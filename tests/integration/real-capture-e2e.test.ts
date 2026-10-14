/*
 * P6B-beta2: the REAL user workflow, end to end, over recorded REAL GitHub responses -- and an honest account of what it could not cover.
 *
 *   web tier (`runSubmission`, the code behind "Submit and start capture") -> real API routes -> real queue and worker loop -> production SSRF-safe
 *   client and GitHub adapter (over the recorded real responses, tests/fixtures/real-github) -> real database -> API read routes -> web status rules
 *
 * WHAT THIS IS NOT: a capture of a real Devpost page. devpost.com is not reachable from the environment this milestone was built in (the egress policy refuses
 * the connection; see the milestone report), so there is no real Devpost response to record. The Devpost source of this pair therefore ends in the same state a
 * real block produces (a recorded FAILED capture with a precise category and NO content), which this test asserts -- it does not substitute invented page
 * text. The two links below are one real GitHub repository and a Devpost URL that is only a declaration: nothing claims they belong to the same project.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ApiErrorBody,
  type ProjectDetail,
  type SnapshotDetail,
} from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessmentRequests,
  assessmentRunCalls,
  claims,
  evidenceItems,
  preInterviewAssessments,
  sourceSnapshotArtifacts,
  unknowns,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import {
  createFixtureNetwork,
  createSafeHttpClient,
  type FixtureWorld,
} from '../../packages/safe-http/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import type { EventContextService } from '../../apps/api/src/event-context/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import {
  bearer,
  fakeVerifier,
  loadFixtures,
  lockedEventFromRecording,
  replayService,
  requireValue,
  TEST_TOKENS,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/api/src/testing/harness.js';
import { createAdapterRegistry } from '../../apps/worker/src/adapters.js';
import { captureSetup } from '../../apps/worker/src/testing/harness.js';
import { describeCapture } from '../../apps/web/lib/capture-status.js';
import { runSubmission, type ApiFn } from '../../apps/web/lib/submission.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const RECORDED = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../fixtures/real-github/recorded-judge-9459c98.json'),
    'utf8',
  ),
) as FixtureWorld & { routes: Record<string, { json?: Record<string, unknown> }> };
const GITHUB = 'https://github.com/meetbhadra701-cloud/Judge'; // as an organizer would paste it
const DEVPOST = 'https://devpost.com/software/not-captured-here';
const REVISION = '9459c9830086e9c7bf889ff22aaf9c19a1369d5d';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe.each(testDatabaseTargets())(
  'real-workflow capture of a recorded real repository on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let app: ApiApp;
    let eventContext: EventContextService;

    const api: ApiFn = async (method, path, body, headers) => {
      const response = await app.inject({
        method,
        url: path,
        headers: { ...bearer(TEST_TOKENS.organizer), ...headers },
        ...(body === undefined ? {} : { payload: body as object }),
      });
      const json: unknown = response.json<unknown>();
      if (response.statusCode < 300) return { ok: true, data: json as never };
      const parsed = ApiErrorBody.parse(json);
      return {
        ok: false,
        status: response.statusCode,
        code: parsed.error.code,
        message: parsed.error.message,
        issues: [],
        details: parsed.error.details,
      };
    };
    const read = async <T>(path: string): Promise<T> => {
      const result = await api<T>('GET', path);
      if (!result.ok) throw new Error(`${path}: ${result.code}`);
      return result.data;
    };

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      const fixtures = await loadFixtures();
      eventContext = replayService(db, fixtures.values());
      app = buildApp({
        logger,
        db,
        verifier: fakeVerifier(),
        eventContext,
        projects: new ProjectService({ db }),
        assessments: new AssessmentService({ db, offline: null }),
      });
    });
    afterAll(async () => {
      await app.close();
      await testDb.close();
    });

    async function lockedEvent(): Promise<string> {
      const fixtures = await loadFixtures();
      return (
        await lockedEventFromRecording(
          eventContext,
          requireValue(fixtures.get('fixture-e-multiple-tracks')),
        )
      ).eventId;
    }

    /** The worker, serving the recorded GitHub world; every other host is unknown to it (as devpost.com is to the real environment). */
    async function drain(world: FixtureWorld = RECORDED) {
      const network = createFixtureNetwork(world);
      const http = createSafeHttpClient({
        resolver: network.resolver,
        transport: network.transport,
      });
      const setup = await captureSetup(db, {
        adapters: createAdapterRegistry({ http, githubLimits: { maxFiles: 4, maxCommits: 5 } }),
      });
      await setup.loop.drain();
      return network;
    }

    it('submit -> capture -> read: one project, exact commit, verified files, a failed Devpost capture with no content, nothing assessed', async () => {
      const eventId = await lockedEvent();
      const before = {
        assessments: (await db.select().from(preInterviewAssessments)).length,
        requests: (await db.select().from(assessmentRequests)).length,
        calls: (await db.select().from(assessmentRunCalls)).length,
      };
      const outcome = await runSubmission(
        api,
        eventId,
        { github: GITHUB, devpost: DEVPOST, name: '' },
        randomUUID(),
      );
      expect(outcome).toMatchObject({
        kind: 'started',
        result: 'created',
        projectName: 'meetbhadra701-cloud/judge',
      });
      const projectId = outcome.kind === 'started' ? outcome.projectId : '';
      const network = await drain();

      // the project is ONE identity: one GitHub source, one Devpost source, both in canonical form
      const project = await read<ProjectDetail>(`/projects/${projectId}`);
      expect(project.sources.map((s) => [s.sourceType, s.url])).toEqual([
        ['github', 'https://github.com/meetbhadra701-cloud/judge'],
        ['devpost', DEVPOST],
      ]);
      const github = requireValue(
        project.sources.find((s) => s.sourceType === 'github')?.latestSnapshot,
      );
      const devpost = requireValue(
        project.sources.find((s) => s.sourceType === 'devpost')?.latestSnapshot,
      );

      // GitHub: a partial capture of the recorded repository, with the reasons stated
      expect(github).toMatchObject({ status: 'partial', revision: REVISION, captureNumber: 1 });
      expect(github.partialReasons).toEqual(
        expect.arrayContaining(['commit_limit', 'file_count_limit']),
      );
      const detail = await read<SnapshotDetail>(`/projects/${projectId}/snapshots/${github.id}`);
      expect(detail.run).toMatchObject({ state: 'succeeded', failureCategory: null });
      expect(detail.artifacts.map((a) => a.kind).filter((k) => k === 'file')).toHaveLength(4);
      // the content hash the API reports is recomputable from the stored artifacts, by this test, independently
      for (const artifact of detail.artifacts) {
        const stored = (await db.select().from(sourceSnapshotArtifacts)).find(
          (row) => row.id === artifact.id,
        );
        expect(stored?.contentHash).toBe(artifact.contentHash);
        expect(sha256(stored?.textContent ?? '')).toBe(artifact.contentHash);
      }
      // the artifact text served by the API is the text of GitHub's own blob for that path (independent comparison with the recording)
      const tree = (
        RECORDED.routes[
          `https://api.github.com/repos/meetbhadra701-cloud/judge/git/trees/${requireValue(detail.metadata)['treeSha'] as string}?recursive=1`
        ]?.json as {
          tree: { path: string; sha: string }[];
        }
      ).tree;
      for (const artifact of detail.artifacts.filter((a) => a.kind === 'file')) {
        const listed = requireValue(tree.find((entry) => `files/${entry.path}` === artifact.key));
        const blob = RECORDED.routes[
          `https://api.github.com/repos/meetbhadra701-cloud/judge/git/blobs/${listed.sha}`
        ]?.json as { content: string };
        const served = await read<{ textContent: string }>(
          `/projects/${projectId}/snapshots/${github.id}/artifacts/${artifact.id}`,
        );
        expect(served.textContent).toBe(
          Buffer.from(blob.content.replace(/\s+/g, ''), 'base64').toString('utf8'),
        );
      }

      // Devpost: the source is unreachable here; the record says so, precisely, and holds no page text at all
      expect(devpost.status).toBe('failed');
      expect(devpost.failureCategory).not.toBeNull();
      expect(devpost.artifactCount).toBe(0);
      expect(devpost.contentHash).toBeNull();
      const devpostView = describeCapture(devpost);
      expect(devpostView.stage).toMatch(/failed/);
      expect(devpostView).toMatchObject({ hasContent: false, retryable: true });
      expect(describeCapture(github).hasContent).toBe(true);

      // nothing but the repository's API host was contacted for GitHub; the Devpost host was never reached (unknown to the network)
      expect(network.contacts.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);

      // capturing is not assessing: no claim, evidence, unknown, assessment request, assessment or model call exists
      const own = (rows: { projectId?: string | null }[]) =>
        rows.filter((row) => row.projectId === projectId).length;
      expect([
        own(await db.select().from(claims)),
        own(await db.select().from(evidenceItems)),
        own(await db.select().from(unknowns)),
        (await db.select().from(preInterviewAssessments)).length - before.assessments,
        (await db.select().from(assessmentRequests)).length - before.requests,
        (await db.select().from(assessmentRunCalls)).length - before.calls,
      ]).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it('a retry of the unreachable source adds a snapshot, never rewrites the failed one; the GitHub snapshot is untouched', async () => {
      const eventId = await lockedEvent();
      const started = await runSubmission(
        api,
        eventId,
        { github: GITHUB, devpost: DEVPOST, name: '' },
        randomUUID(),
      );
      const projectId = started.kind === 'started' ? started.projectId : '';
      await drain();
      const first = await read<ProjectDetail>(`/projects/${projectId}`);
      const devpostSource = requireValue(first.sources.find((s) => s.sourceType === 'devpost'));
      const frozen = JSON.stringify(await read(`/projects/${projectId}/snapshots`));
      const retry = await api(
        'POST',
        `/projects/${projectId}/sources/${devpostSource.id}/captures`,
      );
      expect(retry.ok).toBe(true);
      await drain();
      const snapshots = (
        await read<{
          snapshots: { captureNumber: number; sourceType: string; status: string; id: string }[];
        }>(`/projects/${projectId}/snapshots`)
      ).snapshots;
      expect(
        snapshots
          .filter((s) => s.sourceType === 'devpost')
          .map((s) => [s.captureNumber, s.status])
          .sort(),
      ).toEqual([
        [1, 'failed'],
        [2, 'failed'],
      ]);
      // the earlier snapshots are exactly what they were
      const earlier = JSON.parse(frozen) as { snapshots: { id: string }[] };
      for (const old of earlier.snapshots) {
        expect(JSON.stringify(snapshots.find((s) => s.id === old.id))).toBe(JSON.stringify(old));
      }
    });

    it('a second project captured by the same worker keeps its own sources: nothing crosses between projects or events', async () => {
      const eventId = await lockedEvent();
      const otherEventId = await lockedEvent();
      const one = await runSubmission(
        api,
        eventId,
        { github: GITHUB, devpost: DEVPOST, name: '' },
        randomUUID(),
      );
      // the SAME pair submitted to another event is an independent project with its own snapshots
      const two = await runSubmission(
        api,
        otherEventId,
        { github: GITHUB, devpost: DEVPOST, name: '' },
        randomUUID(),
      );
      expect([one.kind, two.kind]).toEqual(['started', 'started']);
      const [a, b] = [one, two].map((o) => (o.kind === 'started' ? o.projectId : ''));
      await drain();
      const [pa, pb] = await Promise.all([
        read<ProjectDetail>(`/projects/${a}`),
        read<ProjectDetail>(`/projects/${b}`),
      ]);
      expect(a).not.toBe(b);
      for (const project of [pa, pb]) {
        for (const source of project.sources)
          expect(source.latestSnapshot?.projectId).toBe(project.id);
      }
      expect(requireValue(pa.sources[0]?.latestSnapshot).id).not.toBe(
        requireValue(pb.sources[0]?.latestSnapshot).id,
      );
      expect(pa.sources[0]?.latestSnapshot?.contentHash).toBe(
        pb.sources[0]?.latestSnapshot?.contentHash,
      ); // same material, same hash, separate rows
    });
  },
);
