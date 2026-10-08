import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf, roundReported } from './canonical.js';
import {
  CONTRADICTION_CAP,
  SCORING_PARAMETERS,
  contradictionFactor,
  type EffectiveLevel,
} from './parameters.js';
import { parametersHash } from './parameters-hash.js';
import { FALLBACK_RUBRIC_DEFINITION } from './rubric/fallback.js';
import { evidenceItemStrength } from './strength.js';

// The approved V1 heuristics, written out independently of the implementation.
const V: Record<EffectiveLevel, number> = {
  unverified: 0.15,
  team_claim: 0.35,
  repo_corroborated: 0.6,
};
const DIRECTNESS = { direct: 1, adjacent: 0.6, indirect: 0.3 } as const;
const SPECIFICITY = { exact: 1, partial: 0.6, generic: 0.3 } as const;

describe('evidence item strength = V(level) x L(directness) x L(specificity)', () => {
  const cells = (Object.keys(V) as EffectiveLevel[]).flatMap((level) =>
    (Object.keys(DIRECTNESS) as (keyof typeof DIRECTNESS)[]).flatMap((directness) =>
      (Object.keys(SPECIFICITY) as (keyof typeof SPECIFICITY)[]).map(
        (specificity) => [level, directness, specificity] as const,
      ),
    ),
  );

  it('covers all 27 cells of the ladder', () => {
    expect(cells).toHaveLength(27);
  });

  it.each(cells)('%s / %s / %s', (level, directness, specificity) => {
    expect(evidenceItemStrength(level, directness, specificity)).toBe(
      V[level] * DIRECTNESS[directness] * SPECIFICITY[specificity],
    );
  });

  it('is always in (0, 0.6] and ordered by every factor', () => {
    const values = cells.map((cell) => evidenceItemStrength(...cell));
    expect(Math.min(...values)).toBeCloseTo(0.0135, 12);
    expect(Math.max(...values)).toBe(0.6);
    expect(values.every((value) => value > 0 && value <= 0.6)).toBe(true);
    for (const directness of ['direct', 'adjacent', 'indirect'] as const) {
      for (const specificity of ['exact', 'partial', 'generic'] as const) {
        expect(evidenceItemStrength('repo_corroborated', directness, specificity)).toBeGreaterThan(
          evidenceItemStrength('team_claim', directness, specificity),
        );
        expect(evidenceItemStrength('team_claim', directness, specificity)).toBeGreaterThan(
          evidenceItemStrength('unverified', directness, specificity),
        );
      }
    }
  });

  it('matches the worked examples (E1, E3, E9)', () => {
    expect(roundReported(evidenceItemStrength('repo_corroborated', 'direct', 'exact'))).toBe(0.6);
    expect(roundReported(evidenceItemStrength('unverified', 'direct', 'exact'))).toBe(0.15);
    expect(roundReported(evidenceItemStrength('team_claim', 'adjacent', 'partial'))).toBe(0.126);
    expect(roundReported(evidenceItemStrength('team_claim', 'direct', 'exact'))).toBe(0.35);
  });
});

describe('contradiction factor', () => {
  it('is 1, 0.7, 0.49, 0.343 and stays at the cap', () => {
    expect(CONTRADICTION_CAP).toBe(3);
    expect([0, 1, 2, 3, 4, 9, 1000].map(contradictionFactor)).toEqual([
      1, 0.7, 0.49, 0.343, 0.343, 0.343, 0.343,
    ]);
  });

  it('reproduces the E2 confidences', () => {
    const base = 0.6;
    expect([0, 1, 2, 3, 4].map((k) => roundReported(base * contradictionFactor(k)))).toEqual([
      0.6, 0.42, 0.294, 0.2058, 0.2058,
    ]);
  });
});

describe('parameters', () => {
  it('are the approved V1 heuristics, frozen, and carry no privileged-level weight', () => {
    expect(SCORING_PARAMETERS.levelFactor).toEqual(V);
    expect(Object.keys(SCORING_PARAMETERS.levelFactor)).toEqual([
      'unverified',
      'team_claim',
      'repo_corroborated',
    ]);
    expect(SCORING_PARAMETERS.directnessFactor).toEqual(DIRECTNESS);
    expect(SCORING_PARAMETERS.specificityFactor).toEqual(SPECIFICITY);
    expect(SCORING_PARAMETERS.minAssessedShare).toEqual({ criterion: 0.5, overall: 0.6 });
    expect(SCORING_PARAMETERS.roundingDecimals).toBe(4);
    expect(SCORING_PARAMETERS.status).toBe('heuristic_not_calibrated');
    const text = canonicalJson(SCORING_PARAMETERS);
    for (const privileged of ['machine_verified', 'judge_verified', 'live_verified']) {
      expect(text).not.toContain(privileged);
    }
    expect(Object.isFrozen(SCORING_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(SCORING_PARAMETERS.levelFactor)).toBe(true);
    expect(Object.isFrozen(SCORING_PARAMETERS.contradictionFactors)).toBe(true);
    expect(() => {
      (SCORING_PARAMETERS.levelFactor as Record<string, number>)['unverified'] = 1;
    }).toThrow();
    expect(() => {
      (SCORING_PARAMETERS.levelFactor as Record<string, number>)['machine_verified'] = 1;
    }).toThrow();
  });

  it('hash every parameter AND the fallback rubric definition (weights and evidence needs)', () => {
    expect(parametersHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parametersHash).toBe(
      hashOf({ parameters: SCORING_PARAMETERS, fallbackRubric: FALLBACK_RUBRIC_DEFINITION }),
    );
    const changedParameter = { ...SCORING_PARAMETERS, contradictionFactors: [1, 0.8, 0.49, 0.343] };
    expect(
      hashOf({ parameters: changedParameter, fallbackRubric: FALLBACK_RUBRIC_DEFINITION }),
    ).not.toBe(parametersHash);
    const changedNeeds = FALLBACK_RUBRIC_DEFINITION.map((criterion, index) =>
      index === 0
        ? {
            ...criterion,
            dimensions: criterion.dimensions.map((dimension, i) =>
              i === 0 ? { ...dimension, needGroups: [['video' as const]] } : dimension,
            ),
          }
        : criterion,
    );
    expect(hashOf({ parameters: SCORING_PARAMETERS, fallbackRubric: changedNeeds })).not.toBe(
      parametersHash,
    );
    const changedWeight = FALLBACK_RUBRIC_DEFINITION.map((criterion, index) =>
      index === 1 ? { ...criterion, weightPercent: criterion.weightPercent + 1 } : criterion,
    );
    expect(hashOf({ parameters: SCORING_PARAMETERS, fallbackRubric: changedWeight })).not.toBe(
      parametersHash,
    );
  });
});

describe('rounding', () => {
  it('rounds once, half-up, to four decimals', () => {
    expect(roundReported(6.90625)).toBe(6.9063);
    expect(roundReported(0.00005)).toBe(0.0001);
    expect(roundReported(0.00004)).toBe(0);
    expect(roundReported(7)).toBe(7);
    expect(roundReported(0.7028000000000001)).toBe(0.7028);
    expect(roundReported(1.0000000000000002)).toBe(1);
  });

  it('never returns negative zero and is idempotent', () => {
    expect(Object.is(roundReported(-0), 0)).toBe(true);
    expect(Object.is(roundReported(-0.00001), 0)).toBe(true);
    for (const value of [0.1, 0.12345, 3.14159265, 9.99995, 0.30000000000000004]) {
      expect(roundReported(roundReported(value))).toBe(roundReported(value));
    }
  });
});
