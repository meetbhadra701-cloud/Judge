/*
 * The per-call CLOSED SET (design §3.3, §11, invariant 20). A model may refer only to the records the CURRENT call actually showed it.
 * A structurally valid, real record of another batch of the same extraction (a passage that was never in this window, a claim that was
 * in a different relation-matching batch, a pair from another verifier call, a candidate of another scoring unit) is not an
 * authorized reference just because it exists in the overall extraction.
 *
 * The shape is exactly `RenderedPrompt.closedSet` of the prompts package (structurally identical; this package does not import
 * that one, so the layering is preserved). The caller passes the set the renderer RETURNED for the request it sent; nothing here can
 * infer it. Every gate takes it as a REQUIRED argument, and a gate called without it (a JavaScript caller, a cast) fails closed by
 * throwing, never by falling back to the world it validates against.
 */

export interface ClosedSet {
  readonly passages: readonly string[];
  readonly claims: readonly string[];
  readonly evidence: readonly string[];
  readonly pairs: readonly string[];
  /** Claim or evidence handles reviewed by the fidelity stage. */
  readonly items: readonly string[];
  /** The one unit a dimension or critic prompt is about. */
  readonly unit: string | null;
}

export class ClosedSetRequiredError extends Error {
  constructor(readonly field: string) {
    super(`the per-call closed set ("${field}") is required to validate a model output`);
    this.name = 'ClosedSetRequiredError';
  }
}

/** The handles of one closed-set field as a set. Throws when the closed set or the field is missing or malformed. */
export function shownHandles(shown: unknown, field: keyof ClosedSet): ReadonlySet<string> {
  if (typeof shown !== 'object' || shown === null) throw new ClosedSetRequiredError(field);
  const value = (shown as Record<string, unknown>)[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ClosedSetRequiredError(field);
  }
  return new Set(value as string[]);
}

/** The unit named by a closed set. Throws when absent. */
export function shownUnit(shown: unknown): string {
  if (typeof shown !== 'object' || shown === null) throw new ClosedSetRequiredError('unit');
  const value = (shown as Record<string, unknown>)['unit'];
  if (typeof value !== 'string' || value.length === 0) throw new ClosedSetRequiredError('unit');
  return value;
}
