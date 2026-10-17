import { describe, expect, it } from 'vitest';
import { validateCandidates, withoutNeutralWords } from './validate.js';
import { candidate, handleOfKind, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/*
 * M6-R2 (R9B P2, F1): an official title establishes what may be DISCUSSED; it never establishes that the team did something wrong, and it never switches the
 * accusation guard off. On e9662b7 every accusation of the first block below was ACCEPTED (24 of 24: four sentences x the titles Fraud, Plagiarism, Cheating,
 * as a track and as a rubric criterion). Both the exported helper and the real validateCandidates() entry point are exercised.
 */

const trackWorld = (title: string, trackText = 'Must satisfy the track.') =>
  world({
    tracks: { declared: [{ key: 't', name: title }], unassessedTrackRubrics: [] },
    requirements: [requirement('r-t', { trackKey: 't', text: trackText })],
  });
const criterionWorld = (title: string) => {
  const base = world();
  return world({
    dimensions: base.input.dimensions.map((d) =>
      d.id === 'official.technical_depth' ? { ...d, name: title } : d,
    ),
  });
};
type World = ReturnType<typeof world>;
const TRACK = 'requirement_unaddressed';
const CRITERION = 'claim_unverified';

const codes = (w: World, kind: string, text: string, reason?: string, mode = 'ask') => {
  const opportunity = handleOfKind(w.closed, kind);
  return validateCandidates(
    {
      candidates: [
        candidate({
          opportunities: [opportunity],
          mode,
          text,
          ...(reason ? { reason } : {}),
        } as never),
      ],
    },
    w.closed,
  ).rejected.map((r) => r.code);
};
const refused = (w: World, kind: string, text: string, reason?: string) =>
  expect(codes(w, kind, text, reason)).toContain('accusatory_wording');
const accepted = (w: World, kind: string, text: string, reason?: string) =>
  expect(codes(w, kind, text, reason)).toEqual([]);

// ------------------------------------------------------------------------------------------------ the R9B reproduction
const STANDALONE = ['Fraud', 'Plagiarism', 'Cheating'] as const;
const sentences = (title: string) => [
  `Did your team commit ${title} when you built this?`,
  `Why did your team engage in ${title}?`,
  `Is your whole project ${title}?`,
  `Your team is guilty of ${title}, correct?`,
];

describe('R9B F1: an accusation is refused whatever the official title says (the reproduction)', () => {
  for (const title of STANDALONE) {
    it.each(sentences(title))(`refuses “%s” (track named ${title})`, (text) => {
      refused(trackWorld(title), TRACK, text);
    });
    it.each(sentences(title))(`refuses “%s” (criterion named ${title})`, (text) => {
      refused(criterionWorld(title), CRITERION, text);
    });
  }
});

// ------------------------------------------------------------------------------------------------ required matrices
describe('neutral questions about an official compound title stay valid', () => {
  const MATRIX: [string, string, string, 'track' | 'criterion'][] = [
    [
      'Fraud Prevention',
      'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
      '',
      'track',
    ],
    [
      'Fake News Detection',
      'Could you show how the Fake News Detection component classifies an article?',
      '',
      'track',
    ],
    ['Plagiarism Detection', 'Can you demonstrate the Plagiarism Detection workflow?', '', 'track'],
    [
      'Fraud Prevention',
      'Which implementation supports the Fraud Prevention track requirement?',
      '',
      'track',
    ],
    [
      'Fraud Prevention',
      'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
      '',
      'criterion',
    ],
    [
      'Fake News Detection',
      'Could you show how the Fake News Detection component classifies an article?',
      '',
      'criterion',
    ],
    [
      'Plagiarism Detection',
      'Can you demonstrate the Plagiarism Detection workflow?',
      '',
      'criterion',
    ],
    [
      'Fraud Prevention',
      'Can you demonstrate how your FRAUD PREVENTION feature handles a suspicious transaction?',
      '',
      'track',
    ],
    [
      'Fraud Prevention',
      'Can you demonstrate how your Fraud   Prevention feature handles a suspicious transaction?',
      '',
      'track',
    ],
    [
      'Fraud Prevention',
      'Can you demonstrate how your fraud-prevention feature handles a suspicious transaction?',
      '',
      'track',
    ],
    [
      'Fake News Detection',
      'Could you show how the fake-news-detection component classifies an article?',
      '',
      'track',
    ],
    [
      'Fraud & Cheating Detection',
      'Could you show the Fraud & Cheating Detection workflow on one example?',
      '',
      'track',
    ],
  ];
  it.each(MATRIX)('accepts [%s] “%s”', (title, text, _x, kind) => {
    if (kind === 'track') accepted(trackWorld(title), TRACK, text);
    else accepted(criterionWorld(title), CRITERION, text);
  });
  it('accepts a neutral title in the reason too', () => {
    accepted(
      trackWorld('Fraud Prevention'),
      TRACK,
      'Could you show the main flow on the project itself?',
      'The Fraud Prevention track requirement is not yet shown by any examined evidence.',
    );
  });
});

describe('accusations are refused even when the exact title is official', () => {
  const ACCUSATIONS: [string, string][] = [
    ['Fraud', 'Did your team commit Fraud?'],
    ['Fraud', 'Your team is guilty of Fraud, correct?'],
    ['Fraud', 'Is your project Fraud?'],
    ['Plagiarism', 'Why did your team engage in Plagiarism?'],
    ['Cheating', 'Did you deliberately cheat during the Cheating track?'],
    ['Fraud Prevention', 'Why did your team fake the results of Fraud Prevention?'],
    ['Fake News Detection', 'Did your team fabricate the Fake News Detection evaluation?'],
  ];
  it.each(ACCUSATIONS)('[%s] refuses “%s”', (title, text) => {
    refused(trackWorld(title), TRACK, text);
    refused(criterionWorld(title), CRITERION, text);
  });

  // a COMPOUND title must not be a hiding place either: nothing here relies on a list of single-word titles
  const HIDDEN: [string, string][] = [
    ['Fraud Prevention', 'Did your team commit Fraud Prevention?'],
    ['Fraud Prevention', 'Your team is guilty of Fraud Prevention, correct?'],
    ['Fraud Prevention', 'Is your whole project Fraud Prevention?'],
    ['Plagiarism Detection', 'Why did your team engage in Plagiarism Detection?'],
    ['Plagiarism Detection', 'Was your team accused of Plagiarism Detection evasion?'],
    ['Fake News Detection', 'Was your team charged with Fake News Detection?'],
    ['Fake News Detection', 'Did your team really build the Fake News Detection model?'],
    ['Fraud Prevention', 'Isn’t it true that the Fraud Prevention numbers were not yours?'],
    [
      'Fraud Prevention',
      'Is it true that you actually wrote the Fraud Prevention rules yourselves?',
    ],
    [
      'Plagiarism Detection',
      'Did you build the Plagiarism Detection module on your own, honestly?',
    ],
    ['Fraud Prevention', 'Fraud Prevention was supposedly built by your team, wasn’t it?'],
    [
      'Fraud Prevention',
      'You have been accused of copying it. Can you show the Fraud Prevention workflow?',
    ],
  ];
  it.each(HIDDEN)('[%s] refuses “%s”', (title, text) => {
    refused(trackWorld(title), TRACK, text);
    refused(criterionWorld(title), CRITERION, text);
  });
});

describe('guilt and blame are refused without any particular noun', () => {
  it.each([
    'Is your team guilty of anything in connection with the Fraud Prevention track?',
    'Is the team culpable for how the Fraud Prevention demo turned out?',
    'Was there any misconduct behind the Fraud Prevention numbers?',
    'Was anyone convicted of anything related to the Plagiarism Detection module?',
  ])('refuses “%s”', (text) => {
    refused(trackWorld('Fraud Prevention'), TRACK, text);
  });
});

describe('every other path of the question and the reason is still checked', () => {
  it.each([
    'We suspect the team fabricated the Fraud Prevention results.',
    'The team is guilty of Fraud Prevention evasion.',
    'This question tests whether they committed Fraud.',
    'Did the team really write the Fraud Prevention module?',
  ])('refuses an accusation in the REASON: “%s”', (reason) => {
    const w = trackWorld('Fraud Prevention');
    refused(w, TRACK, 'Can you demonstrate the Fraud Prevention workflow?', reason);
  });

  it('refuses an accusation in the reason when the title is a standalone accusatory word', () => {
    refused(
      trackWorld('Fraud'),
      TRACK,
      'Could you show the main flow on the project itself?',
      'The team committed Fraud here.',
    );
  });

  it('a standalone title that is an accusatory word is not set aside even in a neutral-looking sentence (fail closed)', () => {
    // documented limit: the price of never trusting a bare accusatory title
    refused(trackWorld('Fraud'), TRACK, 'Can you demonstrate how your Fraud feature works?');
  });

  it('a title made only of accusatory words is not set aside either', () => {
    const w = trackWorld('Fraud and Plagiarism');
    refused(w, TRACK, 'Did your team commit Fraud and Plagiarism?');
    refused(w, TRACK, 'Can you demonstrate the Fraud and Plagiarism workflow?');
  });

  it('a title absent from the frozen analysis never authorizes anything', () => {
    const plain = world();
    for (const text of [
      'Can you demonstrate the Fraud Prevention workflow?',
      'Could you show how the Fake News Detection component classifies an article?',
      'Can you demonstrate the Plagiarism Detection workflow?',
    ]) {
      refused(plain, CRITERION, text);
    }
    // ... and a different official title does not authorize this one
    refused(
      trackWorld('Fraud Prevention'),
      TRACK,
      'Can you demonstrate the Plagiarism Detection workflow?',
    );
  });

  it('a candidate cannot declare a title in its own text or reason', () => {
    const plain = world();
    refused(
      plain,
      CRITERION,
      'The official track “Fraud Prevention” asks: can you show it working on one transaction?',
    );
    refused(
      plain,
      CRITERION,
      'Could you show the main flow on the project itself?',
      'This is the official Fraud Prevention track.',
    );
  });

  it('a title inside a longer word is not a title', () => {
    expect(withoutNeutralWords('Superfraud Prevention', ['Fraud Prevention'], [])).toContain(
      'Superfraud',
    );
    expect(withoutNeutralWords('Fraudulent Fraud Prevention', ['Fraud Prevention'], [])).toMatch(
      /Fraudulent\s+OFFICIALTITLE/,
    );
    refused(
      trackWorld('Fraud Prevention'),
      TRACK,
      'Did the Fraudulent Fraud Prevention layer work?',
    );
  });

  it('refuses a direct allegation placed beside an attributed team statement', () => {
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
    const opportunity = handleOfKind(w.closed, TRACK);
    const check = (text: string) =>
      validateCandidates(
        { candidates: [candidate({ opportunities: [opportunity], mode: 'verify', text })] },
        w.closed,
      ).rejected.map((r) => r.code);
    // the attributed sentence alone is neutral
    expect(
      check(
        'Your README says our Fraud Prevention engine flags suspicious payments before settlement. Could you show it?',
      ),
    ).toEqual([]);
    // an allegation in the same sentence, in the next one, or hidden in a "so" clause is not authorized by the attribution
    for (const text of [
      'Your README says our Fraud Prevention engine flags suspicious payments before settlement, so your team is guilty of Fraud Prevention.',
      'Your README says our Fraud Prevention engine flags suspicious payments before settlement. Did your team commit Fraud Prevention?',
      'Your README says our Fraud Prevention engine flags suspicious payments before settlement. Your team faked it, correct?',
      'Your README says our Fraud Prevention engine flags suspicious payments before settlement; why did your team fake the results?',
    ]) {
      expect(check(text), text).toContain('accusatory_wording');
    }
  });
});

// ------------------------------------------------------------------------------------------------ the helper itself
describe('withoutNeutralWords: what is set aside, exactly', () => {
  const T = ['Fraud Prevention', 'Fraud'];
  it('never sets aside a title made only of accusatory words', () => {
    expect(withoutNeutralWords('Your team is guilty of Fraud', ['Fraud'], [])).toContain('Fraud');
    expect(withoutNeutralWords('Fraud and Cheating', ['Fraud and Cheating'], [])).toContain(
      'Fraud',
    );
    expect(withoutNeutralWords('Your team is guilty of Fraud', T, [])).toContain('Fraud');
  });
  it('sets aside a compound title in a neutral position', () => {
    for (const text of [
      'Can you demonstrate the Fraud Prevention workflow?',
      'Which implementation supports the Fraud Prevention track requirement?',
      'How does Fraud Prevention decide that a payment is suspicious?',
    ]) {
      expect(withoutNeutralWords(text, ['Fraud Prevention'], []), text).toContain('OFFICIALTITLE');
    }
  });
  it('keeps the title as written where it is charged, a verdict, or challenged', () => {
    for (const text of [
      'Did your team commit Fraud Prevention?',
      'Your team is guilty of Fraud Prevention, correct?',
      'Why did your team engage in Fraud Prevention?',
      'Is your whole project Fraud Prevention?',
      'Did you actually build Fraud Prevention?',
    ]) {
      const out = withoutNeutralWords(text, ['Fraud Prevention'], []);
      expect(out, text).not.toContain('OFFICIALTITLE');
      expect(out, text).toMatch(/Fraud Prevention/);
    }
  });
  it('decides per occurrence: a neutral mention and a charged mention in one text', () => {
    const out = withoutNeutralWords(
      'Can you show the Fraud Prevention workflow? Did your team commit Fraud Prevention?',
      ['Fraud Prevention'],
      [],
    );
    expect(out).toMatch(/show the\s+OFFICIALTITLE\s+workflow/);
    expect(out).toMatch(/commit Fraud Prevention/);
  });
  it('does not widen the team-words exception: only a 3+ word run of a recorded claim, only in an attributed sentence', () => {
    const claim = ['The system flags fake reviews before they are shown.'];
    const out = withoutNeutralWords(
      'Your README says the system flags fake reviews before they are shown. Your team faked the benchmark.',
      [],
      claim,
    );
    expect(out).not.toMatch(/flags fake reviews/);
    expect(out).toMatch(/faked/);
  });
});
