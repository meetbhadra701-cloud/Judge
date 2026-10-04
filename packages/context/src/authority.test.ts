import { EVENT_SOURCE_AUTHORITY_VALUES, type EventSourceAuthority } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { authorityRank, compareAuthorityDescending, SOURCE_AUTHORITY_PRECEDENCE } from './index.js';

describe('source authority', () => {
  it('assigns the explicit documented precedence to every authority', () => {
    expect(SOURCE_AUTHORITY_PRECEDENCE).toEqual({
      official_event_rules: 100,
      official_judging_rubric: 95,
      official_track_rules: 90,
      organizer_guidance: 85,
      judge_context: 60,
      universal_fallback: 40,
    });
    expect(Object.keys(SOURCE_AUTHORITY_PRECEDENCE).sort()).toEqual(
      [...EVENT_SOURCE_AUTHORITY_VALUES].sort(),
    );
  });

  it('orders by the precedence table, not by array position', () => {
    const shuffled: EventSourceAuthority[] = [
      'judge_context',
      'universal_fallback',
      'official_track_rules',
      'official_event_rules',
      'organizer_guidance',
      'official_judging_rubric',
    ];
    expect([...shuffled].sort(compareAuthorityDescending)).toEqual([
      'official_event_rules',
      'official_judging_rubric',
      'official_track_rules',
      'organizer_guidance',
      'judge_context',
      'universal_fallback',
    ]);
    expect(authorityRank('official_event_rules')).toBeGreaterThan(authorityRank('judge_context'));
  });
});
