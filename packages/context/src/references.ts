/*
 * Source references inside Event Context documents live under three keys:
 *   sourceIds / prevailingSourceIds (arrays) and sourceId (single, on conflict positions).
 * The database trigger `event_context_json_source_ids` uses the same keys.
 */
const LIST_KEYS = new Set(['sourceIds', 'prevailingSourceIds']);
const SINGLE_KEY = 'sourceId';

/** Every source ID referenced anywhere in a document-shaped value. */
export function collectSourceIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  walk(value, (id) => {
    ids.add(id);
    return id;
  });
  return ids;
}

/** Returns a copy of `value` with every source reference replaced by `map(id)`. */
export function remapSourceIds<T>(value: T, map: (id: string) => string): T {
  return walk(value, map) as T;
}

function walk(value: unknown, map: (id: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, map));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if (LIST_KEYS.has(key) && Array.isArray(entry)) {
        return [key, (entry as unknown[]).map((id) => (typeof id === 'string' ? map(id) : id))];
      }
      if (key === SINGLE_KEY && typeof entry === 'string') {
        return [key, map(entry)];
      }
      return [key, walk(entry, map)];
    }),
  );
}
