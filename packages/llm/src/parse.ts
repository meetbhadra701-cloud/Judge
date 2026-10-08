/*
 * Strict parsing of a provider's TEXT answer into JSON. The answer must be exactly one JSON document: a
 * markdown fence, a leading or trailing remark, two documents or an empty string are REJECTED, never "fixed"
 * (design §13.5). What survives is still untrusted `unknown`; the caller runs the stage schema and domain gates.
 */

export type ModelJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'empty' | 'not_json' | 'too_large' };

/** A hard bound on a model answer before it is parsed (a parser should never see unbounded input). */
export const MAX_MODEL_JSON_CHARS = 2_000_000;

export function parseModelJson(text: string): ModelJsonResult {
  if (text.length === 0 || text.trim().length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_MODEL_JSON_CHARS) return { ok: false, reason: 'too_large' };
  // JSON allows surrounding whitespace; anything else around the document is a refusal to guess.
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'not_json' };
  }
}
