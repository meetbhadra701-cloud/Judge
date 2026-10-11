/* Test-only: stored-artifact fixtures for pure tests (excluded from the build). */
import type { SourceArtifact } from '@judge-copilot/assessment';
import { createHash } from 'node:crypto';

const id = (text: string): string => {
  const hex = createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export function artifact(
  overrides: Partial<SourceArtifact> & Pick<SourceArtifact, 'key' | 'text'>,
): SourceArtifact {
  const sourceType = overrides.sourceType ?? 'github';
  return {
    snapshotId: id(`snapshot:${sourceType}`),
    artifactId: id(`artifact:${sourceType}:${overrides.key}`),
    sourceType,
    snapshotStatus: 'captured',
    kind:
      sourceType === 'github' ? 'file' : sourceType === 'devpost' ? 'submission_text' : 'page_text',
    mediaType: 'text/plain',
    ...overrides,
  };
}
