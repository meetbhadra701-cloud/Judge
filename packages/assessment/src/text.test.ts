import { describe, expect, it } from 'vitest';
import {
  codePointCount,
  codePointIndexOf,
  extendsPrevious,
  isPassageBarrier,
  isQuotableText,
  sliceOf,
  toCodePoints,
} from './text.js';

describe('code-point helpers', () => {
  it('counts and slices by code point, not UTF-16 unit', () => {
    const text = 'a💧b𝒜c';
    expect(codePointCount(text)).toBe(5);
    expect(text.length).toBe(7);
    const points = toCodePoints(text);
    expect(sliceOf(points, 1, 4)).toBe('💧b𝒜');
  });

  it('maps a UTF-16 index back to a code-point index', () => {
    const text = 'a💧b𝒜c';
    expect(codePointIndexOf(text, 0)).toBe(0);
    expect(codePointIndexOf(text, 1)).toBe(1);
    expect(codePointIndexOf(text, 3)).toBe(2); // after the 2-unit emoji
    expect(codePointIndexOf(text, 4)).toBe(3);
  });

  it('treats a lone surrogate as its own code point', () => {
    expect(toCodePoints('a\uD800b')).toEqual(['a', '\uD800', 'b']);
  });
});

describe('passage barriers', () => {
  it('allows tab, line feed and carriage return', () => {
    for (const ok of ['\t', '\n', '\r', 'a', ' ', '💧', '\u0085', '\u2028'])
      expect(isPassageBarrier(ok)).toBe(false);
  });
  it('bars the other C0 controls, DEL and lone surrogates', () => {
    for (const bad of [
      '\u0000',
      '\u0001',
      '\u0008',
      '\u000B',
      '\u000C',
      '\u001B',
      '\u001F',
      '\u007F',
      '\uD800',
      '\uDFFF',
    ]) {
      expect(isPassageBarrier(bad), JSON.stringify(bad)).toBe(true);
    }
  });
});

describe('quotable text', () => {
  it('rejects carriage returns and other controls, accepts tab and newline', () => {
    expect(isQuotableText('a\tb\nc')).toBe(true);
    expect(isQuotableText('a\rb')).toBe(false);
    expect(isQuotableText('a\u001Bb')).toBe(false);
    expect(isQuotableText('a\uD800b')).toBe(false);
  });
  it('knows which characters extend the previous one', () => {
    expect(extendsPrevious('́')).toBe(true);
    expect(extendsPrevious('\u200D')).toBe(true);
    expect(extendsPrevious('a')).toBe(false);
  });
});
