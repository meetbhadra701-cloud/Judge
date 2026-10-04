import { randomUUID } from 'node:crypto';
import { createAuditEvent } from '@judge-copilot/audit';
import { isContentResult, snapshotContentHash, type CaptureResult } from '@judge-copilot/capture';
import {
  analysisRuns,
  createDatabaseAuditSink,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  type JudgeDatabase,
} from '@judge-copilot/database';
import type {
  AnalysisRunFailureCategory,
  CaptureFailureCategory,
  ProjectSourceType,
} from '@judge-copilot/schemas';
import { and, asc, eq, lt } from 'drizzle-orm';

/*
 * PostgreSQL-backed capture queue (no external broker). A pending `project_source_capture`
 * analysis run is the durable work item; its pending snapshot is the capture request.
 *
 *   claim     — one short transaction: SELECT … FOR UPDATE SKIP LOCKED, mark the run running with
 *               a fresh lease token. Two workers can never claim the same run.
 *   capture   — runs with NO transaction open (see runner.ts).
 *   finalize  — one short transaction: re-lock the run and snapshot, check the lease token is
 *               still ours and the snapshot still pending, store artifacts, make the snapshot
 *               terminal, finish the run, audit. A lost lease discards the result.
 */

export const SOURCE_CAPTURE_RUN_TYPE = 'project_source_capture';

export const CAPTURE_AUDIT_ACTIONS = {
  captured: 'source_snapshot_captured',
  partial: 'source_snapshot_partial',
  failed: 'source_snapshot_failed',
  rejected: 'source_snapshot_rejected',
} as const;

export interface CaptureClaim {
  readonly runId: string;
  readonly leaseToken: string;
  readonly snapshotId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly sourceType: ProjectSourceType;
  readonly sourceUrl: string;
  readonly captureNumber: number;
}

export interface FinalizeInput {
  readonly result: CaptureResult;
  readonly attempts: number;
  /** When the adapter returned (content statuses record it as the capture time). */
  readonly capturedAt: Date;
  /** Run state override for shutdown: the snapshot fails, the run is cancelled. */
  readonly cancelled?: boolean;
}

export type FinalizeOutcome = 'finalized' | 'lease_lost';

export interface QueueOptions {
  readonly db: JudgeDatabase;
  readonly leaseMs: number;
  readonly now?: () => Date;
}

function runFailureCategory(category: CaptureFailureCategory): AnalysisRunFailureCategory {
  if (category === 'timeout') return 'timeout';
  if (category === 'internal_error') return 'internal_error';
  return 'source_unavailable';
}

/** The run outcome for a snapshot outcome. Policy rejections are completed work, not failures. */
function runStateFor(result: CaptureResult, cancelled: boolean) {
  if (cancelled) return { state: 'cancelled' as const, failureCategory: null };
  if (result.status === 'failed') {
    return {
      state: 'failed' as const,
      failureCategory: runFailureCategory(result.failure.category),
    };
  }
  return { state: 'succeeded' as const, failureCategory: null };
}

const ARTIFACT_BATCH = 50;

export class CaptureQueue {
  private readonly db: JudgeDatabase;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(options: QueueOptions) {
    this.db = options.db;
    this.leaseMs = options.leaseMs;
    this.now = options.now ?? (() => new Date());
  }

  async claim(): Promise<CaptureClaim | null> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(
          and(eq(analysisRuns.runType, SOURCE_CAPTURE_RUN_TYPE), eq(analysisRuns.state, 'pending')),
        )
        .orderBy(asc(analysisRuns.createdAt), asc(analysisRuns.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!run?.sourceSnapshotId) return null;
      const [snapshot] = await tx
        .select()
        .from(sourceSnapshots)
        .where(eq(sourceSnapshots.id, run.sourceSnapshotId));
      if (!snapshot) return null;
      const now = this.now();
      const leaseToken = randomUUID();
      await tx
        .update(analysisRuns)
        .set({
          state: 'running',
          startedAt: now,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        })
        .where(eq(analysisRuns.id, run.id));
      return {
        runId: run.id,
        leaseToken,
        snapshotId: snapshot.id,
        projectId: snapshot.projectId,
        sourceId: snapshot.projectSourceId,
        sourceType: snapshot.sourceType,
        sourceUrl: snapshot.sourceUrl,
        captureNumber: snapshot.captureNumber,
      };
    });
  }

  async finalize(claim: CaptureClaim, input: FinalizeInput): Promise<FinalizeOutcome> {
    const { result } = input;
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, claim.runId))
        .for('update');
      if (!run || run.state !== 'running' || run.leaseToken !== claim.leaseToken)
        return 'lease_lost';
      const [snapshot] = await tx
        .select()
        .from(sourceSnapshots)
        .where(eq(sourceSnapshots.id, claim.snapshotId))
        .for('update');
      if (!snapshot || snapshot.status !== 'pending') return 'lease_lost';
      const completedAt = this.now();
      const audit: Record<string, string | number | boolean | null | string[]> = {
        projectId: claim.projectId,
        sourceId: claim.sourceId,
        sourceType: claim.sourceType,
        captureNumber: claim.captureNumber,
        runId: claim.runId,
        attempts: input.attempts,
      };

      if (isContentResult(result)) {
        for (let index = 0; index < result.artifacts.length; index += ARTIFACT_BATCH) {
          await tx.insert(sourceSnapshotArtifacts).values(
            result.artifacts.slice(index, index + ARTIFACT_BATCH).map((artifact) => ({
              snapshotId: claim.snapshotId,
              artifactKey: artifact.key,
              artifactKind: artifact.kind,
              mediaType: artifact.mediaType,
              textContent: artifact.textContent,
              metadata: artifact.metadata,
              byteLength: artifact.byteLength,
              contentHash: artifact.contentHash,
              createdAt: completedAt,
            })),
          );
        }
        const contentHash = snapshotContentHash({
          sourceType: claim.sourceType,
          sourceUrl: claim.sourceUrl,
          revision: result.revision,
          metadata: result.metadata,
          partialReasons: result.partialReasons,
          artifacts: result.artifacts,
        });
        const capturedAt =
          input.capturedAt < snapshot.createdAt ? snapshot.createdAt : input.capturedAt;
        await tx
          .update(sourceSnapshots)
          .set({
            status: result.status,
            revision: result.revision,
            metadata: result.metadata,
            contentHash,
            partialReasons: [...result.partialReasons],
            capturedAt,
            completedAt: completedAt < capturedAt ? capturedAt : completedAt,
          })
          .where(eq(sourceSnapshots.id, claim.snapshotId));
        Object.assign(audit, {
          revision: result.revision,
          contentHash,
          artifactCount: result.artifacts.length,
          capturedBytes: result.artifacts.reduce(
            (total, artifact) => total + artifact.byteLength,
            0,
          ),
          partialReasons: [...result.partialReasons],
        });
      } else {
        await tx
          .update(sourceSnapshots)
          .set({
            status: result.status,
            failureCategory: result.failure.category,
            failureMetadata: result.failure.metadata,
            completedAt,
          })
          .where(eq(sourceSnapshots.id, claim.snapshotId));
        Object.assign(audit, {
          failureCategory: result.failure.category,
          ...(result.failure.metadata.reason ? { reason: result.failure.metadata.reason } : {}),
          ...(result.failure.metadata.httpStatus
            ? { httpStatus: result.failure.metadata.httpStatus }
            : {}),
        });
      }

      const outcome = runStateFor(result, input.cancelled ?? false);
      await tx
        .update(analysisRuns)
        .set({
          state: outcome.state,
          failureCategory: outcome.failureCategory,
          finishedAt: completedAt,
          attemptCount: input.attempts,
        })
        .where(eq(analysisRuns.id, claim.runId));
      // Worker actions are system actions: no human actor.
      await createDatabaseAuditSink(tx).append(
        createAuditEvent({
          actorId: null,
          entityType: 'source_snapshot',
          entityId: claim.snapshotId,
          action: CAPTURE_AUDIT_ACTIONS[result.status],
          metadata: audit,
        }),
      );
      return 'finalized';
    });
  }

  /**
   * Fails captures whose worker vanished (lease expired while running). The snapshot becomes
   * `failed` (`internal_error`, reason `worker_lease_expired`); a new capture can be requested.
   */
  async reapExpired(): Promise<number> {
    const expired = await this.db
      .select({
        id: analysisRuns.id,
        leaseToken: analysisRuns.leaseToken,
        snapshotId: analysisRuns.sourceSnapshotId,
      })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.runType, SOURCE_CAPTURE_RUN_TYPE),
          eq(analysisRuns.state, 'running'),
          lt(analysisRuns.leaseExpiresAt, this.now()),
        ),
      )
      .limit(20);
    let reaped = 0;
    for (const run of expired) {
      if (!run.leaseToken || !run.snapshotId) continue;
      const [snapshot] = await this.db
        .select()
        .from(sourceSnapshots)
        .where(eq(sourceSnapshots.id, run.snapshotId));
      if (!snapshot) continue;
      const outcome = await this.finalize(
        {
          runId: run.id,
          leaseToken: run.leaseToken,
          snapshotId: snapshot.id,
          projectId: snapshot.projectId,
          sourceId: snapshot.projectSourceId,
          sourceType: snapshot.sourceType,
          sourceUrl: snapshot.sourceUrl,
          captureNumber: snapshot.captureNumber,
        },
        {
          result: {
            status: 'failed',
            failure: { category: 'internal_error', metadata: { reason: 'worker_lease_expired' } },
          },
          attempts: 0,
          capturedAt: this.now(),
        },
      );
      if (outcome === 'finalized') reaped += 1;
    }
    return reaped;
  }
}
