/// <reference lib="dom" />
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from 'vitest';
import { openOfflineGate } from '../../apps/api/src/assessments/runtime-gate.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { EventContextService } from '../../apps/api/src/event-context/service.js';
import { EvidenceGraphService } from '../../apps/api/src/evidence-graph/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { QuestionService } from '../../apps/api/src/questions/service.js';
import { fakeVerifier, TEST_TOKENS } from '../../apps/api/src/testing/harness.js';
import { createAssessmentRuntime } from '../../apps/worker/src/assessment/runtime.js';
import { loadWorkerEnv } from '../../apps/worker/src/env.js';
import { TEST_MODELS } from '../../apps/worker/src/testing/assessment-world.js';
import {
  captureSetup,
  memoryLogger,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';
import { EvidenceGraphStore } from '../../packages/database/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';

/*
 * M6: REAL-BROWSER journeys through the Five Questions workflow, on the harness of the P6D journeys (tests/browser/p6d.browser.ts). Nothing is typed
 * as JSON, no identifier is ever shown or entered, and this file performs no database write of any kind (the last test checks its own source for that).
 *
 *   Journey C (a full event): create hackathon -> author an official rubric and rules in the STRUCTURED editor -> lock -> submit GitHub + Devpost -> the
 *     capture worker captures GitHub, the organizer supplies the Devpost text -> request the offline scripted report -> open its Five Questions section
 *     (nothing generated yet) -> generate -> read every question with its reason, the uncertainty it addresses and its evidence links -> reload: the
 *     same set, unchanged -> generate again: the stored set -> the assessment itself is byte-identical before and after.
 *   Journey D (insufficient evidence): the Devpost page cannot be fetched and nobody supplies it -> the report says an expected source is missing ->
 *     the questions ask about the missing material, never treat it as a weakness, and say why fewer than five were produced when they are.
 *   Journey E (isolation and honesty): the page never shows an answer field or a probability, labels the set an offline demonstration (never
 *     AI-generated), and a project with no assessment has no Five Questions section.
 *
 * Real: the web server (`next start` of the production build), the API routes over loopback, the SSRF-safe capture worker loop over the SYNTHETIC
 * fixture network, the assessment worker from its REAL runtime (ASSESSMENT_PROVIDER=scripted), and the real question service. Not real: the model
 * (none is called, nothing is spent), the network, and every text below, which is SYNTHETIC REGRESSION MATERIAL. Run with `pnpm test:browser`.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_DIR = join(ROOT, 'apps/web');
const SHOTS = process.env['BROWSER_SMOKE_SHOTS'] ?? join(tmpdir(), 'judge-m6-shots');
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const [, openDatabase] = testDatabaseTargets()[0] as [string, () => Promise<TestDatabase>];

const OFFICIAL = 'Official — stated in an official source I cite';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// -- Synthetic official-source texts (clearly labelled; written to look like the real thing) ----------------------------------------------
const RULES_TEXT = [
  'SYNTHETIC REGRESSION FIXTURE — NOT A REAL EVENT.',
  'Northwind Open Hackathon 2026 — Official Rules.',
  'Eligibility. Every project must be original work created during the event period. Teams have at most five members.',
  'Submission. Each team submits one public GitHub repository and one Devpost project page before the submission deadline.',
  'Prior work. Pre-existing libraries may be used if they are disclosed in the Devpost description.',
  'The event runs from 1 May 2026 09:00 UTC to 3 May 2026 18:00 UTC. Judging starts on 4 May 2026 09:00 UTC.',
].join('\n');
const RUBRIC_TEXT = [
  'SYNTHETIC REGRESSION FIXTURE — NOT A REAL EVENT.',
  'Northwind Open Hackathon 2026 — Official Judging Criteria (score each from 1 to 5).',
  'Innovation (40%): how new and thoughtful the idea is. 1 = a copy of an existing product; 5 = a genuinely new approach.',
  'Execution (35%): how completely and carefully the project is built.',
  'Impact (25%): how many people could benefit and how much.',
].join('\n');
const DEVPOST_TEXT = [
  'SYNTHETIC REGRESSION TEXT — NOT A REAL DEVPOST SUBMISSION.',
  'Atlas provides offline maps for disaster responders. The team claims it syncs over mesh radio and was built during the event.',
].join('\n');

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

const checkoutState = (): string =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

describe('M6 real-browser journeys: Five Questions from a verified preliminary report', () => {
  const checkoutBefore = checkoutState();
  let testDb: TestDatabase;
  let app: ApiApp;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let page: Page;
  let webUrl = '';
  let apiUrl = '';
  let stopWorkers: () => Promise<void> = () => Promise.resolve();

  const shot = async (name: string) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };
  /** The Five Questions section alone, so a reviewer sees what the judge sees without scrolling a long report. */
  const shotQuestions = async (name: string) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.getByTestId('five-questions').screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const main = async () => page.locator('main').innerText();
  const api = async <T = Record<string, unknown>>(path: string) =>
    (await (
      await fetch(`${apiUrl}${path}`, {
        headers: { authorization: `Bearer ${TEST_TOKENS.organizer}` },
      })
    ).json()) as T;

  /** Reloads until `check` holds on the page text (the capture page refreshes itself, the report page does not). */
  const reloadUntil = async (check: (text: string) => boolean, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const text = await main();
      if (check(text)) return text;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}; the page says:\n${text.slice(0, 1500)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 700));
      await page.reload();
    }
  };

  // -- UI helpers (organizer actions) ---------------------------------------------------------------------------------------------------
  async function createEvent(name: string): Promise<string> {
    await page.goto(`${webUrl}/`);
    await page.getByLabel('Name', { exact: false }).first().fill(name);
    await page
      .getByLabel('Slug', { exact: false })
      .fill(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    await page.getByRole('button', { name: 'Create event' }).click();
    await page.waitForURL(/\/events\/[0-9a-f-]+$/);
    return /events\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  }
  async function newDraft(): Promise<string> {
    await page.getByRole('button', { name: 'Create draft version' }).click();
    await page.waitForURL(/\/versions\/[0-9a-f-]+$/);
    return /versions\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  }
  async function addSource(title: string, authority: string, text: string) {
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Authority').selectOption(authority);
    await page.getByLabel('Normalized text').fill(text);
    await page.getByRole('button', { name: 'Add source' }).click();
    await page.getByText(title).first().waitFor();
  }
  const openEditor = async () => {
    await page.getByTestId('edit-context-link').click();
    await page.waitForURL(/\/edit$/);
    await page.getByRole('heading', { name: /Edit Event Context/ }).waitFor();
  };
  const saveDraft = async () => {
    await page.getByRole('button', { name: 'Save draft' }).click();
  };
  /** Ticks a source in the picker inside `scope` (the picker lists sources by their TITLE, never by an identifier). */
  const pick = async (scope: Locator, title: string) =>
    scope.getByLabel(new RegExp(`^\\s*${title}`)).check();
  const dateBox = (label: string) =>
    page
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: label }) })
      .first();

  async function fillDate(label: string, value: string, sourceTitle: string) {
    const box = dateBox(label);
    await box.getByLabel('Date and time (UTC)').fill(value);
    await box.getByLabel('What kind of statement is this?').selectOption({ label: OFFICIAL });
    await pick(box, sourceTitle);
  }
  async function addRule(index: number, text: string, basis: string, sourceTitle: string | null) {
    await page.getByRole('button', { name: 'Add a rule' }).click();
    const card = page.getByTestId(`rules-${String(index)}`);
    await card.getByLabel(/^Rule \d+/).fill(text);
    await card.getByLabel('What kind of statement is this?').selectOption({ label: basis });
    if (sourceTitle) await pick(card, sourceTitle);
  }
  async function addCriterion(
    rubric: Locator,
    index: number,
    name: string,
    weight: string,
    description = '',
  ) {
    if (index > 0) await rubric.getByRole('button', { name: 'Add a criterion' }).click();
    const card = page.getByTestId(`criterion-0-${String(index)}`);
    await card.getByLabel(new RegExp(`^Criterion ${String(index + 1)} name`)).fill(name);
    if (description) await card.getByLabel('What it measures (optional)').fill(description);
    await card.getByLabel(/^Weight in percent/).fill(weight);
  }

  /** The judge side: submit, capture, request the report. */
  async function submitProject(
    eventId: string,
    github: string,
    devpost: string,
    tracks: string[] = [],
  ) {
    await page.goto(`${webUrl}/events/${eventId}/submit`);
    await page.getByLabel('GitHub repository URL').fill(github);
    await page.getByLabel('Devpost project URL').fill(devpost);
    for (const track of tracks)
      await page.getByTestId(`track-option-${track}`).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.waitForURL(/\/projects\/([0-9a-f-]+)\/capture/);
    return /projects\/([0-9a-f-]+)\/capture/.exec(page.url())?.[1] ?? '';
  }
  const requestReport = async (projectId: string) => {
    await page.goto(`${webUrl}/projects/${projectId}/assessment`);
    await page.getByRole('button', { name: 'Run assessment' }).first().click();
  };

  beforeAll(async () => {
    if (!existsSync(join(WEB_DIR, '.next/BUILD_ID'))) {
      throw new Error(
        'apps/web has no production build: run `pnpm test:browser` (it builds first).',
      );
    }
    testDb = await openDatabase();
    const db = testDb.db;
    // the API's assessment runtime comes from its REAL gate, exactly as `main.ts` builds it
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
      // no extractor, as in a real deployment without a model: the organizer authors the context by hand
      eventContext: new EventContextService({ db, extractor: null }),
      projects: new ProjectService({ db }),
      evidenceGraph: new EvidenceGraphService({ store: new EvidenceGraphStore({ db }) }),
      assessments: new AssessmentService({ db, offline: gate.runtime }),
      questions: new QuestionService({ db, offline: gate.runtime }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apiUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;

    // the capture worker: the production adapters over the synthetic fixture network, running continuously
    const capture = await captureSetup(db);
    capture.loop.start();
    // the assessment worker: its real runtime, from a real environment (ASSESSMENT_PROVIDER=scripted, NODE_ENV set explicitly), running continuously
    const workerEnv = loadWorkerEnv({
      NODE_ENV: 'test',
      ASSESSMENT_PROVIDER: 'scripted',
      ASSESSMENT_POLL_INTERVAL_MS: '100',
    });
    const assessments = await createAssessmentRuntime({
      db,
      env: workerEnv,
      logger: memoryLogger().logger,
    });
    if (!assessments) throw new Error('the scripted runtime was not built');
    assessments.start();
    stopWorkers = async () => {
      await capture.loop.stop();
      await assessments.stop();
    };

    const webPort = 3960 + Math.floor(Math.random() * 9);
    webUrl = `http://127.0.0.1:${String(webPort)}`;
    web = spawn(
      join(WEB_DIR, 'node_modules/.bin/next'),
      ['start', '-p', String(webPort), '--hostname', '127.0.0.1'],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          JUDGE_API_URL: apiUrl,
          JUDGE_API_TOKEN: TEST_TOKENS.organizer,
          NODE_OPTIONS: '',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: 'ignore',
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

  // a failing step leaves a screenshot and the page text behind: a journey that fails must be diagnosable without re-running it
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
    await stopWorkers();
    await app.close();
    await testDb.close();
  });

  // ================================================================================================================================

  // ================================================================================================================================
  describe('Journey C: a full event, from the editor to five explained questions', () => {
    let eventId = '';
    let projectId = '';
    let assessmentId = '';
    let firstSetText = '';
    let setId = '';
    let assessmentBefore = '';

    it('C1. the organizer authors an official rubric and rules in the editor and locks the version', async () => {
      eventId = await createEvent('Northwind Open Hackathon C');
      await newDraft();
      await addSource('Official rules', 'official_event_rules', RULES_TEXT);
      await addSource('Official judging criteria', 'official_judging_rubric', RUBRIC_TEXT);
      await openEditor();
      await fillDate('Event starts', '2026-05-01T09:00', 'Official rules');
      await fillDate('Event ends', '2026-05-03T18:00', 'Official rules');
      await fillDate('Judging starts', '2026-05-04T09:00', 'Official rules');
      await page.getByRole('button', { name: 'Add the overall judging rubric' }).click();
      const rubric = page.getByTestId('rubric-0');
      await rubric.getByLabel('Rubric name').fill('Official judging criteria');
      await rubric.getByLabel('Lowest score').fill('1');
      await rubric.getByLabel('Highest score').fill('5');
      await pick(rubric, 'Official judging criteria');
      await addCriterion(rubric, 0, 'Innovation', '40', 'How new and thoughtful the idea is.');
      await addCriterion(rubric, 1, 'Execution', '35', 'How completely the project is built.');
      await addCriterion(rubric, 2, 'Impact', '25', 'How many people could benefit.');
      await addRule(
        0,
        'Every project must be original work created during the event.',
        OFFICIAL,
        'Official rules',
      );
      await page.getByRole('button', { name: 'Add a requirement' }).click();
      const requirement = page.getByTestId('requirement-0');
      await requirement
        .getByLabel(/^Requirement 1/)
        .fill('Each team submits one public GitHub repository and one Devpost page.');
      await pick(requirement, 'Official rules');
      await saveDraft();
      await page.waitForURL(/\/versions\/[0-9a-f-]+$/);
      expect(await main()).not.toMatch(/Cannot lock yet/);
      await page.getByRole('button', { name: 'Lock context' }).click();
      await page
        .getByText(/LOCKED/)
        .first()
        .waitFor();
    });

    it('C2. submit and capture; the organizer supplies the Devpost text; the scripted report is requested', async () => {
      projectId = await submitProject(
        eventId,
        'https://github.com/synthetic/atlas',
        'https://devpost.com/software/team-not-in-fixtures',
      );
      await reloadUntil(
        (t) =>
          /CAPTURED/.test(t) &&
          /CAPTURE FAILED/.test(t) &&
          !/WAITING FOR THE CAPTURE WORKER/.test(t),
        'both captures to settle',
      );
      await page.getByTestId('supply-content').locator('summary').click();
      await page.getByLabel('Submission text').fill(DEVPOST_TEXT);
      await page.getByRole('button', { name: 'Store this text' }).click();
      await page.getByText('TEXT SUPPLIED BY AN ORGANIZER').waitFor();
      await requestReport(projectId);
      await reloadUntil((t) => /NOT AN AI ASSESSMENT/.test(t), 'the scripted report');
      const list = await api<{ assessments: { id: string }[] }>(
        `/projects/${projectId}/assessments`,
      );
      assessmentId = list.assessments[0]?.id ?? '';
      expect(assessmentId).not.toBe('');
      assessmentBefore = JSON.stringify(
        await api(`/projects/${projectId}/assessments/${assessmentId}`),
      );
      await shot('C2-report');
    });

    it('C3. the Five Questions section is there, says nothing has been generated, and offers one button and no answer field', async () => {
      const text = await main();
      expect(text).toContain('Five Questions');
      expect(text).toContain('No questions have been generated for this version yet.');
      expect(text).toMatch(/OFFLINE DEMONSTRATION/);
      const section = page.getByTestId('five-questions');
      expect(await section.locator('textarea, select, input[type="text"]').count()).toBe(0);
      expect(await section.getByRole('button').count()).toBe(1);
      expect(await section.innerText()).not.toMatch(/\d+ ?%|probab|score of/i);
      await shot('C3-before-generating');
      await shotQuestions('C3-section-before-generating');
    });

    it('C4. generating shows a labelled demonstration set: every question with its reason, the uncertainty it addresses and its evidence links', async () => {
      await page.getByTestId('generate-questions').click();
      await page.getByTestId('questions-list').waitFor();
      const section = page.getByTestId('five-questions');
      const text = await section.innerText();
      // honest labelling: an offline demonstration, never AI-generated, never a model's wording
      expect(text).toMatch(/OFFLINE DEMONSTRATION — NOT AI-GENERATED/);
      await page.getByTestId('questions-demonstration-banner').waitFor();
      expect(text).not.toMatch(/generated by (an )?AI|AI-written|model-written/i);

      const count = await page.locator('[data-testid^="question-"][data-rank]').count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(5);
      for (let rank = 1; rank <= count; rank += 1) {
        const card = page.getByTestId(`question-${String(rank)}`);
        const cardText = await card.innerText();
        expect(cardText).toContain(`Question ${String(rank)}`);
        expect(
          (await page.getByTestId(`question-${String(rank)}-text`).innerText()).trim().length,
        ).toBeGreaterThan(20);
        expect(cardText).toContain('Why it matters');
        expect(cardText).toContain('Uncertainty it addresses');
        expect(cardText).toContain('What would settle it');
        expect(await page.getByTestId(`question-${String(rank)}-reason`).innerText()).toMatch(
          /\S{3}/,
        );
        // no identifier ever reaches the judge
        expect(cardText).not.toMatch(UUID);
        expect(cardText).not.toMatch(/opp-[0-9a-f]{16}|cand-[0-9a-f]{16}|O-\d{3}/);
      }
      if (count < 5) {
        // fewer than five: the page says why, and gives the manual path; nothing is padded
        const shortfall = page.getByTestId('questions-shortfall');
        await shortfall.waitFor();
        expect(await shortfall.innerText()).toMatch(/Why fewer than five/);
        expect(await shortfall.innerText()).toMatch(/Nothing was added to fill the list/);
        await page.getByTestId('questions-uncertainties').waitFor();
      } else {
        expect(await page.getByTestId('questions-shortfall').count()).toBe(0);
      }
      // the scripted demonstration produces a question per distinct uncertainty; each one is tied to a criterion or to a stated reason
      expect(text).toMatch(/Innovation|Execution|Impact|implementation|material|requirements/);
      firstSetText = await page.getByTestId('questions-list').innerText();
      const sets = await api<{ sets: { id: string }[] }>(
        `/projects/${projectId}/assessments/${assessmentId}/question-sets`,
      );
      expect(sets.sets).toHaveLength(1);
      setId = sets.sets[0]?.id ?? '';
      await shot('C4-five-questions');
      await shotQuestions('C4-five-questions-section');
    });

    it('C5. reloading shows the same set; generating again returns the stored set; the assessment is untouched', async () => {
      await page.reload();
      expect(await page.getByTestId('questions-list').innerText()).toBe(firstSetText);
      // the page offers no second generate button once a set exists
      expect(await page.getByTestId('generate-questions').count()).toBe(0);
      // the API's idempotent POST returns the same set
      const again = await fetch(
        `${apiUrl}/projects/${projectId}/assessments/${assessmentId}/question-sets`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_TOKENS.organizer}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
      );
      expect(again.status).toBe(200);
      const body = (await again.json()) as { result: string; set: { id: string } };
      expect(body.result).toBe('already_generated');
      expect(body.set.id).toBe(setId);
      expect(JSON.stringify(await api(`/projects/${projectId}/assessments/${assessmentId}`))).toBe(
        assessmentBefore,
      );
      // the report page still shows the same scores (the questions changed nothing)
      expect(await main()).toMatch(/NOT AN AI ASSESSMENT/);
      await shot('C5-reloaded');
    });
  });

  // ================================================================================================================================
  describe('Journey D: missing material is asked about, never scored against', () => {
    let projectId = '';

    it('D1. a project whose Devpost page cannot be fetched (and is not supplied) still gets a report that says so', async () => {
      const eventId = /events\/([0-9a-f-]+)/.exec(
        await (async () => {
          await page.goto(`${webUrl}/`);
          const href = await page
            .getByRole('link', { name: /Northwind Open Hackathon C/ })
            .first()
            .getAttribute('href');
          return href ?? '';
        })(),
      )?.[1];
      expect(eventId).toBeTruthy();
      projectId = await submitProject(
        eventId ?? '',
        'https://github.com/synthetic/moving',
        'https://devpost.com/software/team-not-in-fixtures-2',
      );
      await reloadUntil(
        (t) =>
          /CAPTURED/.test(t) &&
          /CAPTURE FAILED/.test(t) &&
          !/WAITING FOR THE CAPTURE WORKER/.test(t),
        'both captures to settle',
      );
      await requestReport(projectId);
      const text = await reloadUntil((t) => /NOT AN AI ASSESSMENT/.test(t), 'the scripted report');
      expect(text).toMatch(/EXPECTED SOURCE MISSING/);
      await shot('D1-report');
    });

    it('D2. the questions ask about the missing material and say it is unknown, not weak', async () => {
      await page.getByTestId('generate-questions').click();
      await page.getByTestId('questions-list').waitFor();
      const section = await page.getByTestId('five-questions').innerText();
      expect(section).toMatch(/Expected material not captured/);
      expect(section).toMatch(/missing evidence, not a finding about the project/);
      expect(section).not.toMatch(/failed to provide|did not provide|poor|weak project|lacking/i);
      const count = await page.locator('[data-testid^="question-"][data-rank]').count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(5);
      await shot('D2-missing-source-questions');
      await shotQuestions('D2-missing-source-section');
    });
  });

  // ================================================================================================================================
  describe('Journey E: no assessment, no questions', () => {
    it('E1. a project with no assessment has no Five Questions section and no generate button', async () => {
      const eventHref = await (async () => {
        await page.goto(`${webUrl}/`);
        return (
          (await page
            .getByRole('link', { name: /Northwind Open Hackathon C/ })
            .first()
            .getAttribute('href')) ?? ''
        );
      })();
      const eventId = /events\/([0-9a-f-]+)/.exec(eventHref)?.[1] ?? '';
      const fresh = await submitProject(
        eventId,
        'https://github.com/synthetic/oversized',
        'https://devpost.com/software/team-not-in-fixtures-3',
      );
      await page.goto(`${webUrl}/projects/${fresh}/assessment`);
      const text = await main();
      expect(text).toContain('No assessment has been requested for this project yet.');
      expect(text).not.toContain('Five Questions');
      expect(await page.getByTestId('generate-questions').count()).toBe(0);
    });
  });

  // ================================================================================================================================
  describe('the journeys themselves', () => {
    it('performed no database write and edited no JSON: this file contains neither, and it left the checkout exactly as it found it', () => {
      const source = readFileSync(import.meta.filename, 'utf8');
      const write = ['\\.(insert|update|delete)\\(', '\\.execute\\(', 'sql`', 'edit/advanced'].join(
        '|',
      );
      // the pattern is assembled from parts so that this very test does not match itself
      const hits = source
        .split('\n')
        .filter((line) => new RegExp(write).test(line) && !line.includes('const write'));
      expect(hits).toEqual([]);
      expect(checkoutState()).toBe(checkoutBefore);
    });
  });
});
