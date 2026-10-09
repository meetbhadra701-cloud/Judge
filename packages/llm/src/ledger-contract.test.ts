import { sha256Hex, canonicalJson } from '@judge-copilot/context';
import { describe, expect, it } from 'vitest';
import { MAX_RECORDED_RESPONSE_BYTES, type RunBudget } from './budget.js';
import { createGuardedProvider } from './guarded.js';
import { PRICES_V1 } from './prices-v1.js';
import { ScriptedProvider } from './scripted.js';
import { budgetFor, fail, ok, request, seededRandom, signal, usage } from './testing/builders.js';

/*
 * F3 — the response-auditing contract of a RunBudget ledger. The suite is parameterized over a ledger factory so the
 * database-backed ledger (P4) inherits it by adding one factory to this table.
 */
const ledgers: [string, () => RunBudget][] = [['in-memory', () => budgetFor().budget]];

const bounds = { inputTokens: 100, outputTokens: 100, costNanoUsd: 1_000 };
async function settleWith(budget: RunBudget, responseJson: unknown, hash: string | null = null) {
  const r = await budget.reserve({
    stage: 'critic',
    model: 'claude-haiku-5-5',
    requestDigest: 'd',
    bounds,
  });
  if (!r.ok) throw new Error('denied');
  await budget.settle(r.callId, {
    kind: 'measured',
    usage: usage(10, 5),
    outcomeCode: 'ok',
    responseHash: hash,
    ...(responseJson === undefined ? {} : { responseJson }),
  });
  const entries = await budget.entries();
  const entry = entries[entries.length - 1];
  if (!entry) throw new Error('no entry');
  return entry;
}

describe.each(ledgers)('%s ledger: response auditing contract', (_name, make) => {
  it('retains the model answer as a canonical, key-sorted, deeply frozen copy', async () => {
    const answer = { zeta: 1, alpha: { nested: [3, 2, { b: 1, a: 2 }] } };
    const entry = await settleWith(make(), answer);
    expect(entry.responseRecord).toBe('stored');
    expect(entry.responseJson).toEqual(answer);
    expect(JSON.stringify(entry.responseJson)).toBe(
      '{"alpha":{"nested":[3,2,{"a":2,"b":1}]},"zeta":1}',
    );
    expect(entry.responseBytes).toBe(new TextEncoder().encode(canonicalJson(answer)).length);
    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(entry.responseJson)).toBe(true);
    expect(() => {
      (entry.responseJson as { zeta: number }).zeta = 99;
    }).toThrow(TypeError);
  });

  it("does not alias the caller's object: mutating it afterwards cannot change the record", async () => {
    const budget = make();
    const answer = { claims: [{ ref: 'c1' }] };
    await settleWith(budget, answer);
    answer.claims.push({ ref: 'c2' });
    const [entry] = await budget.entries();
    expect(entry?.responseJson).toEqual({ claims: [{ ref: 'c1' }] });
  });

  it('hands out entries whose mutation cannot alter the ledger', async () => {
    const budget = make();
    await settleWith(budget, { a: 1 });
    const [first] = await budget.entries();
    if (first) (first as { responseRecord: string }).responseRecord = 'none';
    const [again] = await budget.entries();
    expect(again?.responseRecord).toBe('stored');
  });

  it('keeps the recorded answer bound: exactly the limit is stored, one byte more is not', async () => {
    const overhead = new TextEncoder().encode(canonicalJson({ a: '' })).length; // {"a":""}
    const atLimit = { a: 'x'.repeat(MAX_RECORDED_RESPONSE_BYTES - overhead) };
    const stored = await settleWith(make(), atLimit);
    expect(stored.responseBytes).toBe(MAX_RECORDED_RESPONSE_BYTES);
    expect(stored.responseRecord).toBe('stored');

    const over = { a: 'x'.repeat(MAX_RECORDED_RESPONSE_BYTES - overhead + 1) };
    const hash = sha256Hex(canonicalJson(over));
    const dropped = await settleWith(make(), over, hash);
    expect(dropped.responseRecord).toBe('too_large');
    expect(dropped.responseJson).toBeNull();
    expect(dropped.responseBytes).toBe(MAX_RECORDED_RESPONSE_BYTES + 1);
    expect(dropped.responseHash).toBe(hash); // the answer is still identified, just not retained
  });

  it('measures the bound in UTF-8 bytes, not characters', async () => {
    const overhead = new TextEncoder().encode(canonicalJson({ a: '' })).length;
    const emoji = '😀'; // 4 bytes
    const count = Math.floor((MAX_RECORDED_RESPONSE_BYTES - overhead) / 4);
    expect((await settleWith(make(), { a: emoji.repeat(count) })).responseRecord).toBe('stored');
    expect((await settleWith(make(), { a: emoji.repeat(count + 1) })).responseRecord).toBe(
      'too_large',
    );
  });

  it('records unserializable answers as such, without throwing', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    for (const answer of [circular, { n: 10n }, () => 1]) {
      const entry = await settleWith(make(), answer);
      expect(entry.responseRecord).toBe('unserializable');
      expect(entry.responseJson).toBeNull();
    }
  });

  it('stores nothing when there is no answer, and never for a released or unknown attempt', async () => {
    const budget = make();
    expect((await settleWith(budget, undefined)).responseRecord).toBe('none');
    for (const kind of ['released', 'unknown'] as const) {
      const r = await budget.reserve({
        stage: 'critic',
        model: 'claude-haiku-5-5',
        requestDigest: kind,
        bounds,
      });
      if (!r.ok) throw new Error('denied');
      await budget.settle(r.callId, { kind, outcomeCode: 'x' });
    }
    const entries = await budget.entries();
    expect(entries.slice(1).map((e) => [e.responseRecord, e.responseJson])).toEqual([
      ['none', null],
      ['none', null],
    ]);
  });
});

describe('through the guarded provider: only the answer is recorded, never the request', () => {
  it('records the model answer and its hash, and none of the prompt or credential text', async () => {
    const prompt = 'PROMPT-CANARY system and project text';
    const credential = 'CANARY-api-key-value-0123456789';
    const answer = { claims: [{ ref: 'c1', text: 'ok' }] };
    const { budget, clock } = budgetFor();
    const llm = createGuardedProvider({
      base: new ScriptedProvider([ok(answer, usage(5, 5))]),
      budget,
      prices: PRICES_V1,
      clock,
      random: seededRandom(1),
    });
    await llm.generate(request({ system: prompt, user: [prompt, credential] }), signal());
    const [entry] = await budget.entries();
    expect(entry?.responseJson).toEqual(answer);
    expect(entry?.responseHash).toBe(sha256Hex(canonicalJson(answer)));
    const dump = JSON.stringify([await budget.entries(), await budget.snapshot()]);
    expect(dump).not.toContain('PROMPT-CANARY');
    expect(dump).not.toContain('CANARY-api-key');
  });

  it('records nothing for a failed attempt', async () => {
    const { budget, clock } = budgetFor();
    const llm = createGuardedProvider({
      base: new ScriptedProvider([fail('refused', 'sent_unknown')]),
      budget,
      prices: PRICES_V1,
      clock,
      random: seededRandom(1),
    });
    await llm.generate(request(), signal());
    const [entry] = await budget.entries();
    expect([entry?.responseRecord, entry?.responseJson]).toEqual(['none', null]);
  });
});
