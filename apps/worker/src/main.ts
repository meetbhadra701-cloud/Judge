import { createDatabase } from '@judge-copilot/database';
import { createFixtureNetwork, createSafeHttpClient } from '@judge-copilot/safe-http';
import { createLogger, handleShutdownSignals } from '@judge-copilot/shared';
import { createAdapterRegistry } from './adapters.js';
import { createCaptureLoop } from './capture/loop.js';
import { CaptureQueue } from './capture/queue.js';
import { loadWorkerEnv } from './env.js';
import { loadFixtureWorld } from './fixtures.js';
import { createWorker, SERVICE_NAME } from './worker.js';

const env = loadWorkerEnv();
const logger = createLogger({ service: SERVICE_NAME, level: env.LOG_LEVEL });

// No connection is opened until the first query.
const database = env.DATABASE_URL
  ? createDatabase(env.DATABASE_URL, { maxConnections: env.CAPTURE_CONCURRENCY + 2 })
  : null;

let captureLoop = null;
if (database) {
  let http = createSafeHttpClient();
  if (env.CAPTURE_NETWORK === 'fixture' && env.CAPTURE_FIXTURE_DIR) {
    const world = await loadFixtureWorld(env.CAPTURE_FIXTURE_DIR);
    const network = createFixtureNetwork(world);
    http = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
    logger.warn(
      { fixtures: world.names },
      'development fixture network enabled; no real network is used',
    );
  }
  captureLoop = createCaptureLoop({
    queue: new CaptureQueue({ db: database.db, leaseMs: env.CAPTURE_LEASE_MS }),
    adapters: createAdapterRegistry({ http, githubToken: env.GITHUB_TOKEN ?? null }),
    logger,
    concurrency: env.CAPTURE_CONCURRENCY,
    pollIntervalMs: env.CAPTURE_POLL_INTERVAL_MS,
  });
}

const worker = createWorker({ logger, captureLoop });

handleShutdownSignals(
  async () => {
    await worker.stop();
    await database?.close();
  },
  { logger },
);
worker.start();
