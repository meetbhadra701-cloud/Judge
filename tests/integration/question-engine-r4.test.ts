import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuestionSetStore, type JudgeDatabase } from '../../packages/database/src/index.js';
import { ScriptedProvider, type StructuredRequest } from '../../packages/llm/src/index.js';
import type {
  AssessmentListResponse,
  CreateQuestionSetResponse,
  QuestionSetListResponse,
} from '../../packages/schemas/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { QuestionService } from '../../apps/api/src/questions/service.js';
import { QuestionInputReader } from '../../packages/database/src/index.js';
import { generate, prepare } from '../../apps/api/src/questions/generation.js';
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
 * M6-R4: changing the scripted templates changes the generation identity. A set stored under the previous templates is never reused for the new behaviour, is never
 * rewritten, and stays readable beside the new one.
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
};
const RUNTIME = { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS } as const;

describe.each(testDatabaseTargets())(
  'question engine R4 (template identity, history) on %s',
  (_n, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let app: ApiApp;
    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      app = buildApp({
        logger,
        db,
        verifier: fakeVerifier(),
        eventContext: replayService(db, (await loadFixtures()).values()),
        projects: new ProjectService({ db }),
        assessments: new AssessmentService({ db, offline: RUNTIME }),
        questions: new QuestionService({ db, offline: RUNTIME }),
      });
    });
    afterAll(async () => {
      await app.close();
      await testDb.close();
    });
    const call = async (method: 'GET' | 'POST', url: string) => {
      const r = await app.inject({ method, url, headers: bearer(TEST_TOKENS.organizer) });
      return { status: r.statusCode, body: r.json<unknown>() };
    };

    it('a set stored under the earlier templates keeps its wording and its identity; the new templates create a second, distinct set; both stay readable', async () => {
      const result = await execute(db, {
        worldOptions: { trackKeys: ['health'], declare: ['health'] },
        provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
      });
      const projectId = result.world.project.id;
      const assessmentId =
        ((await call('GET', `/projects/${projectId}/assessments`)).body as AssessmentListResponse)
          .assessments[0]?.id ?? '';
      const read = await new QuestionInputReader(db).read(projectId, assessmentId);
      if (read.kind !== 'ready') throw new Error('expected a verified assessment');

      // the identity the previous release computed for a scripted generation: no template version in it
      const before = prepare(read.input, {
        provider: { id: 'scripted', mode: 'scripted' },
        model: MODELS.assessment,
        secrets: [],
      });
      const handles = (request: StructuredRequest) =>
        (request.user[0] ?? '').split('\n').flatMap((line) => {
          const m = /^<<<ITEM (O-\d+) [0-9a-f]{16}>>>$/.exec(line);
          return m?.[1] ? [m[1]] : [];
        });
      const oldWording =
        'Could you show us, on the project itself, what it does in relation to “Innovation”?';
      const oldProvider = new ScriptedProvider(
        [
          (request) => ({
            ok: true,
            json: {
              candidates: handles(request)
                .slice(0, 1)
                .map((h) => ({
                  mode: 'show_me',
                  text: oldWording,
                  reason:
                    'No score could be given for “Innovation”, so seeing it directly is the quickest way to place it on the rubric.',
                  expectedInformation: ['live_demonstration'],
                  opportunities: [h],
                  dimensions: [],
                  references: [],
                  distinguishes: 'strong',
                  effort: 'moderate',
                })),
            },
            usage: { inputTokens: 0, outputTokens: 0 },
            providerRequestId: null,
            servedModel: 'x',
          }),
        ],
        { repeatLast: true },
      );
      const outcome = await generate(
        read.input,
        before,
        {
          provider: oldProvider,
          model: MODELS.assessment,
          secrets: [],
          providerMode: 'scripted',
          providerId: 'scripted',
        },
        null,
        new AbortController().signal,
      );
      const stored = await new QuestionSetStore(db).persist(outcome.persist);
      expect(stored.kind).toBe('created');

      const created = await call(
        'POST',
        `/projects/${projectId}/assessments/${assessmentId}/question-sets`,
      );
      expect(created.status).toBe(201); // not "already generated": the new templates are a new identity
      const next = (created.body as CreateQuestionSetResponse).set;
      expect(next.id).not.toBe(stored.setId);
      expect(next.questions.map((q) => q.text).join(' ')).not.toMatch(
        /Innovation|Execution|Impact/,
      );

      const list = (
        await call('GET', `/projects/${projectId}/assessments/${assessmentId}/question-sets`)
      ).body as QuestionSetListResponse;
      expect(list.sets.map((s) => s.id).sort()).toEqual([stored.setId, next.id].sort());
      const old = (await call('GET', `/projects/${projectId}/question-sets/${stored.setId}`))
        .body as CreateQuestionSetResponse['set'];
      expect(old.questions[0]?.text).toBe(oldWording); // never rewritten

      const again = await call(
        'POST',
        `/projects/${projectId}/assessments/${assessmentId}/question-sets`,
      );
      expect(again.status).toBe(200);
      expect((again.body as CreateQuestionSetResponse).result).toBe('already_generated');
      expect((again.body as CreateQuestionSetResponse).set.id).toBe(next.id);
    });
  },
);
