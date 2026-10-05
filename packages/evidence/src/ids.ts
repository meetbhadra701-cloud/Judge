import { createHash, randomUUID } from 'node:crypto';

/*
 * Trusted ID assignment (invariant 20). Producers of graph content never choose persisted IDs:
 * they name new entities with batch-local refs and trusted code assigns UUIDs through this port.
 * Production uses `randomIdAllocator`; tests and demos use `deterministicIdAllocator` so runs are
 * reproducible.
 */

export interface IdAllocator {
  /** A fresh UUID for a new entity. `scope` names the entity (`claim`, `evidence`, ...). */
  next(scope: string): string;
}

export function randomIdAllocator(): IdAllocator {
  return { next: () => randomUUID() };
}

/**
 * A reproducible allocator: IDs are a pure function of `(namespace, scope, counter)`, formatted
 * as RFC 4122 version-5-style UUIDs. The same namespace and call order always give the same IDs.
 */
export function deterministicIdAllocator(namespace: string): IdAllocator {
  const counters = new Map<string, number>();
  return {
    next(scope) {
      const count = (counters.get(scope) ?? 0) + 1;
      counters.set(scope, count);
      const bytes = createHash('sha256')
        .update(`${namespace}\u0000${scope}\u0000${String(count)}`)
        .digest()
        .subarray(0, 16);
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = bytes.toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}
