import type { ProjectDetail } from '@judge-copilot/schemas';
import { apiRequest, projectPath } from '../../../../../lib/api';
import { captureFingerprint, overviewOf } from '../../../../../lib/capture-status';

export const dynamic = 'force-dynamic';

/**
 * A tiny read-only progress probe for the capture page's checker: the page polls THIS (plain JSON, no router involvement) and asks
 * Next.js to re-render only when the fingerprint changed. Reads exactly what the page reads; it starts, retries and changes nothing.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const project = await apiRequest<ProjectDetail>('GET', projectPath(projectId));
  if (!project.ok) {
    return Response.json(
      { ok: false },
      { status: project.status >= 400 && project.status < 600 ? project.status : 502 },
    );
  }
  return Response.json({
    ok: true,
    fingerprint: captureFingerprint(project.data),
    anyWaiting: overviewOf(project.data.sources).anyWaiting,
  });
}
