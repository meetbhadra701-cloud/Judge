import type { Logger } from '@judge-copilot/shared';

export const SERVICE_NAME = 'judge-copilot-worker';

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * The worker process lifecycle. Pipeline stages (ingestion, assessment, reassessment) will
 * register job handlers in later milestones; M0 registers none and contacts nothing.
 */
export function createWorker({ logger }: { logger: Logger }): Worker {
  // Keeps the event loop alive while idle; there is no job source to do so in M0.
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
      logger.info({ jobHandlers: 0 }, 'worker started');
    },
    stop() {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = undefined;
        logger.info('worker stopped');
      }
      return Promise.resolve();
    },
  };
}
