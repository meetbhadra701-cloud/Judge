import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { backoffDelayMs, DEFAULT_RETRY_POLICY, MAX_RETRIES_CEILING, withRetry } from './retry.js';
import { ScriptedProvider } from './scripted.js';
import { fail, ok, request, seededRandom, signal } from './testing/builders.js';

const deps = (clock = new ManualClock(), value = 0.5) => ({ clock, random: () => value });

describe('backoff', () => {
  it('doubles from 2 s, caps at 30 s, and jitters within [50%, 100%) of the capped value', () => {
    const noJitterLow = () => 0; // 50%
    const noJitterHigh = () => 0.999999; // ~100%
    const low = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(DEFAULT_RETRY_POLICY, n, noJitterLow));
    expect(low).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    const high = [1, 2, 3, 4, 5, 6].map((n) =>
      backoffDelayMs(DEFAULT_RETRY_POLICY, n, noJitterHigh),
    );
    expect(high).toEqual([1_999, 3_999, 7_999, 15_999, 29_999, 29_999]);
  });

  it('never leaves its bounds under 2,000 seeded draws', () => {
    const random = seededRandom(42);
    for (let index = 0; index < 2_000; index += 1) {
      const n = 1 + (index % 8);
      const delay = backoffDelayMs(DEFAULT_RETRY_POLICY, n, random);
      const cap = Math.min(30_000, 2_000 * 2 ** (n - 1));
      expect(delay).toBeGreaterThanOrEqual(cap / 2);
      expect(delay).toBeLessThan(cap);
    }
  });
});

describe('withRetry', () => {
  it('returns success immediately without sleeping', async () => {
    const provider = new ScriptedProvider([ok()]);
    const clock = new ManualClock();
    const result = await withRetry(provider, DEFAULT_RETRY_POLICY, deps(clock)).generate(
      request(),
      signal(),
    );
    expect(result.ok).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('retries a transient failure up to 2 times (3 attempts) and then returns the last failure', async () => {
    const provider = new ScriptedProvider([
      fail('rate_limited', 'not_sent'),
      fail('timeout'),
      fail('provider_unavailable'),
    ]);
    const clock = new ManualClock();
    const pending = withRetry(provider, DEFAULT_RETRY_POLICY, deps(clock)).generate(
      request(),
      signal(),
    );
    await clock.advance(60_000);
    const result = await pending;
    expect(provider.requests).toHaveLength(3);
    expect(result).toMatchObject({ ok: false, category: 'provider_unavailable' });
    expect(clock.sleeps).toHaveLength(2); // backoff happens between attempts only
  });

  it('recovers when a later attempt succeeds', async () => {
    const provider = new ScriptedProvider([fail('provider_unavailable'), ok({ done: true })]);
    const clock = new ManualClock();
    const pending = withRetry(provider, DEFAULT_RETRY_POLICY, deps(clock)).generate(
      request(),
      signal(),
    );
    await clock.advance(10_000);
    expect(await pending).toMatchObject({ ok: true, json: { done: true } });
    expect(provider.requests).toHaveLength(2);
  });

  it.each([
    'refused',
    'truncated',
    'auth',
    'bad_request',
    'cancelled',
    'budget_exceeded',
    'replay_miss',
  ] as const)('never retries %s', async (category) => {
    const provider = new ScriptedProvider([fail(category), ok()]);
    const result = await withRetry(provider, DEFAULT_RETRY_POLICY, deps()).generate(
      request(),
      signal(),
    );
    expect(result).toMatchObject({ ok: false, category });
    expect(provider.requests).toHaveLength(1);
  });

  it('honors Retry-After when it is longer than the backoff, and gives up when it exceeds the cap', async () => {
    const provider = new ScriptedProvider([
      fail('rate_limited', 'not_sent', { retryAfterMs: 20_000 }),
      ok(),
    ]);
    const clock = new ManualClock();
    const pending = withRetry(provider, DEFAULT_RETRY_POLICY, deps(clock, 0)).generate(
      request(),
      signal(),
    );
    await clock.advance(20_000);
    expect((await pending).ok).toBe(true);
    expect(clock.sleeps).toEqual([20_000]);

    const tooLong = new ScriptedProvider([
      fail('rate_limited', 'not_sent', { retryAfterMs: 61_000 }),
      ok(),
    ]);
    const result = await withRetry(tooLong, DEFAULT_RETRY_POLICY, deps()).generate(
      request(),
      signal(),
    );
    expect(result).toMatchObject({ ok: false, category: 'rate_limited' });
    expect(tooLong.requests).toHaveLength(1);
  });

  it('is capped at 3 retries even if configured higher', async () => {
    expect(MAX_RETRIES_CEILING).toBe(3);
    const provider = new ScriptedProvider([fail('timeout')], { repeatLast: true });
    const clock = new ManualClock();
    const pending = withRetry(
      provider,
      { ...DEFAULT_RETRY_POLICY, maxRetries: 50 },
      deps(clock),
    ).generate(request(), signal());
    await clock.advance(500_000);
    await pending;
    expect(provider.requests).toHaveLength(4);
  });

  it('stops without another attempt when the caller aborts during backoff', async () => {
    const provider = new ScriptedProvider([fail('provider_unavailable'), ok()]);
    const clock = new ManualClock();
    const controller = new AbortController();
    const pending = withRetry(provider, DEFAULT_RETRY_POLICY, deps(clock)).generate(
      request(),
      controller.signal,
    );
    await clock.advance(0);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, category: 'cancelled' });
    expect(provider.requests).toHaveLength(1);
  });

  it('does not start an attempt when already aborted', async () => {
    const provider = new ScriptedProvider([ok()]);
    const controller = new AbortController();
    controller.abort();
    const result = await withRetry(provider, DEFAULT_RETRY_POLICY, deps()).generate(
      request(),
      controller.signal,
    );
    expect(result).toMatchObject({ ok: false, category: 'cancelled', sendState: 'not_sent' });
    expect(provider.requests).toHaveLength(0);
  });
});
