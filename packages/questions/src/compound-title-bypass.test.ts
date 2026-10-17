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
