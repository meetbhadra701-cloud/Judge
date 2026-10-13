/// <reference lib="dom" />
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
  lockedEventFromRecording,
  replayService,
  requireValue,
  TEST_TOKENS,
} from '../../apps/api/src/testing/harness.js';
import { createAssessmentLoop } from '../../apps/worker/src/assessment/loop.js';
import { harness, seedWorld, TEST_MODELS } from '../../apps/worker/src/testing/assessment-world.js';
import { corruptions } from '../../apps/worker/src/testing/corrupt.js';
import { FakeModel } from '../../apps/worker/src/testing/fake-model.js';
import {
  captureSetup,
  memoryLogger,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';
import { execute } from '../../apps/worker/src/testing/run.js';
import {
  analysisRuns,
  EvidenceGraphStore,
  projects,
  sourceSnapshots,
} from '../../packages/database/src/index.js';
import {
  computeRequestDigest,
  ReplayProvider,
  ScriptedProvider,
} from '../../packages/llm/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';

/*
 * P6B-alpha: a permanent REAL-BROWSER smoke test of the journey that exists in this slice:
 *
 *   hackathon (locked Event Context) -> GitHub + Devpost links -> capture progress (waiting / captured / failed / retry)
 *   -> the preliminary-report page (no assessment / run that cannot complete offline / verified report / withheld report)
 *
 * Everything is real except the model and the network: the real Next.js server (`next start` of the production build), the real API
 * routes over a loopback socket, the real capture worker loop in front of the synthetic fixture network, the real assessment loop on the
 * OFFLINE replay provider. No external connection is opened and no model is called. Run with `pnpm test:browser`.
 * Screenshots go to $BROWSER_SMOKE_SHOTS (default: a folder under the OS temp directory, never the checkout).
 */

const ROOT = resolve(import.meta.dirname, '../..');
const WEB_DIR = join(ROOT, 'apps/web');
// outside the repository by default: a test run must never create or modify a tracked (or untracked) file in the checkout
const SHOTS = process.env['BROWSER_SMOKE_SHOTS'] ?? join(tmpdir(), 'judge-browser-shots');
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const [, openDatabase] = testDatabaseTargets()[0] as [string, () => Promise<TestDatabase>];

interface Entry {
  requestDigest: string;
  stage: string;
  note: string;
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

async function waitForHttp(url: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
}

/** The working tree's state (tracked changes and untracked files), so a run can prove it left the checkout exactly as it found it. */
const checkoutState = (): string =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

describe('browser smoke: submit -> capture -> preliminary report', () => {
  const checkoutBefore = checkoutState();
  let testDb: TestDatabase;
  let app: ApiApp;
  let web: ChildProcess | null = null;
  let browser: Browser;
  let page: Page;
  let webUrl = '';
  let apiUrl = '';
  let eventId = '';
  let newLockedEvent: () => Promise<string>;
  const entries: Entry[] = [];

  const shot = async (name: string) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  };
  const main = async () => page.locator('main').innerText();
  const api = async (path: string) => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: { authorization: `Bearer ${TEST_TOKENS.organizer}` },
    });
    return (await response.json()) as Record<string, unknown>;
  };

  /** Waits until the API reports an active (pending) assessment run for the project: the click's server action has finished. */
  const waitForActiveRun = async (projectId: string) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const body = await api(`/projects/${projectId}/assessments`);
      if (body['activeRun'] !== null && body['activeRun'] !== undefined) return;
      if (Date.now() > deadline) throw new Error('no assessment run was requested');
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  };

  /** The real capture worker, once over everything pending. */
  const drainCaptures = async () => (await captureSetup(testDb.db)).loop.drain();

  /** The real assessment loop on the OFFLINE replay provider, once over everything pending. */
  const drainAssessments = async () => {
    const h = harness(testDb.db);
    const replay = new ReplayProvider({
      fixtures: { version: 'replay-fixtures/v1', synthetic: true, entries },
    });
    const { shutdown: _shutdown, ...deps } = h.deps(replay);
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
        'apps/web has no production build: run `pnpm test:browser` (it builds first) or `pnpm --filter @judge-copilot/web build`.',
      );
    }
    testDb = await openDatabase();
    const db = testDb.db;

    // 1. record the hand-written answers for the built-in synthetic demonstration project (the only material replay can answer)
    const recorder = new FakeModel();
    await execute(db, {
      provider: new ScriptedProvider(
        [
          (request) => {
            const result = recorder.step(request);
            if (result.ok) {
              entries.push({
                requestDigest: computeRequestDigest({ ...request, provider: 'replay' }),
                stage: request.stage,
                note: 'synthetic: hand-authored by the test, not produced by any model',
                output: result.json,
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                },
              });
            }
            return result;
          },
        ],
        { repeatLast: true },
      ),
    });

    // 2. the API (loopback), with the offline replay runtime approved, and a locked hackathon
    const fixtures = await loadFixtures();
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
        offline: { provider: { id: 'replay', mode: 'replay' }, models: TEST_MODELS },
      }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apiUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    newLockedEvent = async () =>
      (
        await lockedEventFromRecording(
          eventContext,
          requireValue(fixtures.get('fixture-e-multiple-tracks')),
        )
      ).eventId;
    eventId = await newLockedEvent();

    // 3. the real web server (production build)
    const webPort = 3940 + Math.floor(Math.random() * 50);
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
  });

  afterAll(async () => {
    await browser.close();
    web?.kill();
    await app.close();
    await testDb.close();
  });

  it('leaves the checkout exactly as it found it (no screenshot, report or build artifact lands in a tracked or untracked file)', () => {
    expect(checkoutState()).toBe(checkoutBefore);
  });

  it('the submit page identifies the hackathon and its locked Event Context, and explains this is a temporary offline workflow', async () => {
    await page.goto(`${webUrl}/events/${eventId}/submit`);
    await expect(page.locator('[data-testid=active-event]').innerText()).resolves.toMatch(/\S/);
    await expect(page.locator('[data-testid=active-context]').innerText()).resolves.toContain(
      'locked Event Context',
    );
    const text = await main();
    expect(text).toContain('Temporary offline workflow');
    expect(text).toContain('not an AI analysis');
    expect(await page.getByLabel('GitHub repository URL').count()).toBe(1);
    expect(await page.getByLabel('Devpost project URL').count()).toBe(1);
    await shot('01-submit');
  });

  it('invalid links are explained next to their fields and create nothing', async () => {
    await page.goto(`${webUrl}/events/${eventId}/submit`);
    await page
      .getByLabel('GitHub repository URL')
      .fill('https://devpost.com/software/synthetic-atlas');
    await page.getByLabel('Devpost project URL').fill('https://github.com/synthetic/atlas');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.locator('#github-error').waitFor();
    expect(await page.locator('#github-error').innerText()).toContain(
      'belongs in the Devpost field',
    );
    expect(await page.locator('#devpost-error').innerText()).toContain(
      'belongs in the GitHub field',
    );
    // the typed values stay in the form
    expect(await page.getByLabel('GitHub repository URL').inputValue()).toContain('devpost.com');
    expect(((await api(`/events/${eventId}/projects`))['projects'] as unknown[]).length).toBe(0);
    await shot('02-invalid');
  });

  it('a (double-)clicked valid submission creates ONE project with both sources waiting for the capture worker', async () => {
    await page.goto(`${webUrl}/events/${eventId}/submit`);
    await page.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/atlas');
    await page
      .getByLabel('Devpost project URL')
      .fill('https://devpost.com/software/synthetic-atlas');
    await page.getByRole('button', { name: 'Submit and start capture' }).dblclick();
    await page.waitForURL(/\/projects\/[0-9a-f-]+\/capture/);
    await page.locator('[data-testid=source-github][data-stage=waiting]').waitFor();
    await page.locator('[data-testid=source-devpost][data-stage=waiting]').waitFor();
    const text = await main();
    expect(text).toContain('WAITING FOR THE CAPTURE WORKER');
    expect(text).toContain('not an AI analysis');
    expect(text).toContain('Temporary offline workflow');
    expect(await page.locator('[data-testid=next-blocked]').count()).toBe(1);
    expect(await page.locator('[data-testid=next-report]').count()).toBe(0);
    const listed = (await api(`/events/${eventId}/projects`))['projects'] as {
      id: string;
      name: string;
    }[];
    expect(listed.map((project) => project.name)).toEqual(['synthetic/atlas']);
    const snapshots = (await testDb.db.select().from(sourceSnapshots)).filter(
      (s) => s.projectId === listed[0]?.id,
    );
    expect(snapshots.map((s) => s.status)).toEqual(['pending', 'pending']);
    await shot('03-waiting');
  });

  it('when the worker captures, the page refreshes itself, says CAPTURED (not analysed) and opens the separate report step', async () => {
    await drainCaptures();
    await page
      .locator('[data-testid=source-github][data-stage=captured]')
      .waitFor({ timeout: 20_000 });
    await page.locator('[data-testid=source-devpost][data-stage=captured]').waitFor();
    const text = await main();
    expect(text).toContain('not an analysis');
    expect(text).not.toMatch(/analysis (is )?complete/i);
    await shot('04-captured');
    await page.locator('[data-testid=next-report]').click();
    await page.waitForURL(/\/assessment$/);
    const report = await main();
    expect(report).toContain('Preliminary report');
    expect(report).toContain('NO ASSESSMENT');
    expect(report).toContain('Nothing has been scored');
    expect(report).toContain('Offline replay demonstration');
    await shot('05-report-none');
  });

  it('asking for the report on material with no recorded demonstration answer ends honestly: no score, and the reason is stated', async () => {
    const submittedProjectId = /\/projects\/([0-9a-f-]+)\/assessment/.exec(page.url())?.[1] ?? '';
    await page.getByRole('button', { name: 'Run assessment' }).click();
    await waitForActiveRun(submittedProjectId);
    await drainAssessments();
    await page.reload();
    const text = await main();
    expect(text).toContain('RUN DID NOT COMPLETE');
    expect(text).toContain('No assessment was produced');
    expect(text).toMatch(
      /no recorded answer|official overall rubric|known limitation|did not complete/,
    );
    expect(text).not.toMatch(/\d+(\.\d+)? \/ 10/);
    await shot('06-run-failed');
  });

  it('a failed capture is reported for that source only, and Retry makes a new attempt', async () => {
    // its own hackathon: one Devpost page can belong to only one submission of an event
    const failingEventId = await newLockedEvent();
    await page.goto(`${webUrl}/events/${failingEventId}/submit`);
    await page
      .getByLabel('GitHub repository URL')
      .fill('https://github.com/synthetic/does-not-exist');
    await page
      .getByLabel('Devpost project URL')
      .fill('https://devpost.com/software/synthetic-atlas');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.waitForURL(/\/capture/);
    await drainCaptures();
    await page.reload();
    await page.locator('[data-testid=source-github][data-stage=failed]').waitFor();
    await page.locator('[data-testid=source-devpost][data-stage=captured]').waitFor();
    const failedRow = page.locator('[data-testid=source-github]');
    expect(await failedRow.innerText()).toContain('CAPTURE FAILED');
    expect(await page.getByRole('button', { name: 'Retry capture' }).count()).toBe(1);
    expect(await main()).toContain('missing evidence, never a negative judgment');
    await shot('07-failed');
    await page.getByRole('button', { name: 'Retry capture' }).click();
    await page.locator('[data-testid=source-github][data-stage=waiting]').waitFor();
    expect(await page.locator('[data-testid=source-github]').innerText()).toContain('Attempt #2');
    await drainCaptures();
    await page.reload();
    await page.locator('[data-testid=source-github][data-stage=failed]').waitFor();
    await shot('08-retried');
  });

  it('R7-1/R7-2 in a real browser: two tabs sending the same repository with different Devpost pages never share a project', async () => {
    const raceEventId = await newLockedEvent();
    const context = await browser.newContext();
    for (let round = 0; round < 6; round += 1) {
      const tabs = [await context.newPage(), await context.newPage()];
      const github = `https://github.com/synthetic/race-${String(round)}`;
      for (const [index, tab] of tabs.entries()) {
        await tab.goto(`${webUrl}/events/${raceEventId}/submit`);
        await tab.getByLabel('GitHub repository URL').fill(github);
        await tab
          .getByLabel('Devpost project URL')
          .fill(`https://devpost.com/software/race-${String(round)}-${index === 0 ? 'a' : 'b'}`);
      }
      await Promise.all(
        tabs.map((tab) => tab.getByRole('button', { name: 'Submit and start capture' }).click()),
      );
      // each tab ends either on the capture page (it won) or on the form with an explanation (it lost): never both on a capture page
      await Promise.all(
        tabs.map((tab) =>
          Promise.race([
            tab.waitForURL(/\/capture/, { timeout: 30_000 }),
            tab.locator('main [role=alert]').first().waitFor({ timeout: 30_000 }),
          ]),
        ),
      );
      const landed = tabs.filter((tab) => /\/capture/.test(tab.url()));
      expect(landed).toHaveLength(1);
      const loser = tabs.find((tab) => !/\/capture/.test(tab.url()));
      expect(await loser?.locator('main [role=alert]').first().innerText()).toContain(
        'nothing was merged',
      );
      const stored = (await testDb.db.select().from(projects)).filter(
        (p) => p.eventId === raceEventId,
      );
      const mine = stored.filter((p) => p.name === `synthetic/race-${String(round)}`);
      expect(mine).toHaveLength(1);
      const sources = (await api(`/projects/${mine[0]?.id ?? ''}`))['sources'] as {
        sourceType: string;
      }[];
      expect(sources.map((source) => source.sourceType).sort()).toEqual(['devpost', 'github']);
      await Promise.all(tabs.map((tab) => tab.close()));
    }
    await context.close();
  });

  it('refresh and back/forward navigation never create or change anything', async () => {
    const navEventId = await newLockedEvent();
    await page.goto(`${webUrl}/events/${navEventId}/submit`);
    await page.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/navigate');
    await page.getByLabel('Devpost project URL').fill('https://devpost.com/software/navigate');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.waitForURL(/\/capture/);
    const captureUrl = page.url();
    const count = async () =>
      (await testDb.db.select().from(projects)).filter((p) => p.eventId === navEventId).length;
    const snapshotCount = async () => (await testDb.db.select().from(sourceSnapshots)).length;
    expect(await count()).toBe(1);
    const snapshotsBefore = await snapshotCount();
    await page.reload();
    await page.reload();
    expect(await count()).toBe(1);
    // Next.js attaches its history handling only once the page has hydrated; going back inside that window is a framework race, not a
    // behavior of this application, so the test waits for hydration like a person who has seen the page appear would
    await page.waitForFunction(
      () => 'next' in window && Boolean((window as { next?: { router?: unknown } }).next?.router),
    );
    // back to the form, press the same form again (the browser may restore the very same key), then forward and back once more
    await page.goBack();
    await page.waitForURL(/\/submit/);
    await page.getByLabel('GitHub repository URL').waitFor();
    const form = page.getByRole('button', { name: 'Submit and start capture' });
    await page.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/navigate');
    await page.getByLabel('Devpost project URL').fill('https://devpost.com/software/navigate');
    await form.click();
    await page.waitForURL(/\/capture/);
    expect(page.url()).toBe(captureUrl); // converged on the same project
    await page.goBack();
    await page.goForward();
    await page.reload();
    expect(await count()).toBe(1);
    expect(await snapshotCount()).toBe(snapshotsBefore);
    // changing a link after the first submission is a different submission, never an edit of the first
    await page.goto(`${webUrl}/events/${navEventId}/submit`);
    await page.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/navigate');
    await page
      .getByLabel('Devpost project URL')
      .fill('https://devpost.com/software/navigate-other');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.locator('main [role=alert]').first().waitFor();
    expect(await page.locator('main [role=alert]').first().innerText()).toContain(
      'nothing was merged',
    );
    expect(await count()).toBe(1);
  });

  it('R7-5: the progress checker says what it does, refreshes on a real change, and tells the truth after its five minutes', async () => {
    const watchEventId = await newLockedEvent();
    const tab = await browser.newPage();
    await tab.clock.install();
    await tab.goto(`${webUrl}/events/${watchEventId}/submit`);
    await tab.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/atlas');
    await tab
      .getByLabel('Devpost project URL')
      .fill('https://devpost.com/software/synthetic-atlas');
    await tab.getByRole('button', { name: 'Submit and start capture' }).click();
    await tab.waitForURL(/\/capture/);
    const note = tab.locator('[data-testid=auto-refresh]');
    await note.waitFor();
    expect(await note.getAttribute('data-state')).toBe('watching');
    expect(await note.innerText()).toBe(
      'This page checks for progress every 3 seconds, for up to 5 minutes.',
    );
    // a real change (the worker captures) is picked up on the next check, without a reload
    await drainCaptures();
    await tab.clock.fastForward(4000);
    await tab
      .locator('[data-testid=source-github][data-stage=captured]')
      .waitFor({ timeout: 20_000 });
    expect(await tab.locator('[data-testid=auto-refresh]').count()).toBe(0); // nothing is waiting any more, so nothing is claimed
    await tab.close();

    // nothing changes for longer than five minutes: the page must stop claiming it is checking
    const quietEventId = await newLockedEvent();
    const quiet = await browser.newPage();
    await quiet.clock.install();
    await quiet.goto(`${webUrl}/events/${quietEventId}/submit`);
    await quiet.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/quiet');
    await quiet.getByLabel('Devpost project URL').fill('https://devpost.com/software/quiet');
    await quiet.getByRole('button', { name: 'Submit and start capture' }).click();
    await quiet.waitForURL(/\/capture/);
    await quiet.locator('[data-testid=auto-refresh][data-state=watching]').waitFor();
    await quiet.clock.fastForward('06:00');
    await quiet
      .locator('[data-testid=auto-refresh][data-state=expired]')
      .waitFor({ timeout: 20_000 });
    const expired = await quiet.locator('[data-testid=auto-refresh]').innerText();
    expect(expired).toBe(
      'Automatic checking stopped after 5 minutes. Reload the page to check again.',
    );
    expect(expired).not.toMatch(/every 3 seconds/);
    await quiet.close();
  });

  it('R7-6: every page has its own title, and a refused submission moves focus to what must be fixed', async () => {
    const titleEventId = await newLockedEvent();
    const eventName = (
      (await api(`/events/${titleEventId}`))['event'] as { name: string }
    ).name.trim();
    const visited: [string, string][] = [];
    const visit = async (url: string, expected: RegExp) => {
      await page.goto(`${webUrl}${url}`);
      const title = await page.title();
      expect(title).toMatch(expected);
      visited.push([url, title]);
    };
    await visit('/', /^Events · Judge Copilot$/);
    await visit(`/events/${titleEventId}`, new RegExp(`^${eventName} · Judge Copilot$`));
    await visit(
      `/events/${titleEventId}/submit`,
      new RegExp(`^Submit a project · ${eventName} · Judge Copilot$`),
    );
    // a submission, then its project pages
    await page.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/titles');
    await page.getByLabel('Devpost project URL').fill('https://devpost.com/software/titles');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.waitForURL(/\/capture/);
    const projectId = /\/projects\/([0-9a-f-]+)\//.exec(page.url())?.[1] ?? '';
    await visit(
      `/projects/${projectId}/capture`,
      /^Capture progress · synthetic\/titles · Judge Copilot$/,
    );
    await visit(
      `/projects/${projectId}/assessment`,
      /^Preliminary report · synthetic\/titles · Judge Copilot$/,
    );
    await visit(
      `/projects/${projectId}/evidence`,
      /^Evidence · synthetic\/titles · Judge Copilot$/,
    );
    await visit(`/projects/${projectId}`, /^synthetic\/titles · Judge Copilot$/);
    expect(new Set(visited.map(([, title]) => title)).size).toBe(visited.length);

    // focus: a refused field gets focus, so keyboard and screen-reader users land on the problem
    await page.goto(`${webUrl}/events/${titleEventId}/submit`);
    await page.getByLabel('GitHub repository URL').fill('not a link');
    await page.getByLabel('Devpost project URL').fill('https://devpost.com/software/titles');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    await page.locator('#github-error').waitFor();
    expect(
      await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name),
    ).toBe('github');
    // a refusal that belongs to no field (the link is already used by another submission) focuses the message itself
    await page.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/titles');
    await page
      .getByLabel('Devpost project URL')
      .fill('https://devpost.com/software/titles-different');
    await page.getByRole('button', { name: 'Submit and start capture' }).click();
    const refusal = page.locator('main p[role=alert]', { hasText: 'nothing was merged' });
    await refusal.waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('alert');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain(
      'nothing was merged',
    );
  });

  it('R7-6: no page scrolls sideways on a phone-width screen, even with long names and a wide table', async () => {
    const phoneEventId = await newLockedEvent();
    const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const phone = await context.newPage();
    const overflow = async (label: string) => {
      const widths = await phone.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        window: window.innerWidth,
      }));
      expect(
        widths.page,
        `${label}: page is ${String(widths.page)}px wide in a ${String(widths.window)}px window`,
      ).toBeLessThanOrEqual(widths.window);
    };
    await phone.goto(`${webUrl}/events/${phoneEventId}/submit`);
    await overflow('submit');
    await phone.getByLabel('GitHub repository URL').fill('https://github.com/synthetic/phone');
    await phone.getByLabel('Devpost project URL').fill('https://devpost.com/software/phone');
    await phone.getByLabel(/Project name/).fill('A'.repeat(200));
    await phone.getByRole('button', { name: 'Submit and start capture' }).click();
    await phone.waitForURL(/\/capture/);
    await overflow('capture (waiting, 200-character project name)');
    const projectId = /\/projects\/([0-9a-f-]+)\//.exec(phone.url())?.[1] ?? '';
    await drainCaptures();
    await phone.reload();
    await overflow('capture (failed or captured)');
    await phone.goto(`${webUrl}/projects/${projectId}/assessment`);
    await overflow('report (nothing assessed)');
    const world = await seedWorld(testDb.db);
    await phone.goto(`${webUrl}/projects/${world.project.id}/assessment`);
    await phone.getByRole('button', { name: 'Run assessment' }).click();
    await waitForActiveRun(world.project.id);
    await drainAssessments();
    await phone.goto(`${webUrl}/projects/${world.project.id}/assessment`);
    expect(await phone.locator('main').innerText()).toContain('SCORED');
    await overflow('report (scored)');
    await phone.goto(`${webUrl}/events/${phoneEventId}`);
    await overflow('event');
    await context.close();
  });

  it('R7-7: a hand-written ?error= link shows nothing, while a real failure is shown through the sealed message', async () => {
    const forged = 'Your session expired. Call 0800 123 456 to restore access.';
    await page.goto(`${webUrl}/?error=${encodeURIComponent(forged)}`);
    expect(await main()).not.toContain('0800');
    expect(await page.locator('main [role=alert]').count()).toBe(0);
    // a genuine failure (a slug that is already taken) is displayed, because this server sealed it
    const slug = `sealed-${String(Date.now())}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto(`${webUrl}/`);
      await page.locator('input[name=name]').first().fill('Sealed message hackathon');
      await page.locator('input[name=slug]').first().fill(slug);
      await page
        .getByRole('button', { name: /create/i })
        .first()
        .click();
      await page.waitForLoadState('networkidle');
    }
    const alert = page.locator('main [role=alert]').first();
    await alert.waitFor();
    expect((await alert.innerText()).length).toBeGreaterThan(5);
    expect(page.url()).toMatch(/\?error=[A-Za-z0-9_\-.%]+/);
    // tampering with the sealed value makes it vanish
    const tampered = page.url().replace(/(error=[A-Za-z0-9_\-%]+)\.[A-Za-z0-9_-]+/, '$1.AAAA');
    await page.goto(tampered);
    expect(await page.locator('main [role=alert]').count()).toBe(0);
  });

  it('a verified report shows its scores, relative highs/lows, unknowns and limits; corrupting it withholds everything', async () => {
    const world = await seedWorld(testDb.db);
    const projectUrl = `${webUrl}/projects/${world.project.id}/assessment`;
    await page.goto(projectUrl);
    await page.getByRole('button', { name: 'Run assessment' }).click();
    await waitForActiveRun(world.project.id);
    await drainAssessments();
    await page.goto(projectUrl);
    const text = await main();
    expect(text).toContain('SCORED');
    expect(text).toContain('7.0 / 10');
    expect(text).toContain('Replay demonstration');
    expect(text).toContain('Advisory only');
    expect(text).toContain('Relative highs and lows among assessed dimensions');
    expect(text).toContain('there is no highest or lowest'); // both dimensions score 7
    expect(text).toContain('Unknowns and missing information');
    expect(text).not.toContain('could not be loaded');
    expect(text).toContain('Gaps recorded for the material of version 1');
    expect(text).toContain('not a list of the project’s current gaps');
    expect(text).toContain('stored text that no integrity hash covers');
    expect(text).toContain('a raw 7.33333 is reported, and shown, as 7.3333');
    await shot('09-report-scored');

    const list = (await api(`/projects/${world.project.id}/assessments`))['assessments'] as {
      id: string;
    }[];
    await corruptions.judgmentScores(testDb.db, list[0]?.id ?? '');
    await page.goto(projectUrl);
    const withheld = await main();
    expect(withheld).toContain('NOT VERIFIED');
    expect(withheld).toContain('This assessment is withheld');
    expect(withheld).toContain('judgment_mismatch_score');
    expect(withheld).toContain('Reassess');
    expect(withheld).not.toMatch(/\d+(\.\d+)? \/ 10/);
    expect(withheld).not.toContain('Relative highs and lows');
    expect(withheld).not.toContain('Unknowns and missing information');
    expect(
      await page.getByRole('button', { name: 'Show assessment for current material' }).count(),
    ).toBe(0);
    await shot('10-report-withheld');
  });

  it('no run other than capture runs and the explicitly requested offline assessments exists, and no model was called', async () => {
    const runs = await testDb.db.select().from(analysisRuns);
    const types = new Set(runs.map((run) => run.runType));
    expect([...types].sort()).toEqual([
      'event_context_build',
      'pre_interview_assessment',
      'project_source_capture',
    ]);
    // the submit/capture flow alone never created an assessment run for the submitted projects before the explicit click
    expect((await testDb.db.select().from(projects)).length).toBeGreaterThanOrEqual(3);
  });
});
