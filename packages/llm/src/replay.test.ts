import { describe, expect, it } from 'vitest';
import { computeRequestDigest } from './digest.js';
import { ProviderNotAllowedError } from './modes.js';
import { REPLAY_FIXTURE_VERSION, ReplayProvider } from './replay.js';
import { ScriptedProvider } from './scripted.js';
import { request, signal } from './testing/builders.js';
import { ManualClock } from './clock.js';
import { createGuardedProvider } from './guarded.js';
import { PRICES_V1 } from './prices-v1.js';
import { budgetFor } from './testing/builders.js';

const base = request({ user: ['P-0001 evidence text', 'rubric anchors v1: 0-10'] });
const fixture = (overrides: Record<string, unknown> = {}) => ({
  version: REPLAY_FIXTURE_VERSION,
  synthetic: true,
  entries: [
    {
      requestDigest: computeRequestDigest(base),
      stage: 'claim_extraction',
      note: 'hand-authored synthetic output',
      output: { claims: [{ ref: 'c1' }] },
      usage: { inputTokens: 321, outputTokens: 45 },
    },
  ],
  ...overrides,
});

describe('ReplayProvider', () => {
  it('serves a recording by the exact request digest, as a clone', async () => {
    const provider = new ReplayProvider({ fixtures: fixture() });
    const first = await provider.generate(base, signal());
    expect(first).toMatchObject({
      ok: true,
      usage: { inputTokens: 321, outputTokens: 45 },
      servedModel: base.model,
    });
    if (first.ok) (first.json as { claims: unknown[] }).claims.push('mutated');
    const second = await provider.generate(base, signal());
    expect(second.ok && (second.json as { claims: unknown[] }).claims).toHaveLength(1);
    expect(provider.mode).toBe('replay');
  });

  it('misses — never serves an old recording — when ANY model-visible input or setting changes', async () => {
    const provider = new ReplayProvider({ fixtures: fixture() });
    const changed = [
      request({ user: ['P-0001 evidence text.', 'rubric anchors v1: 0-10'] }), // one character of evidence
      request({ user: ['P-0001 evidence text', 'rubric anchors v1: 0-9'] }), // a changed anchor, same handles
      request({ user: ['P-0001 evidence text', 'rubric anchors v1: 0-10', 'extra'] }),
      request({ user: base.user, system: `${base.system} ` }),
      request({ user: base.user, model: 'claude-sonnet-5-5' }),
      request({ user: base.user, promptVersion: 'v2' }),
      request({ user: base.user, schemaVersion: 'v2' }),
      request({ user: base.user, jsonSchema: { type: 'object' } }),
      request({
        user: base.user,
        generation: { effort: 'high', maxOutputTokens: 1_000, timeoutMs: 120_000 },
      }),
      request({
        user: base.user,
        generation: { effort: 'low', maxOutputTokens: 999, timeoutMs: 120_000 },
      }),
    ];
    for (const candidate of changed) {
      expect(await provider.generate(candidate, signal())).toEqual({
        ok: false,
        category: 'replay_miss',
        sendState: 'not_sent',
      });
    }
    expect(provider.misses).toHaveLength(changed.length);
    expect(new Set(provider.misses).size).toBe(changed.length);
  });

  it('is unaffected by the timeout (it does not change what the model sees)', async () => {
    const provider = new ReplayProvider({ fixtures: fixture() });
    const result = await provider.generate(
      request({
        user: base.user,
        generation: { effort: 'low', maxOutputTokens: 1_000, timeoutMs: 5 },
      }),
      signal(),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses fixtures that are not declared synthetic, have bad digests, or repeat a digest', () => {
    expect(() => new ReplayProvider({ fixtures: fixture({ synthetic: false }) })).toThrow();
    expect(() => new ReplayProvider({ fixtures: fixture({ version: 'other' }) })).toThrow();
    const [entry] = fixture().entries;
    expect(
      () =>
        new ReplayProvider({
          fixtures: fixture({ entries: [{ ...entry, requestDigest: 'not-a-digest' }] }),
        }),
    ).toThrow();
    expect(
      () => new ReplayProvider({ fixtures: fixture({ entries: [entry, { ...entry }] }) }),
    ).toThrow(/duplicate/);
    expect(
      () =>
        new ReplayProvider({
          fixtures: { ...fixture(), entries: [{ requestDigest: 'a'.repeat(64) }] },
        }),
    ).toThrow();
    expect(() => new ReplayProvider({ fixtures: { ...fixture(), extra: 1 } })).toThrow();
  });

  it('is refused in production, for replay and scripted providers alike', () => {
    expect(() => new ReplayProvider({ fixtures: fixture(), nodeEnv: 'production' })).toThrow(
      ProviderNotAllowedError,
    );
    expect(() => new ScriptedProvider([], { nodeEnv: 'production' })).toThrow(
      ProviderNotAllowedError,
    );
    expect(() => new ReplayProvider({ fixtures: fixture(), nodeEnv: 'development' })).not.toThrow();
    expect(() => new ReplayProvider({ fixtures: fixture(), nodeEnv: 'test' })).not.toThrow();
  });

  it('answers cancelled when already aborted, without recording a miss', async () => {
    const provider = new ReplayProvider({ fixtures: fixture() });
    const controller = new AbortController();
    controller.abort();
    expect(await provider.generate(base, controller.signal)).toMatchObject({
      category: 'cancelled',
      sendState: 'not_sent',
    });
    expect(provider.misses).toHaveLength(0);
  });

  it('needs no credential, no network and no clock; the guard counts its recorded usage as measured', async () => {
    const { budget, clock } = budgetFor();
    const llm = createGuardedProvider({
      base: new ReplayProvider({ fixtures: fixture() }),
      budget,
      prices: PRICES_V1,
      clock,
      random: () => 0.5,
    });
    expect((await llm.generate(base, signal())).ok).toBe(true);
    const [entry] = await budget.entries();
    expect(entry).toMatchObject({ state: 'settled', inputTokens: 321, outputTokens: 45 });
    expect(llm.mode).toBe('replay');
    expect(new ManualClock().pending).toBe(0);
  });

  it('proves a digest depends on text, so freshly allocated UUIDs inside a prompt would defeat replay (handles are required)', () => {
    const withUuid = (uuid: string) =>
      request({ user: [`evidence ${uuid}: handler validates input`] });
    expect(computeRequestDigest(withUuid('3f2b8f0e-6a38-4c0b-9a6e-1f1c3d6c4a11'))).not.toBe(
      computeRequestDigest(withUuid('9d1c2e0a-0b7f-4a52-8e53-5a1d7c7e9b02')),
    );
    const withHandle = (handle: string) =>
      request({ user: [`evidence ${handle}: handler validates input`] });
    expect(computeRequestDigest(withHandle('E-001'))).toBe(
      computeRequestDigest(withHandle('E-001')),
    );
  });
});
