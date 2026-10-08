import { RUBRIC_WEIGHT_SUM_TOLERANCE, rubricWeightSumIssues } from '@judge-copilot/context';
import { describe, expect, it } from 'vitest';
import { seeded, rubricDefinition } from '../testing/builders.js';
import { validatePublishedWeights } from './weights.js';

/*
 * The actual invariant (docs/SCORING.md §2.5), not "every weight change is invalid":
 *   - every weight is finite and in (0, 1];
 *   - all-or-none weighting;
 *   - |TOTAL - 1| <= 1e-6.
 * Compensating changes that keep the total at 1 are valid. Weights are validated, never repaired.
 */

const ok = (weights: (number | null)[]) => validatePublishedWeights(weights).ok;

describe('published weights', () => {
  it('has the same tolerance as Event Context locking', () => {
    expect(RUBRIC_WEIGHT_SUM_TOLERANCE).toBe(1e-6);
  });

  it('accepts all-unweighted and exact totals', () => {
    expect(validatePublishedWeights([null, null, null])).toEqual({ ok: true, weighted: false });
    expect(validatePublishedWeights([1])).toEqual({ ok: true, weighted: true });
    expect(validatePublishedWeights([0.5, 0.25, 0.25])).toEqual({ ok: true, weighted: true });
    expect(validatePublishedWeights([0.2, 0.2, 0.15, 0.15, 0.1, 0.1, 0.1]).ok).toBe(true);
  });

  it('accepts a total within the tolerance and rejects one beyond it', () => {
    expect(ok([0.5, 0.5 + 0.9e-6])).toBe(true);
    expect(ok([0.5, 0.5 - 0.9e-6])).toBe(true);
    expect(ok([0.5, 0.5 + 1.1e-6])).toBe(false);
    expect(ok([0.5, 0.5 - 1.1e-6])).toBe(false);
    expect(ok([0.3, 0.3, 0.3])).toBe(false);
    expect(ok([0.5, 0.6])).toBe(false);
  });

  it('accepts compensating changes: an individual change larger than 1e-6 is valid if the total still is 1', () => {
    expect(ok([0.2, 0.3, 0.5])).toBe(true);
    expect(ok([0.1, 0.4, 0.5])).toBe(true); // two weights each moved by 0.1
    expect(ok([0.3, 0.2, 0.5])).toBe(true);
    // ...while a single change that breaks the total is not.
    expect(ok([0.2, 0.3, 0.5 + 1e-3])).toBe(false);
  });

  it('is all-or-none', () => {
    expect(ok([0.5, null])).toBe(false);
    expect(ok([null, 0.5, 0.5])).toBe(false);
    expect(validatePublishedWeights([1, null])).toEqual({
      ok: false,
      messages: ['Either every criterion has a weight or none does'],
    });
  });

  it.each([
    ['zero', [0, 1]],
    ['negative', [-0.5, 1.5]],
    ['above one', [1.5, -0.5]],
    ['NaN', [Number.NaN, 0.5]],
    ['Infinity', [Number.POSITIVE_INFINITY, 0.5]],
    ['negative Infinity', [Number.NEGATIVE_INFINITY, 1]],
  ])('rejects a %s weight even when the total could be 1', (_name, weights) => {
    expect(ok(weights)).toBe(false);
  });

  it('retains the published values: validation returns no repaired weights', () => {
    const weights = [0.3333333, 0.3333333, 0.3333334];
    const before = [...weights];
    const result = validatePublishedWeights(weights);
    expect(result).toEqual({ ok: true, weighted: true });
    expect(weights).toEqual(before);
    expect(Object.keys(result)).toEqual(['ok', 'weighted']);
  });
});

describe('published weights, property tests (seeded)', () => {
  const random = seeded(20_310_412);
  const between = (min: number, max: number) => min + random() * (max - min);

  /** A random valid weight vector: positive, in range, total exactly 1 up to floating error. */
  function validWeights(): number[] {
    const count = 1 + Math.floor(random() * 8);
    const raw = Array.from({ length: count }, () => 0.05 + random());
    const total = raw.reduce((sum, value) => sum + value, 0);
    return raw.map((value) => value / total);
  }

  it('accepts 500 random valid vectors', () => {
    for (let i = 0; i < 500; i += 1) {
      const weights = validWeights();
      expect(Math.abs(weights.reduce((s, w) => s + w, 0) - 1)).toBeLessThanOrEqual(1e-9);
      expect(ok(weights), JSON.stringify(weights)).toBe(true);
    }
  });

  it('accepts 500 compensating perturbations (each > 1e-6) that keep the total at 1', () => {
    let exercised = 0;
    for (let i = 0; i < 500; i += 1) {
      const weights = validWeights();
      if (weights.length < 2) continue;
      const a = Math.floor(random() * weights.length);
      let b = Math.floor(random() * weights.length);
      if (b === a) b = (a + 1) % weights.length;
      const wa = weights[a] ?? 0;
      const wb = weights[b] ?? 0;
      const delta = between(1e-4, Math.min(wa, 1 - wb) * 0.9);
      if (!(wa - delta > 0 && wb + delta <= 1)) continue;
      weights[a] = wa - delta;
      weights[b] = wb + delta;
      exercised += 1;
      expect(delta).toBeGreaterThan(1e-6);
      expect(ok(weights), JSON.stringify(weights)).toBe(true);
    }
    expect(exercised).toBeGreaterThan(300);
  });

  it('rejects 500 single-weight changes that move the total by more than the tolerance', () => {
    for (let i = 0; i < 500; i += 1) {
      const weights = validWeights();
      const index = Math.floor(random() * weights.length);
      const sign = random() < 0.5 ? -1 : 1;
      const original = weights[index] ?? 0;
      const changed = original + sign * between(2e-6, 0.04);
      if (!(changed > 0 && changed <= 1)) continue;
      weights[index] = changed;
      expect(ok(weights), JSON.stringify(weights)).toBe(false);
    }
  });

  it('rejects 200 vectors with one out-of-range or non-finite weight', () => {
    const bad = [0, -0.1, 1.0000001, 2, Number.NaN, Number.POSITIVE_INFINITY];
    for (let i = 0; i < 200; i += 1) {
      const weights = validWeights();
      weights[Math.floor(random() * weights.length)] = bad[i % bad.length] ?? 0;
      expect(ok(weights)).toBe(false);
    }
  });

  it('rejects 200 partially weighted vectors', () => {
    for (let i = 0; i < 200; i += 1) {
      const weights: (number | null)[] = validWeights();
      if (weights.length < 2) continue;
      weights[Math.floor(random() * weights.length)] = null;
      expect(ok(weights)).toBe(false);
    }
  });

  it('agrees with the Event Context lock-time check on total and all-or-none for in-range weights', () => {
    for (let i = 0; i < 400; i += 1) {
      const count = 1 + Math.floor(random() * 6);
      let weights: (number | null)[] = Array.from({ length: count }, () => 0.01 + random() * 0.6);
      if (random() < 0.4) {
        const total = (weights as number[]).reduce((sum, value) => sum + value, 0);
        weights = (weights as number[]).map((value) => value / total);
        if (random() < 0.5) weights[0] = (weights[0] ?? 0) + between(-3e-6, 3e-6);
      }
      if (random() < 0.2) weights[Math.floor(random() * count)] = null;
      if (random() < 0.1) weights = weights.map(() => null);
      const inRange = weights.every((weight) => weight === null || (weight > 0 && weight <= 1));
      if (!inRange) continue;
      const definition = rubricDefinition({
        criteria: weights.map((weight, index) => ({ key: `c${String(index)}`, weight })),
      });
      expect(ok(weights), JSON.stringify(weights)).toBe(
        rubricWeightSumIssues(definition, 'r').length === 0,
      );
    }
  });
});
