import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  ASSESSMENT_RUN_TYPE,
  CoverageRecord,
  type AssessmentRequestMode,
  type AssessmentRunFailureCategory,
  type AssessmentRunLimits,
  type CoverageRecord as CoverageRecordType,
  type ExtractionKind,
  type ProviderMode,
} from '@judge-copilot/schemas';
import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { buildEventReferenceItems, type EventReferenceMeta } from '@judge-copilot/assessment';
import { inputsFingerprint, trackSelectionSetHash } from './assessment-hashes.js';
import { assessmentIdentityOf, requestIdentityOf } from './assessment-identity.js';
import type { JudgeDatabase } from './client.js';
import { referenceSetMismatch } from './context-reference-check.js';
import { LockedContextReader } from './locked-context-reader.js';
import { reapReservedCalls } from './run-budget-store.js';
import {
  analysisRuns,
  assessmentRequests,
  assessmentRunBudget,
  assessmentRunCalls,
  assessmentRunCoverage,
  assessmentRunExtractions,
  assessmentRunInputs,
  assessmentRunInputSnapshots,
  assessmentRunOutcomes,
  eventContextVersions,
  evidenceItems,
  graphExtractionItems,
  graphExtractions,
  preInterviewAssessments,
  projects,
  projectVoids,
  projectSources,
  projectTrackSelections,
  sourceSnapshots,
  tracks,
} from './schema/index.js';

/*
 * Requests, pins and the run lifecycle (M5 P4, design §7.2 and §8.6). Every method is ONE short transaction; none holds a transaction
 * across a model call (there is no model code here). Lock order, identical everywhere:
 *   project row (FOR NO KEY UPDATE) -> pinned event_context_versions row (FOR SHARE) -> analysis_runs row (FOR UPDATE)
 *   -> assessment_run_budget row (FOR UPDATE).
 * M1's lock/supersede takes event -> version rows and never touches a project or run row, so the orders cannot form a cycle.
 */

type Executor = JudgeDatabase;

export type AssessmentTarget =
  { readonly kind: 'overall' } | { readonly kind: 'track'; readonly trackKey: string };

export interface PinnedInputs {
  readonly eventId: string;
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  /** Distinct declared track keys with the selection row that declares each (aligned arrays, sorted by key). */
  readonly declaredTrackKeys: readonly string[];
  readonly trackSelectionIds: readonly string[];
  readonly trackSelectionSetHash: string;
  readonly snapshots: readonly {
    readonly snapshotId: string;
    readonly sourceType: string;
    readonly contentHash: string;
  }[];
}

/**
 * What a caller may say. Deliberately NOT here (R4 F5): a request hash, a pipeline-configuration hash and an assessment key. Those
 * are computed below, from the project, the mode, the target and the configuration, so a caller cannot make two different requests
 * look equal (or one request look different) by choosing a hash.
 */
export interface RequestAssessmentInput {
  readonly projectId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly mode: AssessmentRequestMode;
  readonly target: AssessmentTarget;
  /** The pipeline configuration (prompt versions, models, extractor settings...). Its canonical SHA-256 is part of every identity. */
  readonly pipelineConfig: Record<string, unknown>;
  readonly limits: AssessmentRunLimits;
  readonly priceTableId: string;
}

export type RequestAssessmentResult =
  | { readonly kind: 'run_created'; readonly requestId: string; readonly runId: string }
  | {
      readonly kind: 'run_active';
      readonly requestId: string;
      readonly runId: string;
      readonly replayed: true;
    }
  | {
      readonly kind: 'run_succeeded';
      readonly requestId: string;
      readonly runId: string;
      readonly assessmentId: string;
      readonly replayed: true;
    }
  | {
      readonly kind: 'run_failed';
      readonly requestId: string;
      readonly runId: string;
      readonly state: 'failed' | 'cancelled';
      readonly failureCategory: string | null;
      readonly replayed: true;
    }
  | {
      readonly kind: 'already_assessed';
      readonly requestId: string;
      readonly assessmentId: string;
      readonly replayed: boolean;
    }
  | { readonly kind: 'key_reused' }
  | { readonly kind: 'run_active_conflict'; readonly runId: string }
  | { readonly kind: 'project_voided' }
  | { readonly kind: 'no_locked_context' }
  | { readonly kind: 'no_source_snapshots' }
  | {
      readonly kind: 'no_context_reference_evidence';
      /** P6D: what the refusal can honestly tell the judge. Whether the locked context defines tracks, and which the project declared. */
      readonly contextDefinesTracks: boolean;
      readonly declaredTrackKeys: readonly string[];
      /** M6 phase 0: explicit rules/requirements the context states but that cite no official source (so they are not reference evidence). */
      readonly unofficialStatements: number;
    }
  /** P6D: the locked context has no official OVERALL rubric (track rubrics are not assessed); the run could only have failed late. */
  | { readonly kind: 'no_overall_rubric'; readonly trackRubrics: number }
  | { readonly kind: 'track_not_in_context'; readonly trackKey: string };

export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly contextVersionId: string;
  readonly state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly failureCategory: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly attemptCount: number;
}

export interface FinishRunInput {
  readonly runId: string;
  /** When given it must be the run's current lease token. */
  readonly leaseToken?: string;
  readonly state: 'failed' | 'cancelled';
  readonly failureCategory?: AssessmentRunFailureCategory;
  readonly failureCode: string;
  readonly stageReached?: string;
  readonly providerMode?: ProviderMode;
}

export class AssessmentRunError extends Error {
  constructor(
    readonly code:
      | 'run_not_found'
      | 'wrong_state'
      | 'lease_mismatch'
      | 'inputs_missing'
      | 'extraction_kind_mismatch'
      | 'extraction_rejected'
      | 'coverage_rejected',
    message: string,
  ) {
    super(message);
    this.name = 'AssessmentRunError';
  }
}

export interface AssessmentRunStoreOptions {
  readonly db: JudgeDatabase;
  readonly now?: () => Date;
  /**
   * Test seam, awaited by `finishRun` and `recoverRun` right after the run row is locked and validated, before anything is written.
   * It lets a test hold the run lock to force an interleaving; it has no production use.
   */
  readonly afterRunLocked?: (operation: 'finish' | 'recover') => Promise<void>;
  /**
   * Test seam, awaited by `expirePendingRun` right after the run row is locked and the pending/age checks passed, before anything is
   * written. Separate from `afterRunLocked` so that hooks written against its two operations keep their types.
   */
  readonly afterPendingLocked?: () => Promise<void>;
}

const ACTIVE = ['pending', 'running'] as const;

/** True for the unique-index violation of (actor, idempotency key). */
function isActorKeyViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      candidate.code === '23505' &&
      (candidate.constraint === 'assessment_requests_actor_key_key' ||
        candidate.constraint_name === 'assessment_requests_actor_key_key')
    ) {
      return true;
    }
    if (/assessment_requests_actor_key_key/.test(current.message)) return true;
  }
  return false;
}

export class AssessmentRunStore {
  private readonly db: JudgeDatabase;
  private readonly now: () => Date;
  private readonly afterRunLocked: AssessmentRunStoreOptions['afterRunLocked'];
  private readonly afterPendingLocked: AssessmentRunStoreOptions['afterPendingLocked'];

  constructor(options: AssessmentRunStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.afterRunLocked = options.afterRunLocked;
    this.afterPendingLocked = options.afterPendingLocked;
  }

  // -- S0: request, idempotency and pin ------------------------------------------------------------------------------------

  /**
   * The §8.6 matrix, in one transaction. Lock order: the (actor, key) advisory lock, then the project row. The advisory lock makes two
   * simultaneous requests with the same key serialize even when they name DIFFERENT projects (their project locks would not), so the
   * loser sees the winner's request and answers `key_reused` instead of failing on the unique index.
   */
  async requestAssessment(input: RequestAssessmentInput): Promise<RequestAssessmentResult> {
    const pipelineConfigHash = sha256Hex(canonicalJson(input.pipelineConfig));
    const request = requestIdentityOf({
      projectId: input.projectId,
      mode: input.mode,
      target: input.target,
      pipelineConfigHash,
      limits: { ...input.limits },
      priceTableId: input.priceTableId,
    });
    // Defense in depth: if the advisory lock were ever bypassed, the unique index would still reject the loser. That is retried once, so
    // the caller gets the controlled answer a lone retry would have got.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(input, request.key, pipelineConfigHash);
      } catch (error) {
        if (attempt === 0 && isActorKeyViolation(error)) continue;
        throw error;
      }
    }
  }

  private async requestOnce(
    input: RequestAssessmentInput,
    requestHash: string,
    pipelineConfigHash: string,
  ): Promise<RequestAssessmentResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assessment-request:${input.actorId}:${input.idempotencyKey}`}, 0))`,
      );
      const [project] = await tx
        .select({ id: projects.id, eventId: projects.eventId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .for('no key update');
      if (!project) throw new AssessmentRunError('run_not_found', 'project not found');

      // 1. an earlier request with this key
      const [previous] = await tx
        .select()
        .from(assessmentRequests)
        .where(
          and(
            eq(assessmentRequests.actorId, input.actorId),
            eq(assessmentRequests.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (previous) return this.replayOf(tx, previous, input, requestHash);

      // 1b. a voided project (P6B-beta2) starts no new assessment; its earlier ones stay readable and their replays above still answer
      const [voided] = await tx
        .select({ id: projectVoids.id })
        .from(projectVoids)
        .where(eq(projectVoids.projectId, project.id));
      if (voided) return { kind: 'project_voided' };

      // 2. pin
      const pins = await this.readPins(tx, project.id, project.eventId);
      if (pins === 'no_locked_context') return { kind: 'no_locked_context' };
      if (pins === 'no_source_snapshots') return { kind: 'no_source_snapshots' };
      if ('trackNotInContext' in pins) {
        return { kind: 'track_not_in_context', trackKey: pins.trackNotInContext };
      }
      if (
        input.target.kind === 'track' &&
        !pins.declaredTrackKeys.includes(input.target.trackKey)
      ) {
        return { kind: 'track_not_in_context', trackKey: input.target.trackKey };
      }

      // 2b. P6C F-3: a context with no explicit rule, requirement or declared track gives the assessment no reference evidence
      // (the worker would fail the run late, after it was queued). Refuse here, before any run or spend; nothing is invented.
      const pinned = await new LockedContextReader().read(
        tx,
        project.eventId,
        pins.contextVersionId,
      );
      if (pinned.ok && pinned.recomputedHash === pins.lockedContentHash) {
        // P6D: with no official OVERALL rubric the fallback rubric would apply and its anchors are not approved, so the run could only fail late
        // (`fallback_anchors_not_approved`). Track rubrics are never assessed in this milestone and nothing substitutes for the missing one.
        const { rubrics: contextRubrics, tracks: contextTracks } = pinned.snapshot.document;
        if (!contextRubrics.some((rubric) => rubric.scope === 'overall')) {
          return {
            kind: 'no_overall_rubric',
            trackRubrics: contextRubrics.filter((rubric) => rubric.scope === 'track').length,
          };
        }
        const reference = buildEventReferenceItems(pinned.snapshot, pins.declaredTrackKeys);
        if (reference.items.length === 0) {
          return {
            kind: 'no_context_reference_evidence',
            contextDefinesTracks: contextTracks.length > 0,
            declaredTrackKeys: [...pins.declaredTrackKeys],
            unofficialStatements: reference.exclusions.filter(
              (exclusion) => exclusion.code === 'not_official_source',
            ).length,
          };
        }
      }

      // 3. the intended assessment identity, frozen now: from the pins just read and the documented salt
      const requestId = randomUUID();
      const salt = input.mode === 'reassess' ? requestId : '';
      const assessment = assessmentIdentityOf({
        projectId: input.projectId,
        eventId: project.eventId,
        contextVersionId: pins.contextVersionId,
        lockedContentHash: pins.lockedContentHash,
        trackSelectionSetHash: pins.trackSelectionSetHash,
        declaredTrackKeys: pins.declaredTrackKeys,
        target: input.target,
        snapshots: pins.snapshots,
        pipelineConfigHash,
        salt,
      });

      // 4. `assess` with an equal assessment already on record: answer with it, spend nothing
      if (input.mode === 'assess') {
        const [equal] = await tx
          .select({ id: preInterviewAssessments.id })
          .from(preInterviewAssessments)
          .where(
            and(
              eq(preInterviewAssessments.projectId, input.projectId),
              eq(preInterviewAssessments.assessmentKey, assessment.key),
            ),
          );
        if (equal) {
          await tx.insert(assessmentRequests).values({
            id: requestId,
            projectId: input.projectId,
            actorId: input.actorId,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            mode: input.mode,
            assessmentId: equal.id,
          });
          return {
            kind: 'already_assessed',
            requestId,
            assessmentId: equal.id,
            replayed: false,
          };
        }
      }

      // 5. another run is active: 409, nothing recorded
      const [active] = await tx
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.projectId, input.projectId),
            eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
            inArray(analysisRuns.state, [...ACTIVE]),
          ),
        );
      if (active) return { kind: 'run_active_conflict', runId: active.id };

      // 6. a new run, its request, its pins and its budget limits: all or nothing
      const [run] = await tx
        .insert(analysisRuns)
        .values({
          runType: ASSESSMENT_RUN_TYPE,
          state: 'pending',
          eventId: project.eventId,
          projectId: input.projectId,
          contextVersionId: pins.contextVersionId,
          startedAt: null,
        })
        .returning({ id: analysisRuns.id });
      if (!run) throw new Error('internal: the run insert returned no row');
      await tx.insert(assessmentRequests).values({
        id: requestId,
        projectId: input.projectId,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        mode: input.mode,
        runId: run.id,
      });
      await tx.insert(assessmentRunInputs).values({
        runId: run.id,
        projectId: input.projectId,
        eventId: project.eventId,
        contextVersionId: pins.contextVersionId,
        lockedContentHash: pins.lockedContentHash,
        declaredTrackKeys: [...pins.declaredTrackKeys],
        trackSelectionIds: [...pins.trackSelectionIds],
        trackSelectionSetHash: pins.trackSelectionSetHash,
        targetKind: input.target.kind,
        targetTrackKey: input.target.kind === 'track' ? input.target.trackKey : null,
        inputsFingerprint: inputsFingerprint({
          contextVersionId: pins.contextVersionId,
          lockedContentHash: pins.lockedContentHash,
          trackSelectionSetHash: pins.trackSelectionSetHash,
          target: {
            kind: input.target.kind,
            trackKey: input.target.kind === 'track' ? input.target.trackKey : null,
          },
          snapshots: pins.snapshots.map((s) => ({
            snapshotId: s.snapshotId,
            contentHash: s.contentHash,
          })),
          pipelineConfigHash,
        }),
        pipelineConfig: input.pipelineConfig,
        pipelineConfigHash,
        assessmentKey: assessment.key,
        assessmentIdentityCanonical: assessment.canonical,
        requestedByActorId: input.actorId,
      });
      await tx.insert(assessmentRunInputSnapshots).values(
        pins.snapshots.map((snapshot) => ({
          runId: run.id,
          projectId: input.projectId,
          snapshotId: snapshot.snapshotId,
          snapshotContentHash: snapshot.contentHash,
        })),
      );
      await tx.insert(assessmentRunBudget).values({
        runId: run.id,
        maxCalls: input.limits.maxCalls,
        maxInputTokens: input.limits.maxInputTokens,
        maxOutputTokens: input.limits.maxOutputTokens,
        maxCostNanoUsd: input.limits.maxCostNanoUsd,
        maxReservedInputTokensPerCall: input.limits.maxReservedInputTokensPerCall,
        runWallClockMs: input.limits.runWallClockMs,
        priceTableId: input.priceTableId,
      });
      return { kind: 'run_created', requestId, runId: run.id };
    });
  }

  /** What a retry of an earlier request returns, derived ONLY from stable relations (the request row is never edited). */
  private async replayOf(
    tx: Executor,
    previous: typeof assessmentRequests.$inferSelect,
    input: RequestAssessmentInput,
    requestHash: string,
  ): Promise<RequestAssessmentResult> {
    // The request identity covers project, mode, target, configuration, limits and price table: anything different is a different request.
    if (
      previous.projectId !== input.projectId ||
      previous.requestHash !== requestHash ||
      previous.mode !== input.mode
    ) {
      return { kind: 'key_reused' };
    }
    if (previous.assessmentId !== null) {
      return {
        kind: 'already_assessed',
        requestId: previous.id,
        assessmentId: previous.assessmentId,
        replayed: true,
      };
    }
    const runId = previous.runId;
    if (runId === null) throw new Error('internal: a request names neither run nor assessment');
    const [run] = await tx.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    if (!run) throw new Error('internal: a request names a missing run');
    if (run.state === 'pending' || run.state === 'running') {
      return { kind: 'run_active', requestId: previous.id, runId, replayed: true };
    }
    if (run.state === 'succeeded') {
      const [assessment] = await tx
        .select({ id: preInterviewAssessments.id })
        .from(preInterviewAssessments)
        .where(eq(preInterviewAssessments.runId, runId));
      if (!assessment) throw new Error('internal: a succeeded run has no assessment');
      return {
        kind: 'run_succeeded',
        requestId: previous.id,
        runId,
        assessmentId: assessment.id,
        replayed: true,
      };
    }
    return {
      kind: 'run_failed',
      requestId: previous.id,
      runId,
      state: run.state,
      failureCategory: run.failureCategory,
      replayed: true,
    };
  }

  /** Reads what a new run would be pinned to. Called under the project lock; locks the version row FOR SHARE. */
  async readPins(
    tx: Executor,
    projectId: string,
    eventId: string,
  ): Promise<
    PinnedInputs | 'no_locked_context' | 'no_source_snapshots' | { trackNotInContext: string }
  > {
    const [version] = await tx
      .select()
      .from(eventContextVersions)
      .where(
        and(eq(eventContextVersions.eventId, eventId), eq(eventContextVersions.status, 'locked')),
      )
      .for('share');
    if (!version?.lockedContentHash) return 'no_locked_context';

    const selections = await tx
      .select({
        id: projectTrackSelections.id,
        trackKey: projectTrackSelections.trackKey,
        declaredAt: projectTrackSelections.declaredAt,
      })
      .from(projectTrackSelections)
      .where(eq(projectTrackSelections.projectId, projectId))
      .orderBy(desc(projectTrackSelections.declaredAt), desc(projectTrackSelections.id));
    const byKey = new Map<string, string>();
    for (const row of selections) if (!byKey.has(row.trackKey)) byKey.set(row.trackKey, row.id);
    const declared = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (declared.length > 0) {
      const present = await tx
        .select({ key: tracks.key })
        .from(tracks)
        .where(eq(tracks.contextVersionId, version.id));
      const keys = new Set(present.map((row) => row.key));
      const missing = declared.find(([key]) => !keys.has(key));
      // fail closed (design D4): a declared track the pinned version does not define is never silently dropped
      if (missing) return { trackNotInContext: missing[0] };
    }

    // the latest content-bearing capture of every declared source
    const rows = await tx
      .select({
        id: sourceSnapshots.id,
        projectSourceId: sourceSnapshots.projectSourceId,
        sourceType: sourceSnapshots.sourceType,
        contentHash: sourceSnapshots.contentHash,
        captureNumber: sourceSnapshots.captureNumber,
      })
      .from(sourceSnapshots)
      .innerJoin(projectSources, eq(projectSources.id, sourceSnapshots.projectSourceId))
      .where(
        and(
          eq(sourceSnapshots.projectId, projectId),
          inArray(sourceSnapshots.status, ['captured', 'partial']),
        ),
      )
      .orderBy(asc(sourceSnapshots.projectSourceId), desc(sourceSnapshots.captureNumber));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows)
      if (!latest.has(row.projectSourceId)) latest.set(row.projectSourceId, row);
    const snapshots = [...latest.values()]
      .map((row) => ({
        snapshotId: row.id,
        sourceType: row.sourceType,
        contentHash: row.contentHash ?? '',
      }))
      .sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : 1));
    if (snapshots.length === 0) return 'no_source_snapshots';

    return {
      eventId,
      contextVersionId: version.id,
      lockedContentHash: version.lockedContentHash,
      declaredTrackKeys: declared.map(([key]) => key),
      trackSelectionIds: declared.map(([, id]) => id),
      trackSelectionSetHash: trackSelectionSetHash(
        declared.map(([trackKey, selectionId]) => ({ selectionId, trackKey })),
      ),
      snapshots,
    };
  }

  // -- Lifecycle -------------------------------------------------------------------------------------------------------------

  async getRun(runId: string, executor: Executor = this.db): Promise<RunRecord | null> {
    const [row] = await executor.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    if (!row?.projectId || !row.eventId || !row.contextVersionId) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      eventId: row.eventId,
      contextVersionId: row.contextVersionId,
      state: row.state,
      failureCategory: row.failureCategory,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
      attemptCount: row.attemptCount,
    };
  }

  /** pending -> running with a lease. Returns the lease token, or null when the run is not pending. */
  async claimRun(runId: string, leaseMs: number): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for('update');
      if (run?.state !== 'pending') return null;
      return this.startLease(tx, run, leaseMs);
    });
  }

  /**
   * Claims the OLDEST claimable pending assessment run, atomically with its lease: one transaction, `FOR UPDATE SKIP LOCKED`, so a
   * run whose row another session holds (a competing claim, an expiry, a stuck transaction) is skipped instead of waited for. Two
   * workers can never receive the same run, a held lock never blocks the queue, and the caller never claims a second time: the
   * result is the lease it must run under. `createdAfter` (the pending-expiry cutoff) keeps a run the 15-minute policy is about to
   * cancel from being started. Returns null when nothing is claimable right now.
   * The state transition itself is the one `claimRun` uses (`startLease`). Lock order is unchanged: only the run row is locked.
   */
  async claimNextRun(
    leaseMs: number,
    options: { readonly createdAfter?: Date } = {},
  ): Promise<{ readonly runId: string; readonly leaseToken: string } | null> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
            eq(analysisRuns.state, 'pending'),
            ...(options.createdAfter === undefined
              ? []
              : [gt(analysisRuns.createdAt, options.createdAfter)]),
          ),
        )
        .orderBy(asc(analysisRuns.createdAt), asc(analysisRuns.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!run) return null;
      return { runId: run.id, leaseToken: await this.startLease(tx, run, leaseMs) };
    });
  }

  /** The single pending -> running transition (caller holds the run row lock and has seen `pending`). */
  private async startLease(
    tx: Executor,
    run: { id: string; attemptCount: number },
    leaseMs: number,
  ): Promise<string> {
    const token = randomUUID();
    const now = this.now();
    await tx
      .update(analysisRuns)
      .set({
        state: 'running',
        startedAt: now,
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attemptCount: run.attemptCount + 1,
      })
      .where(eq(analysisRuns.id, run.id));
    return token;
  }

  /** Extends the lease of a running run. False when the token is stale. */
  async heartbeat(runId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for('update');
      if (run?.state !== 'running' || run.leaseToken !== leaseToken) return false;
      await tx
        .update(analysisRuns)
        .set({ leaseExpiresAt: new Date(this.now().getTime() + leaseMs) })
        .where(eq(analysisRuns.id, runId));
      return true;
    });
  }

  /**
   * Stores the coverage record of this run's source selection (P6B-beta3-R1), once, under the lease and before any spend. The store does not
   * trust the caller: the text must parse as a `CoverageRecord`, be its own canonical form and hash to `sha256`, and name exactly the
   * snapshots the run pinned. A retry of the same run with the same inputs writes the identical record (a no-op); a different record for the
   * same run is refused, never replaced.
   */
  async recordCoverage(
    runId: string,
    leaseToken: string,
    input: { readonly canonical: string; readonly sha256: string },
  ): Promise<void> {
    let parsed: CoverageRecordType;
    try {
      parsed = CoverageRecord.parse(JSON.parse(input.canonical));
    } catch {
      throw new AssessmentRunError('coverage_rejected', 'the coverage record is not valid');
    }
    if (canonicalJson(parsed) !== input.canonical || sha256Hex(input.canonical) !== input.sha256) {
      throw new AssessmentRunError(
        'coverage_rejected',
        'the coverage record is not canonical or its hash differs',
      );
    }
    await this.db.transaction(async (tx) => {
      const run = await this.lockOwnRun(tx, runId, leaseToken);
      const pins = await tx
        .select({ id: assessmentRunInputSnapshots.snapshotId })
        .from(assessmentRunInputSnapshots)
        .where(eq(assessmentRunInputSnapshots.runId, runId));
      const pinned = pins.map((pin) => pin.id).sort();
      const recorded = parsed.snapshots.map((snapshot) => snapshot.snapshotId).sort();
      if (pinned.length !== recorded.length || pinned.some((id, i) => id !== recorded[i])) {
        throw new AssessmentRunError(
          'coverage_rejected',
          'the coverage record names other snapshots than the run pinned',
        );
      }
      const inserted = await tx
        .insert(assessmentRunCoverage)
        .values({
          runId,
          projectId: run.projectId,
          schemaId: parsed.schema,
          selectionPolicy: parsed.policy.selection,
          verdict: parsed.verdict,
          recordCanonical: input.canonical,
          recordSha256: input.sha256,
          record: JSON.parse(input.canonical) as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning({ runId: assessmentRunCoverage.runId });
      if (inserted.length === 0) {
        const [existing] = await tx
          .select({ sha: assessmentRunCoverage.recordSha256 })
          .from(assessmentRunCoverage)
          .where(eq(assessmentRunCoverage.runId, runId));
        if (existing?.sha !== input.sha256) {
          throw new AssessmentRunError(
            'coverage_rejected',
            'a different coverage record is already stored for this run',
          );
        }
      }
    });
  }

  /**
   * Records which extraction of `kind` this running run uses (written when the graph is created or reused). Before it is bound, the
   * extraction is checked against what the run pinned (R4 F6/F8), so a run can never use an extraction that is not about its inputs:
   *   source           the extraction covers EXACTLY the snapshots the run pinned (incomplete or extra coverage is refused);
   *   context_evidence it is of the pinned version, was built for exactly the declared tracks, and equals, member by member, the
   *                    reference set RECOMPUTED from the pinned locked document (forged metadata, forged text or an over-declared
   *                    track set does not match).
   * The database triggers of migration 0013 repeat the structural parts of these checks.
   */
  async bindExtraction(
    runId: string,
    leaseToken: string,
    kind: ExtractionKind,
    extractionId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = await this.lockOwnRun(tx, runId, leaseToken);
      const [inputs] = await tx
        .select()
        .from(assessmentRunInputs)
        .where(eq(assessmentRunInputs.runId, runId));
      if (!inputs) throw new AssessmentRunError('inputs_missing', 'the run has no pinned inputs');
      const [extraction] = await tx
        .select()
        .from(graphExtractions)
        .where(
          and(eq(graphExtractions.id, extractionId), eq(graphExtractions.projectId, run.projectId)),
        );
      if (!extraction || extraction.kind !== kind) {
        throw new AssessmentRunError(
          'extraction_kind_mismatch',
          'the extraction is not of this project or not of the stated kind',
        );
      }
      if (kind === 'source') {
        const pins = await tx
          .select({ id: assessmentRunInputSnapshots.snapshotId })
          .from(assessmentRunInputSnapshots)
          .where(eq(assessmentRunInputSnapshots.runId, runId));
        const pinned = new Set(pins.map((pin) => pin.id));
        const covered = new Set(extraction.snapshotIds);
        if (
          pinned.size !== covered.size ||
          [...pinned].some((id) => !covered.has(id)) ||
          extraction.snapshotIds.length !== covered.size
        ) {
          throw new AssessmentRunError(
            'extraction_rejected',
            'a source extraction must cover exactly the snapshots the run pinned',
          );
        }
      } else {
        if (extraction.contextVersionId !== inputs.contextVersionId) {
          throw new AssessmentRunError(
            'extraction_rejected',
            'the context extraction is not of the pinned context version',
          );
        }
        const declared = [...inputs.declaredTrackKeys].sort();
        const built = [...extraction.declaredTrackKeys].sort();
        if (declared.length !== built.length || declared.some((key, i) => key !== built[i])) {
          throw new AssessmentRunError(
            'extraction_rejected',
            'the context extraction was built for other declared tracks than the run declares',
          );
        }
        const context = await new LockedContextReader().read(
          tx,
          inputs.eventId,
          inputs.contextVersionId,
        );
        if (!context.ok || context.recomputedHash !== inputs.lockedContentHash) {
          throw new AssessmentRunError(
            'extraction_rejected',
            'the pinned context version cannot be read back as it was pinned',
          );
        }
        const itemRows = await tx
          .select()
          .from(graphExtractionItems)
          .where(eq(graphExtractionItems.extractionId, extraction.id))
          .orderBy(asc(graphExtractionItems.recordType), asc(graphExtractionItems.ordinal));
        const texts = itemRows.length
          ? await tx
              .select({ id: evidenceItems.id, text: evidenceItems.text })
              .from(evidenceItems)
              .where(
                and(
                  eq(evidenceItems.projectId, run.projectId),
                  inArray(
                    evidenceItems.id,
                    itemRows.map((item) => item.recordId),
                  ),
                ),
              )
          : [];
        const mismatch = referenceSetMismatch({
          locked: context.snapshot,
          declaredTrackKeys: inputs.declaredTrackKeys,
          items: itemRows.map((item) => ({
            recordType: item.recordType,
            recordId: item.recordId,
            ordinal: item.ordinal,
            role: item.role,
            grounding: item.grounding,
            relationBasis: item.relationBasis,
            reference:
              item.referenceBuilder !== null &&
              item.referenceKind !== null &&
              item.referenceApplicability !== null
                ? {
                    builder: item.referenceBuilder as EventReferenceMeta['builder'],
                    kind: item.referenceKind,
                    applicability: item.referenceApplicability,
                    trackKey: item.referenceTrackKey,
                  }
                : null,
          })),
          textById: new Map(texts.map((row) => [row.id, row.text])),
        });
        if (mismatch !== null) {
          throw new AssessmentRunError(
            'extraction_rejected',
            `the context extraction is not the reference set of the pinned locked document (${mismatch})`,
          );
        }
      }
      await tx.insert(assessmentRunExtractions).values({
        runId,
        projectId: run.projectId,
        kind,
        extractionId,
      });
    });
  }

  /**
   * Ends a run WITHOUT an assessment: any still-reserved call becomes `unknown` (counted at its worst case), the state moves to
   * `failed`/`cancelled`, and the outcome row with the ledger totals is written, all in one transaction. A failed run can never
   * have an assessment (deferred trigger). Lock order: run (FOR UPDATE) -> budget (FOR UPDATE) -> ledger rows.
   */
  async finishRun(input: FinishRunInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, input.runId);
      if (run.state !== 'pending' && run.state !== 'running') {
        throw new AssessmentRunError('wrong_state', `run is already ${run.state}`);
      }
      if (input.leaseToken !== undefined && run.leaseToken !== input.leaseToken) {
        throw new AssessmentRunError('lease_mismatch', "the lease token is not the run's");
      }
      await this.afterRunLocked?.('finish');
      await this.terminalize(tx, run, input);
    });
  }

  /**
   * Fails every running assessment run whose lease expired before `before` (a crashed worker): in-flight attempts become `unknown`,
   * the run ends `failed (internal_error / worker_lease_expired)`, nothing is re-run automatically. Returns the run ids.
   * The list is only a hint: each run is re-validated under its own row lock by `recoverRun`.
   */
  async recoverExpiredRuns(before: Date = this.now()): Promise<string[]> {
    const expired = await this.db
      .select({ id: analysisRuns.id })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
          eq(analysisRuns.state, 'running'),
          lt(analysisRuns.leaseExpiresAt, before),
        ),
      );
    const recovered: string[] = [];
    for (const { id } of expired) {
      if (await this.recoverRun(id, before)) recovered.push(id);
    }
    return recovered;
  }

  /**
   * Recovers ONE run, re-checking under the row lock that it is still running and that its lease has STILL expired before `before`.
   * A heartbeat that renewed the lease first (or a worker that finished first) wins: this returns false and changes nothing. Safe to
   * call repeatedly and concurrently (idempotent).
   */
  async recoverRun(runId: string, before: Date = this.now()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // SKIP LOCKED: a run whose row someone else holds right now (a heartbeat, a finishing worker, a stuck session) is not recovered
      // by THIS pass, which must not wait for it; the next pass re-checks it under the same rules.
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for('update', { skipLocked: true });
      if (
        !run?.projectId ||
        run.runType !== ASSESSMENT_RUN_TYPE ||
        run.state !== 'running' ||
        run.leaseExpiresAt === null ||
        run.leaseExpiresAt.getTime() >= before.getTime()
      ) {
        return false;
      }
      await this.afterRunLocked?.('recover');
      await this.terminalize(
        tx,
        { ...run, projectId: run.projectId },
        {
          state: 'failed',
          failureCategory: 'internal_error',
          failureCode: 'worker_lease_expired',
        },
      );
      return true;
    });
  }

  /**
   * Cancels ONE abandoned pending run (`cancelled / pending_expired`), re-checking UNDER THE RUN ROW LOCK that the run is still
   * `pending` and was created before `createdBefore`. The cancellation is written in the same transaction as those checks, through
   * the same terminal path as every other end (`terminalize`: ledger reaped, outcome row written).
   *
   * A list of expired pending runs is only a hint. A worker that claimed the run first (it is `running` now) or that is claiming it
   * right now wins: this returns false and changes nothing, so a pending-expiry pass can never end a running run. If this locks
   * first and commits, a later `claimRun` finds the run `cancelled` and is refused. Safe to call repeatedly and concurrently
   * (idempotent). Lock order: run -> budget -> ledger rows, as in `finishRun`.
   */
  async expirePendingRun(
    runId: string,
    createdBefore: Date,
    failureCode: 'pending_expired' | 'cancelled_by_void' = 'pending_expired',
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // SKIP LOCKED: a pending run whose row another session holds (a claim in progress, a stuck transaction) is left alone by this
      // pass and re-examined by the next one; maintenance never waits for an unrelated lock.
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for('update', { skipLocked: true });
      if (
        !run?.projectId ||
        run.runType !== ASSESSMENT_RUN_TYPE ||
        run.state !== 'pending' ||
        run.createdAt.getTime() >= createdBefore.getTime()
      ) {
        return false;
      }
      await this.afterPendingLocked?.();
      await this.terminalize(
        tx,
        { ...run, projectId: run.projectId },
        { state: 'cancelled', failureCode, stageReached: 'pending' },
      );
      return true;
    });
  }

  /**
   * Cancels a `pending` assessment run INSIDE a transaction the caller already holds (a correction that voids the project and cancels the
   * requests no worker started). Same terminal path as every other end. Returns false, changing nothing, when the run is not pending any more.
   */
  async cancelPendingWithin(
    tx: Executor,
    runId: string,
    failureCode: 'cancelled_by_void',
  ): Promise<boolean> {
    const [run] = await tx
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.id, runId))
      .for('update');
    if (!run?.projectId || run.runType !== ASSESSMENT_RUN_TYPE || run.state !== 'pending')
      return false;
    await this.terminalize(
      tx,
      { ...run, projectId: run.projectId },
      { state: 'cancelled', failureCode, stageReached: 'pending' },
    );
    return true;
  }

  /** `SELECT ... FOR UPDATE` of a run, the first lock of every terminal path. */
  private async lockRun(tx: Executor, runId: string) {
    const [run] = await tx
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.id, runId))
      .for('update');
    if (!run?.projectId) throw new AssessmentRunError('run_not_found', 'run not found');
    return { ...run, projectId: run.projectId };
  }

  /** The terminal write of a failed or cancelled run; the caller holds the run row lock. */
  private async terminalize(
    tx: Executor,
    run: { id: string; projectId: string; startedAt: Date | null },
    input: {
      state: 'failed' | 'cancelled';
      failureCategory?: AssessmentRunFailureCategory;
      failureCode: string;
      stageReached?: string;
      providerMode?: ProviderMode;
    },
  ): Promise<void> {
    await this.reapReserved(tx, run.id, 'run_ended');
    const finishedAt = this.now();
    const failureCategory =
      input.state === 'failed' ? (input.failureCategory ?? 'internal_error') : null;
    await tx
      .update(analysisRuns)
      .set({
        state: input.state,
        failureCategory,
        startedAt: run.startedAt ?? finishedAt,
        finishedAt,
      })
      .where(eq(analysisRuns.id, run.id));
    await this.writeOutcome(tx, {
      runId: run.id,
      projectId: run.projectId,
      outcome: input.state,
      failureCategory,
      failureCode: input.failureCode,
      stageReached: input.stageReached ?? null,
      providerMode: input.providerMode ?? null,
    });
  }

  /** Locks and returns a RUNNING run, checking the lease. */
  async lockOwnRun(tx: Executor, runId: string, leaseToken: string) {
    const [run] = await tx
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.id, runId))
      .for('update');
    if (!run?.projectId) throw new AssessmentRunError('run_not_found', 'run not found');
    if (run.state !== 'running') {
      throw new AssessmentRunError('wrong_state', `run is ${run.state}, not running`);
    }
    if (run.leaseToken !== leaseToken) {
      throw new AssessmentRunError('lease_mismatch', "the lease token is not the run's");
    }
    return { ...run, projectId: run.projectId };
  }

  /** Turns every `reserved` ledger row of the run into `unknown` at its worst case. Returns how many. */
  reapReserved(tx: Executor, runId: string, outcomeCode: string): Promise<number> {
    return reapReservedCalls(tx, runId, outcomeCode);
  }

  /** The outcome row: totals are the ledger's, computed in the same transaction (the trigger re-verifies them). */
  async writeOutcome(
    tx: Executor,
    outcome: {
      runId: string;
      projectId: string;
      outcome: 'succeeded' | 'failed' | 'cancelled';
      failureCategory: string | null;
      failureCode: string | null;
      stageReached: string | null;
      providerMode: ProviderMode | null;
    },
  ): Promise<void> {
    const [totals] = await tx
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
        // M6 phase 0: only a live row is an external provider invocation (a released reservation never reached the provider)
        liveCalls:
          sql<number>`count(*) filter (where ${assessmentRunCalls.providerMode} = 'live' and ${assessmentRunCalls.state} <> 'released')`.mapWith(
            Number,
          ),
      })
      .from(assessmentRunCalls)
      .where(eq(assessmentRunCalls.runId, outcome.runId));
    await tx.insert(assessmentRunOutcomes).values({
      runId: outcome.runId,
      projectId: outcome.projectId,
      outcome: outcome.outcome,
      failureCategory: outcome.failureCategory,
      failureCode: outcome.failureCode,
      stageReached: outcome.stageReached,
      providerMode: outcome.providerMode,
      attemptsStarted: totals?.attempts ?? 0,
      settledCalls: totals?.settled ?? 0,
      unknownCalls: totals?.unknown ?? 0,
      releasedCalls: totals?.released ?? 0,
      inputTokens: totals?.input ?? 0,
      outputTokens: totals?.output ?? 0,
      costNanoUsd: totals?.cost ?? 0,
      stageExecutions: totals?.attempts ?? 0,
      providerCalls: totals?.liveCalls ?? 0,
    });
  }

  /** The stored response of a request, or null. Used by tests and by the API's idempotent replay. */
  async getRequest(actorId: string, idempotencyKey: string) {
    const [row] = await this.db
      .select()
      .from(assessmentRequests)
      .where(
        and(
          eq(assessmentRequests.actorId, actorId),
          eq(assessmentRequests.idempotencyKey, idempotencyKey),
        ),
      );
    return row ?? null;
  }

  /** All assessment runs of a project that are not the given one (test helper for exclusion checks). */
  async otherActiveRuns(projectId: string, exceptRunId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: analysisRuns.id })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.projectId, projectId),
          eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
          inArray(analysisRuns.state, [...ACTIVE]),
          ne(analysisRuns.id, exceptRunId),
        ),
      );
    return rows.map((row) => row.id);
  }
}
