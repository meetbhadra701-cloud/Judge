/*
 * Test-only: wraps a Drizzle database so a hook runs immediately BEFORE each `select().from(table)`
 * statement executes, with a handle on the same transaction (when the select runs inside one). It
 * lets a test observe transaction properties (isolation level, read-only, snapshot) and force an
 * exact interleaving with a concurrent writer at a precise point between two reads. Excluded from
 * the package build and exports.
 */
import { getTableName, type SQL } from 'drizzle-orm';
import type { JudgeDatabase } from '../client.js';

export interface SelectEvent {
  /** SQL name of the table of the `from(...)` clause. */
  table: string;
  /** The transaction (or database) the statement is about to run on. */
  scope: JudgeDatabase;
  /** Runs a raw statement on the same transaction/connection as the pending select. */
  execute: (query: SQL) => Promise<unknown>;
}

export type SelectHook = (event: SelectEvent) => Promise<void> | void;

type Thenable = {
  then: (onFulfilled: (value: unknown) => void, onRejected: (reason: unknown) => void) => unknown;
};
type SelectBuilder = { from: (table: unknown) => Thenable };

export function instrumentSelects(db: JudgeDatabase, hook: SelectHook): JudgeDatabase {
  const wrap = (target: JudgeDatabase): JudgeDatabase =>
    new Proxy(target, {
      get(inner, prop) {
        const value: unknown = Reflect.get(inner, prop, inner);
        if (prop === 'select' && typeof value === 'function') {
          return (...args: unknown[]) => {
            const builder = (value as (...a: unknown[]) => SelectBuilder).apply(inner, args);
            const from = builder.from.bind(builder);
            builder.from = (table: unknown) => {
              const pending = from(table);
              const originalThen = pending.then.bind(pending);
              pending.then = (onFulfilled, onRejected) =>
                Promise.resolve()
                  .then(() =>
                    hook({
                      table: getTableName(table as Parameters<typeof getTableName>[0]),
                      scope: inner,
                      execute: (query) => inner.execute(query),
                    }),
                  )
                  .then(
                    () =>
                      new Promise<unknown>((resolve, reject) => {
                        originalThen(resolve, reject);
                      }),
                  )
                  .then(onFulfilled, onRejected);
              return pending;
            };
            return builder;
          };
        }
        if (prop === 'transaction' && typeof value === 'function') {
          return (fn: (tx: JudgeDatabase) => Promise<unknown>, config?: unknown) =>
            (value as (...a: unknown[]) => Promise<unknown>).call(
              inner,
              (tx: JudgeDatabase) => fn(wrap(tx)),
              config,
            );
        }
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(inner)
          : value;
      },
    });
  return wrap(db);
}
