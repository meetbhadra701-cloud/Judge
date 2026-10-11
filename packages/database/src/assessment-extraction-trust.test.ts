import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractionIdentityOf } from './assessment-identity.js';
import { AssessmentRunError } from './assessment-run-store.js';
import { ExtractionConflictError, ExtractionInputError } from './extraction-store.js';
import type { JudgeDatabase } from './index.js';
import { AssessmentStore } from './assessment-store.js';
import { extractAndBind, scoreRun, startRun } from './testing/assessment-pipeline.js';
import {
  contextExtraction,
  seedAssessmentWorld,
  sourceExtraction,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import {
  expectPgMessage,
  probe,
  rows,
  sql,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { seedSnapshot, sha256 } from './testing/graph-world.js';

/*
 * R4 F6 (extraction identity and snapshot coverage) and F8 (a context extraction must be exactly the reference set of the tracks the
 * run declares). Every attack is also tried against the database triggers, because the store is not the only writer a database has.
 */

describe.each(testDatabaseTargets())('R4 F6/F8 extraction trust on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });
  afterAll(async () => {
    await testDb.close();
  });

  const newWorld = (): Promise<AssessmentWorld> =>
    seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      requirements: [
        {
          statement: 'Health projects must cite their data source.',
          certainty: 'explicit',
          trackKey: 'health',
        },
        {
          statement: 'Robotics projects must describe their hardware.',
          certainty: 'explicit',
          trackKey: 'robotics',
        },
      ],
    });
  const extractionsOf = async (projectId: string) =>
    Number(
      (
        await rows<{ n: number }>(
          db,
          sql`SELECT count(*)::int AS n FROM graph_extractions WHERE project_id = ${projectId}`,
        )
      )[0]?.n,
    );

  describe('F6: the key is derived from every key-defining input', () => {
    it('legitimate reuse: identical inputs and identical content reuse the extraction and write nothing', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const input = { ...sourceExtraction(w, { key: 'same' }), runId: run.runId };
      const first = await run.extractions.createExtraction(input);
      const again = await run.extractions.createExtraction(input);
      expect(first.created).toBe(true);
      expect(again).toMatchObject({ created: false, extraction: { id: first.extraction.id } });
      expect(await extractionsOf(w.project.id)).toBe(1);
      // after a crash a caller finds it by its inputs alone, without presenting (or paying for) any content
      const found = await run.extractions.lookup(input);
      expect(found?.id).toBe(first.extraction.id);
      expect(await run.extractions.lookup({ ...input, configHash: sha256('another') })).toBeNull();
    });

    it('the same key with DIFFERENT CONTENT is refused (a changed answer cannot ride on an old key)', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const input = { ...sourceExtraction(w, { key: 'content' }), runId: run.runId };
      await run.extractions.createExtraction(input);
      const changed = {
        ...input,
        batch: {
          ...(input.batch as Record<string, unknown>),
          unknowns: [
            {
              unknownType: 'missing',
              text: 'A different unknown.',
              claims: [{ ref: 'c2' }],
              evidence: [],
            },
          ],
        },
      };
      await expect(run.extractions.createExtraction(changed)).rejects.toMatchObject({
        reason: 'content',
      });
      await expect(run.extractions.createExtraction(changed)).rejects.toBeInstanceOf(
        ExtractionConflictError,
      );
      expect(await extractionsOf(w.project.id)).toBe(1);
    });

    it('other snapshots or another configuration are other extractions, never a reuse of the same key', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const base = { ...sourceExtraction(w, { key: 'base' }), runId: run.runId };
      const one = await run.extractions.createExtraction(base);
      const config = await run.extractions.createExtraction({
        ...base,
        configHash: sha256('another config'),
      });
      expect(config.created).toBe(true);
      expect(config.extraction.extractionKey).not.toBe(one.extraction.extractionKey);
      // a subset of the snapshots is a different identity too (its evidence must then only cite that snapshot)
      const subset = {
        ...base,
        snapshotIds: [w.snapshots.devpost.snapshot.id],
        batch: {
          claims: [
            {
              ref: 'c1',
              text: 'The app stores each intake entry in SQLite.',
              verificationLevel: 'team_claim',
            },
          ],
          evidence: [],
        },
        claimGrounding: { c1: 'exact_text' as const },
        evidence: {},
        relations: [],
      };
      const sub = await run.extractions.createExtraction(subset);
      expect(sub.extraction.extractionKey).not.toBe(one.extraction.extractionKey);
      expect(sub.extraction.snapshotIds).toEqual([w.snapshots.devpost.snapshot.id]);
    });

    it('a snapshot of another project, a failed snapshot or a duplicate is refused before anything is written', async () => {
      const w = await newWorld();
      const other = await newWorld();
      const run = await startRun(db, w);
      const base = { ...sourceExtraction(w, { key: 'bad' }), runId: run.runId };
      for (const snapshotIds of [
        [other.snapshots.devpost.snapshot.id],
        [w.snapshots.devpost.snapshot.id, w.snapshots.devpost.snapshot.id],
        [],
      ]) {
        await expect(
          run.extractions.createExtraction({ ...base, snapshotIds }),
        ).rejects.toBeInstanceOf(ExtractionInputError);
      }
      expect(await extractionsOf(w.project.id)).toBe(0);
    });

    it('direct SQL cannot give a key to other inputs: the key must be the SHA-256 of an identity that names the stored snapshots and hashes', async () => {
      const w = await newWorld();
      const devpost = w.snapshots.devpost.snapshot;
      const github = w.snapshots.github.snapshot;
      const hashes = [
        { snapshotId: devpost.id, contentHash: sha256(devpost.id) },
        { snapshotId: github.id, contentHash: sha256(github.id) },
      ];
      const identity = (over: Partial<Parameters<typeof extractionIdentityOf>[0]> = {}) =>
        extractionIdentityOf({
          kind: 'source',
          projectId: w.project.id,
          configHash: sha256('c'),
          snapshots: hashes,
          ...over,
        } as Parameters<typeof extractionIdentityOf>[0]);
      const insert = (
        id: ReturnType<typeof identity>,
        over: { key?: string; snapshots?: string[]; config?: string } = {},
      ) =>
        probe(db, async (tx) => {
          await tx.execute(sql`INSERT INTO graph_extractions
            (project_id, event_id, kind, extraction_key, snapshot_ids, config_hash, identity_canonical, content_fingerprint,
             claim_count, evidence_count, relation_count, unknown_count, contradiction_count, members_hash)
            VALUES (${w.project.id}, ${w.event.id}, 'source', ${over.key ?? id.key},
                    ${sql.raw(`ARRAY[${(over.snapshots ?? [devpost.id, github.id]).map((s) => `'${s}'`).join(',')}]::uuid[]`)},
                    ${over.config ?? sha256('c')}, ${id.canonical}, ${sha256('content')}, 1, 0, 0, 0, 0, ${sha256('m')})`);
        });
      expect(await insert(identity())).toBe('accepted');
      await expectPgMessage(
        insert(identity(), { key: sha256('hand-picked key') }),
        'SHA-256 of its canonical identity',
      );
      await expectPgMessage(
        insert(identity(), { snapshots: [devpost.id] }),
        'names other snapshots',
      );
      await expectPgMessage(insert(identity(), { config: sha256('other') }), 'disagrees');
      const wrongHash = identity({
        snapshots: [
          { snapshotId: devpost.id, contentHash: sha256('not the stored hash') },
          { snapshotId: github.id, contentHash: sha256(github.id) },
        ],
      });
      await expectPgMessage(insert(wrongHash), 'another snapshot content hash');
    });

    it('a source extraction bound to a run must cover EXACTLY the snapshots the run pinned', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      // incomplete coverage: only one of the two pinned snapshots
      const partial = await run.extractions.createExtraction({
        ...sourceExtraction(w, { key: 'partial' }),
        runId: run.runId,
        snapshotIds: [w.snapshots.devpost.snapshot.id],
        batch: {
          claims: [
            {
              ref: 'c1',
              text: 'The app stores each intake entry in SQLite.',
              verificationLevel: 'team_claim',
            },
          ],
        },
        claimGrounding: { c1: 'exact_text' },
        evidence: {},
        relations: [],
      });
      await expect(
        run.store.bindExtraction(run.runId, run.leaseToken, 'source', partial.extraction.id),
      ).rejects.toMatchObject({ code: 'extraction_rejected' });
      // extra coverage: a snapshot captured AFTER the run pinned its inputs
      const later = await seedSnapshot(db, w.project, 'deployment', 'captured', [
        { key: 'deploy.json', kind: 'file', mediaType: 'application/json', text: '{"ok":true}' },
      ]);
      const extra = await run.extractions.createExtraction({
        ...sourceExtraction(w, { key: 'extra' }),
        runId: run.runId,
        snapshotIds: [
          w.snapshots.devpost.snapshot.id,
          w.snapshots.github.snapshot.id,
          later.snapshot.id,
        ],
      });
      await expect(
        run.store.bindExtraction(run.runId, run.leaseToken, 'source', extra.extraction.id),
      ).rejects.toBeInstanceOf(AssessmentRunError);
      // the database repeats both refusals
      for (const id of [partial.extraction.id, extra.extraction.id]) {
        await expectPgMessage(
          probe(db, async (tx) => {
            await tx.execute(sql`INSERT INTO assessment_run_extractions (run_id, project_id, kind, extraction_id)
              VALUES (${run.runId}, ${w.project.id}, 'source', ${id})`);
          }),
          'source extraction',
        );
      }
      // the exact set binds
      const exact = await run.extractions.createExtraction({
        ...sourceExtraction(w, { key: 'exact' }),
        runId: run.runId,
      });
      await run.store.bindExtraction(run.runId, run.leaseToken, 'source', exact.extraction.id);
    });
  });

  describe('F8: a context extraction is exactly the reference set of the declared tracks', () => {
    it("the reviewer's forged example: an OVER-DECLARED context extraction (a track the run did not declare) cannot be bound", async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      // a genuine, self-consistent reference set for BOTH tracks, presented to a run that declared only `health`
      const over = contextExtraction({ ...w, declared: ['health', 'robotics'] });
      const created = await run.extractions.createExtraction({ ...over.input, runId: run.runId });
      expect(created.created).toBe(true);
      await expect(
        run.store.bindExtraction(
          run.runId,
          run.leaseToken,
          'context_evidence',
          created.extraction.id,
        ),
      ).rejects.toMatchObject({ code: 'extraction_rejected' });
      await expectPgMessage(
        probe(db, async (tx) => {
          await tx.execute(sql`INSERT INTO assessment_run_extractions (run_id, project_id, kind, extraction_id)
            VALUES (${run.runId}, ${w.project.id}, 'context_evidence', ${created.extraction.id})`);
        }),
        'over- or under-declared',
      );
      // an UNDER-declared one (no track) fails the same way
      const under = contextExtraction({ ...w, declared: [] });
      const bare = await run.extractions.createExtraction({ ...under.input, runId: run.runId });
      await expect(
        run.store.bindExtraction(run.runId, run.leaseToken, 'context_evidence', bare.extraction.id),
      ).rejects.toMatchObject({ code: 'extraction_rejected' });
      // the correct one binds
      const right = await run.extractions.createExtraction({
        ...contextExtraction(w).input,
        runId: run.runId,
      });
      await run.store.bindExtraction(
        run.runId,
        run.leaseToken,
        'context_evidence',
        right.extraction.id,
      );
    });

    it('forged text or forged classification is refused when the extraction is created, from the recomputed locked document', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const honest = contextExtraction(w);
      const refs = Object.keys(honest.input.evidence);
      const first = refs[0] ?? '';
      const forgedMeta = {
        ...honest.input,
        evidence: {
          ...honest.input.evidence,
          [first]: {
            role: 'event_reference' as const,
            reference: {
              ...(honest.input.evidence[first]?.reference as NonNullable<
                (typeof honest.input.evidence)[string]['reference']
              >),
              applicability: 'overall_rule' as const,
              trackKey: null,
            },
          },
        },
      };
      await expect(
        run.extractions.createExtraction({ ...forgedMeta, runId: run.runId }),
      ).rejects.toBeInstanceOf(ExtractionInputError);
      const batch = honest.input.batch as { evidence: { text: string }[] };
      const forgedText = {
        ...honest.input,
        batch: {
          ...batch,
          evidence: batch.evidence.map((e, i) =>
            i === 0 ? { ...e, text: `${e.text} (altered)` } : e,
          ),
        },
      };
      await expect(
        run.extractions.createExtraction({ ...forgedText, runId: run.runId }),
      ).rejects.toBeInstanceOf(ExtractionInputError);
      expect(await extractionsOf(w.project.id)).toBe(0);
    });

    it('the stored identity of a context extraction names its version, the locked hash and the declared tracks', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const right = await run.extractions.createExtraction({
        ...contextExtraction(w).input,
        runId: run.runId,
      });
      expect(right.extraction.contextVersionId).toBe(w.context.versionId);
      // the stored identity names the locked hash of the version it was built from
      const [row] = await rows<{ identity_canonical: string }>(
        db,
        sql`SELECT identity_canonical FROM graph_extractions WHERE id = ${right.extraction.id}`,
      );
      expect(JSON.parse(row?.identity_canonical ?? '{}')).toMatchObject({
        kind: 'context_evidence',
        contextVersionId: w.context.versionId,
        lockedContentHash: w.context.hash,
        declaredTrackKeys: ['health'],
      });
    });

    it("binding compares the extraction's recorded declared tracks with the run's even when its members happen to be right (a forged column)", async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const right = await run.extractions.createExtraction({
        ...contextExtraction(w).input,
        runId: run.runId,
      });
      // superuser DDL, committed: forge the recorded declared-tracks column of an immutable row
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE graph_extractions DISABLE TRIGGER graph_extractions_immutable_guard`,
        );
        await tx.execute(
          sql`UPDATE graph_extractions SET declared_track_keys = ARRAY['health', 'robotics']::text[] WHERE id = ${right.extraction.id}`,
        );
        await tx.execute(
          sql`ALTER TABLE graph_extractions ENABLE TRIGGER graph_extractions_immutable_guard`,
        );
      });
      await expect(
        run.store.bindExtraction(
          run.runId,
          run.leaseToken,
          'context_evidence',
          right.extraction.id,
        ),
      ).rejects.toMatchObject({ code: 'extraction_rejected' });
    });

    it('the database also refuses a context extraction whose MEMBERS refer to an undeclared track although its declared-tracks column says otherwise', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const over = await run.extractions.createExtraction({
        ...contextExtraction({ ...w, declared: ['health', 'robotics'] }).input,
        runId: run.runId,
      });
      await expectPgMessage(
        probe(db, async (tx) => {
          // superuser DDL inside a rolled-back transaction: forge the column of an immutable row
          await tx.execute(
            sql`ALTER TABLE graph_extractions DISABLE TRIGGER graph_extractions_immutable_guard`,
          );
          await tx.execute(
            sql`UPDATE graph_extractions SET declared_track_keys = ARRAY['health']::text[] WHERE id = ${over.extraction.id}`,
          );
          await tx.execute(sql`INSERT INTO assessment_run_extractions (run_id, project_id, kind, extraction_id)
            VALUES (${run.runId}, ${w.project.id}, 'context_evidence', ${over.extraction.id})`);
        }),
        'refers to a track the run did not declare',
      );
    });

    it('defense in depth: with the bind trigger bypassed (DDL, rolled back) the citation trigger still refuses a reference to a track the run did not declare', async () => {
      const w = await newWorld();
      // run 1 completes honestly, so that its report is a genuine report for these exact inputs
      const first = await startRun(db, w);
      await extractAndBind(w, first, { source: 'k-src', context: 'k-ctx' });
      const scored = await scoreRun(db, w, first);
      expect((await new AssessmentStore(db).persist(scored.persist)).kind).toBe('persisted');
      // run 2 binds the same source extraction, and (bypassing the guard) an OVER-DECLARED context extraction
      const second = await startRun(db, w, { mode: 'reassess' });
      const source = await second.extractions.createExtraction({
        ...sourceExtraction(w, { key: 'k-src' }),
        runId: second.runId,
      });
      await second.store.bindExtraction(
        second.runId,
        second.leaseToken,
        'source',
        source.extraction.id,
      );
      const over = await second.extractions.createExtraction({
        ...contextExtraction({ ...w, declared: ['health', 'robotics'] }).input,
        runId: second.runId,
      });
      const [robotics] = await rows<{ record_id: string }>(
        db,
        sql`SELECT record_id FROM graph_extraction_items WHERE extraction_id = ${over.extraction.id} AND reference_track_key = 'robotics' LIMIT 1`,
      );
      expect(robotics).toBeDefined();
      const stored = (await import('@judge-copilot/assessment')).storedFormOf(scored.report);
      await expectPgMessage(
        probe(db, async (tx) => {
          await tx.execute(
            sql`ALTER TABLE assessment_run_extractions DISABLE TRIGGER assessment_run_extractions_guard`,
          );
          await tx.execute(sql`INSERT INTO assessment_run_extractions (run_id, project_id, kind, extraction_id)
            VALUES (${second.runId}, ${w.project.id}, 'context_evidence', ${over.extraction.id})`);
          await tx.execute(sql`INSERT INTO pre_interview_assessments
            (project_id, event_id, run_id, version_number, assessment_key, context_version_id, locked_content_hash, pinned_snapshot_ids,
             extraction_id, context_extraction_id, target_kind, engine_version, parameters_hash, rubric_fingerprint, rubric_source,
             input_fingerprint, graph_fingerprint, output_hash, report_canonical, report_text_sha256, report, limitations,
             pipeline_config_hash, provider_mode)
            SELECT p.id, p.event_id, ${second.runId}, 2, i.assessment_key, i.context_version_id, i.locked_content_hash,
                   (SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM assessment_run_input_snapshots WHERE run_id = ${second.runId}),
                   ${source.extraction.id}, ${over.extraction.id},
                   i.target_kind, ${scored.report.engineVersion}, ${scored.report.parametersHash}, ${scored.report.rubric.fingerprint},
                   ${scored.report.rubric.source}, ${scored.report.inputFingerprint}, ${scored.report.graphFingerprint},
                   ${scored.report.outputHash}, ${stored.reportCanonical}, ${stored.reportTextSha256},
                   ${stored.reportCanonical}::jsonb, '[]'::jsonb, i.pipeline_config_hash, 'scripted'
            FROM assessment_run_inputs i JOIN projects p ON p.id = i.project_id WHERE i.run_id = ${second.runId}`);
          await tx.execute(sql`INSERT INTO assessment_dimension_judgments
            (assessment_id, project_id, dimension_id, position, outcome_kind, score, disposition, assessor_attempts, critic_attempts, critic_review_required, critic_reviewed)
            SELECT a.id, a.project_id, 'official.problem_fit', 0, 'insufficient_evidence', NULL, 'no_candidate_evidence', 0, 0, false, false
              FROM pre_interview_assessments a WHERE a.run_id = ${second.runId}`);
          await tx.execute(sql`INSERT INTO assessment_judgment_citations
            (assessment_id, project_id, dimension_id, position, evidence_id, reference_applicability, reference_track_key, directness, specificity)
            SELECT a.id, a.project_id, 'official.problem_fit', 0, ${robotics?.record_id ?? ''}, i.reference_applicability, i.reference_track_key, 'indirect', 'generic'
              FROM pre_interview_assessments a, graph_extraction_items i
             WHERE a.run_id = ${second.runId} AND i.record_id = ${robotics?.record_id ?? ''} AND i.record_type = 'evidence'`);
        }),
        'did not declare',
      );
    });
  });
});
