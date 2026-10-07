import { z } from 'zod';
import { EvidenceKind, EvidenceOrigin, UnknownType, VerificationLevel } from './enums.js';
import { Uuid } from './primitives.js';

/*
 * Vocabularies, limits and creation inputs for the M3 evidence graph (Claim, EvidenceItem,
 * EvidenceRelation, Unknown, Contradiction). Like enums.ts, vocabularies are readonly tuples
 * (reused by database CHECK constraints) plus Zod enums.
 *
 * Creation inputs are what an UNTRUSTED producer (a fixture today, a model-backed extractor in M5)
 * may submit. They never contain persisted IDs for new entities: producers name new entities with
 * batch-local `ref`s and trusted code assigns every UUID (invariant 20). A reference to something
 * that already exists is a `{ id }` that is validated against the authoritative set.
 */

/** What an EvidenceRelation says about a claim. The smallest vocabulary the docs require. */
export const EVIDENCE_RELATION_TYPE_VALUES = ['supports', 'contradicts'] as const;
export const EvidenceRelationType = z.enum(EVIDENCE_RELATION_TYPE_VALUES);
export type EvidenceRelationType = z.infer<typeof EvidenceRelationType>;

/** Everything that is a node of the evidence graph. */
export const GRAPH_NODE_TYPE_VALUES = ['claim', 'evidence', 'unknown', 'contradiction'] as const;
export const GraphNodeType = z.enum(GRAPH_NODE_TYPE_VALUES);
export type GraphNodeType = z.infer<typeof GraphNodeType>;

/** The graph material a Contradiction may be about. */
export const CONTRADICTION_SIDE_TYPE_VALUES = ['claim', 'evidence'] as const;
export const ContradictionSideType = z.enum(CONTRADICTION_SIDE_TYPE_VALUES);
export type ContradictionSideType = z.infer<typeof ContradictionSideType>;

/**
 * Unit of evidence spans. Offsets count Unicode code points (not UTF-16 units, not bytes) from
 * the start of the referenced artifact's stored text, half-open: `[start, end)`. PostgreSQL
 * `substr`/`length` use the same unit for a UTF-8 database, so the database can verify spans.
 */
export const SPAN_UNIT = 'code_points' as const;

/** Hard bounds shared by validation, the planner and database CHECK constraints. */
export const EVIDENCE_GRAPH_LIMITS = {
  claimTextMaxChars: 1_000,
  evidenceTextMaxChars: 2_000,
  unknownTextMaxChars: 1_000,
  contradictionDescriptionMaxChars: 1_000,
  /** Also the maximum length of a span, in code points: the stored excerpt is the span's text. */
  excerptMaxChars: 2_000,
  localRefMaxChars: 64,
  /** Claim and evidence references an Unknown may carry (each). */
  unknownRefsMax: 50,
  /** Per `createGraph` batch. */
  batch: { claims: 100, evidence: 200, relations: 400, unknowns: 50, contradictions: 50 },
  /** Per project, so loading one project's graph is always bounded. */
  perProject: {
    claims: 2_000,
    evidence: 5_000,
    relations: 10_000,
    unknowns: 1_000,
    contradictions: 1_000,
  },
  pageSizeDefault: 50,
  pageSizeMax: 200,
  traversalMaxDepth: 4,
  traversalMaxNodes: 500,
  /** Upper bound on a supersession chain walk (a defensive cycle guard, never reached by valid data). */
  supersessionChainMax: 1_000,
} as const;

// -- Text normalization ------------------------------------------------------------------------

function hasForbiddenControl(value: string, allowed: readonly number[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 || code === 0x7f) && !allowed.includes(code)) return true;
  }
  return false;
}

/**
 * Deterministic text normalization for graph text: Unicode NFC, `\n` line endings, trimmed.
 * Throws nothing; callers validate the result with {@link isStorableGraphText}.
 */
export function normalizeGraphText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

/** A claim is one line: normalization additionally collapses every whitespace run to one space. */
export function normalizeClaimText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Well-formed Unicode and no control characters other than tab and newline (never NUL). */
export function isStorableGraphText(value: string): boolean {
  return !hasLoneSurrogate(value) && !hasForbiddenControl(value, [0x09, 0x0a]);
}

function boundedText(maxChars: number, normalize: (value: string) => string) {
  return z
    .string()
    .max(maxChars * 4)
    .transform(normalize)
    .pipe(
      z
        .string()
        .min(1, 'must not be empty')
        .max(maxChars)
        .refine(isStorableGraphText, 'contains control characters or malformed Unicode'),
    );
}

export const ClaimText = boundedText(EVIDENCE_GRAPH_LIMITS.claimTextMaxChars, normalizeClaimText);
export const EvidenceText = boundedText(
  EVIDENCE_GRAPH_LIMITS.evidenceTextMaxChars,
  normalizeGraphText,
);
export const UnknownText = boundedText(
  EVIDENCE_GRAPH_LIMITS.unknownTextMaxChars,
  normalizeGraphText,
);
export const ContradictionDescription = boundedText(
  EVIDENCE_GRAPH_LIMITS.contradictionDescriptionMaxChars,
  normalizeGraphText,
);

// -- References --------------------------------------------------------------------------------

/** Batch-local name of a new entity. Meaningless outside its batch; never persisted. */
export const LocalRef = z
  .string()
  .max(EVIDENCE_GRAPH_LIMITS.localRefMaxChars)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    'must be lowercase letters, digits, "_" or "-", starting with a letter',
  );
export type LocalRef = z.infer<typeof LocalRef>;

/** A UUID, canonicalized to lowercase so the same ID always compares equal. */
export const CanonicalUuid = Uuid.transform((value) => value.toLowerCase());

/**
 * A reference to a node: either one created in the same batch (`ref`) or one that already exists
 * (`id`, validated against the authoritative set). Well-formedness proves nothing about existence.
 */
export const GraphRef = z.union([
  z.strictObject({ ref: LocalRef }),
  z.strictObject({ id: CanonicalUuid }),
]);
export type GraphRef = z.infer<typeof GraphRef>;

const ContradictionSideInput = z.union([
  z.strictObject({ type: ContradictionSideType, ref: LocalRef }),
  z.strictObject({ type: ContradictionSideType, id: CanonicalUuid }),
]);
export type ContradictionSideInput = z.infer<typeof ContradictionSideInput>;

// -- Creation inputs ---------------------------------------------------------------------------

const NonNegativeInt = z.number().int().min(0).max(2_147_483_647);

export const EvidenceSpanInput = z.strictObject({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type EvidenceSpanInput = z.infer<typeof EvidenceSpanInput>;

/**
 * Where an evidence item came from. All fields reference existing immutable records; which of
 * them an origin requires is decided by the domain rules in @judge-copilot/evidence.
 */
export const EvidenceProvenanceInput = z.strictObject({
  /** Source-derived evidence: the exact immutable M2 snapshot (never "the latest"). */
  snapshotId: CanonicalUuid.optional(),
  /** Optionally narrows to one artifact of that snapshot. */
  artifactId: CanonicalUuid.optional(),
  /** Optionally narrows to a span of that artifact's stored text. */
  span: EvidenceSpanInput.optional(),
  /**
   * Optional quotation. If given it must equal the span's exact text; if omitted the trusted
   * planner derives it. It is never an independent source of truth.
   */
  excerpt: z
    .string()
    .max(EVIDENCE_GRAPH_LIMITS.excerptMaxChars * 4)
    .optional(),
  /** `event_context` evidence: the locked or historically locked version it comes from. */
  contextVersionId: CanonicalUuid.optional(),
});
export type EvidenceProvenanceInput = z.infer<typeof EvidenceProvenanceInput>;

export const ClaimInput = z.strictObject({
  ref: LocalRef,
  text: ClaimText,
  verificationLevel: VerificationLevel,
  /** An earlier claim of the same project (existing, or earlier in this batch) this one corrects. */
  supersedes: GraphRef.optional(),
});
export type ClaimInput = z.input<typeof ClaimInput>;

export const EvidenceItemInput = z.strictObject({
  ref: LocalRef,
  kind: EvidenceKind,
  origin: EvidenceOrigin,
  verificationLevel: VerificationLevel,
  text: EvidenceText,
  provenance: EvidenceProvenanceInput.default({}),
});
export type EvidenceItemInput = z.input<typeof EvidenceItemInput>;

export const EvidenceRelationInput = z.strictObject({
  claim: GraphRef,
  evidence: GraphRef,
  type: EvidenceRelationType,
});
export type EvidenceRelationInput = z.input<typeof EvidenceRelationInput>;

export const UnknownInput = z.strictObject({
  unknownType: UnknownType,
  text: UnknownText,
  claims: z.array(GraphRef).max(EVIDENCE_GRAPH_LIMITS.unknownRefsMax).default([]),
  evidence: z.array(GraphRef).max(EVIDENCE_GRAPH_LIMITS.unknownRefsMax).default([]),
});
export type UnknownInput = z.input<typeof UnknownInput>;

export const ContradictionInput = z.strictObject({
  sideA: ContradictionSideInput,
  sideB: ContradictionSideInput,
  /** Neutral description of the inconsistency, for a judge to review. Never an accusation. */
  description: ContradictionDescription,
});
export type ContradictionInput = z.input<typeof ContradictionInput>;

/**
 * One atomic batch: all of it is validated and inserted, or none of it is. `strictObject`
 * everywhere, so a caller cannot smuggle IDs, origins, timestamps or scores into a record.
 */
export const EvidenceGraphBatchInput = z
  .strictObject({
    claims: z.array(ClaimInput).max(EVIDENCE_GRAPH_LIMITS.batch.claims).default([]),
    evidence: z.array(EvidenceItemInput).max(EVIDENCE_GRAPH_LIMITS.batch.evidence).default([]),
    relations: z
      .array(EvidenceRelationInput)
      .max(EVIDENCE_GRAPH_LIMITS.batch.relations)
      .default([]),
    unknowns: z.array(UnknownInput).max(EVIDENCE_GRAPH_LIMITS.batch.unknowns).default([]),
    contradictions: z
      .array(ContradictionInput)
      .max(EVIDENCE_GRAPH_LIMITS.batch.contradictions)
      .default([]),
  })
  .refine(
    (batch) =>
      batch.claims.length +
        batch.evidence.length +
        batch.relations.length +
        batch.unknowns.length +
        batch.contradictions.length >
      0,
    'A graph batch must create at least one record',
  );
export type EvidenceGraphBatchInput = z.input<typeof EvidenceGraphBatchInput>;
export type ParsedEvidenceGraphBatch = z.output<typeof EvidenceGraphBatchInput>;
