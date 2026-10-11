import {
  buildStatementItems,
  combineVerifications,
  indexPassages,
  interpretViews,
  pairsForVerification,
  pendingReviews,
  resolveFidelity,
  sourceGapUnknowns,
  statementViews,
  validateClaimExtraction,
  validateContradictions,
  validateEvidenceInterpretation,
  validateFidelityReview,
  validateRelationMatching,
  validateRelationVerification,
  validateUnknowns,
  type AdmittedClaim,
  type AdmittedEvidence,
  type CodeUnknown,
  type CommentaryWorld,
  type DroppedRelation,
  type FidelityCall,
  type FidelityResolution,
  type PassageIndex,
  type ProposedContradiction,
  type ProposedRelation,
  type ProposedUnknown,
  type RelationEvidence,
  type RelationWorld,
  type Rejection,
  type SourceStatus,
  type StatementItem,
  type VerificationResolution,
  type WindowingResult,
} from '@judge-copilot/assessment';
import { RESERVATION_OVERHEAD_TOKENS } from '@judge-copilot/llm';
import type { AssessmentRunLimits } from '@judge-copilot/schemas';
import { STAGE_BATCH, type EffectivePlan } from './config.js';
import type { CallResult, ModelCaller } from './model-call.js';
import { failRun } from './stop.js';

/*
 * S2-S6: the model-backed extraction stages (design §3.2, §4, §9.3 rows 1-5). Each stage is a narrow task over code-assigned HANDLES; the
 * code between stages assigns every ID, span, excerpt, origin and verification label (the model has no field for any of them).
 *
 *   S2   claim extraction            statement passages               -> G1
 *   S3   evidence interpretation     repository / observation passages -> G2
 *   S3b  fidelity review             paraphrases only, <= 10 per call -> G2b (an invalid reviewer answer DOWNGRADES, never admits)
 *   S4   relation matching           claims x evidence digests         -> G3
 *   S4b  relation verification       one independent pair per item     -> G3b (a relation survives only if the verifier agrees)
 *   S5   contradictions, S6 unknowns (plus the code-authored `missing` unknowns from the source status)
 *
 * Failure semantics follow §9.3: an item that fails its gate is DROPPED AND COUNTED and the stage goes on; an answer that stays
 * structurally invalid after its single re-ask fails the RUN (an incomplete extraction is never presented as complete); a refusal or an
 * outage fails the run; spend is never reused by another run.
 */

export interface ExtractionDraft {
  readonly claims: readonly AdmittedClaim[];
  readonly statementItems: readonly StatementItem[];
  readonly evidence: readonly AdmittedEvidence[];
  readonly relations: readonly ProposedRelation[];
  readonly contradictions: readonly ProposedContradiction[];
  readonly unknowns: readonly (ProposedUnknown | CodeUnknown)[];
  readonly fidelity: FidelityResolution['dispositions'];
  readonly rejections: readonly Rejection[];
  readonly droppedRelations: readonly DroppedRelation[];
}

export interface ExtractionContext {
  readonly caller: ModelCaller;
  readonly windowing: WindowingResult;
  readonly plan: EffectivePlan;
  readonly statuses: readonly SourceStatus[];
  readonly limits: AssessmentRunLimits;
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;
/** Bytes of framing the renderer adds per record (markers, JSON meta). */
const RECORD_OVERHEAD_BYTES = 400;
/** Headroom for the system text (at most ~4.3K bytes) and the output schema (at most ~1.3K), which the reservation counts as input too. */
const SYSTEM_AND_SCHEMA_BYTES = 8_000;

/** The input bytes one call may carry so that its worst-case RESERVATION stays under the per-call bound. */
export function variableByteBudget(limits: AssessmentRunLimits): number {
  return Math.max(
    8_000,
    limits.maxReservedInputTokensPerCall - RESERVATION_OVERHEAD_TOKENS - SYSTEM_AND_SCHEMA_BYTES,
  );
}

/** Splits items into batches of at most `maxCount` items and at most `maxBytes` bytes (an item larger than the budget goes alone). */
export function fitBatches<T>(
  items: readonly T[],
  maxCount: number,
  maxBytes: number,
  sizeOf: (item: T) => number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item) + RECORD_OVERHEAD_BYTES;
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The longest prefix of `items` whose bytes fit (always at least one item when any exist). */
function prefixWithin<T>(
  items: readonly T[],
  maxCount: number,
  maxBytes: number,
  sizeOf: (item: T) => number,
): T[] {
  return fitBatches(items, maxCount, maxBytes, sizeOf)[0] ?? [];
}

type Unwrapped<T> = { value: T; reasked: boolean };

/**
 * An extraction call must produce a usable answer or end the run. `schema` is the failure category when the answer stayed invalid.
 */
function required<T>(result: CallResult<T>, stage: string): Unwrapped<T> {
  switch (result.kind) {
    case 'ok':
      return { value: result.value, reasked: result.reasked };
    case 'invalid':
      return failRun(
        result.phase === 'shape' ? 'schema_validation_failed' : 'domain_validation_failed',
        `extraction_output_invalid:${stage}`,
        stage,
      );
    case 'truncated':
      return failRun('schema_validation_failed', `extraction_output_truncated:${stage}`, stage);
    case 'refused':
      return failRun('provider_error', `provider_refused:${stage}`, stage);
  }
}

const mostlyRejected = (accepted: number, rejected: number): boolean =>
  rejected > 0 && rejected > accepted;

export async function runExtractionStages(context: ExtractionContext): Promise<ExtractionDraft> {
  const { caller, windowing, plan, statuses, limits } = context;
  const budget = variableByteBudget(limits);
  const index: PassageIndex = indexPassages(windowing.passages);
  const rejections: Rejection[] = [];

  // -- S2: claims ---------------------------------------------------------------------------------------------------------
  const claimsFound: AdmittedClaim[] = [];
  for (const batch of fitBatches(
    statementViews(windowing.passages),
    STAGE_BATCH.passagesPerCall,
    budget,
    (view) => byteLength(view.text),
  )) {
    const { value } = required(
      await caller.call({
        stage: 'claim_extraction',
        role: 'extraction',
        input: { passages: batch },
        validate: (json, closed) => {
          const staged = validateClaimExtraction(json, index, closed, {
            existing: claimsFound,
            maxClaims: plan.claimsCap,
          });
          if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
          return {
            ok: true,
            value: staged,
            weak: mostlyRejected(staged.accepted.length, staged.rejected.length),
            quality: staged.accepted.length - staged.rejected.length,
          };
        },
      }),
      'claim_extraction',
    );
    claimsFound.push(...value.accepted);
    rejections.push(...value.rejected);
  }

  // -- S3: interpreted evidence --------------------------------------------------------------------------------------------
  const evidenceFound: AdmittedEvidence[] = [];
  for (const batch of fitBatches(
    interpretViews(windowing.passages),
    STAGE_BATCH.passagesPerCall,
    budget,
    (view) => byteLength(view.text),
  )) {
    const { value } = required(
      await caller.call({
        stage: 'evidence_interpretation',
        role: 'extraction',
        input: { passages: batch },
        validate: (json, closed) => {
          const staged = validateEvidenceInterpretation(json, index, closed, {
            existing: evidenceFound,
            maxEvidence: plan.evidenceCap,
          });
          if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
          return {
            ok: true,
            value: staged,
            weak: mostlyRejected(staged.accepted.length, staged.rejected.length),
            quality: staged.accepted.length - staged.rejected.length,
          };
        },
      }),
      'evidence_interpretation',
    );
    evidenceFound.push(...value.accepted);
    rejections.push(...value.rejected);
  }

  // -- S3b: fidelity review of the paraphrases (verbatim items need no call) ------------------------------------------------
  const pending = pendingReviews(claimsFound, evidenceFound);
  const fidelityCalls: FidelityCall[] = [];
  for (const batch of fitBatches(
    pending,
    STAGE_BATCH.fidelityItemsPerCall,
    budget,
    (item) => byteLength(item.assertion) + byteLength(item.quote),
  )) {
    const shown = batch.map((item) => item.handle);
    const result = await caller.call({
      stage: 'fidelity_review',
      role: 'extraction',
      input: {
        items: batch.map((item) => ({
          handle: item.handle,
          assertion: item.assertion,
          quote: item.quote,
        })),
      },
      validate: (json, closed) => {
        const staged = validateFidelityReview(json, closed, pending);
        if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
        return {
          ok: true,
          value: staged,
          weak: staged.issues.length > 0,
          quality: staged.call.verdicts.length,
        };
      },
    });
    if (result.kind === 'refused') required(result, 'fidelity_review');
    // An invalid or truncated reviewer answer DOWNGRADES this batch (design §4.5 rule 3); it never admits a paraphrase unreviewed.
    fidelityCalls.push(result.kind === 'ok' ? result.value.call : { shown, verdicts: [] });
  }
  const resolved = resolveFidelity(claimsFound, evidenceFound, fidelityCalls);

  // -- statement items: every claim must have its citable statement (M4 scores evidence ids, never claim ids) ---------------------
  const statements = buildStatementItems(resolved.claims, resolved.evidence);
  const unstatable = new Set(statements.unstatable);
  for (const handle of unstatable) {
    rejections.push({ gate: 'G1', code: 'claim_not_statable', index: -1, handle });
  }
  const claims = resolved.claims.filter((claim) => !unstatable.has(claim.handle));
  const statementItems = statements.items;
  const evidence = resolved.evidence;

  // The records the model sees in S4-S6: facts first, then the statement items, bounded by count and bytes.
  const digests: RelationEvidence[] = [
    ...evidence.map((item) => ({
      handle: item.handle,
      kind: 'fact' as const,
      text: item.text,
      excerpt: item.located.excerpt,
      statementOf: [] as string[],
    })),
    ...statementItems.map((item) => ({
      handle: item.handle,
      kind: 'claim' as const,
      text: item.text,
      excerpt: item.located.excerpt,
      statementOf: [...item.claimHandles],
    })),
  ];
  const world: RelationWorld = {
    claims: new Map(
      claims.map((claim) => [claim.handle, { handle: claim.handle, text: claim.text }]),
    ),
    evidence: new Map(digests.map((item) => [item.handle, item])),
  };
  const commentaryWorld: CommentaryWorld = {
    claims: new Set(world.claims.keys()),
    evidence: new Set(world.evidence.keys()),
    statementOf: new Map(statementItems.map((item) => [item.handle, [...item.claimHandles]])),
  };

  let relations: ProposedRelation[] = [];
  let droppedRelations: DroppedRelation[] = [];
  let contradictions: ProposedContradiction[] = [];
  const modelUnknowns: ProposedUnknown[] = [];

  if (claims.length > 0) {
    const claimBytes = claims.reduce((sum, claim) => sum + byteLength(claim.text), 0);
    const shownEvidence = prefixWithin(
      digests,
      STAGE_BATCH.evidenceShownPerCall,
      Math.max(2_000, budget - Math.min(budget / 2, claimBytes)),
      (item) => byteLength(item.text) + byteLength(item.excerpt),
    );
    const evidenceRecords = shownEvidence.map((item) => ({
      handle: item.handle,
      text: item.text,
      quote: item.excerpt,
    }));
    const evidenceBytes = shownEvidence.reduce(
      (sum, item) => sum + byteLength(item.text) + byteLength(item.excerpt) + RECORD_OVERHEAD_BYTES,
      0,
    );

    // -- S4: relation matching -------------------------------------------------------------------------------------------
    const matched: ProposedRelation[] = [];
    for (const batch of fitBatches(
      claims,
      STAGE_BATCH.claimsPerMatchingCall,
      Math.max(2_000, budget - evidenceBytes),
      (claim) => byteLength(claim.text),
    )) {
      const { value } = required(
        await caller.call({
          stage: 'relation_matching',
          role: 'extraction',
          input: {
            claims: batch.map((claim) => ({ handle: claim.handle, text: claim.text })),
            evidence: evidenceRecords,
          },
          validate: (json, closed) => {
            const staged = validateRelationMatching(json, world, closed, matched);
            if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
            return {
              ok: true,
              value: staged,
              weak: mostlyRejected(staged.accepted.length, staged.rejected.length),
              quality: staged.accepted.length - staged.rejected.length,
            };
          },
        }),
        'relation_matching',
      );
      matched.push(...value.accepted);
      rejections.push(...value.rejected);
    }

    // -- S4b: independent verification of EVERY candidate relation -------------------------------------------------------
    const pairs = pairsForVerification(matched, world);
    const resolutions: VerificationResolution[] = [];
    for (const batch of fitBatches(
      pairs,
      STAGE_BATCH.pairsPerVerificationCall,
      budget,
      (pair) => byteLength(pair.claim) + byteLength(pair.evidence) + byteLength(pair.evidenceQuote),
    )) {
      const { value } = required(
        await caller.call({
          stage: 'relation_verification',
          role: 'extraction',
          input: {
            pairs: batch.map((pair) => ({
              handle: pair.handle,
              claim: pair.claim,
              evidence: pair.evidence,
              evidenceQuote: pair.evidenceQuote,
            })),
          },
          validate: (json, closed) => {
            const staged = validateRelationVerification(json, pairs, closed);
            if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
            return {
              ok: true,
              value: staged,
              weak: staged.issues.length > 0,
              quality: staged.keptPairs.length - staged.issues.length,
            };
          },
        }),
        'relation_verification',
      );
      resolutions.push(value);
    }
    const settled = combineVerifications(pairs, resolutions);
    relations = [...settled.kept];
    droppedRelations = [...settled.dropped];

    const shownClaims = claims.slice(0, STAGE_BATCH.claimsShownPerCall);
    const commentaryInput = {
      claims: shownClaims.map((claim) => ({ handle: claim.handle, text: claim.text })),
      evidence: evidenceRecords,
    };

    // -- S5: contradictions ----------------------------------------------------------------------------------------------
    {
      const { value } = required(
        await caller.call({
          stage: 'contradiction_detection',
          role: 'extraction',
          input: commentaryInput,
          validate: (json, closed) => {
            const staged = validateContradictions(json, commentaryWorld, closed, []);
            if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
            return {
              ok: true,
              value: staged,
              weak: mostlyRejected(staged.accepted.length, staged.rejected.length),
              quality: staged.accepted.length - staged.rejected.length,
            };
          },
        }),
        'contradiction_detection',
      );
      contradictions = [...value.accepted];
      rejections.push(...value.rejected);
    }

    // -- S6: unknowns ----------------------------------------------------------------------------------------------------
    {
      const { value } = required(
        await caller.call({
          stage: 'unknown_identification',
          role: 'extraction',
          input: commentaryInput,
          validate: (json, closed) => {
            const staged = validateUnknowns(json, commentaryWorld, closed, []);
            if (!staged.ok) return { ok: false, phase: 'shape', issues: staged.issues };
            return {
              ok: true,
              value: staged,
              weak: mostlyRejected(staged.accepted.length, staged.rejected.length),
              quality: staged.accepted.length - staged.rejected.length,
            };
          },
        }),
        'unknown_identification',
      );
      modelUnknowns.push(...value.accepted);
      rejections.push(...value.rejected);
    }
  }

  return {
    claims,
    statementItems,
    evidence,
    relations,
    contradictions,
    // code-authored `missing` unknowns: a gap the judge must see, never a deduction (design §10.4, invariant 4)
    unknowns: [...modelUnknowns, ...sourceGapUnknowns(statuses)],
    fidelity: resolved.dispositions,
    rejections,
    droppedRelations,
  };
}
