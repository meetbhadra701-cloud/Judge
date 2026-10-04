import { createHash } from 'node:crypto';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** JSON with recursively sorted object keys; `undefined` properties are omitted. */
export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
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

/** Normalized text: Unicode NFC and `\n` line endings. Never interprets the content. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(text) <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  let end = bytes.length;
  // Step back over a partial multi-byte sequence.
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end -= 1;
  if (end > 0 && ((bytes[end - 1] ?? 0) & 0x80) !== 0) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
