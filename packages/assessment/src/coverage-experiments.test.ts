import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildPassages,
  DEFAULT_BUDGETS,
  SELECTION_POLICY,
  SELECTION_POLICY_V1,
  type SourceArtifact,
  type WindowingResult,
} from './windowing.js';
import {
  ALL_SCENARIOS,
  artifactsFromProfile,
  artifactsOf,
  hostileInstructions,
  type CaptureProfile,
} from './testing/coverage-repos.js';
import { measure, shownByKey, type Metrics } from './testing/coverage-metrics.js';
import { THRESHOLDS } from './testing/coverage-thresholds.js';

/*
 * P6B-beta3 (R9-B1): evidence-selection experiments. Every scenario is run through the selection under the SAME budgets and measured by the
 * independent oracle (testing/coverage-metrics.ts). With COVERAGE_REPORT=<file> the numbers are written as JSON for the milestone report.
 */

const PROFILE = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../tests/fixtures/real-github/coverage-profile-judge-9459c98.json',
    ),
    'utf8',
  ),
) as CaptureProfile;

const results: Record<string, unknown> = {};
afterAll(() => {
  const target = process.env['COVERAGE_REPORT'];
  if (target) writeFileSync(target, `${JSON.stringify(results, null, 2)}\n`);
});

const summary = (m: Metrics) => ({
  componentCoverage: Number(m.componentCoverage.toFixed(3)),
  implementationComponents: `${String(m.implementationComponents.covered)}/${String(m.implementationComponents.total)}`,
  uncovered: m.implementationComponents.uncovered.length,
  maxArtifactShare: `${m.maxArtifactShare.key} ${m.maxArtifactShare.share.toFixed(3)}`,
  rootReadmeShown: `${String(m.rootReadmeShown)}/${String(m.rootReadmeLength)}`,
  testShareOfSource: Number(m.testShareOfSource.toFixed(3)),
  generatedShareOfSource: Number(m.generatedShareOfSource.toFixed(3)),
  sourceUtilization: Number(m.sourceUtilization.toFixed(3)),
  byRole: Object.fromEntries(
    Object.entries(m.byRole).map(([role, c]) => [
      role,
      `${String(c.filesShown)}/${String(c.files)} files, ${String(c.codePointsShown)}/${String(c.codePoints)} cp`,
    ]),
  ),
});

describe('v1 baseline (the selection as accepted in P6B-beta2): measured, not judged', () => {
  const runs = [...ALL_SCENARIOS.map((make) => make())].map((scenario) => ({
    scenario,
    artifacts: artifactsOf(scenario),
  }));

  it.each(runs.map((r) => [r.scenario.name, r] as const))('%s', (_name, run) => {
    const result = buildPassages(run.artifacts, DEFAULT_BUDGETS, SELECTION_POLICY_V1);
    results[`v1/${run.scenario.name}`] = summary(measure(run.artifacts, result));
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it('real-judge-404: the 404-artifact capture reconstructed from its metadata profile', () => {
    const artifacts = artifactsFromProfile(PROFILE);
    expect(artifacts).toHaveLength(404);
    const result: WindowingResult = buildPassages(artifacts, DEFAULT_BUDGETS, SELECTION_POLICY_V1);
    const shownArtifacts = new Set(result.passages.map((p) => p.artifactKey)).size;
    const reasons: Record<string, number> = {};
    for (const o of result.omissions) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
    results['v1/real-judge-404'] = {
      ...summary(measure(artifacts, result)),
      artifacts: artifacts.length,
      shownArtifacts,
      passages: result.passages.length,
      omissionsByReason: reasons,
      buckets: result.buckets,
    };
    expect(shownArtifacts).toBeGreaterThan(0);
  });
});

// -- v2: acceptance against the thresholds fixed BEFORE it was written (testing/coverage-thresholds.ts) -------------------------------------

type Run = { name: string; artifacts: SourceArtifact[] };
const runsV2: Run[] = [
  ...ALL_SCENARIOS.map((make) => {
    const scenario = make();
    return { name: scenario.name, artifacts: artifactsOf(scenario) };
  }),
  { name: 'real-judge-404', artifacts: artifactsFromProfile(PROFILE) },
];
const v1Of = (run: Run) => buildPassages(run.artifacts, DEFAULT_BUDGETS, SELECTION_POLICY_V1);
const v2Of = (run: Run) => buildPassages(run.artifacts, DEFAULT_BUDGETS, SELECTION_POLICY);

describe('v2 acceptance thresholds', () => {
  it.each(runsV2.map((r) => [r.name, r] as const))(
    '%s: measured and within thresholds',
    (_n, run) => {
      const v1 = measure(run.artifacts, v1Of(run));
      const result = v2Of(run);
      const m = measure(run.artifacts, result);
      results[`v2/${run.name}`] = summary(m);
      const statusCounts: Record<string, number> = {};
      for (const entry of result.coverage.artifacts) {
        statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
      }
      const skipped = result.omissions.filter(
        (o) => o.reason !== 'budget_exhausted' && o.reason !== 'duplicate_content',
      ).length;
      // every artifact is accounted for exactly once: shown in full, shown in part, never shown, a duplicate of a shown file, or skipped by routing
      expect(result.coverage.artifacts.length + skipped).toBe(run.artifacts.length);
      results[`v2-accounting/${run.name}`] = {
        artifacts: run.artifacts.length,
        ...statusCounts,
        skippedByRouting: skipped,
      };
      results[`v1-vs-v2/${run.name}`] = {
        componentCoverage: [
          Number(v1.componentCoverage.toFixed(3)),
          Number(m.componentCoverage.toFixed(3)),
        ],
        verdict: result.coverage.verdict,
        concerns: result.coverage.concerns,
      };

      // implementation components
      const over = m.implementationComponents.total > THRESHOLDS.componentHeadCapacity;
      const minCoverage = over
        ? THRESHOLDS.componentCoverageMinWhenOverCapacity
        : THRESHOLDS.implementationComponentCoverageMin;
      expect(m.componentCoverage).toBeGreaterThanOrEqual(minCoverage);

      // one file may not eat a bucket's budget while another eligible file of that bucket is unseen (judged per bucket)
      for (const bucket of ['statement', 'source', 'metadata'] as const) {
        const entry = m.perBucket[bucket];
        if (entry.unshownEligible > 0) {
          expect(entry.maxShare.share, `${bucket}: ${entry.maxShare.key}`).toBeLessThanOrEqual(
            THRESHOLDS.maxArtifactShareWhileOthersUnshown + 1_200 / DEFAULT_BUDGETS[bucket] + 1e-9,
          );
        }
      }
      // root README
      expect(m.rootReadmeShown).toBeGreaterThanOrEqual(
        Math.min(THRESHOLDS.rootReadmeMinCodePoints, m.rootReadmeLength),
      );
      // deployment
      if (
        m.deployment.codePoints <=
        THRESHOLDS.deploymentMaxShareForGuarantee * DEFAULT_BUDGETS.source
      ) {
        expect(m.deployment.headsShown).toBe(m.deployment.files);
      }
      // tests do not displace implementation
      if (m.implementationComponents.uncovered.length > 0) {
        expect(m.testShareOfSource).toBeLessThanOrEqual(
          THRESHOLDS.testShareMaxWhileComponentsUncovered,
        );
      }
      if (m.byRole.test.files > 0) expect(m.byRole.test.filesShown).toBeGreaterThan(0);
      // generated files and duplicates do not displace implementation
      if (m.unshownDistinctImplementationFiles > 0) {
        expect(m.generatedShareOfSource).toBeLessThanOrEqual(THRESHOLDS.generatedShareMax + 1e-9);
      }
      // no wasted budget
      const source = result.buckets.find((b) => b.bucket === 'source');
      if (source && source.eligibleCodePoints > source.budget) {
        expect(m.sourceUtilization).toBeGreaterThanOrEqual(THRESHOLDS.budgetUtilizationMin);
      }
      // never worse than v1 at the same budgets
      expect(m.componentCoverage).toBeGreaterThanOrEqual(v1.componentCoverage);
      expect(m.rootReadmeShown).toBeGreaterThanOrEqual(
        Math.min(v1.rootReadmeShown, THRESHOLDS.rootReadmeMinCodePoints),
      );
      expect(m.deployment.headsShown).toBeGreaterThanOrEqual(v1.deployment.headsShown);
    },
  );

  it('is strictly better than v1 on component coverage where v1 left components unseen (monorepo cases)', () => {
    for (const name of ['large-monorepo', 'real-judge-404']) {
      const run = runsV2.find((r) => r.name === name) as Run;
      const before = measure(run.artifacts, v1Of(run));
      const after = measure(run.artifacts, v2Of(run));
      expect(before.componentCoverage, name).toBeLessThan(1);
      expect(after.componentCoverage, name).toBeGreaterThan(before.componentCoverage);
    }
  });

  it.each(runsV2.map((r) => [r.name, r] as const))(
    '%s: the coverage report is exactly what the independent oracle recomputes from the passages',
    (_n, run) => {
      const result = v2Of(run);
      const shown = shownByKey(result);
      const ranges = new Map<string, [number, number][]>();
      for (const p of result.passages) {
        const list = ranges.get(p.artifactKey) ?? [];
        list.push([p.start, p.end]);
        ranges.set(p.artifactKey, list);
      }
      for (const entry of result.coverage.artifacts) {
        expect(entry.shownCodePoints).toBe(shown.get(entry.artifactKey) ?? 0);
        expect(entry.shownRanges.map((r) => [r.start, r.end])).toEqual(
          ranges.get(entry.artifactKey) ?? [],
        );
        expect(entry.status === 'full' ? entry.unshownRanges.length : 1).toBe(
          entry.status === 'full' ? 0 : 1,
        );
        if (entry.status === 'partial' || entry.status === 'unseen')
          expect(entry.unshownRanges).not.toEqual([]);
        expect(entry.shownCodePoints).toBeLessThanOrEqual(entry.totalCodePoints);
        // the part never shown starts where the shown prefix ends and runs to the end of the stored text (recomputed here from the text itself)
        const text = run.artifacts.find((a) => a.key === entry.artifactKey)?.text ?? '';
        const length = [...text].length;
        const lastShownEnd =
          entry.shownRanges.length === 0
            ? 0
            : (entry.shownRanges[entry.shownRanges.length - 1]?.end ?? 0);
        if (entry.status === 'partial' || entry.status === 'unseen') {
          expect(entry.unshownRanges).toEqual([{ start: lastShownEnd, end: length }]);
        }
      }
      // every omission is accounted for by a coverage entry and vice versa
      const unfinished = result.coverage.artifacts.filter((e) => e.status !== 'full');
      expect(unfinished.map((e) => e.artifactKey).sort()).toEqual(
        result.omissions
          .filter((o) => o.reason === 'budget_exhausted' || o.reason === 'duplicate_content')
          .map((o) => o.artifactKey)
          .sort(),
      );
    },
  );

  it('selection does not depend on file content: hostile instructions move nothing', () => {
    const { benign, hostile } = hostileInstructions();
    const a = buildPassages(artifactsOf(benign), DEFAULT_BUDGETS, SELECTION_POLICY);
    const b = buildPassages(artifactsOf(hostile), DEFAULT_BUDGETS, SELECTION_POLICY);
    const shape = (r: WindowingResult) =>
      r.passages.map((p) => `${p.artifactKey}:${String(p.start)}-${String(p.end)}`);
    expect(shape(b)).toEqual(shape(a));
    expect(b.coverage.verdict).toBe(a.coverage.verdict);
  });

  it.each(runsV2.map((r) => [r.name, r] as const))(
    '%s: any permutation of the input gives an identical result',
    (_n, run) => {
      const forward = v2Of(run);
      const reversed = buildPassages(
        [...run.artifacts].reverse(),
        DEFAULT_BUDGETS,
        SELECTION_POLICY,
      );
      const rotated = buildPassages(
        [...run.artifacts.slice(7), ...run.artifacts.slice(0, 7)],
        DEFAULT_BUDGETS,
        SELECTION_POLICY,
      );
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
      expect(JSON.stringify(rotated)).toBe(JSON.stringify(forward));
    },
  );
});
