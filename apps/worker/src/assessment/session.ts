import type { AssessmentRunStore } from '@judge-copilot/database';
import type { Clock } from '@judge-copilot/llm';
import type { Logger } from '@judge-copilot/shared';
import { RunStopped } from './stop.js';

/*
 * The ownership of one running run (design §10.3): its lease, its heartbeat, its cancellation and the worker's shutdown.
 *
 * A worker owns a run only while it holds the lease token. A heartbeat extends the lease on a timer, between and DURING model calls (a
 * call can take minutes). Anything that ends the ownership aborts one `AbortSignal` that every model call listens to:
 *
 *   lease_lost      the heartbeat found the token stale or the run no longer `running` (another worker recovered it, or an operator
 *                   ended it), or the database could not be reached for a whole lease. The worker must NOT write anything about the
 *                   run any more: it does not own it.
 *   shutdown        the worker is stopping; the run is cancelled (in-flight attempts stay counted at their worst case).
 *   wall_clock      the run's wall-clock limit passed; the run ends `timeout`.
 *
 * Checkpoints are explicit: the pipeline calls `checkpoint(stage)` before every stage and every model call, so no new spending starts
 * after the ownership ended. There is no transaction held anywhere in this class.
 */

/** How long `stop()` waits for a heartbeat that is still in flight. */
export const HEARTBEAT_STOP_WAIT_MS = 2_000;

export type StopReason = 'lease_lost' | 'shutdown' | 'wall_clock';

export interface SessionOptions {
  readonly runId: string;
  readonly leaseToken: string;
  readonly runs: AssessmentRunStore;
  readonly clock: Clock;
  readonly leaseMs: number;
  /** Defaults to a third of the lease. */
  readonly heartbeatEveryMs?: number;
  /** The worker's shutdown signal. */
  readonly shutdown: AbortSignal;
  /** The run's wall-clock limit in ms, counted from when this session starts. */
  readonly wallClockMs: number;
  readonly logger: Logger;
}

export class RunSession {
  private readonly controller = new AbortController();
  private reasonValue: StopReason | null = null;
  private cancelHeartbeat: (() => void) | undefined;
  private cancelDeadline: (() => void) | undefined;
  private stopped = false;
  private lastRenewedAt: number;
  private beating: Promise<void> = Promise.resolve();
  private currentStage = 'start';
  private readonly heartbeatEveryMs: number;
  private readonly onShutdown: () => void;
  /** How many heartbeats succeeded / failed (observable for tests and logs). */
  heartbeats = 0;
  heartbeatFailures = 0;

  constructor(private readonly options: SessionOptions) {
    this.lastRenewedAt = options.clock.now();
    this.heartbeatEveryMs =
      options.heartbeatEveryMs ?? Math.max(1, Math.floor(options.leaseMs / 3));
    this.onShutdown = () => {
      this.abort('shutdown');
    };
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get reason(): StopReason | null {
    return this.reasonValue;
  }

  get stage(): string {
    return this.currentStage;
  }

  start(): void {
    const { shutdown, clock } = this.options;
    if (shutdown.aborted) this.abort('shutdown');
    else shutdown.addEventListener('abort', this.onShutdown, { once: true });
    this.scheduleHeartbeat();
    this.cancelDeadline = clock.after(this.options.wallClockMs, () => {
      this.abort('wall_clock');
    });
  }

  /**
   * Stops the heartbeat and the deadline and waits for an in-flight heartbeat, but only for `HEARTBEAT_STOP_WAIT_MS`: a heartbeat query
   * that never settles (a dead connection) must not keep a finished run's worker slot occupied forever. A heartbeat that settles later
   * changes nothing: `beat` writes no run state and `scheduleHeartbeat` refuses once stopped. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelHeartbeat?.();
    this.cancelDeadline?.();
    this.options.shutdown.removeEventListener('abort', this.onShutdown);
    let timer: NodeJS.Timeout | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HEARTBEAT_STOP_WAIT_MS);
      timer.unref();
    });
    try {
      await Promise.race([this.beating, bounded]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Throws `RunStopped` when the ownership ended. Called before every stage and every model call. The FIRST reason wins: a lease lost
   * while shutting down is still a lost lease (the worker may not write about a run it no longer owns).
   */
  checkpoint(stage: string): void {
    this.currentStage = stage;
    if (this.reasonValue !== null) throw new RunStopped(this.stopFor(stage));
  }

  /** The `Stop` that corresponds to the abort reason (callers use it after a cancelled model call). */
  stopFor(stage: string = this.currentStage) {
    switch (this.reasonValue) {
      case 'shutdown':
        return { kind: 'cancel' as const, code: 'worker_shutdown', stage };
      case 'wall_clock':
        return {
          kind: 'fail' as const,
          category: 'timeout' as const,
          code: 'run_wall_clock_exceeded',
          stage,
        };
      case 'lease_lost':
      case null:
        return { kind: 'lost' as const, stage };
    }
  }

  /** Marks the ownership as lost (for example when settling a call proves the run ended). Idempotent. */
  markLost(): void {
    this.abort('lease_lost');
  }

  private abort(reason: StopReason): void {
    if (this.reasonValue === null) {
      this.reasonValue = reason;
      this.controller.abort(new Error(reason));
    } else if (reason === 'lease_lost' && this.reasonValue !== 'lease_lost') {
      // a lost lease overrides every other reason: the worker may not write a terminal state for a run it does not own
      this.reasonValue = 'lease_lost';
    }
  }

  private scheduleHeartbeat(): void {
    if (this.stopped || this.reasonValue === 'lease_lost') return;
    this.cancelHeartbeat = this.options.clock.after(this.heartbeatEveryMs, () => {
      this.beating = this.beat().finally(() => {
        this.scheduleHeartbeat();
      });
    });
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    const { runs, runId, leaseToken, leaseMs, clock, logger } = this.options;
    try {
      const renewed = await runs.heartbeat(runId, leaseToken, leaseMs);
      if (renewed) {
        this.lastRenewedAt = clock.now();
        this.heartbeats += 1;
      } else {
        // The token is stale or the run is not `running`: someone else owns it or ended it.
        logger.warn({ runId }, 'assessment lease lost');
        this.abort('lease_lost');
      }
    } catch {
      this.heartbeatFailures += 1;
      // The database is unreachable. Keep trying until the lease itself would have expired: after that another worker may legitimately
      // recover the run, so this one must stop.
      if (clock.now() - this.lastRenewedAt >= leaseMs) {
        logger.warn({ runId }, 'assessment lease expired while the database was unreachable');
        this.abort('lease_lost');
      }
    }
  }
}
