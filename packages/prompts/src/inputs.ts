import {
  ClaimHandle,
  DimensionLimitationCode,
  DottedIdentifier,
  EVIDENCE_CHANNEL_VALUES,
  EvidenceDirectness,
  EvidenceHandle,
  EvidenceSpecificity,
  isStorableGraphText,
  ItemHandle,
  PairHandle,
  PassageHandle,
} from '@judge-copilot/schemas';
import { z } from 'zod';

/*
 * The ONLY things a prompt can be built from. Every input schema is a `strictObject` allow-list: a field that is not
 * listed here (an API key, a token, a connection string, an environment dump, a UUID, a verification level, an `origin`)
 * is REJECTED, so it cannot reach a prompt by accident. Handles are the only identifiers, and each handle field is
 * matched against its closed pattern. Persisted UUIDs have no field here at all.
 *
 * Limits are hard ceilings: the renderer refuses over-long text instead of truncating it (a truncated quote source would
 * silently change what the model can quote).
 */

export const PROMPT_INPUT_LIMITS = {
  passagesPerCall: 40,
  passageTextMaxChars: 2_000,
  labelMaxChars: 200,
  fidelityItemsPerCall: 100,
  claimsPerCall: 100,
  evidencePerCall: 120,
  pairsPerCall: 20,
  claimTextMaxChars: 1_000,
  evidenceTextMaxChars: 2_000,
  quoteMaxChars: 2_000,
  candidatesPerUnit: 60,
  anchorsPerUnit: 50,
  descriptionMaxChars: 5_000,
  rationaleMaxChars: 1_200,
  noteMaxChars: 240,
  oneLineMaxChars: 300,
  contradictionsPerUnit: 20,
  flagsPerUnit: 10,
} as const;

function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Text that is exact data: no NUL or lone surrogate; control characters other than tab and newline are refused. */
export const PromptText = (max: number) =>
  z
    .string()
    .refine((value) => value.length > 0 && codePoints(value) <= max, {
      message: `must be 1 to ${String(max)} characters`,
    })
    .refine(isStorableGraphText, 'contains control characters or malformed Unicode');

/** Source text a model must quote exactly: tab, newline and carriage return are allowed; every other control character is not. */
export const PassageText = (max: number) =>
  z
    .string()
    .refine((value) => value.length > 0 && codePoints(value) <= max, {
      message: `must be 1 to ${String(max)} characters`,
    })
    .refine(
      (value) => isStorableGraphText(value.replaceAll('\r', '')),
      'contains control characters or malformed Unicode',
    );

/** A code-produced label (an artifact path). Data, JSON-escaped when rendered; still length-bounded and storable. */
const Label = PromptText(PROMPT_INPUT_LIMITS.labelMaxChars);

const unique = <T>(items: readonly T[], key: (item: T) => string): boolean =>
  new Set(items.map(key)).size === items.length;

const SourceType = z.enum(['devpost', 'github', 'deployment', 'video']);
const ArtifactClass = z.enum(['source_code', 'repository_metadata', 'deployment_observation']);

// -- Extraction stages -------------------------------------------------------------------------------

const StatementPassage = z.strictObject({
  handle: PassageHandle,
  sourceType: SourceType,
  artifact: Label,
  text: PassageText(PROMPT_INPUT_LIMITS.passageTextMaxChars),
});

export const ClaimExtractionInput = z.strictObject({
  passages: z
    .array(StatementPassage)
    .min(1)
    .max(PROMPT_INPUT_LIMITS.passagesPerCall)
    .refine((list) => unique(list, (p) => p.handle), 'handles must be unique'),
});

const RepositoryPassage = z.strictObject({
  handle: PassageHandle,
  sourceType: SourceType,
  artifact: Label,
  artifactClass: ArtifactClass,
  text: PassageText(PROMPT_INPUT_LIMITS.passageTextMaxChars),
});

export const EvidenceInterpretationInput = z.strictObject({
  passages: z
    .array(RepositoryPassage)
    .min(1)
    .max(PROMPT_INPUT_LIMITS.passagesPerCall)
    .refine((list) => unique(list, (p) => p.handle), 'handles must be unique'),
});

export const FidelityReviewInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        handle: ItemHandle,
        assertion: PromptText(PROMPT_INPUT_LIMITS.evidenceTextMaxChars),
        quote: PromptText(PROMPT_INPUT_LIMITS.quoteMaxChars),
      }),
    )
    .min(1)
    .max(PROMPT_INPUT_LIMITS.fidelityItemsPerCall)
    .refine((list) => unique(list, (i) => i.handle), 'handles must be unique'),
});

const ClaimRecord = z.strictObject({
  handle: ClaimHandle,
  text: PromptText(PROMPT_INPUT_LIMITS.claimTextMaxChars),
});
const EvidenceRecord = z.strictObject({
  handle: EvidenceHandle,
  text: PromptText(PROMPT_INPUT_LIMITS.evidenceTextMaxChars),
  quote: PromptText(PROMPT_INPUT_LIMITS.quoteMaxChars).nullable(),
});

const claimsAndEvidence = {
  claims: z
    .array(ClaimRecord)
    .min(1)
    .max(PROMPT_INPUT_LIMITS.claimsPerCall)
    .refine((list) => unique(list, (c) => c.handle), 'handles must be unique'),
  evidence: z
    .array(EvidenceRecord)
    .max(PROMPT_INPUT_LIMITS.evidencePerCall)
    .refine((list) => unique(list, (e) => e.handle), 'handles must be unique'),
};

export const RelationMatchingInput = z.strictObject(claimsAndEvidence);
export const ContradictionDetectionInput = z.strictObject(claimsAndEvidence);
export const UnknownIdentificationInput = z.strictObject(claimsAndEvidence);

export const RelationVerificationInput = z.strictObject({
  pairs: z
    .array(
      z.strictObject({
        handle: PairHandle,
        claim: PromptText(PROMPT_INPUT_LIMITS.claimTextMaxChars),
        evidence: PromptText(PROMPT_INPUT_LIMITS.evidenceTextMaxChars),
        evidenceQuote: PromptText(PROMPT_INPUT_LIMITS.quoteMaxChars),
      }),
    )
    .min(1)
    .max(PROMPT_INPUT_LIMITS.pairsPerCall)
    .refine((list) => unique(list, (p) => p.handle), 'handles must be unique'),
});

// -- Scoring-unit stages -----------------------------------------------------------------------------

const Scale = z
  .strictObject({ min: z.number(), max: z.number() })
  .refine((scale) => scale.min < scale.max, 'min must be below max');

/**
 * What a score means for this unit. `official` and `official_no_anchors` come from the locked Event Context (build them
 * with `officialUnitFromLockedSnapshot`). `fallback` is accepted by the SCHEMA only so that the renderer can refuse it with
 * a precise error: the fallback anchors are an unapproved draft and no prompt may use them.
 */
const Standard = z.discriminatedUnion('basis', [
  z.strictObject({
    basis: z.literal('official'),
    criterionDescription: PromptText(PROMPT_INPUT_LIMITS.descriptionMaxChars),
    anchors: z
      .array(
        z.strictObject({
          score: z.number(),
          description: PromptText(PROMPT_INPUT_LIMITS.descriptionMaxChars),
        }),
      )
      .min(1)
      .max(PROMPT_INPUT_LIMITS.anchorsPerUnit),
  }),
  z.strictObject({
    basis: z.literal('official_no_anchors'),
    criterionDescription: PromptText(PROMPT_INPUT_LIMITS.descriptionMaxChars),
  }),
  z.strictObject({
    basis: z.literal('fallback'),
    anchorsVersion: z.string().min(1).max(100),
    guide: PromptText(PROMPT_INPUT_LIMITS.descriptionMaxChars),
  }),
]);

export const UnitView = z.strictObject({
  dimensionId: DottedIdentifier,
  name: PromptText(PROMPT_INPUT_LIMITS.labelMaxChars),
  scale: Scale,
  standard: Standard,
  notices: z.array(DimensionLimitationCode).max(PROMPT_INPUT_LIMITS.flagsPerUnit),
});
export type UnitView = z.infer<typeof UnitView>;

/** Only the two labels Option B can produce (design §4.4): a label cannot be smuggled in as `repo_corroborated`. */
const PromptLabel = z.enum(['unverified', 'team_claim']);
const Authorship = z.enum(['team_statement', 'interpreted_fact', 'event_reference']);
const Channel = z.enum(EVIDENCE_CHANNEL_VALUES);

export const Candidate = z.strictObject({
  handle: EvidenceHandle,
  channel: Channel,
  label: PromptLabel,
  authorship: Authorship,
  text: PromptText(PROMPT_INPUT_LIMITS.evidenceTextMaxChars),
  excerpt: PromptText(PROMPT_INPUT_LIMITS.evidenceTextMaxChars).nullable(),
});
export type Candidate = z.infer<typeof Candidate>;

export const DimensionAssessmentInput = z.strictObject({
  unit: UnitView,
  candidates: z
    .array(Candidate)
    .min(1)
    .max(PROMPT_INPUT_LIMITS.candidatesPerUnit)
    .refine((list) => unique(list, (c) => c.handle), 'handles must be unique'),
});

export const CRITIC_FLAG_VALUES = [
  'raw_signal_terms',
  'score_outside_anchor_bracket',
  'all_citations_weak',
  'rationale_mentions_uncited_handle',
  'only_team_authored_evidence',
] as const;

export const CriticInput = z
  .strictObject({
    unit: UnitView,
    judgment: z.strictObject({
      outcome: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('scored'), score: z.number() }),
        z.strictObject({ kind: z.literal('insufficient_evidence') }),
      ]),
      rationale: PromptText(PROMPT_INPUT_LIMITS.rationaleMaxChars),
      citations: z
        .array(
          z.strictObject({
            evidence: EvidenceHandle,
            directness: EvidenceDirectness,
            specificity: EvidenceSpecificity,
            note: PromptText(PROMPT_INPUT_LIMITS.noteMaxChars),
          }),
        )
        .max(PROMPT_INPUT_LIMITS.candidatesPerUnit),
    }),
    cited: z
      .array(Candidate)
      .max(PROMPT_INPUT_LIMITS.candidatesPerUnit)
      .refine((list) => unique(list, (c) => c.handle), 'handles must be unique'),
    others: z
      .array(
        z.strictObject({
          handle: EvidenceHandle,
          oneLine: PromptText(PROMPT_INPUT_LIMITS.oneLineMaxChars),
        }),
      )
      .max(PROMPT_INPUT_LIMITS.candidatesPerUnit),
    contradictions: z
      .array(
        z.strictObject({
          description: PromptText(PROMPT_INPUT_LIMITS.evidenceTextMaxChars),
          sideA: ItemHandle,
          sideB: ItemHandle,
        }),
      )
      .max(PROMPT_INPUT_LIMITS.contradictionsPerUnit),
    flags: z.array(z.enum(CRITIC_FLAG_VALUES)).max(PROMPT_INPUT_LIMITS.flagsPerUnit),
  })
  .superRefine((input, ctx) => {
    const cited = new Set(input.cited.map((c) => c.handle));
    const others = new Set(input.others.map((o) => o.handle));
    input.judgment.citations.forEach((citation, index) => {
      if (!cited.has(citation.evidence)) {
        ctx.addIssue({
          code: 'custom',
          path: ['judgment', 'citations', index, 'evidence'],
          message: 'a cited handle must be one of the cited records',
        });
      }
    });
    for (const handle of others) {
      if (cited.has(handle)) {
        ctx.addIssue({
          code: 'custom',
          path: ['others'],
          message: 'a record cannot be both cited and other',
        });
      }
    }
  });

export const STAGE_INPUT_SCHEMAS = {
  claim_extraction: ClaimExtractionInput,
  evidence_interpretation: EvidenceInterpretationInput,
  fidelity_review: FidelityReviewInput,
  relation_matching: RelationMatchingInput,
  relation_verification: RelationVerificationInput,
  contradiction_detection: ContradictionDetectionInput,
  unknown_identification: UnknownIdentificationInput,
  dimension_assessment: DimensionAssessmentInput,
  critic: CriticInput,
} as const;

export type StageInputs = {
  [K in keyof typeof STAGE_INPUT_SCHEMAS]: z.input<(typeof STAGE_INPUT_SCHEMAS)[K]>;
};
