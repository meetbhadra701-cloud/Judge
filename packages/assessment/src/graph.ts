import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  buildEvidenceGraph,
  deterministicIdAllocator,
  planEvidenceGraphBatch,
  checkProvenanceReferences,
  checkProvenanceShape,
  validateGraphIntegrity,
  type EvidenceGraph,
  type EvidenceGraphRecords,
  type GraphIssue,
  type KnownEntities,
  type PlanContext,
  type PlannedGraph,
  type PlanResult,
} from '@judge-copilot/evidence';
import {
  EvidenceGraphBatchInput,
  Uuid,
  type ClaimRecord,
  type ContradictionRecord,
  type EvidenceRecord,
  type RelationRecord,
  type UnknownRecord,
} from '@judge-copilot/schemas';
import type { AdmittedClaim, AdmittedEvidence } from './extraction.js';
import { handleNumber, refOf } from './handles.js';
import { issue, type DomainIssue } from './issues.js';
import {
  levelForClaim,
  levelForEvidence,
  kindForEvidence,
  originForEvidence,
} from './label-policy.js';
import type { ProposedContradiction, ProposedUnknown } from './commentary.js';
import type { ProposedRelation } from './relations.js';
import type { CodeUnknown } from './source-gaps.js';
import type { StatementItem } from './statements.js';
import type { EventReferenceItem } from './event-evidence.js';
import type { SourceArtifact } from './windowing.js';
import { sliceOf, toCodePoints } from './text.js';

/*
 * Deterministic graph planning (design §4.6, §8.7). Accepted records become ONE M3 batch with batch-local refs only; the batch is
 * dry-run through the pure planner `planEvidenceGraphBatch`, so every M3 rule is checked before any transaction opens. Nothing is
 * written here. The batch has no `{ id }` reference to an existing record and no `supersedes`, so the member set is CLOSED by
 * construction; `verifyClosure` and `scopeGraph` check that independently of the planner.
 */

export type BatchInput = EvidenceGraphBatchInput;

export interface ExtractionRecords {
  readonly claims: readonly AdmittedClaim[];
  readonly statementItems: readonly StatementItem[];
  readonly evidence: readonly AdmittedEvidence[];
  /** Verified model relations only. The `supports` relations to statement items are authored here. */
  readonly relations: readonly ProposedRelation[];
  readonly contradictions: readonly ProposedContradiction[];
  readonly unknowns: readonly (ProposedUnknown | CodeUnknown)[];
}

export interface RelationBasisRecord {
  readonly claimRef: string;
  readonly evidenceRef: string;
  readonly type: 'supports' | 'contradicts';
  readonly basis: 'source_statement' | 'independent_observation' | 'team_restatement';
}

export interface AssembledBatch {
  readonly batch: BatchInput;
  /** Handle -> batch-local ref, for mapping the planned ids back to the handles the model saw. */
  readonly claimRefs: ReadonlyMap<string, string>;
  readonly evidenceRefs: ReadonlyMap<string, string>;
  /** Why each relation exists (design §4.5): persisted by P4 in graph_extraction_items. */
  readonly relationBasis: readonly RelationBasisRecord[];
}

const byHandleNumber = <T extends { handle: string }>(a: T, b: T): number =>
  handleNumber(a.handle) - handleNumber(b.handle);

export function assembleExtractionBatch(records: ExtractionRecords): AssembledBatch {
  const claims = [...records.claims].sort(byHandleNumber);
  // Design §4.2: a claim without a statement item cannot exist in M5 (M4 scores evidence ids, never claim ids).
  const statementOf = new Set(records.statementItems.flatMap((item) => item.claimHandles));
  if (claims.some((claim) => !statementOf.has(claim.handle))) {
    throw new Error('internal: a claim without a statement item cannot be planned');
  }
  const claimRefs = new Map(claims.map((claim) => [claim.handle, refOf(claim.handle)]));

  type EvidenceDraft = BatchInput['evidence'] extends infer E
    ? E extends readonly (infer I)[]
      ? I
      : never
    : never;
  const evidenceDrafts: { number: number; handle: string; draft: EvidenceDraft }[] = [];
  for (const item of records.statementItems) {
    const role = 'statement' as const;
    evidenceDrafts.push({
      number: handleNumber(item.handle),
      handle: item.handle,
      draft: {
        ref: refOf(item.handle),
        kind: kindForEvidence(role),
        origin: originForEvidence(role, item.sourceType),
        verificationLevel: levelForEvidence(role),
        text: item.text,
        provenance: {
          snapshotId: item.located.snapshotId,
          artifactId: item.located.artifactId,
          span: { start: item.located.start, end: item.located.end },
          excerpt: item.located.excerpt,
        },
      },
    });
  }
  for (const item of records.evidence) {
    const role = 'interpreted_fact' as const;
    evidenceDrafts.push({
      number: handleNumber(item.handle),
      handle: item.handle,
      draft: {
        ref: refOf(item.handle),
        kind: kindForEvidence(role),
        origin: originForEvidence(role, item.sourceType),
        verificationLevel: levelForEvidence(role),
        text: item.text,
        provenance: {
          snapshotId: item.located.snapshotId,
          artifactId: item.located.artifactId,
          span: { start: item.located.start, end: item.located.end },
          excerpt: item.located.excerpt,
        },
      },
    });
  }
  evidenceDrafts.sort((a, b) => a.number - b.number);
  const evidenceRefs = new Map(evidenceDrafts.map((entry) => [entry.handle, entry.draft.ref]));

  const relationBasis: RelationBasisRecord[] = [];
  const relations: NonNullable<BatchInput['relations']> = [];
  const push = (
    claimHandle: string,
    evidenceHandle: string,
    type: 'supports' | 'contradicts',
    basis: RelationBasisRecord['basis'],
  ) => {
    const claimRef = claimRefs.get(claimHandle);
    const evidenceRef = evidenceRefs.get(evidenceHandle);
    if (claimRef === undefined || evidenceRef === undefined) {
      throw new Error('internal: a relation names a record that is not in the batch');
    }
    relations.push({ claim: { ref: claimRef }, evidence: { ref: evidenceRef }, type });
    relationBasis.push({ claimRef, evidenceRef, type, basis });
  };
  for (const item of [...records.statementItems].sort(byHandleNumber)) {
    for (const claimHandle of item.claimHandles)
      push(claimHandle, item.handle, 'supports', 'source_statement');
  }
  for (const relation of records.relations) {
    push(relation.claim, relation.evidence, relation.type, relation.basis);
  }

  const side = (type: 'claim' | 'evidence', handle: string) => {
    const ref = (type === 'claim' ? claimRefs : evidenceRefs).get(handle);
    if (ref === undefined)
      throw new Error('internal: a contradiction names a record that is not in the batch');
    return { type, ref };
  };
  const refsOf = (handles: readonly string[], map: ReadonlyMap<string, string>) =>
    handles.map((handle) => {
      const ref = map.get(handle);
      if (ref === undefined)
        throw new Error('internal: an unknown names a record that is not in the batch');
      return { ref };
    });

  const batch: BatchInput = {
    claims: claims.map((claim) => ({
      ref: refOf(claim.handle),
      text: claim.text,
      verificationLevel: levelForClaim(),
    })),
    evidence: evidenceDrafts.map((entry) => entry.draft),
    relations,
    contradictions: records.contradictions.map((c) => ({
      sideA: side(c.sideA.type, c.sideA.handle),
      sideB: side(c.sideB.type, c.sideB.handle),
      description: c.description,
    })),
    unknowns: records.unknowns.map((u) => ({
      unknownType: u.unknownType,
      text: u.text,
      claims: refsOf(u.claims, claimRefs),
      evidence: refsOf(u.evidence, evidenceRefs),
    })),
  };
  return { batch, claimRefs, evidenceRefs, relationBasis };
}

/** The deterministic Event-Context reference set, planned separately (it is keyed by context version, not by sources). */
export function assembleContextBatch(
  items: readonly EventReferenceItem[],
  contextVersionId: string,
): BatchInput {
  const role = 'event_reference' as const;
  return {
    evidence: items.map((item) => ({
      ref: item.ref,
      kind: kindForEvidence(role),
      origin: originForEvidence(role, null),
      verificationLevel: levelForEvidence(role),
      text: item.text,
      provenance: { contextVersionId },
    })),
  };
}

// -- Dry-run planning -----------------------------------------------------------------------------------------------------

export interface SnapshotFact {
  readonly id: string;
  readonly sourceType: 'devpost' | 'github' | 'deployment' | 'video';
  readonly status: 'captured' | 'partial' | 'failed' | 'rejected' | 'pending';
  readonly captureNumber?: number;
}

export interface PlanWorld {
  readonly projectId: string;
  readonly eventId: string;
  readonly snapshots: readonly SnapshotFact[];
  readonly artifacts: readonly SourceArtifact[];
  readonly contextVersion?: {
    readonly id: string;
    readonly version: number;
    readonly status: 'locked' | 'superseded';
  };
}

export function buildPlanContext(world: PlanWorld): PlanContext {
  const known: KnownEntities = {
    claims: new Map(),
    evidence: new Map(),
    snapshots: new Map(
      world.snapshots.map((snapshot) => [
        snapshot.id,
        {
          id: snapshot.id,
          projectId: world.projectId,
          sourceType: snapshot.sourceType,
          captureNumber: snapshot.captureNumber ?? 1,
          status: snapshot.status,
          revision: null,
          contentHash: null,
          capturedAt: null,
        },
      ]),
    ),
    artifacts: new Map(
      world.artifacts.map((artifact) => {
        const points = toCodePoints(artifact.text);
        return [
          artifact.artifactId,
          {
            id: artifact.artifactId,
            snapshotId: artifact.snapshotId,
            key: artifact.key,
            kind: artifact.kind as 'file',
            mediaType: artifact.mediaType,
            byteLength: new TextEncoder().encode(artifact.text).length,
            codePointLength: points.length,
            contentHash: sha256Hex(artifact.text),
            slice: (start: number, end: number) =>
              start >= 0 && end >= start && end <= points.length
                ? sliceOf(points, start, end)
                : undefined,
          },
        ] as const;
      }),
    ),
    contextVersions: new Map(
      world.contextVersion
        ? [
            [
              world.contextVersion.id,
              {
                id: world.contextVersion.id,
                eventId: world.eventId,
                version: world.contextVersion.version,
                status: world.contextVersion.status,
              },
            ],
          ]
        : [],
    ),
  };
  return {
    ...known,
    relationPairs: new Map(),
    contradictionPairs: new Set(),
    totals: { claims: 0, evidence: 0, relations: 0, unknowns: 0, contradictions: 0 },
  };
}

/** Parses the batch with the M3 schema (defaults, normalization) and dry-runs the pure planner with deterministic ids. */
export function dryRunPlan(
  batch: BatchInput,
  world: PlanWorld,
): PlanResult | { ok: false; issues: GraphIssue[] } {
  const parsed = EvidenceGraphBatchInput.safeParse(batch);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 50).map((entry) => ({
        code: 'INVALID_INPUT' as GraphIssue['code'],
        path: entry.path.join('.'),
        message: entry.code,
      })),
    };
  }
  const namespace = `p3-dry-run:${sha256Hex(canonicalJson(batch)).slice(0, 16)}`;
  return planEvidenceGraphBatch(
    parsed.data,
    { projectId: world.projectId, eventId: world.eventId },
    buildPlanContext(world),
    deterministicIdAllocator(namespace),
  );
}

// -- Membership and closure -------------------------------------------------------------------------------------------------

/**
 * The explicit member IDs of one extraction (design §8.7). Membership is ONLY these arrays; it is never derived from a query such
 * as "evidence on these snapshots". P4 stores them atomically with the graph.
 */
export interface ExtractionMembers {
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly unknownIds: readonly string[];
  readonly contradictionIds: readonly string[];
}

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort();

export function membersOf(graph: PlannedGraph): ExtractionMembers {
  return {
    claimIds: sortedIds(graph.claims.map((r) => r.id)),
    evidenceIds: sortedIds(graph.evidence.map((r) => r.id)),
    relationIds: sortedIds(graph.relations.map((r) => r.id)),
    unknownIds: sortedIds(graph.unknowns.map((r) => r.id)),
    contradictionIds: sortedIds(graph.contradictions.map((r) => r.id)),
  };
}

export function membersHash(members: ExtractionMembers): string {
  return sha256Hex(
    canonicalJson({
      claims: sortedIds(members.claimIds),
      evidence: sortedIds(members.evidenceIds),
      relations: sortedIds(members.relationIds),
      unknowns: sortedIds(members.unknownIds),
      contradictions: sortedIds(members.contradictionIds),
    }),
  );
}

interface ClosureView {
  readonly claimIds: ReadonlySet<string>;
  readonly evidenceIds: ReadonlySet<string>;
  readonly relations: readonly { id: string; claimId: string; evidenceId: string }[];
  readonly unknowns: readonly {
    id: string;
    claimIds: readonly string[];
    evidenceIds: readonly string[];
  }[];
  readonly contradictions: readonly {
    id: string;
    sideA: { type: string; id: string };
    sideB: { type: string; id: string };
  }[];
  readonly supersessions: number;
}

function closureIssues(view: ClosureView): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const add = (code: string, path: string) => issues.push(issue('graph', code, path));
  view.relations.forEach((relation, index) => {
    if (!view.claimIds.has(relation.claimId))
      add('relation_claim_outside_members', `relations[${String(index)}].claim`);
    if (!view.evidenceIds.has(relation.evidenceId))
      add('relation_evidence_outside_members', `relations[${String(index)}].evidence`);
  });
  view.unknowns.forEach((unknown, index) => {
    unknown.claimIds.forEach((id, i) => {
      if (!view.claimIds.has(id))
        add('unknown_claim_outside_members', `unknowns[${String(index)}].claims[${String(i)}]`);
    });
    unknown.evidenceIds.forEach((id, i) => {
      if (!view.evidenceIds.has(id))
        add(
          'unknown_evidence_outside_members',
          `unknowns[${String(index)}].evidence[${String(i)}]`,
        );
    });
  });
  view.contradictions.forEach((contradiction, index) => {
    for (const [name, side] of [
      ['sideA', contradiction.sideA],
      ['sideB', contradiction.sideB],
    ] as const) {
      const inside =
        side.type === 'claim' ? view.claimIds.has(side.id) : view.evidenceIds.has(side.id);
      if (!inside)
        add('contradiction_side_outside_members', `contradictions[${String(index)}].${name}`);
    }
  });
  if (view.supersessions > 0) add('member_has_supersession', 'claims');
  return issues;
}

/** Closure of a planned graph under every relation endpoint, contradiction side and unknown reference; no supersession edge. */
export function verifyClosure(graph: PlannedGraph): DomainIssue[] {
  return closureIssues({
    claimIds: new Set(graph.claims.map((c) => c.id)),
    evidenceIds: new Set(graph.evidence.map((e) => e.id)),
    relations: graph.relations,
    unknowns: graph.unknowns,
    contradictions: graph.contradictions,
    supersessions: graph.claims.filter((c) => c.supersedesId !== null).length,
  });
}

// -- Records (planned -> loaded shape) and the scoped graph --------------------------------------------------------------------

const EPOCH = '2026-01-01T00:00:00.000Z';

/** Loaded-record shape for a planned graph (insertion order = plan order). Used for dry runs and tests; the database is P4's. */
export function recordsFromPlan(
  graph: PlannedGraph,
  scope: { projectId: string; eventId: string },
): EvidenceGraphRecords {
  let seq = 0;
  const next = () => (seq += 1);
  const claims: ClaimRecord[] = graph.claims.map((c) => ({
    id: c.id,
    projectId: c.projectId,
    seq: next(),
    text: c.text,
    verificationLevel: c.verificationLevel,
    supersedesId: c.supersedesId,
    createdByActorId: null,
    createdAt: EPOCH,
  }));
  const evidence: EvidenceRecord[] = graph.evidence.map((e) => ({
    id: e.id,
    projectId: e.projectId,
    eventId: scope.eventId,
    seq: next(),
    kind: e.kind,
    origin: e.origin,
    verificationLevel: e.verificationLevel,
    text: e.text,
    provenance: {
      snapshotId: e.provenance.snapshotId,
      artifactId: e.provenance.artifactId,
      span: e.provenance.span,
      excerpt: e.provenance.excerpt,
      contextVersionId: e.provenance.contextVersionId,
    },
    createdByActorId: null,
    createdAt: EPOCH,
  }));
  const relations: RelationRecord[] = graph.relations.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    seq: next(),
    claimId: r.claimId,
    evidenceId: r.evidenceId,
    type: r.type,
    createdByActorId: null,
    createdAt: EPOCH,
  }));
  const unknowns: UnknownRecord[] = graph.unknowns.map((u) => ({
    id: u.id,
    projectId: u.projectId,
    seq: next(),
    unknownType: u.unknownType,
    text: u.text,
    claimIds: [...u.claimIds],
    evidenceIds: [...u.evidenceIds],
    createdByActorId: null,
    createdAt: EPOCH,
  }));
  const contradictions: ContradictionRecord[] = graph.contradictions.map((c) => ({
    id: c.id,
    projectId: c.projectId,
    seq: next(),
    sideA: c.sideA,
    sideB: c.sideB,
    description: c.description,
    createdByActorId: null,
    createdAt: EPOCH,
  }));
  return { claims, evidence, relations, unknowns, contradictions };
}

export type ScopeResult =
  | {
      readonly ok: true;
      readonly records: EvidenceGraphRecords;
      readonly graph: EvidenceGraph;
      readonly membersHash: string;
    }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/** Findings about stored LABELS only (mirrors the classification M4's context factory applies; label rules are re-derived by M4). */
const LABEL_ONLY_INTEGRITY: readonly string[] = [
  'UNJUSTIFIED_VERIFICATION',
  'ARTIFACT_NOT_CORROBORATING',
  'INVALID_VERIFICATION_TRANSITION',
];

/**
 * Everything an AUTHORITATIVE scoping needs, all REQUIRED (review F3). A caller cannot obtain a verified scope by leaving one out:
 * a missing or malformed trust input fails closed with `trust_input_missing`; there is no "skip the provenance checks" mode.
 *
 * This function does not authenticate the database. It verifies the loaded records against the facts the CALLER supplies, so P4
 * must read those facts from independent, authorized database reads: the project and event from the run row, `known` from the pinned
 * snapshots / artifacts (with readable text for every cited span) / context version, and the member ids and membership hash from the
 * committed extraction record.
 */
export interface VerifiedScopeInput {
  /** The project the run is for (from the authorized run, never from the records being checked). */
  readonly projectId: string;
  readonly eventId: string;
  /** The COMPLETE authoritative provenance facts for the cited snapshots, artifacts and context versions. */
  readonly known: KnownEntities;
  /** The membership hash stored with the committed extraction record. */
  readonly expectedMembersHash: string;
  /** The member ids stored with the committed extraction record. */
  readonly members: ExtractionMembers;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function trustInputIssues(input: unknown): DomainIssue[] {
  const missing = (path: string) => issue('graph', 'trust_input_missing', path);
  if (typeof input !== 'object' || input === null) return [missing('input')];
  const value = input as Record<string, unknown>;
  const issues: DomainIssue[] = [];
  if (!Uuid.safeParse(value['projectId']).success) issues.push(missing('projectId'));
  if (!Uuid.safeParse(value['eventId']).success) issues.push(missing('eventId'));
  const known = value['known'] as Record<string, unknown> | undefined | null;
  for (const field of ['snapshots', 'artifacts', 'contextVersions']) {
    if (typeof known !== 'object' || known === null || !(known[field] instanceof Map)) {
      issues.push(missing(`known.${field}`));
    }
  }
  const hash = value['expectedMembersHash'];
  if (typeof hash !== 'string' || !SHA256_HEX.test(hash))
    issues.push(missing('expectedMembersHash'));
  const members = value['members'] as Record<string, unknown> | undefined | null;
  for (const field of [
    'claimIds',
    'evidenceIds',
    'relationIds',
    'unknownIds',
    'contradictionIds',
  ]) {
    const list = typeof members === 'object' && members !== null ? members[field] : undefined;
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
      issues.push(missing(`members.${field}`));
    }
  }
  return issues;
}

/**
 * Selects the records whose ids are listed, WITHOUT verifying anything about them. Internal on purpose: filtering is not scoping, and
 * nothing outside `scopeGraph` may use its result as a trusted reader would.
 */
function selectMembersUnverified<T extends { id: string }>(
  label: string,
  records: readonly T[],
  ids: readonly string[],
  issues: DomainIssue[],
): T[] {
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) issues.push(issue('graph', 'member_ids_not_unique', label));
  // Loaded ids must be unique: a duplicate can stand in for a missing member under a plain count comparison. Never deduplicated.
  const loaded = new Set<string>();
  let duplicated = false;
  for (const record of records) {
    if (loaded.has(record.id)) duplicated = true;
    loaded.add(record.id);
  }
  if (duplicated) issues.push(issue('graph', 'loaded_record_ids_not_unique', label));
  const found = records.filter((record) => wanted.has(record.id));
  // Exact set equality between the committed ids and the selected ids (not a count).
  const foundIds = new Set(found.map((record) => record.id));
  if (foundIds.size !== wanted.size || [...wanted].some((id) => !foundIds.has(id))) {
    issues.push(issue('graph', 'member_missing', label));
  }
  return found;
}

/**
 * The pure core of P4's trusted reader: from ALL records of a project and the committed extraction record, produce the VERIFIED scoped
 * graph, or fail closed. Verified means: (1) every trust input is present; (2) the committed ids hash to the committed hash; (3) every
 * member exists exactly once, belongs to the expected project and event, and the loaded members hash to the same value; (4) the member
 * set is closed (relation endpoints, contradiction sides, unknown references, no supersession); (5) every member evidence record's
 * provenance points to authorized snapshots, artifacts, context versions and exact span text, checked against the EXPECTED scope (not
 * against the record's own project, which a fabricated record would carry); (6) M3 graph integrity holds apart from label-only findings.
 * Records that are not members (older extractions, other producers, foreign relations that merely reference a member) are excluded.
 */
export function scopeGraph(all: EvidenceGraphRecords, input: VerifiedScopeInput): ScopeResult {
  const trust = trustInputIssues(input);
  if (trust.length > 0) return { ok: false, issues: trust };
  const { members, known } = input;
  const scope = { projectId: input.projectId, eventId: input.eventId };
  const issues: DomainIssue[] = [];

  if (membersHash(members) !== input.expectedMembersHash) {
    issues.push(issue('graph', 'committed_members_hash_mismatch', 'members'));
  }
  const claims = selectMembersUnverified('claims', all.claims, members.claimIds, issues);
  const evidence = selectMembersUnverified('evidence', all.evidence, members.evidenceIds, issues);
  const relations = selectMembersUnverified(
    'relations',
    all.relations,
    members.relationIds,
    issues,
  );
  const unknowns = selectMembersUnverified('unknowns', all.unknowns, members.unknownIds, issues);
  const contradictions = selectMembersUnverified(
    'contradictions',
    all.contradictions,
    members.contradictionIds,
    issues,
  );

  // identity: every loaded member belongs to the run's project and event
  for (const [label, records] of [
    ['claims', claims],
    ['evidence', evidence],
    ['relations', relations],
    ['unknowns', unknowns],
    ['contradictions', contradictions],
  ] as const) {
    if (records.some((record) => record.projectId !== scope.projectId)) {
      issues.push(issue('graph', 'member_wrong_project', label));
    }
  }
  if (evidence.some((record) => record.eventId !== scope.eventId)) {
    issues.push(issue('graph', 'member_wrong_event', 'evidence'));
  }

  issues.push(
    ...closureIssues({
      claimIds: new Set(claims.map((c) => c.id)),
      evidenceIds: new Set(evidence.map((e) => e.id)),
      relations,
      unknowns,
      contradictions,
      supersessions: claims.filter((c) => c.supersedesId !== null).length,
    }),
  );
  const hash = membersHash({
    claimIds: claims.map((r) => r.id),
    evidenceIds: evidence.map((r) => r.id),
    relationIds: relations.map((r) => r.id),
    unknownIds: unknowns.map((r) => r.id),
    contradictionIds: contradictions.map((r) => r.id),
  });
  if (hash !== input.expectedMembersHash)
    issues.push(issue('graph', 'members_hash_mismatch', 'members'));

  // provenance, against the EXPECTED scope and the authoritative facts
  for (const record of evidence) {
    const path = `evidence:${record.id}`;
    const provenance = {
      snapshotId: record.provenance.snapshotId,
      artifactId: record.provenance.artifactId,
      span: record.provenance.span
        ? { start: record.provenance.span.start, end: record.provenance.span.end }
        : null,
      excerpt: record.provenance.excerpt,
      contextVersionId: record.provenance.contextVersionId,
    };
    for (const finding of checkProvenanceShape(record, provenance)) {
      issues.push(
        issue('graph', `provenance_${finding.code.toLowerCase()}`, `${path}.${finding.field}`),
      );
    }
    for (const finding of checkProvenanceReferences(record, provenance, known, scope).issues) {
      issues.push(
        issue('graph', `provenance_${finding.code.toLowerCase()}`, `${path}.${finding.field}`),
      );
    }
    // a cited span must be verifiable against the stored text: without readable text the excerpt is only a claim
    const artifact =
      provenance.artifactId === null ? undefined : known.artifacts.get(provenance.artifactId);
    if (provenance.span !== null && artifact !== undefined && artifact.slice === undefined) {
      issues.push(issue('graph', 'artifact_text_unavailable', `${path}.provenance.span`));
    }
  }

  const records: EvidenceGraphRecords = { claims, evidence, relations, unknowns, contradictions };
  if (issues.length === 0) {
    const graph = buildEvidenceGraph(records);
    for (const finding of validateGraphIntegrity(graph, known)) {
      if (!LABEL_ONLY_INTEGRITY.includes(finding.code)) {
        issues.push(issue('graph', `integrity_${finding.code.toLowerCase()}`, finding.path));
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, records, graph: buildEvidenceGraph(records), membersHash: hash };
}
