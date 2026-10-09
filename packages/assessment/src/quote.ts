import { codePointCount, codePointIndexOf, extendsPrevious, isQuotableText } from './text.js';
import type { Passage } from './windowing.js';

/*
 * Exact quote location (design §4.1). A model never gives an offset; it gives a quotation, and CODE finds it.
 *
 *   - The quote must occur in THE PASSAGE'S text exactly once, code point for code point. No normalization of the stored text,
 *     of the quote, or of line endings is ever applied before matching, and no offset is ever computed on a rewritten copy.
 *   - Occurrences are counted with overlap ("aaa" occurs twice in "aaaa"), so a repeated substring is ambiguous, not unique.
 *   - The span is  passage.start + (index of the match in code points)  ..  + (quote length in code points): original-text offsets.
 *   - The excerpt is the matched text of the passage, which IS the original text at that span.
 *
 * Policy for forbidden characters (CR, other control characters): see Quote in @judge-copilot/schemas. A quote cannot contain a
 * carriage return, so a multi-line quote can only be located in text whose line ends are "\n". A quote that would match only if
 * line endings were normalized is REJECTED with `quote_crosses_line_ending` (the diagnostic never produces a position). A quote
 * that would begin or end inside a combining sequence is rejected with `quote_splits_character`, because a provenance span must not
 * cut a character in half.
 */

export const QUOTE_MIN_CODE_POINTS = 8;
export const QUOTE_MAX_CODE_POINTS = 2_000;

export const QUOTE_FAILURE_CODES = [
  'quote_invalid',
  'quote_blank',
  'quote_not_found',
  'quote_ambiguous',
  'quote_crosses_line_ending',
  'quote_splits_character',
] as const;
export type QuoteFailureCode = (typeof QUOTE_FAILURE_CODES)[number];

export interface LocatedQuote {
  readonly passageHandle: string;
  readonly snapshotId: string;
  readonly artifactId: string;
  readonly artifactKey: string;
  /** Absolute code-point span in the original artifact text, half-open. */
  readonly start: number;
  readonly end: number;
  /** The exact original text at [start, end). */
  readonly excerpt: string;
}

export type LocateResult =
  | { readonly ok: true; readonly located: LocatedQuote }
  | { readonly ok: false; readonly code: QuoteFailureCode };

/** UTF-16 indexes of every (overlapping) occurrence of `needle` in `haystack`, at most `limit`. */
function occurrences(haystack: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  let from = 0;
  while (found.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    from = index + 1;
  }
  return found;
}

const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');

export function locateQuote(passage: Passage, quote: string): LocateResult {
  const length = codePointCount(quote);
  if (!isQuotableText(quote) || length < QUOTE_MIN_CODE_POINTS || length > QUOTE_MAX_CODE_POINTS) {
    return { ok: false, code: 'quote_invalid' };
  }
  if (quote.trim().length === 0) return { ok: false, code: 'quote_blank' };

  const hits = occurrences(passage.text, quote, 2);
  if (hits.length === 0) {
    // Diagnostic only: would it match if line endings were normalized? Never used to produce a position.
    if (/[\r]/.test(passage.text) && occurrences(toLf(passage.text), quote, 1).length > 0) {
      return { ok: false, code: 'quote_crosses_line_ending' };
    }
    return { ok: false, code: 'quote_not_found' };
  }
  if (hits.length > 1) return { ok: false, code: 'quote_ambiguous' };

  const [unitIndex] = hits;
  if (unitIndex === undefined) return { ok: false, code: 'quote_not_found' };
  const first = quote.codePointAt(0);
  const afterUnit = unitIndex + quote.length;
  const after = afterUnit < passage.text.length ? passage.text.codePointAt(afterUnit) : undefined;
  if (
    (first !== undefined && extendsPrevious(String.fromCodePoint(first))) ||
    (after !== undefined && extendsPrevious(String.fromCodePoint(after)))
  ) {
    return { ok: false, code: 'quote_splits_character' };
  }
  const local = codePointIndexOf(passage.text, unitIndex);
  const start = passage.start + local;
  return {
    ok: true,
    located: {
      passageHandle: passage.handle,
      snapshotId: passage.snapshotId,
      artifactId: passage.artifactId,
      artifactKey: passage.artifactKey,
      start,
      end: start + length,
      excerpt: quote,
    },
  };
}
