import { z } from 'zod';

/**
 * A score on Judge Copilot's 0.0–10.0 scale (dimension, criterion and overall scores).
 * See docs/SCORING.md. Range-checked only; rounding/precision is a scoring-engine concern (M4).
 */
export const Score10 = z.number().min(0).max(10);
export type Score10 = z.infer<typeof Score10>;

/**
 * A closed-interval ratio in [0, 1] (e.g. evidence coverage, weights, the confidence index).
 * A Ratio is never a statistical probability unless a specific schema says so — see invariant 13.
 */
export const Ratio = z.number().min(0).max(1);
export type Ratio = z.infer<typeof Ratio>;

/** All persisted entities use UUID primary keys. */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * Regex sources are exported as strings so the database package can enforce the
 * identical rule in CHECK constraints (POSIX ARE syntax compatible with PostgreSQL).
 */
export const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';

/** URL-safe lowercase slug, e.g. `cruzhacks-2027`. */
export const Slug = z.string().min(1).max(100).regex(new RegExp(SLUG_PATTERN));
export type Slug = z.infer<typeof Slug>;

export const IDENTIFIER_PATTERN = '^[a-z][a-z0-9_]*$';

/** A snake_case machine identifier, e.g. an audit entity type or an analysis run type. */
export const Identifier = z.string().max(100).regex(new RegExp(IDENTIFIER_PATTERN));
export type Identifier = z.infer<typeof Identifier>;

export const DOTTED_IDENTIFIER_PATTERN = '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$';

/** A dot-separated snake_case identifier, e.g. the audit action `event_context.locked`. */
export const DottedIdentifier = z.string().max(200).regex(new RegExp(DOTTED_IDENTIFIER_PATTERN));
export type DottedIdentifier = z.infer<typeof DottedIdentifier>;
