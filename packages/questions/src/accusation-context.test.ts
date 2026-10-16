import { describe, expect, it } from 'vitest';
import { validateCandidates, withoutNeutralWords } from './validate.js';
import { candidate, handleOfKind, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/*
 * M6-R1 (R9A P2-3): neutral official terminology is not an accusation; accusations are still refused. The titles that may be set aside come from the FROZEN
 * analysis (rubric criteria and declared tracks the cited uncertainties bear on), never from a candidate's own declaration. These tests also pin the limits:
 * the filter is a heuristic and an unrelated use of an accusatory word is refused.
 */

const fraudWorld = () =>
  world({
    tracks: { declared: [{ key: 'fraud', name: 'Fraud Prevention' }], unassessedTrackRubrics: [] },
    requirements: [
      requirement('r-fraud', { trackKey: 'fraud', text: 'Must detect suspicious transactions.' }),
    ],
  });

const verdict = (
  w: ReturnType<typeof world>,
  over: Parameters<typeof candidate>[0] extends infer P ? Partial<P> : never,
) => {
  const opportunity = handleOfKind(w.closed, 'requirement_unaddressed');
  return validateCandidates(
    { candidates: [candidate({ opportunities: [opportunity], mode: 'demonstrate', ...over })] },
    w.closed,
  ).rejected.map((r) => r.code);
};

describe('a legitimate official term is not an accusation', () => {
  it.each([
    'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
    'Can you demonstrate how your FRAUD PREVENTION feature handles a suspicious transaction?',
    'Can you demonstrate how your fraud-prevention feature handles a suspicious transaction?',
    'Can you demonstrate how your Fraud   Prevention feature handles a suspicious transaction?',
  ])('accepts “%s” when the track is cited by the uncertainty', (text) => {
    expect(verdict(fraudWorld(), { text })).toEqual([]);
  });

  it('accepts accusatory words in a rubric criterion title the cited uncertainty bears on', () => {
    const base = world();
    const renamed = world({
      dimensions: base.input.dimensions.map((d) =>
        d.id === 'official.technical_depth' ? { ...d, name: 'Fake News Detection' } : d,
      ),
    });
    const opportunity = handleOfKind(renamed.closed, 'claim_unverified');
    const result = validateCandidates(
      {
        candidates: [
          candidate({
            opportunities: [opportunity],
            text: 'How does your Fake News Detection approach decide that one article is unreliable?',
            mode: 'clarify',
          }),
        ],
      },
      renamed.closed,
    );
    expect(result.rejected).toEqual([]);
  });

  it('accepts a team’s own words when the sentence attributes them to the team’s materials', () => {
    const base = world();
    const w = world({
      claims: base.input.claims.map((c) =>
        c.id === 'c-pipeline'
          ? { ...c, text: 'Our tool detects fake reviews using a trained classifier.' }
          : c,
      ),
    });
    const opportunity = handleOfKind(w.closed, 'claim_unverified');
    const result = validateCandidates(
      {
        candidates: [
          candidate({
            opportunities: [opportunity],
            mode: 'verify',
            text: 'Your README says the tool detects fake reviews using a trained classifier. Could you show it flagging one example?',
          }),
        ],
      },
      w.closed,
    );
    expect(result.rejected).toEqual([]);
  });
});

describe('accusations are still refused', () => {
  const REFUSED: [string, string][] = [
    [
      'an explicit accusation, even beside an official title',
      'Why did your team fake the results of the Fraud Prevention demo?',
    ],
    [
      'an accusation of plagiarism',
      'Did you plagiarize the Fraud Prevention module from another project?',
    ],
    ['dishonest conduct', 'Did your team cheat while building the Fraud Prevention feature?'],
    ['a presupposed violation', 'How did you get around the rules for Fraud Prevention?'],
    ['concealment', 'Why did your team hide how Fraud Prevention works?'],
    ['rule-breaking', 'Your team violated the requirements, so how does Fraud Prevention work?'],
    ['leading phrasing', 'You never actually built the Fraud Prevention feature, did you?'],
    ['the title used as a weapon', 'Is the Fraud Prevention entry itself a fraud?'],
    ['only part of the title', 'Does your fraud checker catch anything at all?'],
    ['an accusatory word with no official title around it', 'Is your fraud detection genuine?'],
  ];
  it.each(REFUSED)('refuses %s', (_name, text) => {
    expect(verdict(fraudWorld(), { text })).toContain('accusatory_wording');
  });

  it('refuses an accusation placed in the reason, not only in the question', () => {
    expect(
      verdict(fraudWorld(), {
        text: 'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
        reason: 'The team faked the evidence for this criterion.',
      }),
    ).toContain('accusatory_wording');
  });

  it('refuses the same wording when no such title exists in the verified analysis: a candidate cannot declare an official term', () => {
    const plain = world();
    const opportunity = handleOfKind(plain.closed, 'claim_unverified');
    for (const text of [
      'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
      'Our official Fraud Prevention track asks: can you show it working on a suspicious transaction?',
    ]) {
      const result = validateCandidates(
        { candidates: [candidate({ opportunities: [opportunity], text, mode: 'demonstrate' })] },
        plain.closed,
      );
      expect(result.rejected.map((r) => r.code)).toEqual(['accusatory_wording']);
    }
    // ... nor in the reason
    const viaReason = validateCandidates(
      {
        candidates: [
          candidate({
            opportunities: [opportunity],
            text: 'Could you show the main flow on the project itself?',
            reason: 'This is the official Fraud track of the event.',
            mode: 'demonstrate',
          }),
        ],
      },
      plain.closed,
    );
    expect(viaReason.rejected.map((r) => r.code)).toEqual(['accusatory_wording']);
  });

  it('refuses a quotation that is NOT the team’s recorded words, even when it is attributed', () => {
    const w = world();
    const opportunity = handleOfKind(w.closed, 'claim_unverified');
    const result = validateCandidates(
      {
        candidates: [
          candidate({
            opportunities: [opportunity],
            mode: 'verify',
            text: 'Your README says “you faked the whole benchmark run”. Could you show the run?',
          }),
        ],
      },
      w.closed,
    );
    expect(result.rejected.map((r) => r.code)).toContain('accusatory_wording');
  });
});

describe('what is set aside, exactly', () => {
  it('sets aside a title as whole words only, never a longer word that contains it', () => {
    expect(withoutNeutralWords('Fraudulent Fraud Prevention', ['Fraud Prevention'], [])).toMatch(
      /Fraudulent\s+OFFICIALTITLE/,
    );
    expect(withoutNeutralWords('Superfraud Prevention', ['Fraud Prevention'], [])).toContain(
      'Superfraud',
    );
  });

  it('sets aside team words only in an attributed sentence and only runs of three or more words', () => {
    const claim = ['The system flags fake reviews before they are shown.'];
    expect(
      withoutNeutralWords(
        'Your README says the system flags fake reviews before they are shown. Show it.',
        [],
        claim,
      ),
    ).not.toMatch(/fake/);
    // no attribution: nothing is set aside
    expect(
      withoutNeutralWords('The system flags fake reviews before they are shown.', [], claim),
    ).toMatch(/fake/);
    // a one-word overlap is not a quotation
    expect(withoutNeutralWords('Your README says you made fake data.', [], claim)).toMatch(/fake/);
  });
});

describe('the R9A scenario: a Fraud Prevention track keeps all four of its candidates', () => {
  it('accepts four neutral candidates about the track across its requirement and its own rubric', () => {
    const w = world({
      tracks: {
        declared: [{ key: 'fraud', name: 'Fraud Prevention' }],
        unassessedTrackRubrics: [
          {
            trackKey: 'fraud',
            trackName: 'Fraud Prevention',
            rubricName: 'Fraud Prevention criteria',
          },
        ],
      },
      requirements: [
        requirement('r-fraud', { trackKey: 'fraud', text: 'Must detect suspicious transactions.' }),
      ],
    });
    const req = handleOfKind(w.closed, 'requirement_unaddressed');
    const rubric = handleOfKind(w.closed, 'track_rubric_not_assessed');
    const result = validateCandidates(
      {
        candidates: [
          candidate({
            opportunities: [req],
            mode: 'demonstrate',
            text: 'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
          }),
          candidate({
            opportunities: [req],
            mode: 'show_me',
            text: 'Could you open the part of the code that scores a transaction for the Fraud Prevention track?',
          }),
          candidate({
            opportunities: [rubric],
            mode: 'ask',
            text: 'How would you describe what the Fraud Prevention criteria reward in your own project?',
          }),
          candidate({
            opportunities: [rubric],
            mode: 'verify',
            text: 'How can a judge check that your Fraud Prevention results come from real transaction data?',
          }),
        ],
      },
      w.closed,
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(4);
  });
});
