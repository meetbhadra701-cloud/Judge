import { z } from 'zod';
import {
  EvidenceKind,
  EvidenceOrigin,
  SourceSnapshotStatus,
  UnknownType,
  VerificationLevel,
} from './enums.js';
import {
  ContradictionSideType,
  EVIDENCE_GRAPH_LIMITS,
  EvidenceRelationType,
  GraphNodeType,
  SPAN_UNIT,
} from './evidence-graph.js';
import { Uuid } from './primitives.js';
import { ProjectSourceType, SnapshotArtifactKind } from './source-ingestion.js';

/*
 * Persisted records of the M3 evidence graph and the HTTP contract that exposes them
 * (apps/api, apps/web). Timestamps are ISO-8601 UTC strings. `seq` is the database insertion
 * sequence: the canonical, locale-independent ordering of every graph query.
 *
 * Nothing here is a score. There is no weight, strength, coverage, confidence or ranking field.
 */

const IsoDateTime = z.iso.datetime({ offset: true });
const Seq = z.number().int().min(1);

export const GraphNodeRef = z.object({ type: GraphNodeType, id: Uuid });
export type GraphNodeRef = z.infer<typeof GraphNodeRef>;

export const ContradictionSide = z.object({ type: ContradictionSideType, id: Uuid });
export type ContradictionSide = z.infer<typeof ContradictionSide>;

export const ClaimRecord = z.object({
  id: Uuid,
  projectId: Uuid,
  seq: Seq,
  text: z.string(),
  verificationLevel: VerificationLevel,
  /** The earlier claim this one supersedes (same project), or null. */
  supersedesId: Uuid.nullable(),
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type ClaimRecord = z.infer<typeof ClaimRecord>;

export const EvidenceSpan = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  unit: z.literal(SPAN_UNIT),
});
export type EvidenceSpan = z.infer<typeof EvidenceSpan>;

export const EvidenceProvenance = z.object({
  snapshotId: Uuid.nullable(),
  artifactId: Uuid.nullable(),
  span: EvidenceSpan.nullable(),
  /** The span's exact text, copied at creation and re-verified by the database. Data, not truth. */
  excerpt: z.string().nullable(),
  contextVersionId: Uuid.nullable(),
});
export type EvidenceProvenance = z.infer<typeof EvidenceProvenance>;

export const EvidenceRecord = z.object({
  id: Uuid,
  projectId: Uuid,
  eventId: Uuid,
  seq: Seq,
  kind: EvidenceKind,
  origin: EvidenceOrigin,
  verificationLevel: VerificationLevel,
  text: z.string(),
  provenance: EvidenceProvenance,
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const RelationRecord = z.object({
  id: Uuid,
  projectId: Uuid,
  seq: Seq,
  claimId: Uuid,
  evidenceId: Uuid,
  type: EvidenceRelationType,
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type RelationRecord = z.infer<typeof RelationRecord>;

export const UnknownRecord = z.object({
  id: Uuid,
  projectId: Uuid,
  seq: Seq,
  unknownType: UnknownType,
  text: z.string(),
  claimIds: z.array(Uuid),
  evidenceIds: z.array(Uuid),
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type UnknownRecord = z.infer<typeof UnknownRecord>;

export const ContradictionRecord = z.object({
  id: Uuid,
  projectId: Uuid,
  seq: Seq,
  /** Canonical order: `sideA` sorts before `sideB`, so (A, B) and (B, A) are one record. */
  sideA: ContradictionSide,
  sideB: ContradictionSide,
  /** Neutral description for a judge to review. Never a penalty, score or accusation. */
  description: z.string(),
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type ContradictionRecord = z.infer<typeof ContradictionRecord>;

// -- Source facts for provenance traces --------------------------------------------------------

export const SnapshotProvenanceFacts = z.object({
  id: Uuid,
  projectId: Uuid,
  sourceType: ProjectSourceType,
  captureNumber: z.number().int().min(1),
  status: SourceSnapshotStatus,
  revision: z.string().nullable(),
  contentHash: z.string().nullable(),
  capturedAt: IsoDateTime.nullable(),
});
export type SnapshotProvenanceFacts = z.infer<typeof SnapshotProvenanceFacts>;

export const ArtifactProvenanceFacts = z.object({
  id: Uuid,
  snapshotId: Uuid,
  key: z.string(),
  kind: SnapshotArtifactKind,
  mediaType: z.string(),
  byteLength: z.number().int().min(0),
  /** Length of the stored text in code points, the unit of every evidence span. */
  codePointLength: z.number().int().min(0),
  contentHash: z.string(),
});
export type ArtifactProvenanceFacts = z.infer<typeof ArtifactProvenanceFacts>;

export const ContextVersionProvenanceFacts = z.object({
  id: Uuid,
  eventId: Uuid,
  version: z.number().int().min(1),
  status: z.enum(['draft', 'in_review', 'locked', 'superseded']),
});
export type ContextVersionProvenanceFacts = z.infer<typeof ContextVersionProvenanceFacts>;

export const ProvenanceTrace = z.object({
  evidenceId: Uuid,
  origin: EvidenceOrigin,
  /** `source_snapshot` | `event_context_version` | `none` (nothing structural to follow). */
  kind: z.enum(['source_snapshot', 'event_context_version', 'none']),
  snapshot: SnapshotProvenanceFacts.nullable(),
  artifact: ArtifactProvenanceFacts.nullable(),
  span: EvidenceSpan.nullable(),
  excerpt: z.string().nullable(),
  contextVersion: ContextVersionProvenanceFacts.nullable(),
  /** Reference problems found while tracing (a valid graph has none). */
  issues: z.array(z.string()),
});
export type ProvenanceTrace = z.infer<typeof ProvenanceTrace>;

// -- Query results -----------------------------------------------------------------------------

export const SupersessionView = z.object({
  /** Oldest to newest. Always contains the queried claim. */
  chain: z.array(Uuid),
  predecessorId: Uuid.nullable(),
  successorId: Uuid.nullable(),
  /** The newest claim of the chain: the only one nothing supersedes. */
  currentId: Uuid,
  isCurrent: z.boolean(),
});
export type SupersessionView = z.infer<typeof SupersessionView>;

const Counted = <T extends z.ZodType>(value: T) =>
  z.object({ value, count: z.number().int().min(0) });

export const EvidenceGraphSummary = z.object({
  projectId: Uuid,
  claims: z.object({
    total: z.number().int(),
    current: z.number().int(),
    superseded: z.number().int(),
    byVerificationLevel: z.array(Counted(VerificationLevel)),
  }),
  evidence: z.object({
    total: z.number().int(),
    byKind: z.array(Counted(EvidenceKind)),
    byOrigin: z.array(Counted(EvidenceOrigin)),
    byVerificationLevel: z.array(Counted(VerificationLevel)),
  }),
  relations: z.object({
    total: z.number().int(),
    byType: z.array(Counted(EvidenceRelationType)),
  }),
  unknowns: z.object({ total: z.number().int(), byType: z.array(Counted(UnknownType)) }),
  contradictions: z.object({ total: z.number().int() }),
});
export type EvidenceGraphSummary = z.infer<typeof EvidenceGraphSummary>;

export const EvidenceLink = z.object({
  relationId: Uuid,
  type: EvidenceRelationType,
  evidence: EvidenceRecord,
});
export type EvidenceLink = z.infer<typeof EvidenceLink>;

export const ClaimLink = z.object({
  relationId: Uuid,
  type: EvidenceRelationType,
  claim: ClaimRecord,
});
export type ClaimLink = z.infer<typeof ClaimLink>;

export const ClaimDetail = z.object({
  claim: ClaimRecord,
  supporting: z.array(EvidenceLink),
  contradicting: z.array(EvidenceLink),
  unknowns: z.array(UnknownRecord),
  contradictions: z.array(ContradictionRecord),
  supersession: SupersessionView,
});
export type ClaimDetail = z.infer<typeof ClaimDetail>;

export const EvidenceDetail = z.object({
  evidence: EvidenceRecord,
  supports: z.array(ClaimLink),
  contradicts: z.array(ClaimLink),
  unknowns: z.array(UnknownRecord),
  contradictions: z.array(ContradictionRecord),
  provenance: ProvenanceTrace,
});
export type EvidenceDetail = z.infer<typeof EvidenceDetail>;

export const NeighborEdgeKind = z.enum([
  'relation',
  'unknown_reference',
  'contradiction_side',
  'supersession',
]);
export type NeighborEdgeKind = z.infer<typeof NeighborEdgeKind>;

export const NeighborhoodNode = z.object({
  type: GraphNodeType,
  id: Uuid,
  /** Shortest hop distance from the start node (the start node is 0). */
  distance: z.number().int().min(0),
});
export const NeighborhoodEdge = z.object({
  kind: NeighborEdgeKind,
  from: GraphNodeRef,
  to: GraphNodeRef,
  /** For `relation` edges: supports or contradicts. */
  relationType: EvidenceRelationType.nullable(),
});
export const Neighborhood = z.object({
  start: GraphNodeRef,
  depth: z.number().int(),
  nodes: z.array(NeighborhoodNode),
  edges: z.array(NeighborhoodEdge),
  /** True when the node cap stopped the traversal early. */
  truncated: z.boolean(),
});
export type Neighborhood = z.infer<typeof Neighborhood>;

// -- Pagination --------------------------------------------------------------------------------

export const PageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(EVIDENCE_GRAPH_LIMITS.pageSizeMax)
    .default(EVIDENCE_GRAPH_LIMITS.pageSizeDefault),
  /** Return records with `seq` greater than this. Omit for the first page. */
  after: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof PageQuery>;

const Page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.object({
      limit: z.number().int(),
      after: z.number().int(),
      /** Pass as `after` for the next page; null when this was the last page. */
      nextAfter: z.number().int().nullable(),
    }),
  });

export const ClaimsPage = Page(ClaimRecord);
export const EvidencePage = Page(EvidenceRecord);
export const UnknownsPage = Page(UnknownRecord);
export const ContradictionsPage = Page(ContradictionRecord);
export type ClaimsPage = z.infer<typeof ClaimsPage>;
export type EvidencePage = z.infer<typeof EvidencePage>;
export type UnknownsPage = z.infer<typeof UnknownsPage>;
export type ContradictionsPage = z.infer<typeof ContradictionsPage>;
