import {
  deterministicIdAllocator,
  EvidenceGraphError,
  EvidenceGraphPersistenceError,
} from '@judge-copilot/evidence';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConnection } from './client.js';
import { EVIDENCE_GRAPH_AUDIT_ACTIONS, EvidenceGraphStore } from './evidence-graph-store.js';
import { auditEvents, claims, projects } from './index.js';
import { openPostgres, rows } from './testing/databases.js';
import {
  seedGraphWorld,
  seedProject,
  seedSnapshot,
  type GraphWorld,
} from './testing/graph-world.js';

/*
 * Real concurrent writers on real PostgreSQL connections (never promise ordering on one
 * transaction). Skipped without TEST_DATABASE_URL: PGlite is a single connection and cannot
 * interleave transactions.
 */

const URL_ = process.env['TEST_DATABASE_URL'];

describe.skipIf(!URL_)('M3 per-project graph writer serialization (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  let pool: DatabaseConnection;
  let w: GraphWorld;
  let n = 0;

  beforeAll(async () => {
    const url = URL_ ?? '';
    setup = await openPostgres(url);
    w = await seedGraphWorld(setup.db);
    pool = createDatabase(url, { maxConnections: 24 });
  });
  afterAll(async () => {
    await pool.close();
    await setup.close();
  });

  const store = () => {
    n += 1;
    return new EvidenceGraphStore({
      db: pool.db,
      ids: deterministicIdAllocator(`concurrency-${String(n)}`),
    });
  };
  const must = <T>(value: T | undefined | null): T => {
    if (value === undefined || value === null) throw new Error('missing');
    return value;
  };
  const oneClaim = (text: string) => ({
    claims: [{ ref: 'c', text, verificationLevel: 'unverified' }],
  });
  const count = async (query: ReturnType<typeof sql>) =>
    must((await rows<{ n: number }>(pool.db, query))[0]).n;

  it('cap race: 12 concurrent one-claim batches at 1999/2000 -> exactly one wins, 11 get PROJECT_LIMIT_EXCEEDED', async () => {
    const project = await seedProject(setup.db, w.event.id, 'Cap Race');
    await setup.db.execute(sql`INSERT INTO claims (project_id, text, verification_level)
      SELECT ${project.id}::uuid, 'seed ' || g, 'unverified' FROM generate_series(1, 1999) AS g`);
    const claimsBefore = await count(
      sql`SELECT count(*)::int AS n FROM claims WHERE project_id = ${project.id}`,
    );
    expect(claimsBefore).toBe(1999);
    const auditBefore = await count(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${project.id} AND action = ${EVIDENCE_GRAPH_AUDIT_ACTIONS.created}`,
    );

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        store().createGraph(project.id, oneClaim(`racer ${String(i)}`), null),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(EvidenceGraphError);
      expect((result.reason as EvidenceGraphError).codes).toEqual(['PROJECT_LIMIT_EXCEEDED']);
    }
    expect(
      await count(sql`SELECT count(*)::int AS n FROM claims WHERE project_id = ${project.id}`),
    ).toBe(2000);
    // Exactly one graph audit event for the racing batches, and no partial graph from a loser.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${project.id} AND action = ${EVIDENCE_GRAPH_AUDIT_ACTIONS.created}`,
      ),
    ).toBe(auditBefore + 1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM claims WHERE project_id = ${project.id} AND text LIKE 'racer %'`,
      ),
    ).toBe(1);
  });

  describe('lock behaviour of createGraph', () => {
    /** Holds the same project-row lock createGraph takes, on its own connection, until released. */
    async function holdProjectLock(projectId: string) {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = pool.db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, projectId))
          .for('no key update');
        locked();
        await released;
      });
      await acquired;
      return { release, done: holder };
    }

    const within = async <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
      Promise.race([
        promise,
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => {
            resolve('timeout');
          }, ms);
        }),
      ]);

    it('serializes writers of the same project, without blocking writers of another project or FK inserts', async () => {
      const a = await seedProject(setup.db, w.event.id, 'Lock A');
      const b = await seedProject(setup.db, w.event.id, 'Lock B');
      const hold = await holdProjectLock(a.id);
      try {
        // Another project is independent.
        const other = await within(
          store().createGraph(b.id, oneClaim('project b writes'), null),
          5_000,
        );
        expect(other).not.toBe('timeout');

        // Direct inserts into the graph tables take only a KEY SHARE lock on the project row
        // (through their foreign keys), which FOR NO KEY UPDATE does not conflict with.
        const direct = await within(
          pool.db
            .insert(claims)
            .values({ projectId: a.id, text: 'fk insert', verificationLevel: 'unverified' }),
          5_000,
        );
        expect(direct).not.toBe('timeout');

        // A second writer of the SAME project must wait for the holder.
        let settled = false;
        const blocked = store()
          .createGraph(a.id, oneClaim('project a waits'), null)
          .finally(() => {
            settled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(settled).toBe(false);
        hold.release();
        await hold.done;
        await blocked;
        expect(settled).toBe(true);
      } finally {
        hold.release();
        await hold.done.catch(() => undefined);
      }
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM claims WHERE project_id = ${a.id} AND text = 'project a waits'`,
        ),
      ).toBe(1);
    });

    it('introduces no deadlock: mixed writers on two projects all finish with only typed outcomes', async () => {
      const a = await seedProject(setup.db, w.event.id, 'Dead A');
      const b = await seedProject(setup.db, w.event.id, 'Dead B');
      const devpost = {
        [a.id]: (await seedSnapshot(setup.db, a, 'devpost', 'captured', [])).snapshot.id,
        [b.id]: (await seedSnapshot(setup.db, b, 'devpost', 'captured', [])).snapshot.id,
      };
      // Mixed batches touching claims, evidence (snapshot foreign keys) and relations, interleaved
      // across two projects, all through the same first lock.
      const results = await Promise.allSettled(
        Array.from({ length: 24 }, (_, i) => {
          const project = i % 2 === 0 ? a : b;
          return store().createGraph(
            project.id,
            {
              claims: [{ ref: 'c', text: `mixed ${String(i)}`, verificationLevel: 'unverified' }],
              evidence: [
                {
                  ref: 'e',
                  kind: 'claim',
                  origin: 'devpost',
                  verificationLevel: 'team_claim',
                  text: `statement ${String(i)}`,
                  provenance: { snapshotId: devpost[project.id] },
                },
              ],
              relations: [{ claim: { ref: 'c' }, evidence: { ref: 'e' }, type: 'supports' }],
            },
            null,
          );
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).not.toBeInstanceOf(EvidenceGraphPersistenceError);
        }
      }
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(24);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM claims WHERE project_id IN (${a.id}, ${b.id}) AND text LIKE 'mixed %'`,
        ),
      ).toBe(24);
    });
  });

  describe('concurrent duplicates resolve to exactly one winner', () => {
    async function anchor(name: string) {
      const project = await seedProject(setup.db, w.event.id, name);
      const devpost = await seedSnapshot(setup.db, project, 'devpost', 'captured', []);
      const created = await store().createGraph(
        project.id,
        {
          claims: [
            { ref: 'c1', text: 'first claim', verificationLevel: 'unverified' },
            { ref: 'c2', text: 'second claim', verificationLevel: 'unverified' },
          ],
          evidence: [
            {
              ref: 'e',
              kind: 'claim',
              origin: 'devpost',
              verificationLevel: 'team_claim',
              text: 'a statement',
              provenance: { snapshotId: devpost.snapshot.id },
            },
          ],
        },
        null,
      );
      return { project, refs: created.refs };
    }

    it('supersession: one successor', async () => {
      const { project, refs } = await anchor('Race Supersede');
      const target = must(refs.claims['c1']);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          store().createGraph(
            project.id,
            {
              claims: [
                {
                  ref: 'c',
                  text: `successor ${String(i)}`,
                  verificationLevel: 'unverified',
                  supersedes: { id: target },
                },
              ],
            },
            null,
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect((r.reason as EvidenceGraphError).codes).toEqual(['CLAIM_ALREADY_SUPERSEDED']);
      }
    });

    it('relation: one relation per claim/evidence pair', async () => {
      const { project, refs } = await anchor('Race Relation');
      const relation = {
        claim: { id: must(refs.claims['c1']) },
        evidence: { id: must(refs.evidence['e']) },
        type: 'supports',
      };
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          store().createGraph(project.id, { relations: [relation] }, null),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect((r.reason as EvidenceGraphError).codes).toEqual(['DUPLICATE_RELATION']);
      }
    });

    it('contradiction: one record per pair, whichever side order is submitted', async () => {
      const { project, refs } = await anchor('Race Contradiction');
      const [x, y] = [must(refs.claims['c1']), must(refs.claims['c2'])];
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          store().createGraph(
            project.id,
            {
              contradictions: [
                i % 2 === 0
                  ? {
                      sideA: { type: 'claim', id: x },
                      sideB: { type: 'claim', id: y },
                      description: 'differs',
                    }
                  : {
                      sideA: { type: 'claim', id: y },
                      sideB: { type: 'claim', id: x },
                      description: 'differs',
                    },
              ],
            },
            null,
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((v): v is PromiseRejectedResult => v.status === 'rejected')) {
        expect((r.reason as EvidenceGraphError).codes).toEqual(['DUPLICATE_CONTRADICTION']);
      }
    });
  });

  it('keeps the audit trail intact for what the races wrote', async () => {
    const events = await pool.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, EVIDENCE_GRAPH_AUDIT_ACTIONS.created));
    expect(events.length).toBeGreaterThan(0);
  });
});
