/*
 * Exact rational arithmetic over BigInt, used for every quantity the engine rounds.
 *
 * Why. Binary floating point cannot represent most decimals, so a value that is mathematically a
 * tie at the reported precision is usually a hair above or below it: 0.5 × 7.0001 + 0.5 × 7.0036
 * is exactly 7.00185 (a half-up tie, so 7.0019 at four decimals) but evaluates to
 * 7.001849999999999 in IEEE doubles, which rounds to 7.0018. Detecting ties in the RESULT of a
 * float computation cannot fix that (the result is not the tie), and adding a tolerance would turn
 * values that are genuinely just below a tie into ties. The principled fix is to compute exactly.
 *
 * How. Every input number (a judged score, a published weight, a scale endpoint, a heuristic
 * constant) is interpreted as the DECIMAL it prints as (`String(x)`, the shortest decimal that
 * round-trips), converted to an exact fraction, and combined with exact + − × ÷. The only rounding
 * is the final half-up rounding of the reported value, done on the exact fraction. No float result
 * is ever fed back, so there is no drift, and comparisons against thresholds are exact.
 *
 * Determinism. BigInt arithmetic is exact and platform independent. Fractions are kept in lowest
 * terms with a positive denominator, so equal values have identical representations.
 */

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
};

/** 10^k for a non-negative integer k, by exact repeated multiplication. */
export function pow10(k: number): bigint {
  if (!Number.isInteger(k) || k < 0) throw new RangeError('pow10 needs a non-negative integer');
  let result = 1n;
  for (let i = 0; i < k; i += 1) result *= 10n;
  return result;
}

export function rat(n: bigint, d: bigint = 1n): Rational {
  if (d === 0n) throw new RangeError('zero denominator');
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return g > 1n ? { n: (sign * n) / g, d: (sign * d) / g } : { n: sign * n, d: sign * d };
}

export const ZERO: Rational = { n: 0n, d: 1n };
export const ONE: Rational = { n: 1n, d: 1n };

export function fromInt(value: number): Rational {
  if (!Number.isSafeInteger(value)) throw new RangeError('not a safe integer');
  return rat(BigInt(value));
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;
/** Larger exponents cannot come from a finite double that passed the scale and score checks. */
const MAX_EXPONENT = 400;

/**
 * The exact value of the shortest decimal string a finite number prints as. `0.1` is exactly 1/10
 * (not the binary double nearest to it), `7.0001` is exactly 70001/10000.
 */
export function fromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new RangeError('not a finite number');
  const match = DECIMAL.exec(String(value));
  if (!match) throw new RangeError('unrecognized number format');
  const [, sign, whole = '0', fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText) - fraction.length;
  if (Math.abs(exponent) > MAX_EXPONENT) throw new RangeError('exponent out of range');
  const digits = BigInt(`${whole}${fraction}`);
  const signed = sign === '-' ? -digits : digits;
  return exponent >= 0 ? rat(signed * pow10(exponent)) : rat(signed, pow10(-exponent));
}

export const add = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational): Rational => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);
export const div = (a: Rational, b: Rational): Rational => {
  if (b.n === 0n) throw new RangeError('division by zero');
  return rat(a.n * b.d, a.d * b.n);
};

/** -1, 0 or 1. Denominators are positive, so cross-multiplication preserves order. */
export const cmp = (a: Rational, b: Rational): number => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
};
export const eq = (a: Rational, b: Rational): boolean => cmp(a, b) === 0;
export const lt = (a: Rational, b: Rational): boolean => cmp(a, b) < 0;
export const gte = (a: Rational, b: Rational): boolean => cmp(a, b) >= 0;
export const gt = (a: Rational, b: Rational): boolean => cmp(a, b) > 0;
export const min = (a: Rational, b: Rational): Rational => (cmp(a, b) <= 0 ? a : b);
export const max = (a: Rational, b: Rational): Rational => (cmp(a, b) >= 0 ? a : b);
export const isZero = (a: Rational): boolean => a.n === 0n;

export function sum(values: readonly Rational[]): Rational {
  let total = ZERO;
  for (const value of values) total = add(total, value);
  return total;
}

export const clamp = (value: Rational, low: Rational, high: Rational): Rational =>
  min(max(value, low), high);

/**
 * `value` rounded half away from zero (half-up for the non-negative values the engine reports) to
 * `decimals` places, EXACTLY: a value whose exact decimal expansion ends in a 5 at the next place
 * rounds up, and a value one part in 10^300 below it rounds down. Returns the nearest double of
 * the rounded decimal, and never negative zero.
 */
export function roundHalfUp(value: Rational, decimals: number): number {
  const scale = pow10(decimals);
  const negative = value.n < 0n;
  const magnitude = negative ? -value.n : value.n;
  const rounded = (2n * magnitude * scale + value.d) / (2n * value.d);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('rounded value out of range');
  const result = Number(rounded) / Number(scale);
  return negative && result !== 0 ? -result : result;
}
