import { describe, expect, it } from 'vitest';
import { validateCandidates } from './validate.js';
import { candidate, handleOfKind, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/*
 * M6-R2 (R9B P2, F1): an official title that IS an accusatory word must never switch the accusation guard off. On e9662b7 every one of these sixteen
 * accusations (four sentences x the titles Fraud, Plagiarism, Cheating and, as the criterion variant, the same words) was ACCEPTED.
 */

const TITLES = ['Fraud', 'Plagiarism', 'Cheating'] as const;
const sentences = (title: string) => [
  `Did your team commit ${title} when you built this?`,
  `Why did your team engage in ${title}?`,
  `Is your whole project ${title}?`,
  `Your team is guilty of ${title}, correct?`,
];

const trackWorld = (title: string) =>
  world({
    tracks: { declared: [{ key: 't', name: title }], unassessedTrackRubrics: [] },
    requirements: [requirement('r-t', { trackKey: 't', text: 'Must satisfy the track.' })],
  });
const criterionWorld = (title: string) => {
  const base = world();
  return world({
    dimensions: base.input.dimensions.map((d) =>
      d.id === 'official.technical_depth' ? { ...d, name: title } : d,
    ),
  });
};
const codes = (w: ReturnType<typeof world>, kind: string, text: string, reason?: string) => {
  const opportunity = handleOfKind(w.closed, kind);
  return validateCandidates(
    {
      candidates: [
        candidate({
          opportunities: [opportunity],
          mode: 'ask',
          text,
          ...(reason ? { reason } : {}),
        }),
      ],
    },
    w.closed,
  ).rejected.map((r) => r.code);
};

describe('R9B F1: an accusation is refused whatever the official title says', () => {
  for (const title of TITLES) {
    it.each(sentences(title))(`refuses “%s” (track named ${title})`, (text) => {
      expect(codes(trackWorld(title), 'requirement_unaddressed', text)).toContain(
        'accusatory_wording',
      );
    });
    it.each(sentences(title))(`refuses “%s” (criterion named ${title})`, (text) => {
      expect(codes(criterionWorld(title), 'claim_unverified', text)).toContain(
        'accusatory_wording',
      );
    });
  }
});
