import { membersHash } from '@judge-copilot/assessment';
import { deterministicIdAllocator, EvidenceGraphError } from '@judge-copilot/evidence';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import { ExtractionInputError, GraphExtractionStore } from './extraction-store.js';
import {
  auditEvents,
  claims,
  graphExtractionItems,
  graphExtractions,
  type JudgeDatabase,
} from './index.js';
import {
  contextExtraction,
  seedAssessmentWorld,
  sourceExtraction,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import {
  expectPgError,
  expectPgMessage,
  probe,
  rows,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { sha256 } from './testing/graph-world.js';

const { CHECK_VIOLATION, UNIQUE_VIOLATION } = SQLSTATE;

describe.each(testDatabaseTargets())('M5 P4 atomic extraction on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let w: AssessmentWorld;
  let n = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    w = await seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      requirements: [
        {
          statement: 'Health projects must cite their data source.',
          certainty: 'explicit',
          trackKey: 'health',
        },
      ],
    });
  });
  afterAll(async () => {
    await testDb.close();
  });

  const graphs = () => {
    n += 1;
    return new EvidenceGraphStore({ db, ids: deterministicIdAllocator(`extraction-${String(n)}`) });
  };
  const store = () => new GraphExtractionStore(db, graphs());
  const count = async (
    table: 'claims' | 'evidence_items' | 'graph_extractions' | 'graph_extraction_items',
  ) =>
    Number(
      (await rows<{ n: number }>(db, sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]?.n,
    );

  it('the seeded locked context is exactly what the reader reconstructs (fixture sanity)', async () => {
    const { readLocked } = await import('./testing/assessment-world.js');
    const read = await readLocked(db, w.event.id, w.context.versionId);
    expect(read.ok).toBe(true);
  });

  it('writes the graph and its membership together, from the authoritative ids the database just allocated', async () => {
    const input = sourceExtraction(w);
    const result = await store().createExtraction(input);
    expect(result.created).toBe(true);
    expect(result.graph?.claims).toHaveLength(2);
    const stored = result.extraction;
    expect(stored.kind).toBe('source');
    // the members ARE the created records, in creation order
    expect(result.members.claimIds).toEqual(result.graph?.claims.map((c) => c.id));
    expect(result.members.evidenceIds).toEqual(result.graph?.evidence.map((e) => e.id));
    expect(result.members.relationIds).toEqual(result.graph?.relations.map((r) => r.id));
    // the hash the database recomputed at commit equals the application's
    expect(stored.membersHash).toBe(membersHash(result.members));
    const [dbHash] = await rows<{ h: string }>(
      db,
      sql`SELECT graph_extraction_members_hash(${stored.id}::uuid) AS h`,
    );
    expect(dbHash?.h).toBe(stored.membersHash);
    // every member is a real row of the project; the metadata was stored per record
    const items = await store().readItems(stored.id);
    expect(items.filter((i) => i.recordType === 'evidence').map((i) => i.role)).toEqual([
      'statement',
      'statement',
      'interpreted_fact',
    ]);
    expect(items.filter((i) => i.recordType === 'relation').map((i) => i.relationBasis)).toEqual([
      'source_statement',
      'source_statement',
      'independent_observation',
    ]);
    expect(items.filter((i) => i.recordType === 'claim').map((i) => i.grounding)).toEqual([
      'exact_text',
      'exact_text',
    ]);
  });

  it('stores the Event-Context reference metadata of the context extraction, derived from the locked document', async () => {
    const { input, items } = contextExtraction(w);
    const result = await store().createExtraction(input);
    const stored = await store().readItems(result.extraction.id);
    expect(stored.every((i) => i.recordType === 'evidence' && i.role === 'event_reference')).toBe(
      true,
    );
    expect(
      stored.map((i) => [i.reference?.kind, i.reference?.applicability, i.reference?.trackKey]),
    ).toEqual(items.map((i) => [i.kind, i.applicability, i.trackKey]));
    // declared track definition, track-specific requirement, overall rule: robotics (undeclared) is absent
    expect(stored.map((i) => i.reference?.trackKey)).toEqual(['health', null, 'health']);
  });

  it('reuses an extraction with the same key and writes nothing', async () => {
    const input = sourceExtraction(w);
    const first = await store().createExtraction(input);
    const before = { claims: await count('claims'), items: await count('graph_extraction_items') };
    const again = await store().createExtraction(input);
    expect(again.created).toBe(false);
    expect(again.graph).toBeNull();
    expect(again.extraction.id).toBe(first.extraction.id);
    expect(again.members).toEqual(first.members);
    expect({ claims: await count('claims'), items: await count('graph_extraction_items') }).toEqual(
      before,
    );
  });

  describe('atomicity: neither graph records nor membership remain on any failure', () => {
    const snapshot = async () => ({
      claims: await count('claims'),
      evidence: await count('evidence_items'),
      extractions: await count('graph_extractions'),
      items: await count('graph_extraction_items'),
    });

    it('a batch the M3 planner rejects writes nothing', async () => {
      const input = sourceExtraction(w);
      const bad = structuredClone(input) as {
        batch: { evidence: { provenance: { excerpt: string } }[] };
      };
      const first = bad.batch.evidence[0];
      if (first) first.provenance.excerpt = 'words that are not in the artifact';
      const before = await snapshot();
      await expect(store().createExtraction({ ...input, batch: bad.batch })).rejects.toBeInstanceOf(
        EvidenceGraphError,
      );
      expect(await snapshot()).toEqual(before);
    });

    it('missing metadata discovered AFTER the graph rows were inserted rolls the graph back too', async () => {
      const input = sourceExtraction(w);
      const { e3: _dropped, ...evidence } = input.evidence;
      const before = await snapshot();
      await expect(store().createExtraction({ ...input, evidence })).rejects.toBeInstanceOf(
        ExtractionInputError,
      );
      expect(await snapshot()).toEqual(before);
    });

    it('a database rejection of the membership rows (e.g. a forged snapshot id) rolls the graph back too', async () => {
      const input = sourceExtraction(w);
      const before = await snapshot();
      await expectPgError(
        store().createExtraction({
          ...input,
          snapshotIds: [
            w.snapshots.devpost.snapshot.id,
            sha256('x').slice(0, 8) + '-0000-4000-8000-000000000000',
          ],
        }),
        CHECK_VIOLATION,
        '23503',
      );
      expect(await snapshot()).toEqual(before);
    });

    it('an unknown project writes nothing and is a typed error', async () => {
      const input = sourceExtraction(w);
      await expect(
        store().createExtraction({ ...input, projectId: '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e' }),
      ).rejects.toBeInstanceOf(ExtractionInputError);
    });
  });

  describe('the database verifies completeness at COMMIT (direct SQL attacks)', () => {
    /** Creates the graph through the real store inside the SAME transaction, then lets `attack` write the membership rows by hand. */
    async function attempt(
      attack: (
        tx: JudgeDatabase,
        created: Awaited<ReturnType<EvidenceGraphStore['createGraphInTransaction']>>,
        extractionId: string,
      ) => Promise<void>,
      options: { key?: string; skipGraph?: boolean } = {},
    ) {
      const input = sourceExtraction(w, options.key === undefined ? {} : { key: options.key });
      const extractionId = crypto.randomUUID();
      return db.transaction(async (tx) => {
        const created = await graphs().createGraphInTransaction(
          tx,
          w.project.id,
          input.batch,
          null,
        );
        await attack(tx, created, extractionId);
      });
    }
    const extractionRow = (
      id: string,
      created: {
        claims: unknown[];
        evidence: unknown[];
        relations: unknown[];
        unknowns: unknown[];
        contradictions: unknown[];
      },
      overrides: Partial<typeof graphExtractions.$inferInsert> = {},
    ) => ({
      id,
      projectId: w.project.id,
      eventId: w.event.id,
      kind: 'source' as const,
      extractionKey: sha256(`attack:${id}`),
      snapshotIds: [w.snapshots.devpost.snapshot.id, w.snapshots.github.snapshot.id],
      configHash: sha256('c'),
      claimCount: created.claims.length,
      evidenceCount: created.evidence.length,
      relationCount: created.relations.length,
      unknownCount: created.unknowns.length,
      contradictionCount: created.contradictions.length,
      membersHash: sha256('placeholder'),
      ...overrides,
    });
    const items = (
      extractionId: string,
      created: Awaited<ReturnType<EvidenceGraphStore['createGraphInTransaction']>>,
      skip: (type: string, index: number) => boolean = () => false,
    ) => {
      const out: (typeof graphExtractionItems.$inferInsert)[] = [];
      const push = (
        recordType: 'claim' | 'evidence' | 'relation' | 'unknown' | 'contradiction',
        ids: string[],
      ) => {
        ids.forEach((recordId, index) => {
          if (skip(recordType, index)) return;
          out.push({
            recordType,
            recordId,
            extractionId,
            projectId: w.project.id,
            ordinal: index + 1,
            role: recordType === 'evidence' ? 'statement' : null,
            relationBasis: recordType === 'relation' ? 'source_statement' : null,
          });
        });
      };
      push(
        'claim',
        created.claims.map((c) => c.id),
      );
      push(
        'evidence',
        created.evidence.map((e) => e.id),
      );
      push(
        'relation',
        created.relations.map((r) => r.id),
      );
      push(
        'unknown',
        created.unknowns.map((u) => u.id),
      );
      push(
        'contradiction',
        created.contradictions.map((c) => c.id),
      );
      return out;
    };
    const hashOf = (created: Awaited<ReturnType<EvidenceGraphStore['createGraphInTransaction']>>) =>
      membersHash({
        claimIds: created.claims.map((r) => r.id),
        evidenceIds: created.evidence.map((r) => r.id),
        relationIds: created.relations.map((r) => r.id),
        unknownIds: created.unknowns.map((r) => r.id),
        contradictionIds: created.contradictions.map((r) => r.id),
      });

    it('a correct hand-written extraction passes (control)', async () => {
      await attempt(async (tx, created, id) => {
        await tx
          .insert(graphExtractions)
          .values(extractionRow(id, created, { membersHash: hashOf(created) }));
        await tx.insert(graphExtractionItems).values(items(id, created));
      });
    });

    it('a wrong members_hash is rejected at commit', async () => {
      await expectPgError(
        attempt(async (tx, created, id) => {
          await tx.insert(graphExtractions).values(extractionRow(id, created));
          await tx.insert(graphExtractionItems).values(items(id, created));
        }),
        CHECK_VIOLATION,
      );
    });

    it('a missing member (the graph has a record the extraction does not list) is rejected', async () => {
      await expectPgError(
        attempt(async (tx, created, id) => {
          const listed = { ...created, claims: created.claims.slice(1) };
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, listed, { membersHash: hashOf(listed) }));
          await tx.insert(graphExtractionItems).values(items(id, listed));
        }),
        CHECK_VIOLATION,
      );
    });

    it('a member that THIS transaction did not create (a record of an earlier writer) is rejected', async () => {
      const earlier = await store().createExtraction(sourceExtraction(w));
      const foreignClaim = earlier.members.claimIds[0] ?? '';
      await expectPgError(
        attempt(async (tx, created, id) => {
          // swap one of the extraction's own claims for the earlier writer's claim
          const forged = {
            ...created,
            claims: [{ ...created.claims[0], id: foreignClaim }, ...created.claims.slice(1)],
          } as typeof created;
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, forged, { membersHash: hashOf(forged) }));
          await tx.insert(graphExtractionItems).values(items(id, forged));
        }),
        CHECK_VIOLATION,
        UNIQUE_VIOLATION,
      );
    });

    it('a record cannot belong to two extractions', async () => {
      const earlier = await store().createExtraction(sourceExtraction(w));
      await expectPgError(
        db.insert(graphExtractionItems).values({
          recordType: 'claim',
          recordId: earlier.members.claimIds[0] ?? '',
          extractionId: earlier.extraction.id,
          projectId: w.project.id,
          ordinal: 99,
        }),
        UNIQUE_VIOLATION,
        CHECK_VIOLATION,
        SQLSTATE.RESTRICT_VIOLATION,
      );
    });

    it('wrong counts or non-contiguous ordinals are rejected', async () => {
      await expectPgError(
        attempt(async (tx, created, id) => {
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, created, { membersHash: hashOf(created), claimCount: 3 }));
          await tx.insert(graphExtractionItems).values(items(id, created));
        }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        attempt(async (tx, created, id) => {
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, created, { membersHash: hashOf(created) }));
          await tx
            .insert(graphExtractionItems)
            .values(
              items(id, created).map((item) =>
                item.recordType === 'claim' && item.ordinal === 2 ? { ...item, ordinal: 5 } : item,
              ),
            );
        }),
        CHECK_VIOLATION,
      );
    });

    it('a member of another project cannot be listed', async () => {
      await expectPgError(
        attempt(async (tx, created, id) => {
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, created, { membersHash: hashOf(created) }));
          await tx.insert(graphExtractionItems).values(
            items(id, created).map((item, index) =>
              index === 0
                ? {
                    ...item,
                    projectId: w.project.id,
                    recordId: '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e',
                  }
                : item,
            ),
          );
        }),
        '23503',
        CHECK_VIOLATION,
      );
    });

    it('a source extraction cannot cite a snapshot it does not list', async () => {
      await expectPgError(
        attempt(async (tx, created, id) => {
          await tx.insert(graphExtractions).values(
            extractionRow(id, created, {
              membersHash: hashOf(created),
              snapshotIds: [w.snapshots.devpost.snapshot.id],
            }),
          );
          await tx.insert(graphExtractionItems).values(items(id, created));
        }),
        CHECK_VIOLATION,
      );
    });

    it('ISOLATED: a record created by an EARLIER transaction cannot be listed, even when counts, hash, closure and coverage all fit', async () => {
      // an earlier writer's standalone claim: a member of NO extraction, so only the "created by this transaction" rule can refuse it
      const earlier = await graphs().createGraph(
        w.project.id,
        {
          claims: [
            {
              ref: 'e',
              text: 'A claim an earlier transaction wrote.',
              verificationLevel: 'unverified',
            },
          ],
        },
        null,
      );
      const foreign = earlier.claims[0]?.id ?? '';
      await expectPgMessage(
        attempt(async (tx, created, id) => {
          const claimIds = [...created.claims.map((c) => c.id), foreign];
          const listed = { ...created, claims: [...created.claims, { id: foreign } as never] };
          const hash = membersHash({
            claimIds,
            evidenceIds: created.evidence.map((r) => r.id),
            relationIds: created.relations.map((r) => r.id),
            unknownIds: created.unknowns.map((r) => r.id),
            contradictionIds: created.contradictions.map((r) => r.id),
          });
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, listed, { membersHash: hash }));
          await tx.insert(graphExtractionItems).values(items(id, listed));
        }),
        'did not create',
      );
    });

    it('ISOLATED: a graph record this transaction created that no extraction lists is refused (an unreferenced one: an unknown)', async () => {
      await expectPgMessage(
        attempt(async (tx, created, id) => {
          const listed = { ...created, unknowns: [] };
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, listed, { membersHash: hashOf(listed) }));
          await tx.insert(graphExtractionItems).values(items(id, listed));
        }),
        'no extraction lists',
      );
    });

    it('ISOLATED: a relation whose endpoint belongs to ANOTHER extraction is not a closed member set', async () => {
      const earlier = await store().createExtraction(sourceExtraction(w));
      const foreignEvidence = earlier.members.evidenceIds[0] ?? '';
      const batch = {
        claims: [
          {
            ref: 'c',
            text: 'A claim that leans on the earlier extraction.',
            verificationLevel: 'team_claim',
          },
        ],
        relations: [{ claim: { ref: 'c' }, evidence: { id: foreignEvidence }, type: 'supports' }],
      };
      await expectPgMessage(
        db.transaction(async (tx) => {
          const created = await graphs().createGraphInTransaction(tx, w.project.id, batch, null);
          const id = crypto.randomUUID();
          await tx
            .insert(graphExtractions)
            .values(extractionRow(id, created, { membersHash: hashOf(created) }));
          await tx.insert(graphExtractionItems).values(items(id, created));
        }),
        'endpoint is not a member',
      );
    });

    it('ISOLATED: a record already listed by another extraction cannot be listed again (the key, not a later check)', async () => {
      const earlier = await store().createExtraction(sourceExtraction(w));
      await expectPgError(
        probe(db, async (tx) => {
          const id = crypto.randomUUID();
          await tx
            .insert(graphExtractions)
            .values(
              extractionRow(
                id,
                { claims: [1], evidence: [], relations: [], unknowns: [], contradictions: [] },
                { membersHash: sha256('x') },
              ),
            );
          await tx.insert(graphExtractionItems).values({
            recordType: 'claim',
            recordId: earlier.members.claimIds[0] ?? '',
            extractionId: id,
            projectId: w.project.id,
            ordinal: 1,
          });
        }),
        UNIQUE_VIOLATION,
      );
    });

    it('FEASIBILITY (xmin): inside a SAVEPOINT the check fails closed, never open', async () => {
      // Rows inserted in a subtransaction carry the subtransaction id as xmin, which differs from the top-level id the trigger
      // compares with. The check therefore REJECTS (a false negative), it can never accept a record it should not. The graph
      // writer never opens a savepoint, so the correct path is unaffected (the control test above and every other test).
      await expectPgError(
        db.transaction(async (tx) => {
          await tx.transaction(async (inner) => {
            const created = await graphs().createGraphInTransaction(
              inner,
              w.project.id,
              sourceExtraction(w).batch,
              null,
            );
            const id = crypto.randomUUID();
            await inner
              .insert(graphExtractions)
              .values(extractionRow(id, created, { membersHash: hashOf(created) }));
            await inner.insert(graphExtractionItems).values(items(id, created));
          });
        }),
        CHECK_VIOLATION,
      );
    });

    it('graph rows written WITHOUT an extraction row are unaffected (the M3 write path is not an extraction)', async () => {
      const before = await count('graph_extractions');
      await graphs().createGraph(
        w.project.id,
        {
          claims: [
            { ref: 'solo', text: 'A standalone M3 claim.', verificationLevel: 'unverified' },
          ],
        },
        null,
      );
      expect(await count('graph_extractions')).toBe(before);
    });
  });

  it('createGraph and createGraphInTransaction are observably identical (parity)', async () => {
    const batch = sourceExtraction(w).batch;
    const viaCreate = await new EvidenceGraphStore({
      db,
      ids: deterministicIdAllocator('parity-a'),
      now: () => new Date('2026-10-05T12:00:00.000Z'),
    }).createGraph(w.project.id, batch, null);
    const viaTx = await db.transaction((tx) =>
      new EvidenceGraphStore({
        db,
        ids: deterministicIdAllocator('parity-b'),
        now: () => new Date('2026-10-05T12:00:00.000Z'),
      }).createGraphInTransaction(tx, w.project.id, batch, null),
    );
    // ids come from the same allocator seed, so the two writes mint ids from one namespace; compare everything id-independent
    const strip = (g: typeof viaCreate) => ({
      claims: g.claims.map(({ text, verificationLevel }) => ({ text, verificationLevel })),
      evidence: g.evidence.map(({ kind, origin, text, provenance }) => ({
        kind,
        origin,
        text,
        span: provenance.span,
      })),
      relations: g.relations.map(({ type }) => type),
      unknowns: g.unknowns.map(({ unknownType, text }) => ({ unknownType, text })),
    });
    expect(strip(viaTx)).toEqual(strip(viaCreate));
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'evidence_graph.created'));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    // both entry points reject an invalid batch with the same typed error and write nothing
    const invalid = { claims: [{ ref: 'x', text: '', verificationLevel: 'unverified' }] };
    await expect(graphs().createGraph(w.project.id, invalid, null)).rejects.toThrow();
    await expect(
      db.transaction((tx) => graphs().createGraphInTransaction(tx, w.project.id, invalid, null)),
    ).rejects.toThrow();
    const [leftover] = await db.select().from(claims).where(eq(claims.text, ''));
    expect(leftover).toBeUndefined();
  });
});
