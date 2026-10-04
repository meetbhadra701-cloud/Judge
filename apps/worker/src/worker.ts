import type { Logger } from '@judge-copilot/shared';
import type { CaptureLoop } from './capture/loop.js';

export const SERVICE_NAME = 'judge-copilot-worker';

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * The worker process lifecycle. M2 registers one job handler, project-source capture, when a
 * database is configured; without one the worker idles with no handlers and contacts nothing.
 * No LLM, scoring or assessment jobs exist.
 */
export function createWorker({
  logger,
  captureLoop = null,
}: {
  logger: Logger;
  captureLoop?: CaptureLoop | null;
}): Worker {
  // Keeps the event loop alive while idle.
  let keepAlive: NodeJS.Timeout | undefined;

  return {
    get running() {
      return keepAlive !== undefined;
    },
    start() {
      if (keepAlive) {
        return;
      }
      keepAlive = setInterval(() => undefined, 60_000);
      captureLoop?.start();
      logger.info(
        captureLoop ? { jobHandlers: 1, handlers: ['project_source_capture'] } : { jobHandlers: 0 },
        'worker started',
      );
    },
    async stop() {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = undefined;
        await captureLoop?.stop();
        logger.info('worker stopped');
      }
    },
  };
}
