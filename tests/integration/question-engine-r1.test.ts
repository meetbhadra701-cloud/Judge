import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JudgeDatabase } from '../../packages/database/src/index.js';
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
import { QuestionService } from '../../apps/api/src/questions/service.js';
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
const OK_USAGE = { inputTokens: 0, outputTokens: 0 };
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
  const instance = (provider: LlmProvider, extra: Record<string, unknown> = {}) =>
    buildWith(new QuestionService({ db, offline: RUNTIME, provider, ...extra }));
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

  void OK_USAGE;
});
