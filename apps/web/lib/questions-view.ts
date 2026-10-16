import type {
  ExpectedInformation,
  QuestionMode,
  QuestionReferenceView,
  QuestionSetListResponse,
  QuestionSetView,
  UncertaintyKind,
  UncertaintySeverity,
} from '@judge-copilot/schemas';

/*
 * What the "Five Questions" section says, decided in one place and from the API's verified read model only. Nothing here computes a number, ranks a question
 * or changes a score: the order, the explanations and the links are exactly what the stored question set holds.
 */

export const MODE_LABELS: Readonly<Record<QuestionMode, string>> = {
  ask: 'Ask',
  clarify: 'Clarify',
  show_me: 'Show me',
  demonstrate: 'Demonstrate',
  verify: 'Verify',
};

export const MODE_HINTS: Readonly<Record<QuestionMode, string>> = {
  ask: 'a plain question',
  clarify: 'asks for the meaning of something unclear',
  show_me: 'asks the team to open or point to a specific thing',
  demonstrate: 'asks the team to show it working',
  verify: 'asks how a statement or figure can be checked',
};

export const EXPECTED_INFORMATION_LABELS: Readonly<Record<ExpectedInformation, string>> = {
  explanation: 'a spoken explanation',
  code_walkthrough: 'a walk-through of the code',
  live_demonstration: 'a live demonstration',
  link_or_document: 'a link or document',
  measurement: 'a measurement or figure',
};

export const REFERENCE_TYPE_LABELS: Readonly<Record<QuestionReferenceView['type'], string>> = {
  dimension: 'Rubric criterion',
  claim: 'Team claim',
  evidence: 'Evidence',
  unknown: 'Recorded gap',
  contradiction: 'Recorded inconsistency',
  requirement: 'Event requirement',
  coverage: 'Coverage',
  track: 'Track',
};

export const KIND_LABELS: Readonly<Record<UncertaintyKind, string>> = {
  dimension_not_assessed: 'Criterion without a score',
  dimension_rests_on_claims: 'Score rests on the team’s own statements',
  claim_unverified: 'Statement not yet corroborated',
  contradiction_recorded: 'Recorded inconsistency',
  unknown_recorded: 'Recorded gap',
  source_missing: 'Expected material not captured',
  coverage_partial: 'Part of the implementation not examined',
  requirement_unaddressed: 'Requirement not yet shown to be met',
  track_rubric_not_assessed: 'Track criteria not scored',
  thin_evidence: 'Small amount of evidence',
};

export const SEVERITY_LABELS: Readonly<Record<UncertaintySeverity, string>> = {
  critical: 'could change the picture most',
  high: 'could change the picture a lot',
  moderate: 'could change the picture somewhat',
  low: 'unlikely to change the picture much',
};

export type QuestionsPanelState =
  /** The assessment does not verify (or none exists): the section is not shown at all. */
  | { readonly kind: 'hidden' }
  /** The question service could not be reached or answered. */
  | { readonly kind: 'unavailable'; readonly message: string }
  /** No set yet, and generation is possible. */
  | { readonly kind: 'not_generated'; readonly canGenerate: true; readonly notice: string }
  /** No set yet, and generation is not possible here (no provider, voided project, stale version). */
  | { readonly kind: 'not_generated'; readonly canGenerate: false; readonly notice: string }
  /** A stored set exists but its assessment no longer verifies: nothing is shown. */
  | { readonly kind: 'withheld' }
  | { readonly kind: 'set'; readonly set: QuestionSetView };

export function questionsPanelState(input: {
  readonly verified: boolean;
  readonly list: QuestionSetListResponse | null;
  readonly set: QuestionSetView | null;
  readonly error?: string | undefined;
  readonly canGenerate: boolean;
}): QuestionsPanelState {
  if (!input.verified) return { kind: 'hidden' };
  if (input.error !== undefined) return { kind: 'unavailable', message: input.error };
  if (input.list === null) {
    return { kind: 'unavailable', message: 'The suggested questions could not be loaded.' };
  }
  if (input.set !== null) {
    return input.set.assessmentVerified ? { kind: 'set', set: input.set } : { kind: 'withheld' };
  }
  return input.canGenerate && input.list.launch.available
    ? { kind: 'not_generated', canGenerate: true, notice: input.list.launch.notice }
    : { kind: 'not_generated', canGenerate: false, notice: input.list.launch.notice };
}

/** "5 of 5", or "3 of 5 — fewer than five, and why". */
export function countLine(set: QuestionSetView): string {
  const n = set.questions.length;
  if (n === 5) return 'Five questions, most valuable first.';
  if (n === 0) return 'No questions were selected.';
  return `${String(n)} question${n === 1 ? '' : 's'} (fewer than five), most valuable first.`;
}

/** Percentage of the rubric a criterion carries, or null when the rubric publishes no weights. */
export function weightText(weightShare: number | null): string | null {
  return weightShare === null ? null : `${String(Math.round(weightShare * 100))}% of the rubric`;
}
