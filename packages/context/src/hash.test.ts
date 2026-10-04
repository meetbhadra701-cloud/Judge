import { describe, expect, it } from 'vitest';
import { canonicalJson, normalizeSourceText, sha256Hex, sourceContentHash } from './index.js';

describe('source hashing', () => {
  it('computes standard SHA-256 hex digests', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic for the same normalized content', () => {
    const text = normalizeSourceText('Official rules\nTeams of four.');
    expect(sourceContentHash(text)).toBe(sourceContentHash(text));
    expect(sourceContentHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes line endings, Unicode form and surrounding whitespace before hashing', () => {
    const lf = normalizeSourceText('Café rules\nline two');
    const crlf = normalizeSourceText('  Café rules\r\nline two \n');
    expect(crlf).toBe(lf);
    expect(sourceContentHash(crlf)).toBe(sourceContentHash(lf));
  });

  it('changes when the content changes', () => {
    expect(sourceContentHash('Prior work is allowed.')).not.toBe(
      sourceContentHash('Prior work is not allowed.'),
    );
  });

  it('canonical JSON is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
});
