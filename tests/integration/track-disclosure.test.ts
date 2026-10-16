import type { AssessmentDetail, AssessmentListResponse } from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JudgeDatabase } from '../../packages/database/src/index.js';
import { ScriptedProvider } from '../../packages/llm/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
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
 * M6 phase 0 (R8B P3-3): the report says which tracks the project declared and which rubric was assessed. Only the OVERALL rubric is scored; a track's
 * own rubric is disclosed as not assessed, in the API (`trackContext`) and never folded into any number.
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
};

describe.each(testDatabaseTargets())('track rubric disclosure on %s', (_name, open) => {
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
      assessments: new AssessmentService({
        db,
        offline: { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS },
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  const detailOf = async (projectId: string): Promise<AssessmentDetail> => {
    const get = async <T>(url: string) =>
      (await app.inject({ method: 'GET', url, headers: bearer(TEST_TOKENS.organizer) })).json<T>();
    const list = await get<AssessmentListResponse>(`/projects/${projectId}/assessments`);
    return get<AssessmentDetail>(
      `/projects/${projectId}/assessments/${list.assessments[0]?.id ?? ''}`,
    );
  };
  const run = (worldOptions: Parameters<typeof execute>[1] extends infer S ? S : never) =>
    execute(db, {
      ...(worldOptions as object),
      provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
    });

  it('a project that declared a track with its own rubric: the overall rubric is the assessed one and the track rubric is listed as NOT assessed', async () => {
    const result = await run({
      worldOptions: {
        trackKeys: ['health', 'climate'],
        trackRubricKeys: ['health'],
        declare: ['health'],
      },
    });
    expect(result.outcome.kind).toBe('succeeded');
    const detail = await detailOf(result.world.project.id);
    expect(detail.trackContext).toEqual({
      assessedRubric: { scope: 'overall', name: 'Official rubric' },
      declaredTracks: [{ key: 'health', name: 'Track health' }],
      unassessedTrackRubrics: [
        { trackKey: 'health', trackName: 'Track health', rubricName: 'Track health rubric' },
      ],
    });
    // the track rubric's criterion has no judgment and no number anywhere in the report
    expect(JSON.stringify(detail.report?.dimensions)).not.toContain('health_impact');
    expect(detail.judgments.map((j) => j.dimensionId)).not.toContain('track.health.health_impact');
    expect(detail.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'official_track_rubrics_not_assessed' }),
      ]),
    );
  });

  it('a project that declared a track WITHOUT a published rubric lists the track and no unassessed rubric; one that declared none says so', async () => {
    const withTrack = await run({ worldOptions: { trackKeys: ['health'], declare: ['health'] } });
    const a = await detailOf(withTrack.world.project.id);
    expect(a.trackContext).toMatchObject({
      declaredTracks: [{ key: 'health', name: 'Track health' }],
      unassessedTrackRubrics: [],
    });
    const none = await run({ worldOptions: { trackKeys: ['health'] } });
    const b = await detailOf(none.world.project.id);
    expect(b.trackContext).toMatchObject({ declaredTracks: [], unassessedTrackRubrics: [] });
  });

  it('a rubric of a track the project did NOT declare is not claimed as relevant to this project', async () => {
    const result = await run({
      worldOptions: {
        trackKeys: ['health', 'climate'],
        trackRubricKeys: ['climate'],
        declare: ['health'],
      },
    });
    const detail = await detailOf(result.world.project.id);
    expect(detail.trackContext?.unassessedTrackRubrics).toEqual([]);
    expect(detail.trackContext?.declaredTracks).toEqual([{ key: 'health', name: 'Track health' }]);
  });
});
