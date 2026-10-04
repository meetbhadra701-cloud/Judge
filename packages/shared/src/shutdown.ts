import type { Logger } from './logger.js';

export interface ShutdownOptions {
  logger: Logger;
  /** Hard deadline after which the process exits with code 1 if shutdown has not finished. */
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
}

/**
 * Runs `shutdown` once on the first SIGINT/SIGTERM. The process then exits naturally when its
 * event loop drains; failures or a missed deadline set a non-zero exit code.
 */
export function handleShutdownSignals(
  shutdown: (signal: NodeJS.Signals) => Promise<void>,
  { logger, timeoutMs = 10_000, signals = ['SIGINT', 'SIGTERM'] }: ShutdownOptions,
): void {
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');

    const deadline = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown deadline exceeded; forcing exit');
      process.exit(1);
    }, timeoutMs);
    deadline.unref();

    shutdown(signal).then(
      () => {
        clearTimeout(deadline);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        logger.error({ err: error }, 'shutdown failed');
        process.exitCode = 1;
      },
    );
  };

  for (const signal of signals) {
    process.once(signal, onSignal);
  }
}
