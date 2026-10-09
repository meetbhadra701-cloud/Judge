/*
 * Neutral-language screen (invariant 25: no automatic cheating accusations; design §11). Model-written COMMENTARY about a project
 * (a contradiction description, an unknown, a critic note) must describe an inconsistency neutrally. A match rejects the item.
 *
 * This is a HEURISTIC BACKSTOP, not a classifier: the primary control is the prompt and the closed schema. It cannot catch every
 * phrasing (a paraphrase such as "the work is not their own" evades it), and it can reject innocent wording such as "fraud
 * detection". It is applied only to model commentary, never to the team's own quoted words. The documented evasion corpus is in
 * neutral.test.ts so the limit is on record.
 */

const ACCUSATION_STEMS = [
  'cheat',
  'fraud',
  'plagiar',
  'fake',
  'liar',
  'lying',
  'lied',
  'dishonest',
  'disqualif',
  'deceiv',
  'deceit',
  'decepti',
  'scam',
  'forg(?:ed|ery)',
  'swindl',
  'counterfeit',
  'stole',
  'stolen',
  'steal',
  'misrepresent',
  'fabricat',
] as const;

// "lie" / "lies" as whole words only (so "believe", "relies" and "client" are untouched).
const ACCUSATION_PATTERN = new RegExp(
  `(?:\\b(?:${ACCUSATION_STEMS.join('|')})|\\b(?:lie|lies)\\b)`,
  'iu',
);

/** True when the text contains accusation vocabulary. */
export function containsAccusation(text: string): boolean {
  return ACCUSATION_PATTERN.test(text.normalize('NFKC'));
}
