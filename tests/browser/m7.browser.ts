/// <reference lib="dom" />
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest';
import { openOfflineGate } from '../../apps/api/src/assessments/runtime-gate.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { InterviewService } from '../../apps/api/src/interview/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { QuestionService } from '../../apps/api/src/questions/service.js';
import {
  fakeVerifier,
  loadFixtures,
  replayService,
  TEST_TOKENS,
} from '../../apps/api/src/testing/harness.js';
import { demonstrationStep } from '../../apps/worker/src/assessment/demonstration-model.js';
import { TEST_MODELS } from '../../apps/worker/src/testing/assessment-world.js';
import { testDatabaseTargets, type TestDatabase } from '../../apps/worker/src/testing/harness.js';
import { execute } from '../../apps/worker/src/testing/run.js';
import { ScriptedProvider } from '../../packages/llm/src/index.js';
import type {
  AssessmentListResponse,
  InterviewRecordsResponse,
} from '../../packages/schemas/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';

/*
 * M7: a REAL-BROWSER interview journey (Chromium), through the production web build and the real API over loopback.
 *
 *   open the question -> type the team's answer -> save -> record a separate observation of the live demonstration (linked to that answer) and a standalone one
 *   -> reload -> the original text, the actor, the time and the linkage are exactly as saved.
 *
 * Also in the browser: an empty save is refused with the rule and keeps what was typed; a save whose RESPONSE is lost (a proxy forwards the request and then drops the
 * connection) says it could not confirm, keeps the text, and pressing Save again records it exactly once; a correction keeps the original and marks it superseded;
 * hostile text is shown as text; a voided project keeps its history and shows no form.
 *
 * Real: the web server (`next start` of the production build), the API routes, the real question and interview services, the database. Not real: the model
 * (the offline scripted demonstration, nothing is called or spent), the network, and every text below, which is SYNTHETIC. The project and its verified assessment are
 * produced by the worker pipeline harness; the journey itself only drives the UI (and, to void the project and to count what was saved, reads or calls the API).
 * Run with `pnpm test:browser`.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_DIR = join(ROOT, 'apps/web');
const SHOTS = process.env['BROWSER_SMOKE_SHOTS'] ?? join(tmpdir(), 'judge-m7-shots');
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const [, openDatabase] = testDatabaseTargets()[0] as [string, () => Promise<TestDatabase>];

async function waitForHttp(url: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).status > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
}

/**
 * A forwarding proxy between the web server and the API. It sees every request the web tier makes, and can be told to forward the NEXT team-answer POST and then drop
 * the connection without answering (the response is lost, the request was processed): the case an idempotent retry exists for.
 */
function startProxy(target: string): Promise<{
  server: Server;
  url: string;
  state: {
    dropNextAnswerResponse: boolean;
    answerPosts: { key: string | undefined; status: number | null }[];
  };
}> {
  const state = {
    dropNextAnswerResponse: false,
    answerPosts: [] as { key: string | undefined; status: number | null }[],
  };
  const upstream = new URL(target);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const isAnswer = req.method === 'POST' && /\/team-answers$/.test(req.url ?? '');
      const forward = httpRequest(
        {
          host: upstream.hostname,
          port: upstream.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (answer) => {
          const body: Buffer[] = [];
          answer.on('data', (c: Buffer) => body.push(c));
          answer.on('end', () => {
            if (isAnswer) {
              const key = req.headers['idempotency-key'];
              state.answerPosts.push({
                key: typeof key === 'string' ? key : undefined,
                status: answer.statusCode ?? null,
              });
              if (state.dropNextAnswerResponse) {
                state.dropNextAnswerResponse = false;
                req.socket.destroy();
                return;
              }
            }
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            res.end(Buffer.concat(body));
          });
        },
      );
      forward.on('error', () => res.destroy());
      forward.end(Buffer.concat(chunks));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      resolveStart({
        server,
        url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        state,
      });
    });
  });
}

describe('M7 real-browser journey: Interview Mode', () => {
  let testDb: TestDatabase;
  let app: ApiApp;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let page: Page;
  let webUrl = '';
  let apiUrl = '';
  let projectId = '';
  let assessmentId = '';

  const shot = async (name: string) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };
  const api = async <T = Record<string, unknown>>(
    path: string,
    token: string = TEST_TOKENS.judge,
  ) =>
    (await (
      await fetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as T;
  const records = () =>
    api<InterviewRecordsResponse>(`/projects/${projectId}/assessments/${assessmentId}/interview`);
  const interviewUrl = () => `${webUrl}/projects/${projectId}/interview`;

  beforeAll(async () => {
    if (!existsSync(join(WEB_DIR, '.next/BUILD_ID'))) {
      throw new Error(
        'apps/web has no production build: run `pnpm test:browser` (it builds first).',
      );
    }
    testDb = await openDatabase();
    const db = testDb.db;
    // a project with a VERIFIED pre-interview assessment, produced by the worker pipeline harness with the scripted demonstration model
    const seeded = await execute(db, {
      worldOptions: { trackKeys: ['health'], declare: ['health'] },
      provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
    });
    expect(seeded.outcome.kind).toBe('succeeded');
    projectId = seeded.world.project.id;
    const gate = await openOfflineGate({
      provider: 'scripted',
      fixturePath: undefined,
      models: TEST_MODELS,
    });
    expect(gate.problem).toBeNull();
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext: replayService(db, (await loadFixtures()).values()),
      projects: new ProjectService({ db }),
      assessments: new AssessmentService({ db, offline: gate.runtime }),
      questions: new QuestionService({ db, offline: gate.runtime }),
      interview: new InterviewService({ db }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apiUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    assessmentId =
      (await api<AssessmentListResponse>(`/projects/${projectId}/assessments`)).assessments[0]
        ?.id ?? '';
    expect(assessmentId).not.toBe('');
    proxy = await startProxy(apiUrl);

    const webPort = 3975 + Math.floor(Math.random() * 9);
    webUrl = `http://127.0.0.1:${String(webPort)}`;
    web = spawn(
      join(WEB_DIR, 'node_modules/.bin/next'),
      ['start', '-p', String(webPort), '--hostname', '127.0.0.1'],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          JUDGE_API_URL: proxy.url,
          // the web tier holds ONE server-side credential: the judge's. The browser never sees it.
          JUDGE_API_TOKEN: TEST_TOKENS.judge,
          NODE_OPTIONS: '',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: process.env['M7_WEB_LOG'] ? 'inherit' : 'ignore',
      },
    );
    await waitForHttp(`${webUrl}/`);
    browser = await chromium.launch(
      process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] }
        : {},
    );
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(20_000);
  });

  beforeEach((context) => {
    onTestFailed(async () => {
      const name = context.task.name.slice(0, 40).replace(/[^A-Za-z0-9]+/g, '-');
      await shot(`FAIL-${name}`).catch(() => undefined);
      const text = await page
        .locator('body')
        .innerText()
        .catch(() => '(no page)');
      process.stderr.write(
        `--- ${context.task.name}\nURL: ${page.url()}\n${text.slice(0, 2500)}\n`,
      );
    });
  });

  afterAll(async () => {
    await browser.close();
    web?.kill();
    await new Promise<void>((done) => {
      proxy.server.close(() => {
        done();
      });
    });
    await app.close();
    await testDb.close();
  });

  const answersOf = (rank: number) => page.getByTestId(`question-${String(rank)}-answers`);
  const typeAnswer = async (rank: number, text: string) =>
    page.getByTestId(`answer-form-${String(rank)}-text`).fill(text);
  const saveAnswer = async (rank: number) =>
    page
      .getByTestId(`answer-form-${String(rank)}`)
      .getByRole('button', { name: 'Save team answer' })
      .click();

  describe('Journey I: open a question, record the answer and a separate observation, reload', () => {
    let questionId = '';
    let answerId = '';
    const ANSWER = 'We sync over a mesh radio.\nLine two: <b>not bold</b> & "quoted" \u{1F642}';

    it('I1. the report offers Interview Mode once the questions are generated; the page shows every question with its evidence IN VIEW', async () => {
      await page.goto(`${webUrl}/projects/${projectId}/assessment`);
      await page.getByTestId('generate-questions').click();
      await page.getByTestId('questions-list').waitFor();
      await page.getByTestId('open-interview-mode').getByRole('link').click();
      await page.waitForURL(/\/interview\?/);
      const root = page.getByTestId('interview-page');
      expect(await root.getAttribute('data-state')).toBe('ready');
      expect(await root.getAttribute('data-can-record')).toBe('yes');
      const count = await page
        .locator('[data-testid^="interview-question-"][data-question-id]')
        .count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(5);
      for (let rank = 1; rank <= count; rank += 1) {
        const evidence = page.getByTestId(`interview-question-${String(rank)}-evidence`);
        // nothing a judge needs to understand the question sits in a collapsed element
        expect(await evidence.isVisible()).toBe(true);
        expect(
          await page.getByTestId(`interview-question-${String(rank)}-uncertainty`).isVisible(),
        ).toBe(true);
        expect((await evidence.innerText()).length).toBeGreaterThan(40);
        expect(await page.getByTestId(`answer-form-${String(rank)}`).isVisible()).toBe(true);
        expect(await page.getByTestId(`observation-form-${String(rank)}`).isVisible()).toBe(true);
      }
      const text = await root.innerText();
      expect(text).toContain('not a verified fact');
      expect(text).toMatch(/OFFLINE DEMONSTRATION/);
      questionId =
        (await page.getByTestId('interview-question-1').getAttribute('data-question-id')) ?? '';
      expect(questionId).not.toBe('');
      await shot('I1-interview-mode');
    });

    it('I2. typing the team’s answer and saving shows it at once, as typed, with who saved it and when, and empties the form', async () => {
      await typeAnswer(1, ANSWER);
      await saveAnswer(1);
      await page.getByTestId('answer-form-1-saved').waitFor();
      const saved = answersOf(1).locator('[data-testid="team-answer"]');
      expect(await saved.count()).toBe(1);
      answerId = (await saved.first().getAttribute('data-record-id')) ?? '';
      const shown = await saved.first().getByTestId('team-answer-text').innerText();
      expect(shown).toBe(ANSWER);
      // hostile-looking markup is text, not markup
      expect(await saved.first().locator('b').count()).toBe(0);
      expect(await saved.first().getByTestId('team-answer-meta').innerText()).toMatch(
        /^Saved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC by judge-1 \(judge\)$/,
      );
      expect(await page.getByTestId('answer-form-1-text').inputValue()).toBe('');
      await shot('I2-answer-saved');
    });

    it('I3. a separate observation of the live demonstration, linked to that answer, and a standalone one that could not be verified', async () => {
      const form = page.getByTestId('observation-form-1');
      await form.getByTestId('observation-form-1-subject').fill('Mesh sync demo');
      await form
        .getByTestId('observation-form-1-observed')
        .fill('Two devices exchanged a message with Wi-Fi switched off.');
      await form.getByTestId('observation-form-1-outcome-confirmed').check();
      await form.getByTestId('observation-form-1-answer').selectOption(answerId);
      await form.getByRole('button', { name: 'Save observation' }).click();
      await page.getByTestId('observation-form-1-saved').waitFor();
      const observed = page
        .getByTestId('question-1-observations')
        .locator('[data-testid="judge-observation"]');
      expect(await observed.count()).toBe(1);
      expect(await observed.first().getAttribute('data-outcome')).toBe('confirmed');
      expect(await observed.first().innerText()).toContain('about a recorded team answer');
      // the answer list is untouched: testimony and observation are different records in different lists
      expect(await answersOf(1).locator('[data-testid="team-answer"]').count()).toBe(1);

      const standalone = page.getByTestId('observation-form-standalone');
      await standalone.getByTestId('observation-form-standalone-subject').fill('Deployment');
      await standalone
        .getByTestId('observation-form-standalone-observed')
        .fill('The live deployment did not load during the visit.');
      await standalone.getByTestId('observation-form-standalone-outcome-unable_to_verify').check();
      await standalone.getByRole('button', { name: 'Save observation' }).click();
      await page.getByTestId('observation-form-standalone-saved').waitFor();
      const standaloneList = page
        .getByTestId('standalone-observations')
        .locator('[data-testid="judge-observation"]');
      expect(await standaloneList.count()).toBe(1);
      expect(await standaloneList.first().innerText()).toContain(
        'Nothing is inferred from this about the project.',
      );
      await shot('I3-observations-saved');
    });

    it('I4. after a reload the page shows exactly what was saved, and the API holds the same records, linked to the original question and answer', async () => {
      const lists = ['question-1-answers', 'question-1-observations', 'standalone-observations'];
      const before = await Promise.all(lists.map((id) => page.getByTestId(id).innerText()));
      await page.reload();
      const after = await Promise.all(lists.map((id) => page.getByTestId(id).innerText()));
      expect(after).toEqual(before);
      expect(await page.getByTestId('team-answer-text').first().innerText()).toBe(ANSWER);
      const stored = await records();
      expect(stored.teamAnswers).toHaveLength(1);
      expect(stored.judgeObservations).toHaveLength(2);
      const [a] = stored.teamAnswers;
      expect(a).toMatchObject({
        id: answerId,
        questionId,
        text: ANSWER,
        recordedBy: { subject: 'judge-1' },
        recordedAsRole: 'judge',
        isCurrent: true,
      });
      const linked = stored.judgeObservations.find((o) => o.teamAnswerId !== null);
      expect(linked).toMatchObject({ teamAnswerId: answerId, questionId, outcome: 'confirmed' });
      const standalone = stored.judgeObservations.find((o) => o.teamAnswerId === null);
      expect(standalone).toMatchObject({
        questionId: null,
        questionSetId: null,
        outcome: 'unable_to_verify',
      });
      // saving interview records created no assessment and no score: the assessment list is the one it was
      expect(
        (await api<AssessmentListResponse>(`/projects/${projectId}/assessments`)).assessments,
      ).toHaveLength(1);
      await shot('I4-after-reload');
    });

    it('I5. an empty save is refused with the rule and keeps what was typed; no record is created', async () => {
      const before = (await records()).teamAnswers.length;
      await saveAnswer(
        2 <= (await page.locator('[data-testid^="interview-question-"][data-question-id]').count())
          ? 2
          : 1,
      );
      const rank =
        2 <= (await page.locator('[data-testid^="interview-question-"][data-question-id]').count())
          ? 2
          : 1;
      await page.getByTestId(`answer-form-${String(rank)}-error`).waitFor();
      expect(await page.getByTestId(`answer-form-${String(rank)}-error`).innerText()).toBe(
        'The answer must not be empty',
      );
      // an observation without a chosen outcome: the rule is named and the typed text stays
      const form = page.getByTestId('observation-form-standalone');
      await form.getByTestId('observation-form-standalone-subject').fill('Kept subject');
      await form.getByTestId('observation-form-standalone-observed').fill('Kept observation text');
      await form.getByRole('button', { name: 'Save observation' }).click();
      await page.getByTestId('observation-form-standalone-error').waitFor();
      expect(await page.getByTestId('observation-form-standalone-error').innerText()).toBe(
        'Choose what the attempt showed',
      );
      expect(await form.getByTestId('observation-form-standalone-subject').inputValue()).toBe(
        'Kept subject',
      );
      expect(await form.getByTestId('observation-form-standalone-observed').inputValue()).toBe(
        'Kept observation text',
      );
      expect((await records()).teamAnswers.length).toBe(before);
      expect((await records()).judgeObservations).toHaveLength(2);
    });

    it('I6. a save whose answer is lost says it could not confirm, keeps the text, and saving again records it exactly once', async () => {
      await page.goto(interviewUrl());
      const text = 'An answer whose confirmation never arrived.';
      await typeAnswer(1, text);
      proxy.state.dropNextAnswerResponse = true;
      const postsBefore = proxy.state.answerPosts.length;
      await saveAnswer(1);
      await page.getByTestId('answer-form-1-error').waitFor();
      expect(await page.getByTestId('answer-form-1-error').innerText()).toMatch(
        /could not confirm whether this was saved/i,
      );
      // the request WAS processed; the judge was told the truth and nothing typed was lost
      expect(await page.getByTestId('answer-form-1-text').inputValue()).toBe(text);
      expect((await records()).teamAnswers.filter((a) => a.text === text)).toHaveLength(1);
      await saveAnswer(1);
      await page.getByTestId('answer-form-1-saved').waitFor();
      expect((await records()).teamAnswers.filter((a) => a.text === text)).toHaveLength(1);
      const posts = proxy.state.answerPosts.slice(postsBefore);
      expect(posts).toHaveLength(2);
      expect(posts[0]?.key).toBeDefined();
      expect(posts[1]?.key).toBe(posts[0]?.key);
      expect(posts.map((p) => p.status)).toEqual([201, 200]);
      await page.reload();
      expect(
        await answersOf(1).locator('[data-testid="team-answer"]', { hasText: text }).count(),
      ).toBe(1);
    });

    it('I7. a correction is a new record: the original stays, marked superseded, and the correction is marked as one', async () => {
      const original = answersOf(1)
        .locator('[data-testid="team-answer"][data-current="yes"]')
        .first();
      const originalId = (await original.getAttribute('data-record-id')) ?? '';
      const details = page.getByTestId(`correct-answer-${originalId}`);
      await details.locator('summary').click();
      await page
        .getByTestId(`correct-answer-form-${originalId}-text`)
        .fill('Corrected: the sync runs over Bluetooth mesh.');
      await details.getByRole('button', { name: 'Save correction' }).click();
      // the form of a superseded answer disappears with the re-render (only the newest record of a chain can be corrected): wait for the correction itself
      const fix = answersOf(1).locator('[data-testid="team-answer"]', {
        hasText: 'Corrected: the sync runs over Bluetooth mesh.',
      });
      await fix.waitFor();
      const marked = answersOf(1).locator(`[data-record-id="${originalId}"]`);
      expect(await marked.getAttribute('data-current')).toBe('no');
      expect(await marked.innerText()).toContain('Superseded by a later correction');
      expect(await fix.innerText()).toContain('Correction');
      const stored = await records();
      const chain = stored.teamAnswers.find((a) => a.supersedesAnswerId === originalId);
      expect(chain).toBeDefined();
      expect(stored.teamAnswers.find((a) => a.id === originalId)).toMatchObject({
        isCurrent: false,
        supersededByAnswerId: chain?.id,
      });
      await shot('I7-correction');
    });

    it('I8. a voided project keeps its interview history readable and offers no form and accepts no record', async () => {
      const before = await records();
      const voided = await fetch(`${apiUrl}/projects/${projectId}/void`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKENS.organizer}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ reason: 'The wrong submission was entered.' }),
      });
      expect(voided.status).toBe(201);
      await page.goto(interviewUrl());
      expect(await page.getByTestId('interview-page').getAttribute('data-can-record')).toBe('no');
      expect(await page.getByTestId('interview-read-only').innerText()).toMatch(/voided/);
      expect(await page.locator('form').count()).toBe(0);
      // the history is all still there
      expect(await page.locator('[data-testid="team-answer"]').count()).toBe(
        before.teamAnswers.length,
      );
      expect(await page.locator('[data-testid="judge-observation"]').count()).toBe(
        before.judgeObservations.length,
      );
      const refused = await fetch(
        `${apiUrl}/projects/${projectId}/assessments/${assessmentId}/judge-observations`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_TOKENS.judge}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({ subject: 's', observed: 'o', outcome: 'confirmed' }),
        },
      );
      expect(refused.status).toBe(409);
      expect((await records()).judgeObservations).toHaveLength(before.judgeObservations.length);
      await shot('I8-voided-history');
    });
  });

  describe('the journey itself', () => {
    it('never touched the interview tables or the browser storage directly: this file contains no SQL, no direct DOM writing and no browser storage', () => {
      const source = readFileSync(import.meta.filename, 'utf8');
      const forbidden = ['sql' + '`', '.execute' + '(', 'inner' + 'HTML', 'local' + 'Storage'];
      expect(forbidden.filter((needle) => source.includes(needle))).toEqual([]);
    });
  });
});
