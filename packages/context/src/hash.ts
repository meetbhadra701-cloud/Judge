import { createHash } from 'node:crypto';

/**
 * Canonical form of source text before hashing and storage: Unicode NFC, `\n` line endings,
 * no leading/trailing whitespace. Normalization never interprets the content.
 */
export function normalizeSourceText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministic SHA-256 of normalized source text. Used for change detection and
 * immutability checks only — a hash is never evidence that a source is trustworthy.
 */
export function sourceContentHash(normalizedText: string): string {
  return sha256Hex(normalizedText);
}

/** JSON with recursively sorted object keys; `undefined` properties are omitted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
