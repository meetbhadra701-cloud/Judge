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
 * P6D: two complete REAL-BROWSER journeys through the screens an organizer and a judge actually use. Nothing is typed as JSON, no identifier is
 * ever shown or entered, and this file performs no database write of any kind (the last test checks its own source for that).
 *
 *   Journey A (event with global rules):
 *     create hackathon -> add its official sources -> author the rubric, rules, requirements and dates in the STRUCTURED editor (a deliberate
 *     mistake first: the form explains it) -> review -> lock -> submit GitHub + Devpost -> the capture worker captures GitHub (exact commit),
 *     Devpost cannot be fetched -> the organizer supplies its text -> request the offline scripted report -> read it.
 *   Journey B (event whose reference material is track-specific):
 *     create hackathon -> author tracks, a track requirement, a track rubric and the overall rubric (NO event-wide rule) -> lock -> submit on the
 *     NORMAL submit page with the track selector (first without a track, to see the real refusal and its remedy, then void-and-replace with the
 *     track) -> capture -> request the scripted report -> read it.
 *
 * Real: the web server (`next start` of the production build), the API routes over loopback, the SSRF-safe capture worker loop with the production
 * adapters over the SYNTHETIC fixture network, and the assessment worker built from its REAL runtime (`loadWorkerEnv` + `createAssessmentRuntime`
 * with ASSESSMENT_PROVIDER=scripted), both running continuously as separate loops. Not real: the model (none is called, nothing is spent), the
 * network (a synthetic fixture world; no socket leaves the machine), and every text below, which is SYNTHETIC REGRESSION MATERIAL: these journeys
 * demonstrate the interface and say nothing about a real event or a real project. Run with `pnpm test:browser`.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_DIR = join(ROOT, 'apps/web');
const SHOTS = process.env['BROWSER_SMOKE_SHOTS'] ?? join(tmpdir(), 'judge-p6d-shots');
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const [, openDatabase] = testDatabaseTargets()[0] as [string, () => Promise<TestDatabase>];

const OFFICIAL = 'Official — stated in an official source I cite';
const INTERPRETATION = 'Organizer’s interpretation — my reading of the sources';
const UNVERIFIED = 'Unverified note — not confirmed by any source';
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
const NOTES_TEXT = [
  'SYNTHETIC REGRESSION FIXTURE — NOT A REAL EVENT.',
  'Organizer notes to judges: please be generous with first-time hackers.',
].join('\n');
const TRACK_RULES_TEXT = [
  'SYNTHETIC REGRESSION FIXTURE — NOT A REAL EVENT.',
  'Northwind Open Hackathon 2026 — Track Rules.',
  'Health & Care track: projects must improve health outcomes. Health entrants must name a clinical advisor.',
  'Climate track: projects must reduce or measure emissions. Climate entrants must cite their data source.',
  'Sponsor challenge (Health & Care): the sponsor judges this track with the Health rubric below.',
].join('\n');
const HEALTH_RUBRIC_TEXT = [
  'SYNTHETIC REGRESSION FIXTURE — NOT A REAL EVENT.',
  'Health & Care track criteria (score each from 0 to 10): Clinical relevance. Safety.',
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

describe('P6D real-event journeys: structured Event Context editor, track selection, scripted report', () => {
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
  const section = (heading: RegExp) =>
    page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });
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
  describe('Journey A: an event with global rules', () => {
    let eventId = '';
    let versionId = '';
    let projectId = '';

    it('A1. the organizer creates the hackathon and adds its official sources', async () => {
      eventId = await createEvent('Northwind Open Hackathon A');
      versionId = await newDraft();
      await addSource('Official rules', 'official_event_rules', RULES_TEXT);
      await addSource('Official judging criteria', 'official_judging_rubric', RUBRIC_TEXT);
      await addSource('Organizer notes', 'organizer_guidance', NOTES_TEXT);
      // with no extractor the page says so plainly and offers the editor as the normal way
      expect(await main()).toContain('Edit Event Context');
      await shot('A1-sources');
    });

    it('A2. the structured editor: forms for everything, no JSON, no identifiers, and a clear explanation of a mistake', async () => {
      await openEditor();
      const text = await main();
      expect(text).not.toMatch(/JSON/);
      expect(text).not.toMatch(UUID);
      // the sources are listed by title and authority
      expect(text).toContain('Official rules · official_event_rules');

      // dates (UTC), each marked official and tied to the source it comes from
      await fillDate('Event starts', '2026-05-01T09:00', 'Official rules');
      await fillDate('Event ends', '2026-05-03T18:00', 'Official rules');
      await fillDate('Judging starts', '2026-05-04T09:00', 'Official rules');
      await page
        .getByLabel('Statement', { exact: true })
        .first()
        .fill('Projects are judged in two rounds at the venue.');
      await pick(
        section(/Dates and how judging works/)
          .locator('fieldset')
          .last(),
        'Official rules',
      );

      // the rubric: criteria, weights, scale and a scoring guide, tied to the official rubric source
      await page.getByRole('button', { name: 'Add the overall judging rubric' }).click();
      const rubric = page.getByTestId('rubric-0');
      await rubric.getByLabel('Rubric name').fill('Official judging criteria');
      await rubric.getByLabel('Lowest score').fill('1');
      await rubric.getByLabel('Highest score').fill('5');
      await pick(rubric, 'Official judging criteria');
      await addCriterion(rubric, 0, 'Innovation', '40', 'How new and thoughtful the idea is.');
      await page.getByTestId('criterion-0-0').getByText('Scoring guide (optional)').click();
      await page
        .getByTestId('criterion-0-0')
        .getByRole('button', { name: 'Add a scoring-guide row' })
        .click();
      await page.getByTestId('criterion-0-0').getByLabel('Score', { exact: true }).fill('1');
      await page
        .getByTestId('criterion-0-0')
        .getByLabel('What this score means')
        .fill('A copy of an existing product.');
      await addCriterion(rubric, 1, 'Execution', '35', 'How completely the project is built.');
      // a deliberate mistake: the weights add up to 95 %
      await addCriterion(rubric, 2, 'Impact', '20', 'How many people could benefit.');
      expect(await page.getByTestId('weight-total-0').innerText()).toMatch(
        /95 % of 100 %.*must total 100 %/,
      );

      // event rules: one official (cites the rules), one the organizer's own reading, one unverified note
      await addRule(
        0,
        'Every project must be original work created during the event.',
        OFFICIAL,
        'Official rules',
      );
      await addRule(1, 'Teams have at most five members.', INTERPRETATION, 'Official rules');
      await addRule(2, 'Judges may also weigh polish.', UNVERIFIED, null);
      // a requirement for every project
      await page.getByRole('button', { name: 'Add a requirement' }).click();
      const requirement = page.getByTestId('requirement-0');
      await requirement
        .getByLabel(/^Requirement 1/)
        .fill('Each team submits one public GitHub repository and one Devpost page.');
      await pick(requirement, 'Official rules');
      // prior-work policy
      await section(/Prior-work policy/)
        .getByLabel('Statement', { exact: true })
        .fill('Pre-existing libraries may be used if disclosed.');
      await section(/Prior-work policy/)
        .getByLabel('What kind of statement is this?')
        .selectOption({ label: OFFICIAL });
      await section(/Prior-work policy/)
        .getByLabel('Policy')
        .selectOption('allowed_with_disclosure');
      await pick(section(/Prior-work policy/), 'Official rules');
      // organizer guidance: never offered as official
      await page.getByRole('button', { name: 'Add guidance' }).click();
      const guidance = page.getByTestId('guidance-0');
      await guidance.getByLabel(/^Guidance 1/).fill('Please be generous with first-time hackers.');
      expect(
        await guidance
          .getByLabel('What kind of statement is this?')
          .locator('option')
          .allInnerTexts(),
      ).not.toContain(OFFICIAL);

      // an assumption cannot be promoted: marking the unverified note official without a source is refused, in words, next to the field
      await page
        .getByTestId('rules-2')
        .getByLabel('What kind of statement is this?')
        .selectOption({ label: OFFICIAL });
      await saveDraft();
      await page.getByTestId('editor-issues').waitFor();
      expect(await page.getByTestId('editor-issues').innerText()).toMatch(
        /Nothing is treated as official without a source/,
      );
      expect(page.url()).toMatch(/\/edit$/); // nothing was saved
      await shot('A2-editor-issue');
      await page
        .getByTestId('rules-2')
        .getByLabel('What kind of statement is this?')
        .selectOption({ label: UNVERIFIED });
      await saveDraft();
      // the draft is saved (weights that do not total 100 % can be saved but not locked): back on the review page
      await page.waitForURL(/\/versions\/[0-9a-f-]+$/);
      await shot('A2-review-cannot-lock');
    });

    it('A3. the review says what is official, what is interpretation and what is unverified, and explains why the version cannot be locked yet', async () => {
      const text = await main();
      expect(text).toMatch(/Cannot lock yet/);
      expect(text).toMatch(
        /weights add up to 95 %, but an official rubric’s weights must total exactly 100 %/,
      );
      expect(text).not.toMatch(/INVALID_RUBRIC_WEIGHTS|rubrics\[0\]|tolerance/); // no codes, paths or jargon
      expect(await page.getByRole('button', { name: 'Lock context' }).isDisabled()).toBe(true);
      expect(text).toContain('Official');
      expect(text).toContain('Organizer’s interpretation');
      expect(text).toContain('Unverified note');
      // fix the weight in the editor and save again
      await openEditor();
      await page
        .getByTestId('criterion-0-2')
        .getByLabel(/^Weight in percent/)
        .fill('25');
      expect(await page.getByTestId('weight-total-0').innerText()).toContain('100 % of 100 %');
      await saveDraft();
      await page.waitForURL(/\/versions\/[0-9a-f-]+$/);
      expect(await main()).not.toMatch(/Cannot lock yet/);
    });

    it('A4. the organizer locks the version; a locked version cannot be edited', async () => {
      await page.getByRole('button', { name: 'Lock context' }).click();
      await page
        .getByText(/LOCKED/)
        .first()
        .waitFor();
      expect(await main()).toMatch(/This version is immutable/);
      await page.goto(`${webUrl}/events/${eventId}/versions/${versionId}/edit`);
      expect(await main()).toMatch(/is locked and cannot be edited/);
      await shot('A4-locked');
    });

    it('A5. submit GitHub + Devpost (no track section: the event has no tracks); GitHub is captured at an exact commit, Devpost cannot be fetched', async () => {
      projectId = await submitProject(
        eventId,
        'https://github.com/synthetic/atlas',
        'https://devpost.com/software/team-not-in-fixtures',
      );
      const text = await reloadUntil(
        (t) =>
          /CAPTURED/.test(t) &&
          /CAPTURE FAILED/.test(t) &&
          !/WAITING FOR THE CAPTURE WORKER/.test(t),
        'both captures to settle',
      );
      expect(text).toMatch(/Exact commit [0-9a-f]{40}/);
      expect(text).toMatch(/Devpost[\s\S]*CAPTURE FAILED/);
      expect(text).toMatch(/1 of 2 sources have stored content/);
      await shot('A5-captured');
    });

    it('A6. the organizer supplies the Devpost text; it is labelled as supplied, never as fetched', async () => {
      await page.getByTestId('supply-content').locator('summary').click();
      await page.getByLabel('Submission text').fill(DEVPOST_TEXT);
      await page.getByRole('button', { name: 'Store this text' }).click();
      await page.getByText('TEXT SUPPLIED BY AN ORGANIZER').waitFor();
      const text = await main();
      expect(text).toContain('NOT fetched from the source');
      expect(text).toMatch(
        /2 of 2 sources have stored content: 1 captured from the source, 1 typed or pasted by an organizer/,
      );
      await shot('A6-supplied');
    });

    it('A7. the scripted report: labelled as a demonstration from its first line, with no model, no spend and an honest account of the evidence', async () => {
      await page.goto(`${webUrl}/projects/${projectId}/assessment`);
      expect(await main()).toMatch(/Offline demonstration, not an AI estimate/);
      await requestReport(projectId);
      const text = await reloadUntil((t) => /NOT AN AI ASSESSMENT/.test(t), 'the scripted report');
      // the lead line, the banner and the labels never claim an AI produced anything
      expect(text).not.toMatch(/AI estimate from the submitted material/);
      expect(text).toMatch(/Offline demonstration, not an AI estimate/);
      expect(text).toContain('SCRIPTED DEMONSTRATION');
      expect(text).toMatch(/fixed placeholder value \(no assessor, no model\)/);
      expect(text).not.toMatch(/scored by the assessor/);
      expect(text).toMatch(/placeholder citation/);
      // the rubric is the organizer's own: criteria and scale come from what was entered in the editor
      expect(text).toMatch(/Innovation/);
      expect(text).toMatch(/Execution/);
      expect(text).toMatch(/Impact/);
      expect(text).toMatch(/3\.8 on the rubric’s scale of 1 to 5/);
      // accounting: nothing was spent, and the counters are not presented as usage
      expect(text).toMatch(/0 provider calls, no tokens, no cost/);
      expect(text).not.toMatch(/\$\d/);
      expect(text).not.toMatch(/\d+ input \/ \d+ output tokens/);
      // provenance: the supplied Devpost text is a team claim, listed as supplied
      expect(text).toContain('organizer_supplied_source');
      await shot('A7-report');

      // the API agrees with the page: no cost, no provider call
      const list = await api<{ assessments: { id: string }[] }>(
        `/projects/${projectId}/assessments`,
      );
      const detail = await api(`/projects/${projectId}/assessments/${list.assessments[0]?.id}`);
      expect(detail['usage']).toMatchObject({
        basis: 'simulated',
        providerCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 0,
      });
      expect(detail['providerMode']).toBe('scripted');
    });
  });

  // ================================================================================================================================
  describe('Journey B: an event whose reference material is track-specific', () => {
    let eventId = '';
    let firstProjectId = '';
    let projectId = '';

    it('B1. the organizer authors tracks, a track requirement, a track rubric and the overall rubric, with NO event-wide rule, and locks it', async () => {
      eventId = await createEvent('Northwind Open Hackathon B');
      await newDraft();
      await addSource('Official judging criteria', 'official_judging_rubric', RUBRIC_TEXT);
      await addSource('Official track rules', 'official_track_rules', TRACK_RULES_TEXT);
      await addSource('Health track criteria', 'official_judging_rubric', HEALTH_RUBRIC_TEXT);
      await openEditor();

      // tracks (a sponsor challenge is a track with its own requirement and rubric)
      for (const [i, name] of ['Health & Care', 'Climate'].entries()) {
        await page.getByRole('button', { name: 'Add a track', exact: true }).click();
        const track = page.getByTestId(`track-${String(i)}`);
        await track.getByLabel('Track name').fill(name);
        await pick(track, 'Official track rules');
      }
      // the overall rubric
      await page.getByRole('button', { name: 'Add the overall judging rubric' }).click();
      const overall = page.getByTestId('rubric-0');
      await overall.getByLabel('Rubric name').fill('Official judging criteria');
      await overall.getByLabel('Lowest score').fill('1');
      await overall.getByLabel('Highest score').fill('5');
      await pick(overall, 'Official judging criteria');
      await addCriterion(overall, 0, 'Innovation', '40');
      await addCriterion(overall, 1, 'Execution', '35');
      await addCriterion(overall, 2, 'Impact', '25');
      // the Health track rubric (not assessed in this version, and the page says so)
      await page.getByRole('button', { name: 'Add a track rubric' }).click();
      const health = page.getByTestId('rubric-1');
      await health.locator('select').first().selectOption({ label: 'Health & Care' }); // the track chooser is the first control of a track rubric
      await health.getByLabel('Rubric name').fill('Health & Care criteria');
      await health.getByLabel('Lowest score').fill('0');
      await health.getByLabel('Highest score').fill('10');
      await pick(health, 'Health track criteria');
      await page
        .getByTestId('criterion-1-0')
        .getByLabel(/^Criterion 1 name/)
        .fill('Clinical relevance');
      // a requirement that belongs to the Health track only
      await page.getByRole('button', { name: 'Add a requirement' }).click();
      const requirement = page.getByTestId('requirement-0');
      await requirement
        .getByLabel(/^Requirement 1/)
        .fill('Health entrants must name a clinical advisor.');
      await pick(requirement, 'Official track rules');
      await requirement
        .getByLabel('Applies to')
        .selectOption({ label: 'Only the track: Health & Care' });
      await shot('B1-editor');
      await saveDraft();
      await page.waitForURL(/\/versions\/[0-9a-f-]+$/);
      const review = await main();
      expect(review).not.toMatch(/Cannot lock yet/);
      expect(review).toMatch(/Tracks \(2\)/);
      expect(review).toContain('Health & Care');
      await page.getByRole('button', { name: 'Lock context' }).click();
      await page
        .getByText(/LOCKED/)
        .first()
        .waitFor();
      await shot('B1-locked');
    });

    it('B2. the normal submit page offers the tracks and says a track is needed (there is no event-wide rule); submitting WITHOUT one is accepted but the report is refused with the real remedy', async () => {
      await page.goto(`${webUrl}/events/${eventId}/submit`);
      const form = await main();
      expect(form).toContain('Tracks this project competes in');
      expect(form).toContain('Health & Care');
      expect(form).toContain('Without a track the report cannot be requested');
      await shot('B2-submit-form');
      firstProjectId = await submitProject(
        eventId,
        'https://github.com/synthetic/atlas',
        'https://devpost.com/software/synthetic-atlas',
      );
      await reloadUntil(
        (t) =>
          !/WAITING FOR THE CAPTURE WORKER/.test(t) && (t.match(/CAPTURED/g) ?? []).length >= 2,
        'both captures',
      );
      await requestReport(firstProjectId);
      await page.waitForURL(/error=/);
      const refusal = await main();
      expect(refusal).toMatch(/declared no track/);
      expect(refusal).toMatch(/void this submission and submit it again with its track selected/);
      expect(refusal).toMatch(/Nothing was queued or spent/);
      const list = await api(`/projects/${firstProjectId}/assessments`);
      expect(list['activeRun']).toBeNull();
      expect(list['assessments']).toEqual([]);
      await shot('B2-refused');
    });

    it('B3. the remedy works: void-and-replace offers the same track selector; the corrected submission declares the track', async () => {
      await page.goto(`${webUrl}/projects/${firstProjectId}/correct`);
      await page.getByLabel('Why is this project being voided?').fill('Entered without its track.');
      await page
        .getByLabel('Corrected GitHub repository URL')
        .fill('https://github.com/synthetic/atlas');
      await page
        .getByLabel('Corrected Devpost project URL')
        .fill('https://devpost.com/software/synthetic-atlas');
      await page.getByTestId('track-option-health_care').getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Void this project' }).click();
      await page.waitForURL(/\/projects\/([0-9a-f-]+)\/capture/);
      projectId = /projects\/([0-9a-f-]+)\/capture/.exec(page.url())?.[1] ?? '';
      expect(projectId).not.toBe(firstProjectId);
      const project = await api<{ tracks: { trackKey: string }[] }>(`/projects/${projectId}`);
      expect(project.tracks.map((t) => t.trackKey)).toEqual(['health_care']);
      // the voided project keeps its history and shows no track it never declared
      const voided = await api(`/projects/${firstProjectId}`);
      expect(voided['tracks']).toEqual([]);
      await shot('B3-replaced');
    });

    it('B4. capture, request the scripted report and read it: correctly labelled, for the overall rubric, with the track rubric disclosed as not assessed', async () => {
      await reloadUntil(
        (t) =>
          !/WAITING FOR THE CAPTURE WORKER/.test(t) && (t.match(/CAPTURED/g) ?? []).length >= 2,
        'both captures',
      );
      await requestReport(projectId);
      const text = await reloadUntil((t) => /NOT AN AI ASSESSMENT/.test(t), 'the scripted report');
      expect(text).toMatch(/Offline demonstration, not an AI estimate/);
      expect(text).toContain('SCRIPTED DEMONSTRATION');
      expect(text).toMatch(/Innovation/);
      expect(text).toMatch(/0 provider calls, no tokens, no cost/);
      expect(text).not.toMatch(/\$\d/);
      // the track rubric is disclosed in words (M6 phase 0, R8B P3-3), not as a raw code
      expect(text).toMatch(/The event published a rubric for this track/);
      expect(text).toMatch(/Which rubric was assessed/);
      // both expected sources were captured: no missing-source headline
      expect(text).not.toMatch(/EXPECTED SOURCE MISSING/);
      await shot('B4-report');
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
