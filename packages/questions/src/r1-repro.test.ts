import { describe, expect, it } from 'vitest';
import { rankCandidates } from './rank.js';
import { selectQuestions } from './select.js';
import { validateCandidates } from './validate.js';
import { candidate, handleOfKind, oneCandidatePerOpportunity, world } from './testing/world.js';
import { requirement } from './testing/fixture.js';

/*
 * M6-R1: the baseline reproductions of the two pure R9A P2 failures. They assert the CORRECT behaviour, so they FAIL on the failed R9A head and pass once repaired.
 */

describe('R9A P2-3: neutral official terminology', () => {
  it('a legitimate “Fraud Prevention” track is not an accusation', () => {
    const { closed } = world({
      tracks: {
        declared: [{ key: 'fraud', name: 'Fraud Prevention' }],
        unassessedTrackRubrics: [],
      },
      requirements: [
        requirement('r-fraud', { trackKey: 'fraud', text: 'Must detect suspicious transactions.' }),
      ],
    });
    const opportunity = handleOfKind(closed, 'requirement_unaddressed');
    const result = validateCandidates(
      {
        candidates: [
          candidate({
            opportunities: [opportunity],
            mode: 'demonstrate',
            text: 'Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?',
          }),
        ],
      },
      closed,
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });
});

describe('R9A P2-4: the shortfall names the real stopping cause', () => {
  it('six valid candidates that all fall below the minimum marginal value are NOT reported as repeats', () => {
    const { report, closed } = world();
    const raw = oneCandidatePerOpportunity(closed, {
      mode: 'ask',
      distinguishes: 'weak',
      effort: 'extended',
    });
    const validated = validateCandidates({ candidates: raw }, closed);
    const ranked = rankCandidates(validated.accepted, report.opportunities).map((r) => ({
      ...r,
      valueBp: 200,
    }));
    expect(ranked.length).toBeGreaterThanOrEqual(5);
    const selection = selectQuestions(ranked, {
      opportunities: report.opportunities.length,
      rejections: [],
    });
    expect(selection.selected).toHaveLength(0);
    expect(selection.shortfall?.code).not.toBe('redundant_candidates');
    expect(selection.shortfall?.explanation).not.toMatch(/repeated a question/);
  });
});
