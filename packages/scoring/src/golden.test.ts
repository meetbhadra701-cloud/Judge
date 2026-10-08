import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { createTrustedScoringContext } from './context.js';
import { scoreProject } from './engine.js';
import { goldenScenarios } from './testing/scenarios.js';
import {
  baseWorld,
  cite,
  codeEvidence,
  devpostEvidence,
  lockedSnapshot,
  makeContext,
  payload,
  rubricDefinition,
  scored,
  uid,
} from './testing/builders.js';

/*
 * Golden numerical fixtures. Each scenario's FULL canonical report is stored under
 * packages/scoring/golden/ and compared byte for byte. The expected numbers of the approved design
 * are additionally asserted inline, so regenerating a golden file (UPDATE_GOLDEN=1) can never
 * silently change a headline value: both have to be changed, and reviewed.
 */

const PACKAGE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const GOLDEN = join(PACKAGE, 'golden');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

function check(name: string, value: unknown) {
  const path = join(GOLDEN, `${name}.json`);
  const text = `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, text);
  }
  expect(existsSync(path), `missing golden file ${name}.json (run with UPDATE_GOLDEN=1)`).toBe(
    true,
  );
  expect(text).toBe(readFileSync(path, 'utf8'));
}

const scenarios = goldenScenarios();
const reportOf = (name: string): ScoreReport => {
  const scenario = scenarios.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const result = scoreProject(scenario.context, scenario.body, scenario.options);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
};
const dim = (report: ScoreReport, id: string) => {
  const found = report.dimensions.find((d) => d.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

describe('golden reports (full canonical bytes)', () => {
  it('covers every required scenario', () => {
    expect(scenarios.map((s) => s.name)).toEqual([
      'official-weighted-scale-1-5',
      'official-unweighted',
      'official-unweighted-with-unofficial-preview',
      'fallback-no-tracks-with-gaps',
      'fallback-with-declared-track',
      'missing-evidence-partial-criterion',
      'weak-but-well-supported',
      'high-quality-low-confidence',
      'contradictions-lineage-and-unmapped',
      'direct-sql-privileged-labels',
      'ten-statements-one-source',
      'official-citation-presence-proxy',
      'scored-without-usable-citation',
      'all-insufficient',
    ]);
  });

  it.each(scenarios.map((scenario) => scenario.name))('%s', (name) => {
    check(name, reportOf(name));
  });
});

describe('golden headline numbers (inline, independent of the files)', () => {
  it('official weighted scale 1-5 (E13): overall 5.5, 3.2 on the official scale', () => {
    const r = reportOf('official-weighted-scale-1-5');
    expect(r.overall).toMatchObject({
      state: 'scored',
      weightBasis: 'official',
      score10: 5.5,
      scoreOnScale: 3.2,
    });
    expect(r.rubric.official).toBe(true);
  });

  it('official unweighted (E14): no overall number; preview exactly 7.0 at share 0.6667 and labeled unofficial', () => {
    const plain = reportOf('official-unweighted');
    expect(plain.overall.state).toBe('not_computed');
    expect(plain.unofficialPreview).toBeNull();
    const preview = reportOf('official-unweighted-with-unofficial-preview');
    expect(preview.overall.state).toBe('not_computed');
    expect(preview.unofficialPreview).toMatchObject({
      official: false,
      weightBasis: 'equal_assumed',
      state: 'scored_partial',
      score10: 7,
      assessedWeightShare: 0.6667,
    });
  });

  it('fallback with gaps (E12): overall 6.9063, Track not_applicable', () => {
    const r = reportOf('fallback-no-tracks-with-gaps');
    expect(r.overall).toMatchObject({
      state: 'scored_partial',
      score10: 6.9063,
      assessedWeightShare: 0.8889,
    });
    expect(r.criteria.find((c) => c.key === 'track_prize_alignment')?.state).toBe('not_applicable');
  });

  it('missing evidence (E11): the criterion is 7.0, not 5.6', () => {
    const r = reportOf('missing-evidence-partial-criterion');
    const c = r.criteria.find((x) => x.key === 'technical_execution');
    expect(c).toMatchObject({ state: 'partial', score10: 7, assessedWeightShare: 0.8 });
  });

  it('weak but well supported (E5) and high quality / low confidence (E4)', () => {
    expect(
      dim(reportOf('weak-but-well-supported'), 'completion_functionality.core_user_flow'),
    ).toMatchObject({ score10: 3, confidence: 0.6 });
    expect(
      dim(reportOf('high-quality-low-confidence'), 'technical_execution.architecture_integration'),
    ).toMatchObject({ score10: 9, confidence: 0.063 });
  });

  it('contradictions (E2 / F5): k = 2 -> confidence 0.294, score untouched, the stray one is listed', () => {
    const r = reportOf('contradictions-lineage-and-unmapped');
    expect(dim(r, 'completion_functionality.core_user_flow')).toMatchObject({
      score10: 7,
      confidence: 0.294,
    });
    expect(r.claimLineages).toHaveLength(1);
    expect(r.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['UNMAPPED_CONTRADICTION', 'LINEAGE_CONTRADICTION_IN_HISTORY']),
    );
  });

  it('privileged labels (E9): worth 0.15, with neutral diagnostics', () => {
    const r = reportOf('direct-sql-privileged-labels');
    expect(dim(r, 'technical_execution.implementation_depth')).toMatchObject({
      evidenceStrength: 0.6,
    });
    expect(dim(r, 'innovation_creativity.original_technical_contribution')).toMatchObject({
      evidenceStrength: 0.15,
    });
    expect(dim(r, 'technical_execution.correctness_robustness')).toMatchObject({
      evidenceStrength: 0.15,
    });
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining(['UNATTESTED_PRIVILEGED_LEVEL', 'UNSUPPORTED_REPO_CORROBORATION']),
    );
  });

  it('ten statements (E3): 0.35', () => {
    expect(
      dim(reportOf('ten-statements-one-source'), 'impact_problem_fit.problem_clarity'),
    ).toMatchObject({ evidenceStrength: 0.35, provenanceGroupCount: 1 });
  });

  it('citation presence (E8): confidence = strength, coverage null', () => {
    const r = reportOf('official-citation-presence-proxy');
    expect(dim(r, 'official.a')).toMatchObject({
      confidence: 0.6,
      confidenceBasis: 'citation_presence',
    });
    expect(dim(r, 'official.b')).toMatchObject({ confidence: 0.126 });
  });

  it('scored without usable citation (D10) and all insufficient: states, never zeros', () => {
    const r = reportOf('scored-without-usable-citation');
    expect(dim(r, 'technical_execution.technical_ownership').state).toBe('insufficient_evidence');
    expect(dim(r, 'demo_communication.actual_proof_demonstration').state).toBe(
      'insufficient_evidence',
    );
    expect(r.diagnostics.filter((d) => d.code === 'JUDGED_VALUE_NOT_USED')).toHaveLength(2);
    const none = reportOf('all-insufficient');
    expect(none.overall.state).toBe('insufficient_evidence');
    expect(none.dimensions.every((d) => d.state === 'insufficient_evidence')).toBe(true);
  });
});

describe('rejection goldens: invalid weights and invalid IDs are rejected, never repaired', () => {
  const invalidWeights: Record<string, (number | null)[]> = {
    'sum-too-high': [0.5, 0.6],
    'sum-too-low': [0.3, 0.3, 0.3],
    'partially-weighted': [0.5, null],
    'zero-weight': [0, 1],
    'negative-weight': [-0.5, 1.5],
    'weight-above-one': [1.5],
    'not-a-number': [Number.NaN, 1],
    infinite: [Number.POSITIVE_INFINITY],
  };

  it('invalid published weights', () => {
    const issues: Record<string, unknown> = {};
    for (const [name, weights] of Object.entries(invalidWeights)) {
      const rubric = rubricDefinition({
        criteria: weights.map((weight, index) => ({ key: `c${String(index)}`, weight })),
      });
      const result = createTrustedScoringContext({
        ...baseWorld().build(),
        locked: lockedSnapshot({ rubrics: [rubric] }),
        target: { kind: 'overall' },
        declaredTrackKeys: [],
      });
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.every((issue) => issue.code === 'RUBRIC_INVALID'),
          name,
        ).toBe(true);
        issues[name] = result.issues;
      }
    }
    check('rejections-invalid-weights', issues);
  });

  it('invalid and invented identifiers', () => {
    const g = baseWorld();
    const code = codeEvidence(g, uid(1, 'e0b00001'));
    const dev = devpostEvidence(g, uid(2, 'e0b00001'));
    const rubric = rubricDefinition({
      criteria: [
        { key: 'a', weight: 0.5 },
        { key: 'b', weight: 0.5 },
      ],
    });
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
    const rejected: Record<string, unknown> = {};
    const cases: Record<string, unknown> = {
      'invented-evidence-id': payload(
        scored('official.a', 5, cite(uid(9, 'deadbeef'))),
        scored('official.b', 5, cite(dev)),
      ),
      'malformed-evidence-id': payload(
        scored('official.a', 5, cite('not-a-uuid')),
        scored('official.b', 5, cite(dev)),
      ),
      'unknown-dimension': payload(
        scored('official.a', 5, cite(code)),
        scored('official.b', 5, cite(dev)),
        scored('official.ghost', 5, cite(dev)),
      ),
      'invented-fallback-dimension': payload(
        scored('official.a', 5, cite(code)),
        scored('technical_execution.implementation_depth', 5, cite(dev)),
      ),
      'duplicate-citation': payload(
        scored('official.a', 5, cite(code), cite(code)),
        scored('official.b', 5, cite(dev)),
      ),
      'out-of-scale': payload(
        scored('official.a', 11, cite(code)),
        scored('official.b', 5, cite(dev)),
      ),
      'smuggled-attestation': {
        ...payload(scored('official.a', 5, cite(code)), scored('official.b', 5, cite(dev))),
        attestations: [code],
      },
    };
    for (const [name, body] of Object.entries(cases)) {
      const result = scoreProject(ctx, body);
      expect(result.ok, name).toBe(false);
      if (!result.ok) rejected[name] = result.issues;
    }
    check('rejections-invalid-ids', rejected);
  });
});

describe('cross-process determinism', () => {
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=@judge-copilot/source',
        '--import',
        'tsx',
        join(PACKAGE, 'src/testing/hash-cli.ts'),
      ],
      { cwd: PACKAGE, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };

  it('two fresh processes print the same output hash for every scenario, equal to this process', () => {
    const first = run();
    const second = run();
    expect(second).toBe(first);
    const inProcess = scenarios
      .map((scenario) => `${scenario.name} ${reportOf(scenario.name).outputHash}`)
      .join('\n');
    expect(first.trim()).toBe(inProcess);
    expect(first).not.toContain('REJECTED');
  });
});
