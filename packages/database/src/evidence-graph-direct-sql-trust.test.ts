import {
  contradictionsTouching,
  currentClaims,
  deterministicIdAllocator,
  supersessionView,
  validateGraphIntegrity,
  type GraphIssueCode,
} from '@judge-copilot/evidence';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import {
  expectPgError,
  rows,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import {
  seedGraphWorld,
  seedProject,
  seedSnapshot,
  type GraphWorld,
} from './testing/graph-world.js';

/*
 * M4 prerequisite B: CHARACTERIZATION of what the stored graph can contain when the trusted write
 * path (EvidenceGraphStore.createGraph) is bypassed, and what the M3 validators say about it.
 *
 * These tests document the CURRENT boundary so that no M4 consumer trusts a stored verification
 * label by accident. They are not a statement that the behaviour is desirable. If the owner
 * approves database hardening (see docs/milestones/M4-design.md), the tests that show a direct
 * insert being ACCEPTED are the ones that must flip, deliberately, in that migration.
 */

const CODE = 'export const a = 1;\n';
const must = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
};

describe.each(testDatabaseTargets())(
  'M4 stored-graph trust boundary (direct SQL) on %s',
  (name, open) => {
    let testDb: TestDatabase;
    let w: GraphWorld;
    let n = 0;

    beforeAll(async () => {
      testDb = await open();
      w = await seedGraphWorld(testDb.db);
    });
    afterAll(async () => {
      await testDb.close();
    });

    const store = () => {
      n += 1;
      return new EvidenceGraphStore({
        db: testDb.db,
        ids: deterministicIdAllocator(`trust-${name}-${String(n)}`),
      });
    };
    const codes = async (projectId: string): Promise<GraphIssueCode[]> => {
      const loaded = must(await store().loadGraph(projectId));
      return validateGraphIntegrity(loaded.graph, loaded.known).map((issue) => issue.code);
    };
    const insertClaim = async (projectId: string, text: string, level: string) =>
      must(
        (
          await rows<{ id: string }>(
            testDb.db,
            sql`INSERT INTO claims (project_id, text, verification_level)
              VALUES (${projectId}::uuid, ${text}, ${level}) RETURNING id`,
          )
        )[0],
      ).id;

    it('F1: the database stores a claim at ANY level with no evidence; only the validator notices', async () => {
      const project = await seedProject(testDb.db, w.event.id, 'Trust F1');
      for (const level of [
        'unverified',
        'team_claim',
        'repo_corroborated',
        'machine_verified',
        'judge_verified',
        'live_verified',
        'contradicted',
      ]) {
        await insertClaim(project.id, `f1 ${level}`, level);
      }
      const issues = await codes(project.id);
      // Every level above team_claim, plus contradicted, lacks its justification...
      expect(issues.filter((code) => code === 'UNJUSTIFIED_VERIFICATION')).toHaveLength(5);
      // ...which means a consumer that skips validateGraphIntegrity would have seen five
      // "verified" claims backed by nothing.
    });

    it('F2: a fully self-consistent machine_verified chain written by SQL passes validateGraphIntegrity with NO issue', async () => {
      const project = await seedProject(testDb.db, w.event.id, 'Trust F2');
      const github = await seedSnapshot(testDb.db, project, 'github', 'captured', [
        { key: 'files/src/a.ts', kind: 'file', mediaType: 'text/plain', text: CODE },
      ]);
      const claimId = await insertClaim(
        project.id,
        'The product has 10/10 accuracy.',
        'machine_verified',
      );
      // The cited text is real; the evidence TEXT is unrelated to it. Nothing checks they agree.
      const evidenceId = must(
        (
          await rows<{ id: string }>(
            testDb.db,
            sql`INSERT INTO evidence_items (project_id, event_id, kind, origin, verification_level, text,
                snapshot_id, artifact_id, span_start, span_end, excerpt)
              VALUES (${project.id}::uuid, ${w.event.id}::uuid, 'fact', 'github', 'machine_verified',
                'Independent benchmarks prove 10/10 accuracy', ${github.snapshot.id}::uuid,
                ${must(github.artifacts[0]).id}::uuid, 0, 6, 'export') RETURNING id`,
          )
        )[0],
      ).id;
      await testDb.db.execute(
        sql`INSERT INTO evidence_relations (project_id, claim_id, evidence_id, relation_type)
          VALUES (${project.id}::uuid, ${claimId}::uuid, ${evidenceId}::uuid, 'supports')`,
      );
      // The graph is "valid" and indistinguishable from what a future TRUSTED producer would write.
      // Therefore validateGraphIntegrity can never be what authorizes a privileged label.
      expect(await codes(project.id)).toEqual([]);
      const loaded = must(await store().loadGraph(project.id));
      expect(loaded.graph.claims.get(claimId)?.verificationLevel).toBe('machine_verified');
    });

    it('F3: README-anchored repo_corroborated evidence is stored; the validator flags the evidence but not the claim it "justifies"', async () => {
      const project = await seedProject(testDb.db, w.event.id, 'Trust F3');
      const github = await seedSnapshot(testDb.db, project, 'github', 'captured', [
        {
          key: 'files/README.md',
          kind: 'file',
          mediaType: 'text/markdown',
          text: '# Atlas\nPerfect.\n',
        },
      ]);
      const claimId = await insertClaim(project.id, 'Atlas is perfect.', 'repo_corroborated');
      const evidenceId = must(
        (
          await rows<{ id: string }>(
            testDb.db,
            sql`INSERT INTO evidence_items (project_id, event_id, kind, origin, verification_level, text,
                snapshot_id, artifact_id)
              VALUES (${project.id}::uuid, ${w.event.id}::uuid, 'fact', 'github', 'repo_corroborated',
                'README says Atlas is perfect', ${github.snapshot.id}::uuid,
                ${must(github.artifacts[0]).id}::uuid) RETURNING id`,
          )
        )[0],
      ).id;
      await testDb.db.execute(
        sql`INSERT INTO evidence_relations (project_id, claim_id, evidence_id, relation_type)
          VALUES (${project.id}::uuid, ${claimId}::uuid, ${evidenceId}::uuid, 'supports')`,
      );
      // Only the EVIDENCE is reported. The claim passes its justification check on the evidence's
      // stored LABEL. A consumer must therefore re-derive trust from structure, not read labels.
      expect(await codes(project.id)).toEqual(['ARTIFACT_NOT_CORROBORATING']);
    });

    it('F4: judge_observation and team_answer evidence cannot be inserted (CHECK), so judge/live claims can never be justified in M3/M4', async () => {
      const project = await seedProject(testDb.db, w.event.id, 'Trust F4');
      const devpost = await seedSnapshot(testDb.db, project, 'devpost', 'captured', [
        { key: 'submission.txt', kind: 'submission_text', mediaType: 'text/plain', text: 'x' },
      ]);
      for (const [origin, kind, level] of [
        ['judge_observation', 'fact', 'live_verified'],
        ['team_answer', 'claim', 'team_claim'],
      ] as const) {
        await expectPgError(
          testDb.db.execute(
            sql`INSERT INTO evidence_items (project_id, event_id, kind, origin, verification_level, text, snapshot_id)
              VALUES (${project.id}::uuid, ${w.event.id}::uuid, ${kind}, ${origin}, ${level}, 'x', ${devpost.snapshot.id}::uuid)`,
          ),
          SQLSTATE.CHECK_VIOLATION,
        );
      }
    });

    it('F5: the legitimate producer path can supersede a contradicted claim with a plain team_claim, so the HEAD of the chain shows no contradiction and no history', async () => {
      const project = await seedProject(testDb.db, w.event.id, 'Trust F5');
      const github = await seedSnapshot(testDb.db, project, 'github', 'captured', [
        { key: 'files/src/a.ts', kind: 'file', mediaType: 'text/plain', text: CODE },
      ]);
      const devpost = await seedSnapshot(testDb.db, project, 'devpost', 'captured', [
        { key: 'submission.txt', kind: 'submission_text', mediaType: 'text/plain', text: 'x' },
      ]);
      const first = await store().createGraph(
        project.id,
        {
          claims: [
            { ref: 'c', text: 'Offline cache works.', verificationLevel: 'repo_corroborated' },
          ],
          evidence: [
            {
              ref: 'code',
              kind: 'fact',
              origin: 'github',
              verificationLevel: 'repo_corroborated',
              text: 'cache implementation exists',
              provenance: {
                snapshotId: github.snapshot.id,
                artifactId: must(github.artifacts[0]).id,
              },
            },
            {
              ref: 'says',
              kind: 'claim',
              origin: 'devpost',
              verificationLevel: 'team_claim',
              text: 'The write-up describes a cache.',
              provenance: { snapshotId: devpost.snapshot.id },
            },
          ],
          relations: [{ claim: { ref: 'c' }, evidence: { ref: 'code' }, type: 'supports' }],
        },
        null,
      );
      const second = await store().createGraph(
        project.id,
        {
          claims: [
            {
              ref: 'c',
              text: 'Offline cache works.',
              verificationLevel: 'contradicted',
              supersedes: { id: must(first.refs.claims['c']) },
            },
          ],
          contradictions: [
            {
              sideA: { type: 'claim', ref: 'c' },
              sideB: { type: 'evidence', id: must(first.refs.evidence['says']) },
              description: 'The demo video shows the cache failing.',
            },
          ],
        },
        null,
      );
      const third = await store().createGraph(
        project.id,
        {
          claims: [
            {
              ref: 'c',
              text: 'Offline cache works.',
              verificationLevel: 'team_claim',
              supersedes: { id: must(second.refs.claims['c']) },
            },
          ],
        },
        null,
      );
      const loaded = must(await store().loadGraph(project.id));
      const head = must(currentClaims(loaded.graph)[0]);
      expect(head.id).toBe(third.refs.claims['c']);
      expect(head.verificationLevel).toBe('team_claim');
      // Valid by every M3 rule, yet the head shows neither the contradiction nor the earlier level.
      expect(await codes(project.id)).toEqual([]);
      expect(contradictionsTouching(loaded.graph, { type: 'claim', id: head.id })).toHaveLength(0);
      // The information is in the chain, which only a chain-aware consumer reads.
      const chain = must(supersessionView(loaded.graph, head.id));
      expect(chain.chain.map((id) => loaded.graph.claims.get(id)?.verificationLevel)).toEqual([
        'repo_corroborated',
        'contradicted',
        'team_claim',
      ]);
      expect(
        contradictionsTouching(loaded.graph, { type: 'claim', id: must(second.refs.claims['c']) }),
      ).toHaveLength(1);
    });
  },
);
