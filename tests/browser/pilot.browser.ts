/// <reference lib="dom" />
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { EvidenceGraphService } from '../../apps/api/src/evidence-graph/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import {
  fakeVerifier,
  loadFixtures,
  replayService,
  requireValue,
  TEST_TOKENS,
} from '../../apps/api/src/testing/harness.js';
import { createAdapterRegistry } from '../../apps/worker/src/adapters.js';
import { demonstrationStep } from '../../apps/worker/src/assessment/demonstration-model.js';
import { createAssessmentLoop } from '../../apps/worker/src/assessment/loop.js';
import { harness, TEST_MODELS } from '../../apps/worker/src/testing/assessment-world.js';
import {
  captureSetup,
  memoryLogger,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';
import { EvidenceGraphStore, sourceSnapshots } from '../../packages/database/src/index.js';
import { ScriptedProvider } from '../../packages/llm/src/index.js';
import { createFixtureNetwork, createSafeHttpClient } from '../../packages/safe-http/src/index.js';
import type { FixtureWorld } from '../../packages/safe-http/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';

/*
 * P6C: the first real-source pilot journey, in a REAL browser, through the screens a judge actually uses and nothing else:
 *
 *   create a hackathon -> add its official sources -> build the Event Context -> lock it -> submit a GitHub URL and a Devpost URL
 *   -> the GitHub repository is captured (production adapter, SSRF-safe client, over the RECORDED REAL GitHub responses for
 *      meetbhadra701-cloud/Judge @ 9459c98; no network) -> Devpost cannot be fetched -> the organizer pastes authorized text
 *   -> request the preliminary assessment (the OFFLINE scripted demonstrator) -> open the report.
 *
 * What is real: the web server, the API, the capture worker with the production GitHub adapter, the assessment worker, the database.
 * What is NOT: (a) GitHub is a recording of real responses (tests/fixtures/real-github/README.md), (b) the Devpost text is a clearly
 * labelled REGRESSION-TEST text, not a real submission, (c) the Event Context is the repository's synthetic regression event, not an
 * authentic hackathon rubric, (d) the "assessment" is the scripted demonstrator: every score is a fixed placeholder. This test therefore
 * proves that the interface works end to end on real captured evidence; it does NOT prove real-source ingestion of a Devpost page and it
 * says nothing about the quality of any AI judgment. No model is called. Run with `pnpm test:browser`.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_DIR = join(ROOT, 'apps/web');
const SHOTS = process.env['BROWSER_SMOKE_SHOTS'] ?? join(tmpdir(), 'judge-pilot-shots');
const RECORDING = join(ROOT, 'tests/fixtures/real-github/recorded-judge-9459c98.json');
const REAL_REPO = 'https://github.com/meetbhadra701-cloud/Judge';
const REAL_REVISION = '9459c9830086e9c7bf889ff22aaf9c19a1369d5d';
const DEVPOST_URL = 'https://devpost.com/software/judge-copilot-regression-example';
const REGRESSION_DEVPOST_TEXT = [
  'REGRESSION-TEST TEXT — NOT A REAL DEVPOST SUBMISSION.',
  'Judge Copilot is a human-in-the-loop hackathon judging assistant. It captures a project’s GitHub repository and Devpost page,',
  'extracts claims, and prepares an evidence-backed preliminary assessment for a human judge to review.',
].join('\n');
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

describe('P6C pilot journey: event -> context lock -> GitHub + Devpost -> scripted preliminary report', () => {
  let testDb: TestDatabase;
  let app: ApiApp;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let page: Page;
  let webUrl = '';
  let apiUrl = '';
  let eventId = '';
  let projectId = '';

  const shot = async (name: string) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };
  const main = async () => page.locator('main').innerText();
  const api = async (path: string) =>
    (await (
      await fetch(`${apiUrl}${path}`, {
        headers: { authorization: `Bearer ${TEST_TOKENS.organizer}` },
      })
    ).json()) as Record<string, unknown>;

  /** The production capture worker over the RECORDED REAL GitHub responses; every other host is unreachable (as Devpost is from here). */
  const drainCaptures = async () => {
    const recorded = JSON.parse(readFileSync(RECORDING, 'utf8')) as FixtureWorld;
    const network = createFixtureNetwork(recorded);
    const http = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
    // the recording was made with these limits: the request set depends on them
    const adapters = createAdapterRegistry({
      http,
      githubToken: null,
      githubLimits: { maxFiles: 4, maxCommits: 5 },
      deploymentTimeoutMs: 200,
    });
    await (await captureSetup(testDb.db, { adapters })).loop.drain();
  };

  /** The real assessment loop on the OFFLINE scripted demonstrator. */
  const drainAssessments = async () => {
    const h = harness(testDb.db);
    const scripted = new ScriptedProvider([demonstrationStep], { repeatLast: true });
    const { shutdown: _shutdown, ...deps } = h.deps(scripted);
    await createAssessmentLoop({
      db: testDb.db,
      runs: h.runs,
      logger: memoryLogger().logger,
      concurrency: 1,
      pollIntervalMs: 50,
      onOutcome: () => undefined,
      pipeline: deps,
    }).drain();
  };

  beforeAll(async () => {
    if (!existsSync(join(WEB_DIR, '.next/BUILD_ID'))) {
      throw new Error(
        'apps/web has no production build: run `pnpm test:browser` (it builds first).',
      );
    }
    testDb = await openDatabase();
    const db = testDb.db;
    const fixtures = await loadFixtures();
    // the Event Context extractor is the repository's replay extractor: it answers only the recorded synthetic regression event
    const eventContext = replayService(db, fixtures.values());
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db }),
      evidenceGraph: new EvidenceGraphService({ store: new EvidenceGraphStore({ db }) }),
      assessments: new AssessmentService({
        db,
        offline: { provider: { id: 'scripted', mode: 'scripted' }, models: TEST_MODELS },
      }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apiUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const webPort = 3990 + Math.floor(Math.random() * 9);
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
    page = await browser.newPage();
    // keep the recording honest: the fixture must be the one this test says it is
    expect(readFileSync(RECORDING, 'utf8')).toContain(REAL_REVISION);
  });

  afterAll(async () => {
    await browser.close();
    web?.kill();
    await app.close();
    await testDb.close();
  });

  it('1. a judge creates a hackathon, adds its official sources, builds the Event Context and locks it — all in the browser', async () => {
    const recording = requireValue(
      (await loadFixtures()).get('fixture-a-clear-official-rubric'),
      'regression event recording',
    );
    await page.goto(`${webUrl}/`);
    await page.getByLabel('Name', { exact: false }).first().fill('Pilot Regression Hackathon');
    await page.getByLabel('Slug', { exact: false }).fill('pilot-regression-hackathon');
    await page.getByRole('button', { name: 'Create event' }).click();
    await page.waitForURL(/\/events\/[0-9a-f-]+$/);
    eventId = /events\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
    await page.getByRole('button', { name: 'Create draft version' }).click();
    await page.waitForURL(/\/versions\/[0-9a-f-]+$/);
    for (const source of recording.sources) {
      await page.getByLabel('Title').fill(source.title);
      await page.getByLabel('Authority').selectOption(source.authority);
      await page.getByLabel('Normalized text').fill(source.normalizedText);
      await page.getByRole('button', { name: 'Add source' }).click();
      await page.getByText(source.title).first().waitFor();
    }
    await page.getByRole('button', { name: 'Build context from sources' }).click();
    await page.getByRole('heading', { name: /^Rubrics \(1\)/ }).waitFor();
    await shot('01-context-built');
    await page.getByRole('button', { name: 'Lock context' }).click();
    await page
      .getByText(/locked/i)
      .first()
      .waitFor();
    expect(await main()).toMatch(/locked/i);
    await shot('02-context-locked');
  });

  it('2. the judge submits the real GitHub URL and a Devpost URL; the GitHub repository is captured (partially, with the limits said) at an immutable commit', async () => {
    await page.goto(`${webUrl}/events/${eventId}/submit`);
    await page.getByLabel('GitHub repository URL').fill(REAL_REPO);
    await page.getByLabel('Devpost project URL').fill(DEVPOST_URL);
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.waitForURL(/\/projects\/([0-9a-f-]+)\/capture/);
    projectId = /projects\/([0-9a-f-]+)\/capture/.exec(page.url())?.[1] ?? '';
    await drainCaptures();
    await page.reload();
    await page.locator('[data-testid=source-github][data-stage=captured_partial]').waitFor();
    expect(await page.getByTestId('revision-github').innerText()).toContain(REAL_REVISION);
    await shot('03-github-captured');
    const rows = (await testDb.db.select().from(sourceSnapshots)).filter(
      (s) => s.projectId === projectId && s.sourceType === 'github',
    );
    expect(rows.map((r) => r.revision)).toContain(REAL_REVISION);
  });

  it('3. Devpost cannot be fetched from here, says so plainly, and the organizer supplies authorized text which is labelled as supplied', async () => {
    const devpost = page.locator('[data-testid=source-devpost]');
    expect(await devpost.getAttribute('data-stage')).toBe('failed');
    await page.getByTestId('supply-content').locator('summary').click();
    await page.getByLabel('Submission text').fill(REGRESSION_DEVPOST_TEXT);
    await page.getByRole('button', { name: 'Store this text' }).click();
    await page.getByText('TEXT SUPPLIED BY AN ORGANIZER').waitFor();
    expect(await main()).toContain('NOT fetched from the source');
    await shot('04-devpost-supplied');
  });

  it('4. the judge requests the assessment: the page says it is a scripted demonstration, then the report shows scores, citations, unknowns and limitations with the right labels', async () => {
    await page.goto(`${webUrl}/projects/${projectId}/assessment`);
    const before = await main();
    expect(before).toMatch(/demonstration/i);
    await shot('05-before-request');
    await page.getByRole('button', { name: 'Run assessment' }).click();
    const deadline = Date.now() + 20_000;
    for (;;) {
      const body = await api(`/projects/${projectId}/assessments`);
      if (body['activeRun']) break;
      if (Date.now() > deadline) throw new Error('no assessment run was requested');
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    await drainAssessments();
    await page.goto(`${webUrl}/projects/${projectId}/assessment`);
    const banner = page.getByTestId('demonstration-banner');
    await banner.waitFor();
    expect(await banner.getAttribute('data-mode')).toBe('scripted');
    expect(await banner.innerText()).toContain('SCRIPTED DEMONSTRATION');
    const text = await main();
    expect(text).toContain('organizer_supplied_source');
    expect(text).toContain('No model was called and nothing was spent');
    expect(text).not.toMatch(/\$\d/);
    expect(text).toMatch(/not (a )?model assessment|says nothing about its quality/i);
    expect(text).not.toMatch(/AI (judgment|assessment) of this project/i);
    // provenance: the supplied Devpost text is a team claim, never verified
    expect(text).toMatch(/Unknown|unknown/);
    await shot('06-scripted-report');
  });
});
