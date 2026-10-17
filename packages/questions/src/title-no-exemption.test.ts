import { describe, expect, it } from 'vitest';
import { validateCandidates } from './validate.js';
import { candidate, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/*
 * M6-R4: a verified official title is a SOURCE IDENTIFIER and a topic, never a licence. The wording check runs on the COMPLETE text of every question and reason;
 * no official title is masked, set aside or exempted from it, whatever the title says, wherever it sits in the sentence, and whoever the sentence is about.
 *
 * This file reconstructs the R9A-R9D attack matrices against the real validateCandidates() entry point. On e0b0f0f (M6-R3) the families below that name a title
 * which MODIFIES a misconduct word (Fake News, Fake Reviews, Fraud Cases, ...) were accepted. A neutral question that QUOTES such a title is now refused too: that is
 * the price of having no exemption (the offline demonstrator never quotes a title; see demonstration.test.ts).
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
/** One candidate that cites EVERY opportunity of the kind, so every official title of the world is cited. */
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
  expect(codes(w, kind, text, reason), text).toContain('accusatory_wording');
};

const TITLES = [
  // titles that END in a misconduct word (R9C)
  'Fraud',
  'Plagiarism',
  'Cheating',
  'Payment Fraud',
  'Identity Fraud',
  'Insurance Fraud',
  'Academic Plagiarism',
  'Exam Cheating',
  'Academic Dishonesty',
  'Online Scams',
  // titles that merely CONTAIN one (R9D)
  'Fake News',
  'Fake Reviews',
  'Fraud Cases',
  'Cheating Scandal',
  'Plagiarism Report',
  'Fraud Prevention',
  'Plagiarism Detection',
  'Fake News Detection',
  'Fraud & Cheating Detection',
];

describe('the exact R9D examples', () => {
  it.each([
    ['Fake News', 'Is your group behind Fake News?'],
    ['Fake Reviews', 'Are the founders responsible for Fake Reviews?'],
    ['Fake News', 'Is your team behind: Fake News?'],
    ['Fake News', 'Did your team commit the following: Fake News?'],
    ['Fake News', 'Is this submission a case of Fake News?'],
    ['Fraud Cases', 'Does your project amount to Fraud Cases?'],
  ])('[%s] refuses “%s” as a track and as a criterion', (title, text) => {
    refused(trackWorld(title), TRACK, text);
    refused(criterionWorld(title), CRITERION, text);
  });
});

describe('no official title exempts itself: every title x every grammatical structure, as a track and as a criterion', () => {
  // people the old lexicon knew, people it did not, nobody at all, and the submission itself
  const SUBJECTS = [
    'your team',
    'the team',
    'you',
    'your group',
    'your company',
    'your startup',
    'the founders',
    'the engineers',
    'the students',
    'your colleagues',
    'he',
    'she',
    'we',
    'whoever wrote it',
    'someone on your side',
    'the submission',
    'your project',
    'the demo',
    'the implementation',
    'the source code',
    'the results',
    'the evidence supplied',
  ];
  const FRAMES = [
    'Is S behind TITLE?',
    'Are S responsible for TITLE?',
    'Did S carry out TITLE?',
    'Has S been involved in TITLE?',
    'Did S benefit from TITLE?',
    'How long has S practised TITLE?',
    'Can you explain how S got away with TITLE?',
    'Explain the TITLE S committed.',
    'Was TITLE what S did here?',
    'Is S not innocent of TITLE, correct?',
    'Is S a case of TITLE?',
    'Does S amount to TITLE?',
    'Is S TITLE?',
  ];
  for (const title of TITLES) {
    it(`${title}: ${String(SUBJECTS.length * FRAMES.length)} frames x track and criterion`, () => {
      for (const s of SUBJECTS) {
        for (const f of FRAMES) {
          const text = f.replace('S', s).replace('TITLE', title);
          refused(trackWorld(title), TRACK, text);
          refused(criterionWorld(title), CRITERION, text);
        }
      }
    });
  }
});

describe('punctuation cannot isolate a title into an exempt sentence', () => {
  const SPLITS = (t: string) => [
    `Is your team behind: ${t}?`,
    `Is your team behind... ${t}?`,
    `Did your team commit the following: ${t}?`,
    `Is your team responsible for the following? ${t}.`,
    `Your team is behind it. ${t}, correct?`,
    `Who is behind this? ${t}.`,
    `Did your team do it! ${t}?`,
    `Did your team carry out: ${t}?`,
    `Has your team been involved in any of the following. ${t}?`,
    `Your team did what? ${t}.`,
    `Is your team behind this – ${t}?`,
    `Is your team behind this\n${t}?`,
    `Is your team behind this; ${t}?`,
    `Is your team behind “${t}”?`,
    `Is your team behind (${t})?`,
  ];
  for (const title of TITLES) {
    it(`${title}`, () => {
      for (const text of SPLITS(title)) {
        refused(trackWorld(title), TRACK, text);
        refused(criterionWorld(title), CRITERION, text);
      }
    });
  }
});

describe('question text and reason are treated identically', () => {
  for (const title of TITLES) {
    it(`${title}: an accusation in the reason is refused as a track and as a criterion`, () => {
      for (const reason of [
        `The founders are behind ${title}.`,
        `This checks something. The team is behind: ${title}.`,
        `The submission is a case of ${title}.`,
        `This checks how the team got away with ${title}.`,
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
    });
  }
});

describe('several official titles in one candidate, and forged titles', () => {
  it('a quoted title keeps its accusatory word visible whatever stands next to it', () => {
    const w = trackWorld('Fraud Prevention', 'Payment Fraud', 'Fake News');
    for (const text of [
      'Could you compare Fraud Prevention with Payment Fraud?',
      'Is your group behind Fraud Prevention and Fake News?',
      'Could you show how Fake News and Fraud Prevention share a pipeline?',
    ]) {
      refused(w, TRACK, text);
    }
  });
  it('a title absent from the frozen analysis grants nothing (it was never needed)', () => {
    const plain = world();
    for (const text of [
      'Is your group behind Fake News?',
      'The official Payment Fraud track asks: is your team behind it?',
      'Could you demonstrate Plagiarism Detection?',
    ]) {
      refused(plain, CRITERION, text);
    }
  });
});
