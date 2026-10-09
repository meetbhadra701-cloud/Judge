import { isStorableGraphText } from '@judge-copilot/schemas';

/*
 * Code-point text helpers. Every offset in this package counts Unicode CODE POINTS from the start of an artifact's stored text,
 * half-open [start, end): the same unit as M3's `EvidenceSpan` and PostgreSQL's `substr`/`length` on a UTF-8 database.
 * Offsets are never computed against a normalized copy: text is only ever sliced, never rewritten.
 */

/** The code points of `text`, one string each. A lone surrogate is its own element. */
export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

export function codePointCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** Code-point index of the UTF-16 index `index` (which must lie on a code-point boundary). */
export function codePointIndexOf(text: string, index: number): number {
  let count = 0;
  let unit = 0;
  while (unit < index) {
    const code = text.codePointAt(unit) ?? 0;
    unit += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

/**
 * True for a code point that may not appear in PASSAGE text: C0 controls other than tab, line feed and carriage return, DEL, and
 * lone surrogates. Such a code point is never shown to a model and never inside any passage; it acts as a passage BARRIER, so no
 * quote can span it. (Captured text is hostile: a stray ESC or form feed must neither fail a run nor be silently deleted from the
 * offsets, so it simply separates passages while every offset stays that of the original text.)
 */
export function isPassageBarrier(codePoint: string): boolean {
  const code = codePoint.codePointAt(0) ?? 0;
  if (codePoint.length === 1 && code >= 0xd800 && code <= 0xdfff) return true;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || code === 0x7f;
}

/** The text between two code-point offsets of an already split text. */
export function sliceOf(points: readonly string[], start: number, end: number): string {
  return points.slice(start, end).join('');
}

/** Whether `text` is acceptable as a QUOTE: well-formed and free of control characters other than tab and newline (never CR). */
export const isQuotableText = isStorableGraphText;

const NON_WHITESPACE = /\S/u;
export const hasVisibleContent = (text: string): boolean => NON_WHITESPACE.test(text);

/** Combining marks and zero-width joiners: a quote may not begin or end in the middle of the character they extend. */
const EXTENDS_PREVIOUS = /^(?:\p{M}|\u200D|\uFE0E|\uFE0F)/u;
export const extendsPrevious = (codePoint: string): boolean => EXTENDS_PREVIOUS.test(codePoint);
