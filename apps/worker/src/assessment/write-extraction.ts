import {
  assembleContextBatch,
  assembleExtractionBatch,
  buildEventReferenceItems,
  dryRunPlan,
  referenceMetaOf,
  type PlanWorld,
  type SnapshotFact,
  type SourceArtifact,
} from '@judge-copilot/assessment';
import {
  AssessmentRunError,
  ExtractionInputError,
  type AssessmentRunStore,
  type CreateExtractionInput,
  type EvidenceItemMeta,
  type Grounding,
  type GraphExtractionStore,
  type StoredExtraction,
} from '@judge-copilot/database';
import {
  EvidenceGraphError,
  EvidenceGraphInputError,
  EvidenceGraphPersistenceError,
} from '@judge-copilot/evidence';
import type { EventContextLockedSnapshot, ExtractionKind } from '@judge-copilot/schemas';
import type { ExtractionDraft } from './extract.js';
import { failRun, lostRun } from './stop.js';

/*
 * S7 (design §8.5, §8.7): the extraction is written ATOMICALLY by P4's store (graph records, membership rows and the extraction row in
 * ONE transaction that holds no model call: everything it writes was validated before it opened), or an equal committed extraction is
 * reused. This module only assembles the batch from the already-gated records, dry-runs it through the pure M3 planner (so a rule
 * violation is found before a transaction opens), hands it to the store, and binds the result to the run. It decides nothing about
 * content: every id, label, span and role comes from the earlier gates, never from a model.
 */

export interface WriteContext {
  readonly extractions: GraphExtractionStore;
  readonly runs: AssessmentRunStore;
  readonly runId: string;
  readonly leaseToken: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly actorId: string | null;
}

/** Maps the P4 store's failures to run endings. Nothing here swallows a failure. */
function mapStoreError(error: unknown, stage: string): never {
  if (error instanceof EvidenceGraphError) {
    return failRun(
      'domain_validation_failed',
      `graph_rejected:${error.codes[0] ?? 'unknown'}`,
      stage,
    );
  }
  if (error instanceof EvidenceGraphInputError) {
    return failRun('domain_validation_failed', 'graph_batch_malformed', stage);
  }
  if (error instanceof EvidenceGraphPersistenceError) {
    return failRun('internal_error', `graph_persistence_failed:${error.sqlState ?? 'none'}`, stage);
  }
  if (error instanceof ExtractionInputError) {
    return failRun('internal_error', 'extraction_input_invalid', stage);
  }
  if (error instanceof Error && error.name === 'ExtractionConflictError') {
    return failRun('internal_error', 'extraction_conflict', stage);
  }
  throw error;
}

export async function bindExtraction(
  context: WriteContext,
  kind: ExtractionKind,
  extractionId: string,
  stage: string,
): Promise<void> {
  try {
    await context.runs.bindExtraction(context.runId, context.leaseToken, kind, extractionId);
  } catch (error) {
    if (error instanceof AssessmentRunError) {
      if (error.code === 'lease_mismatch' || error.code === 'wrong_state') return lostRun(stage);
      return failRun('internal_error', `extraction_bind_rejected:${error.code}`, stage);
    }
    throw error;
  }
}

export interface SourceExtractionInput {
  readonly draft: ExtractionDraft;
  readonly configHash: string;
  readonly snapshotIds: readonly string[];
  readonly snapshots: readonly SnapshotFact[];
  readonly artifacts: readonly SourceArtifact[];
}

export async function writeSourceExtraction(
  context: WriteContext,
  input: SourceExtractionInput,
): Promise<StoredExtraction> {
  const { draft } = input;
  const stage = 'write_source_extraction';
  const assembled = assembleExtractionBatch({
    claims: draft.claims,
    statementItems: draft.statementItems,
    evidence: draft.evidence,
    relations: draft.relations,
    contradictions: draft.contradictions,
    unknowns: draft.unknowns,
  });
  const records =
    (assembled.batch.claims?.length ?? 0) +
    (assembled.batch.evidence?.length ?? 0) +
    (assembled.batch.relations?.length ?? 0) +
    (assembled.batch.unknowns?.length ?? 0) +
    (assembled.batch.contradictions?.length ?? 0);
  if (records === 0) {
    // Nothing could be extracted from content that exists: an empty graph cannot be recorded (M3 refuses an empty batch), and an
    // assessment of nothing is not produced from it.
    return failRun('source_unavailable', 'no_extractable_records', stage);
  }
  const world: PlanWorld = {
    projectId: context.projectId,
    eventId: context.eventId,
    snapshots: input.snapshots,
    artifacts: input.artifacts,
  };
  const planned = dryRunPlan(assembled.batch, world);
  if (!planned.ok) {
    return failRun(
      'domain_validation_failed',
      `graph_plan_rejected:${planned.issues[0]?.code ?? 'unknown'}`,
      stage,
    );
  }

  const groundingOf = new Map<string, Grounding>(
    draft.fidelity.map((entry) => [entry.handle, entry.disposition]),
  );
  const claimGrounding: Record<string, Grounding> = {};
  for (const [handle, ref] of assembled.claimRefs) {
    claimGrounding[ref] = groundingOf.get(handle) ?? 'exact_text';
  }
  const statementHandles = new Set(draft.statementItems.map((item) => item.handle));
  const evidence: Record<string, EvidenceItemMeta> = {};
  for (const [handle, ref] of assembled.evidenceRefs) {
    evidence[ref] = statementHandles.has(handle)
      ? { role: 'statement', grounding: 'exact_text' }
      : { role: 'interpreted_fact', grounding: groundingOf.get(handle) ?? 'exact_text' };
  }
  const createInput: CreateExtractionInput = {
    projectId: context.projectId,
    actorId: context.actorId,
    runId: context.runId,
    kind: 'source',
    configHash: input.configHash,
    snapshotIds: [...input.snapshotIds].sort(),
    contextVersionId: null,
    batch: assembled.batch,
    claimGrounding,
    evidence,
    relations: assembled.relationBasis.map((relation) => ({
      claimRef: relation.claimRef,
      evidenceRef: relation.evidenceRef,
      basis: relation.basis,
    })),
  };
  try {
    const created = await context.extractions.createExtraction(createInput);
    return created.extraction;
  } catch (error) {
    return mapStoreError(error, stage);
  }
}

/**
 * The model-free Event-Context reference extraction (design §4.7). It is keyed by (project, context version, declared tracks, builder), so a
 * re-lock of the context does not force a model re-extraction and an equal extraction is simply reused.
 */
export async function writeContextExtraction(
  context: WriteContext,
  input: {
    readonly locked: EventContextLockedSnapshot;
    readonly declaredTrackKeys: readonly string[];
    readonly configHash: string;
  },
): Promise<StoredExtraction> {
  const stage = 'write_context_extraction';
  const built = buildEventReferenceItems(input.locked, input.declaredTrackKeys);
  if (built.items.length === 0) {
    // P4 contract gap (reported in the P5 report): an extraction needs at least one record, and the trusted reader requires a bound
    // context extraction. A locked document with no declared track and no explicit rule or requirement therefore cannot be assessed.
    // Nothing is invented to fill it.
    return failRun('domain_validation_failed', 'no_context_reference_evidence', stage);
  }
  const world: PlanWorld = {
    projectId: context.projectId,
    eventId: context.eventId,
    snapshots: [],
    artifacts: [],
    contextVersion: { id: input.locked.versionId, version: input.locked.version, status: 'locked' },
  };
  const batch = assembleContextBatch(built.items, input.locked.versionId);
  const planned = dryRunPlan(batch, world);
  if (!planned.ok) {
    return failRun(
      'domain_validation_failed',
      `graph_plan_rejected:${planned.issues[0]?.code ?? 'unknown'}`,
      stage,
    );
  }
  const createInput: CreateExtractionInput = {
    projectId: context.projectId,
    actorId: context.actorId,
    runId: context.runId,
    kind: 'context_evidence',
    configHash: input.configHash,
    snapshotIds: [],
    contextVersionId: input.locked.versionId,
    declaredTrackKeys: [...input.declaredTrackKeys].sort(),
    batch,
    evidence: Object.fromEntries(
      built.items.map((item) => [
        item.ref,
        { role: 'event_reference' as const, reference: referenceMetaOf(item) },
      ]),
    ),
  };
  try {
    return (await context.extractions.createExtraction(createInput)).extraction;
  } catch (error) {
    return mapStoreError(error, stage);
  }
}
