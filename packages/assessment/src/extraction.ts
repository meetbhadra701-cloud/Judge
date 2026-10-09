import {
  EVIDENCE_GRAPH_LIMITS,
  isStorableGraphText,
  normalizeClaimText,
  normalizeGraphText,
  type ClaimExtractionOutput,
  type EvidenceInterpretationOutput,
  type FidelityReviewOutput,
  type FidelityVerdict,
} from '@judge-copilot/schemas';
import { shownHandles, type ClosedSet } from './closed-set.js';
import { claimHandle, evidenceHandle, handleNumber } from './handles.js';
import { issue, type DomainIssue, type Rejection } from './issues.js';
import { locateQuote, type LocatedQuote } from './quote.js';
import type { RoutedSourceType } from './routing.js';
import { codePointCount } from './text.js';
import type { Passage } from './windowing.js';

/*
 * Gates G1 (claims), G2 (interpreted evidence) and G2b (fidelity), design §4.5-§4.6.
 *
 * They run AFTER the strict Zod schema of the stage has passed (see `validateStageOutput` in stage.ts). They reject, never repair:
 * an item whose handle, passage route or quote does not check out is dropped and counted, and the rest of the answer stands. No
 * model-supplied ID, offset, excerpt, origin, level or kind is read: those fields do not exist in the schemas, and what code needs
 * (snapshot, artifact, span, excerpt, origin) is derived from the passage the handle names and the quote it locates.
 */

export type PassageIndex = ReadonlyMap<string, Passage>;

export function indexPassages(passages: readonly Passage[]): PassageIndex {
  return new Map(passages.map((passage) => [passage.handle, passage]));
}

export type Grounding = 'exact_text' | 'paraphrase_reviewed_faithful' | 'pending_review';

export interface AdmittedClaim {
  readonly handle: string;
  /** The model's local name, used only to detect a repeated ref inside one answer. */
  readonly modelRef: string;
  /** One line, NFC (Zod `ClaimText`). A paraphrase until fidelity review says otherwise. */
  readonly text: string;
  readonly sourceType: RoutedSourceType;
  readonly located: LocatedQuote;
  readonly grounding: Grounding;
}

export interface AdmittedEvidence {
  readonly handle: string;
  readonly modelRef: string;
  readonly text: string;
  readonly sourceType: RoutedSourceType;
  readonly artifactClass: Passage['artifactClass'];
  readonly located: LocatedQuote;
  readonly grounding: Grounding;
}

export interface GateOutcome<T> {
  readonly accepted: readonly T[];
  readonly rejected: readonly Rejection[];
}

export const MAX_CLAIMS_PER_RUN = 80;
export const MAX_EVIDENCE_PER_RUN = 100;

export interface ClaimGateState {
  /** Claims admitted by earlier calls of the same extraction. */
  readonly existing: readonly AdmittedClaim[];
  readonly maxClaims?: number;
}

const claimKey = (c: Pick<AdmittedClaim, 'located' | 'text'>): string =>
  `${c.located.artifactId}\u0000${String(c.located.start)}\u0000${String(c.located.end)}\u0000${c.text}`;

/** G1. */
export function gateClaims(
  output: ClaimExtractionOutput,
  passages: PassageIndex,
  shown: Pick<ClosedSet, 'passages'>,
  state: ClaimGateState = { existing: [] },
): GateOutcome<AdmittedClaim> {
  const shownPassages = shownHandles(shown, 'passages');
  const accepted: AdmittedClaim[] = [];
  const rejected: Rejection[] = [];
  const max = state.maxClaims ?? MAX_CLAIMS_PER_RUN;
  const seenKeys = new Set(state.existing.map(claimKey));
  const seenRefs = new Set<string>();
  let counter = state.existing.reduce(
    (highest, claim) => Math.max(highest, handleNumber(claim.handle)),
    0,
  );

  output.claims.forEach((item, index) => {
    const verdict = ((): AdmittedClaim | string => {
      if (seenRefs.has(item.ref)) return 'duplicate_ref';
      seenRefs.add(item.ref);
      const passage = passages.get(item.passage);
      if (!passage) return 'unknown_passage';
      // a real passage of this extraction that THIS call did not show is not an authorized reference
      if (!shownPassages.has(item.passage)) return 'passage_not_shown';
      if (passage.route !== 'statement') return 'passage_not_statement';
      if (state.existing.length + accepted.length >= max) return 'over_cap';
      const located = locateQuote(passage, item.quote);
      if (!located.ok) return located.code;
      const candidate = { located: located.located, text: item.text };
      if (seenKeys.has(claimKey(candidate))) return 'duplicate_claim';
      seenKeys.add(claimKey(candidate));
      counter += 1;
      return {
        handle: claimHandle(counter),
        modelRef: item.ref,
        text: item.text,
        sourceType: passage.sourceType,
        located: located.located,
        grounding: normalizeClaimText(item.quote) === item.text ? 'exact_text' : 'pending_review',
      };
    })();
    if (typeof verdict === 'string') {
      rejected.push({ gate: 'G1', code: verdict, index, handle: item.passage });
    } else {
      accepted.push(verdict);
    }
  });
  return { accepted, rejected };
}

export interface EvidenceGateState {
  readonly existing: readonly AdmittedEvidence[];
  readonly maxEvidence?: number;
}

const evidenceKey = (e: Pick<AdmittedEvidence, 'located' | 'text'>): string =>
  `${e.located.artifactId}\u0000${String(e.located.start)}\u0000${String(e.located.end)}\u0000${e.text}`;

/** G2. */
export function gateEvidence(
  output: EvidenceInterpretationOutput,
  passages: PassageIndex,
  shown: Pick<ClosedSet, 'passages'>,
  state: EvidenceGateState = { existing: [] },
): GateOutcome<AdmittedEvidence> {
  const shownPassages = shownHandles(shown, 'passages');
  const accepted: AdmittedEvidence[] = [];
  const rejected: Rejection[] = [];
  const max = state.maxEvidence ?? MAX_EVIDENCE_PER_RUN;
  const seenKeys = new Set(state.existing.map(evidenceKey));
  const seenRefs = new Set<string>();
  let counter = state.existing.reduce(
    (highest, item) => Math.max(highest, handleNumber(item.handle)),
    0,
  );

  output.evidence.forEach((item, index) => {
    const verdict = ((): AdmittedEvidence | string => {
      if (seenRefs.has(item.ref)) return 'duplicate_ref';
      seenRefs.add(item.ref);
      const passage = passages.get(item.passage);
      if (!passage) return 'unknown_passage';
      if (!shownPassages.has(item.passage)) return 'passage_not_shown';
      if (passage.route !== 'interpret') return 'passage_not_repository';
      if (state.existing.length + accepted.length >= max) return 'over_cap';
      const located = locateQuote(passage, item.quote);
      if (!located.ok) return located.code;
      const candidate = { located: located.located, text: item.text };
      if (seenKeys.has(evidenceKey(candidate))) return 'duplicate_evidence';
      seenKeys.add(evidenceKey(candidate));
      counter += 1;
      return {
        handle: evidenceHandle(counter),
        modelRef: item.ref,
        text: item.text,
        sourceType: passage.sourceType,
        artifactClass: passage.artifactClass,
        located: located.located,
        grounding: normalizeGraphText(item.quote) === item.text ? 'exact_text' : 'pending_review',
      };
    })();
    if (typeof verdict === 'string') {
      rejected.push({ gate: 'G2', code: verdict, index, handle: item.passage });
    } else {
      accepted.push(verdict);
    }
  });
  return { accepted, rejected };
}

// -- G2b: fidelity of paraphrases ---------------------------------------------------------------------------------------

export interface PendingReview {
  readonly handle: string;
  readonly kind: 'claim' | 'evidence';
  readonly assertion: string;
  readonly quote: string;
}

/** The items that need an independent fidelity review: paraphrases only. Verbatim items need no call. */
export function pendingReviews(
  claims: readonly AdmittedClaim[],
  evidence: readonly AdmittedEvidence[],
): PendingReview[] {
  return [
    ...claims
      .filter((claim) => claim.grounding === 'pending_review')
      .map((claim) => ({
        handle: claim.handle,
        kind: 'claim' as const,
        assertion: claim.text,
        quote: claim.located.excerpt,
      })),
    ...evidence
      .filter((item) => item.grounding === 'pending_review')
      .map((item) => ({
        handle: item.handle,
        kind: 'evidence' as const,
        assertion: item.text,
        quote: item.located.excerpt,
      })),
  ];
}

export const FIDELITY_DISPOSITION_VALUES = [
  'exact_text',
  'paraphrase_reviewed_faithful',
  'paraphrase_replaced_by_verbatim',
  'claim_dropped_unfaithful',
  'evidence_text_replaced_by_verbatim',
  'evidence_dropped_unfaithful',
] as const;
export type FidelityDisposition = (typeof FIDELITY_DISPOSITION_VALUES)[number];

export interface FidelityResolution {
  /** Claims that remain, with their final text and a settled grounding. */
  readonly claims: readonly AdmittedClaim[];
  readonly evidence: readonly AdmittedEvidence[];
  /** One entry per reviewed item (including dropped ones), in item order. */
  readonly dispositions: readonly {
    readonly handle: string;
    readonly disposition: FidelityDisposition;
  }[];
  /** Protocol violations in the reviewer's answer (unknown or duplicate items, missing verdicts). Items are never admitted because of them. */
  readonly issues: readonly DomainIssue[];
}

/** One fidelity-review CALL: the items its prompt showed (the batch) and the verdicts that survived its gate. */
export interface FidelityCall {
  readonly shown: readonly string[];
  readonly verdicts: readonly { readonly item: string; readonly verdict: FidelityVerdict }[];
}

export interface FidelityCallResult {
  readonly call: FidelityCall;
  readonly issues: readonly DomainIssue[];
}

/**
 * G2b for ONE call (a batch of at most ten items). A verdict counts only for an item that is both pending review AND shown in THIS
 * call: a verdict about a real pending item of another batch is `item_not_shown`, about an item that is not pending at all
 * `unknown_item`; a repeated verdict voids that item's verdicts in this call. An item shown but not answered is `missing_verdict`.
 */
export function gateFidelityCall(
  output: FidelityReviewOutput,
  shown: Pick<ClosedSet, 'items'>,
  pending: readonly PendingReview[],
): FidelityCallResult {
  const shownItems = shownHandles(shown, 'items');
  const pendingHandles = new Set(pending.map((entry) => entry.handle));
  const issues: DomainIssue[] = [];
  const byHandle = new Map<string, FidelityVerdict[]>();
  output.verdicts.forEach((entry, index) => {
    const path = `verdicts[${String(index)}].item`;
    if (!pendingHandles.has(entry.item)) {
      issues.push(issue('G2b', 'unknown_item', path, entry.item));
    } else if (!shownItems.has(entry.item)) {
      issues.push(issue('G2b', 'item_not_shown', path, entry.item));
    } else {
      const list = byHandle.get(entry.item);
      if (list) list.push(entry.verdict);
      else byHandle.set(entry.item, [entry.verdict]);
    }
  });
  const verdicts: { item: string; verdict: FidelityVerdict }[] = [];
  for (const handle of shownItems) {
    const list = byHandle.get(handle);
    if (!list) {
      if (pendingHandles.has(handle))
        issues.push(issue('G2b', 'missing_verdict', 'verdicts', handle));
    } else if (list.length > 1) {
      issues.push(issue('G2b', 'duplicate_verdict', 'verdicts', handle));
    } else if (list[0] !== undefined) {
      verdicts.push({ item: handle, verdict: list[0] });
    }
  }
  return { call: { shown: [...shownItems], verdicts }, issues };
}

/**
 * G2b over all calls of the extraction. A paraphrase is admitted ONLY with exactly one `faithful` verdict from a call that SHOWED
 * it. Everything else (overstated, unfaithful, cannot_tell, never shown, unanswered, duplicated) takes the downgrade path: the
 * verbatim quote replaces the text, or the item is dropped if the quote cannot stand as that text. Nothing is ever admitted
 * unreviewed, a verdict is re-checked against its own call's shown set (so a forged `FidelityCall` gains nothing), and an
 * unfaithful paraphrase can never become stronger evidence.
 */
export function resolveFidelity(
  claims: readonly AdmittedClaim[],
  evidence: readonly AdmittedEvidence[],
  calls: readonly FidelityCall[],
): FidelityResolution {
  const pending = pendingReviews(claims, evidence);
  const pendingHandles = new Set(pending.map((entry) => entry.handle));
  const issues: DomainIssue[] = [];
  const byHandle = new Map<string, FidelityVerdict[]>();
  const everShown = new Set<string>();
  calls.forEach((call, callIndex) => {
    const shownItems = new Set(call.shown);
    for (const handle of shownItems) everShown.add(handle);
    call.verdicts.forEach((entry, index) => {
      const path = `calls[${String(callIndex)}].verdicts[${String(index)}].item`;
      if (!pendingHandles.has(entry.item)) {
        issues.push(issue('G2b', 'unknown_item', path, entry.item));
      } else if (!shownItems.has(entry.item)) {
        issues.push(issue('G2b', 'item_not_shown', path, entry.item));
      } else {
        const list = byHandle.get(entry.item);
        if (list) list.push(entry.verdict);
        else byHandle.set(entry.item, [entry.verdict]);
      }
    });
  });
  const verdictFor = (handle: string): FidelityVerdict | null => {
    const list = byHandle.get(handle);
    if (!list) {
      issues.push(
        issue(
          'G2b',
          everShown.has(handle) ? 'missing_verdict' : 'never_reviewed',
          'verdicts',
          handle,
        ),
      );
      return null;
    }
    if (list.length > 1) {
      issues.push(issue('G2b', 'duplicate_verdict', 'verdicts', handle));
      return null;
    }
    return list[0] ?? null;
  };

  const dispositions: { handle: string; disposition: FidelityDisposition }[] = [];
  const keptClaims: AdmittedClaim[] = [];
  for (const claim of claims) {
    if (claim.grounding !== 'pending_review') {
      keptClaims.push(claim);
      continue;
    }
    if (verdictFor(claim.handle) === 'faithful') {
      keptClaims.push({ ...claim, grounding: 'paraphrase_reviewed_faithful' });
      dispositions.push({ handle: claim.handle, disposition: 'paraphrase_reviewed_faithful' });
      continue;
    }
    const verbatim = normalizeClaimText(claim.located.excerpt);
    if (
      verbatim.length > 0 &&
      codePointCount(verbatim) <= EVIDENCE_GRAPH_LIMITS.claimTextMaxChars &&
      isStorableGraphText(verbatim)
    ) {
      keptClaims.push({ ...claim, text: verbatim, grounding: 'exact_text' });
      dispositions.push({ handle: claim.handle, disposition: 'paraphrase_replaced_by_verbatim' });
    } else {
      dispositions.push({ handle: claim.handle, disposition: 'claim_dropped_unfaithful' });
    }
  }
  const keptEvidence: AdmittedEvidence[] = [];
  for (const item of evidence) {
    if (item.grounding !== 'pending_review') {
      keptEvidence.push(item);
      continue;
    }
    if (verdictFor(item.handle) === 'faithful') {
      keptEvidence.push({ ...item, grounding: 'paraphrase_reviewed_faithful' });
      dispositions.push({ handle: item.handle, disposition: 'paraphrase_reviewed_faithful' });
      continue;
    }
    const verbatim = normalizeGraphText(item.located.excerpt);
    if (
      verbatim.length > 0 &&
      codePointCount(verbatim) <= EVIDENCE_GRAPH_LIMITS.evidenceTextMaxChars &&
      isStorableGraphText(verbatim)
    ) {
      keptEvidence.push({ ...item, text: verbatim, grounding: 'exact_text' });
      dispositions.push({ handle: item.handle, disposition: 'evidence_text_replaced_by_verbatim' });
    } else {
      dispositions.push({ handle: item.handle, disposition: 'evidence_dropped_unfaithful' });
    }
  }
  return { claims: keptClaims, evidence: keptEvidence, dispositions, issues };
}
