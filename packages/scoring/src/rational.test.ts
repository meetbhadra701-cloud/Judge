import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { roundReported } from './canonical.js';
import { scoreProject } from './engine.js';
import { add, cmp, div, fromNumber, gte, mul, rat, roundHalfUp, sub, sum } from './rational.js';
import {
  baseWorld,
  cite,
  devpostEvidence,
  lockedSnapshot,
  makeContext,
  payload,
  rubricDefinition,
  scored,
  seeded,
  uid,
} from './testing/builders.js';

/*
 * Exact arithmetic and exact half-up rounding (review finding F2). Every expectation here is derived
 * independently with BigInt integers in this file, never from the implementation under test and never
 * from floating-point arithmetic.
 */

/** Reference: round a non-negative fraction num/den half-up to an integer, using integers only. */
const roundDiv = (num: bigint, den: bigint): bigint => (2n * num + den) / (2n * den);

describe('fromNumber reads the shortest decimal of a double, exactly', () => {
  it.each([
    [0.1, 1n, 10n],
    [0.5, 1n, 2n],
    [7.0001, 70001n, 10000n],
    [0.30000000000000004, 30000000000000004n, 100000000000000000n],
    [1e-7, 1n, 10000000n],
    [1e21, 10n ** 21n, 1n],
    [-2.5, -5n, 2n],
    [0, 0n, 1n],
    [-0, 0n, 1n],
  ])('%s', (value, n, d) => {
    expect(fromNumber(value)).toEqual(rat(n, d));
  });

  it('refuses non-finite input', () => {
    expect(() => fromNumber(Number.NaN)).toThrow();
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('exact rational operations', () => {
  it('has no 0.1 + 0.2 problem and no associativity drift', () => {
    expect(cmp(add(fromNumber(0.1), fromNumber(0.2)), fromNumber(0.3))).toBe(0);
    const tenths = Array.from({ length: 10 }, () => fromNumber(0.1));
    expect(cmp(sum(tenths), fromNumber(1))).toBe(0);
    expect(cmp(mul(fromNumber(0.7), fromNumber(0.7)), fromNumber(0.49))).toBe(0);
    expect(
      cmp(sub(fromNumber(1), div(fromNumber(1), fromNumber(3))), div(fromNumber(2), fromNumber(3))),
    ).toBe(0);
  });

  it('compares exactly at the 0.6 threshold where IEEE 0.1 * 6 style sums drift', () => {
    const parts = [0.2, 0.15, 0.15, 0.1].map(fromNumber);
    expect(gte(sum(parts), fromNumber(0.6))).toBe(true);
    expect(gte(sum([0.2, 0.15, 0.15, 0.0999999].map(fromNumber)), fromNumber(0.6))).toBe(false);
  });
});

describe('roundHalfUp against an independent BigInt reference', () => {
  it('rounds EVERY exact decimal tie m + 0.5 (at four decimals) up, for 20,000 consecutive values', () => {
    for (let m = 0; m < 20000; m += 1) {
      const tie = Number(`${String(m)}.5e-4`); // exactly m.5 ten-thousandths as a decimal
      expect(roundReported(tie), `${String(m)}.5e-4`).toBe(Number(`${String(m + 1)}e-4`));
    }
  });

  it('keeps values just BELOW a tie below it, and just above it above (no epsilon pushing them over)', () => {
    for (let m = 0; m < 20000; m += 1) {
      const below = Number(`${String(m)}.4999999999e-4`);
      const above = Number(`${String(m)}.5000000001e-4`);
      expect(roundReported(below), `${String(m)}.4999999999e-4`).toBe(Number(`${String(m)}e-4`));
      expect(roundReported(above), `${String(m)}.5000000001e-4`).toBe(
        Number(`${String(m + 1)}e-4`),
      );
    }
    // The shape the review was worried about: a value one part in 10^13 under a tie.
    expect(roundReported(0.00004999999999999)).toBe(0);
    expect(roundReported(0.00005)).toBe(0.0001);
  });

  it('matches the BigInt reference on random rationals (denominators up to 10^6)', () => {
    const random = seeded(2024);
    for (let i = 0; i < 20000; i += 1) {
      const den = BigInt(1 + Math.floor(random() * 1_000_000));
      const num = BigInt(Math.floor(random() * 4_000_000_000));
      const expected = Number(roundDiv(num * 10_000n, den)) / 10_000;
      expect(roundHalfUp(rat(num, den), 4), `${String(num)}/${String(den)}`).toBe(expected);
    }
  });

  it('rounds exact binary-fraction ties (k/32, k/64, k/160, k/800) up as well', () => {
    for (const den of [32n, 64n, 160n, 800n]) {
      for (let k = 0n; k < 5000n; k += 1n) {
        const expected = Number(roundDiv(k * 10_000n, den)) / 10_000;
        expect(roundHalfUp(rat(k, den), 4), `${String(k)}/${String(den)}`).toBe(expected);
      }
    }
    expect(roundHalfUp(rat(221n, 32n), 4)).toBe(6.9063); // 6.90625, a golden tie
    expect(roundHalfUp(rat(373n, 800n), 4)).toBe(0.4663); // 0.46625: IEEE arithmetic gave 0.4662
    expect(roundHalfUp(rat(7n, 800n), 4)).toBe(0.0088); // 0.00875: IEEE arithmetic gave 0.0087
  });

  it('does not produce negative zero and is symmetric for negatives', () => {
    expect(Object.is(roundHalfUp(rat(-1n, 1_000_000n), 4), 0)).toBe(true);
    expect(roundHalfUp(rat(-5n, 100_000n), 4)).toBe(-0.0001);
  });
});

// -- Engine level: the weighted mean ------------------------------------------------------------

const REVIEW_SCALE = { min: 0, max: 10 };

function overallFor(
  weights: number[],
  values: number[],
  scale: { min: number; max: number },
): ScoreReport['overall'] {
  const g = baseWorld();
  const dev = devpostEvidence(g, uid(1, 'e8000001'));
  const keys = weights.map((_, index) => `c${String(index)}`);
  const rubric = rubricDefinition({
    scaleMin: scale.min,
    scaleMax: scale.max,
    criteria: keys.map((key, index) => ({ key, weight: weights[index] ?? null })),
  });
  const context = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
  const result = scoreProject(
    context,
    payload(...keys.map((key, index) => scored(`official.${key}`, values[index] ?? 0, cite(dev)))),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report.overall;
}

describe('the reviewer case: weights 0.5 / 0.5 with scores 7.0001 and 7.0036', () => {
  it('reports 7.0019 (exact mean 7.00185, half-up), not 7.0018', () => {
    const overall = overallFor([0.5, 0.5], [7.0001, 7.0036], REVIEW_SCALE);
    expect(overall).toMatchObject({ state: 'scored', score10: 7.0019, scoreOnScale: 7.0019 });
    // The old floating-point mean of the two products is not the decimal 7.00185:
    expect(0.5 * 7.0001 + 0.5 * 7.0036).not.toBe(7.00185);
  });

  it('is order independent', () => {
    expect(overallFor([0.5, 0.5], [7.0036, 7.0001], REVIEW_SCALE)).toMatchObject({
      score10: 7.0019,
    });
  });

  it('one hundredth of a step below the tie stays below it', () => {
    expect(overallFor([0.5, 0.5], [7.0001, 7.0035], REVIEW_SCALE)).toMatchObject({
      score10: 7.0018,
    });
  });
});

describe('published-weight means equal the BigInt reference (including normalization on a 1-5 scale)', () => {
  const random = seeded(8675309);

  function weightsOf(count: number, coarse: boolean): number[] {
    // Integers (percent) summing to 100.
    const parts: number[] = [];
    let left = 100;
    for (let i = 0; i < count - 1; i += 1) {
      const step = coarse ? 25 : 1;
      const max = Math.floor((left - (count - 1 - i) * step) / step);
      const value = (1 + Math.floor(random() * max)) * step;
      parts.push(value);
      left -= value;
    }
    parts.push(left);
    return parts;
  }

  it('on a 0-10 scale: 400 random rubrics, many of them exact ties', () => {
    let ties = 0;
    for (let round = 0; round < 400; round += 1) {
      const count = 2 + Math.floor(random() * 3);
      const percent = weightsOf(count, round % 2 === 0);
      // Scores in ten-thousandths.
      const scores = percent.map(() => BigInt(Math.floor(random() * 100_001)));
      const numerator = percent.reduce((acc, w, i) => acc + BigInt(w) * (scores[i] ?? 0n), 0n); // over 100
      if ((2n * numerator) % 100n === 99n || numerator % 100n === 50n) ties += 1;
      const expected = Number(roundDiv(numerator, 100n)) / 10_000;
      const overall = overallFor(
        percent.map((w) => w / 100),
        scores.map((s) => Number(s) / 10_000),
        REVIEW_SCALE,
      );
      expect(overall, `${percent.join('/')} ${scores.join('/')}`).toMatchObject({
        state: 'scored',
        score10: expected,
        scoreOnScale: expected,
      });
    }
    expect(ties).toBeGreaterThan(20); // the property really exercised exact ties
  });

  it('on a 1-5 scale: normalization and denormalization are exact', () => {
    let ties = 0;
    for (let round = 0; round < 300; round += 1) {
      const count = 2 + Math.floor(random() * 3);
      const percent = weightsOf(count, round % 2 === 0);
      // x = 1 + s/10^4 with s in 0..40000.
      const s = percent.map(() => BigInt(Math.floor(random() * 40_001)));
      const numerator = percent.reduce((acc, w, i) => acc + BigInt(w) * (s[i] ?? 0n), 0n);
      // score10 = (mean - 1) * 10 / 4 = numerator / (100 * 10^4) * 2.5 = numerator / 4e5
      if ((numerator * 10_000n) % 400_000n === 200_000n) ties += 1;
      const expected10 = Number(roundDiv(numerator * 10_000n, 400_000n)) / 10_000;
      // on-scale = 1 + numerator / 10^6
      const expectedScale = (10_000n + roundDiv(numerator, 100n)) / 1n;
      const overall = overallFor(
        percent.map((w) => w / 100),
        s.map((v) => Number(`${String(10_000n + v)}e-4`)),
        { min: 1, max: 5 },
      );
      expect(overall, `${percent.join('/')} ${s.join('/')}`).toMatchObject({
        state: 'scored',
        score10: expected10,
        scoreOnScale: Number(expectedScale) / 10_000,
      });
    }
    expect(ties).toBeGreaterThan(5);
  });
});
