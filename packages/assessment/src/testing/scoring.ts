/* Test-only: wires the pure P3 output into the M4 engine, the way the P5 orchestrator will. */
import {
  buildEvidenceGraph,
  type EvidenceGraph,
  type EvidenceGraphRecords,
  type KnownEntities,
  type PlannedGraph,
} from '@judge-copilot/evidence';
import {
  createTrustedScoringContext,
  scoreProject,
  type TrustedScoringContext,
} from '@judge-copilot/scoring';
import type { EventContextLockedSnapshot } from '@judge-copilot/schemas';
import {
  assembleContextBatch,
  assembleExtractionBatch,
  buildCandidateSets,
  buildEventReferenceItems,
  buildPlanContext,
  dryRunPlan,
  referenceMetaByEvidenceId,
  membersHash,
  membersOf,
  recordsFromPlan,
  scopeGraph,
  type EventReferenceMeta,
  type ExtractionMembers,
  type VerifiedScopeInput,
  type ExtractionRecords,
  type UnitCandidates,
} from '../index.js';
import { extract, type Extracted } from './pipeline.js';
import { EVENT_ID, lockedSnapshot, planWorld, PROJECT_ID, VERSION_ID } from './world.js';

export interface Built {
  readonly extracted: Extracted;
  readonly planned: PlannedGraph;
  readonly members: ExtractionMembers;
  readonly graph: EvidenceGraph;
  readonly context: TrustedScoringContext;
  readonly units: UnitCandidates[];
  readonly locked: EventContextLockedSnapshot;
  readonly byHandle: ReadonlyMap<string, string>;
  readonly known: KnownEntities;
  /** The verified-scope inputs (project, event, authoritative facts, committed membership) and the unscoped records. */
  readonly scopeInput: VerifiedScopeInput;
  readonly records: EvidenceGraphRecords;
}

export function build(
  options: {
    extracted?: Extracted;
    locked?: EventContextLockedSnapshot;
    declaredTrackKeys?: string[];
    extraRecords?: Partial<ExtractionRecords>;
    referenceCap?: number;
  } = {},
): Built {
  const extracted = options.extracted ?? extract();
  const locked = options.locked ?? lockedSnapshot();
  const declared = options.declaredTrackKeys ?? [];
  const world = planWorld(extracted.artifacts, {
    contextVersion: { id: VERSION_ID, version: 1, status: 'locked' },
  });
  const assembled = assembleExtractionBatch({
    claims: extracted.claims,
    statementItems: extracted.statements,
    evidence: extracted.evidence,
    relations: [],
    contradictions: [],
    unknowns: [],
    ...options.extraRecords,
  });
  const main = dryRunPlan(assembled.batch, world);
  if (!main.ok) throw new Error(`plan rejected: ${JSON.stringify(main.issues)}`);
  const reference = buildEventReferenceItems(locked, declared);
  const parts: PlannedGraph[] = [main.graph];
  let eventReferences: ReadonlyMap<string, EventReferenceMeta> = new Map();
  if (reference.items.length > 0) {
    const contextPlan = dryRunPlan(assembleContextBatch(reference.items, VERSION_ID), world);
    if (!contextPlan.ok)
      throw new Error(`context plan rejected: ${JSON.stringify(contextPlan.issues)}`);
    parts.push(contextPlan.graph);
    eventReferences = referenceMetaByEvidenceId(contextPlan.graph.evidence, reference.items);
  }
  const planned: PlannedGraph = {
    claims: parts.flatMap((p) => p.claims),
    evidence: parts.flatMap((p) => p.evidence),
    relations: parts.flatMap((p) => p.relations),
    unknowns: parts.flatMap((p) => p.unknowns),
    contradictions: parts.flatMap((p) => p.contradictions),
  };
  const records = recordsFromPlan(planned, { projectId: PROJECT_ID, eventId: EVENT_ID });
  const members = membersOf(planned);
  const known = buildPlanContext(world);
  const scopeInput: VerifiedScopeInput = {
    projectId: PROJECT_ID,
    eventId: EVENT_ID,
    known,
    expectedMembersHash: membersHash(members),
    members,
  };
  const scoped = scopeGraph(records, scopeInput);
  if (!scoped.ok) throw new Error(`scope rejected: ${JSON.stringify(scoped.issues)}`);
  const result = createTrustedScoringContext({
    projectId: PROJECT_ID,
    eventId: EVENT_ID,
    graph: buildEvidenceGraph(scoped.records),
    known,
    locked,
    target: { kind: 'overall' },
    declaredTrackKeys: declared,
  });
  if (!result.ok) throw new Error(`context rejected: ${JSON.stringify(result.issues)}`);
  const units = buildCandidateSets({
    graph: scoped.graph,
    known,
    rubric: result.context.rubric,
    declaredTrackKeys: declared,
    eventReferences,
    ...(options.referenceCap === undefined ? {} : { referenceCap: options.referenceCap }),
  });
  // handle (C-/E-) -> planned id, through the batch refs
  const byHandle = new Map<string, string>();
  for (const [handle, ref] of assembled.claimRefs) {
    const id = planned.claims.find((c) => c.ref === ref)?.id;
    if (id) byHandle.set(handle, id);
  }
  for (const [handle, ref] of assembled.evidenceRefs) {
    const id = planned.evidence.find((e) => e.ref === ref)?.id;
    if (id) byHandle.set(handle, id);
  }
  return {
    extracted,
    planned,
    members,
    graph: scoped.graph,
    context: result.context,
    units,
    locked,
    byHandle,
    known,
    scopeInput,
    records,
  };
}

export { scoreProject };
