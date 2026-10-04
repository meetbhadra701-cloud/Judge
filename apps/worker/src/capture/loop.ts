import type { Logger } from '@judge-copilot/shared';
import type { CaptureQueue } from './queue.js';
import { runCapture, type AdapterRegistry } from './runner.js';

export interface CaptureLoopOptions {
  readonly queue: CaptureQueue;
  readonly adapters: AdapterRegistry;
  readonly logger: Logger;
  /** Maximum captures in flight (bounded concurrency). */
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  /** How long `stop` waits for in-flight captures before aborting them. */
  readonly shutdownGraceMs?: number;
  readonly retryDelayMs?: number;
}

export interface CaptureLoop {
  start(): void;
  stop(): Promise<void>;
  /** Claims and runs work until the queue is empty (used by tests and demos). */
  drain(): Promise<number>;
  readonly inFlight: number;
}

/**
 * Polls the capture queue and runs up to `concurrency` captures at once. A failed capture never
 * stops the loop: every claim is finalized independently, and unexpected (database) errors are
 * logged through the redacting logger and retried on the next poll.
 */
export function createCaptureLoop(options: CaptureLoopOptions): CaptureLoop {
  const { queue, logger } = options;
  const active = new Set<Promise<void>>();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let ticking = false;
  const isRunning = () => running;

  async function launch(): Promise<boolean> {
    const claim = await queue.claim();
    if (!claim) return false;
    const job = runCapture(
      {
        queue,
        adapters: options.adapters,
        logger,
        ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      },
      claim,
      controller.signal,
    )
      .catch((error: unknown) => {
        logger.error({ err: error, snapshotId: claim.snapshotId }, 'capture finalization error');
      })
      .finally(() => active.delete(job));
    active.add(job);
    return true;
  }

  async function tick(): Promise<void> {
    if (ticking || !running) return;
    ticking = true;
    try {
      await queue.reapExpired();
      // `running` may flip during the awaits below (stop() is called concurrently).
      while (isRunning() && active.size < options.concurrency && (await launch())) {
        // keep claiming while there is capacity and work
      }
    } catch (error) {
      logger.error({ err: error }, 'capture poll error');
    } finally {
      ticking = false;
    }
  }

  return {
    get inFlight() {
      return active.size;
    },
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
      await Promise.race([Promise.allSettled([...active]), grace]);
      controller.abort();
      await Promise.allSettled([...active]);
    },
    async drain() {
      let processed = 0;
      for (;;) {
        await queue.reapExpired();
        while (active.size < options.concurrency && (await launch())) processed += 1;
        if (active.size === 0) return processed;
        await Promise.race([...active]);
      }
    },
  };
}
