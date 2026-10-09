import { describe, expect, it } from 'vitest';
import { routeArtifact, SKIP_REASON_VALUES, type ArtifactDescriptor } from './routing.js';

const d = (
  sourceType: ArtifactDescriptor['sourceType'],
  key: string,
  kind: string,
  mediaType = 'text/plain',
): ArtifactDescriptor => ({ sourceType, key, kind, mediaType });

describe('source-routing/v1 (pinned against the artifact keys the M2 adapters produce)', () => {
  it('routes Devpost submission text as statements and its structured twin nowhere', () => {
    expect(routeArtifact(d('devpost', 'submission.txt', 'submission_text'))).toMatchObject({
      route: 'statement',
      priority: 1,
    });
    expect(
      routeArtifact(d('devpost', 'submission.json', 'submission', 'application/json')),
    ).toEqual({ route: 'skip', reason: 'duplicate_structured_form' });
  });

  it('routes README and documentation as statements, source and configuration as interpretation', () => {
    expect(routeArtifact(d('github', 'files/README.md', 'file', 'text/markdown'))).toMatchObject({
      route: 'statement',
      bucket: 'statement',
    });
    expect(
      routeArtifact(d('github', 'files/docs/guide.md', 'file', 'text/markdown')),
    ).toMatchObject({ route: 'statement' });
    expect(routeArtifact(d('github', 'files/src/app.ts', 'file'))).toMatchObject({
      route: 'interpret',
      bucket: 'source',
      artifactClass: 'source_code',
    });
    expect(
      routeArtifact(d('github', 'files/package.json', 'file', 'application/json')),
    ).toMatchObject({ route: 'interpret', bucket: 'source', artifactClass: 'repository_metadata' });
    expect(
      routeArtifact(d('github', 'repository.json', 'repository_metadata', 'application/json')),
    ).toMatchObject({
      route: 'interpret',
      bucket: 'metadata',
      artifactClass: 'repository_metadata',
    });
  });

  it('never shows commit history, the tree listing or the omissions list to a model', () => {
    expect(
      routeArtifact(d('github', 'commits.json', 'commit_history', 'application/json')),
    ).toEqual({ route: 'skip', reason: 'commit_history_not_routed' });
    expect(routeArtifact(d('github', 'tree.json', 'tree', 'application/json'))).toEqual({
      route: 'skip',
      reason: 'listing_only',
    });
    expect(routeArtifact(d('github', 'omissions.json', 'omissions', 'application/json'))).toEqual({
      route: 'skip',
      reason: 'code_authored_source_gap',
    });
  });

  it('routes deployment page text as a statement and HTTP observations as interpretation', () => {
    expect(routeArtifact(d('deployment', 'page.txt', 'page_text'))).toMatchObject({
      route: 'statement',
    });
    expect(
      routeArtifact(d('deployment', 'response.json', 'http_response', 'application/json')),
    ).toMatchObject({ route: 'interpret', artifactClass: 'deployment_observation' });
    expect(
      routeArtifact(d('deployment', 'page.json', 'page_metadata', 'application/json')),
    ).toMatchObject({ route: 'interpret', artifactClass: 'deployment_observation' });
  });

  it('routes video metadata as a statement', () => {
    expect(
      routeArtifact(d('video', 'metadata.json', 'video_metadata', 'application/json')),
    ).toMatchObject({ route: 'statement', priority: 4 });
  });

  it('fails closed on anything it does not recognize, including a known key with the wrong kind', () => {
    expect(routeArtifact(d('devpost', 'something-new.txt', 'submission_text'))).toEqual({
      route: 'skip',
      reason: 'unrecognized_artifact',
    });
    expect(routeArtifact(d('devpost', 'submission.txt', 'http_response'))).toEqual({
      route: 'skip',
      reason: 'unrecognized_artifact',
    });
    expect(routeArtifact(d('github', 'files-evil/README.md', 'file', 'text/markdown'))).toEqual({
      route: 'skip',
      reason: 'unrecognized_artifact',
    });
    expect(routeArtifact(d('video', 'transcript.txt', 'video_metadata'))).toEqual({
      route: 'skip',
      reason: 'unrecognized_artifact',
    });
    expect(SKIP_REASON_VALUES).toContain('unrecognized_artifact');
  });
});
