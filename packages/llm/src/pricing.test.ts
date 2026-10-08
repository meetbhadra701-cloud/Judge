import { describe, expect, it } from 'vitest';
import {
  costNanoUsd,
  inputTokensOf,
  priceFor,
  RESERVATION_OVERHEAD_TOKENS,
  reservationBounds,
} from './pricing.js';
import { PRICES_V1 } from './prices-v1.js';
import { request } from './testing/builders.js';

describe('versioned prices', () => {
  it('is a dated, versioned table of integers', () => {
    expect(PRICES_V1.id).toBe('prices/v1');
    expect(PRICES_V1.effectiveDate).toBe('2026-10-06');
    expect(PRICES_V1.source).toMatch(/unverified/);
    for (const price of Object.values(PRICES_V1.models)) {
      expect(Number.isInteger(price.inputNanoUsdPerToken)).toBe(true);
      expect(Number.isInteger(price.outputNanoUsdPerToken)).toBe(true);
    }
  });

  it('computes exact costs: $0.10/MTok in, $0.50/MTok out is 100 / 500 nano-USD per token', () => {
    const haiku = priceFor(PRICES_V1, 'claude-haiku-5-5');
    expect(haiku).not.toBeNull();
    if (!haiku) return;
    // 1,000,000 input tokens at $0.10 = $0.10 = 100,000,000 nano-USD; 1,000,000 output at $0.50.
    expect(costNanoUsd(haiku, 1_000_000, 0)).toBe(100_000_000);
    expect(costNanoUsd(haiku, 0, 1_000_000)).toBe(500_000_000);
    const sonnet = priceFor(PRICES_V1, 'claude-sonnet-5-5');
    expect(sonnet && costNanoUsd(sonnet, 1_000_000, 1_000_000)).toBe(12_000_000_000);
  });

  it('knows nothing about unlisted models and ignores prototype names', () => {
    expect(priceFor(PRICES_V1, 'gpt-x')).toBeNull();
    expect(priceFor(PRICES_V1, 'constructor')).toBeNull();
    expect(priceFor(PRICES_V1, '__proto__')).toBeNull();
  });

  it('counts cache tokens as input (conservative)', () => {
    expect(
      inputTokensOf({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 7 }),
    ).toBe(22);
  });
});

describe('reservation bounds', () => {
  it('reserves bytes of everything sent plus overhead, and maxOutputTokens', () => {
    const r = request({ system: 'sys', user: ['héllo', '😀'], jsonSchema: { a: 1 } });
    const bounds = reservationBounds(r, PRICES_V1);
    // UTF-8 bytes: "sys"=3, "héllo"=6, "😀"=4, canonical schema {"a":1}=7
    expect(bounds?.inputTokens).toBe(3 + 6 + 4 + 7 + RESERVATION_OVERHEAD_TOKENS);
    expect(bounds?.outputTokens).toBe(1_000);
    expect(bounds?.costNanoUsd).toBe((bounds?.inputTokens ?? 0) * 100 + 1_000 * 500);
  });

  it('is an upper bound that grows with every added byte, and is null for unpriced models', () => {
    const small = reservationBounds(request(), PRICES_V1);
    const big = reservationBounds(request({ user: ['x'.repeat(10_000)] }), PRICES_V1);
    expect(big?.inputTokens ?? 0).toBeGreaterThan(small?.inputTokens ?? Number.POSITIVE_INFINITY);
    expect(reservationBounds(request({ model: 'unlisted-model' }), PRICES_V1)).toBeNull();
  });
});
