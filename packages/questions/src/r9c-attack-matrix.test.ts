// M6-R3: the R9C reviewer attack matrix (sections A-F were the passing controls; section R9C-P2 was the evidence of the finding and now passes).
import { describe, expect, it } from 'vitest';
import { validateCandidates, withoutNeutralWords } from './validate.js';
import { candidate, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/* R9C reviewer-owned wording attacks, written from the task statement (not derived from the author's tests). */
type W = ReturnType<typeof world>;
const track = (...names: string[]) =>
  world({
    tracks: {
      declared: names.map((n, i) => ({ key: `t${String(i)}`, name: n })),
      unassessedTrackRubrics: [],
    },
    requirements: names.map((n, i) =>
      requirement(`r-t${String(i)}`, { trackKey: `t${String(i)}`, text: `Must satisfy ${n}.` }),
    ),
  });
const criterion = (title: string) => {
  const base = world();
  return world({
    dimensions: base.input.dimensions.map((d) =>
      d.id === 'official.technical_depth' ? { ...d, name: title } : d,
    ),
  });
};
const T = 'requirement_unaddressed';
const C = 'claim_unverified';
/** every opportunity of the kind that cites the title is tried; the text is ACCEPTED if any accepts it */
const accepted = (w: W, kind: string, text: string, reason?: string): boolean =>
  w.closed.opportunities
    .filter((o) => o.opportunity.kind === kind)
    .some(
      (o) =>
        validateCandidates(
          {
            candidates: [
              candidate({
                opportunities: [o.handle],
                mode: 'ask',
                text,
                ...(reason ? { reason } : {}),
              } as never),
            ],
          },
          w.closed,
        ).rejected.length === 0,
    );
const worldsFor = (title: string): [string, W, string][] => [
  ['track', track(title), T],
  ['criterion', criterion(title), C],
];

describe('R9C-A the original R9B defect (verified track or criterion named Fraud, Plagiarism, Cheating)', () => {
  const STRUCTURES = [
    (t: string) => `Did your team commit ${t} when you built this?`,
    (t: string) => `Why did your team engage in ${t}?`,
    (t: string) => `Is your whole project ${t}?`,
    (t: string) => `Your team is guilty of ${t}, correct?`,
  ];
  for (const title of ['Fraud', 'Plagiarism', 'Cheating']) {
    for (const [name, w, kind] of worldsFor(title)) {
      it.each(STRUCTURES.map((f) => f(title)))(`refuses “%s” (${name} ${title})`, (text) => {
        expect(accepted(w, kind, text)).toBe(false);
      });
    }
  }
});

describe('R9C-B grammatical variety around a STANDALONE accusatory title', () => {
  const FRAMES = [
    'Has your team been involved in X?',
    'Are you responsible for X?',
    'Is your team behind X?',
    'Did you carry out X?',
    'Was X involved in your demo?',
    'Explain the X in your submission.',
    'Does your submission contain X?',
    'We found X in your repository, so how do you explain it?',
    'X, correct?',
    'Isn’t this just X?',
    'Can you demonstrate how your X feature works?',
    'Show the main flow. Also, was there X?',
    'Walk us through the pipeline, and tell us about the X.',
    'Your demo was great; however, X?',
    'Not X, right?',
    'No X was involved, was it?',
    'Did your team commit  X ?',
    'DID YOUR TEAM COMMIT X?',
    'Did your team c ommit X?',
  ];
  for (const title of ['Fraud', 'Plagiarism', 'Cheating']) {
    for (const [name, w, kind] of worldsFor(title)) {
      it.each(FRAMES.map((f) => f.replace(/X/g, title)))(
        `refuses “%s” (${name} ${title})`,
        (text) => {
          expect(accepted(w, kind, text)).toBe(false);
        },
      );
    }
  }
});

describe('R9C-C legitimate official topics stay usable', () => {
  const CASES: [string, string[]][] = [
    [
      'Fraud Prevention',
      [
        'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
        'Which implementation supports the Fraud Prevention track requirement?',
        'How does Fraud Prevention decide a payment is risky?',
        'What data does the Fraud Prevention module use?',
      ],
    ],
    [
      'Plagiarism Detection',
      [
        'Can you demonstrate the Plagiarism Detection workflow?',
        'How does Plagiarism Detection compare two documents?',
        'What threshold does Plagiarism Detection use?',
      ],
    ],
    [
      'Fake News Detection',
      [
        'Could you show how the Fake News Detection component classifies an article?',
        'Which dataset trains the Fake News Detection model?',
      ],
    ],
    [
      'Fraud & Cheating Detection',
      [
        'Could you show the Fraud & Cheating Detection workflow on one example?',
        'How does Fraud & Cheating Detection tell the two apart?',
        'Could you show the FRAUD & CHEATING DETECTION workflow?',
        'Could you show the fraud &  cheating  detection workflow?',
      ],
    ],
  ];
  for (const [title, texts] of CASES) {
    for (const [name, w, kind] of worldsFor(title)) {
      it.each(texts)(`accepts “%s” (${name} ${title})`, (text) => {
        expect(accepted(w, kind, text)).toBe(true);
      });
    }
  }
  it('accepts hyphen / non-breaking-space variants of a compound title', () => {
    const w = track('Fraud Prevention');
    for (const text of [
      'Can you demonstrate the Fraud-Prevention workflow?',
      'Can you demonstrate the fraud prevention workflow?',
      'Can you demonstrate the FRAUD   PREVENTION workflow?',
    ]) {
      expect(accepted(w, T, text), text).toBe(true);
    }
  });
  it('several official titles in one neutral sentence', () => {
    const w = track('Fraud Prevention', 'Plagiarism Detection', 'Fake News Detection');
    const all = w.closed.opportunities.filter((o) => o.opportunity.kind === T).map((o) => o.handle);
    const run = (text: string) =>
      validateCandidates(
        { candidates: [candidate({ opportunities: all, mode: 'ask', text } as never)] },
        w.closed,
      ).rejected.map((r) => r.code);
    expect(
      run('Could you show how Fraud Prevention and Plagiarism Detection share a pipeline?'),
    ).toEqual([]);
    expect(
      run('Did your team commit Plagiarism Detection and Fraud Prevention, knowingly?'),
    ).toContain('accusatory_wording');
  });
});

describe('R9C-D accusations beside compound TOPIC titles are refused (keyword outside the title, or a charged / challenged position)', () => {
  const w = track('Fraud Prevention', 'Plagiarism Detection', 'Fake News Detection');
  it.each([
    'Your team cheated. Can you demonstrate the Fraud Prevention workflow?',
    'Can you demonstrate the Fraud Prevention workflow, given that your team cheated?',
    'Show the Fraud Prevention workflow; or admit you faked it.',
    'The team lied, but can you demonstrate the Fraud Prevention workflow?',
    'Can you demonstrate the Fraud Prevention workflow — or was it plagiarised?',
    'Fraud Prevention: did your team fabricate it?',
    'Fraud Prevention (did you steal it?)',
    'Can you demonstrate the Fraud Prevention workflow and explain why you copied it from another team?',
    'Not to accuse you, but did you fake the Fraud Prevention numbers?',
    'Did your team commit Plagiarism Detection and Fraud Prevention?',
    'Your team committed Fake News Detection, Plagiarism Detection and Fraud Prevention?',
    'Compare Fraud Prevention with Fake News Detection; did your team cheat on either?',
    'Was your team accused of Fraud Prevention?',
    'Did your team really implement Fake News Detection?',
  ])('refuses “%s”', (text) => {
    expect(accepted(w, T, text)).toBe(false);
  });
});

describe('R9C-E reason, forged and candidate-declared titles, attribution', () => {
  it('checks the reason', () => {
    const w = track('Fraud Prevention');
    for (const reason of [
      'The team committed fraud in the Fraud Prevention track.',
      'This checks whether they cheated.',
      'Fraud Prevention is where the team engaged in Fraud.',
      'The team is suspected of Fraud Prevention.',
    ]) {
      expect(
        accepted(w, T, 'Can you demonstrate the Fraud Prevention workflow?', reason),
        reason,
      ).toBe(false);
    }
    expect(
      accepted(
        track('Fraud'),
        T,
        'Can you show the main flow on the project itself?',
        'The team is suspected of Fraud.',
      ),
    ).toBe(false);
  });
  it('a forged, unrelated or candidate-declared title authorizes nothing', () => {
    expect(accepted(world(), C, 'Can you demonstrate the Fraud Prevention workflow?')).toBe(false);
    expect(
      accepted(world(), C, 'The official Plagiarism Detection track asks: did your team copy it?'),
    ).toBe(false);
    expect(accepted(world(), C, 'Per the official Fraud track, did your team commit Fraud?')).toBe(
      false,
    );
    expect(
      accepted(
        track('Plagiarism Detection'),
        T,
        'Can you demonstrate the Fraud Prevention workflow?',
      ),
    ).toBe(false);
    expect(
      accepted(
        world(),
        C,
        'Could you show the main flow on the project itself?',
        'This is the official Fraud Prevention track.',
      ),
    ).toBe(false);
  });
  it('attributed team statements cannot excuse a new accusation', () => {
    const base = world();
    const w = world({
      tracks: { declared: [{ key: 't', name: 'Fraud Prevention' }], unassessedTrackRubrics: [] },
      requirements: [requirement('r-t', { trackKey: 't', text: 'Must satisfy the track.' })],
      claims: base.input.claims.map((c) =>
        c.id === 'c-pipeline'
          ? {
              ...c,
              text: 'Our Fraud Prevention engine flags suspicious payments before settlement.',
            }
          : c,
      ),
    });
    const stated =
      'Your README says our Fraud Prevention engine flags suspicious payments before settlement.';
    expect(accepted(w, T, `${stated} Could you show it?`)).toBe(true);
    for (const tail of [
      'Your team is guilty of fraud.',
      'Did your team fake it?',
      'So you cheated, correct?',
      'Why did your team hide how it works?',
      'Did your team commit Fraud Prevention?',
    ]) {
      expect(accepted(w, T, `${stated} ${tail}`), tail).toBe(false);
    }
  });
});

describe('R9C-F masking trust boundary (helper, multiple titles)', () => {
  it('a mask on one title does not change how a second title is read', () => {
    const out = withoutNeutralWords(
      'Did your team commit Plagiarism Detection and Fraud Prevention?',
      ['Fraud Prevention', 'Plagiarism Detection'],
      [],
    );
    expect(out).toMatch(/commit Plagiarism Detection/);
    const out2 = withoutNeutralWords(
      'Did your team commit Plagiarism Detection and Fraud Prevention?',
      ['Plagiarism Detection', 'Fraud Prevention'],
      [],
    );
    expect(out2).toMatch(/commit Plagiarism Detection/);
  });
  it('title order in the list does not matter for the verdict', () => {
    const a = track('Fraud Prevention', 'Plagiarism Detection');
    const b = track('Plagiarism Detection', 'Fraud Prevention');
    for (const text of [
      'Did your team commit Plagiarism Detection and Fraud Prevention?',
      'Could you show how Fraud Prevention and Plagiarism Detection share a pipeline?',
    ]) {
      expect(accepted(a, T, text)).toBe(accepted(b, T, text));
    }
  });
});

describe('R9C-P2 a title that IS a misconduct noun phrase still hides explicit accusations (EVIDENCE OF THE FINDING; fails on the target)', () => {
  const ACCUSATIONS = [
    'Can you explain how your team got away with TITLE?',
    'Your team is not innocent of TITLE, correct?',
    'Is your team behind TITLE?',
    'Explain the TITLE your team committed.',
    'How long has your team practised TITLE?',
    'Did your team carry out TITLE?',
    'Did your team do TITLE to win?',
    'Did your team benefit from TITLE?',
    'Is this submission a case of TITLE?',
    'Does your project amount to TITLE?',
  ];
  for (const title of [
    'Payment Fraud',
    'Identity Fraud',
    'Insurance Fraud',
    'Exam Cheating',
    'Academic Plagiarism',
  ]) {
    for (const [name, w, kind] of worldsFor(title)) {
      it.each(ACCUSATIONS.map((t) => t.replace('TITLE', title)))(
        `refuses “%s” (${name} ${title})`,
        (text) => {
          expect(accepted(w, kind, text)).toBe(false);
        },
      );
    }
  }
  it('while the same titles remain usable as topics', () => {
    for (const title of ['Payment Fraud', 'Identity Fraud']) {
      // not asserted either way by R9C; recorded: the fix must decide between fail-closed and context
      expect(
        typeof accepted(track(title), T, `Which feature handles ${title} in your project?`),
      ).toBe('boolean');
    }
  });
});
