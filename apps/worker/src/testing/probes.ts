/*
 * Test-only probes (excluded from the build): they observe the properties the pipeline promises without changing its behavior.
 */
import type { JudgeDatabase } from '@judge-copilot/database';
import type { LlmProvider, LlmResult, StructuredRequest } from '@judge-copilot/llm';
import { Writable } from 'node:stream';

/** A log destination that discards everything. */
export function nullSink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** A database handle that counts the transactions currently open on it (the stores call `db.transaction` for every unit of work). */
export function countTransactions(db: JudgeDatabase): {
  db: JudgeDatabase;
  open: () => number;
  peak: () => number;
  total: () => number;
} {
  let open = 0;
  let peak = 0;
  let total = 0;
  const proxy = new Proxy(db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'transaction' && typeof value === 'function') {
        return (...args: unknown[]) => {
          open += 1;
          total += 1;
          peak = Math.max(peak, open);
          return (value as (...a: unknown[]) => Promise<unknown>)
            .apply(target, args)
            .finally(() => {
              open -= 1;
            });
        };
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { db: proxy, open: () => open, peak: () => peak, total: () => total };
}

export interface ProbeRecord {
  readonly stage: string;
  readonly openTransactions: number;
  readonly concurrent: number;
}

/** Wraps a provider and records, at every `generate`, how many transactions are open and how many calls are in flight. */
export class ProbeProvider implements LlmProvider {
  readonly id: string;
  readonly mode: LlmProvider['mode'];
  readonly records: ProbeRecord[] = [];
  maxConcurrent = 0;
  private inFlight = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly openTransactions: () => number,
  ) {
    this.id = inner.id;
    this.mode = inner.mode;
  }

  async generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult> {
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    this.records.push({
      stage: request.stage,
      openTransactions: this.openTransactions(),
      concurrent: this.inFlight,
    });
    try {
      return await this.inner.generate(request, signal);
    } finally {
      this.inFlight -= 1;
    }
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
