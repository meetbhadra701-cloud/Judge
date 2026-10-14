import type { ProjectDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { voidedNotice } from '../../../../lib/submission';
import { CorrectForm } from './correct-form';

/* Presentation of the correction page (P6B-beta2), separate from fetching so it can be rendered in a test with plain data. */

export interface CorrectViewProps {
  readonly project: ProjectDetail;
  /** Request identity of this rendering of the form (a UUID, generated per page load). */
  readonly correctionKey: string;
}

export function CorrectView({ project, correctionKey }: CorrectViewProps): ReactNode {
  const notice = voidedNotice(project);
  return (
    <main>
      <p>
        <Link href={`/projects/${project.id}/capture`}>← {project.name}</Link>
      </p>
      <h1>Void and replace a submission</h1>
      <p className="notice" role="note">
        <strong>Nothing is edited or deleted.</strong> A submission cannot be changed in place.
        Voiding marks this project as erroneous with the reason you give; everything captured and
        assessed for it stays on record exactly as it was, and its reports stay readable. It stops
        accepting new captures, sources and assessments, and its links are released so the corrected
        submission can use them. This action is recorded and cannot be undone.
      </p>
      <section aria-labelledby="current-heading">
        <h2 id="current-heading">This project</h2>
        <ul>
          {project.sources
            .filter((source) => source.sourceType === 'github' || source.sourceType === 'devpost')
            .map((source) => (
              <li key={source.id}>
                {source.sourceType === 'github' ? 'GitHub' : 'Devpost'}: <code>{source.url}</code>
              </li>
            ))}
        </ul>
      </section>
      {notice !== null ? (
        <p role="status" data-testid="already-voided">
          {notice} <Link href={`/projects/${project.id}`}>Open the project →</Link>
        </p>
      ) : (
        <section aria-labelledby="void-heading">
          <h2 id="void-heading">Correction</h2>
          <p>
            If a capture is still in progress, wait for it to finish first: the correction is
            refused, and nothing changes, while work on the project is pending.
          </p>
          <CorrectForm projectId={project.id} correctionKey={correctionKey} />
        </section>
      )}
    </main>
  );
}
