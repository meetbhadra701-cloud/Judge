import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  QUESTION_LIMITS,
  QuestionCandidatesOutput,
  type CandidateRejection,
  type Distinguishing,
  type Effort,
  type ExpectedInformation,
  type QuestionMode,
} from '@judge-copilot/schemas';
import type {
  ClosedSet,
  ClosedSetDimension,
  ClosedSetOpportunity,
  ClosedSetReference,
} from './closed-set.js';
import { handleType } from './closed-set.js';

/*
 * The SECOND validation gate for model-phrased candidates (invariants 19, 20, 25): the strict schema is the first, this is the domain gate. A candidate is
 * accepted whole or refused whole, with a stable reason code. Nothing is repaired, no id is guessed, and a refused question is never shown to a judge.
 *
 * What the gate is, and is not. The reference and shape rules are exact. The wording rules (accusation, presupposition, several questions in one) are
 * CONSERVATIVE HEURISTICS over text: they refuse what they recognize, they cannot prove a sentence harmless, and they are not a substitute for the judge
 * reading the question. They exist so that the obvious failures (an accusation, a question that treats a team statement as fact, three questions in one,
 * smuggled markup or an instruction) can never reach the ranking.
 */

export interface ValidatedCandidate {
  /** Code-assigned and reproducible: `cand-` + 16 hex of the mode, the normalized text and the sorted opportunity ids. */
  readonly key: string;
  readonly mode: QuestionMode;
  readonly text: string;
  readonly reason: string;
  readonly expectedInformation: readonly ExpectedInformation[];
  readonly opportunityIds: readonly string[];
  readonly dimensionIds: readonly string[];
  /** Real ids (never handles) of the claims / unknowns / evidence / contradictions / requirements the question draws on. */
  readonly references: readonly {
    readonly type: ClosedSetReference['type'];
    readonly id: string;
  }[];
  readonly distinguishes: Distinguishing;
  readonly effort: Effort;
  /** Position in the model's output (for a deterministic last tie-break and for audit). */
  readonly outputIndex: number;
}

export interface ValidationResult {
  /** False when the whole output failed the strict schema: then there are no candidates and `problem` says why (no text of the output is echoed). */
  readonly outputValid: boolean;
  readonly problem: string | null;
  readonly accepted: readonly ValidatedCandidate[];
  readonly rejected: readonly { readonly index: number; readonly code: CandidateRejection }[];
}

const normalizeText = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim();
const matchForm = (value: string): string =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const tokensOf = (value: string): Set<string> =>
  new Set(
    matchForm(value)
      .split(' ')
      .filter((token) => token.length >= 3),
  );

export function tokenJaccard(a: string, b: string): number {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.size === 0 && right.size === 0) return 1;
  let both = 0;
  for (const token of left) if (right.has(token)) both += 1;
  return both / (left.size + right.size - both);
}

/** Words that accuse. Deliberately broad: a refused neutral question costs a regeneration; an accepted accusation violates an invariant. */
const ACCUSATORY = new RegExp(
  [
    String.raw`\b(cheat\w*|fraud\w*|plagiari\w*|liar|lied|lying|dishonest\w*|deceiv\w*|decepti\w*|scam\w*|forg(?:e|ed|ery)|fabricat\w*|bogus|counterfeit)\b`,
    String.raw`\b(steal\w*|stole\w*|misrepresent\w*|misled|misleading)\b`,
    String.raw`\b(fake|faked|fakes)\b`,
    String.raw`\byou (?:didn'?t|did not|never|haven'?t|have not|couldn'?t|could not) (?:actually |really )?(?:build|built|write|wrote|make|made|implement(?:ed)?|create[d]?)\b`,
    String.raw`\b(?:not|isn'?t|wasn'?t) (?:really )?(?:your|yours|your own|original)\b`,
    String.raw`\b(?:copied|ripped|lifted) (?:this |that |it |the \w+ )?(?:from|off)\b`,
    String.raw`\b(?:admit|confess|come clean)\b`,
  ].join('|'),
  'iu',
);

/** Frames that treat what a team merely stated as established fact. */
const PRESUPPOSITION = new RegExp(
  [
    String.raw`\b(?:since|given that|because|now that|considering that|seeing that|as) you(?:'ve| have)? (?:already )?(?:built|implemented|developed|trained|deployed|created|integrated|designed|shipped|achieved)\b`,
    String.raw`\bhow did you (?:build|implement|develop|train|deploy|create|integrate|design|achieve)\b`,
    String.raw`\bwhy did you (?:build|implement|develop|train|deploy|create|integrate|design|choose to build)\b`,
    String.raw`\bwhat (?:challenges|problems|difficulties) did you (?:face|encounter|have) (?:when|while|in) (?:building|implementing|developing|training|deploying)\b`,
  ].join('|'),
  'iu',
);

/** Words that attribute a statement to the team's own materials, which makes quoting it a question about the statement, not an assertion of it. */
const ATTRIBUTION = new RegExp(
  [
    String.raw`\b(?:your|the) (?:submission|devpost(?: page)?|readme|repository|repo|project page|write-?up|materials?|description|documentation|video|demo|page)\b[^.?!]{0,60}\b(?:states?|stated|says?|said|claims?|claimed|describes?|described|mentions?|mentioned|lists?|listed|notes?|noted|asserts?|indicates?|suggests?|reads?|shows?)\b`,
    String.raw`\bas (?:stated|described|claimed|written|listed|noted) (?:in|on|by)\b`,
    String.raw`\byou (?:state|stated|say|said|claim|claimed|describe|described|mention|mentioned|wrote|write|listed|list|note|noted)\b`,
    String.raw`\baccording to (?:your|the)\b`,
  ].join('|'),
  'iu',
);

// The control characters are the point of this pattern: smuggled control text is refused.
/* eslint-disable no-control-regex */
const MARKUP_OR_LINK =
  /[<>`\u0000-\u0008\u000b\u000c\u000e-\u001f]|https?:\/\/|\bjavascript:|\]\(|\bdata:[a-z]+\/|\bsystem\s*:|\b(?:ignore|disregard|forget) (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions?|messages?|rules?)\b|\bas an ai\b|\bsystem prompt\b/iu;
/* eslint-enable no-control-regex */

const SEVERAL_QUESTIONS = [
  /\(\s*(?:1|a|i)\s*\)[\s\S]*\(\s*(?:2|b|ii)\s*\)/i,
  /\b(?:first(?:ly)?|1[.)])\b[\s\S]{3,}\b(?:second(?:ly)?|2[.)])\b/i,
  /\b(?:additionally|separately|on another note|unrelated|and another thing|another question|second question)\b[,:]?/i,
];

/** True when `text` reads as more than one question: several question marks, an enumeration, or an explicit change of topic. */
export function looksLikeSeveralQuestions(text: string): boolean {
  const marks = (text.match(/\?/g) ?? []).length;
  if (marks > 1) return true;
  const sentences = text.split(/(?<=[.?!])\s+/).filter((part) => part.trim().length > 0);
  if (sentences.length > 3) return true;
  return SEVERAL_QUESTIONS.some((pattern) => pattern.test(text));
}

function includesStatement(question: string, statement: string): boolean {
  const q = matchForm(question);
  const s = matchForm(statement);
  if (s.length < 12) return false;
  const needle = s.length > 60 ? s.slice(0, 60) : s; // the opening of a long claim is enough to recognize a quotation
  return q.includes(needle);
}

/** True when the text quotes a team statement and does not attribute it to the team's own materials in the sentence that quotes it. */
function assertsStatement(question: string, statements: readonly string[]): boolean {
  const sentences = normalizeText(question).split(/(?<=[.?!:])\s+/);
  const sentenceNeedsAttribution = (sentence: string): boolean =>
    statements.some((statement) => includesStatement(sentence, statement)) &&
    !ATTRIBUTION.test(sentence);
  // the attribution may open the previous clause of the same sentence ("Your README states: “…”. Can you ..."): look one sentence back
  return sentences.some((sentence, index) => {
    if (!sentenceNeedsAttribution(sentence)) return false;
    const previous = index > 0 ? sentences[index - 1] : undefined;
    return !(previous !== undefined && ATTRIBUTION.test(previous));
  });
}

export function validateCandidates(raw: unknown, closed: ClosedSet): ValidationResult {
  const parsed = QuestionCandidatesOutput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      outputValid: false,
      problem: `schema:${issue?.code ?? 'invalid'}:${issue?.path.slice(0, 3).map(String).join('.') ?? ''}`,
      accepted: [],
      rejected: [],
    };
  }
  const opportunityByHandle = new Map<string, ClosedSetOpportunity>(
    closed.opportunities.map((o) => [o.handle, o] as const),
  );
  const dimensionByHandle = new Map<string, ClosedSetDimension>(
    closed.dimensions.map((d) => [d.handle, d] as const),
  );
  const referenceByHandle = new Map<string, ClosedSetReference>(
    closed.references.map((r) => [r.handle, r] as const),
  );
  const referenceByKey = new Map(closed.references.map((r) => [`${r.type}:${r.id}`, r] as const));

  const accepted: ValidatedCandidate[] = [];
  const rejected: { index: number; code: CandidateRejection }[] = [];
  const perOpportunity = new Map<string, number>();

  parsed.data.candidates.forEach((candidate, index) => {
    const refuse = (code: CandidateRejection): false => {
      rejected.push({ index, code });
      return false;
    };

    // -- text and reason
    const text = normalizeText(candidate.text);
    const reason = normalizeText(candidate.reason);
    if (text.length === 0) return refuse('empty_question');
    if (reason.length === 0) return refuse('empty_reason');
    if (
      text.length > QUESTION_LIMITS.questionMaxChars ||
      reason.length > QUESTION_LIMITS.reasonMaxChars
    ) {
      return refuse('question_too_long');
    }

    // -- handles: opportunities, dimensions, references (a closed set; an unknown handle is refused, never guessed)
    const opportunityHandles = [...new Set(candidate.opportunities)];
    const opportunities: ClosedSetOpportunity[] = [];
    for (const handle of opportunityHandles) {
      const found = opportunityByHandle.get(handle);
      if (!found) return refuse('unknown_opportunity_handle');
      opportunities.push(found);
    }
    if (opportunities.length === 0) return refuse('no_opportunity');
    const opportunityDimensions = new Set(opportunities.flatMap((o) => o.opportunity.dimensionIds));
    const dimensions: ClosedSetDimension[] = [];
    for (const handle of [...new Set(candidate.dimensions)]) {
      const found = dimensionByHandle.get(handle);
      if (!found) return refuse('unknown_dimension_handle');
      if (!opportunityDimensions.has(found.id)) return refuse('dimension_outside_opportunities');
      dimensions.push(found);
    }
    const trail = new Set(
      opportunities.flatMap((o) => o.opportunity.trail.map((entry) => `${entry.type}:${entry.id}`)),
    );
    const references: ClosedSetReference[] = [];
    for (const handle of [...new Set(candidate.references)]) {
      if (handleType(handle) === null) return refuse('unknown_reference_handle');
      const found = referenceByHandle.get(handle);
      if (!found) return refuse('unknown_reference_handle');
      if (!trail.has(`${found.type}:${found.id}`)) return refuse('reference_outside_opportunities');
      references.push(found);
    }

    // -- wording (heuristics; see the header)
    if (MARKUP_OR_LINK.test(text) || MARKUP_OR_LINK.test(reason))
      return refuse('contains_markup_or_link');
    if (ACCUSATORY.test(text) || ACCUSATORY.test(reason)) return refuse('accusatory_wording');
    const statements = opportunities.flatMap((o) =>
      o.opportunity.trail.flatMap((entry) => {
        if (entry.type !== 'claim') return [];
        const claim = referenceByKey.get(`claim:${entry.id}`);
        return claim ? [claim.label] : [];
      }),
    );
    if (PRESUPPOSITION.test(text) || assertsStatement(text, statements))
      return refuse('presupposes_unverified_claim');
    if (looksLikeSeveralQuestions(text)) return refuse('not_a_single_question');

    // -- one opportunity cannot be flooded with variants of itself
    for (const { opportunity } of opportunities) {
      if ((perOpportunity.get(opportunity.id) ?? 0) >= QUESTION_LIMITS.perOpportunityMax) {
        return refuse('exceeds_per_opportunity_limit');
      }
    }
    // -- duplicates: the same words, or nearly (a candidate is compared with the ones already accepted)
    if (accepted.some((other) => tokenJaccard(other.text, text) >= 0.85))
      return refuse('duplicate_of_candidate');

    const opportunityIds = opportunities.map((o) => o.opportunity.id).sort();
    const dimensionIds =
      dimensions.length > 0
        ? dimensions.map((d) => d.id).sort()
        : [...opportunityDimensions].sort();
    for (const id of opportunityIds) perOpportunity.set(id, (perOpportunity.get(id) ?? 0) + 1);
    accepted.push({
      key: `cand-${sha256Hex(canonicalJson({ mode: candidate.mode, text: matchForm(text), opportunityIds })).slice(0, 16)}`,
      mode: candidate.mode,
      text,
      reason,
      expectedInformation: [...new Set(candidate.expectedInformation)],
      opportunityIds,
      dimensionIds,
      references: references.map(({ type, id }) => ({ type, id })),
      distinguishes: candidate.distinguishes,
      effort: candidate.effort,
      outputIndex: index,
    });
    return true;
  });
  return { outputValid: true, problem: null, accepted, rejected };
}
