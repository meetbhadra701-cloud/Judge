import type {
  AssessmentDetail,
  AssessmentListResponse,
  AssessmentRunView,
} from '../../packages/schemas/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  classifyOverall,
  classifyPage,
  explainFailure,
  runToExplain,
} from '../../apps/web/lib/assessment-view.js';

const usage = {
  attemptsStarted: 0,
  settledCalls: 0,
  unknownCalls: 0,
  releasedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costNanoUsd: 0,
};

function run(overrides: Partial<AssessmentRunView>): AssessmentRunView {
  return {
    id: 'r1',
    projectId: 'p',
    state: 'failed',
    mode: 'assess',
    failureCategory: 'provider_error',
    failureCode: null,
    stageReached: null,
    providerMode: 'replay',
    replayDemonstration: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    assessmentId: null,
    usage,
    guard: {} as unknown as AssessmentRunView['guard'],
    ...overrides,
  };
}

function list(overrides: Partial<AssessmentListResponse>): AssessmentListResponse {
  return {
    assessments: [],
    activeRun: null,
    latestRun: null,
    launch: { available: true, providerMode: 'replay', notice: 'n' },
    notice: 'x' as AssessmentListResponse['notice'],
    ...overrides,
  };
}

function detail(overall: unknown, verified = true): AssessmentDetail {
  return {
    verified,
    report: verified ? { overall } : null,
  } as unknown as AssessmentDetail;
}

describe('assessment page state (classification only: no number is ever produced)', () => {
  it('distinguishes the seven UI states', () => {
    expect(classifyPage(list({}), null)).toBe('none');
    expect(classifyPage(list({ activeRun: run({ state: 'running' }) }), null)).toBe('in_progress');
    expect(classifyPage(list({ latestRun: run({ state: 'failed' }) }), null)).toBe('run_failed');
    expect(classifyPage(list({ latestRun: run({ state: 'cancelled' }) }), null)).toBe('run_failed');
    expect(classifyOverall(detail({ state: 'scored' }))).toBe('scored');
    expect(classifyOverall(detail({ state: 'scored_partial' }))).toBe('scored_partial');
    expect(classifyOverall(detail({ state: 'insufficient_evidence' }))).toBe(
      'insufficient_evidence',
    );
    expect(classifyOverall(detail({ state: 'not_computed' }))).toBe('insufficient_evidence');
    expect(classifyOverall(detail(null, false))).toBe('unverified');
  });

  it('classifies an unverified assessment as unverified however much content it carries (P6A-R1)', () => {
    // verified=false with a report that looks perfectly scored: the flag wins, never the content
    expect(classifyOverall(detail({ state: 'scored' }, false))).toBe('unverified');
    const hostile = {
      verified: false,
      report: { overall: { state: 'scored', score10: 10 } },
    } as unknown as AssessmentDetail;
    expect(classifyOverall(hostile)).toBe('unverified');
    expect(classifyPage(list({ assessments: [{ id: 'a' } as never] }), hostile)).toBe('unverified');
    // verified=true without a report is not a score of zero
    expect(classifyOverall({ verified: true, report: null } as unknown as AssessmentDetail)).toBe(
      'unverified',
    );
    // an unknown overall state is never promoted to a scored one
    expect(classifyOverall(detail({ state: 'something_new' }))).toBe('insufficient_evidence');
  });

  it('never presents a failed run as a success, and keeps a failure newer than the last assessment visible', () => {
    const failed = run({ id: 'r2', state: 'failed', createdAt: '2026-01-03T00:00:00.000Z' });
    const older = {
      id: 'a1',
      runId: 'r1',
      createdAt: '2026-01-02T00:00:00.000Z',
    } as AssessmentListResponse['assessments'][number];
    expect(runToExplain(list({ assessments: [older], latestRun: failed }))).toBe(failed);
    // a failure older than the newest assessment no longer hides it
    expect(
      runToExplain(
        list({
          assessments: [{ ...older, createdAt: '2026-01-04T00:00:00.000Z' }],
          latestRun: failed,
        }),
      ),
    ).toBeNull();
    expect(explainFailure(failed)).not.toMatch(/success/i);
  });
});
