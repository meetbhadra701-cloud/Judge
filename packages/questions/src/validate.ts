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
    // M6-R2: words of guilt and blame, and the structure "<team> ... guilty of / accused of ...", which does not depend on any particular noun
    String.raw`\b(?:guilty|culpable|convicted|misconduct|wrongdoing)\b`,
    String.raw`\b(?:you|your team|the team|they|team members)\b[^.?!]{0,40}\b(?:accused of|suspected of|blamed for|charged with)\b`,
    String.raw`\b(fake|faked|fakes)\b`,
    String.raw`\byou (?:didn'?t|did not|never|haven'?t|have not|couldn'?t|could not) (?:actually |really )?(?:build|built|write|wrote|make|made|implement(?:ed)?|create[d]?)\b`,
    String.raw`\b(?:not|isn'?t|wasn'?t) (?:really )?(?:your|yours|your own|original)\b`,
    String.raw`\b(?:copied|ripped|lifted) (?:this |that |it |the \w+ )?(?:from|off)\b`,
    String.raw`\b(?:admit|confess|come clean)\b`,
    // M6-R1: an accusation of rule-breaking or concealment aimed at the team
    String.raw`\b(?:you|your team|the team) (?:violated|broke|bypassed|ignored|circumvented) (?:the |our |these |those )?(?:rules?|policy|policies|requirements?|terms)\b`,
    String.raw`\bhow did (?:you|your team) (?:get around|sneak|slip|hide|conceal)\b`,
    String.raw`\bwhy (?:did|do|would) (?:you|your team) (?:hide|conceal|cover up|lie)\b`,
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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_GAP = String.raw`[^\p{L}\p{N}]+`;

/**
 * An official title whose LAST substantive word is an accusatory word ("Fraud", "Payment Fraud", "Exam Cheating", "Fraud and Plagiarism") is never set aside.
 * The last word is the head of the noun phrase: such a title does not name a subject that merely mentions misconduct ("Fraud Prevention", "Plagiarism Detection",
 * "Fake News Detection" have the heads Prevention, Detection, News), it names the misconduct itself, and "Is your team behind Payment Fraud?" is the same
 * sentence whether or not a track is called Payment Fraud. Trailing punctuation, a trailing parenthetical qualifier, a bare number and grammatical filler
 * (and / of / the …) are ignored when looking for the last substantive word. A title that fails this test is merely ELIGIBLE for the neutral treatment below,
 * which still applies the position and doubt checks; eligibility is not proof that a sentence using the title is harmless.
 */
function endsInMisconductWord(title: string): boolean {
  const words = normalizeText(title)
    .replace(/\([^)]*\)\s*$/u, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) => word.length > 0 && !/^\d+$/u.test(word) && !TITLE_FILLER.has(word.toLowerCase()),
    );
  const last = words[words.length - 1];
  return last !== undefined && ACCUSATORY.test(last);
}
const TITLE_FILLER: ReadonlySet<string> = new Set([
  'and',
  'or',
  'of',
  'the',
  'a',
  'an',
  'for',
  'in',
  'on',
  'to',
  'vs',
]);

const TEAM_SUBJECT = String.raw`(?:you|your team|the team|your \w+ team|they|team members|the developers|the participants)`;
/** Immediately before a title: a verb or phrase that charges someone with it. A title right after one of these is the thing the team is accused of. */
const CHARGED_WITH_BEFORE = new RegExp(
  String.raw`\b(?:commit(?:ted|ting|s)?|guilty of|accused of|suspected of|convicted of|charged with|blamed for|perpetrat\w+)\s+(?:(?:any|some|the|a|an|such|your|their|its|this|that|more|actual|real|outright|deliberate|deliberately)\s+){0,3}$`,
  'iu',
);
/** The same, for verbs that are only an accusation when a person does them ("your team engaged in X"). */
const CHARGED_WITH_PERSON_BEFORE = new RegExp(
  String.raw`\b${TEAM_SUBJECT}\b[^.?!]{0,60}\b(?:engag(?:e|ed|es|ing) in|resort(?:ed|ing|s)? to|indulg(?:e|ed|es|ing) in|participat(?:e|ed|es|ing) in|take part in|took part in|taking part in)\s+(?:(?:any|some|the|a|an|such|more|actual|real|outright|deliberate)\s+){0,3}$`,
  'iu',
);
/** "Is your whole project <title>?": the title is what the project IS, which is a verdict on it, not a topic. */
const PROJECT_IS_BEFORE = new RegExp(
  String.raw`\b(?:is|are|was|were|be|been|being)\s+(?:your|the|this|that|our)\s+(?:(?:whole|entire|actual|own)\s+)*(?:project|entry|entries|submission|team|work|solution|app|application|product|demo|results?|code|repository|repo|idea|prototype)\s+(?:itself\s+)?(?:(?:just|actually|really|basically|simply|truly)\s+)*(?:an?\s+)?$`,
  'iu',
);
/** Doubt and implication in the sentence of a title: the title is then the object of a challenge, not the subject of a neutral question. */
const DOUBT_AROUND_TITLE = new RegExp(
  [
    String.raw`\b(?:really|actually|truly|genuinely|honestly|supposedly|allegedly|purportedly|so-called|yourselves|by yourselves|on your own|in fact|surely)\b`,
    String.raw`\bis it true that\b|\bisn'?t it true\b|\bbe honest\b|\btoo good to be true\b|\bhard to believe\b|\bexpect us to believe\b`,
    String.raw`\b(?:did|do|does|have|has) (?:you|your team|the team) (?:even|ever|really|actually)\b`,
  ].join('|'),
  'iu',
);

/**
 * WHO the sentence is about. A title names a SUBJECT; it is only safe to set it aside when the sentence is not about the team's conduct. The lexical test of a
 * title ("does it end in a misconduct word?") cannot tell "Fraud Prevention" from "Fake News" or "Fraud Cases" (an accusatory modifier on a neutral head,
 * which can name the misconduct itself), so the boundary is the sentence, not the title: when a person (you, the team, they, …) or the submission is referred
 * to in the same sentence, the title is set aside only if every such reference belongs to one of a few closed, structural forms of a neutral question
 * (a polite request to the team, the team's own materials or statements, the code-written "the team can point to it"). Any other reference to the team next to
 * the title leaves the title as written, so the accusatory word inside it is checked like any other. This is fail-closed: a neutral sentence with the team as
 * its subject ("Did your team implement Fraud Prevention?") is refused and has to be rephrased.
 */
const TEAM_REFERENCE = new RegExp(
  String.raw`\b(?:you|yours|yourself|yourselves|teams?|team members?|participants?|developers?|authors?|creators?|contestants?|entrants?)\b`,
  'iu',
);
const NEUTRAL_TEAM_FORMS = [
  // a polite request addressed to the team: "Can you …", "Could you …", "How would you …" (any verb: an accusation needs a SECOND reference to the team, which is not licensed)
  String.raw`\b(?:can|could|would|will|may|might|shall) you\b`,
  // the team's own materials and what they state
  String.raw`\b(?:the|this|that|your) team(?:'s|’s)? (?:materials?|readme|submission|devpost|description|documentation|claims?|statements?|page|write-?up|video|repository)\b`,
  String.raw`\b(?:the|your) team (?:states?|stated|says?|said|claims?|claimed|describes?|described|lists?|listed|mentions?|mentioned|reports?|reported|notes?|noted|writes?|wrote)\b`,
  String.raw`\b(?:a )?claim by the team\b`,
  // the code-written demonstration reasons: "the team can point to it", "the team can say more directly"
  String.raw`\bthe team (?:can|could|may|might) (?:point|say|show|explain|clarify|describe|demonstrate|provide|share|answer|tell)\b`,
].map((source) => new RegExp(source, 'giu'));

function titleInTeamSentence(sentence: string): boolean {
  let rest = sentence;
  for (const form of NEUTRAL_TEAM_FORMS) rest = rest.replace(form, ' ');
  return TEAM_REFERENCE.test(rest);
}

/** True when this occurrence of a title sits where an accusation, a verdict or a challenge would put it. Such an occurrence is NOT set aside. */
function titleInAccusingPosition(whole: string, start: number, end: number): boolean {
  const before = whole.slice(Math.max(0, start - 120), start);
  if (
    CHARGED_WITH_BEFORE.test(before) ||
    CHARGED_WITH_PERSON_BEFORE.test(before) ||
    PROJECT_IS_BEFORE.test(before)
  ) {
    return true;
  }
  const sentenceStart = Math.max(
    whole.lastIndexOf('.', start - 1),
    whole.lastIndexOf('?', start - 1),
    whole.lastIndexOf('!', start - 1),
    whole.lastIndexOf(':', start - 1),
  );
  const stops = ['.', '?', '!', ':'].map((mark) => whole.indexOf(mark, end)).filter((i) => i >= 0);
  const sentenceEnd = stops.length === 0 ? whole.length : Math.min(...stops);
  const sentence = whole.slice(sentenceStart + 1, sentenceEnd);
  return DOUBT_AROUND_TITLE.test(sentence) || titleInTeamSentence(sentence);
}

/**
 * WORDS THAT ARE NOT AN ACCUSATION (M6-R1, R9A P2-3; narrowed by M6-R2 after R9B P2 F1). The accusation filter is a conservative heuristic over text, and a legitimate
 * topic can contain an accusatory WORD: a track called “Fraud Prevention”, a criterion “Fake News Detection”. Deleting the filter would be wrong; so before it runs,
 * exactly two kinds of text may be set aside, and only text that comes from the FROZEN, VERIFIED analysis, never from what a candidate says about itself:
 *
 *   1. an official TITLE (a rubric criterion the cited uncertainties bear on, or a declared track they cite; whole words, any case), and ONLY when
 *        - the title does not END in an accusatory word (a track called “Fraud” or “Payment Fraud” establishes a subject, never that the team committed fraud), and
 *        - this occurrence is in a neutral position: not right after “commit / guilty of / accused of / engaged in …”, not the predicate of “is your project …”, and
 *          not in a sentence that doubts or challenges (“really”, “actually”, “isn't it true”, …). An occurrence in any of those positions stays as written, so the
 *          accusatory word inside it is checked like any other;
 *   2. the team's OWN WORDS, in a sentence that attributes them to the team's materials ("Your README states that ..."): a run of at least three consecutive words
 *      that also occurs, in the same order, in a cited team claim. The rest of that sentence, and every other sentence, is checked as usual.
 *
 * Everything else keeps being checked, including the rest of the same sentence: "Why did your team fake the results?" is refused even beside “Fraud Prevention”.
 * This reduces false refusals; it cannot prove a sentence harmless, and a refused neutral question costs a regeneration while an accepted accusation violates an invariant.
 */
export function withoutNeutralWords(
  text: string,
  officialTitles: readonly string[],
  teamStatements: readonly string[],
): string {
  let masked = normalizeText(text);
  for (const title of officialTitles) {
    const trimmed = normalizeText(title);
    if (trimmed.length < 3 || endsInMisconductWord(trimmed)) continue;
    const words = trimmed.split(' ').map(escapeRegExp).join(WORD_GAP);
    masked = masked.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'giu'),
      (match: string, offset: number, whole: string) =>
        titleInAccusingPosition(whole, offset, offset + match.length) ? match : ' OFFICIALTITLE ',
    );
  }
  const sentences = masked.split(/(?<=[.?!:])\s+/);
  return sentences
    .map((sentence, index) => {
      const previous = index > 0 ? sentences[index - 1] : undefined;
      const attributed =
        ATTRIBUTION.test(sentence) || (previous !== undefined && ATTRIBUTION.test(previous));
      if (!attributed) return sentence;
      let result = sentence;
      for (const statement of teamStatements) {
        const claimWords = matchForm(statement).split(' ').filter(Boolean);
        const sentenceWords = matchForm(result).split(' ').filter(Boolean);
        for (let start = 0; start + 3 <= sentenceWords.length; start += 1) {
          let length = 0;
          while (
            start + length < sentenceWords.length &&
            containsRun(claimWords, sentenceWords.slice(start, start + length + 1))
          ) {
            length += 1;
          }
          if (length >= 3) {
            const run = sentenceWords
              .slice(start, start + length)
              .map(escapeRegExp)
              .join(WORD_GAP);
            result = result.replace(new RegExp(run, 'giu'), ' TEAMWORDS ');
            break;
          }
        }
      }
      return result;
    })
    .join(' ');
}

function containsRun(haystack: readonly string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= haystack.length; i += 1) {
    if (run.every((word, offset) => haystack[i + offset] === word)) return true;
  }
  return false;
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
    const statements = opportunities.flatMap((o) =>
      o.opportunity.trail.flatMap((entry) => {
        if (entry.type !== 'claim') return [];
        const claim = referenceByKey.get(`claim:${entry.id}`);
        return claim ? [claim.label] : [];
      }),
    );
    // official titles come from the closed set (the verified analysis): the criteria the cited uncertainties bear on, and the tracks they cite
    const titles = [
      ...dimensions.map((d) => d.name),
      ...[...opportunityDimensions].flatMap((id) => {
        const found = closed.dimensions.find((d) => d.id === id);
        return found ? [found.name] : [];
      }),
      ...opportunities.flatMap((o) =>
        o.opportunity.trail.flatMap((entry) => {
          if (entry.type !== 'track') return [];
          const track = referenceByKey.get(`track:${entry.id}`);
          return track ? [track.label] : [];
        }),
      ),
    ];
    if (
      ACCUSATORY.test(withoutNeutralWords(text, titles, statements)) ||
      ACCUSATORY.test(withoutNeutralWords(reason, titles, statements))
    ) {
      return refuse('accusatory_wording');
    }
    if (PRESUPPOSITION.test(text) || assertsStatement(text, statements))
      return refuse('presupposes_unverified_claim');
    if (looksLikeSeveralQuestions(text)) return refuse('not_a_single_question');

    // -- one opportunity cannot be flooded with variants of itself
    for (const { opportunity } of opportunities) {
      if ((perOpportunity.get(opportunity.id) ?? 0) >= QUESTION_LIMITS.perOpportunityMax) {
        return refuse('exceeds_per_opportunity_limit');
      }
    }
    // -- duplicates: the same words, or nearly (a candidate is compared with the ones already accepted). Alike wording about the SAME uncertainty is a
    //    duplicate; alike wording about different uncertainties is two questions (templated phrasing around a different criterion name), unless it is identical.
    const opportunityIdsOfThis = opportunities.map((o) => o.opportunity.id);
    if (
      accepted.some((other) => {
        const similarity = tokenJaccard(other.text, text);
        return (
          similarity >= 0.95 ||
          (similarity >= 0.85 &&
            other.opportunityIds.some((id) => opportunityIdsOfThis.includes(id)))
        );
      })
    ) {
      return refuse('duplicate_of_candidate');
    }

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
