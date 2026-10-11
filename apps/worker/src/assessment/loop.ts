import {
  analysisRuns,
  AssessmentRunError,
  type AssessmentRunStore,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { ASSESSMENT_RUN_TYPE } from '@judge-copilot/schemas';
import type { Logger } from '@judge-copilot/shared';
import { and, asc, eq, lt } from 'drizzle-orm';
import { safeErrorCode } from '../capture/safe-error.js';
import { runAssessment, type PipelineDeps, type RunOutcome } from './pipeline.js';

/*
 * The assessment work loop (design §10.3), a sibling of the capture loop.
 *
 *   claim      a pending `pre_interview_assessment` run is the durable work item. `claimRun` locks the run row and re-checks that it is
 *              still `pending`, so two workers (or two loops) can never both own one run; the loser simply moves on.
 *   pending    a run nobody claimed within `pendingMaxAgeMs` (the request handler died before a worker started: default 15 minutes) is
 *              CANCELLED `pending_expired`. A pending run cannot own a ledger row, so nothing was spent; the project is free again.
 *   expired    a running run whose lease expired (a crashed worker) is failed `internal_error / worker_lease_expired` and its in-flight
 *              attempts are counted at their worst case. Nothing is re-run automatically.
 *   shutdown   `stop()` waits a grace period for in-flight runs, then aborts them: each cancels its provider call and ends `cancelled`
 *              (`worker_shutdown`). Concurrency is bounded (default 1, at most 2); model calls inside one run are always sequential.
 */

export const PENDING_MAX_AGE_DEFAULT_MS = 15 * 60_000;

export interface AssessmentLoopOptions {
  readonly db: JudgeDatabase;
  readonly runs: AssessmentRunStore;
  /** The pipeline dependencies WITHOUT the shutdown signal, which the loop owns. */
  readonly pipeline: Omit<PipelineDeps, 'shutdown'>;
  readonly logger: Logger;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  /** A pending run older than this is cancelled. Configurable; the approved default is 15 minutes. */
  readonly pendingMaxAgeMs?: number;
  readonly shutdownGraceMs?: number;
  readonly now?: () => Date;
  /** Called with every run's outcome (tests and operational metrics). */
  readonly onOutcome?: (runId: string, outcome: RunOutcome) => void;
}

export interface AssessmentLoop {
  start(): void;
  stop(): Promise<void>;
  /** Claims and runs work until none is left (tests and demos). Returns the number of runs started. */
  drain(): Promise<number>;
  readonly inFlight: number;
  /** One maintenance pass: expire abandoned pending runs and recover runs whose lease expired. */
  maintain(): Promise<{ expiredPending: string[]; recovered: string[] }>;
}

export function createAssessmentLoop(options: AssessmentLoopOptions): AssessmentLoop {
  const { db, runs, logger } = options;
  const now = options.now ?? (() => new Date());
  const pendingMaxAgeMs = options.pendingMaxAgeMs ?? PENDING_MAX_AGE_DEFAULT_MS;
  const active = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let ticking = false;

  async function pendingRunIds(limit: number): Promise<string[]> {
    const rows = await db
      .select({ id: analysisRuns.id })
      .from(analysisRuns)
      .where(and(eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE), eq(analysisRuns.state, 'pending')))
      .orderBy(asc(analysisRuns.createdAt), asc(analysisRuns.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async function expirePending(): Promise<string[]> {
    const cutoff = new Date(now().getTime() - pendingMaxAgeMs);
    const stale = await db
      .select({ id: analysisRuns.id })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.runType, ASSESSMENT_RUN_TYPE),
          eq(analysisRuns.state, 'pending'),
          lt(analysisRuns.createdAt, cutoff),
        ),
      );
    const expired: string[] = [];
    for (const { id } of stale) {
      try {
        await runs.finishRun({
          runId: id,
          state: 'cancelled',
          failureCode: 'pending_expired',
          stageReached: 'pending',
        });
        expired.push(id);
      } catch (error) {
        // a worker claimed it, or it ended, between the list and the cancel: idempotent, nothing to do
        if (!(error instanceof AssessmentRunError)) throw error;
      }
    }
    return expired;
  }

  async function maintain() {
    const recovered = await runs.recoverExpiredRuns(now());
    const expiredPending = await expirePending();
    return { expiredPending, recovered };
  }

  function launch(runId: string): void {
    const job = runAssessment({ ...options.pipeline, shutdown: controller.signal }, runId)
      .then((outcome) => {
        options.onOutcome?.(runId, outcome);
      })
      .catch((error: unknown) => {
        // Never `err: error`: driver errors embed bound parameters (captured source text).
        logger.error({ runId, errorCode: safeErrorCode(error) }, 'assessment job error');
      })
      .finally(() => {
        active.delete(runId);
      });
    active.set(runId, job);
  }

  async function fill(): Promise<number> {
    const attempted = new Set<string>();
    while (running && active.size < options.concurrency) {
      const candidates = (
        await pendingRunIds(options.concurrency + active.size + attempted.size)
      ).filter((id) => !active.has(id) && !attempted.has(id));
      const next = candidates[0];
      if (next === undefined) break;
      // `launch` registers the run synchronously, so it is never launched twice; the claim itself is the row-locked `claimRun`
      attempted.add(next);
      launch(next);
    }
    return attempted.size;
  }

  async function tick(): Promise<void> {
    if (ticking || !running) return;
    ticking = true;
    try {
      await maintain();
      await fill();
    } catch (error) {
      logger.error({ errorCode: safeErrorCode(error) }, 'assessment poll error');
    } finally {
      ticking = false;
    }
  }

  return {
    get inFlight() {
      return active.size;
    },
    maintain,
    start() {
      if (running) return;
      running = true;
      timer = setInterval(() => void tick(), options.pollIntervalMs);
      void tick();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (active.size === 0) return;
      const grace = new Promise<void>((resolve) =>
        setTimeout(resolve, options.shutdownGraceMs ?? 10_000).unref(),
      );
      await Promise.race([Promise.allSettled([...active.values()]), grace]);
      controller.abort();
      await Promise.allSettled([...active.values()]);
    },
    async drain() {
      let started = 0;
      running = true;
      try {
        for (;;) {
          await maintain();
          const before = started;
          started += await fill();
          if (active.size === 0 && started === before) return started;
          if (active.size > 0) await Promise.race([...active.values()]);
        }
      } finally {
        running = false;
      }
    },
  };
}
