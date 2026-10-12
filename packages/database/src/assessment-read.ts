import { classifyDisposition } from '@judge-copilot/assessment';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  ASSESSMENT_API_NOTICE,
  ASSESSMENT_RUN_TYPE,
  ScoreReport,
  type AssessmentDetail,
  type AssessmentGuardView,
  type AssessmentJudgmentView,
  type AssessmentLimitationView,
  type AssessmentRunView,
  type AssessmentSummary,
  type AssessmentUsageView,
  type JudgmentCitationView,
  type ProviderMode,
} from '@judge-copilot/schemas';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AssessmentStore } from './assessment-store.js';
import type { JudgeDatabase } from './client.js';
import {
  analysisRuns,
  assessmentRequests,
  assessmentRunBudget,
  assessmentRunCalls,
  assessmentRunInputs,
  assessmentRunOutcomes,
  evidenceItems,
  preInterviewAssessments,
  projects,
} from './schema/index.js';

/*
 * The READ MODEL of the pre-interview assessment (M5 P6A): what the API and the UI may show. It never writes and never calls a model.
 *
 *   isolation   every query is keyed by the project: an assessment or run of another project is indistinguishable from a missing one
 *               (the methods return null), so identifiers never reveal objects of other projects.
 *   honesty     a stored assessment is RE-VERIFIED on every read (text hash, schema, M4 output hash). A report that fails
 *               verification is not returned. An insufficient dimension has no score of any kind. A failed or cancelled run has no
 *               assessment, and its outcome is reported as recorded (code, stage, totals).
 *   labels      the replay demonstration flag is derived from the stored provider mode, never from a client.
 */

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

interface ConfigFacts {
  readonly providerMode: ProviderMode | null;
  readonly provider: { id: string; mode: ProviderMode } | null;
  readonly models: { extraction: string; assessment: string; critic: string } | null;
}

function configFacts(config: Record<string, unknown>): ConfigFacts {
  const provider = config['provider'] as { id?: unknown; mode?: unknown } | undefined;
  const models = config['models'] as Record<string, unknown> | undefined;
  const mode = provider?.mode;
  const validMode = mode === 'live' || mode === 'replay' || mode === 'scripted';
  return {
    providerMode: validMode ? mode : null,
    provider: validMode && typeof provider?.id === 'string' ? { id: provider.id, mode } : null,
    models:
      typeof models?.['extraction'] === 'string' &&
      typeof models['assessment'] === 'string' &&
      typeof models['critic'] === 'string'
        ? {
            extraction: models['extraction'],
            assessment: models['assessment'],
            critic: models['critic'],
          }
        : null,
  };
}

const isDemonstration = (mode: ProviderMode | null): boolean =>
  mode === 'replay' || mode === 'scripted';

const REPLAY_NOTICE =
  'REPLAY DEMONSTRATION — replayed hand-written synthetic outputs, not a live model assessment.';

export class AssessmentReadStore {
  private readonly store: AssessmentStore;

  constructor(private readonly db: JudgeDatabase) {
    this.store = new AssessmentStore(db);
  }

  async projectExists(projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row !== undefined;
  }

  // -- Runs ---------------------------------------------------------------------------------------------------------------

  private async usageOf(runId: string): Promise<AssessmentUsageView> {
    const [row] = await this.db
      .select({
        attempts: sql<number>`count(*)`.mapWith(Number),
        settled:
          sql<number>`count(*) filter (where ${assessmentRunCalls.state} = 'settled')`.mapWith(
            Number,
          ),
        unknown:
          sql<number>`count(*) filter (where ${assessmentRunCalls.state} = 'unknown')`.mapWith(
            Number,
          ),
        released:
          sql<number>`count(*) filter (where ${assessmentRunCalls.state} = 'released')`.mapWith(
            Number,
          ),
        input: sql<number>`coalesce(sum(${assessmentRunCalls.inputTokens}), 0)`.mapWith(Number),
        output: sql<number>`coalesce(sum(${assessmentRunCalls.outputTokens}), 0)`.mapWith(Number),
        cost: sql<number>`coalesce(sum(${assessmentRunCalls.costNanoUsd}), 0)`.mapWith(Number),
      })
      .from(assessmentRunCalls)
      .where(eq(assessmentRunCalls.runId, runId));
    return {
      attemptsStarted: row?.attempts ?? 0,
      settledCalls: row?.settled ?? 0,
      unknownCalls: row?.unknown ?? 0,
      releasedCalls: row?.released ?? 0,
      inputTokens: row?.input ?? 0,
      outputTokens: row?.output ?? 0,
      costNanoUsd: row?.cost ?? 0,
    };
  }

  private async runViewOf(
    run: typeof analysisRuns.$inferSelect,
    projectId: string,
  ): Promise<AssessmentRunView> {
    const [inputs] = await this.db
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, run.id));
    const [budget] = await this.db
      .select()
      .from(assessmentRunBudget)
      .where(eq(assessmentRunBudget.runId, run.id));
    const [outcome] = await this.db
      .select()
      .from(assessmentRunOutcomes)
      .where(eq(assessmentRunOutcomes.runId, run.id));
    const [request] = await this.db
      .select({ mode: assessmentRequests.mode })
      .from(assessmentRequests)
      .where(eq(assessmentRequests.runId, run.id));
    const [assessment] = await this.db
      .select({ id: preInterviewAssessments.id })
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.runId, run.id));
    const facts = configFacts(inputs?.pipelineConfig ?? {});
    const guard: AssessmentGuardView = {
      maxCalls: budget?.maxCalls ?? 0,
      maxInputTokens: budget?.maxInputTokens ?? 0,
      maxOutputTokens: budget?.maxOutputTokens ?? 0,
      maxCostNanoUsd: budget?.maxCostNanoUsd ?? 0,
      maxReservedInputTokensPerCall: budget?.maxReservedInputTokensPerCall ?? 0,
      runWallClockMs: budget?.runWallClockMs ?? 0,
      priceTableId: budget?.priceTableId ?? '',
      notice: 'local_spending_guard_not_a_provider_billing_limit',
    };
    return {
      id: run.id,
      projectId,
      state: run.state,
      mode: request?.mode ?? null,
      failureCategory: run.failureCategory,
      // a succeeded run has no failure outcome; only a failed or cancelled one reports its code and stage
      failureCode:
        run.state === 'failed' || run.state === 'cancelled' ? (outcome?.failureCode ?? null) : null,
      stageReached:
        run.state === 'failed' || run.state === 'cancelled'
          ? (outcome?.stageReached ?? null)
          : null,
      providerMode: facts.providerMode,
      replayDemonstration: isDemonstration(facts.providerMode),
      createdAt: run.createdAt.toISOString(),
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      assessmentId: run.state === 'succeeded' ? (assessment?.id ?? null) : null,
      usage: await this.usageOf(run.id),
      guard,
    };
  }

  /** One run of THIS project, or null (a run of another project, or a run of another type, is the same as a missing one). */
  async getRun(projectId: string, runId: string): Promise<AssessmentRunView | null> {
    const [run] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.projectId, projectId),
          eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
        ),
      );
    return run ? this.runViewOf(run, projectId) : null;
  }

  async activeRun(projectId: string): Promise<AssessmentRunView | null> {
    const [run] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.projectId, projectId),
          eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
          inArray(analysisRuns.state, ['pending', 'running']),
        ),
      );
    return run ? this.runViewOf(run, projectId) : null;
  }

  async latestRun(projectId: string): Promise<AssessmentRunView | null> {
    const [run] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(eq(analysisRuns.projectId, projectId), eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE)),
      )
      .orderBy(desc(analysisRuns.createdAt), desc(analysisRuns.id))
      .limit(1);
    return run ? this.runViewOf(run, projectId) : null;
  }

  // -- Assessments --------------------------------------------------------------------------------------------------------

  /** Versions, newest first. */
  async list(projectId: string): Promise<AssessmentSummary[]> {
    const rows = await this.db
      .select()
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.projectId, projectId))
      .orderBy(desc(preInterviewAssessments.versionNumber));
    const summaries: AssessmentSummary[] = [];
    for (const row of rows) {
      const verified = await this.store.getVerified(row.id);
      const parsed = verified?.verified === true ? ScoreReport.safeParse(row.report) : null;
      const overall = parsed?.success ? parsed.data.overall : null;
      summaries.push({
        id: row.id,
        versionNumber: row.versionNumber,
        runId: row.runId,
        createdAt: row.createdAt.toISOString(),
        providerMode: row.providerMode,
        replayDemonstration: isDemonstration(row.providerMode),
        target: 'overall',
        overall:
          overall === null
            ? null
            : {
                state: overall.state,
                // only a computed score is a number; insufficient and not-computed overalls carry none
                score10:
                  overall.state === 'scored' || overall.state === 'scored_partial'
                    ? overall.score10
                    : null,
              },
        verified: verified?.verified === true,
      });
    }
    return summaries;
  }

  /** The assessment of THIS project with its judgments, citations and evidence, or null. */
  async getDetail(projectId: string, assessmentId: string): Promise<AssessmentDetail | null> {
    const [row] = await this.db
      .select()
      .from(preInterviewAssessments)
      .where(
        and(
          eq(preInterviewAssessments.id, assessmentId),
          eq(preInterviewAssessments.projectId, projectId),
        ),
      );
    if (!row) return null;
    const verified = await this.store.getVerified(row.id);
    const isVerified = verified?.verified === true;
    const parsed = isVerified ? ScoreReport.safeParse(row.report) : null;
    const [inputs] = await this.db
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, row.runId));

    const judgmentRows = await this.store.judgments(row.id);
    const evidenceIds = [
      ...new Set(judgmentRows.flatMap((j) => j.citations.map((c) => c.evidenceId))),
    ];
    const evidence =
      evidenceIds.length === 0
        ? []
        : await this.db
            .select()
            .from(evidenceItems)
            .where(
              and(eq(evidenceItems.projectId, projectId), inArray(evidenceItems.id, evidenceIds)),
            );
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));

    const judgments: AssessmentJudgmentView[] = judgmentRows.map((j) => {
      const citations: JudgmentCitationView[] = j.citations.map((c) => {
        const item = evidenceById.get(c.evidenceId);
        return {
          evidenceId: c.evidenceId,
          directness: c.directness,
          specificity: c.specificity,
          note: c.note ?? '',
          evidence: item
            ? {
                kind: item.kind,
                origin: item.origin,
                verificationLevel: item.verificationLevel,
                text: item.text,
                excerpt: item.excerpt,
                snapshotId: item.snapshotId,
                artifactId: item.artifactId,
                span:
                  item.spanStart !== null && item.spanEnd !== null
                    ? { start: item.spanStart, end: item.spanEnd }
                    : null,
                contextVersionId: item.contextVersionId,
              }
            : null,
        };
      });
      return {
        dimensionId: j.dimensionId,
        position: j.position,
        outcomeKind: j.outcomeKind === 'scored' ? 'scored' : 'insufficient_evidence',
        // an insufficient outcome never carries a number, whatever else the row holds
        score: j.outcomeKind === 'scored' ? j.score : null,
        disposition: j.disposition,
        dispositionClass: classifyDisposition(j.disposition),
        rationale: j.rationale,
        limitations: [...j.limitations],
        assessorAttempts: j.assessorAttempts,
        criticAttempts: j.criticAttempts,
        criticReviewRequired: j.criticReviewRequired,
        criticReviewed: j.criticReviewed,
        semanticRelevance: 'not_verified',
        citations,
      };
    });

    const facts = configFacts(inputs?.pipelineConfig ?? {});
    // stored by trusted code, but read defensively: a malformed entry is shown as what it is, never as a different code
    const limitations: AssessmentLimitationView[] = row.limitations.map((raw) => {
      const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      return {
        code: typeof entry['code'] === 'string' ? entry['code'] : 'malformed_limitation',
        count: typeof entry['count'] === 'number' ? entry['count'] : 0,
        subjects: Array.isArray(entry['subjects'])
          ? entry['subjects'].filter((item): item is string => typeof item === 'string')
          : [],
      };
    });
    const replay = isDemonstration(row.providerMode);
    return {
      id: row.id,
      projectId,
      runId: row.runId,
      versionNumber: row.versionNumber,
      createdAt: row.createdAt.toISOString(),
      providerMode: row.providerMode,
      replayDemonstration: replay,
      target: 'overall',
      verified: isVerified && parsed?.success === true,
      verificationFailure: isVerified
        ? parsed?.success === true
          ? null
          : 'report_schema'
        : (verified?.failed ?? 'unverifiable'),
      report: parsed?.success ? parsed.data : null,
      judgments,
      limitations,
      pipeline:
        facts.provider !== null && facts.models !== null
          ? {
              provider: facts.provider,
              models: facts.models,
              configHash:
                inputs?.pipelineConfigHash ??
                sha256Hex(canonicalJson(inputs?.pipelineConfig ?? {})),
            }
          : null,
      usage: await this.usageOf(row.runId),
      notices: {
        advisory: ASSESSMENT_API_NOTICE,
        semanticRelevance: 'not_verified',
        target: 'overall_rubric_only',
        replay: replay ? REPLAY_NOTICE : null,
      },
    };
  }
}
