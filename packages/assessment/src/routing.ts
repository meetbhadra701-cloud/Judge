import { classifyRepositoryArtifact } from '@judge-copilot/evidence';

/*
 * source-routing/v1: which stored artifact is shown to which model stage. It is pinned against the artifact keys the M2 adapters
 * ACTUALLY produce (packages/devpost, github, deployment, video adapters); tests/integration/assessment-source-routing.test.ts
 * fails if an adapter emits a key this table does not decide, so the table cannot silently drift from M2.
 *
 *   statement   team-authored prose: the model extracts CLAIMS (S2). Evidence derived from it is `kind=claim`, `team_claim`.
 *   interpret   repository files / metadata / deployment observations: the model reports FACTS (S3), `unverified`.
 *   skip        deliberately not shown (with a stable reason that is recorded, never hidden).
 *
 * Decisions that are NOT obvious, and why:
 *   - A repository file is "prose" or "code" by M3's own classifier (`classifyRepositoryArtifact`), so README/docs are statements
 *     and everything else is interpreted; a configuration/manifest file the classifier cannot call source is `repository_metadata`
 *     (it is a repository fact, but not source code and never a corroborating channel).
 *   - `commits.json` is skipped: commit messages are team prose, and commit counts or volume must never become a signal.
 *   - `submission.json` is skipped: it is the structured form of `submission.txt`; showing both would double-count one statement.
 */

export const SOURCE_ROUTING_POLICY = 'source-routing/v1' as const;

export const SOURCE_TYPE_VALUES = ['devpost', 'github', 'deployment', 'video'] as const;
export type RoutedSourceType = (typeof SOURCE_TYPE_VALUES)[number];

export type InterpretClass = 'source_code' | 'repository_metadata' | 'deployment_observation';

export const SKIP_REASON_VALUES = [
  'duplicate_structured_form',
  'listing_only',
  'commit_history_not_routed',
  'code_authored_source_gap',
  'unrecognized_artifact',
] as const;
export type SkipReason = (typeof SKIP_REASON_VALUES)[number];

/** Selection buckets with separate code-point budgets (design §12.3.2). */
export type Bucket = 'statement' | 'source' | 'metadata';

export interface ArtifactDescriptor {
  readonly sourceType: RoutedSourceType;
  readonly key: string;
  readonly kind: string;
  readonly mediaType: string;
}

export type RouteDecision =
  | {
      readonly route: 'statement';
      readonly bucket: 'statement';
      /** Selection priority class, lower first (design §12.3.2 item 1). */
      readonly priority: number;
    }
  | {
      readonly route: 'interpret';
      readonly bucket: 'source' | 'metadata';
      readonly artifactClass: InterpretClass;
      readonly priority: number;
    }
  | { readonly route: 'skip'; readonly reason: SkipReason };

const SKIP = (reason: SkipReason): RouteDecision => ({ route: 'skip', reason });

export function routeArtifact(descriptor: ArtifactDescriptor): RouteDecision {
  const { sourceType, key, kind } = descriptor;
  switch (sourceType) {
    case 'devpost':
      if (key === 'submission.txt' && kind === 'submission_text') {
        return { route: 'statement', bucket: 'statement', priority: 1 };
      }
      return key === 'submission.json'
        ? SKIP('duplicate_structured_form')
        : SKIP('unrecognized_artifact');
    case 'github': {
      if (kind === 'file' && key.startsWith('files/')) {
        const cls = classifyRepositoryArtifact({ key, kind, mediaType: descriptor.mediaType });
        if (cls === 'team_prose') return { route: 'statement', bucket: 'statement', priority: 2 };
        if (cls === 'source_code') {
          return {
            route: 'interpret',
            bucket: 'source',
            artifactClass: 'source_code',
            priority: 6,
          };
        }
        return {
          route: 'interpret',
          bucket: 'source',
          artifactClass: 'repository_metadata',
          priority: 6,
        };
      }
      if (key === 'repository.json' && kind === 'repository_metadata') {
        return {
          route: 'interpret',
          bucket: 'metadata',
          artifactClass: 'repository_metadata',
          priority: 5,
        };
      }
      if (key === 'commits.json') return SKIP('commit_history_not_routed');
      if (key === 'tree.json') return SKIP('listing_only');
      if (key === 'omissions.json') return SKIP('code_authored_source_gap');
      return SKIP('unrecognized_artifact');
    }
    case 'deployment':
      if (key === 'page.txt' && kind === 'page_text') {
        return { route: 'statement', bucket: 'statement', priority: 3 };
      }
      if (
        (key === 'response.json' && kind === 'http_response') ||
        (key === 'page.json' && kind === 'page_metadata')
      ) {
        return {
          route: 'interpret',
          bucket: 'metadata',
          artifactClass: 'deployment_observation',
          priority: 3,
        };
      }
      return SKIP('unrecognized_artifact');
    case 'video':
      if (key === 'metadata.json' && kind === 'video_metadata') {
        return { route: 'statement', bucket: 'statement', priority: 4 };
      }
      return SKIP('unrecognized_artifact');
  }
}

/** The origin an evidence item derived from this source type carries. The strings coincide with M3's `EvidenceOrigin`. */
export const originOf = (sourceType: RoutedSourceType): RoutedSourceType => sourceType;
