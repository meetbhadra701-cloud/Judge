/*
 * P6B-beta3-R2 (P2): a self-consistent coverage record is not proof that it describes the actual source. Real assessments are produced by the real
 * pipeline on a disposable database; the stored record is then REPLACED, with the immutability guard switched off for that one statement, by a
 * forgery that agrees with itself (entries, measures, verdict, concerns, limitations, SHA-256 and mirror). The R1 implementation accepted every one;
 * the read model must withhold the coverage (verified: false, no derived field) while the assessment's own verified report is untouched.
 */
import { canonicalJson, sha256Hex } from '../../packages/context/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COVERAGE_LIMITATION_CODES,
  verifyCoverageRecord,
} from '../../packages/assessment/src/index.js';
import { reforge } from '../../packages/assessment/src/testing/forge-coverage.js';
import { forgeries } from '../../packages/assessment/src/testing/forgeries.js';
import {
  AssessmentReadStore,
  AssessmentRunStore,
  clearProvenanceMemo,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { rows, sql } from '../../packages/database/src/testing/databases.js';
import { CoverageRecord } from '../../packages/schemas/src/index.js';
import { withGuardsDisabled } from '../../apps/worker/src/testing/corrupt.js';
import { testDatabaseTargets, type TestDatabase } from '../../apps/worker/src/testing/harness.js';
import { execute, type Executed } from '../../apps/worker/src/testing/run.js';

const source = (tag: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`).join(
    '\n',
  );
const packages = (count: number, lines: number) =>
  Array.from({ length: count }, (_, i) => ({
    path: `packages/pkg-${String(i)}/src/index.ts`,
    text: source(`pkg${String(i)}`, lines),
  }));
const docs = Array.from({ length: 20 }, (_, i) => ({
  path: `docs/notes/n${String(i).padStart(2, '0')}.md`,
  text: source(`note${String(i)}`, 300),
}));
const PARTIAL = {
  worldOptions: { extraFiles: [...packages(8, 200), ...docs], partialRepository: true },
  models: { windowing: { source: 9_000 } },
};

describe.each(testDatabaseTargets())(
  'coverage provenance against real assessments on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let reads: AssessmentReadStore;
    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      reads = new AssessmentReadStore(db);
    });
    afterAll(async () => {
      await testDb.close();
    });

    const assessmentIdOf = async (run: Executed): Promise<string> => {
      const [assessment] = await run.assessments();
      if (!assessment) throw new Error('no assessment');
      return assessment.id;
    };
    interface Stored {
      canonical: string;
      sha256: string;
      verdict: string;
      policy: string;
    }
    const storedOf = async (run: Executed): Promise<Stored> => {
      const [row] = await rows<{
        record_canonical: string;
        record_sha256: string;
        verdict: string;
        selection_policy: string;
      }>(
        db,
        sql`SELECT record_canonical, record_sha256, verdict, selection_policy FROM assessment_run_coverage WHERE run_id = ${run.runId}`,
      );
      if (!row) throw new Error('no coverage row');
      return {
        canonical: row.record_canonical,
        sha256: row.record_sha256,
        verdict: row.verdict,
        policy: row.selection_policy,
      };
    };
    /**
     * Replaces the stored record. When `limitations` is given the assessment's stored limitations are rewritten as well (they are text that no hash
     * covers), which is what a thorough forger does so that the record and the assessment agree: the INTERNAL checks then pass and only comparison
     * with the immutable evidence can tell.
     */
    const replaceStored = async (
      run: Executed,
      next: Stored,
      limitations?: unknown[],
    ): Promise<void> => {
      clearProvenanceMemo();
      await withGuardsDisabled(
        db,
        limitations === undefined ? ['coverage'] : ['coverage', 'assessments'],
        [
          sql`UPDATE assessment_run_coverage SET record_canonical = ${next.canonical}, record_sha256 = ${next.sha256},
              record = ${next.canonical}::jsonb, verdict = ${next.verdict}, selection_policy = ${next.policy}
            WHERE run_id = ${run.runId}`,
          ...(limitations === undefined
            ? []
            : [
                sql`UPDATE pre_interview_assessments SET limitations = ${JSON.stringify(limitations)}::jsonb WHERE run_id = ${run.runId}`,
              ]),
        ],
      );
    };
    const limitationsOf = async (run: Executed): Promise<{ code: string }[]> =>
      (
        await rows<{ limitations: { code: string }[] }>(
          db,
          sql`SELECT limitations FROM pre_interview_assessments WHERE run_id = ${run.runId}`,
        )
      )[0]?.limitations ?? [];
    const asStored = (record: ReturnType<typeof CoverageRecord.parse>): Stored => {
      const canonical = canonicalJson(record);
      return {
        canonical,
        sha256: sha256Hex(canonical),
        verdict: record.verdict,
        policy: record.policy.selection,
      };
    };

    it('a real record of every kind verifies by recomputation: complete, partial, partial capture, each selection policy, and a run refused at the gate', async () => {
      clearProvenanceMemo();
      const cases: [string, Parameters<typeof execute>[1], string | null][] = [
        ['complete', {}, 'complete'],
        ['partial with a partial capture', PARTIAL, 'partial'],
        ['source-selection/v1', { selection: 'source-selection/v1' }, null],
        ['source-selection/v2', { selection: 'source-selection/v2' }, null],
        ['source-selection/v3', { selection: 'source-selection/v3' }, null],
      ];
      for (const [name, scenario, verdict] of cases) {
        const run = await execute(db, scenario);
        expect(run.outcome.kind, name).toBe('succeeded');
        const detail = await reads.getDetail(run.world.project.id, await assessmentIdOf(run));
        expect(detail?.coverage, name).toMatchObject({
          status: 'recorded',
          verified: true,
          problems: [],
          provenance: { method: 'recomputed_from_snapshots', budgets: 'pinned_by_extraction' },
        });
        if (verdict !== null) expect(detail?.coverage.verdict, name).toBe(verdict);
        if (scenario?.selection !== undefined) {
          expect(detail?.coverage.policy?.selection).toBe(scenario.selection);
        }
      }
      const refused = await execute(db, {
        worldOptions: { extraFiles: packages(8, 200) },
        models: { windowing: { source: 1_000 } },
      });
      expect(refused.outcome).toMatchObject({
        kind: 'failed',
        code: 'source_coverage_insufficient',
      });
      const view = await reads.getRun(refused.world.project.id, refused.runId);
      expect(view?.coverage).toMatchObject({
        status: 'recorded',
        verified: true,
        verdict: 'insufficient',
      });
    });

    describe('the eleven forged records', () => {
      let target: Executed;
      let targetId: string;
      let other: Executed;
      let original: Stored;
      let reportBefore: string;
      let foreign: Parameters<typeof forgeries>[1];
      beforeAll(async () => {
        target = await execute(db, PARTIAL);
        other = await execute(db, {});
        targetId = await assessmentIdOf(target);
        original = await storedOf(target);
        const detail = await reads.getDetail(target.world.project.id, targetId);
        reportBefore = canonicalJson({ report: detail?.report, judgments: detail?.judgments });
        const [art] = await rows<{
          id: string;
          snapshot_id: string;
          artifact_key: string;
          content_hash: string;
          n: number;
        }>(
          db,
          sql`SELECT a.id, a.snapshot_id, a.artifact_key, a.content_hash, char_length(a.text_content)::int AS n
              FROM source_snapshot_artifacts a JOIN source_snapshots s ON s.id = a.snapshot_id
             WHERE s.project_id = ${other.world.project.id} ORDER BY a.artifact_key LIMIT 1`,
        );
        if (!art) throw new Error('no artifact of the other project');
        foreign = {
          artifactId: art.id,
          snapshotId: art.snapshot_id,
          key: art.artifact_key,
          textSha256: art.content_hash,
          totalCodePoints: art.n,
        };
      });

      it('the forged variants are generated from the genuine record', () => {
        const base = CoverageRecord.parse(JSON.parse(original.canonical));
        expect(forgeries(base, foreign)).toHaveLength(11);
      });

      for (let index = 0; index < 11; index += 1) {
        it(`forgery #${String(index + 1)}: accepted by the R1 check, withheld by the repaired read model`, async () => {
          const base = CoverageRecord.parse(JSON.parse(original.canonical));
          const [name, change, expected] = forgeries(base, foreign)[index] ?? [];
          if (name === undefined || change === undefined || expected === undefined)
            throw new Error('missing forgery');
          const forged = reforge(base, change);
          const stored = asStored(forged);
          const originalLimitations = await limitationsOf(target);
          const coverageCodes = new Set<string>(COVERAGE_LIMITATION_CODES);
          try {
            // the thorough forger also rewrites the assessment's stored limitations, so every INTERNAL check passes
            await replaceStored(target, stored, [
              ...originalLimitations.filter((l) => !coverageCodes.has(l.code)),
              ...forged.assessorInputs.limitations,
            ]);
            // what R1 checked (the record agrees with itself, the pinned ids and the stored limitations): it accepts the forgery
            const pins = await rows<{ snapshot_id: string }>(
              db,
              sql`SELECT snapshot_id FROM assessment_run_input_snapshots WHERE run_id = ${target.runId}`,
            );
            const old = verifyCoverageRecord(
              {
                canonical: stored.canonical,
                sha256: stored.sha256,
                mirror: JSON.parse(stored.canonical) as unknown,
              },
              {
                pinnedSnapshotIds: pins.map((p) => p.snapshot_id),
                storedLimitations: forged.assessorInputs.limitations,
              },
            );
            expect(old.ok, `${name}: the R1 check`).toBe(true);

            const detail = await reads.getDetail(target.world.project.id, targetId);
            // withheld: not verified, the reason is named, and NOTHING derived from the forgery is exposed
            expect(
              detail?.coverage.verified,
              `${name}: ${JSON.stringify(detail?.coverage.problems)}`,
            ).toBe(false);
            for (const code of expected)
              expect(
                detail?.coverage.problems,
                `${name}: ${JSON.stringify(detail?.coverage.problems)}`,
              ).toContain(code);
            expect(detail?.coverage).toMatchObject({
              status: 'recorded',
              verdict: null,
              measures: null,
              concerns: [],
              omittedComponents: [],
              documentation: [],
              snapshots: [],
              assessorNotices: [],
              artifactCount: 0,
              provenance: null,
            });
            expect(JSON.stringify(detail?.coverage)).not.toContain('invented');
            const full = await reads.getCoverage(target.world.project.id, targetId);
            expect(full?.record).toBeNull();
            const listed = (await reads.list(target.world.project.id)).find(
              (a) => a.id === targetId,
            );
            expect(listed?.coverage).toMatchObject({
              status: 'recorded',
              verified: false,
              verdict: null,
              concerns: [],
            });
            // the assessment's own verified report is preserved (the established assessment-integrity contract), with coverage marked invalid
            expect(detail?.verified).toBe(true);
            expect(canonicalJson({ report: detail?.report, judgments: detail?.judgments })).toBe(
              reportBefore,
            );
          } finally {
            await replaceStored(target, original, originalLimitations);
          }
          // restored: the genuine record verifies again
          const again = await reads.getDetail(target.world.project.id, targetId);
          expect(again?.coverage.verified).toBe(true);
        });
      }
    });

    it('a verification outcome is never reused after the evidence changed: the same record stops verifying when the frozen configuration it was checked against no longer fits', async () => {
      const run = await execute(db, {});
      const id = await assessmentIdOf(run);
      const original = await rows<{ pipeline_config: unknown }>(
        db,
        sql`SELECT pipeline_config FROM assessment_run_inputs WHERE run_id = ${run.runId}`,
      );
      clearProvenanceMemo();
      expect((await reads.getDetail(run.world.project.id, id))?.coverage.verified).toBe(true); // memoized now
      try {
        // the run's frozen configuration is rewritten (an immutable row; the guard is disabled for this one statement): the budgets the record
        // was made under are no longer ones this configuration and extraction can explain
        await withGuardsDisabled(
          db,
          ['runInputs'],
          [
            sql`UPDATE assessment_run_inputs SET pipeline_config = jsonb_set(pipeline_config, '{windowing,source}', '60000') WHERE run_id = ${run.runId}`,
          ],
        );
        const detail = await reads.getDetail(run.world.project.id, id);
        expect(detail?.coverage.verified).toBe(false);
        expect(detail?.coverage.problems).toContain('provenance_budget_mismatch');
      } finally {
        await withGuardsDisabled(
          db,
          ['runInputs'],
          [
            sql`UPDATE assessment_run_inputs SET pipeline_config = ${JSON.stringify(original[0]?.pipeline_config)}::jsonb WHERE run_id = ${run.runId}`,
          ],
        );
        clearProvenanceMemo();
      }
      expect((await reads.getDetail(run.world.project.id, id))?.coverage.verified).toBe(true);
    });

    it('coverage of one project is never readable through another, and a forged record of one project does not affect another', async () => {
      const a = await execute(db, {});
      const b = await execute(db, {});
      const idA = await assessmentIdOf(a);
      expect(await reads.getCoverage(b.world.project.id, idA)).toBeNull();
      expect(await reads.getDetail(b.world.project.id, idA)).toBeNull();
      const before = await reads.getDetail(b.world.project.id, await assessmentIdOf(b));
      const forged = asStored(
        reforge(CoverageRecord.parse(JSON.parse((await storedOf(a)).canonical)), (r) => {
          r.snapshots[0] && (r.snapshots[0].status = 'partial');
        }),
      );
      const original = await storedOf(a);
      try {
        await replaceStored(a, forged);
        expect((await reads.getDetail(a.world.project.id, idA))?.coverage.verified).toBe(false);
        expect(
          (await reads.getDetail(b.world.project.id, await assessmentIdOf(b)))?.coverage,
        ).toEqual(before?.coverage);
      } finally {
        await replaceStored(a, original);
      }
    });

    it('INVALID COVERAGE AUTHORIZES NO SPENDING: a record planted for a run before the worker writes its own aborts the run before any model call or ledger entry', async () => {
      const runs = new AssessmentRunStore({ db });
      let planted = false;
      const run = await execute(db, {
        deps: {
          runs: new Proxy(runs, {
            get(target, property, receiver) {
              if (property !== 'recordCoverage')
                return Reflect.get(target, property, receiver) as unknown;
              return async (
                runId: string,
                lease: string,
                built: { canonical: string; sha256: string },
              ) => {
                // an unauthorized writer gets in first: a record claiming everything was inspected
                const record = CoverageRecord.parse(JSON.parse(built.canonical));
                const forged = asStored(
                  reforge(record, (r) => {
                    for (const e of r.artifacts) {
                      e.status = 'full';
                      e.shownCodePoints = e.totalCodePoints;
                      e.unshown = [];
                    }
                  }),
                );
                await db.execute(sql`INSERT INTO assessment_run_coverage (run_id, project_id, schema_id, selection_policy, verdict, record_canonical, record_sha256, record)
                SELECT ${runId}::uuid, project_id, ${forged.canonical}::jsonb->>'schema', ${forged.policy}, ${forged.verdict}, ${forged.canonical}, ${forged.sha256}, ${forged.canonical}::jsonb
                  FROM analysis_runs WHERE id = ${runId}::uuid`);
                planted = true;
                return runs.recordCoverage(runId, lease, built);
              };
            },
          }),
        },
        ...PARTIAL,
      });
      expect(planted).toBe(true);
      expect(run.outcome).toMatchObject({
        kind: 'failed',
        code: 'coverage_record_rejected_coverage_rejected',
        stage: 'write_coverage_record',
      });
      expect(run.model.calls).toHaveLength(0);
      expect(
        await rows(db, sql`SELECT 1 FROM assessment_run_calls WHERE run_id = ${run.runId}`),
      ).toHaveLength(0);
      expect(await run.assessments()).toHaveLength(0);
      const view = await reads.getRun(run.world.project.id, run.runId);
      expect(view?.coverage.verified).toBe(false); // the planted record does not verify against the evidence either
      expect(view?.usage).toMatchObject({ attemptsStarted: 0, costNanoUsd: 0 });
    });
  },
);
