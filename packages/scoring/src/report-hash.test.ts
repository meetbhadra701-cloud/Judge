import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScoreReport, SCORING_ENGINE_VERSION, type ScoreReportBody } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf, sha256Hex } from './canonical.js';
import { scoreProject } from './engine.js';
import { parametersHash } from './parameters-hash.js';
import { reportOutputHash, verifyScoreReportHash } from './report-hash.js';
import { goldenScenarios } from './testing/scenarios.js';

/*
 * The additive export that verifies M4's `outputHash` (M5 design §8.9). It must reproduce the engine's EXISTING computation
 * (`outputHash = hashOf(body)`, body = the report WITHOUT outputHash), not introduce a new report-hashing rule. engine.ts is not edited.
 */

const GOLDEN = join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'golden');

/** Every golden file that holds a COMPLETE report (the others record rejections or issue lists). */
function goldenReports(): { name: string; report: ScoreReport }[] {
  return readdirSync(GOLDEN)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const parsed = ScoreReport.safeParse(JSON.parse(readFileSync(join(GOLDEN, name), 'utf8')));
      return parsed.success ? [{ name, report: parsed.data }] : [];
    });
}

describe('reportOutputHash / verifyScoreReportHash', () => {
  const reports = goldenReports();

  it('finds the existing golden reports (the test fails if it finds none)', () => {
    // 16 golden files: 14 complete reports + 2 rejection lists. A new golden file is a deliberate change to this count.
    expect(readdirSync(GOLDEN).filter((name) => name.endsWith('.json'))).toHaveLength(16);
    expect(reports).toHaveLength(14);
  });

  it.each(reports.map((r) => [r.name, r.report] as const))(
    "%s: verifies by the engine's own rule",
    (_name, report) => {
      const { outputHash, ...body } = report;
      expect(reportOutputHash(body)).toBe(outputHash);
      expect(verifyScoreReportHash(report)).toEqual({
        ok: true,
        expected: outputHash,
        actual: outputHash,
      });
      // negative control: the SHA-256 of the whole serialized report is a DIFFERENT value, so the two must never be conflated
      expect(sha256Hex(canonicalJson(report))).not.toBe(outputHash);
      // negative control: hashing the body together with its own hash is not the rule either
      expect(hashOf({ ...body, outputHash })).not.toBe(outputHash);
    },
  );

  it('verifies every report the engine produces for every golden scenario', () => {
    const scenarios = goldenScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(14);
    for (const scenario of scenarios) {
      const result = scoreProject(scenario.context, scenario.body, scenario.options);
      if (!result.ok) continue; // rejection scenarios have no report
      expect(verifyScoreReportHash(result.report).ok, scenario.name).toBe(true);
    }
  });

  it('fails when any field of the body is tampered with', () => {
    const [first] = reports;
    if (!first) throw new Error('no golden report');
    const { report } = first;
    const tampered: Record<string, ScoreReport> = {
      parametersHash: { ...report, parametersHash: 'f'.repeat(64) },
      inputFingerprint: { ...report, inputFingerprint: 'f'.repeat(64) },
      graphFingerprint: { ...report, graphFingerprint: 'f'.repeat(64) },
      rubricName: { ...report, rubric: { ...report.rubric, name: `${report.rubric.name}!` } },
    };
    const dimension = report.dimensions[0];
    if (dimension) {
      tampered['dimensionName'] = {
        ...report,
        dimensions: [{ ...dimension, name: `${dimension.name}!` }, ...report.dimensions.slice(1)],
      };
    }
    for (const [name, forged] of Object.entries(tampered)) {
      expect(verifyScoreReportHash(forged).ok, name).toBe(false);
    }
    // controls: an unchanged copy still verifies
    expect(verifyScoreReportHash({ ...report, overall: { ...report.overall } }).ok).toBe(true);
  });

  it('fails when only the stored outputHash is tampered with', () => {
    const [first] = reports;
    if (!first) throw new Error('no golden report');
    const forged = { ...first.report, outputHash: 'e'.repeat(64) };
    const result = verifyScoreReportHash(forged);
    expect(result.ok).toBe(false);
    expect(result.expected).toBe('e'.repeat(64));
    expect(result.actual).toBe(first.report.outputHash);
  });

  it('is pure and key-order independent (canonical JSON)', () => {
    const [first] = reports;
    if (!first) throw new Error('no golden report');
    const { outputHash, ...body } = first.report;
    const reordered = Object.fromEntries(Object.entries(body).reverse()) as ScoreReportBody;
    expect(reportOutputHash(reordered)).toBe(outputHash);
  });
});

describe('the engine is unchanged', () => {
  it('every golden report was produced by this engine version and these parameters', () => {
    for (const { report } of goldenReports()) {
      expect(report.engineVersion).toBe(SCORING_ENGINE_VERSION);
      expect(report.parametersHash).toBe(parametersHash);
    }
  });
});
