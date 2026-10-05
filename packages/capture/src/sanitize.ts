import type { JsonObject, JsonValue } from './ports.js';

/*
 * Database-safe text. PostgreSQL cannot store U+0000 in `text` or `jsonb`, and `jsonb` also
 * rejects unpaired UTF-16 surrogates. Captured material is hostile input, so a stray NUL byte in a
 * page title must neither fail the snapshot nor reach the database as an error. Both are replaced
 * by U+FFFD (the Unicode replacement character), deterministically, and the number of
 * replacements is recorded in the snapshot metadata (`contentSanitization`) so the loss is never
 * silent. Nothing else is altered.
 */

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL = '\u0000';
const REPLACEMENT = '�';

export interface SanitizationCounts {
  nulReplaced: number;
  invalidSurrogatesReplaced: number;
}

export function emptyCounts(): SanitizationCounts {
  return { nulReplaced: 0, invalidSurrogatesReplaced: 0 };
}

export function hasReplacements(counts: SanitizationCounts): boolean {
  return counts.nulReplaced > 0 || counts.invalidSurrogatesReplaced > 0;
}

/** Replaces every U+0000 and unpaired surrogate with U+FFFD, counting each replacement. */
export function scrubText(text: string, counts: SanitizationCounts): string {
  let output = text;
  if (output.includes(NUL)) {
    const pieces = output.split(NUL);
    counts.nulReplaced += pieces.length - 1;
    output = pieces.join(REPLACEMENT);
  }
  return output.replace(UNPAIRED_SURROGATE, () => {
    counts.invalidSurrogatesReplaced += 1;
    return REPLACEMENT;
  });
}

const MAX_DEPTH = 64;

/** Scrubs every string value and object key of a JSON value. Rejects absurd nesting. */
export function scrubJson(value: JsonValue, counts: SanitizationCounts, depth = 0): JsonValue {
  if (typeof value === 'string') return scrubText(value, counts);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) throw new RangeError('JSON nesting is too deep');
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, counts, depth + 1));
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    output[scrubText(key, counts)] = scrubJson(entry, counts, depth + 1);
  }
  return output;
}
