import type {
  ClaimsPage,
  ContradictionRecord,
  ContradictionsPage,
  EvidenceGraphSummary,
  EvidencePage,
  ProjectDetail,
  UnknownsPage,
} from '@judge-copilot/schemas';
import Link from 'next/link';
import { apiRequest, projectPath } from '../../../../lib/api';
import { ErrorBanner } from '../../../components/ui';

export const dynamic = 'force-dynamic';

const PAGE = 'limit=200';

/**
 * Read-only evidence graph view (M3). Everything shown is untrusted project material rendered as
 * plain React text (escaped); nothing here is scored, ranked or generated, and there is no AI
 * action. A claim existing does not make it true, an unknown or an absence is not a negative, and
 * a contradiction is a note for the judge, never an accusation.
 */
export default async function EvidenceGraphPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const base = projectPath(projectId);
  const [project, summary, claims, evidence, unknowns, contradictions] = await Promise.all([
    apiRequest<ProjectDetail>('GET', base),
    apiRequest<EvidenceGraphSummary>('GET', `${base}/evidence-graph`),
    apiRequest<ClaimsPage>('GET', `${base}/claims?${PAGE}`),
    apiRequest<EvidencePage>('GET', `${base}/evidence?${PAGE}`),
    apiRequest<UnknownsPage>('GET', `${base}/unknowns?${PAGE}`),
    apiRequest<ContradictionsPage>('GET', `${base}/contradictions?${PAGE}`),
  ]);
  if (!project.ok) {
    return (
      <main>
        <p>
          <Link href="/">← Events</Link>
        </p>
        <ErrorBanner message={project.message} />
      </main>
    );
  }
  if (!(summary.ok && claims.ok && evidence.ok && unknowns.ok && contradictions.ok)) {
    const failure = [summary, claims, evidence, unknowns, contradictions].flatMap((result) =>
      result.ok ? [] : [result.message],
    )[0];
    return (
      <main>
        <p>
          <Link href={base}>← {project.data.name}</Link>
        </p>
        <ErrorBanner message={failure} />
      </main>
    );
  }

  const claimText = new Map(claims.data.items.map((claim) => [claim.id, claim.text]));
  const evidenceText = new Map(evidence.data.items.map((item) => [item.id, item.text]));
  const sideLabel = (side: ContradictionRecord['sideA']) => {
    const text = (side.type === 'claim' ? claimText : evidenceText).get(side.id);
    return `${side.type}: ${text ?? side.id}`;
  };
  const supersededIds = new Set(
    claims.data.items.flatMap((claim) => (claim.supersedesId ? [claim.supersedesId] : [])),
  );
  const truncated = [claims, evidence, unknowns, contradictions].some(
    (page) => page.data.page.nextAfter !== null,
  );

  return (
    <main>
      <p>
        <Link href={base}>← {project.data.name}</Link>
      </p>
      <h1>Evidence graph</h1>
      <p className="notice">
        Read-only. Claims, evidence, unknowns and contradictions are immutable records. Nothing here
        is scored: a claim existing does not make it true, missing evidence is not negative
        evidence, and a contradiction is a note for a judge to review. Captured text is untrusted
        data.
      </p>

      <section>
        <h2>Summary</h2>
        <p>
          {summary.data.claims.total} claims ({summary.data.claims.current} current,{' '}
          {summary.data.claims.superseded} superseded) · {summary.data.evidence.total} evidence
          items · {summary.data.relations.total} relations · {summary.data.unknowns.total} unknowns
          · {summary.data.contradictions.total} contradictions
        </p>
        {truncated ? <p>Showing the first 200 records of each list.</p> : null}
      </section>

      <section>
        <h2>Claims</h2>
        {claims.data.items.length === 0 ? (
          <p>No claims have been recorded for this project.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Verification</th>
                <th>History</th>
              </tr>
            </thead>
            <tbody>
              {claims.data.items.map((claim) => (
                <tr key={claim.id}>
                  <td>
                    <Link href={`${base}/evidence/claims/${claim.id}`}>{claim.text}</Link>
                  </td>
                  <td>
                    <span className="badge">{claim.verificationLevel}</span>
                  </td>
                  <td>
                    {supersededIds.has(claim.id) ? 'superseded' : 'current'}
                    {claim.supersedesId ? ' · supersedes an earlier version' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Evidence</h2>
        {evidence.data.items.length === 0 ? (
          <p>No evidence has been recorded for this project.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Evidence</th>
                <th>Kind</th>
                <th>Origin</th>
                <th>Verification</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {evidence.data.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.text}</td>
                  <td>{item.kind}</td>
                  <td>{item.origin}</td>
                  <td>
                    <span className="badge">{item.verificationLevel}</span>
                  </td>
                  <td>
                    {item.provenance.snapshotId ? (
                      <Link href={`${base}/snapshots/${item.provenance.snapshotId}`}>snapshot</Link>
                    ) : item.provenance.contextVersionId ? (
                      <small>event context version</small>
                    ) : (
                      '—'
                    )}
                    {item.provenance.span ? (
                      <small>
                        {' '}
                        · {item.provenance.span.start}–{item.provenance.span.end} (code points)
                      </small>
                    ) : null}
                    {item.provenance.excerpt ? <pre>{item.provenance.excerpt}</pre> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Unknowns</h2>
        {unknowns.data.items.length === 0 ? (
          <p>No unknowns have been recorded.</p>
        ) : (
          <ul>
            {unknowns.data.items.map((unknown) => (
              <li key={unknown.id}>
                <span className="badge">{unknown.unknownType}</span> {unknown.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Contradictions (for judge review)</h2>
        {contradictions.data.items.length === 0 ? (
          <p>No contradictions have been recorded.</p>
        ) : (
          <ul>
            {contradictions.data.items.map((contradiction) => (
              <li key={contradiction.id}>
                {contradiction.description}
                <br />
                <small>{sideLabel(contradiction.sideA)}</small>
                <br />
                <small>{sideLabel(contradiction.sideB)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
