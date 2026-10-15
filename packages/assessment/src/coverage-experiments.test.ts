import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPassages, DEFAULT_BUDGETS, type WindowingResult } from './windowing.js';
import {
  ALL_SCENARIOS,
  artifactsFromProfile,
  artifactsOf,
  type CaptureProfile,
} from './testing/coverage-repos.js';
import { measure, type Metrics } from './testing/coverage-metrics.js';

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
    const result = buildPassages(run.artifacts, DEFAULT_BUDGETS);
    results[`v1/${run.scenario.name}`] = summary(measure(run.artifacts, result));
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it('real-judge-404: the 404-artifact capture reconstructed from its metadata profile', () => {
    const artifacts = artifactsFromProfile(PROFILE);
    expect(artifacts).toHaveLength(404);
    const result: WindowingResult = buildPassages(artifacts, DEFAULT_BUDGETS);
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
