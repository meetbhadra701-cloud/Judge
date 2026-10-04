import type { EventSourceAuthority } from '@judge-copilot/schemas';

/**
 * Explicit precedence of event-context source authorities (higher wins). Precedence is defined
 * by this table, never by the order of a values array. Official event material outranks generic
 * judging assumptions (invariant 1).
 */
export const SOURCE_AUTHORITY_PRECEDENCE = {
  official_event_rules: 100,
  official_judging_rubric: 95,
  official_track_rules: 90,
  organizer_guidance: 85,
  judge_context: 60,
  universal_fallback: 40,
} as const satisfies Record<EventSourceAuthority, number>;

export function authorityRank(authority: EventSourceAuthority): number {
  return SOURCE_AUTHORITY_PRECEDENCE[authority];
}

/** Sorts authorities from highest to lowest precedence. */
export function compareAuthorityDescending(
  a: EventSourceAuthority,
  b: EventSourceAuthority,
): number {
  return authorityRank(b) - authorityRank(a);
}
