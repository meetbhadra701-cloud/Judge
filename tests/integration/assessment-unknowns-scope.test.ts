/*
 * P6B-beta1 (R7A finding on unknowns): the unknowns shown beside an assessment are the unknowns of THAT assessment's own pinned graph
 * extraction, never the project's unknowns in general.
 *
 * The scenario is the one that exposed the defect: a project is assessed with only its Devpost page captured (the GitHub repository is a
 * recorded gap), the repository is captured afterwards, and the project is assessed again. The first assessment must keep telling the
 * truth about ITS material (and say that newer captures exist), the second must not repeat a gap that its own material resolved, and
 * neither may carry the other's, or duplicate, unknowns. Real pipeline, real API read routes, real database; no model.
 */
import { randomUUID } from 'node:crypto';
import { ApiErrorBody } from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  graphExtractionItems,
  preInterviewAssessments,
  unknowns,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { EvidenceGraphStore } from '../../packages/database/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { EvidenceGraphService } from '../../apps/api/src/evidence-graph/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { bearer, fakeVerifier, TEST_TOKENS } from '../../apps/api/src/testing/harness.js';
import {
  README_TEXT,
  seedLaterCapture,
  seedSnapshot,
  seedWorld,
  SOURCE_CODE_TEXT,
} from '../../apps/worker/src/testing/assessment-world.js';
import { corruptions } from '../../apps/worker/src/testing/corrupt.js';
import { testDatabaseTargets, type TestDatabase } from '../../apps/worker/src/testing/harness.js';
import { execute } from '../../apps/worker/src/testing/run.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const GITHUB_MISSING = 'The GitHub repository was not provided';

interface UnknownsBody {
  assessmentId: string;
  versionNumber: number;
  verified: boolean;
  scope: string;
  items: { id: string; unknownType: string; text: string; occurrences: number }[];
  currency: {
    upToDate: boolean;
    newerCaptures: {
      sourceType: string;
      pinnedCaptureNumber: number | null;
      newerCaptureNumber: number;
      newerStatus: string;
    }[];
  } | null;
  notice: string;
}

describe.each(testDatabaseTargets())('assessment-scoped unknowns on %s', (_name, open) => {
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
      projects: new ProjectService({ db }),
      evidenceGraph: new EvidenceGraphService({ store: new EvidenceGraphStore({ db }) }),
      assessments: new AssessmentService({ db, offline: null }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  async function get(url: string, token: string = TEST_TOKENS.organizer) {
    const response = await app.inject({ method: 'GET', url, headers: bearer(token) });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }
  async function scoped(projectId: string, assessmentId: string): Promise<UnknownsBody> {
    const response = await get(`/projects/${projectId}/assessments/${assessmentId}/unknowns`);
    expect(response.status).toBe(200);
    return response.body as unknown as UnknownsBody;
  }

  it('derives each assessment’s unknowns from its own pinned extraction, and reassessment after a source arrives does not repeat or lose anything', async () => {
    // 1. only Devpost is captured: the GitHub repository is a recorded gap
    const first = await execute(db, { worldOptions: { sources: ['devpost'] } });
    expect(first.outcome.kind).toBe('succeeded');
    const world = first.world;
    const projectId = world.project.id;
    const [a1] = await first.assessments();
    const v1 = await scoped(projectId, a1?.id ?? '');
    expect(v1).toMatchObject({
      verified: true,
      versionNumber: 1,
      scope: 'assessment_pinned_extraction',
    });
    expect(v1.items.some((item) => item.text.startsWith(GITHUB_MISSING))).toBe(true);
    expect(v1.currency).toEqual({ upToDate: true, newerCaptures: [] });
    // the items are exactly the members of that assessment's extraction, and nothing else
    const members = (await db.select().from(graphExtractionItems)).filter(
      (item) => item.extractionId === a1?.extractionId,
    );
    const memberIds = new Set(
      members.filter((item) => item.recordType === 'unknown').map((item) => item.recordId),
    );
    expect(v1.items.every((item) => memberIds.has(item.id))).toBe(true);
    const v1Before = JSON.stringify(v1);

    // 2. the repository is captured AFTER the first assessment: the first one still describes ITS material, and says newer captures exist
    await seedSnapshot(db, world.project, 'github', 'captured', [
      { key: 'files/README.md', kind: 'file', mediaType: 'text/markdown', text: README_TEXT },
      { key: 'files/src/remind.ts', kind: 'file', mediaType: 'text/plain', text: SOURCE_CODE_TEXT },
    ]);
    const v1Stale = await scoped(projectId, a1?.id ?? '');
    expect(v1Stale.items).toEqual(v1.items); // the historical report is unchanged ...
    expect(v1Stale.currency).toMatchObject({ upToDate: false });
    expect(v1Stale.currency?.newerCaptures).toEqual([
      expect.objectContaining({
        sourceType: 'github',
        pinnedCaptureNumber: null,
        newerCaptureNumber: 1,
        newerStatus: 'captured',
      }),
    ]); // ... and it is not presented as the project's current state

    // 3. reassessment over the new material
    const second = await execute(db, { world });
    expect(second.outcome.kind).toBe('succeeded');
    const [a2] = await second.assessments();
    const v2 = await scoped(projectId, a2?.id ?? '');
    expect(v2).toMatchObject({ verified: true, versionNumber: 2 });
    expect(v2.items.some((item) => item.text.startsWith(GITHUB_MISSING))).toBe(false); // resolved by ITS material
    expect(v2.currency).toEqual({ upToDate: true, newerCaptures: [] });
    // no unknown row is shared between the two assessments
    expect(new Set(v1.items.map((item) => item.id)).size).toBe(v1.items.length);
    expect(v2.items.some((item) => v1.items.some((old) => old.id === item.id))).toBe(false);
    // within one assessment nothing is listed twice
    for (const body of [v1, v2]) {
      const keys = body.items.map((item) => `${item.unknownType}\u0000${item.text}`);
      expect(new Set(keys).size).toBe(keys.length);
    }

    // 4. the old, project-wide list is the union of every reading: exactly the stale + duplicated view the report must not use
    const everything = (await db.select().from(unknowns)).filter(
      (row) => row.projectId === projectId,
    );
    expect(everything.length).toBeGreaterThan(v2.items.length);
    expect(everything.some((row) => row.text.startsWith(GITHUB_MISSING))).toBe(true);

    // 5. the historical report is reproducible byte for byte after the newer one exists
    const v1Again = await scoped(projectId, a1?.id ?? '');
    expect(v1Again.currency).toMatchObject({ upToDate: false });
    expect(JSON.stringify({ ...v1Again, currency: v1.currency })).toBe(v1Before);
    const stored = (await db.select().from(preInterviewAssessments)).filter(
      (row) => row.id === a1?.id,
    );
    expect(stored).toHaveLength(1);
  });

  it('a newer capture that FAILED is reported, so a pinned older capture is not mistaken for the latest state', async () => {
    const run = await execute(db, { worldOptions: { sources: ['devpost', 'github'] } });
    const [assessment] = await run.assessments();
    const world = run.world;
    // a second capture attempt of the GitHub source fails (a new snapshot of the same declared source)
    const githubSource = world.snapshots['github']?.source;
    if (!githubSource) throw new Error('no github source');
    await seedLaterCapture(db, world.project, githubSource, 'failed');
    const body = await scoped(world.project.id, assessment?.id ?? '');
    expect(body.currency?.upToDate).toBe(false);
    expect(body.currency?.newerCaptures).toEqual([
      expect.objectContaining({
        sourceType: 'github',
        pinnedCaptureNumber: 1,
        newerCaptureNumber: 2,
        newerStatus: 'failed',
      }),
    ]);
  });

  it('fails closed for an assessment that does not verify, and never reveals another project’s assessment', async () => {
    const run = await execute(db, { worldOptions: { sources: ['devpost'] } });
    const [assessment] = await run.assessments();
    const projectId = run.world.project.id;
    const good = await scoped(projectId, assessment?.id ?? '');
    expect(good.items.length).toBeGreaterThan(0);

    const other = await seedWorld(db, { sources: ['devpost'] });
    const foreign = await get(
      `/projects/${other.project.id}/assessments/${assessment?.id ?? ''}/unknowns`,
    );
    expect([foreign.status, ApiErrorBody.parse(foreign.body).error.code]).toEqual([
      404,
      'ASSESSMENT_NOT_FOUND',
    ]);
    const missing = await get(`/projects/${projectId}/assessments/${randomUUID()}/unknowns`);
    expect(missing.status).toBe(404);

    await corruptions.judgmentScores(db, assessment?.id ?? '');
    const withheld = await scoped(projectId, assessment?.id ?? '');
    expect(withheld).toMatchObject({ verified: false, items: [], currency: null });
  });

  it('is read-only and requires the assessment read permission', async () => {
    const run = await execute(db, { worldOptions: { sources: ['devpost'] } });
    const [assessment] = await run.assessments();
    const url = `/projects/${run.world.project.id}/assessments/${assessment?.id ?? ''}/unknowns`;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url,
        headers: bearer(TEST_TOKENS.organizer),
        payload: {},
      });
      expect(response.statusCode).toBe(405);
    }
    expect((await get(url, TEST_TOKENS.noRole)).status).toBe(403);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await get(url, TEST_TOKENS.judge)).status).toBe(200);
  });
});
