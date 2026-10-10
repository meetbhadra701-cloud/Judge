import { randomUUID } from 'node:crypto';
import {
  ASSESSMENT_RUN_TYPE,
  type AssessmentRequestMode,
  type AssessmentRunFailureCategory,
  type AssessmentRunLimits,
  type ExtractionKind,
  type ProviderMode,
} from '@judge-copilot/schemas';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { inputsFingerprint, trackSelectionSetHash } from './assessment-hashes.js';
import type { JudgeDatabase } from './client.js';
import { reapReservedCalls } from './run-budget-store.js';
import {
  analysisRuns,
  assessmentRequests,
  assessmentRunBudget,
  assessmentRunCalls,
  assessmentRunExtractions,
  assessmentRunInputs,
  assessmentRunInputSnapshots,
  assessmentRunOutcomes,
  eventContextVersions,
  preInterviewAssessments,
  projects,
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

export interface RequestAssessmentInput {
  readonly projectId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly mode: AssessmentRequestMode;
  /** SHA-256 of the canonical request body: the same key with a different body is `key_reused`. */
  readonly requestHash: string;
  readonly target: AssessmentTarget;
  readonly pipelineConfig: Record<string, unknown>;
  readonly pipelineConfigHash: string;
  readonly limits: AssessmentRunLimits;
  readonly priceTableId: string;
  /**
   * PURE. Derives `assessment_key` from what was just pinned and the salt ("" for `assess`, the request id for `reassess`). It runs
   * inside the transaction, so it must not perform I/O.
   */
  readonly assessmentKey: (pins: PinnedInputs, salt: string) => string;
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
  | { readonly kind: 'no_locked_context' }
  | { readonly kind: 'no_source_snapshots' }
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
      | 'extraction_kind_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'AssessmentRunError';
  }
}

export interface AssessmentRunStoreOptions {
  readonly db: JudgeDatabase;
  readonly now?: () => Date;
}

const ACTIVE = ['pending', 'running'] as const;

export class AssessmentRunStore {
  private readonly db: JudgeDatabase;
  private readonly now: () => Date;

  constructor(options: AssessmentRunStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  // -- S0: request, idempotency and pin ------------------------------------------------------------------------------------

  /** The §8.6 matrix, in one transaction under the project lock. */
  async requestAssessment(input: RequestAssessmentInput): Promise<RequestAssessmentResult> {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ id: projects.id, eventId: projects.eventId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .for('no key update');
      if (!project) throw new AssessmentRunError('run_not_found', 'project not found');

      // 1. an earlier request with this key (the UNIQUE(actor, key) index plus the project lock serialize simultaneous requests)
      const [previous] = await tx
        .select()
        .from(assessmentRequests)
        .where(
          and(
            eq(assessmentRequests.actorId, input.actorId),
            eq(assessmentRequests.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (previous) return this.replayOf(tx, previous, input);

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

      const requestId = randomUUID();
      const salt = input.mode === 'reassess' ? requestId : '';
      const assessmentKey = input.assessmentKey(pins, salt);

      // 3. `assess` with an equal assessment already on record: answer with it, spend nothing
      if (input.mode === 'assess') {
        const [equal] = await tx
          .select({ id: preInterviewAssessments.id })
          .from(preInterviewAssessments)
          .where(
            and(
              eq(preInterviewAssessments.projectId, input.projectId),
              eq(preInterviewAssessments.assessmentKey, assessmentKey),
            ),
          );
        if (equal) {
          await tx.insert(assessmentRequests).values({
            id: requestId,
            projectId: input.projectId,
            actorId: input.actorId,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
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

      // 4. another run is active: 409, nothing recorded
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

      // 5. a new run, its request, its pins and its budget limits: all or nothing
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
        requestHash: input.requestHash,
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
          pipelineConfigHash: input.pipelineConfigHash,
        }),
        pipelineConfig: input.pipelineConfig,
        pipelineConfigHash: input.pipelineConfigHash,
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
  ): Promise<RequestAssessmentResult> {
    if (previous.requestHash !== input.requestHash || previous.mode !== input.mode) {
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
        .where(eq(analysisRuns.id, runId));
      return token;
    });
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

  /** Records which extraction of `kind` this running run uses (written when the graph is created or reused). */
  async bindExtraction(
    runId: string,
    leaseToken: string,
    kind: ExtractionKind,
    extractionId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = await this.lockOwnRun(tx, runId, leaseToken);
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
   * have an assessment (deferred trigger).
   */
  async finishRun(input: FinishRunInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, input.runId))
        .for('update');
      if (!run?.projectId) throw new AssessmentRunError('run_not_found', 'run not found');
      if (run.state !== 'pending' && run.state !== 'running') {
        throw new AssessmentRunError('wrong_state', `run is already ${run.state}`);
      }
      if (input.leaseToken !== undefined && run.leaseToken !== input.leaseToken) {
        throw new AssessmentRunError('lease_mismatch', "the lease token is not the run's");
      }
      await this.reapReserved(tx, input.runId, 'run_ended');
      const finishedAt = this.now();
      await tx
        .update(analysisRuns)
        .set({
          state: input.state,
          failureCategory:
            input.state === 'failed' ? (input.failureCategory ?? 'internal_error') : null,
          startedAt: run.startedAt ?? finishedAt,
          finishedAt,
        })
        .where(eq(analysisRuns.id, input.runId));
      await this.writeOutcome(tx, {
        runId: input.runId,
        projectId: run.projectId,
        outcome: input.state,
        failureCategory:
          input.state === 'failed' ? (input.failureCategory ?? 'internal_error') : null,
        failureCode: input.failureCode,
        stageReached: input.stageReached ?? null,
        providerMode: input.providerMode ?? null,
      });
    });
  }

  /**
   * Fails every running assessment run whose lease expired before `before` (a crashed worker): in-flight attempts become `unknown`,
   * the run ends `failed (internal_error / worker_lease_expired)`, nothing is re-run automatically. Returns the run ids.
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
      try {
        await this.finishRun({
          runId: id,
          state: 'failed',
          failureCategory: 'internal_error',
          failureCode: 'worker_lease_expired',
        });
        recovered.push(id);
      } catch (error) {
        // another process finished it first
        if (!(error instanceof AssessmentRunError && error.code === 'wrong_state')) throw error;
      }
    }
    return recovered;
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
