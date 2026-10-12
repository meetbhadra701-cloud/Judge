import { analysisRuns, type AssessmentRunStore, type JudgeDatabase } from '@judge-copilot/database';
import { ASSESSMENT_RUN_TYPE } from '@judge-copilot/schemas';
import type { Logger } from '@judge-copilot/shared';
import { and, eq, lt } from 'drizzle-orm';
import { safeErrorCode } from '../capture/safe-error.js';
import { runClaimedAssessment, type PipelineDeps, type RunOutcome } from './pipeline.js';

/*
 * The assessment work loop (design §10.3), a sibling of the capture loop.
 *
 *   claim      `claimNextRun` takes the oldest claimable pending `pre_interview_assessment` run and its lease in ONE transaction with
 *              `FOR UPDATE SKIP LOCKED`: two workers never receive the same run, and a run whose row another session holds (a claim in
 *              progress, a stuck transaction) is skipped, never waited for, so one locked run cannot freeze the queue or occupy a
 *              worker slot. The pipeline runs under that lease and performs no claim of its own (`runClaimedAssessment`).
 *   pending    a run nobody claimed within `pendingMaxAgeMs` (the request handler died before a worker started: default 15 minutes) is
 *              CANCELLED `pending_expired` by `expirePendingRun`, which re-checks `pending` and the age under the run row lock and
 *              cancels in the same transaction (a locked row is skipped and re-examined on the next pass). A run a worker claimed in
 *              the meantime is never touched, and a run past the limit is never claimed (`createdAfter`). A pending run cannot own a
 *              ledger row, so nothing was spent; the project is free again.
 *   expired    a running run whose lease expired (a crashed worker) is failed `internal_error / worker_lease_expired` and its in-flight
 *              attempts are counted at their worst case (`recoverRun`, also SKIP LOCKED). Nothing is re-run automatically.
 *   passes     maintenance (expiry, recovery) and queue filling are INDEPENDENT passes with their own re-entrancy guards: a slow or
 *              stuck pass of one can never delay the other.
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
  let maintaining: Promise<void> | null = null;
  let filling: Promise<void> | null = null;

  const pendingCutoff = (): Date => new Date(now().getTime() - pendingMaxAgeMs);

  async function expirePending(): Promise<string[]> {
    const cutoff = pendingCutoff();
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
      // The list above is only a hint: `expirePendingRun` re-checks `pending` and the age under the run row lock and cancels in the
      // same transaction, so a run that a worker claimed (or is claiming) in the meantime is left alone. It never ends a running run,
      // and it skips a row somebody else holds instead of waiting for it.
      if (await runs.expirePendingRun(id, cutoff)) expired.push(id);
    }
    return expired;
  }

  async function maintain() {
    const recovered = await runs.recoverExpiredRuns(now());
    const expiredPending = await expirePending();
    return { expiredPending, recovered };
  }

  function launch(runId: string, leaseToken: string): void {
    const job = runClaimedAssessment(
      { ...options.pipeline, shutdown: controller.signal },
      runId,
      leaseToken,
    )
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

  /** Claims work while a slot is free. Every claim is one short transaction that never waits for a locked row. */
  async function fill(): Promise<number> {
    let started = 0;
    while (running && active.size < options.concurrency) {
      const claimed = await runs.claimNextRun(options.pipeline.leaseMs, {
        createdAfter: pendingCutoff(),
      });
      if (claimed === null) break;
      // the run is ours from the moment the claim committed: it is launched even if `stop()` began meanwhile (it then aborts at once)
      launch(claimed.runId, claimed.leaseToken);
      started += 1;
    }
    return started;
  }

  /** One pass of one kind; a failure is logged (code only) and the pass is retried at the next interval. */
  function guarded(label: string, work: () => Promise<unknown>): Promise<void> {
    return work()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error({ errorCode: safeErrorCode(error) }, `assessment ${label} error`);
      });
  }

  /** Maintenance and filling are started independently and never awaited by one another. */
  function tick(): void {
    if (!running) return;
    if (maintaining === null) {
      maintaining = guarded('maintenance', maintain).finally(() => {
        maintaining = null;
      });
    }
    if (filling === null) {
      filling = guarded('poll', fill).finally(() => {
        filling = null;
      });
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
      timer = setInterval(tick, options.pollIntervalMs);
      tick();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      const grace = new Promise<void>((resolve) =>
        setTimeout(resolve, options.shutdownGraceMs ?? 10_000).unref(),
      );
      // a pass that is mid-flight finishes (a claim may still hand us a run, which is then launched and aborted below)
      const passes = [maintaining, filling].filter((job): job is Promise<void> => job !== null);
      if (passes.length > 0) await Promise.race([Promise.allSettled(passes), grace]);
      if (active.size === 0) return;
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
