import { z } from 'zod';
import { IDENTIFIER_PATTERN, Uuid } from './primitives.js';

/*
 * Event Context Pack (M1) — vocabularies and document shapes.
 *
 * Shapes live here so the API, database, domain rules and web UI share one definition.
 * Cross-field rules (rubric weights, provenance preservation, authority-based conflict
 * resolution, source-reference integrity) are domain rules in @judge-copilot/context.
 */

// ---------------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------------

/** How a source's normalized text reached the system. URLs are provenance metadata only (no fetching in M1). */
export const EVENT_SOURCE_TYPE_VALUES = ['pasted_text', 'url_text', 'document_text'] as const;
export const EventSourceType = z.enum(EVENT_SOURCE_TYPE_VALUES);
export type EventSourceType = z.infer<typeof EventSourceType>;

/**
 * The authority of an event-context source. Precedence is NOT array order: it is the explicit
 * table `SOURCE_AUTHORITY_PRECEDENCE` in @judge-copilot/context.
 */
export const EVENT_SOURCE_AUTHORITY_VALUES = [
  'official_event_rules',
  'official_judging_rubric',
  'official_track_rules',
  'organizer_guidance',
  'judge_context',
  'universal_fallback',
] as const;
export const EventSourceAuthority = z.enum(EVENT_SOURCE_AUTHORITY_VALUES);
export type EventSourceAuthority = z.infer<typeof EventSourceAuthority>;

/** How certain an event-context fact is. `unclear` preserves ambiguity instead of guessing. */
export const SOURCE_CERTAINTY_VALUES = ['explicit', 'interpreted', 'unclear'] as const;
export const SourceCertainty = z.enum(SOURCE_CERTAINTY_VALUES);
export type SourceCertainty = z.infer<typeof SourceCertainty>;

export const RUBRIC_SCOPE_VALUES = ['overall', 'track'] as const;
export const RubricScope = z.enum(RUBRIC_SCOPE_VALUES);
export type RubricScope = z.infer<typeof RubricScope>;

/**
 * Who authored a fact. `source_derived` facts came from extraction over sources and must keep
 * their source provenance forever; `human` facts are explicit human corrections/notes.
 */
export const FACT_ORIGIN_VALUES = ['source_derived', 'human'] as const;
export const FactOrigin = z.enum(FACT_ORIGIN_VALUES);
export type FactOrigin = z.infer<typeof FactOrigin>;

export const PRIOR_WORK_STANCE_VALUES = [
  'allowed',
  'allowed_with_disclosure',
  'not_allowed',
  'unclear',
] as const;
export const PriorWorkStance = z.enum(PRIOR_WORK_STANCE_VALUES);
export type PriorWorkStance = z.infer<typeof PriorWorkStance>;

/** How a conflict between sources is resolved. Resolution never deletes the losing positions. */
export const CONFLICT_RESOLUTION_STATUS_VALUES = [
  'resolved_by_authority',
  'resolved_by_human',
  'unresolved',
] as const;
export const ConflictResolutionStatus = z.enum(CONFLICT_RESOLUTION_STATUS_VALUES);
export type ConflictResolutionStatus = z.infer<typeof ConflictResolutionStatus>;

// ---------------------------------------------------------------------------------------------
// Limits (untrusted input is size-bounded)
// ---------------------------------------------------------------------------------------------

export const EVENT_CONTEXT_LIMITS = {
  sourceTextMaxChars: 200_000,
  sourceTitleMaxChars: 300,
  urlMaxChars: 2_048,
  sourcesPerVersionMax: 50,
  statementMaxChars: 5_000,
  nameMaxChars: 200,
  listMaxItems: 200,
  criteriaPerRubricMax: 100,
  anchorsPerCriterionMax: 50,
  sourceIdsPerFactMax: 50,
} as const;

/** Text that PostgreSQL text/jsonb can store: no NUL characters. */
const SafeText = z.string().refine((value) => !value.includes('\u0000'), {
  message: 'Text must not contain NUL characters',
});

const Statement = SafeText.pipe(
  z.string().trim().min(1).max(EVENT_CONTEXT_LIMITS.statementMaxChars),
);
const Name = SafeText.pipe(z.string().trim().min(1).max(EVENT_CONTEXT_LIMITS.nameMaxChars));
const Description = SafeText.pipe(z.string().trim().max(EVENT_CONTEXT_LIMITS.statementMaxChars));
const Key = z.string().max(100).regex(new RegExp(IDENTIFIER_PATTERN), 'Keys must be snake_case');
const SourceIds = z.array(Uuid).max(EVENT_CONTEXT_LIMITS.sourceIdsPerFactMax);
const IsoDateTime = z.iso.datetime({ offset: true });
const list = <T extends z.ZodType>(item: T) => z.array(item).max(EVENT_CONTEXT_LIMITS.listMaxItems);

// ---------------------------------------------------------------------------------------------
// Event sources
// ---------------------------------------------------------------------------------------------

export const EventSourceInput = z
  .object({
    sourceType: EventSourceType,
    authority: EventSourceAuthority,
    title: SafeText.pipe(z.string().trim().min(1).max(EVENT_CONTEXT_LIMITS.sourceTitleMaxChars)),
    url: z
      .url({ protocol: /^https?$/, hostname: z.regexes.domain })
      .max(EVENT_CONTEXT_LIMITS.urlMaxChars)
      .nullable()
      .optional(),
    /** Normalized text supplied by the client. The server re-normalizes before hashing. */
    normalizedText: SafeText.pipe(z.string().min(1).max(EVENT_CONTEXT_LIMITS.sourceTextMaxChars)),
    capturedAt: IsoDateTime.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceType === 'url_text' && !value.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'url_text sources require a url' });
    }
  });
export type EventSourceInput = z.input<typeof EventSourceInput>;

export const EventSourceSummary = z.object({
  id: Uuid,
  contextVersionId: Uuid,
  sourceType: EventSourceType,
  authority: EventSourceAuthority,
  authorityRank: z.number().int(),
  title: z.string(),
  url: z.string().nullable(),
  contentHash: z.string(),
  textLength: z.number().int(),
  capturedAt: IsoDateTime,
  createdAt: IsoDateTime,
  copiedFromId: Uuid.nullable(),
});
export type EventSourceSummary = z.infer<typeof EventSourceSummary>;

export const EventSourceRecord = EventSourceSummary.extend({ normalizedText: z.string() });
export type EventSourceRecord = z.infer<typeof EventSourceRecord>;

// ---------------------------------------------------------------------------------------------
// Document input (human edits) and extraction output (untrusted extractor/model output)
// ---------------------------------------------------------------------------------------------

const factInputShape = {
  /** Present when editing an existing fact; absent for new facts. Never supplied by extractors. */
  id: Uuid.optional(),
  statement: Statement,
  certainty: SourceCertainty,
  sourceIds: SourceIds,
};

type CertaintyCheck = { certainty: SourceCertainty };

function refineDateFact(value: CertaintyCheck & { value: string | null }, ctx: z.RefinementCtx) {
  if ((value.value === null) !== (value.certainty === 'unclear')) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'A date value must be null exactly when certainty is "unclear"',
    });
  }
}

function refinePriorWork(
  value: CertaintyCheck & { stance: PriorWorkStance },
  ctx: z.RefinementCtx,
) {
  if ((value.stance === 'unclear') !== (value.certainty === 'unclear')) {
    ctx.addIssue({
      code: 'custom',
      path: ['stance'],
      message: 'Prior-work stance must be "unclear" exactly when certainty is "unclear"',
    });
  }
}

export const ContextFactInput = z.object(factInputShape);
export type ContextFactInput = z.infer<typeof ContextFactInput>;

export const DateFactInput = z
  .object({ ...factInputShape, value: IsoDateTime.nullable() })
  .superRefine(refineDateFact);
export type DateFactInput = z.infer<typeof DateFactInput>;

export const SubmissionRequirementInput = z.object({ ...factInputShape, trackKey: Key.nullable() });

export const PriorWorkPolicyInput = z
  .object({ ...factInputShape, stance: PriorWorkStance })
  .superRefine(refinePriorWork);

export const TrackInput = z.object({
  key: Key,
  name: Name,
  description: Description.nullable(),
  sourceIds: SourceIds,
});

export const RubricAnchorInput = z.object({
  score: z.number(),
  description: Statement,
});

export const RubricCriterionInput = z.object({
  key: Key,
  name: Name,
  description: Description,
  /** A fraction in (0, 1]; null when the official rubric gives no weights. Never invented. */
  weight: z.number().nullable(),
  sourceIds: SourceIds,
  anchors: z.array(RubricAnchorInput).max(EVENT_CONTEXT_LIMITS.anchorsPerCriterionMax),
});

export const RubricInput = z.object({
  scope: RubricScope,
  trackKey: Key.nullable(),
  name: Name,
  scaleMin: z.number(),
  scaleMax: z.number(),
  sourceIds: SourceIds,
  criteria: z.array(RubricCriterionInput).max(EVENT_CONTEXT_LIMITS.criteriaPerRubricMax),
});

export const ConflictPosition = z.object({ sourceId: Uuid, statement: Statement });
export type ConflictPosition = z.infer<typeof ConflictPosition>;

export const HumanConflictResolution = z.object({
  prevailingSourceIds: z.array(Uuid).min(1).max(20),
  note: Statement,
});
export type HumanConflictResolution = z.infer<typeof HumanConflictResolution>;

export const ConflictInput = z.object({
  id: Uuid.optional(),
  topic: Name,
  description: Statement,
  positions: z.array(ConflictPosition).max(20),
  /** Only permitted when the highest-authority positions are tied. */
  humanResolution: HumanConflictResolution.nullable().optional(),
});

export const EventDatesInput = z.object({
  startsAt: DateFactInput,
  endsAt: DateFactInput,
  judgingStartsAt: DateFactInput,
  submissionDeadline: DateFactInput,
});

export const EventContextDocumentInput = z.object({
  dates: EventDatesInput,
  judgingFormat: ContextFactInput,
  rules: list(ContextFactInput),
  submissionRequirements: list(SubmissionRequirementInput),
  priorWorkPolicy: PriorWorkPolicyInput,
  organizerGuidance: list(ContextFactInput),
  tracks: list(TrackInput),
  rubrics: list(RubricInput),
  conflicts: list(ConflictInput),
});
export type EventContextDocumentInput = z.infer<typeof EventContextDocumentInput>;

/**
 * The output contract of an EventContextExtractor. Same shape as a human edit, except that
 * extractors may never supply IDs (invariant 20) or human conflict resolutions.
 */
export const EventContextExtraction = EventContextDocumentInput.superRefine((value, ctx) => {
  const facts: { id?: string | undefined; path: (string | number)[] }[] = [
    ...Object.entries(value.dates).map(([key, fact]) => ({ id: fact.id, path: ['dates', key] })),
    { id: value.judgingFormat.id, path: ['judgingFormat'] },
    { id: value.priorWorkPolicy.id, path: ['priorWorkPolicy'] },
    ...value.rules.map((fact, i) => ({ id: fact.id, path: ['rules', i] })),
    ...value.submissionRequirements.map((fact, i) => ({
      id: fact.id,
      path: ['submissionRequirements', i],
    })),
    ...value.organizerGuidance.map((fact, i) => ({ id: fact.id, path: ['organizerGuidance', i] })),
    ...value.conflicts.map((conflict, i) => ({ id: conflict.id, path: ['conflicts', i] })),
  ];
  for (const fact of facts) {
    if (fact.id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [...fact.path, 'id'],
        message: 'Extractors must not supply IDs',
      });
    }
  }
  value.conflicts.forEach((conflict, i) => {
    if (conflict.humanResolution != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['conflicts', i, 'humanResolution'],
        message: 'Extractors must not resolve conflicts on behalf of a human',
      });
    }
  });
});
export type EventContextExtraction = z.infer<typeof EventContextExtraction>;

// ---------------------------------------------------------------------------------------------
// Stored / reviewed document (server-computed provenance fields)
// ---------------------------------------------------------------------------------------------

const provenanceShape = {
  sourceIds: SourceIds,
  origin: FactOrigin,
  /** True when a human changed a source-derived item; its source provenance is retained. */
  humanModified: z.boolean(),
};

const factShape = {
  id: Uuid,
  statement: Statement,
  certainty: SourceCertainty,
  ...provenanceShape,
};

export const ContextFact = z.object(factShape);
export type ContextFact = z.infer<typeof ContextFact>;

export const DateFact = z
  .object({ ...factShape, value: IsoDateTime.nullable() })
  .superRefine(refineDateFact);
export type DateFact = z.infer<typeof DateFact>;

export const EventDates = z.object({
  startsAt: DateFact,
  endsAt: DateFact,
  judgingStartsAt: DateFact,
  submissionDeadline: DateFact,
});
export type EventDates = z.infer<typeof EventDates>;

/** An official rule, as a sourced fact. */
export const StructuredEventRule = ContextFact;
export type StructuredEventRule = ContextFact;

export const SubmissionRequirement = z.object({ ...factShape, trackKey: Key.nullable() });
export type SubmissionRequirement = z.infer<typeof SubmissionRequirement>;

export const PriorWorkPolicy = z
  .object({ ...factShape, stance: PriorWorkStance })
  .superRefine(refinePriorWork);
export type PriorWorkPolicy = z.infer<typeof PriorWorkPolicy>;

export const OrganizerGuidance = ContextFact;
export type OrganizerGuidance = ContextFact;

export const TrackDefinition = z.object({
  key: Key,
  name: Name,
  description: Description.nullable(),
  ...provenanceShape,
});
export type TrackDefinition = z.infer<typeof TrackDefinition>;

export const RubricAnchorDefinition = RubricAnchorInput;
export type RubricAnchorDefinition = z.infer<typeof RubricAnchorDefinition>;

export const RubricCriterionDefinition = z.object({
  key: Key,
  name: Name,
  description: Description,
  weight: z.number().nullable(),
  anchors: z.array(RubricAnchorDefinition),
  ...provenanceShape,
});
export type RubricCriterionDefinition = z.infer<typeof RubricCriterionDefinition>;

export const RubricDefinition = z.object({
  scope: RubricScope,
  trackKey: Key.nullable(),
  name: Name,
  scaleMin: z.number(),
  scaleMax: z.number(),
  criteria: z.array(RubricCriterionDefinition),
  ...provenanceShape,
});
export type RubricDefinition = z.infer<typeof RubricDefinition>;

export const ConflictResolution = z.object({
  status: ConflictResolutionStatus,
  prevailingSourceIds: z.array(Uuid),
  note: z.string().nullable(),
});
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const ContextConflict = z.object({
  id: Uuid,
  topic: Name,
  description: Statement,
  /** Every position is retained, including those that lost on authority. */
  positions: z.array(ConflictPosition),
  resolution: ConflictResolution,
  origin: FactOrigin,
  humanModified: z.boolean(),
});
export type ContextConflict = z.infer<typeof ContextConflict>;

const contentShape = {
  dates: EventDates,
  judgingFormat: ContextFact,
  rules: z.array(StructuredEventRule),
  submissionRequirements: z.array(SubmissionRequirement),
  priorWorkPolicy: PriorWorkPolicy,
  organizerGuidance: z.array(OrganizerGuidance),
  conflicts: z.array(ContextConflict),
};

/** The non-rubric part of a document, stored as typed JSONB on the context version. */
export const EventContextContent = z.object(contentShape);
export type EventContextContent = z.infer<typeof EventContextContent>;

/** A complete reviewed Event Context (a draft while editable; frozen once locked). */
export const EventContextDocument = z.object({
  ...contentShape,
  tracks: z.array(TrackDefinition),
  rubrics: z.array(RubricDefinition),
});
export type EventContextDocument = z.infer<typeof EventContextDocument>;
