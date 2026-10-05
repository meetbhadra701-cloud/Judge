import type { ClaimDetail } from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../../../lib/api';
import { ErrorBanner } from '../../../../../components/ui';

export const dynamic = 'force-dynamic';

/** One claim with the evidence that supports or contradicts it, as stored. Read-only, unscored. */
export default async function ClaimPage({
  params,
}: {
  params: Promise<{ projectId: string; claimId: string }>;
}) {
  const { projectId, claimId } = await params;
  const base = projectPath(projectId);
  const result = await apiRequest<ClaimDetail>(
    'GET',
    `${base}/claims/${encodeURIComponent(claimId)}`,
  );
  if (!result.ok) {
    return (
      <main>
        <p>
          <Link href={`${base}/evidence`}>← Evidence graph</Link>
        </p>
        <ErrorBanner message={result.message} />
      </main>
    );
  }
  const { claim, supporting, contradicting, unknowns, contradictions, supersession } = result.data;
  const links = [
    { title: 'Supporting evidence', items: supporting },
    { title: 'Contradicting evidence', items: contradicting },
  ];

  return (
    <main>
      <p>
        <Link href={`${base}/evidence`}>← Evidence graph</Link>
      </p>
      <h1>{claim.text}</h1>
      <p>
        <span className="badge">{claim.verificationLevel}</span>{' '}
        {supersession.isCurrent ? 'current version' : 'superseded by a later version'} · version{' '}
        {supersession.chain.indexOf(claim.id) + 1} of {supersession.chain.length}
      </p>
      <p className="notice">
        A claim is a statement relevant to the project. It is not true because it exists, and its
        verification level is stored with it, never computed from counts.
      </p>
      {supersession.chain.length > 1 ? (
        <section>
          <h2>Versions</h2>
          <ol>
            {supersession.chain.map((id) => (
              <li key={id}>
                {id === claim.id ? (
                  'this claim'
                ) : (
                  <Link href={`${base}/evidence/claims/${id}`}>{id}</Link>
                )}
                {id === supersession.currentId ? ' (current)' : ''}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {links.map(({ title, items }) => (
        <section key={title}>
          <h2>{title}</h2>
          {items.length === 0 ? (
            <p>None recorded.</p>
          ) : (
            <ul>
              {items.map(({ relationId, evidence }) => (
                <li key={relationId}>
                  {evidence.text}
                  <br />
                  <small>
                    {evidence.kind} · {evidence.origin} · {evidence.verificationLevel}
                    {evidence.provenance.snapshotId ? (
                      <>
                        {' · '}
                        <Link href={`${base}/snapshots/${evidence.provenance.snapshotId}`}>
                          snapshot
                        </Link>
                      </>
                    ) : null}
                  </small>
                  {evidence.provenance.excerpt ? <pre>{evidence.provenance.excerpt}</pre> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section>
        <h2>Unknowns</h2>
        {unknowns.length === 0 ? (
          <p>None recorded.</p>
        ) : (
          <ul>
            {unknowns.map((unknown) => (
              <li key={unknown.id}>
                <span className="badge">{unknown.unknownType}</span> {unknown.text}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Contradictions (for judge review)</h2>
        {contradictions.length === 0 ? (
          <p>None recorded.</p>
        ) : (
          <ul>
            {contradictions.map((contradiction) => (
              <li key={contradiction.id}>{contradiction.description}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
