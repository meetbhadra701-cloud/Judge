import type { Logger } from '@judge-copilot/shared';
import type { AssessmentLoop } from './assessment/loop.js';
import type { CaptureLoop } from './capture/loop.js';

export const SERVICE_NAME = 'judge-copilot-worker';

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * The worker process lifecycle. M2 registers the project-source capture handler when a database is configured;
 * M5 P5 adds the offline pre-interview assessment handler when a (replay) provider is also configured. Without a database the worker
 * idles with no handlers and contacts nothing; without an assessment provider it never reads a prompt or contacts a model.
 */
export function createWorker({
  logger,
  captureLoop = null,
  assessmentLoop = null,
}: {
  logger: Logger;
  captureLoop?: CaptureLoop | null;
  assessmentLoop?: AssessmentLoop | null;
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
      assessmentLoop?.start();
      const handlers = [
        ...(captureLoop ? ['project_source_capture'] : []),
        ...(assessmentLoop ? ['pre_interview_assessment'] : []),
      ];
      logger.info(
        handlers.length > 0 ? { jobHandlers: handlers.length, handlers } : { jobHandlers: 0 },
        'worker started',
      );
    },
    async stop() {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = undefined;
        await Promise.all([captureLoop?.stop(), assessmentLoop?.stop()]);
        logger.info('worker stopped');
      }
    },
  };
}
