import type {
  ArtifactProvenanceFacts,
  ClaimRecord,
  ContextVersionProvenanceFacts,
  EvidenceRecord,
  SnapshotProvenanceFacts,
} from '@judge-copilot/schemas';
import type { GraphIssueCode } from './issues.js';

/*
 * The authoritative set of entities a reference may point at. Persistence adapters build it from
 * the database for exactly the IDs a batch mentions, looking in EVERY project, so that a
 * reference can be classified precisely: nonexistent, the wrong kind of entity, or an entity of
 * another project. A well-formed UUID proves none of these.
 */

export type KnownEntityType = 'claim' | 'evidence' | 'snapshot' | 'artifact' | 'context_version';

export interface KnownClaim extends ClaimRecord {
  /** The claim that supersedes this one, if any (at most one). */
  successorId: string | null;
}

export interface ArtifactFacts extends ArtifactProvenanceFacts {
  /**
   * The artifact's stored text between two code-point offsets (half-open). Supplied only when
   * the caller can read the text (the database adapter prefetches the spans a batch uses).
   */
  slice?: (start: number, end: number) => string | undefined;
}

export interface KnownEntities {
  readonly claims: ReadonlyMap<string, KnownClaim>;
  readonly evidence: ReadonlyMap<string, EvidenceRecord>;
  readonly snapshots: ReadonlyMap<string, SnapshotProvenanceFacts>;
  readonly artifacts: ReadonlyMap<string, ArtifactFacts>;
  readonly contextVersions: ReadonlyMap<string, ContextVersionProvenanceFacts>;
}

export const NO_KNOWN_ENTITIES: KnownEntities = {
  claims: new Map(),
  evidence: new Map(),
  snapshots: new Map(),
  artifacts: new Map(),
  contextVersions: new Map(),
};

/** What owns the references: the project being written and its event. */
export interface GraphScope {
  readonly projectId: string;
  readonly eventId: string;
}

export function entityTypeOf(known: KnownEntities, id: string): KnownEntityType | null {
  if (known.claims.has(id)) return 'claim';
  if (known.evidence.has(id)) return 'evidence';
  if (known.snapshots.has(id)) return 'snapshot';
  if (known.artifacts.has(id)) return 'artifact';
  if (known.contextVersions.has(id)) return 'context_version';
  return null;
}

const NOT_FOUND_CODE: Record<KnownEntityType, GraphIssueCode> = {
  claim: 'CLAIM_NOT_FOUND',
  evidence: 'EVIDENCE_NOT_FOUND',
  snapshot: 'SNAPSHOT_NOT_FOUND',
  artifact: 'ARTIFACT_NOT_FOUND',
  context_version: 'CONTEXT_VERSION_NOT_FOUND',
};

const LABEL: Record<KnownEntityType, string> = {
  claim: 'claim',
  evidence: 'evidence item',
  snapshot: 'source snapshot',
  artifact: 'snapshot artifact',
  context_version: 'event context version',
};

interface ByType {
  claim: KnownClaim;
  evidence: EvidenceRecord;
  snapshot: SnapshotProvenanceFacts;
  artifact: ArtifactFacts;
  context_version: ContextVersionProvenanceFacts;
}

export type Resolved<T extends KnownEntityType> =
  { ok: true; entity: ByType[T] } | { ok: false; code: GraphIssueCode; message: string };

/**
 * Resolves `id` as an entity of type `expected` inside `scope`:
 *   - not known at all             -> `<TYPE>_NOT_FOUND`
 *   - known, but another type      -> `WRONG_ENTITY_TYPE`
 *   - of another project / event   -> `CROSS_PROJECT_REFERENCE`
 * Checks run in that order, so classification is deterministic.
 */
export function resolveKnown<T extends KnownEntityType>(
  known: KnownEntities,
  id: string,
  expected: T,
  scope: GraphScope,
): Resolved<T> {
  const actual = entityTypeOf(known, id);
  if (actual === null) {
    return {
      ok: false,
      code: NOT_FOUND_CODE[expected],
      message: `The referenced ${LABEL[expected]} does not exist`,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      code: 'WRONG_ENTITY_TYPE',
      message: `The referenced ID is a ${LABEL[actual]}, but a ${LABEL[expected]} is required`,
    };
  }
  const entity = lookup(known, expected, id);
  if (!belongsToScope(known, expected, entity, scope)) {
    return {
      ok: false,
      code: 'CROSS_PROJECT_REFERENCE',
      message: `The referenced ${LABEL[expected]} belongs to another project`,
    };
  }
  return { ok: true, entity: entity as ByType[T] };
}

function lookup(known: KnownEntities, type: KnownEntityType, id: string): unknown {
  switch (type) {
    case 'claim':
      return known.claims.get(id);
    case 'evidence':
      return known.evidence.get(id);
    case 'snapshot':
      return known.snapshots.get(id);
    case 'artifact':
      return known.artifacts.get(id);
    case 'context_version':
      return known.contextVersions.get(id);
  }
}

function belongsToScope(
  known: KnownEntities,
  type: KnownEntityType,
  entity: unknown,
  scope: GraphScope,
): boolean {
  switch (type) {
    case 'claim':
    case 'evidence':
    case 'snapshot':
      return (entity as { projectId: string }).projectId === scope.projectId;
    case 'artifact': {
      const snapshot = known.snapshots.get((entity as ArtifactFacts).snapshotId);
      return snapshot?.projectId === scope.projectId;
    }
    case 'context_version':
      return (entity as ContextVersionProvenanceFacts).eventId === scope.eventId;
  }
}
