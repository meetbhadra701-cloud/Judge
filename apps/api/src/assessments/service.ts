import {
  AssessmentReadStore,
  AssessmentRunError,
  AssessmentRunStore,
  type JudgeDatabase,
  type RequestAssessmentResult,
} from '@judge-copilot/database';
import {
  ASSESSMENT_API_NOTICE,
  ASSESSMENT_DEMONSTRATION_NOTICE,
  type AssessmentDetail,
  type AssessmentCoverageRecordResponse,
  type AssessmentUnknownsResponse,
  type AssessmentLaunchView,
  type AssessmentListResponse,
  type AssessmentRunView,
  type CreateAssessmentRequest,
  type CreateAssessmentResponse,
} from '@judge-copilot/schemas';
import { AssessmentApiError } from './errors.js';
import { frozenRequestParts } from './pipeline-config.js';
import type { OfflineAssessmentRuntime } from './runtime-gate.js';

export interface AssessmentServiceOptions {
  readonly db: JudgeDatabase;
  /** The approved offline runtime, or null: reading still works, requesting answers 503. */
  readonly offline: OfflineAssessmentRuntime | null;
}

export interface RequestOutcome {
  readonly status: 200 | 202;
  readonly body: CreateAssessmentResponse;
}

/**
 * Requesting and reading pre-interview assessments. A request only CREATES A PENDING RUN (one short database transaction inside the P4
 * run store, which also freezes the pins, the configuration and the limits); the worker executes it outside any request. Nothing here
 * calls a model, reads a prompt or opens a transaction of its own. Every lookup is scoped to the project in the URL.
 */
export class AssessmentService {
  private readonly runs: AssessmentRunStore;
  private readonly reads: AssessmentReadStore;
  private readonly offline: OfflineAssessmentRuntime | null;

  constructor(options: AssessmentServiceOptions) {
    this.runs = new AssessmentRunStore({ db: options.db });
    this.reads = new AssessmentReadStore(options.db);
    this.offline = options.offline;
  }

  private async requireProject(projectId: string): Promise<void> {
    if (!(await this.reads.projectExists(projectId))) {
      throw new AssessmentApiError('PROJECT_NOT_FOUND', 'Project not found');
    }
  }

  launchView(): AssessmentLaunchView {
    return this.offline === null
      ? {
          available: false,
          providerMode: null,
          notice: 'No assessment provider is configured, so no assessment can be requested.',
        }
      : {
          available: true,
          providerMode: this.offline.provider.mode,
          notice:
            this.offline.provider.mode === 'scripted'
              ? 'SCRIPTED DEMONSTRATION: fixed placeholder answers are produced by rules that do not read the project; no model is called, no project text leaves this system, and the resulting scores say nothing about the project.'
              : 'Offline replay demonstration: hand-written synthetic outputs are replayed; no model is called and no project text leaves this system.',
        };
  }

  async request(
    projectId: string,
    actorId: string,
    idempotencyKey: string,
    body: CreateAssessmentRequest,
  ): Promise<RequestOutcome> {
    if (this.offline === null) {
      throw new AssessmentApiError(
        'ASSESSMENT_PROVIDER_NOT_CONFIGURED',
        'No assessment provider is configured',
      );
    }
    const frozen = frozenRequestParts(this.offline);
    let result: RequestAssessmentResult;
    try {
      result = await this.runs.requestAssessment({
        projectId,
        actorId,
        idempotencyKey,
        mode: body.mode,
        target: { kind: 'overall' },
        pipelineConfig: frozen.pipelineConfig,
        limits: frozen.limits,
        priceTableId: frozen.priceTableId,
      });
    } catch (error) {
      if (error instanceof AssessmentRunError && error.code === 'run_not_found') {
        throw new AssessmentApiError('PROJECT_NOT_FOUND', 'Project not found');
      }
      throw error;
    }
    return this.respond(projectId, result);
  }

  private async respond(
    projectId: string,
    result: RequestAssessmentResult,
  ): Promise<RequestOutcome> {
    switch (result.kind) {
      case 'run_created':
        return {
          status: 202,
          body: { result: 'run_created', runId: result.runId, state: 'pending', replayed: false },
        };
      case 'run_active': {
        const run = await this.reads.getRun(projectId, result.runId);
        return {
          status: 202,
          body: {
            result: 'run_active',
            runId: result.runId,
            state: run?.state === 'running' ? 'running' : 'pending',
            replayed: true,
          },
        };
      }
      case 'run_succeeded':
        return {
          status: 200,
          body: {
            result: 'assessment_ready',
            assessmentId: result.assessmentId,
            runId: result.runId,
            replayed: true,
          },
        };
      case 'already_assessed':
        return {
          status: 200,
          body: {
            result: 'already_assessed',
            assessmentId: result.assessmentId,
            runId: null,
            replayed: result.replayed,
          },
        };
      case 'run_failed':
        return {
          status: 200,
          body: {
            result: 'run_failed',
            runId: result.runId,
            state: result.state,
            failureCategory: result.failureCategory,
            replayed: true,
          },
        };
      case 'key_reused':
        throw new AssessmentApiError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request',
        );
      case 'run_active_conflict':
        throw new AssessmentApiError(
          'ASSESSMENT_RUN_ACTIVE',
          'An assessment of this project is already pending or running',
          { runId: result.runId },
        );
      case 'project_voided':
        throw new AssessmentApiError(
          'PROJECT_VOIDED',
          'This project was voided by an organizer; request the assessment on its replacement',
        );
      case 'no_locked_context':
        throw new AssessmentApiError(
          'NO_LOCKED_CONTEXT',
          'The project’s event has no locked Event Context',
        );
      case 'no_source_snapshots':
        throw new AssessmentApiError(
          'NO_SOURCE_SNAPSHOTS',
          'The project has no captured source to assess',
        );
      case 'no_context_reference_evidence':
        throw new AssessmentApiError(
          'NO_CONTEXT_REFERENCE_EVIDENCE',
          result.unofficialStatements > 0
            ? `The locked Event Context states ${String(result.unofficialStatements)} rule(s) or requirement(s) as explicit, but none of them cites an official source (the official rules, rubric or track rules), so none can be used as official reference for an assessment. Nothing was queued or spent. Cite the official source for each statement in a new Event Context version, lock it, and request the assessment again.`
            : result.contextDefinesTracks && result.declaredTrackKeys.length === 0
              ? 'The locked Event Context offers an assessment nothing to refer to for this project: it has no explicit event-wide rule or submission requirement, and its only reference material is track-specific, but this project declared no track. Nothing was queued or spent. A project’s tracks are chosen when it is submitted and are never edited afterwards: ask an organizer to void this submission and submit it again with its track selected, or add an explicit event rule or requirement in a new Event Context version, lock it, and request the assessment again.'
              : 'The locked Event Context has no explicit rule, no explicit submission requirement and no declared track for an assessment to refer to. Nothing was queued or spent. Add an explicit rule or requirement (marked as stated in an official source) in a new Event Context version, lock it, and request the assessment again.',
          {
            contextDefinesTracks: result.contextDefinesTracks,
            declaredTrackKeys: [...result.declaredTrackKeys],
            unofficialStatements: result.unofficialStatements,
          },
        );
      case 'no_overall_rubric':
        throw new AssessmentApiError(
          'NO_OVERALL_RUBRIC',
          `The locked Event Context has no official overall rubric${result.trackRubrics > 0 ? ` (it has ${String(result.trackRubrics)} track rubric(s), and track rubrics are not assessed in this version)` : ''}. An assessment is made against the event’s overall rubric only, and no substitute rubric is invented. Nothing was queued or spent. Add the event’s overall judging rubric in a new Event Context version, lock it, and request the assessment again.`,
          { trackRubrics: result.trackRubrics },
        );
      case 'track_not_in_context':
        throw new AssessmentApiError(
          'NO_LOCKED_CONTEXT',
          'The declared tracks are not part of the locked Event Context',
        );
    }
  }

  async list(projectId: string): Promise<AssessmentListResponse> {
    await this.requireProject(projectId);
    const assessments = await this.reads.list(projectId);
    return {
      assessments,
      activeRun: await this.reads.activeRun(projectId),
      latestRun: await this.reads.latestRun(projectId),
      launch: this.launchView(),
      // the project-level line says "AI estimate" only when a real (live) assessment is listed; no live provider exists yet, and an offline
      // demonstration must never lead with a claim that a model estimated anything (P6D)
      notice: assessments.some((assessment) => !assessment.replayDemonstration)
        ? ASSESSMENT_API_NOTICE
        : ASSESSMENT_DEMONSTRATION_NOTICE,
    };
  }

  async get(projectId: string, assessmentId: string): Promise<AssessmentDetail> {
    const detail = await this.reads.getDetail(projectId, assessmentId);
    if (!detail) throw new AssessmentApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    return detail;
  }

  async getUnknowns(projectId: string, assessmentId: string): Promise<AssessmentUnknownsResponse> {
    const unknowns = await this.reads.getUnknowns(projectId, assessmentId);
    if (!unknowns) throw new AssessmentApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    return unknowns;
  }

  async getCoverage(
    projectId: string,
    assessmentId: string,
  ): Promise<AssessmentCoverageRecordResponse> {
    const coverage = await this.reads.getCoverage(projectId, assessmentId);
    if (!coverage) throw new AssessmentApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    return coverage;
  }

  async getRun(projectId: string, runId: string): Promise<AssessmentRunView> {
    const run = await this.reads.getRun(projectId, runId);
    if (!run) throw new AssessmentApiError('ASSESSMENT_RUN_NOT_FOUND', 'Assessment run not found');
    return run;
  }
}
