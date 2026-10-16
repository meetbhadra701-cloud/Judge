import type { TrackContext } from '../../lib/tracks';

/**
 * Track selection for the submission forms (P6D). Renders nothing when the locked Event Context defines no track. The choices and the version
 * token come from the locked context the page loaded; the API validates both again.
 */
export function TrackSelector({
  context,
  selected,
  error,
}: {
  context: TrackContext | null;
  selected: readonly string[];
  error?: string | undefined;
}) {
  if (context === null || context.tracks.length === 0) return null;
  const chosen = new Set(selected);
  return (
    <fieldset aria-describedby="tracks-help" aria-invalid={error ? true : undefined}>
      <legend>Tracks this project competes in</legend>
      <input type="hidden" name="contextVersionId" value={context.contextVersionId} />
      <p id="tracks-help">
        <small>
          Tick every track the team entered, or none. The choice is recorded with the submission and
          is not edited afterwards (to change it, an organizer voids the submission and submits it
          again).
        </small>
      </p>
      {context.tracks.map((track) => (
        <label key={track.key} className="inline" data-testid={`track-option-${track.key}`}>
          <input
            type="checkbox"
            name="trackKeys"
            value={track.key}
            defaultChecked={chosen.has(track.key)}
          />{' '}
          {track.name}
          {track.description ? <small> — {track.description}</small> : null}
        </label>
      ))}
      {context.hasEventWideReference ? null : (
        <p className="notice" role="note" data-testid="track-required-notice">
          This hackathon’s Event Context has no event-wide explicit rule or requirement, so a
          preliminary report can only refer to the tracks selected here.{' '}
          <strong>Without a track the report cannot be requested</strong> for this project, and a
          track cannot be added later.
        </p>
      )}
      {error ? (
        <p id="tracks-error" role="alert" className="error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
