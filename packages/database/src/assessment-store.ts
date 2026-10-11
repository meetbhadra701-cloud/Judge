import { storedFormOf, verifyStoredAssessment } from '@judge-copilot/assessment';
import type { ProviderMode, ScoreReport } from '@judge-copilot/schemas';
import { asc, eq } from 'drizzle-orm';
import { AssessmentInputError, AssessmentInputReader } from './assessment-input-reader.js';
import { AssessmentRunStore } from './assessment-run-store.js';
import type { JudgeDatabase } from './client.js';
import {
  canonicalReportText,
  reportDifferences,
  rescore,
  scorerInputOf,
  validateJudgmentRecords,
} from './trusted-rescoring.js';
import { checkJudgmentCalls } from './judgment-calls.js';
import {
  analysisRuns,
  assessmentDimensionJudgments,
  assessmentJudgmentCitations,
  assessmentRunCalls,
  assessmentRunInputs,
  eventContextVersions,
  preInterviewAssessments,
  projects,
} from './schema/index.js';

/*
 * Immutable persistence of ONE successful pre_interview assessment (M5 P4, design §8.1-§8.4, §8.8). One transaction: re-verify the
 * pins under the documented locks, write the assessment, its judgments and citations, move the run to `succeeded` and write its
 * outcome. The deferred triggers of migration 0011 verify completeness at COMMIT; a failed, partial or corrupted write leaves nothing.
 *
 * Lock order: project (FOR NO KEY UPDATE) -> pinned version (FOR SHARE) -> run (FOR UPDATE). If the pinned version is no longer the
 * event's locked version, the run is CANCELLED in this transaction (`context_superseded`) and NO assessment is written.
 */

export interface JudgmentInput {
  readonly dimensionId: string;
  readonly outcomeKind: 'scored' | 'insufficient_evidence';
  readonly score: number | null;
  readonly disposition: (typeof assessmentDimensionJudgments.$inferInsert)['disposition'];
  readonly rationale: string | null;
  readonly limitations: readonly string[];
  readonly assessorAttempts: number;
  readonly criticAttempts: number;
  /** `assessment_run_calls.seq` values of this run. */
  readonly assessorCallSeqs: readonly number[];
  readonly criticCallSeqs: readonly number[];
  readonly criticReviewRequired: boolean;
  readonly criticReviewed: boolean;
  readonly citations: readonly {
    readonly evidenceId: string;
    readonly directness: string;
    readonly specificity: string;
    readonly note: string | null;
  }[];
}

/**
 * Everything the caller supplies. Deliberately NOT here: the assessment key (frozen when the run was requested), the extraction ids,
 * the pinned snapshots, the locked context and any hash of them. Those are read from the database inside the persistence
 * transaction, under the locks, through the trusted input reader.
 */
export interface PersistAssessmentInput {
  readonly runId: string;
  readonly leaseToken: string;
  readonly actorId: string | null;
  /**
   * The complete M4 report. It is NOT trusted: persistence recomputes it with the real engine from the authorized inputs and the
   * `judgments` below and refuses anything that is not byte-identical.
   */
  readonly report: ScoreReport;
  readonly limitations: readonly unknown[];
  /**
   * The finalized judgments. For every dimension the outcome, the score and the classified citations are EXACTLY what the scorer was
   * handed (R4 F1): a dimension downgraded by a gate stores `insufficient_evidence` and no citations; a dimension the assessor itself
   * reported insufficient keeps the citations it gave.
   */
  readonly judgments: readonly JudgmentInput[];
  readonly providerMode: ProviderMode;
  readonly fallbackAnchorsVersion: string | null;
}

export type PersistAssessmentResult =
  | { readonly kind: 'persisted'; readonly assessmentId: string; readonly versionNumber: number }
  | { readonly kind: 'cancelled'; readonly reason: 'context_superseded' };

export class AssessmentPersistError extends Error {
  constructor(
    readonly code:
      | 'report_not_verifiable'
      | 'report_unstorable'
      | 'judgments_invalid'
      | 'scorer_input_invalid'
      | 'inputs_rejected'
      | 'report_mismatch'
      | 'call_binding_invalid'
      | 'run_not_persistable'
      | 'persistence_failed',
    message: string,
    readonly sqlState: string | null = null,
    readonly constraint: string | null = null,
    /** The database's own message (our trigger and constraint texts: row identity only, never record content). */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'AssessmentPersistError';
  }
}

export interface StoredAssessment {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly versionNumber: number;
  readonly assessmentKey: string;
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  readonly pinnedSnapshotIds: readonly string[];
  readonly extractionId: string;
  readonly contextExtractionId: string;
  readonly outputHash: string;
  readonly reportCanonical: string;
  readonly reportTextSha256: string;
  readonly report: unknown;
  readonly providerMode: ProviderMode;
  readonly engineVersion: string;
  readonly parametersHash: string;
  readonly inputFingerprint: string;
  readonly graphFingerprint: string;
  readonly rubricFingerprint: string;
}

function sqlStateOf(error: unknown): {
  code: string | null;
  constraint: string | null;
  message: string | null;
} {
  let code: string | null = null;
  let constraint: string | null = null;
  let message: string | null = null;
  for (let current = error; current instanceof Error; current = current.cause) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      code === null &&
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      code = candidate.code;
    }
    const name = candidate.constraint ?? candidate.constraint_name;
    if (constraint === null && typeof name === 'string') constraint = name;
    if (code !== null && message === null) message = current.message.slice(0, 300);
  }
  return { code, constraint, message };
}

export class AssessmentStore {
  private readonly runs: AssessmentRunStore;
  private readonly reader: AssessmentInputReader;

  private readonly afterRunLocked: (() => Promise<void>) | undefined;

  constructor(
    private readonly db: JudgeDatabase,
    options: {
      now?: () => Date;
      /** Test seam: awaited right after the run row is locked by `persist`, to force an interleaving. */
      afterRunLocked?: () => Promise<void>;
    } = {},
  ) {
    this.afterRunLocked = options.afterRunLocked;
    this.runs = new AssessmentRunStore({
      db,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.reader = new AssessmentInputReader(db);
  }

  async persist(input: PersistAssessmentInput): Promise<PersistAssessmentResult> {
    // Pure checks first: no transaction is opened for input that can never be stored.
    const stored = storedFormOf(input.report);
    const verification = verifyStoredAssessment(stored);
    if (!verification.ok) {
      throw new AssessmentPersistError(
        'report_not_verifiable',
        `report check failed: ${verification.failed}`,
      );
    }
    if (
      stored.reportCanonical.includes('\\u0000') ||
      input.judgments.some(
        (j) =>
          (j.rationale ?? '').includes('\u0000') ||
          j.citations.some((c) => (c.note ?? '').includes('\u0000')),
      )
    ) {
      throw new AssessmentPersistError('report_unstorable', 'text contains a NUL character');
    }
    if (input.fallbackAnchorsVersion !== null) {
      throw new AssessmentPersistError(
        'judgments_invalid',
        'fallback anchors are not approved: fallbackAnchorsVersion must be null',
      );
    }
    const recordIssues = validateJudgmentRecords(input.judgments);
    if (recordIssues.length > 0) {
      throw new AssessmentPersistError(
        'judgments_invalid',
        `the judgment records are inconsistent: ${recordIssues
          .slice(0, 10)
          .map((issue) => `${issue.code}@${issue.dimensionId}`)
          .join(', ')}`,
      );
    }
    const scorerInput = scorerInputOf(input.judgments);
    if (!scorerInput.ok) {
      throw new AssessmentPersistError(
        'scorer_input_invalid',
        `the judgments are not a valid scorer input: ${scorerInput.issues.slice(0, 5).join(', ')}`,
      );
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [run] = await tx
          .select({ projectId: analysisRuns.projectId })
          .from(analysisRuns)
          .where(eq(analysisRuns.id, input.runId));
        if (!run?.projectId) {
          throw new AssessmentPersistError('run_not_persistable', 'run not found');
        }
        const projectId = run.projectId;
        // lock order: project -> version -> run -> budget
        const [project] = await tx
          .select({ id: projects.id, eventId: projects.eventId })
          .from(projects)
          .where(eq(projects.id, projectId))
          .for('no key update');
        if (!project) throw new AssessmentPersistError('run_not_persistable', 'project not found');
        const [inputs] = await tx
          .select()
          .from(assessmentRunInputs)
          .where(eq(assessmentRunInputs.runId, input.runId));
        if (!inputs)
          throw new AssessmentPersistError('run_not_persistable', 'run has no pinned inputs');
        const [version] = await tx
          .select({
            status: eventContextVersions.status,
            hash: eventContextVersions.lockedContentHash,
          })
          .from(eventContextVersions)
          .where(eq(eventContextVersions.id, inputs.contextVersionId))
          .for('share');
        const locked = await this.runs
          .lockOwnRun(tx, input.runId, input.leaseToken)
          .catch((error: unknown) => {
            throw new AssessmentPersistError(
              'run_not_persistable',
              error instanceof Error ? error.message : 'run',
            );
          });
        await this.afterRunLocked?.();

        if (version?.status !== 'locked' || version.hash !== inputs.lockedContentHash) {
          // The pinned version is no longer the event's locked version: cancel, never complete under a superseded context (D3).
          await this.runs.reapReserved(tx, input.runId, 'run_ended');
          const finishedAt = new Date();
          await tx
            .update(analysisRuns)
            .set({ state: 'cancelled', failureCategory: null, finishedAt })
            .where(eq(analysisRuns.id, input.runId));
          await this.runs.writeOutcome(tx, {
            runId: input.runId,
            projectId,
            outcome: 'cancelled',
            failureCategory: null,
            failureCode: 'context_superseded',
            stageReached: 'persist',
            providerMode: input.providerMode,
          });
          return { kind: 'cancelled', reason: 'context_superseded' } as const;
        }
        if (inputs.assessmentKey === null) {
          throw new AssessmentPersistError(
            'run_not_persistable',
            'the run has no frozen assessment identity',
          );
        }

        // (R4 F1/F2) the authoritative inputs, read inside this transaction under the locks above: every pinned input is immutable or
        // locked here (the project row serializes graph writers, the version row is FOR SHARE, the run row is FOR UPDATE), so the
        // statements of the reader see one consistent state without a second snapshot.
        const authorized = await this.reader
          .readInTransaction(tx, input.runId, ['running'])
          .catch((error: unknown) => {
            if (error instanceof AssessmentInputError) {
              throw new AssessmentPersistError(
                'inputs_rejected',
                `the run's inputs were rejected: ${error.code}`,
                null,
                null,
                error.message,
              );
            }
            throw error;
          });
        const data = authorized.data;

        // (R4 F1/F2) recompute the report with the real, unchanged M4 engine and require byte equality with the supplied one.
        const recomputed = rescore(authorized, input.judgments);
        if (!recomputed.ok) {
          throw new AssessmentPersistError(
            'scorer_input_invalid',
            `the engine rejected the judgments (${recomputed.stage}): ${recomputed.issues.slice(0, 5).join(', ')}`,
          );
        }
        if (canonicalReportText(recomputed.report) !== stored.reportCanonical) {
          throw new AssessmentPersistError(
            'report_mismatch',
            `the report is not the engine's result for these inputs and judgments (differs in: ${reportDifferences(recomputed.report, input.report).join(', ')})`,
          );
        }

        // (R4 F7) every cited call belongs to this run and this dimension and proves what the row claims. In-flight calls become
        // `unknown` first (conservative); the budget row is locked by the reap, completing run -> budget -> ledger.
        await this.runs.reapReserved(tx, input.runId, 'run_ended');
        const calls = await tx
          .select()
          .from(assessmentRunCalls)
          .where(eq(assessmentRunCalls.runId, input.runId));
        const callIssues = checkJudgmentCalls(
          input.judgments,
          calls.map((call) => ({
            seq: call.seq,
            stage: call.stage,
            dimensionId: call.dimensionId,
            state: call.state,
            responseRecord: call.responseRecord,
            outcomeCode: call.outcomeCode,
            boundViolation: call.boundViolation,
            providerMode: call.providerMode,
          })),
          input.providerMode,
        );
        if (callIssues.length > 0) {
          throw new AssessmentPersistError(
            'call_binding_invalid',
            `the cited model calls do not support the judgments: ${callIssues
              .slice(0, 10)
              .map(
                (issue) =>
                  `${issue.code}@${issue.dimensionId}${issue.seq === undefined ? '' : `#${String(issue.seq)}`}`,
              )
              .join(', ')}`,
          );
        }

        const [assessment] = await tx
          .insert(preInterviewAssessments)
          .values({
            projectId,
            eventId: project.eventId,
            runId: input.runId,
            versionNumber: 1, // the insert trigger assigns the gapless number under the project lock
            assessmentKey: inputs.assessmentKey, // frozen when the run was requested; the database refuses any other
            contextVersionId: inputs.contextVersionId,
            lockedContentHash: inputs.lockedContentHash,
            pinnedSnapshotIds: data.pinnedSnapshots.map((pin) => pin.snapshotId),
            extractionId: data.source.extraction.id,
            contextExtractionId: data.context.extraction.id,
            targetKind: inputs.targetKind,
            trackKey: inputs.targetTrackKey,
            fallbackAnchorsVersion: null,
            engineVersion: recomputed.report.engineVersion,
            parametersHash: recomputed.report.parametersHash,
            rubricFingerprint: recomputed.report.rubric.fingerprint,
            rubricSource: recomputed.report.rubric.source,
            inputFingerprint: recomputed.report.inputFingerprint,
            graphFingerprint: recomputed.report.graphFingerprint,
            outputHash: recomputed.report.outputHash,
            reportCanonical: stored.reportCanonical,
            reportTextSha256: stored.reportTextSha256,
            report: JSON.parse(stored.reportCanonical) as Record<string, unknown>,
            limitations: [...input.limitations],
            pipelineConfigHash: inputs.pipelineConfigHash,
            providerMode: input.providerMode,
            createdByActorId: input.actorId,
          })
          .returning({
            id: preInterviewAssessments.id,
            versionNumber: preInterviewAssessments.versionNumber,
          });
        if (!assessment) throw new Error('internal: the assessment insert returned no row');

        for (const [position, judgment] of input.judgments.entries()) {
          await tx.insert(assessmentDimensionJudgments).values({
            assessmentId: assessment.id,
            projectId,
            dimensionId: judgment.dimensionId,
            position,
            outcomeKind: judgment.outcomeKind,
            score: judgment.score,
            disposition: judgment.disposition,
            rationale: judgment.rationale,
            limitations: [...judgment.limitations],
            assessorAttempts: judgment.assessorAttempts,
            criticAttempts: judgment.criticAttempts,
            assessorCallSeqs: [...judgment.assessorCallSeqs],
            criticCallSeqs: [...judgment.criticCallSeqs],
            criticReviewRequired: judgment.criticReviewRequired,
            criticReviewed: judgment.criticReviewed,
          });
          if (judgment.citations.length > 0) {
            await tx.insert(assessmentJudgmentCitations).values(
              judgment.citations.map((citation, index) => {
                // the code-authored classification of Event-Context evidence, taken from the VERIFIED reader result
                const reference = data.eventReferences.get(citation.evidenceId);
                return {
                  assessmentId: assessment.id,
                  projectId,
                  dimensionId: judgment.dimensionId,
                  position: index,
                  evidenceId: citation.evidenceId,
                  directness: citation.directness,
                  specificity: citation.specificity,
                  note: citation.note,
                  referenceApplicability: reference?.applicability ?? null,
                  referenceTrackKey: reference?.trackKey ?? null,
                };
              }),
            );
          }
        }

        await tx
          .update(analysisRuns)
          .set({ state: 'succeeded', failureCategory: null, finishedAt: new Date() })
          .where(eq(analysisRuns.id, input.runId));
        await this.runs.writeOutcome(tx, {
          runId: input.runId,
          projectId: locked.projectId,
          outcome: 'succeeded',
          failureCategory: null,
          failureCode: null,
          stageReached: 'persist',
          providerMode: input.providerMode,
        });
        return {
          kind: 'persisted',
          assessmentId: assessment.id,
          versionNumber: assessment.versionNumber,
        } as const;
      });
    } catch (error) {
      if (error instanceof AssessmentPersistError) throw error;
      const { code, constraint, message } = sqlStateOf(error);
      throw new AssessmentPersistError(
        'persistence_failed',
        `the assessment could not be stored (${code ?? 'unknown'}${constraint ? `, ${constraint}` : ''})${message ? `: ${message}` : ''}`,
        code,
        constraint,
        message,
      );
    }
  }

  /** Reads one assessment and RE-VERIFIES it (`verifyStoredAssessment`): text hash, schema, M4 outputHash, fixed point, jsonb mirror. */
  async getVerified(
    assessmentId: string,
  ): Promise<{ assessment: StoredAssessment; verified: boolean; failed: string | null } | null> {
    const [row] = await this.db
      .select()
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.id, assessmentId));
    if (!row) return null;
    const result = verifyStoredAssessment({
      reportCanonical: row.reportCanonical,
      reportTextSha256: row.reportTextSha256,
      outputHash: row.outputHash,
      reportJson: row.report,
    });
    return {
      assessment: {
        id: row.id,
        projectId: row.projectId,
        runId: row.runId,
        versionNumber: row.versionNumber,
        assessmentKey: row.assessmentKey,
        contextVersionId: row.contextVersionId,
        lockedContentHash: row.lockedContentHash,
        pinnedSnapshotIds: [...row.pinnedSnapshotIds],
        extractionId: row.extractionId,
        contextExtractionId: row.contextExtractionId,
        outputHash: row.outputHash,
        reportCanonical: row.reportCanonical,
        reportTextSha256: row.reportTextSha256,
        report: row.report,
        providerMode: row.providerMode,
        engineVersion: row.engineVersion,
        parametersHash: row.parametersHash,
        inputFingerprint: row.inputFingerprint,
        graphFingerprint: row.graphFingerprint,
        rubricFingerprint: row.rubricFingerprint,
      },
      verified: result.ok,
      failed: result.ok ? null : result.failed,
    };
  }

  async judgments(assessmentId: string) {
    const rows = await this.db
      .select()
      .from(assessmentDimensionJudgments)
      .where(eq(assessmentDimensionJudgments.assessmentId, assessmentId))
      .orderBy(asc(assessmentDimensionJudgments.position));
    const citations = await this.db
      .select()
      .from(assessmentJudgmentCitations)
      .where(eq(assessmentJudgmentCitations.assessmentId, assessmentId))
      .orderBy(
        asc(assessmentJudgmentCitations.dimensionId),
        asc(assessmentJudgmentCitations.position),
      );
    return rows.map((row) => ({
      ...row,
      citations: citations.filter((citation) => citation.dimensionId === row.dimensionId),
    }));
  }

  async listVersions(projectId: string) {
    return this.db
      .select({
        id: preInterviewAssessments.id,
        versionNumber: preInterviewAssessments.versionNumber,
      })
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.projectId, projectId))
      .orderBy(asc(preInterviewAssessments.versionNumber));
  }
}
