/*
 * M5 P4: the DATABASE-BACKED call ledger inherits the identical behavioral contract as the in-memory ledger of packages/llm
 * (reserve -> settle accounting, every limit, concurrency, response auditing). packages/database cannot import packages/llm (both are
 * Layer 3), so the suite lives here and reaches both by relative path. On real PostgreSQL the ledger runs on a connection POOL, so the
 * concurrency cases race for real and are serialized only by the budget row lock.
 */
import { afterAll, beforeAll, describe } from 'vitest';
import { createDatabase } from '../../packages/database/src/client.js';
import { type JudgeDatabase } from '../../packages/database/src/index.js';
import { DatabaseRunBudget } from '../../packages/database/src/run-budget-store.js';
import {
  newRunStore,
  requestInput,
} from '../../packages/database/src/testing/assessment-fixtures.js';
import {
  seedAssessmentWorld,
  type AssessmentWorld,
} from '../../packages/database/src/testing/assessment-world.js';
import {
  openPglite,
  openPostgres,
  rows,
  sql,
  type TestDatabase,
} from '../../packages/database/src/testing/databases.js';
import { seedProject, seedSnapshot } from '../../packages/database/src/testing/graph-world.js';
import type { RunBudget } from '../../packages/llm/src/budget.js';
import { ManualClock } from '../../packages/llm/src/clock.js';
import { costNanoUsd, inputTokensOf, priceFor } from '../../packages/llm/src/pricing.js';
import { PRICES_V1 } from '../../packages/llm/src/prices-v1.js';
import { limits } from '../../packages/llm/src/testing/builders.js';
import {
  defineBudgetContract,
  type BudgetFactory,
} from '../../packages/llm/src/testing/budget-contract.js';
import { defineLedgerContract } from '../../packages/llm/src/testing/ledger-contract.js';

const URL_ = process.env['TEST_DATABASE_URL'];

/** A ledger that finishes its asynchronous setup (project, pins, running run) before its first operation. */
class LazyLedger implements RunBudget {
  constructor(private readonly ready: Promise<DatabaseRunBudget>) {
    ready.catch(() => undefined);
  }
  async reserve(request: Parameters<RunBudget['reserve']>[0]) {
    return (await this.ready).reserve(request);
  }
  async settle(callId: number, settlement: Parameters<RunBudget['settle']>[1]) {
    return (await this.ready).settle(callId, settlement);
  }
  async snapshot() {
    return (await this.ready).snapshot() as ReturnType<RunBudget['snapshot']>;
  }
  async entries() {
    return (await this.ready).entries() as ReturnType<RunBudget['entries']>;
  }
  async reapInFlight() {
    return (await this.ready).reapInFlight();
  }
}

const targets: [string, () => Promise<TestDatabase>][] = [['PGlite', openPglite]];
if (URL_) {
  targets.push([
    'PostgreSQL pool',
    async () => {
      const setup = await openPostgres(URL_);
      const pool = createDatabase(URL_, { maxConnections: 24 });
      return {
        db: pool.db,
        close: async () => {
          await pool.close();
          await setup.close();
        },
      };
    },
  ]);
}

describe.each(targets)('database-backed ledger contract on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let world: AssessmentWorld;
  let n = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    world = await seedAssessmentWorld(db);
  });
  afterAll(async () => {
    await testDb.close();
  });

  const factory: BudgetFactory = (overrides = {}, options = {}) => {
    const clock = options.clock ?? new ManualClock(0);
    const startClock = clock.now();
    n += 1;
    const ready = (async () => {
      const project = await seedProject(
        db,
        world.event.id,
        `ledger-${String(n)}-${String(Date.now())}`,
      );
      await seedSnapshot(db, project, 'devpost', 'captured', [
        { key: 'submission.txt', kind: 'submission_text', mediaType: 'text/plain', text: 'text' },
      ]);
      const store = newRunStore(db);
      const result = await store.requestAssessment({
        ...requestInput(world),
        projectId: project.id,
        limits: limits(overrides),
      });
      if (result.kind !== 'run_created') throw new Error(`request failed: ${result.kind}`);
      const lease = await store.claimRun(result.runId, 600_000);
      if (!lease) throw new Error('claim failed');
      const [row] = await rows<{ started_at: Date | string }>(
        db,
        sql`SELECT started_at FROM analysis_runs WHERE id = ${result.runId}`,
      );
      const base = new Date(row?.started_at ?? 0).getTime() - startClock;
      return new DatabaseRunBudget({
        db,
        runId: result.runId,
        nowMs: () => base + clock.now(),
        measure: (model, usage) => {
          const price = priceFor(PRICES_V1, model);
          if (!price) return null;
          const input = inputTokensOf(usage);
          return {
            inputTokens: input,
            outputTokens: usage.outputTokens,
            costNanoUsd: costNanoUsd(price, input, usage.outputTokens),
          };
        },
        ...(options.betweenCheckAndHold === undefined
          ? {}
          : { betweenCheckAndHold: options.betweenCheckAndHold }),
      });
    })();
    return { budget: new LazyLedger(ready), clock };
  };

  defineBudgetContract('budget contract', factory);
  defineLedgerContract('database ledger', factory);
});
