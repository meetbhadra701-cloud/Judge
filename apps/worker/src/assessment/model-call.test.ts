import type { CallBinding, CallMetadata } from '@judge-copilot/database';
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

type IdentityKeys =
  | 'model'
  | 'provider'
  | 'providerMode'
  | 'promptId'
  | 'promptVersion'
  | 'promptTemplateHash'
  | 'schemaId'
  | 'schemaVersion';
/** A stored binding as a test states it: the audit identity defaults to what the caller registered, unless the test overrides it. */
type TestBinding = Omit<CallBinding, IdentityKeys> & Partial<Pick<CallBinding, IdentityKeys>>;

function setup(
  steps: LlmResult[],
  binding: (callId: number, digest: string, rendered: BoundClosedSet) => TestBinding | null,
) {
  let n = 0;
  const digests = new Map<number, string>();
  // what a faithful ledger would have stored for the call: the identity the caller registered and the model it reserved for
  const registered = new Map<string, CallMetadata>();
  const models = new Map<string, string>();
  const inner = {
    register(digest: string, meta: CallMetadata) {
      registered.set(digest, meta);
    },
    reserve(request: { requestDigest: string; model: string }) {
      n += 1;
      digests.set(n, request.requestDigest);
      models.set(request.requestDigest, request.model);
      return Promise.resolve({ ok: true as const, callId: n });
    },
    settle: () => Promise.resolve(),
    snapshot: () => Promise.reject(new Error('unused')),
    entries: () => Promise.resolve([]),
    reapInFlight: () => Promise.resolve(0),
    bindingOf: (callId: number) => {
      const digest = digests.get(callId) ?? '';
      const found = binding(callId, digest, {
        passages: ['P-0001'],
        claims: [],
        evidence: [],
        pairs: [],
        items: [],
        unit: null,
      });
      const meta = registered.get(digest) ?? {};
      return Promise.resolve(
        found === null
          ? null
          : {
              model: models.get(digest) ?? '',
              provider: meta.provider ?? null,
              providerMode: meta.providerMode ?? null,
              promptId: meta.promptId ?? null,
              promptVersion: meta.promptVersion ?? null,
              promptTemplateHash: meta.promptTemplateHash ?? null,
              schemaId: meta.schemaId ?? null,
              schemaVersion: meta.schemaVersion ?? null,
              ...found,
            },
      );
    },
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
  (callId: number, requestDigest: string): TestBinding =>
    ({
      callId,
      stage: 'claim_extraction',
      requestDigest,
      dimensionId: null,
      closedSet,
      closedSetHash: 'x'.repeat(64),
      ...overrides,
    }) as TestBinding;

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

  it.each([
    ['model', { model: 'claude-opus-5-5' }],
    ['provider', { provider: 'other-provider' }],
    ['provider mode', { providerMode: 'live' }],
    ['prompt id', { promptId: 'some.other.prompt' }],
    ['prompt version', { promptVersion: 'v999' }],
    ['prompt template hash', { promptTemplateHash: 'f'.repeat(64) }],
    ['schema id', { schemaId: 'some.other.schema' }],
    ['schema version', { schemaVersion: 'v999' }],
  ] satisfies [string, Partial<CallBinding>][])(
    'stops the run when the ledger recorded another %s than the one sent (R5 F-6)',
    async (_name, override) => {
      const seen: BoundClosedSet[] = [];
      const { caller } = setup([ok(OK_ANSWER)], bindingFor(FULL, override));
      await expect(caller.call(spec(seen))).rejects.toMatchObject({
        stop: {
          kind: 'fail',
          category: 'internal_error',
          code: 'call_identity_differs_from_request',
        },
      });
      expect(seen).toHaveLength(0); // the answer never reaches the domain gate
    },
  );

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

/*
 * Source-review fix 2: the stored closed set must equal the one the prompt offered in EVERY part. Each case below stores a binding that
 * differs from the offered set in exactly one list (the others, and the unit, stay identical), and the answer must be refused before the
 * validator, the first thing that reads handles, ever sees it.
 */
describe('closed-set correspondence is exact in every list', () => {
  const EMPTY = { passages: [], claims: [], evidence: [], pairs: [], items: [], unit: null };
  const claim = (n: number) => ({ handle: `C-00${String(n)}`, text: `Claim ${String(n)}.` });
  const evidence = (n: number) => ({
    handle: `E-00${String(n)}`,
    text: `Evidence ${String(n)}.`,
    quote: null,
  });

  /** One stage per list, with the offered closed set the real renderer produces for it. */
  const CASES = {
    passages: {
      stage: 'claim_extraction' as const,
      role: 'extraction' as const,
      input: { passages: [PASSAGE, { ...PASSAGE, handle: 'P-0002' }] },
      offered: { ...EMPTY, passages: ['P-0001', 'P-0002'] },
    },
    claims: {
      stage: 'relation_matching' as const,
      role: 'extraction' as const,
      input: { claims: [claim(1), claim(2)], evidence: [evidence(1)] },
      offered: { ...EMPTY, claims: ['C-001', 'C-002'], evidence: ['E-001'] },
    },
    evidence: {
      stage: 'relation_matching' as const,
      role: 'extraction' as const,
      input: { claims: [claim(1)], evidence: [evidence(1), evidence(2)] },
      offered: { ...EMPTY, claims: ['C-001'], evidence: ['E-001', 'E-002'] },
    },
    pairs: {
      stage: 'relation_verification' as const,
      role: 'extraction' as const,
      input: {
        pairs: [
          {
            handle: 'X-001',
            claim: 'A claim.',
            evidence: 'Some evidence.',
            evidenceQuote: 'quote',
          },
          {
            handle: 'X-002',
            claim: 'Another.',
            evidence: 'More evidence.',
            evidenceQuote: 'quote',
          },
        ],
      },
      offered: { ...EMPTY, pairs: ['X-001', 'X-002'] },
    },
    items: {
      stage: 'fidelity_review' as const,
      role: 'extraction' as const,
      input: {
        items: [
          { handle: 'C-001', assertion: 'A claim.', quote: 'quote one' },
          { handle: 'E-001', assertion: 'Some evidence.', quote: 'quote two' },
        ],
      },
      offered: { ...EMPTY, items: ['C-001', 'E-001'] },
    },
  };
  type Field = keyof typeof CASES;

  /** The single-list tampering of an offered list of two handles. */
  const TAMPERING: Record<string, (offered: readonly string[]) => string[]> = {
    'a missing entry': (list) => list.slice(0, 1),
    'a substituted handle': (list) => [list[0] ?? '', 'Z-999'],
    'a reordered list': (list) => [...list].reverse(),
    'an extra handle': (list) => [...list, 'Z-999'],
    'an emptied list': () => [],
  };

  const call = (field: Field, stored: Record<string, unknown>) => {
    const seen: BoundClosedSet[] = [];
    const c = CASES[field];
    const { caller } = setup([ok({ any: 'answer' })], (callId, digest) => ({
      ...bindingFor(stored)(callId, digest),
      stage: c.stage,
    }));
    const outcome: Promise<unknown> = caller.call({
      stage: c.stage,
      role: c.role,
      input: c.input,
      validate: (json: unknown, closed: BoundClosedSet) => {
        seen.push(closed);
        return { ok: true, value: json } as const;
      },
    });
    return { outcome, seen };
  };

  it.each(Object.keys(CASES) as Field[])(
    '%s: the exact stored set is accepted (control)',
    async (field) => {
      const { outcome, seen } = call(field, CASES[field].offered);
      expect(await outcome).toMatchObject({ kind: 'ok' });
      expect(seen).toEqual([CASES[field].offered]);
    },
  );

  describe.each(Object.keys(CASES) as Field[])('%s', (field) => {
    it.each(Object.keys(TAMPERING))(
      'stored list with %s is refused before the validator',
      async (name) => {
        const tamper = TAMPERING[name];
        const offered = CASES[field].offered;
        const stored = { ...offered, [field]: tamper?.(offered[field]) ?? [] };
        // everything except this one list is identical to the offered set
        for (const other of Object.keys(offered) as (keyof typeof offered)[]) {
          if (other !== field) expect(stored[other]).toEqual(offered[other]);
        }
        const { outcome, seen } = call(field, stored);
        await expect(outcome).rejects.toMatchObject({
          stop: {
            kind: 'fail',
            category: 'internal_error',
            code: 'closed_set_differs_from_prompt',
          },
        });
        expect(seen).toHaveLength(0);
      },
    );
  });

  it('a stored unit that differs from the offered unit is refused (all lists identical)', async () => {
    const { outcome, seen } = call('claims', { ...CASES.claims.offered, unit: 'novelty' });
    await expect(outcome).rejects.toMatchObject({
      stop: { code: 'closed_set_differs_from_prompt' },
    });
    expect(seen).toHaveLength(0);
  });

  // The three adversarial bindings of the review: they differ ONLY in claims, pairs or items; passages, evidence and unit are identical.
  it('adversarial binding differing only in claims', async () => {
    const stored = { ...CASES.claims.offered, claims: ['C-001', 'C-777'] };
    expect(stored.evidence).toEqual(CASES.claims.offered.evidence);
    expect(stored.passages).toEqual([]);
    const { outcome, seen } = call('claims', stored);
    await expect(outcome).rejects.toMatchObject({
      stop: { code: 'closed_set_differs_from_prompt' },
    });
    expect(seen).toHaveLength(0);
  });

  it('adversarial binding differing only in pairs', async () => {
    const stored = { ...CASES.pairs.offered, pairs: ['X-001', 'X-777'] };
    expect(stored.evidence).toEqual([]);
    expect(stored.passages).toEqual([]);
    const { outcome, seen } = call('pairs', stored);
    await expect(outcome).rejects.toMatchObject({
      stop: { code: 'closed_set_differs_from_prompt' },
    });
    expect(seen).toHaveLength(0);
  });

  it('adversarial binding differing only in items', async () => {
    const stored = { ...CASES.items.offered, items: ['C-001', 'E-777'] };
    expect(stored.evidence).toEqual([]);
    expect(stored.passages).toEqual([]);
    const { outcome, seen } = call('items', stored);
    await expect(outcome).rejects.toMatchObject({
      stop: { code: 'closed_set_differs_from_prompt' },
    });
    expect(seen).toHaveLength(0);
  });
});
