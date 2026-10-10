import { storedFormOf, verifyStoredAssessment } from '@judge-copilot/assessment';
import type { EventReferenceMeta } from '@judge-copilot/assessment';
import type { ProviderMode, ScoreReport } from '@judge-copilot/schemas';
import { and, asc, eq } from 'drizzle-orm';
import { AssessmentRunStore } from './assessment-run-store.js';
import type { JudgeDatabase } from './client.js';
import {
  analysisRuns,
  assessmentDimensionJudgments,
  assessmentJudgmentCitations,
  assessmentRunExtractions,
  assessmentRunInputs,
  assessmentRunInputSnapshots,
  eventContextVersions,
  graphExtractionItems,
  graphExtractions,
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

export interface PersistAssessmentInput {
  readonly runId: string;
  readonly leaseToken: string;
  readonly actorId: string | null;
  readonly assessmentKey: string;
  /** The complete M4 report exactly as the engine returned it. */
  readonly report: ScoreReport;
  readonly limitations: readonly unknown[];
  readonly judgments: readonly JudgmentInput[];
  readonly providerMode: ProviderMode;
  readonly fallbackAnchorsVersion: string | null;
  /** The committed hashes the report was computed from (from the authorized inputs); re-compared under the lock. */
  readonly expected: {
    readonly sourceMembersHash: string;
    readonly contextMembersHash: string;
    readonly lockedContentHash: string;
  };
}

export type PersistAssessmentResult =
  | { readonly kind: 'persisted'; readonly assessmentId: string; readonly versionNumber: number }
  | { readonly kind: 'cancelled'; readonly reason: 'context_superseded' };

export class AssessmentPersistError extends Error {
  constructor(
    readonly code:
      | 'report_not_verifiable'
      | 'report_unstorable'
      | 'members_changed'
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

  constructor(
    private readonly db: JudgeDatabase,
    options: { now?: () => Date } = {},
  ) {
    this.runs = new AssessmentRunStore({
      db,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async persist(input: PersistAssessmentInput): Promise<PersistAssessmentResult> {
    // Pure checks first: no transaction is opened for a report that cannot be stored.
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
      input.judgments.some((j) => (j.rationale ?? '').includes('\u0000'))
    ) {
      throw new AssessmentPersistError('report_unstorable', 'text contains a NUL character');
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
        // lock order: project -> version -> run
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
        if (inputs.lockedContentHash !== input.expected.lockedContentHash) {
          throw new AssessmentPersistError(
            'members_changed',
            'the report was computed from another context',
          );
        }

        const bindings = await tx
          .select()
          .from(assessmentRunExtractions)
          .where(eq(assessmentRunExtractions.runId, input.runId));
        const sourceId = bindings.find((b) => b.kind === 'source')?.extractionId;
        const contextId = bindings.find((b) => b.kind === 'context_evidence')?.extractionId;
        if (!sourceId || !contextId) {
          throw new AssessmentPersistError(
            'run_not_persistable',
            'the run has no bound extractions',
          );
        }
        const hashRows = await tx
          .select({ id: graphExtractions.id, hash: graphExtractions.membersHash })
          .from(graphExtractions)
          .where(eq(graphExtractions.projectId, projectId));
        const hashOf = (id: string) => hashRows.find((row) => row.id === id)?.hash;
        if (
          hashOf(sourceId) !== input.expected.sourceMembersHash ||
          hashOf(contextId) !== input.expected.contextMembersHash
        ) {
          throw new AssessmentPersistError(
            'members_changed',
            'the extraction membership changed since the report was computed',
          );
        }

        const [assessment] = await tx
          .insert(preInterviewAssessments)
          .values({
            projectId,
            eventId: project.eventId,
            runId: input.runId,
            versionNumber: 1, // the insert trigger assigns the gapless number under the project lock
            assessmentKey: input.assessmentKey,
            contextVersionId: inputs.contextVersionId,
            lockedContentHash: inputs.lockedContentHash,
            pinnedSnapshotIds: await this.pinnedSnapshotIds(tx, input.runId),
            extractionId: sourceId,
            contextExtractionId: contextId,
            targetKind: inputs.targetKind,
            trackKey: inputs.targetTrackKey,
            fallbackAnchorsVersion: input.fallbackAnchorsVersion,
            engineVersion: input.report.engineVersion,
            parametersHash: input.report.parametersHash,
            rubricFingerprint: input.report.rubric.fingerprint,
            rubricSource: input.report.rubric.source,
            inputFingerprint: input.report.inputFingerprint,
            graphFingerprint: input.report.graphFingerprint,
            outputHash: input.report.outputHash,
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

        const referenceOf = await this.referenceMetadata(tx, [sourceId, contextId]);
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
                const reference = referenceOf.get(citation.evidenceId);
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

  private async pinnedSnapshotIds(tx: JudgeDatabase, runId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: assessmentRunInputSnapshots.snapshotId })
      .from(assessmentRunInputSnapshots)
      .where(eq(assessmentRunInputSnapshots.runId, runId))
      .orderBy(asc(assessmentRunInputSnapshots.snapshotId));
    return rows.map((row) => row.id);
  }

  /** The code-authored metadata of the reference evidence of the given extractions, keyed by evidence id. */
  private async referenceMetadata(tx: JudgeDatabase, extractionIds: readonly string[]) {
    const map = new Map<string, Pick<EventReferenceMeta, 'applicability' | 'trackKey'>>();
    for (const extractionId of extractionIds) {
      const rows = await tx
        .select()
        .from(graphExtractionItems)
        .where(
          and(
            eq(graphExtractionItems.extractionId, extractionId),
            eq(graphExtractionItems.recordType, 'evidence'),
          ),
        );
      for (const row of rows) {
        if (row.referenceApplicability !== null) {
          map.set(row.recordId, {
            applicability: row.referenceApplicability,
            trackKey: row.referenceTrackKey,
          });
        }
      }
    }
    return map;
  }
}
