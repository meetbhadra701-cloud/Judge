import { describe, expect, it } from 'vitest';
import { validateCandidates } from './validate.js';
import { candidate, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/*
 * M6-R3 (R9C P2): an official title whose LAST substantive word is itself a misconduct word ("Payment Fraud", "Exam Cheating") must never be set aside as a neutral
 * subject. On 738c790, 126 of these 175 accusations (7 titles x the 25 frames below) were ACCEPTED as a track title and as a criterion title.
 * The frames are those of the R9C probe table, reconstructed here; this file is NOT the reviewer's own suite.
 */

type World = ReturnType<typeof world>;
const TRACK = 'requirement_unaddressed';
const CRITERION = 'claim_unverified';
const trackWorld = (...names: string[]): World =>
  world({
    tracks: {
      declared: names.map((name, i) => ({ key: `t${String(i)}`, name })),
      unassessedTrackRubrics: [],
    },
    requirements: names.map((name, i) =>
      requirement(`r-t${String(i)}`, { trackKey: `t${String(i)}`, text: `Must satisfy ${name}.` }),
    ),
  });
const criterionWorld = (title: string): World => {
  const base = world();
  return world({
    dimensions: base.input.dimensions.map((d) =>
      d.id === 'official.technical_depth' ? { ...d, name: title } : d,
    ),
  });
};
/** The rejection codes when ONE candidate cites ALL opportunities of the kind (so every official title of the world is cited). */
const codes = (w: World, kind: string, text: string, reason?: string): string[] => {
  const handles = w.closed.opportunities
    .filter((o) => o.opportunity.kind === kind)
    .map((o) => o.handle);
  return validateCandidates(
    {
      candidates: [
        candidate({
          opportunities: handles,
          mode: 'ask',
          text,
          ...(reason ? { reason } : {}),
        } as never),
      ],
    },
    w.closed,
  ).rejected.map((r) => r.code);
};
const refused = (w: World, kind: string, text: string, reason?: string): void => {
  expect(codes(w, kind, text, reason)).toContain('accusatory_wording');
};
const accepted = (w: World, kind: string, text: string, reason?: string): void => {
  expect(codes(w, kind, text, reason)).toEqual([]);
};

const MISCONDUCT_TITLES = [
  'Payment Fraud',
  'Identity Fraud',
  'Insurance Fraud',
  'Academic Plagiarism',
  'Exam Cheating',
  'Academic Dishonesty',
  'Online Scams',
];
const FRAMES = [
  'Has your team been involved in X?',
  'Are you responsible for X?',
  'Is your team behind X?',
  'Did your team carry out X?',
  'Did you perform X yourselves?',
  'Did your team do X to win?',
  'Did your team benefit from X?',
  'Was X what your team did here?',
  'Were you part of X?',
  'Is X what happened in your project?',
  'Did your team commit, knowingly, X?',
  'Did your team commit  X?',
  'Did your team (knowingly) commit X?',
  'Did your team commit the following: X?',
  'Your team committed X; why?',
  'Why did your team choose to commit X?',
  'How often did your team commit X?',
  'Explain the X your team committed.',
  'Was your team accused of X?',
  'Your team is not innocent of X, correct?',
  'Can you explain how your team got away with X?',
  'How long has your team practised X?',
  'Is this submission a case of X?',
  'Does your project amount to X?',
  'When did your team start X?',
];

describe('R9C F1: a title that ends in a misconduct word hides no accusation (7 titles x 25 frames x track / criterion = 350 checks)', () => {
  it('has 25 distinct frames and 7 titles', () => {
    expect(new Set(FRAMES).size).toBe(25);
    expect(MISCONDUCT_TITLES).toHaveLength(7);
  });
  for (const title of MISCONDUCT_TITLES) {
    it.each(FRAMES.map((f) => f.replace('X', title)))(`refuses “%s” (track ${title})`, (text) => {
      refused(trackWorld(title), TRACK, text);
    });
    it.each(FRAMES.map((f) => f.replace('X', title)))(
      `refuses “%s” (criterion ${title})`,
      (text) => {
        refused(criterionWorld(title), CRITERION, text);
      },
    );
  }

  it.each([
    'Can you explain how your team got away with Payment Fraud?',
    'Your team is not innocent of Payment Fraud, correct?',
    'Is your team behind Payment Fraud?',
    'Explain the Payment Fraud your team committed.',
    'How long has your team practised Payment Fraud?',
  ])('the five exact R9C examples: refuses “%s” as track and as criterion', (text) => {
    refused(trackWorld('Payment Fraud'), TRACK, text);
    refused(criterionWorld('Payment Fraud'), CRITERION, text);
  });

  it('the same accusations in the REASON are refused', () => {
    for (const title of MISCONDUCT_TITLES) {
      for (const reason of [
        `This checks how the team got away with ${title}.`,
        `The team is not innocent of ${title}.`,
      ]) {
        refused(
          trackWorld(title),
          TRACK,
          'Could you show the main flow on the project itself?',
          reason,
        );
        refused(
          criterionWorld(title),
          CRITERION,
          'Could you show the main flow on the project itself?',
          reason,
        );
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------ the rule itself
const TEAM_FRAMES = [
  'Has your team been involved in X?',
  'Is your team behind X?',
  'Did your team carry out X?',
  'Did your team benefit from X?',
  'Were you part of X?',
  'Explain the X your team committed.',
  'Your team is not innocent of X, correct?',
  'Can you explain how your team got away with X?',
  'How long has your team practised X?',
  'When did your team start X?',
  'Did your team create X?',
  'Did your team spread X?',
  'Are you running X?',
  'Did you use X to win?',
];

describe('a title whose last word is NOT a misconduct word is only ELIGIBLE: a sentence that puts the team next to it is still refused', () => {
  // "Fake News", "Fraud Cases", "Fake Reviews" can name the misconduct itself although their head word is neutral; the boundary is the sentence, not the title
  for (const title of [
    'Fake News',
    'Fraud Cases',
    'Fake Reviews',
    'Cheating Scandal',
    'Plagiarism Report',
    'Fraud Prevention',
    'Plagiarism Detection',
    'Fake News Detection',
    'Fraud & Cheating Detection',
  ]) {
    it.each(TEAM_FRAMES.map((f) => f.replace('X', title)))(
      `refuses “%s” (track ${title})`,
      (text) => {
        refused(trackWorld(title), TRACK, text);
      },
    );
    it(`refuses the same in a criterion named ${title} and in the reason`, () => {
      for (const f of TEAM_FRAMES) refused(criterionWorld(title), CRITERION, f.replace('X', title));
      refused(
        trackWorld(title),
        TRACK,
        'Could you show the main flow on the project itself?',
        `The team is not innocent of ${title}.`,
      );
      refused(
        trackWorld(title),
        TRACK,
        'Could you show the main flow on the project itself?',
        `This checks how the team got away with ${title}.`,
      );
    });
  }
});

describe('titles that end in a misconduct word are protected whatever their punctuation, conjunctions, hyphens or position of the sensitive term', () => {
  const PROTECTED = [
    'Fraud',
    'Payment Fraud',
    'Exam Cheating',
    'Fraud and Plagiarism',
    'Fraud & Cheating',
    'Cheating, Fraud and Scams',
    'Anti-Fraud',
    'Prevention of Fraud',
    'Detecting Plagiarism',
    'Payment Fraud (beta)',
    'Payment Fraud 2025',
    'Fraud.',
  ];
  it.each(PROTECTED)(
    'accusation beside “%s” is refused, and the title is not set aside even in a neutral sentence (fail closed)',
    (title) => {
      refused(trackWorld(title), TRACK, `Is your team behind ${title}?`);
      refused(criterionWorld(title), CRITERION, `Your team is not innocent of ${title}, correct?`);
      refused(trackWorld(title), TRACK, `Which feature of the project addresses ${title}?`);
    },
  );
  const ELIGIBLE = [
    'Fraud Prevention',
    'Fraud-Prevention',
    'Plagiarism Detection',
    'Fake News Detection',
    'Fraud & Cheating Detection',
    'Anti-Fraud Tools',
    'Plagiarism: Detection & Prevention',
    'Fraud Prevention (beta)',
    'Fraud Prevention 2025',
  ];
  it.each(ELIGIBLE)('a neutral question about “%s” is accepted (track and criterion)', (title) => {
    accepted(trackWorld(title), TRACK, `Which part of the project covers ${title}?`);
    accepted(criterionWorld(title), CRITERION, `Could you show us how the project meets ${title}?`);
    accepted(
      trackWorld(title),
      TRACK,
      `Could you show the main flow on the project itself?`,
      `Nothing the assessment examined shows how ${title} is met.`,
    );
  });
  it('the neutral request forms of the demonstration templates keep working for an eligible title', () => {
    const w = trackWorld('Fraud Prevention');
    for (const [text, reason] of [
      [
        'Could you show us, on the project itself, what it does in relation to Fraud Prevention?',
        'No score could be given for Fraud Prevention, so seeing it directly is the quickest way to place it on the rubric.',
      ],
      [
        'Could you demonstrate, on the project itself, what your materials describe for Fraud Prevention?',
        "The score for Fraud Prevention rests only on what the team's materials say, so a live look would corroborate or correct it.",
      ],
      [
        'Two parts of your materials seem to describe Fraud Prevention differently; could you explain how they fit together?',
        'Two recorded passages about Fraud Prevention do not obviously agree, and an explanation would settle which reading applies.',
      ],
      [
        'Could you tell us more about the open point the assessment recorded for Fraud Prevention?',
        'The assessment could not establish a point about Fraud Prevention, and the team can say more directly.',
      ],
      [
        'Could you tell us how the project addresses the criteria published for Fraud Prevention?',
        'The criteria published for Fraud Prevention were not scored by the assessment, so the interview is the place to cover them.',
      ],
    ] as const) {
      accepted(w, TRACK, text, reason);
    }
  });
});

describe('the neutral questions of the R9A / R9B / R9C reports stay valid for eligible titles', () => {
  const CASES: [string, string[]][] = [
    [
      'Fraud Prevention',
      [
        'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
        'Which implementation supports the Fraud Prevention track requirement?',
      ],
    ],
    ['Plagiarism Detection', ['Can you demonstrate the Plagiarism Detection workflow?']],
    [
      'Fake News Detection',
      ['Could you show how the Fake News Detection component classifies an article?'],
    ],
    [
      'Fraud & Cheating Detection',
      ['Could you show the Fraud & Cheating Detection workflow on one example?'],
    ],
  ];
  for (const [title, texts] of CASES) {
    it.each(texts)(`accepts “%s” (track and criterion ${title})`, (text) => {
      accepted(trackWorld(title), TRACK, text);
      accepted(criterionWorld(title), CRITERION, text);
    });
  }
});

describe('several official titles in one candidate, and masking one title never changes how an adjacent title is read', () => {
  const both = (a: string, b: string) => trackWorld(a, b);
  it('a protected title next to an eligible one is still seen, in either order and in either title list order', () => {
    for (const w of [
      both('Fraud Prevention', 'Payment Fraud'),
      both('Payment Fraud', 'Fraud Prevention'),
    ]) {
      refused(w, TRACK, 'Could you compare Fraud Prevention with Payment Fraud?');
      refused(w, TRACK, 'Could you compare Payment Fraud with Fraud Prevention?');
      refused(w, TRACK, 'Is your team behind Fraud Prevention and Payment Fraud?');
      accepted(w, TRACK, 'Which feature covers Fraud Prevention?');
    }
  });
  it('two eligible titles share a neutral sentence; a team reference next to either refuses it, in any list order', () => {
    for (const w of [
      both('Fraud Prevention', 'Plagiarism Detection'),
      both('Plagiarism Detection', 'Fraud Prevention'),
    ]) {
      accepted(
        w,
        TRACK,
        'Could you show how Fraud Prevention and Plagiarism Detection share a pipeline?',
      );
      refused(w, TRACK, 'Did your team commit Plagiarism Detection and Fraud Prevention?');
      refused(w, TRACK, 'Is your team behind Plagiarism Detection and Fraud Prevention?');
    }
  });
  it('a title nested inside another title is read as the longer title or not at all, never half-masked', () => {
    const w = both('Fraud Prevention', 'Payment Fraud Prevention');
    accepted(w, TRACK, 'Which feature covers Payment Fraud Prevention?');
    refused(w, TRACK, 'Is your team behind Payment Fraud Prevention?');
  });
});

describe('forged and candidate-declared titles are never trusted', () => {
  it('no title in the frozen analysis, whatever the candidate says about it', () => {
    const plain = world();
    for (const text of [
      'Is your team behind Payment Fraud?',
      'The official Payment Fraud track asks: is your team behind Fraud Prevention?',
      'Which feature covers the official Fraud Prevention track?',
    ]) {
      refused(plain, CRITERION, text);
    }
    refused(
      plain,
      CRITERION,
      'Could you show the main flow on the project itself?',
      'This is the official Fraud Prevention track.',
    );
  });
  it('a different official title does not authorize this one', () => {
    refused(trackWorld('Plagiarism Detection'), TRACK, 'Which feature covers Fraud Prevention?');
  });
});
