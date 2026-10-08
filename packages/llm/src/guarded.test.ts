import { describe, expect, it } from 'vitest';
import type { ManualClock } from './clock.js';
import { toRunFailure } from './failure.js';
import { createGuardedProvider, withBudget } from './guarded.js';
import { reservationBounds } from './pricing.js';
import { PRICES_V1 } from './prices-v1.js';
import { ScriptedProvider } from './scripted.js';
import { budgetFor, fail, ok, request, seededRandom, signal, usage } from './testing/builders.js';
import type { LlmResult } from './types.js';

function guarded(provider: ScriptedProvider, overrides: Record<string, number> = {}) {
  const { budget, clock } = budgetFor(overrides);
  const llm = createGuardedProvider({
    base: provider,
    budget,
    prices: PRICES_V1,
    clock,
    random: seededRandom(7),
  });
  return { llm, budget, clock };
}

/** Runs a logical call to completion while moving the manual clock past every backoff. */
async function run(
  llm: ReturnType<typeof guarded>['llm'],
  clock: ManualClock,
  req = request(),
): Promise<LlmResult> {
  const pending = llm.generate(req, signal());
  let result: LlmResult | undefined;
  void pending.then((value) => (result = value));
  for (let step = 0; step < 100 && result === undefined; step += 1) await clock.advance(5_000);
  return await pending;
}

describe('guarded provider: reserve → call → settle for every attempt', () => {
  it('settles a success with measured usage and a response hash', async () => {
    const provider = new ScriptedProvider([ok({ claims: [] }, usage(700, 80))]);
    const { llm, budget, clock } = guarded(provider);
    const result = await run(llm, clock);
    expect(result.ok).toBe(true);
    const [entry] = await budget.entries();
    expect(entry).toMatchObject({
      state: 'settled',
      usageBasis: 'measured',
      inputTokens: 700,
      outputTokens: 80,
      outcomeCode: 'ok',
    });
    expect(entry?.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await budget.snapshot()).reserved.calls).toBe(0);
  });

  it('releases a provably-unsent failure and keeps an ambiguous one counted at its worst case', async () => {
    const provider = new ScriptedProvider([
      fail('auth', 'not_sent'),
      fail('bad_request', 'not_sent'),
    ]);
    const { llm, budget, clock } = guarded(provider);
    await run(llm, clock);
    expect((await budget.entries())[0]).toMatchObject({ state: 'released', outcomeCode: 'auth' });

    const ambiguous = new ScriptedProvider([fail('refused', 'sent_unknown')]);
    const second = guarded(ambiguous);
    await run(second.llm, second.clock);
    expect((await second.budget.entries())[0]).toMatchObject({
      state: 'unknown',
      usageBasis: 'unknown_reserved',
    });
  });

  it('measures what the provider billed for a failed attempt (a truncated answer)', async () => {
    const provider = new ScriptedProvider([
      fail('truncated', 'sent_unknown', { usage: usage(900, 1_000) }),
    ]);
    const { llm, budget, clock } = guarded(provider);
    expect(await run(llm, clock)).toMatchObject({ ok: false, category: 'truncated' });
    expect((await budget.entries())[0]).toMatchObject({ state: 'settled', outputTokens: 1_000 });
  });

  it('counts a provider that throws as possible spend and never leaks the thrown message', async () => {
    const provider = new ScriptedProvider([
      { throws: Object.assign(new Error('key=CANARY-SECRET'), { code: 'EPIPE' }) },
    ]);
    const { llm, budget, clock } = guarded(provider, { maxCalls: 1 });
    const result = await run(llm, clock);
    // The first attempt threw (possible spend); the retry was refused by the guard (limit of 1).
    expect(result).toMatchObject({ ok: false, category: 'budget_exceeded', denial: 'calls' });
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify([result, await budget.entries(), await budget.snapshot()])).not.toContain(
      'SECRET',
    );
    expect((await budget.entries())[0]?.state).toBe('unknown');
  });

  it('refuses an unpriced model without calling the provider', async () => {
    const provider = new ScriptedProvider([ok()]);
    const { llm, clock } = guarded(provider);
    const result = await run(llm, clock, request({ model: 'unlisted-model' }));
    expect(result).toMatchObject({
      ok: false,
      category: 'budget_exceeded',
      denial: 'unpriced_model',
      sendState: 'not_sent',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('does not reserve anything for a call that is already cancelled', async () => {
    const provider = new ScriptedProvider([ok()]);
    const { budget, clock } = budgetFor();
    const llm = withBudget(provider, budget, PRICES_V1);
    const controller = new AbortController();
    controller.abort();
    expect(await llm.generate(request(), controller.signal)).toMatchObject({
      category: 'cancelled',
      sendState: 'not_sent',
    });
    expect(await budget.entries()).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  it('holds NO lock while the model is called: the ledger stays usable during an in-flight attempt', async () => {
    let release: (() => void) | undefined;
    const provider = new ScriptedProvider([
      () =>
        new Promise<LlmResult>(
          (resolve) =>
            (release = () => {
              resolve(ok());
            }),
        ),
    ]);
    const { llm, budget } = guarded(provider);
    const pending = llm.generate(request(), signal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // If the reservation transaction were still open, these would never resolve.
    const during = await budget.snapshot();
    expect(during.reserved.calls).toBe(1);
    expect(
      (
        await budget.reserve({
          stage: 'critic',
          model: 'claude-haiku-5-5',
          requestDigest: 'z',
          bounds: { inputTokens: 1, outputTokens: 1, costNanoUsd: 1 },
        })
      ).ok,
    ).toBe(true);
    release?.();
    expect((await pending).ok).toBe(true);
  });
});

describe('T-R5b: unexpected retries exhaust the configured guard safely', () => {
  it('stops EXACTLY at the call limit under a retry storm, with no success and no extra call', async () => {
    const provider = new ScriptedProvider([fail('provider_unavailable')], { repeatLast: true });
    const { llm, budget, clock } = guarded(provider, { maxCalls: 5 });
    const outcomes: LlmResult[] = [];
    for (let logical = 0; logical < 4; logical += 1) {
      outcomes.push(await run(llm, clock, request({ user: [`logical call ${String(logical)}`] })));
    }
    expect(provider.requests).toHaveLength(5); // never cap + 1
    expect(outcomes.every((o) => !o.ok)).toBe(true); // nothing is fabricated
    const denied = outcomes.filter((o) => !o.ok && o.category === 'budget_exceeded');
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied.every((o) => !o.ok && o.denial === 'calls' && o.sendState === 'not_sent')).toBe(
      true,
    );
    const snap = await budget.snapshot();
    expect(snap.unknown.calls).toBe(5); // ambiguous attempts stay counted
    expect(snap.settled.calls).toBe(0);
    expect(snap.reserved.calls).toBe(0);
    const last = outcomes[outcomes.length - 1];
    expect(last && !last.ok ? toRunFailure(last) : null).toEqual({
      state: 'failed',
      category: 'budget_exceeded',
    });
  });

  it('stops at the COST guard before the call guard when ambiguous attempts are expensive', async () => {
    const provider = new ScriptedProvider([fail('timeout')], { repeatLast: true });
    const reserve = reservationBounds(request({ user: ['c0'] }), PRICES_V1)?.costNanoUsd ?? 0;
    const cap = Math.floor(reserve * 2.5);
    const { llm, budget, clock } = guarded(provider, { maxCostNanoUsd: cap });
    const results: LlmResult[] = [];
    for (let index = 0; index < 6; index += 1)
      results.push(await run(llm, clock, request({ user: [`c${String(index)}`] })));
    const attempts = provider.requests.length;
    const snap = await budget.snapshot();
    expect(snap.unknown.costNanoUsd).toBeLessThanOrEqual(cap);
    expect(snap.unknown.calls).toBe(2); // two ambiguous attempts fit; a third would cross the cost cap
    expect(snap.settled.calls).toBe(0);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(6 * 3); // the guard cut the storm short of 3 attempts per logical call
    expect(
      results.some((r) => !r.ok && r.category === 'budget_exceeded' && r.denial === 'cost'),
    ).toBe(true);
  });

  it('never exceeds the call limit under concurrent logical calls', async () => {
    const provider = new ScriptedProvider([fail('provider_unavailable')], { repeatLast: true });
    const { llm, clock } = guarded(provider, { maxCalls: 6 });
    const pending = Array.from({ length: 8 }, (_, index) =>
      llm.generate(request({ user: [`p${String(index)}`] }), signal()),
    );
    for (let step = 0; step < 60; step += 1) await clock.advance(5_000);
    const results = await Promise.all(pending);
    expect(provider.requests.length).toBeLessThanOrEqual(6);
    expect(results.every((r) => !r.ok)).toBe(true);
  });

  it('turns an expired wall clock into a timeout run failure with no further attempt', async () => {
    const provider = new ScriptedProvider([ok()], { repeatLast: true });
    const { llm, clock } = guarded(provider, { runWallClockMs: 60_000 });
    expect((await run(llm, clock)).ok).toBe(true);
    await clock.advance(60_000);
    const late = await run(llm, clock);
    expect(late).toMatchObject({ ok: false, category: 'budget_exceeded', denial: 'wall_clock' });
    expect(provider.requests).toHaveLength(1);
    expect(late.ok ? null : toRunFailure(late)).toEqual({ state: 'failed', category: 'timeout' });
  });

  it('counts a hung attempt that times out as unknown spend, then retries within the guard', async () => {
    const provider = new ScriptedProvider(['hang', ok({ done: 1 })]);
    const { llm, budget, clock } = guarded(provider);
    const result = await run(
      llm,
      clock,
      request({ generation: { effort: 'low', maxOutputTokens: 100, timeoutMs: 1_000 } }),
    );
    expect(result).toMatchObject({ ok: true });
    const entries = await budget.entries();
    expect(entries.map((e) => [e.state, e.attempt])).toEqual([
      ['unknown', 1],
      ['settled', 2],
    ]);
  });
});

describe('the ledger never holds prompt text or secrets', () => {
  it('records digests, hashes and counts only', async () => {
    const sentinel = 'SENTINEL-PROJECT-TEXT-CANARY-ABCDEF';
    const provider = new ScriptedProvider([ok({ echo: 'fine' })]);
    const { llm, budget, clock } = guarded(provider);
    await run(llm, clock, request({ system: sentinel, user: [sentinel] }));
    const dump = JSON.stringify([await budget.entries(), await budget.snapshot()]);
    expect(dump).not.toContain('SENTINEL');
    expect(dump).not.toContain('CANARY');
  });
});
