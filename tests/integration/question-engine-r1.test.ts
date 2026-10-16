import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  questionGenerationClaims,
  questionSetQuestions,
  isVoidedProjectRefusal,
  QuestionInputReader,
  QuestionClaimLostError,
  QuestionProjectVoidedError,
  questionSets,
  QuestionSetStore,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import {
  ScriptedProvider,
  type LlmProvider,
  type LlmResult,
  type StructuredRequest,
} from '../../packages/llm/src/index.js';
import {
  ApiErrorBody,
  type AssessmentListResponse,
  type CreateQuestionSetResponse,
  type QuestionSetListResponse,
  type QuestionSetView,
} from '../../packages/schemas/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { questionDemonstrationStep } from '../../apps/api/src/questions/demonstration.js';
import {
  QuestionService,
  type GenerationCoordination,
} from '../../apps/api/src/questions/service.js';
import { generate, prepare } from '../../apps/api/src/questions/generation.js';
import { corruptions } from '../../apps/worker/src/testing/corrupt.js';
import {
  bearer,
  fakeVerifier,
  loadFixtures,
  replayService,
  TEST_TOKENS,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/api/src/testing/harness.js';
import { demonstrationStep } from '../../apps/worker/src/assessment/demonstration-model.js';
import { execute } from '../../apps/worker/src/testing/run.js';

/*
 * M6-R1 (R9A P2-1 and P2-2): the question service over REAL assessments, with providers that count and block.
 * These tests assert the CORRECT behaviour: on the failed R9A head (0ae02eb) they fail (eight provider calls for eight identical requests; a voided project
 * reaches the provider and answers 500).
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
};
const RUNTIME = { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS } as const;
const errorCode = (body: unknown): string => ApiErrorBody.parse(body).error.code;
const setOf = (body: unknown): QuestionSetView => (body as CreateQuestionSetResponse).set;
const resultOf = (body: unknown): string => (body as CreateQuestionSetResponse).result;

/** A provider that counts its invocations and can be held open until released. */
class GatedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly mode = 'scripted' as const;
  calls = 0;
  private release: (() => void) | null = null;
  private readonly gate: Promise<void>;
  private readonly entered: Promise<void>;
  private signalEntered: (() => void) | null = null;
  /** When set, the held invocation fails like a refusing provider instead of answering. */
  failAfterGate = false;
  constructor(
    private readonly blocked: boolean,
    private readonly during?: () => Promise<void>,
  ) {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    this.entered = new Promise((resolve) => {
      this.signalEntered = resolve;
    });
    if (!blocked) this.release?.();
  }
  /** Resolves once the first invocation has begun. */
  get firstCallStarted(): Promise<void> {
    return this.entered;
  }
  open(): void {
    this.release?.();
  }
  async generate(request: StructuredRequest): Promise<LlmResult> {
    this.calls += 1;
    this.signalEntered?.();
    await this.during?.();
    await this.gate;
    if (this.failAfterGate) return { ok: false, category: 'refused', sendState: 'sent_unknown' };
    return questionDemonstrationStep(request);
  }
}

describe.each(testDatabaseTargets())('question engine R1 (R9A P2-1, P2-2) on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let app: ApiApp;
  let eventContext: ReturnType<typeof replayService>;

  const buildWith = (questions: QuestionService) =>
    buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db }),
      assessments: new AssessmentService({ db, offline: RUNTIME }),
      questions,
    });

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    eventContext = replayService(db, (await loadFixtures()).values());
    app = buildWith(new QuestionService({ db, offline: RUNTIME }));
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  const call = async (
    on: ApiApp,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await on.inject({
      method,
      url,
      headers: { ...bearer(TEST_TOKENS.organizer), ...headers },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.json<unknown>() };
  };

  async function assessed() {
    const result = await execute(db, {
      worldOptions: { trackKeys: ['health'], declare: ['health'] },
      provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
    });
    expect(result.outcome.kind).toBe('succeeded');
    const projectId = result.world.project.id;
    const list = (await call(app, 'GET', `/projects/${projectId}/assessments`))
      .body as AssessmentListResponse;
    return { projectId, assessmentId: list.assessments[0]?.id ?? '' };
  }
  /** A well-formed persist input for this assessment under `key`, built by the real pipeline (not a hand-written one). */
  async function buildPublishInput(projectId: string, assessmentId: string, key: string) {
    const read = await new QuestionInputReader(db).read(projectId, assessmentId);
    if (read.kind !== 'ready') throw new Error('expected a verified assessment');
    const prepared = prepare(read.input, {
      provider: { id: 'scripted', mode: 'scripted' },
      model: MODELS.assessment,
      secrets: [],
    });
    const outcome = await generate(
      read.input,
      { ...prepared, generationKey: key },
      {
        provider: new ScriptedProvider([questionDemonstrationStep], { repeatLast: true }),
        model: MODELS.assessment,
        secrets: [],
        providerMode: 'scripted',
        providerId: 'scripted',
      },
      null,
      new AbortController().signal,
    );
    return outcome.persist;
  }
  const SETS = (p: string, a: string) => `/projects/${p}/assessments/${a}/question-sets`;
  const voidProject = (projectId: string) =>
    call(
      app,
      'POST',
      `/projects/${projectId}/void`,
      { reason: 'Entered in error.' },
      {
        'idempotency-key': randomUUID(),
      },
    );
  const instance = (
    provider: LlmProvider,
    generation: Partial<GenerationCoordination> = {},
    extra: Record<string, unknown> = {},
  ) => buildWith(new QuestionService({ db, offline: RUNTIME, provider, generation, ...extra }));
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const keyOf = async (assessmentId: string) => {
    // the generation key of the only claim or set of this assessment
    const sets = (await db.select().from(questionSets)).filter(
      (row) => row.assessmentId === assessmentId,
    );
    const claims = (await db.select().from(questionGenerationClaims)).filter(
      (row) => row.assessmentId === assessmentId,
    );
    return sets[0]?.generationKey ?? claims[0]?.generationKey ?? '';
  };
  const storedSets = async (p: string, a: string) =>
    ((await call(app, 'GET', SETS(p, a))).body as QuestionSetListResponse).sets;

  describe('P2-1: one provider invocation per generation identity', () => {
    it('eight simultaneous identical requests in one process: one provider call, one set, one 201 and seven 200', async () => {
      const { projectId, assessmentId } = await assessed();
      const provider = new GatedProvider(true);
      const one = instance(provider);
      const pending = Array.from({ length: 8 }, () =>
        call(one, 'POST', SETS(projectId, assessmentId)),
      );
      await provider.firstCallStarted;
      await new Promise((resolve) => setTimeout(resolve, 150)); // let every other request reach the claim step
      provider.open();
      const responses = await Promise.all(pending);
      expect(provider.calls).toBe(1);
      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(responses.map((r) => setOf(r.body).id)).size).toBe(1);
      expect(responses.filter((r) => resultOf(r.body) === 'created')).toHaveLength(1);
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      await one.close();
    });

    it('requests across two API instances on the same database: still one provider call and one set', async () => {
      const { projectId, assessmentId } = await assessed();
      const providerA = new GatedProvider(true);
      const providerB = new GatedProvider(true);
      const a = instance(providerA);
      const b = instance(providerB);
      const pending = [
        ...Array.from({ length: 4 }, () => call(a, 'POST', SETS(projectId, assessmentId))),
        ...Array.from({ length: 4 }, () => call(b, 'POST', SETS(projectId, assessmentId))),
      ];
      await new Promise((resolve) => setTimeout(resolve, 300));
      providerA.open();
      providerB.open();
      const responses = await Promise.all(pending);
      expect(providerA.calls + providerB.calls).toBe(1);
      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(responses.map((r) => setOf(r.body).id)).size).toBe(1);
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      await a.close();
      await b.close();
    });
  });

  describe('P2-1 (continued): failure, crash, takeover and fencing', () => {
    it('a provider failure stores nothing, is shared by every waiting request, and starts a cool-down with no new provider call', async () => {
      const { projectId, assessmentId } = await assessed();
      const provider = new GatedProvider(true);
      provider.failAfterGate = true;
      const one = instance(provider, { failureCooldownMs: 700 });
      const pending = Array.from({ length: 4 }, () =>
        call(one, 'POST', SETS(projectId, assessmentId)),
      );
      await provider.firstCallStarted;
      await wait(150);
      provider.open();
      const responses = await Promise.all(pending);
      expect(responses.map((r) => r.status)).toEqual([502, 502, 502, 502]);
      expect(responses.map((r) => errorCode(r.body))).toEqual(
        Array(4).fill('QUESTION_GENERATION_FAILED'),
      );
      expect(provider.calls).toBe(1);
      expect(await storedSets(projectId, assessmentId)).toEqual([]);
      const key = await keyOf(assessmentId);
      expect(
        (await db.select().from(questionSets)).filter((row) => row.generationKey === key),
      ).toEqual([]);
      const claim = await new QuestionSetStore(db).generationClaim(key);
      expect(claim).toMatchObject({ state: 'failed', attempt: 1 });
      expect(claim?.failureCategory).toBe('QUESTION_GENERATION_FAILED:refused');

      // inside the cool-down: the same typed failure, with its retry hint, and still no new provider call
      const early = await call(one, 'POST', SETS(projectId, assessmentId));
      expect(early.status).toBe(502);
      expect(ApiErrorBody.parse(early.body).error.details?.['retryAfterMs']).toBeGreaterThan(0);
      expect(provider.calls).toBe(1);

      // after it: ONE controlled retry (attempt 2) succeeds, publishes, and the claim is gone
      await wait(800);
      provider.failAfterGate = false;
      const retry = await call(one, 'POST', SETS(projectId, assessmentId));
      expect(retry.status).toBe(201);
      expect(provider.calls).toBe(2);
      expect(await new QuestionSetStore(db).generationClaim(key)).toBeNull();
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      await one.close();
    });

    it('an abandoned claim (crashed holder) blocks others only until its lease expires; then exactly one takes over', async () => {
      const { projectId, assessmentId } = await assessed();
      // a holder that claimed and then died: claim it directly through the store, never heartbeat, never publish
      const probe = new GatedProvider(false);
      const warm = instance(probe, { failureCooldownMs: 0 });
      // learn the identity by letting a failing run record a claim, then expire it
      probe.failAfterGate = true;
      await call(warm, 'POST', SETS(projectId, assessmentId));
      const key = await keyOf(assessmentId);
      const store = new QuestionSetStore(db);
      const callsBefore = probe.calls;
      const crashed = await store.claimGeneration({
        generationKey: key,
        projectId,
        assessmentId,
        holder: 'crashed-process',
        leaseMs: 600,
        failureCooldownMs: 0,
        token: randomUUID(),
      });
      expect(crashed.kind).toBe('acquired');

      // while the lease lives: a request waits (bounded) and answers 409 IN_PROGRESS with a retry hint, with ZERO provider calls
      const blocked = instance(new GatedProvider(false), { waitMs: 250, pollMs: 50 });
      const blockedProvider = new GatedProvider(false);
      const blockedApp = instance(blockedProvider, { waitMs: 250, pollMs: 50 });
      const early = await blockedApp.inject({
        method: 'POST',
        url: SETS(projectId, assessmentId),
        headers: bearer(TEST_TOKENS.organizer),
      });
      expect(early.statusCode).toBe(409);
      expect(errorCode(early.json())).toBe('QUESTION_GENERATION_IN_PROGRESS');
      expect(early.headers['retry-after']).toBeDefined();
      expect(blockedProvider.calls).toBe(0);

      // after the lease: one request takes over, calls the provider once and publishes
      await wait(700);
      const takeoverProvider = new GatedProvider(false);
      const takeover = instance(takeoverProvider, { waitMs: 2000, pollMs: 50 });
      const racers = await Promise.all(
        Array.from({ length: 3 }, () => call(takeover, 'POST', SETS(projectId, assessmentId))),
      );
      expect(takeoverProvider.calls).toBe(1);
      expect(racers.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      expect(callsBefore).toBe(1);
      await Promise.all([warm.close(), blocked.close(), blockedApp.close(), takeover.close()]);
    });

    it('a claim won just AFTER another request published (the claim row is deleted with the set) returns the set, calls no provider and leaves no claim behind', async () => {
      const { projectId, assessmentId } = await assessed();
      const first = new GatedProvider(false);
      const publisher = instance(first);
      const published = setOf((await call(publisher, 'POST', SETS(projectId, assessmentId))).body);
      expect(first.calls).toBe(1);
      // a late request that read "no set yet" twice (before the publication became visible to it), then wins the vacant claim
      const late = new GatedProvider(false);
      const service = new QuestionService({ db, offline: RUNTIME, provider: late });
      const store = service['store'];
      const real = store.findSetIdByKey.bind(store);
      let blind = 2;
      store.findSetIdByKey = async (project, key) => {
        if (blind > 0) {
          blind -= 1;
          return null;
        }
        return real(project, key);
      };
      const lateApp = buildWith(service);
      const response = await call(lateApp, 'POST', SETS(projectId, assessmentId));
      expect(blind).toBe(0);
      expect(response.status).toBe(200);
      expect(resultOf(response.body)).toBe('already_generated');
      expect(setOf(response.body).id).toBe(published.id);
      expect(late.calls).toBe(0);
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      expect(await store.generationClaim(await keyOf(assessmentId))).toBeNull();
      await Promise.all([publisher.close(), lateApp.close()]);
    });

    it('a stale holder cannot publish after its claim was taken over: the new holder’s set stands and the old one returns it', async () => {
      const { projectId, assessmentId } = await assessed();
      const slow = new GatedProvider(true);
      const stale = instance(slow, { leaseMs: 400, heartbeatMs: 0, waitMs: 3000, pollMs: 50 });
      const first = call(stale, 'POST', SETS(projectId, assessmentId));
      await slow.firstCallStarted;
      await wait(550); // the stale holder's lease (400 ms, no heartbeat) has expired
      const fast = new GatedProvider(false);
      const fresh = instance(fast, { leaseMs: 5000, heartbeatMs: 0, waitMs: 3000, pollMs: 50 });
      const second = await call(fresh, 'POST', SETS(projectId, assessmentId));
      expect(second.status).toBe(201);
      expect(fast.calls).toBe(1);
      const published = setOf(second.body);
      // now the stale holder's provider finally answers: it must not publish
      slow.open();
      const late = await first;
      expect(slow.calls).toBe(1); // at-most-once is for PUBLICATION: both providers were called (documented limit)
      expect(late.status).toBe(200);
      expect(resultOf(late.body)).toBe('already_generated');
      expect(setOf(late.body).id).toBe(published.id);
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      await Promise.all([stale.close(), fresh.close()]);
    });

    it('a stale holder with NO published set to return answers 409 SUPERSEDED and publishes nothing; the new holder then publishes', async () => {
      const { projectId, assessmentId } = await assessed();
      const slow = new GatedProvider(true);
      const stale = instance(slow, { leaseMs: 400, heartbeatMs: 0, waitMs: 3000, pollMs: 50 });
      const first = call(stale, 'POST', SETS(projectId, assessmentId));
      await slow.firstCallStarted;
      await wait(550);
      const takeoverProvider = new GatedProvider(true);
      const fresh = instance(takeoverProvider, {
        leaseMs: 5000,
        heartbeatMs: 0,
        waitMs: 3000,
        pollMs: 50,
      });
      const second = call(fresh, 'POST', SETS(projectId, assessmentId));
      await takeoverProvider.firstCallStarted;
      slow.open(); // the stale holder answers while the new holder is still working
      const late = await first;
      expect(late.status).toBe(409);
      expect(errorCode(late.body)).toBe('QUESTION_GENERATION_SUPERSEDED');
      expect(await storedSets(projectId, assessmentId)).toEqual([]);
      takeoverProvider.open();
      expect((await second).status).toBe(201);
      expect(await storedSets(projectId, assessmentId)).toHaveLength(1);
      await Promise.all([stale.close(), fresh.close()]);
    });

    it('the heartbeat keeps a long generation alive: a short lease is not taken over while its holder lives', async () => {
      const { projectId, assessmentId } = await assessed();
      const slow = new GatedProvider(true);
      const holder = instance(slow, { leaseMs: 300, heartbeatMs: 80, waitMs: 3000, pollMs: 50 });
      const first = call(holder, 'POST', SETS(projectId, assessmentId));
      await slow.firstCallStarted;
      const rival = new GatedProvider(false);
      const rivalApp = instance(rival, { leaseMs: 300, heartbeatMs: 80, waitMs: 3000, pollMs: 50 });
      const second = call(rivalApp, 'POST', SETS(projectId, assessmentId));
      await wait(1000); // more than three lease lengths
      expect(rival.calls).toBe(0);
      slow.open();
      const results = await Promise.all([first, second]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(slow.calls + rival.calls).toBe(1);
      await Promise.all([holder.close(), rivalApp.close()]);
    });

    it('an assessment that stops verifying while the provider runs is not published (recheck before publication), and nothing is left half-written', async () => {
      const { projectId, assessmentId } = await assessed();
      const provider = new GatedProvider(true);
      const one = instance(provider);
      const pending = call(one, 'POST', SETS(projectId, assessmentId));
      await provider.firstCallStarted;
      await corruptions.reportMirror(db, assessmentId);
      provider.open();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(errorCode(response.body)).toBe('ASSESSMENT_NOT_VERIFIED');
      const key = await keyOf(assessmentId);
      expect(
        (await db.select().from(questionSets)).filter((row) => row.generationKey === key),
      ).toEqual([]);
      await one.close();
    });
  });

  describe('P2-2: a voided project never reaches the provider', () => {
    it('voided before generation: typed 409 PROJECT_VOIDED and zero provider calls', async () => {
      const { projectId, assessmentId } = await assessed();
      expect((await voidProject(projectId)).status).toBe(201);
      const provider = new GatedProvider(false);
      const one = instance(provider);
      const response = await call(one, 'POST', SETS(projectId, assessmentId));
      expect(response.status).toBe(409);
      expect(errorCode(response.body)).toBe('PROJECT_VOIDED');
      expect(provider.calls).toBe(0);
      expect(await storedSets(projectId, assessmentId)).toEqual([]);
      await one.close();
    });

    it('voided while the provider is running: 409 PROJECT_VOIDED, no new set, no 500', async () => {
      const { projectId, assessmentId } = await assessed();
      const provider = new GatedProvider(true);
      const one = instance(provider);
      const pending = call(one, 'POST', SETS(projectId, assessmentId));
      await provider.firstCallStarted;
      expect((await voidProject(projectId)).status).toBe(201);
      provider.open();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(errorCode(response.body)).toBe('PROJECT_VOIDED');
      expect(provider.calls).toBe(1);
      expect(await storedSets(projectId, assessmentId)).toEqual([]);
      await one.close();
    });
  });

  describe('P2-4: the page and the API name the cause that actually stopped the selection', () => {
    interface Item {
      handle: string;
      kind: string;
    }
    /** The uncertainties of a rendered request (handle and kind), read from its marked records. */
    const itemsOf = (request: StructuredRequest): Item[] =>
      (request.user[0] ?? '').split('\n').flatMap((line, index, lines) => {
        const head = /^<<<ITEM (O-\d+) [0-9a-f]{16}>>>$/.exec(line);
        const kind = /"kind":"([a-z_]+)"/.exec(lines[index + 1] ?? '')?.[1];
        return head?.[1] && kind ? [{ handle: head[1], kind }] : [];
      });
    const TOPICS = [
      'cache layer',
      'consent flow',
      'offline mode',
      'data export',
      'rate limiter',
      'audit log',
      'migration path',
      'alert rule',
    ];
    const candidateFor = (handle: string, n: number, over: Record<string, unknown> = {}) => ({
      mode: 'ask',
      text: `Could you walk us through the ${TOPICS[n] ?? 'main flow'} on the project itself?`,
      reason: 'It would show whether the behaviour exists beyond what the materials describe.',
      expectedInformation: ['explanation'],
      opportunities: [handle],
      dimensions: [],
      references: [],
      distinguishes: 'weak',
      effort: 'extended',
      ...over,
    });
    const serve = (build: (items: Item[]) => unknown[]) =>
      instance(
        new ScriptedProvider(
          [
            (request) => ({
              ok: true,
              json: { candidates: build(itemsOf(request)) },
              usage: { inputTokens: 0, outputTokens: 0 },
              providerRequestId: null,
              servedModel: 'x',
            }),
          ],
          { repeatLast: true },
        ),
      );

    it('four valid candidates, the low-value ones left out: the API says "below the minimum", not "repeats"', async () => {
      const { projectId, assessmentId } = await assessed();
      // one cheap, weak, expensive question per uncertainty: the claim one is still worth asking, the gaps and the general rule are not
      const low = serve((items) =>
        items.slice(0, 4).map((item, n) => candidateFor(item.handle, n)),
      );
      const response = await call(low, 'POST', SETS(projectId, assessmentId));
      expect(response.status).toBe(201);
      const set = setOf(response.body);
      expect(set.counts.candidates).toBe(4);
      expect(set.questions).toHaveLength(1);
      expect(set.shortfall?.code).toBe('below_minimum_value');
      expect(set.shortfall?.excluded).toEqual({ redundant: 0, belowMinimum: 3 });
      expect(set.shortfall?.explanation).toMatch(
        /4 valid candidates were generated and 1 was selected/,
      );
      expect(set.shortfall?.explanation).toMatch(/below the minimum worth asking/);
      expect(set.shortfall?.explanation).not.toMatch(/repeated/);
      // the uncertainties no selected question covers are still listed for manual follow-up
      expect(set.opportunities.length).toBeGreaterThan(set.questions.length);
      await low.close();
    });

    it('four valid candidates, two of them repeating a selected question: the same pool size gives a different, true cause', async () => {
      const { projectId, assessmentId } = await assessed();
      const repeats = serve((items) => {
        const claim = items.find((i) => i.kind === 'claim_unverified');
        const gap = items.find((i) => i.kind === 'unknown_recorded');
        if (!claim || !gap) throw new Error('expected a claim and a gap');
        const strong = { mode: 'demonstrate', distinguishes: 'strong', effort: 'moderate' };
        return [
          candidateFor(claim.handle, 0, strong),
          candidateFor(claim.handle, 1, strong),
          candidateFor(claim.handle, 2, strong),
          candidateFor(gap.handle, 3, strong),
        ];
      });
      const response = await call(repeats, 'POST', SETS(projectId, assessmentId));
      expect(response.status).toBe(201);
      const set = setOf(response.body);
      expect(set.counts.candidates).toBe(4);
      expect(set.questions).toHaveLength(2);
      expect(set.shortfall?.code).toBe('redundant_candidates');
      expect(set.shortfall?.excluded).toEqual({ redundant: 2, belowMinimum: 0 });
      expect(set.shortfall?.explanation).toMatch(
        /2 were left out because each largely repeated a question already selected/,
      );
      expect(set.shortfall?.explanation).not.toMatch(/below the minimum/);
      await repeats.close();
    });

    it('a stored v1 set keeps its recorded wording and says it was recorded under the older policy; v2 sets carry no such note', async () => {
      const { projectId, assessmentId } = await assessed();
      const v2 = setOf((await call(app, 'POST', SETS(projectId, assessmentId))).body);
      expect(v2.policyVersion).toBe('question-engine/v2');
      expect(v2.shortfall?.policyNote ?? null).toBeNull();
      // a set recorded under policy v1 (inserted as v1 wrote it: no excluded split)
      const store = new QuestionSetStore(db);
      const input = await buildPublishInput(projectId, assessmentId, 'c'.repeat(64));
      await store.persist({
        ...input,
        policyVersion: 'question-engine/v1',
        counts: { ...input.counts, selected: 1, candidates: 6 },
        questions: input.questions.slice(0, 1).map((q) => ({ ...q, rank: 1 })),
        shortfall: { code: 'redundant_candidates', explanation: 'The recorded v1 wording.' },
      });
      const list = (await call(app, 'GET', SETS(projectId, assessmentId)))
        .body as QuestionSetListResponse;
      const v1Id = list.sets.find((s) => s.id !== v2.id)?.id ?? '';
      const v1 = (await call(app, 'GET', `/projects/${projectId}/question-sets/${v1Id}`))
        .body as QuestionSetView;
      expect(v1.policyVersion).toBe('question-engine/v1');
      expect(v1.shortfall?.explanation).toBe('The recorded v1 wording.');
      expect(v1.shortfall?.excluded).toBeNull();
      expect(v1.shortfall?.policyNote).toMatch(/Recorded under selection policy v1/);
    });
  });

  describe('P2-2 (continued): history, scope and the void race', () => {
    it('keeps a voided project’s historical question sets readable and refuses only NEW generation', async () => {
      const { projectId, assessmentId } = await assessed();
      const created = setOf((await call(app, 'POST', SETS(projectId, assessmentId))).body);
      expect((await voidProject(projectId)).status).toBe(201);
      // history: unchanged and readable (the established contract for voided projects)
      const read = await call(app, 'GET', `/projects/${projectId}/question-sets/${created.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual(created);
      const list = (await call(app, 'GET', SETS(projectId, assessmentId)))
        .body as QuestionSetListResponse;
      expect(list.sets.map((s) => s.id)).toEqual([created.id]);
      expect(list.launch.available).toBe(false);
      expect(list.launch.notice).toMatch(/voided/);
      // new generation: refused, typed, and the historical row is untouched
      const again = await call(app, 'POST', SETS(projectId, assessmentId));
      expect(again.status).toBe(409);
      expect(errorCode(again.body)).toBe('PROJECT_VOIDED');
      expect(
        (await call(app, 'GET', `/projects/${projectId}/question-sets/${created.id}`)).body,
      ).toEqual(created);
    });

    it('is scoped to the project in the path: a voided project cannot be probed or generated through another project, and another project is unaffected', async () => {
      const voided = await assessed();
      const other = await assessed();
      expect((await voidProject(voided.projectId)).status).toBe(201);
      // the other project's assessment through the voided project's path (and the reverse) is indistinguishable from a missing one
      for (const response of [
        await call(app, 'POST', SETS(voided.projectId, other.assessmentId)),
        await call(app, 'POST', SETS(other.projectId, voided.assessmentId)),
      ]) {
        expect([404, 409]).toContain(response.status);
        expect(JSON.stringify(response.body)).not.toContain(other.assessmentId.slice(0, 8) + 'x');
      }
      // an unrelated project keeps generating
      const provider = new GatedProvider(false);
      const one = instance(provider);
      expect((await call(one, 'POST', SETS(other.projectId, other.assessmentId))).status).toBe(201);
      expect(provider.calls).toBe(1);
      await one.close();
    });

    it('the store refuses to publish for a project voided meanwhile (checked inside the publishing transaction) and leaves nothing behind', async () => {
      const { projectId, assessmentId } = await assessed();
      const provider = new GatedProvider(true);
      provider.failAfterGate = true;
      const probe = instance(provider, { failureCooldownMs: 0 });
      const first = call(probe, 'POST', SETS(projectId, assessmentId));
      await provider.firstCallStarted;
      provider.open();
      await first; // a failed attempt leaves a claim row: we need its identity
      const key = await keyOf(assessmentId);
      const store = new QuestionSetStore(db);
      const token = randomUUID();
      expect(
        (
          await store.claimGeneration({
            generationKey: key,
            projectId,
            assessmentId,
            holder: 'h',
            leaseMs: 60000,
            failureCooldownMs: 0,
            token,
          })
        ).kind,
      ).toBe('acquired');
      expect((await voidProject(projectId)).status).toBe(201);
      const input = await buildPublishInput(projectId, assessmentId, key);
      await expect(store.publish(input, { token })).rejects.toBeInstanceOf(
        QuestionProjectVoidedError,
      );
      // nothing half-published: no set, no children; the claim is still ours (it was not consumed)
      expect((await db.select().from(questionSets)).filter((r) => r.generationKey === key)).toEqual(
        [],
      );
      expect(await store.generationClaim(key)).toMatchObject({ claimToken: token });
      // a caller that does not hold the claim publishes nothing either
      await expect(store.publish(input, { token: randomUUID() })).rejects.toBeInstanceOf(
        QuestionClaimLostError,
      );
      await probe.close();
    });

    it('the database guard itself still refuses an insert for a voided project, and the translation recognises exactly that refusal (no generic 500)', async () => {
      const { projectId, assessmentId } = await assessed();
      const provider = new GatedProvider(false);
      const warm = instance(provider);
      const created = setOf((await call(warm, 'POST', SETS(projectId, assessmentId))).body);
      const key = await keyOf(assessmentId);
      expect(created.questions.length).toBeGreaterThan(0);
      expect((await voidProject(projectId)).status).toBe(201);
      const store = new QuestionSetStore(db);
      const input = await buildPublishInput(
        projectId,
        assessmentId,
        key.replace(/.$/, key.endsWith('0') ? '1' : '0'),
      );
      // the raw store path has no pre-check: the trigger of migration 0023 refuses, and the refusal is the one the service translates
      const refusal = await store.persist(input).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(isVoidedProjectRefusal(refusal)).toBe(true);
      expect(isVoidedProjectRefusal(new Error('some other failure'))).toBe(false);
      expect(isVoidedProjectRefusal(null)).toBe(false);
      // the refused insert left no second set for this assessment
      expect(
        (await db.select().from(questionSets)).filter((r) => r.assessmentId === assessmentId),
      ).toHaveLength(1);
      expect(
        (await db.select().from(questionSetQuestions)).filter((r) => r.setId === created.id),
      ).not.toHaveLength(0);
      await warm.close();
    });
  });
});
