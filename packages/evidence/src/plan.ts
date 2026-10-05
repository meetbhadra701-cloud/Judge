import {
  EVIDENCE_GRAPH_LIMITS,
  SPAN_UNIT,
  type ContradictionSide,
  type EvidenceKind,
  type EvidenceRelationType,
  type ParsedEvidenceGraphBatch,
  type UnknownType,
  type VerificationLevel,
  type EvidenceOrigin,
} from '@judge-copilot/schemas';
import { canonicalSides, contradictionPairKey, nodeKey, relationPairKey } from './graph.js';
import type { IdAllocator } from './ids.js';
import {
  contradictionSideKindProblem,
  justificationProblem,
  relationKindProblem,
  transitionProblem,
} from './integrity.js';
import { sortIssues, type GraphIssue, type GraphIssueCode } from './issues.js';
import { resolveKnown, type GraphScope, type KnownEntities } from './known.js';
import { checkProvenanceReferences, checkProvenanceShape } from './provenance.js';
import type { JustifyingEvidence } from './verification.js';

/*
 * The trusted planner: turns an untrusted, schema-valid batch into records with trusted IDs, or
 * rejects it with typed issues. It is the ID-integrity validator (invariants 19 and 20):
 *
 *   - producers name NEW entities with batch-local refs; this code allocates every UUID;
 *   - a reference to an EXISTING entity is looked up in the authoritative `KnownEntities`, in
 *     every project, and classified: nonexistent, wrong entity type, or another project's;
 *   - provenance, verification, relation, unknown and contradiction rules are all applied.
 * It is pure: it reads nothing, writes nothing and never calls a model. All-or-nothing: any issue
 * means no plan.
 */

export interface PlanContext extends KnownEntities {
  /** Existing relations among the known claims/evidence, keyed by `relationPairKey`. */
  readonly relationPairs: ReadonlyMap<string, EvidenceRelationType>;
  /** Existing contradictions among the known sides, keyed by `contradictionPairKey`. */
  readonly contradictionPairs: ReadonlySet<string>;
  /** Current record totals of the project, for the per-project caps. */
  readonly totals: {
    readonly claims: number;
    readonly evidence: number;
    readonly relations: number;
    readonly unknowns: number;
    readonly contradictions: number;
  };
}

export interface PlannedClaim {
  id: string;
  ref: string;
  projectId: string;
  text: string;
  verificationLevel: VerificationLevel;
  supersedesId: string | null;
}

export interface PlannedEvidence {
  id: string;
  ref: string;
  projectId: string;
  eventId: string;
  kind: EvidenceKind;
  origin: EvidenceOrigin;
  verificationLevel: VerificationLevel;
  text: string;
  provenance: {
    snapshotId: string | null;
    artifactId: string | null;
    span: { start: number; end: number; unit: typeof SPAN_UNIT } | null;
    excerpt: string | null;
    contextVersionId: string | null;
  };
}

export interface PlannedRelation {
  id: string;
  projectId: string;
  claimId: string;
  evidenceId: string;
  type: EvidenceRelationType;
}

export interface PlannedUnknown {
  id: string;
  projectId: string;
  unknownType: UnknownType;
  text: string;
  claimIds: string[];
  evidenceIds: string[];
}

export interface PlannedContradiction {
  id: string;
  projectId: string;
  sideA: ContradictionSide;
  sideB: ContradictionSide;
  description: string;
}

export interface PlannedGraph {
  claims: PlannedClaim[];
  evidence: PlannedEvidence[];
  relations: PlannedRelation[];
  unknowns: PlannedUnknown[];
  contradictions: PlannedContradiction[];
}

export type PlanResult = { ok: true; graph: PlannedGraph } | { ok: false; issues: GraphIssue[] };

type Ref = { ref: string } | { id: string };

export function planEvidenceGraphBatch(
  batch: ParsedEvidenceGraphBatch,
  scope: GraphScope,
  context: PlanContext,
  ids: IdAllocator,
): PlanResult {
  const issues: GraphIssue[] = [];
  const add = (code: GraphIssueCode, path: string, message: string) =>
    issues.push({ code, path, message });

  // 0. Per-project caps.
  const caps = EVIDENCE_GRAPH_LIMITS.perProject;
  for (const [key, label] of [
    ['claims', 'claims'],
    ['evidence', 'evidence'],
    ['relations', 'relations'],
    ['unknowns', 'unknowns'],
    ['contradictions', 'contradictions'],
  ] as const) {
    if (context.totals[key] + batch[key].length > caps[key]) {
      add('PROJECT_LIMIT_EXCEEDED', label, `A project holds at most ${String(caps[key])} ${label}`);
    }
  }

  // 1. Allocate trusted IDs for the new claims and evidence (in batch order) and register refs.
  const claimIdByRef = new Map<string, string>();
  const claimIndexByRef = new Map<string, number>();
  const evidenceIdByRef = new Map<string, string>();
  const claims: PlannedClaim[] = [];
  const evidence: PlannedEvidence[] = [];

  batch.claims.forEach((input, index) => {
    if (claimIdByRef.has(input.ref)) {
      add('DUPLICATE_LOCAL_REF', `claims[${String(index)}].ref`, 'A claim ref is used twice');
    }
    const id = ids.next('claim');
    if (!claimIdByRef.has(input.ref)) {
      claimIdByRef.set(input.ref, id);
      claimIndexByRef.set(input.ref, index);
    }
    claims.push({
      id,
      ref: input.ref,
      projectId: scope.projectId,
      text: input.text,
      verificationLevel: input.verificationLevel,
      supersedesId: null,
    });
  });
  batch.evidence.forEach((input, index) => {
    if (evidenceIdByRef.has(input.ref)) {
      add('DUPLICATE_LOCAL_REF', `evidence[${String(index)}].ref`, 'An evidence ref is used twice');
    }
    const id = ids.next('evidence');
    if (!evidenceIdByRef.has(input.ref)) evidenceIdByRef.set(input.ref, id);
    evidence.push({
      id,
      ref: input.ref,
      projectId: scope.projectId,
      eventId: scope.eventId,
      kind: input.kind,
      origin: input.origin,
      verificationLevel: input.verificationLevel,
      text: input.text,
      provenance: {
        snapshotId: input.provenance.snapshotId ?? null,
        artifactId: input.provenance.artifactId ?? null,
        span: input.provenance.span
          ? { start: input.provenance.span.start, end: input.provenance.span.end, unit: SPAN_UNIT }
          : null,
        excerpt: input.provenance.excerpt ?? null,
        contextVersionId: input.provenance.contextVersionId ?? null,
      },
    });
  });
  const plannedClaims = new Map(claims.map((claim) => [claim.id, claim]));
  const plannedEvidence = new Map(evidence.map((item) => [item.id, item]));

  /** Resolves a reference to a claim id (planned or existing), reporting a precise issue. */
  const resolveClaim = (ref: Ref, path: string): string | null => {
    if ('ref' in ref) {
      const id = claimIdByRef.get(ref.ref);
      if (!id) add('LOCAL_REF_NOT_FOUND', path, 'The claim ref is not defined in this batch');
      return id ?? null;
    }
    const resolved = resolveKnown(context, ref.id, 'claim', scope);
    if (!resolved.ok) {
      add(resolved.code, path, resolved.message);
      return null;
    }
    return resolved.entity.id;
  };
  const resolveEvidence = (ref: Ref, path: string): string | null => {
    if ('ref' in ref) {
      const id = evidenceIdByRef.get(ref.ref);
      if (!id) add('LOCAL_REF_NOT_FOUND', path, 'The evidence ref is not defined in this batch');
      return id ?? null;
    }
    const resolved = resolveKnown(context, ref.id, 'evidence', scope);
    if (!resolved.ok) {
      add(resolved.code, path, resolved.message);
      return null;
    }
    return resolved.entity.id;
  };
  const claimLevel = (id: string): VerificationLevel | null =>
    plannedClaims.get(id)?.verificationLevel ?? context.claims.get(id)?.verificationLevel ?? null;
  const evidenceFacts = (id: string): (JustifyingEvidence & { kind: EvidenceKind }) | null =>
    plannedEvidence.get(id) ?? context.evidence.get(id) ?? null;

  // 2. Claims: supersession identity, single successor, transitions.
  const supersededBy = new Map<string, number>();
  batch.claims.forEach((input, index) => {
    const planned = claims[index];
    if (!planned || !input.supersedes) return;
    const path = `claims[${String(index)}].supersedes`;
    let targetId: string | null;
    if ('ref' in input.supersedes) {
      const targetIndex = claimIndexByRef.get(input.supersedes.ref);
      if (targetIndex !== undefined && targetIndex >= index) {
        add(
          'FORWARD_SUPERSESSION',
          path,
          targetIndex === index
            ? 'A claim cannot supersede itself'
            : 'A claim can only supersede a claim that appears earlier in the batch',
        );
        return;
      }
      targetId = resolveClaim(input.supersedes, path);
    } else {
      targetId = resolveClaim(input.supersedes, path);
      const existing = targetId ? context.claims.get(targetId) : undefined;
      if (existing?.successorId) {
        add('CLAIM_ALREADY_SUPERSEDED', path, 'The claim already has a successor');
      }
    }
    if (targetId === null) return;
    const previous = supersededBy.get(targetId);
    if (previous !== undefined) {
      add('CLAIM_ALREADY_SUPERSEDED', path, 'Another claim in this batch already supersedes it');
    }
    supersededBy.set(targetId, index);
    planned.supersedesId = targetId;
    const from = claimLevel(targetId);
    if (from) {
      const problem = transitionProblem(from, planned.verificationLevel);
      if (problem) add('INVALID_VERIFICATION_TRANSITION', `claims[${String(index)}]`, problem);
    }
  });

  // 3. Evidence: matrix, provenance shape, references, derived excerpts.
  evidence.forEach((planned, index) => {
    const base = `evidence[${String(index)}]`;
    const shapeIssues = checkProvenanceShape(planned, planned.provenance);
    for (const issue of shapeIssues) add(issue.code, `${base}.${issue.field}`, issue.message);
    const { issues: referenceIssues, spanText } = checkProvenanceReferences(
      planned.origin,
      planned.provenance,
      context,
      scope,
    );
    for (const issue of referenceIssues) add(issue.code, `${base}.${issue.field}`, issue.message);
    if (planned.provenance.span && referenceIssues.length === 0 && shapeIssues.length === 0) {
      if (spanText === null) {
        add(
          'SPAN_OUT_OF_BOUNDS',
          `${base}.provenance.span`,
          'The span cannot be verified against the artifact text',
        );
      } else {
        planned.provenance.excerpt = spanText;
      }
    }
  });

  // 4. Relations.
  const batchPairs = new Map<string, EvidenceRelationType>();
  const supportingByClaim = new Map<string, JustifyingEvidence[]>();
  const relations: PlannedRelation[] = [];
  const relationDrafts: { claimId: string; evidenceId: string; type: EvidenceRelationType }[] = [];
  batch.relations.forEach((input, index) => {
    const base = `relations[${String(index)}]`;
    const claimId = resolveClaim(input.claim, `${base}.claim`);
    const evidenceId = resolveEvidence(input.evidence, `${base}.evidence`);
    if (claimId === null || evidenceId === null) return;
    const facts = evidenceFacts(evidenceId);
    if (facts) {
      const problem = relationKindProblem(input.type, facts.kind);
      if (problem) add('RELATION_KIND_NOT_ALLOWED', `${base}.evidence`, problem);
    }
    const key = relationPairKey(claimId, evidenceId);
    const existing = batchPairs.get(key) ?? context.relationPairs.get(key);
    if (existing) {
      add(
        existing === input.type ? 'DUPLICATE_RELATION' : 'CONFLICTING_RELATION',
        base,
        'The claim and evidence item are already related',
      );
      return;
    }
    batchPairs.set(key, input.type);
    relationDrafts.push({ claimId, evidenceId, type: input.type });
    if (input.type === 'supports' && facts) {
      const list = supportingByClaim.get(claimId) ?? [];
      list.push(facts);
      supportingByClaim.set(claimId, list);
    }
  });

  // 5. Unknowns.
  const unknownDrafts: {
    input: ParsedEvidenceGraphBatch['unknowns'][number];
    claimIds: string[];
    evidenceIds: string[];
  }[] = [];
  batch.unknowns.forEach((input, index) => {
    const base = `unknowns[${String(index)}]`;
    const claimIds: string[] = [];
    const evidenceIds: string[] = [];
    input.claims.forEach((ref, refIndex) => {
      const id = resolveClaim(ref, `${base}.claims[${String(refIndex)}]`);
      if (id === null) return;
      if (claimIds.includes(id)) {
        add(
          'DUPLICATE_REFERENCE',
          `${base}.claims[${String(refIndex)}]`,
          'The same claim is listed twice',
        );
      } else claimIds.push(id);
    });
    input.evidence.forEach((ref, refIndex) => {
      const id = resolveEvidence(ref, `${base}.evidence[${String(refIndex)}]`);
      if (id === null) return;
      if (evidenceIds.includes(id)) {
        add(
          'DUPLICATE_REFERENCE',
          `${base}.evidence[${String(refIndex)}]`,
          'The same evidence item is listed twice',
        );
      } else evidenceIds.push(id);
    });
    unknownDrafts.push({ input, claimIds, evidenceIds });
  });

  // 6. Contradictions.
  const batchContradictions = new Set<string>();
  const claimsWithContradiction = new Set<string>();
  const contradictionDrafts: {
    sideA: ContradictionSide;
    sideB: ContradictionSide;
    description: string;
  }[] = [];
  batch.contradictions.forEach((input, index) => {
    const base = `contradictions[${String(index)}]`;
    const sides: ContradictionSide[] = [];
    for (const [name, side] of [
      ['sideA', input.sideA],
      ['sideB', input.sideB],
    ] as const) {
      const path = `${base}.${name}`;
      const ref: Ref = 'ref' in side ? { ref: side.ref } : { id: side.id };
      const id = side.type === 'claim' ? resolveClaim(ref, path) : resolveEvidence(ref, path);
      if (id === null) continue;
      if (side.type === 'evidence') {
        const facts = evidenceFacts(id);
        const problem = facts ? contradictionSideKindProblem(facts.kind) : null;
        if (problem) add('CONTRADICTION_KIND_NOT_ALLOWED', path, problem);
      }
      sides.push({ type: side.type, id });
    }
    const [a, b] = sides;
    if (!a || !b) return;
    if (nodeKey(a) === nodeKey(b)) {
      add('CONTRADICTION_SAME_SIDE', base, 'A contradiction needs two distinct sides');
      return;
    }
    const key = contradictionPairKey(a, b);
    if (batchContradictions.has(key) || context.contradictionPairs.has(key)) {
      add(
        'DUPLICATE_CONTRADICTION',
        base,
        'This pair of sides is already recorded (in either order)',
      );
      return;
    }
    batchContradictions.add(key);
    const [first, second] = canonicalSides(a, b);
    contradictionDrafts.push({ sideA: first, sideB: second, description: input.description });
    for (const side of [a, b]) if (side.type === 'claim') claimsWithContradiction.add(side.id);
  });

  // 7. Justification of each new claim's level from the graph material of this batch.
  claims.forEach((claim, index) => {
    const problem = justificationProblem(
      claim.verificationLevel,
      supportingByClaim.get(claim.id) ?? [],
      claimsWithContradiction.has(claim.id),
    );
    if (problem) add('UNJUSTIFIED_VERIFICATION', `claims[${String(index)}]`, problem);
  });

  if (issues.length > 0) return { ok: false, issues: sortIssues(issues) };

  for (const draft of relationDrafts) {
    relations.push({ id: ids.next('relation'), projectId: scope.projectId, ...draft });
  }
  return {
    ok: true,
    graph: {
      claims,
      evidence,
      relations,
      unknowns: unknownDrafts.map(({ input, claimIds, evidenceIds }) => ({
        id: ids.next('unknown'),
        projectId: scope.projectId,
        unknownType: input.unknownType,
        text: input.text,
        claimIds,
        evidenceIds,
      })),
      contradictions: contradictionDrafts.map((draft) => ({
        id: ids.next('contradiction'),
        projectId: scope.projectId,
        ...draft,
      })),
    },
  };
}
