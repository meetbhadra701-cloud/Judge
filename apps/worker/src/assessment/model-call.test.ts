import type { CallBinding } from '@judge-copilot/database';
import {
  createGuardedProvider,
  PRICES_V1,
  ScriptedProvider,
  systemClock,
  type LlmResult,
} from '@judge-copilot/llm';
import { createLogger } from '@judge-copilot/shared';
import { describe, expect, it } from 'vitest';
import { nullSink } from '../testing/probes.js';
import { buildPipelineConfig } from './config.js';
import { RecordingBudget } from './ledger.js';
import { ModelCaller, type BoundClosedSet } from './model-call.js';
import { RunSession } from './session.js';
import { RunStopped } from './stop.js';

/*
 * The model caller against a stub ledger: the answer is validated against the closed set READ BACK from the ledger row of the
 * successful attempt, and a ledger row that is not about this request stops the run.
 */

const PASSAGE = {
  handle: 'P-0001',
  sourceType: 'devpost',
  artifact: 'submission.txt',
  text: 'It works offline and never sends your data to a server.',
};
const OK_ANSWER = { claims: [] };
const ok = (json: unknown): LlmResult => ({
  ok: true,
  json,
  usage: { inputTokens: 100, outputTokens: 10 },
  providerRequestId: null,
  servedModel: 'm',
});

function setup(
  steps: LlmResult[],
  binding: (callId: number, digest: string, rendered: BoundClosedSet) => CallBinding | null,
) {
  let n = 0;
  const digests = new Map<number, string>();
  const inner = {
    register() {},
    reserve(request: { requestDigest: string }) {
      n += 1;
      digests.set(n, request.requestDigest);
      return Promise.resolve({ ok: true as const, callId: n });
    },
    settle: () => Promise.resolve(),
    snapshot: () => Promise.reject(new Error('unused')),
    entries: () => Promise.resolve([]),
    reapInFlight: () => Promise.resolve(0),
    bindingOf: (callId: number) =>
      Promise.resolve(
        binding(callId, digests.get(callId) ?? '', {
          passages: ['P-0001'],
          claims: [],
          evidence: [],
          pairs: [],
          items: [],
          unit: null,
        }),
      ),
  };
  const ledger = new RecordingBudget(inner as never);
  const base = new ScriptedProvider(steps);
  const clock = systemClock;
  const guarded = createGuardedProvider({
    base,
    budget: ledger,
    prices: PRICES_V1,
    clock,
    random: () => 0.5,
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 1_000 },
  });
  const config = buildPipelineConfig({
    provider: { id: base.id, mode: base.mode },
    models: {
      extraction: 'claude-haiku-5-5',
      assessment: 'claude-sonnet-5-5',
      critic: 'claude-sonnet-5-5',
    },
  });
  const session = new RunSession({
    runId: 'r',
    leaseToken: 't',
    runs: { heartbeat: () => Promise.resolve(true) } as never,
    clock,
    leaseMs: 60_000,
    shutdown: new AbortController().signal,
    wallClockMs: 60_000,
    logger: createLogger({ service: 't', destination: nullSink() }),
  });
  const caller = new ModelCaller({ session, ledger, provider: guarded, config });
  return { caller, base };
}

const bindingFor =
  (closedSet: Record<string, unknown>, overrides: Partial<CallBinding> = {}) =>
  (callId: number, requestDigest: string): CallBinding => ({
    callId,
    stage: 'claim_extraction',
    requestDigest,
    dimensionId: null,
    closedSet,
    closedSetHash: 'x'.repeat(64),
    ...overrides,
  });

const spec = (seen: BoundClosedSet[] = []) => ({
  stage: 'claim_extraction' as const,
  role: 'extraction' as const,
  input: { passages: [PASSAGE] },
  validate: (json: unknown, closed: BoundClosedSet) => {
    seen.push(closed);
    return json !== null &&
      typeof json === 'object' &&
      Array.isArray((json as { claims?: unknown }).claims)
      ? ({ ok: true, value: json } as const)
      : ({ ok: false, phase: 'shape' } as const);
  },
});

const FULL = { passages: ['P-0001'], claims: [], evidence: [], pairs: [], items: [], unit: null };

describe('ModelCaller', () => {
  it('validates against the closed set read back from the ledger row of the successful attempt', async () => {
    const { caller } = setup([ok(OK_ANSWER)], bindingFor(FULL));
    const seen: BoundClosedSet[] = [];
    const result = await caller.call(spec(seen));
    expect(result).toMatchObject({ kind: 'ok', reasked: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(FULL);
  });

  it('stops the run when the ledger row is not about this request (digest or stage differ)', async () => {
    for (const override of [{ requestDigest: 'f'.repeat(64) }, { stage: 'critic' as const }]) {
      const { caller } = setup([ok(OK_ANSWER)], (callId) => ({
        ...bindingFor(FULL)(callId, 'x'),
        ...override,
      }));
      await expect(caller.call(spec())).rejects.toMatchObject({
        stop: { kind: 'fail', category: 'internal_error', code: 'closed_set_unbound' },
      });
    }
    const missing = setup([ok(OK_ANSWER)], () => null);
    await expect(missing.caller.call(spec())).rejects.toBeInstanceOf(RunStopped);
  });

  it('stops the run when the stored closed set differs from the one the prompt offered', async () => {
    const { caller } = setup(
      [ok(OK_ANSWER)],
      bindingFor({ ...FULL, passages: ['P-0001', 'P-0002'] }),
    );
    await expect(caller.call(spec())).rejects.toMatchObject({
      stop: { code: 'closed_set_differs_from_prompt' },
    });
  });

  it('rejects a malformed stored closed set instead of guessing', async () => {
    const { caller } = setup([ok(OK_ANSWER)], bindingFor({ ...FULL, passages: 'P-0001' }));
    await expect(caller.call(spec())).rejects.toMatchObject({
      stop: { code: 'closed_set_malformed' },
    });
  });

  it.each([
    ['text', 'not json at all'],
    ['fenced JSON text', '```json\n{"claims":[]}\n```'],
    ['array', []],
    ['null', null],
    ['number', 7],
    ['wrong shape', { claims: 'no' }],
  ])(
    'an answer that is %s is invalid: exactly ONE re-ask of the identical request, then it is reported',
    async (_name, answer) => {
      const { caller, base } = setup([ok(answer), ok(answer), ok(OK_ANSWER)], bindingFor(FULL));
      const result = await caller.call(spec());
      expect(result).toEqual({ kind: 'invalid', phase: 'shape' });
      expect(base.requests).toHaveLength(2); // the third scripted answer was never reached
      expect(base.requests[0]).toEqual(base.requests[1]); // the re-ask repeats the request byte for byte
    },
  );

  it('a valid answer on the re-ask is used (and flagged as re-asked)', async () => {
    const { caller, base } = setup([ok('garbage'), ok(OK_ANSWER)], bindingFor(FULL));
    expect(await caller.call(spec())).toMatchObject({ kind: 'ok', reasked: true });
    expect(base.requests).toHaveLength(2);
  });

  it('reports refusals and truncations to the caller instead of retrying them', async () => {
    const refused = setup(
      [{ ok: false, category: 'refused', sendState: 'sent_unknown' }],
      bindingFor(FULL),
    );
    expect(await refused.caller.call(spec())).toEqual({ kind: 'refused' });
    const truncated = setup(
      [{ ok: false, category: 'truncated', sendState: 'sent_unknown' }],
      bindingFor(FULL),
    );
    expect(await truncated.caller.call(spec())).toEqual({ kind: 'truncated' });
  });

  it('turns outages and budget denials into run endings', async () => {
    const outage = setup(
      Array.from(
        { length: 3 },
        () => ({ ok: false, category: 'provider_unavailable', sendState: 'not_sent' }) as const,
      ),
      bindingFor(FULL),
    );
    await expect(outage.caller.call(spec())).rejects.toMatchObject({
      stop: { kind: 'fail', category: 'provider_error', code: 'provider_unavailable' },
    });
    expect(outage.base.requests).toHaveLength(3);
  });
});
