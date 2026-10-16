import type { EventContextLockedSnapshot } from '@judge-copilot/schemas';

/*
 * P6D: what the submission forms need to know about the event's LOCKED Event Context to offer track selection. Pure functions over the
 * locked snapshot the API already serves (`GET /events/:id/context`); nothing here decides anything the API does not re-check.
 */

export interface TrackChoice {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
}

export interface TrackContext {
  /** The locked version the choices were read from: the form sends it back so a stale selection is refused, not applied. */
  readonly contextVersionId: string;
  readonly tracks: readonly TrackChoice[];
  /**
   * True when the context has event-wide reference material an assessment can refer to without any track (an explicit rule, or an explicit
   * requirement that belongs to no track). This mirrors the assessment preflight (`buildEventReferenceItems`) for DISPLAY only; the API is the authority.
   */
  readonly hasEventWideReference: boolean;
}

export function trackContextOf(snapshot: EventContextLockedSnapshot): TrackContext {
  const { document } = snapshot;
  return {
    contextVersionId: snapshot.versionId,
    tracks: document.tracks.map((track) => ({
      key: track.key,
      name: track.name,
      description: track.description,
    })),
    hasEventWideReference:
      document.rules.some((rule) => rule.certainty === 'explicit') ||
      document.submissionRequirements.some(
        (requirement) => requirement.trackKey === null && requirement.certainty === 'explicit',
      ),
  };
}

/**
 * The track keys a form posted: only strings, unique and sorted (anything else is dropped, not guessed). Whether a key exists in the locked
 * context is the API's decision (UNKNOWN_TRACK), never this function's.
 */
export function postedTrackKeys(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort();
}
