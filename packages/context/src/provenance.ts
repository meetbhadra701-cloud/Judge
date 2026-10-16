import type { EventSourceAuthority, StatementBasis } from '@judge-copilot/schemas';

/*
 * What kind of statement an Event Context fact is, decided by code from two stored facts: its `certainty` and the AUTHORITY of the sources it cites
 * (M6 phase 0, R8B P3-1). One function serves the editor, the lock gate, the API response and the assessment input, so the four can never disagree.
 *
 *   official              `explicit` AND at least one cited source has an official authority (official event rules, judging rubric or track rules).
 *   organizer_interpreted `interpreted`: the organizer's own reading of the sources. Never reference evidence for an assessment.
 *   unverified            everything else: `unclear`, or `explicit` that cites no official source (nothing in the sources backs the "explicit").
 *
 * An `explicit` label alone never makes a statement official: a person with the organizer role may write any label through the API, so the label is
 * only trusted together with an official source. Organizer guidance is a different kind of item (advice to judges) and has no basis here.
 */

export const OFFICIAL_SOURCE_AUTHORITIES: ReadonlySet<EventSourceAuthority> =
  new Set<EventSourceAuthority>([
    'official_event_rules',
    'official_judging_rubric',
    'official_track_rules',
  ]);

type AuthorityOf = ReadonlyMap<string, EventSourceAuthority>;

export function isOfficialAuthority(authority: EventSourceAuthority | undefined): boolean {
  return authority !== undefined && OFFICIAL_SOURCE_AUTHORITIES.has(authority);
}

/** True when at least one of `sourceIds` is a source of an official authority (an unknown id counts for nothing). */
export function citesOfficialSource(
  sourceIds: readonly string[],
  authorities: AuthorityOf,
): boolean {
  return sourceIds.some((id) => isOfficialAuthority(authorities.get(id)));
}

export function statementBasisOf(
  fact: {
    readonly certainty: 'explicit' | 'interpreted' | 'unclear';
    readonly sourceIds: readonly string[];
  },
  authorities: AuthorityOf,
): StatementBasis {
  if (fact.certainty === 'interpreted') return 'organizer_interpreted';
  if (fact.certainty === 'explicit' && citesOfficialSource(fact.sourceIds, authorities)) {
    return 'official';
  }
  return 'unverified';
}
