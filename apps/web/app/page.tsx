import type { Metadata } from 'next';
import type { EventRecord } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest } from '../lib/api';
import { openMessage } from '../lib/flash';
import { createEventAction } from './actions';
import { ErrorBanner } from './components/ui';

// the root layout's title template applies to child segments only, so the home page states its full title
export const metadata: Metadata = { title: { absolute: 'Events · Judge Copilot' } };

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error: sealedError } = await searchParams;
  // only a message this server sealed is shown; a hand-written ?error= link shows nothing (lib/flash.ts)
  const error = openMessage(sealedError) ?? undefined;
  const result = await apiRequest<{ events: EventRecord[] }>('GET', '/events');

  return (
    <main>
      <h1>Judge Copilot</h1>
      <p>
        Human-in-the-loop hackathon judging. Milestone 1 sets up each event&apos;s official context
        (rules, rubric, tracks) and locks it before any project is judged. The human judge&apos;s
        final score is always authoritative.
      </p>
      <ErrorBanner message={error} />

      <section>
        <h2>Events</h2>
        {!result.ok ? (
          <ErrorBanner message={result.message} />
        ) : result.data.events.length === 0 ? (
          <p>No events yet.</p>
        ) : (
          <ul>
            {result.data.events.map((event) => (
              <li key={event.id}>
                <Link href={`/events/${event.id}`}>{event.name}</Link> <code>{event.slug}</code> ·{' '}
                <Link href={`/events/${event.id}/submit`}>Submit a project</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Create event</h2>
        <form action={createEventAction} className="stack">
          <label>
            Name <input name="name" required maxLength={200} />
          </label>
          <label>
            Slug (lowercase, hyphens){' '}
            <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100} />
          </label>
          <button type="submit">Create event</button>
        </form>
      </section>
    </main>
  );
}
