import { BaseEnv, createLogger, handleShutdownSignals, parseEnv } from '@judge-copilot/shared';
import { createWorker, SERVICE_NAME } from './worker.js';

const env = parseEnv(BaseEnv);
const logger = createLogger({ service: SERVICE_NAME, level: env.LOG_LEVEL });
const worker = createWorker({ logger });

handleShutdownSignals(() => worker.stop(), { logger });
worker.start();
