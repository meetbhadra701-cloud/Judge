import { describe, expect, it } from 'vitest';
import {
  emptyCounts,
  InvalidCaptureResultError,
  jsonArtifact,
  scrubJson,
  scrubText,
  sha256Hex,
  textArtifact,
  utf8ByteLength,
  validateCaptureResult,
  type JsonObject,
} from './index.js';

describe('database-safe text', () => {
  it('replaces NUL and unpaired surrogates, and nothing else, counting each', () => {
    const counts = emptyCounts();
    expect(scrubText('a\u0000b\u0000', counts)).toBe('a�b�');
    expect(scrubText('x\uD800y\uDC00z', counts)).toBe('x�y�z');
    expect(counts).toEqual({ nulReplaced: 2, invalidSurrogatesReplaced: 2 });
    const clean = emptyCounts();
    // A valid surrogate pair (an emoji) and ordinary text are untouched.
    expect(scrubText('ok \u{1F600} é', clean)).toBe('ok \u{1F600} é');
    expect(clean).toEqual(emptyCounts());
  });

  it('scrubs nested JSON strings and keys and refuses absurd nesting', () => {
    const counts = emptyCounts();
    expect(scrubJson({ 'k\u0000': ['v\u0000', { t: 'x\uD800' }], n: 1, ok: null }, counts)).toEqual(
      {
        'k�': ['v�', { t: 'x�' }],
        n: 1,
        ok: null,
      },
    );
    expect(counts.nulReplaced).toBe(2);
    let deep: JsonObject = {};
    for (let index = 0; index < 100; index += 1) deep = { deep };
    expect(() => scrubJson(deep, emptyCounts())).toThrow(RangeError);
  });
});

describe('capture results are made storable instead of failing', () => {
  const hostile = (): unknown => ({
    status: 'captured',
    revision: null,
    metadata: { title: 'a\u0000b', nested: { lone: 'x\uD800' } },
    artifacts: [
      textArtifact('page.txt', 'page_text', 'text/plain', 'hello\u0000world', {
        label: 'm\u0000',
      }),
      jsonArtifact('page.json', 'page_metadata', { title: 'a\u0000b' }),
    ],
    partialReasons: [],
  });

  it('replaces NUL/unpaired surrogates, recomputes hashes and records the loss', () => {
    const result = validateCaptureResult('deployment', hostile());
    if (result.status !== 'captured') throw new Error(result.status);
    expect(result.metadata).toMatchObject({
      title: 'a�b',
      nested: { lone: 'x�' },
      // NUL in the text artifact, its metadata, the metadata title; surrogate once.
      contentSanitization: { nulReplaced: 3, invalidSurrogatesReplaced: 1 },
    });
    const page = result.artifacts.find((artifact) => artifact.key === 'page.txt');
    expect(page?.textContent).toBe('hello�world');
    // Length and hash describe the text that will actually be stored.
    expect(page?.byteLength).toBe(utf8ByteLength('hello�world'));
    expect(page?.contentHash).toBe(sha256Hex('hello�world'));
    expect(page?.metadata).toEqual({ label: 'm�' });
    // The JSON artifact's text already escapes NUL, so it is unchanged and keeps its hash.
    const json = result.artifacts.find((artifact) => artifact.key === 'page.json');
    expect(json?.textContent).toContain('\\u0000');
  });

  it('adds no sanitization record to clean results and still rejects genuinely bad ones', () => {
    const clean = validateCaptureResult('deployment', {
      status: 'captured',
      revision: null,
      metadata: { title: 'fine' },
      artifacts: [textArtifact('page.txt', 'page_text', 'text/plain', 'hello')],
      partialReasons: [],
    });
    if (clean.status !== 'captured') throw new Error(clean.status);
    expect(clean.metadata).toEqual({ title: 'fine' });

    // A hash that was wrong before sanitizing is still caught on clean text.
    const tampered = {
      status: 'captured',
      revision: null,
      metadata: {},
      artifacts: [
        { ...textArtifact('a.txt', 'page_text', 'text/plain', 'abc'), contentHash: 'f'.repeat(64) },
      ],
      partialReasons: [],
    };
    expect(() => validateCaptureResult('deployment', tampered)).toThrow(InvalidCaptureResultError);
  });
});
