import { describe, expect, it } from 'vitest';
import { InMemoryRunBudget, type ReserveRequest } from './budget.js';
import { ManualClock } from './clock.js';
import { PRICES_V1 } from './prices-v1.js';
import { budgetFor, limits, usage } from './testing/builders.js';

const bounds = (inputTokens: number, outputTokens: number, price = [100, 500] as const) => ({
  inputTokens,
  outputTokens,
  costNanoUsd: inputTokens * price[0] + outputTokens * price[1],
});
const ask = (b = bounds(1_000, 100), digest = 'd1'): ReserveRequest => ({
  stage: 'claim_extraction',
  model: 'claude-haiku-5-5',
  requestDigest: digest,
  bounds: b,
});

describe('reserve → settle accounting', () => {
  it('holds the worst case while in flight and replaces it with MEASURED usage on settle', async () => {
    const { budget } = budgetFor();
    const r = await budget.reserve(ask());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let snap = await budget.snapshot();
    expect(snap.reserved).toEqual({
      calls: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      costNanoUsd: 150_000,
    });
    await budget.settle(r.callId, {
      kind: 'measured',
      usage: usage(400, 50),
      outcomeCode: 'ok',
      responseHash: 'h',
    });
    snap = await budget.snapshot();
    expect(snap.reserved).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0 });
    expect(snap.settled).toEqual({
      calls: 1,
      inputTokens: 400,
      outputTokens: 50,
      costNanoUsd: 400 * 100 + 50 * 500,
    });
    const [entry] = await budget.entries();
    expect(entry).toMatchObject({
      state: 'settled',
      usageBasis: 'measured',
      boundViolation: false,
      attempt: 1,
    });
  });

  it('keeps an UNKNOWN attempt counted at its FULL reservation', async () => {
    const { budget } = budgetFor();
    const r = await budget.reserve(ask());
    if (!r.ok) throw new Error('denied');
    await budget.settle(r.callId, { kind: 'unknown', outcomeCode: 'timeout' });
    const snap = await budget.snapshot();
    expect(snap.unknown).toEqual({
      calls: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      costNanoUsd: 150_000,
    });
    expect(snap.settled.calls).toBe(0);
    const [entry] = await budget.entries();
    expect(entry).toMatchObject({
      state: 'unknown',
      usageBasis: 'unknown_reserved',
      costNanoUsd: 150_000,
    });
  });

  it('releases an attempt that never reached the provider: it frees tokens and cost but NOT the attempt slot', async () => {
    const cost = bounds(1_000, 100).costNanoUsd;
    const { budget } = budgetFor({ maxCalls: 2, maxCostNanoUsd: cost });
    const first = await budget.reserve(ask());
    if (!first.ok) throw new Error('denied');
    await budget.settle(first.callId, { kind: 'released', outcomeCode: 'rate_limited' });
    const snap = await budget.snapshot();
    expect(snap.releasedCalls).toBe(1);
    expect(snap.attemptsStarted).toBe(1);
    expect(snap.reserved).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0 });
    expect(snap.settled.calls + snap.unknown.calls + snap.reserved.calls).toBe(0);
    // The cost cap is exactly one reservation wide: it is free again, so a second attempt can start...
    const second = await budget.reserve(ask(bounds(1_000, 100), 'b'));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('denied');
    await budget.settle(second.callId, { kind: 'released', outcomeCode: 'rate_limited' });
    // ...but both attempt slots are spent, whatever the freed token and cost headroom says.
    expect(await budget.reserve(ask(bounds(1, 1), 'c'))).toEqual({ ok: false, denial: 'calls' });
    expect((await budget.snapshot()).attemptsStarted).toBe(2);
  });

  it('flags measured usage above the reservation (the byte bound was wrong) and counts the measured figure', async () => {
    const { budget } = budgetFor();
    const r = await budget.reserve(ask(bounds(100, 10)));
    if (!r.ok) throw new Error('denied');
    await budget.settle(r.callId, {
      kind: 'measured',
      usage: usage(500, 10),
      outcomeCode: 'ok',
      responseHash: null,
    });
    const snap = await budget.snapshot();
    expect(snap.boundViolations).toBe(1);
    expect(snap.settled.inputTokens).toBe(500);
  });

  it('refuses a double settlement and settling an unknown call id', async () => {
    const { budget } = budgetFor();
    const r = await budget.reserve(ask());
    if (!r.ok) throw new Error('denied');
    await budget.settle(r.callId, { kind: 'released', outcomeCode: 'x' });
    await expect(budget.settle(r.callId, { kind: 'released', outcomeCode: 'x' })).rejects.toThrow();
    await expect(budget.settle(99, { kind: 'released', outcomeCode: 'x' })).rejects.toThrow();
  });

  it('counts an unpriced model at its reservation instead of guessing zero', async () => {
    const { budget } = budgetFor();
    const r = await budget.reserve({ ...ask(), model: 'unlisted' });
    if (!r.ok) throw new Error('denied');
    await budget.settle(r.callId, {
      kind: 'measured',
      usage: usage(1, 1),
      outcomeCode: 'ok',
      responseHash: null,
    });
    const snap = await budget.snapshot();
    expect(snap.unknown.calls).toBe(1);
    expect(snap.settled.calls).toBe(0);
  });

  it('numbers attempts by request digest', async () => {
    const { budget } = budgetFor();
    for (const digest of ['a', 'a', 'b', 'a']) {
      const r = await budget.reserve(ask(bounds(10, 10), digest));
      if (!r.ok) throw new Error('denied');
      await budget.settle(r.callId, { kind: 'released', outcomeCode: 'x' });
    }
    expect((await budget.entries()).map((e) => e.attempt)).toEqual([1, 2, 1, 3]);
  });

  it('reaps in-flight attempts of a dead worker as unknown at their worst case', async () => {
    const { budget } = budgetFor();
    await budget.reserve(ask());
    await budget.reserve(ask(bounds(10, 10), 'd2'));
    expect(await budget.reapInFlight()).toBe(2);
    const snap = await budget.snapshot();
    expect(snap.reserved.calls).toBe(0);
    expect(snap.unknown.calls).toBe(2);
    expect((await budget.entries()).every((e) => e.outcomeCode === 'lease_expired')).toBe(true);
    expect(await budget.reapInFlight()).toBe(0);
  });
});

describe('every limit is enforced before the attempt starts', () => {
  it('denies on the call count, counting settled, unknown and in-flight attempts', async () => {
    const { budget } = budgetFor({ maxCalls: 3 });
    const a = await budget.reserve(ask(bounds(1, 1), 'a'));
    const b = await budget.reserve(ask(bounds(1, 1), 'b'));
    if (!a.ok || !b.ok) throw new Error('denied');
    await budget.settle(a.callId, {
      kind: 'measured',
      usage: usage(1, 1),
      outcomeCode: 'ok',
      responseHash: null,
    });
    await budget.settle(b.callId, { kind: 'unknown', outcomeCode: 'timeout' });
    expect((await budget.reserve(ask(bounds(1, 1), 'c'))).ok).toBe(true); // in flight
    expect(await budget.reserve(ask(bounds(1, 1), 'd'))).toEqual({ ok: false, denial: 'calls' });
  });

  it('does not refund a released attempt: maxCalls=1 and one rate_limited/not_sent attempt leaves no slot', async () => {
    const { budget } = budgetFor({ maxCalls: 1 });
    const only = await budget.reserve(ask());
    if (!only.ok) throw new Error('denied');
    await budget.settle(only.callId, { kind: 'released', outcomeCode: 'rate_limited' });
    expect(await budget.reserve(ask(bounds(1, 1), 'next'))).toEqual({ ok: false, denial: 'calls' });
  });

  it('counts settled, unknown, released and in-flight attempts together against maxCalls', async () => {
    const { budget } = budgetFor({ maxCalls: 4 });
    const kinds = ['measured', 'unknown', 'released'] as const;
    for (const [index, kind] of kinds.entries()) {
      const r = await budget.reserve(ask(bounds(1, 1), `k${String(index)}`));
      if (!r.ok) throw new Error('denied');
      await budget.settle(
        r.callId,
        kind === 'measured'
          ? { kind, usage: usage(1, 1), outcomeCode: 'ok', responseHash: null }
          : { kind, outcomeCode: 'x' },
      );
    }
    expect((await budget.reserve(ask(bounds(1, 1), 'inflight'))).ok).toBe(true); // the fourth attempt
    expect(await budget.reserve(ask(bounds(1, 1), 'fifth'))).toEqual({
      ok: false,
      denial: 'calls',
    });
    expect((await budget.snapshot()).attemptsStarted).toBe(4);
  });

  it('denies on input tokens, output tokens and cost with the right reason', async () => {
    expect(await budgetFor({ maxInputTokens: 999 }).budget.reserve(ask(bounds(1_000, 1)))).toEqual({
      ok: false,
      denial: 'input_tokens',
    });
    expect(await budgetFor({ maxOutputTokens: 99 }).budget.reserve(ask(bounds(1, 100)))).toEqual({
      ok: false,
      denial: 'output_tokens',
    });
    const exactCost = bounds(1_000, 100).costNanoUsd;
    expect((await budgetFor({ maxCostNanoUsd: exactCost }).budget.reserve(ask())).ok).toBe(true); // at the limit passes
    expect(await budgetFor({ maxCostNanoUsd: exactCost - 1 }).budget.reserve(ask())).toEqual({
      ok: false,
      denial: 'cost',
    });
  });

  it('denies one oversized attempt on the per-call input bound', async () => {
    const { budget } = budgetFor({ maxReservedInputTokensPerCall: 5_000 });
    expect(await budget.reserve(ask(bounds(5_001, 1)))).toEqual({
      ok: false,
      denial: 'per_call_input',
    });
    expect((await budget.reserve(ask(bounds(5_000, 1)))).ok).toBe(true);
  });

  it('denies once the wall-clock limit has passed, whatever the other counters say', async () => {
    const clock = new ManualClock(1_000);
    const budget = new InMemoryRunBudget({
      limits: limits({ runWallClockMs: 60_000 }),
      prices: PRICES_V1,
      clock,
    });
    expect((await budget.reserve(ask())).ok).toBe(true);
    await clock.advance(59_999);
    expect((await budget.reserve(ask())).ok).toBe(true);
    await clock.advance(1);
    expect(await budget.reserve(ask())).toEqual({ ok: false, denial: 'wall_clock' });
  });

  it('counts unknown spend against the cap (an ambiguous call is never assumed free)', async () => {
    const one = bounds(1_000, 100).costNanoUsd;
    const { budget } = budgetFor({ maxCostNanoUsd: one * 2 });
    const a = await budget.reserve(ask());
    if (!a.ok) throw new Error('denied');
    await budget.settle(a.callId, { kind: 'unknown', outcomeCode: 'timeout' });
    const b = await budget.reserve(ask(bounds(1_000, 100), 'b'));
    if (!b.ok) throw new Error('denied');
    await budget.settle(b.callId, { kind: 'unknown', outcomeCode: 'timeout' });
    expect(await budget.reserve(ask(bounds(1, 1), 'c'))).toEqual({ ok: false, denial: 'cost' });
  });
});

describe('concurrency: racing reservations cannot both pass the same remaining budget', () => {
  it('admits exactly the number of attempts the call limit allows under 25 simultaneous reservations', async () => {
    const { budget } = budgetFor({ maxCalls: 7 });
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        budget.reserve(ask(bounds(10, 10), `d${String(index)}`)),
      ),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(7);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(18);
    const snap = await budget.snapshot();
    expect(snap.reserved.calls).toBe(7);
  });

  it('holds even when every reservation is forced to yield between the check and the hold', async () => {
    const yielding = async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };
    const cost = bounds(1_000, 100).costNanoUsd;
    const { budget } = budgetFor({ maxCostNanoUsd: cost * 3 }, { betweenCheckAndHold: yielding });
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        budget.reserve(ask(bounds(1_000, 100), `d${String(index)}`)),
      ),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
    const snap = await budget.snapshot();
    expect(snap.reserved.costNanoUsd).toBeLessThanOrEqual(cost * 3);
  });

  it('cannot exceed maxCalls under concurrency even when other attempts settle as released', async () => {
    const { budget } = budgetFor({ maxCalls: 3 });
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const r = await budget.reserve(ask(bounds(10, 10), `c${String(index)}`));
        if (r.ok) await budget.settle(r.callId, { kind: 'released', outcomeCode: 'rate_limited' });
        return r.ok;
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    const snap = await budget.snapshot();
    expect(snap.attemptsStarted).toBe(3);
    expect(snap.releasedCalls).toBe(3);
    expect(snap.reserved.calls).toBe(0);
  });

  it('serializes settle against reserve: a settlement racing a reservation cannot double-spend the freed budget', async () => {
    const cost = bounds(1_000, 100).costNanoUsd;
    const measured = 10 * 100 + 1 * 500; // the settled cost of the first attempt
    const { budget } = budgetFor({ maxCostNanoUsd: cost + measured });
    const first = await budget.reserve(ask());
    if (!first.ok) throw new Error('denied');
    const [settled, second, third] = await Promise.all([
      budget.settle(first.callId, {
        kind: 'measured',
        usage: usage(10, 1),
        outcomeCode: 'ok',
        responseHash: null,
      }),
      budget.reserve(ask(bounds(1_000, 100), 'b')),
      budget.reserve(ask(bounds(1_000, 100), 'c')),
    ]);
    expect(settled).toBeUndefined();
    expect([second.ok, third.ok].filter(Boolean)).toHaveLength(1);
  });
});
