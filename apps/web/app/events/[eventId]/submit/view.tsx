import type { EventDetail, EventRecord } from '@judge-copilot/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { TrackContext } from '../../../../lib/tracks';
import { SubmitForm } from './submit-form';

/* Presentation of the submit page (P6B-alpha), separate from fetching so it can be rendered in a test with plain data. */

export interface SubmitViewProps {
  readonly event: EventRecord;
  /** The locked Event Context version, or null when the hackathon has none. */
  readonly locked: EventDetail['versions'][number] | null;
  readonly rubric: { readonly name: string; readonly criteriaCount: number } | null;
  /** The locked context's tracks (P6D), or null when the context could not be read. */
  readonly trackContext?: TrackContext | null;
  /** Request identity of this rendering of the form (a UUID, generated per page load). */
  readonly submissionKey: string;
}

export function SubmitView({
  event,
  locked,
  rubric,
  trackContext = null,
  submissionKey,
}: SubmitViewProps): ReactNode {
  return (
    <main>
      <p>
        <Link href={`/events/${event.id}`}>← {event.name}</Link>
      </p>
      <h1>Submit a project</h1>
      <p className="notice" role="note">
        <strong>Temporary offline workflow.</strong> Submitting only registers your two links and
        asks a worker to <em>capture</em> the public pages. Capturing is not an AI analysis, and
        nothing here calls a live model. The preliminary report is a separate, explicit step on the
        next pages; in this version it runs offline on a demonstration provider (recorded answers or
        fixed placeholders, stated at the top of the report), never on a live model.
      </p>

      <section aria-labelledby="event-heading">
        <h2 id="event-heading">Hackathon</h2>
        <p data-testid="active-event">
          <strong>{event.name}</strong> <code>{event.slug}</code>
        </p>
        {locked ? (
          <p data-testid="active-context">
            Judged against the locked Event Context <strong>v{locked.version}</strong>
            {rubric ? (
              <>
                {' '}
                · overall rubric “{rubric.name}” ({rubric.criteriaCount} criteria)
              </>
            ) : (
              <> · no overall rubric</>
            )}
            . <Link href={`/events/${event.id}/versions/${locked.id}`}>View it</Link>
          </p>
        ) : (
          <p role="alert" className="error">
            This hackathon has no locked Event Context. Projects can be submitted only against a
            locked context. <Link href={`/events/${event.id}`}>Set one up first →</Link>
          </p>
        )}
      </section>

      {locked ? (
        <section aria-labelledby="links-heading">
          <h2 id="links-heading">Project links</h2>
          <SubmitForm
            eventId={event.id}
            submissionKey={submissionKey}
            trackContext={trackContext}
          />
        </section>
      ) : null}
    </main>
  );
}
