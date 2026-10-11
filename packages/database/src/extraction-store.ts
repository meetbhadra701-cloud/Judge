import { membersHash, type ExtractionMembers } from '@judge-copilot/assessment';
import type { EventReferenceMeta } from '@judge-copilot/assessment';
import type {
  ExtractionEvidenceRole,
  ExtractionKind,
  GraphRecordType,
  RelationBasis,
} from '@judge-copilot/schemas';
import type { FIDELITY_DISPOSITION_VALUES } from '@judge-copilot/assessment';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  contentFingerprintOf,
  extractionIdentityOf,
  type Identity,
} from './assessment-identity.js';
import type { JudgeDatabase } from './client.js';
import { referenceSetMismatch } from './context-reference-check.js';
import type { CreatedGraph, EvidenceGraphStore } from './evidence-graph-store.js';
import { LockedContextReader } from './locked-context-reader.js';
import {
  eventContextVersions,
  graphExtractionItems,
  graphExtractions,
  projects,
  sourceSnapshots,
} from './schema/index.js';

/*
 * Atomic extraction persistence (M5 P4, design §8.5, §8.7). ONE transaction takes the project lock, writes the M3 graph through
 * `createGraphInTransaction` (same planner, caps, error mapping and audit event as `createGraph`), and records the extraction and its
 * membership rows from the AUTHORITATIVE ids the database just allocated (never from P3 dry-run ids). The deferred trigger of
 * migration 0011 then verifies, at commit, that the membership is complete, closed, owned by this transaction and hashed correctly.
 *
 * No model call ever happens here; nothing in this file knows a prompt or a provider.
 */

export type Grounding = (typeof FIDELITY_DISPOSITION_VALUES)[number];

export interface EvidenceItemMeta {
  readonly role: ExtractionEvidenceRole;
  readonly grounding?: Grounding;
  /** Event-Context reference evidence only: the code-authored metadata. */
  readonly reference?: EventReferenceMeta;
}

export interface RelationItemMeta {
  readonly claimRef: string;
  readonly evidenceRef: string;
  readonly basis: RelationBasis;
}

/**
 * The inputs that DEFINE an extraction (R4 F6). The extraction key is derived from them by this store, from the snapshot content
 * hashes and the locked version hash it reads from the database; a caller cannot choose a key.
 */
export interface ExtractionIdentityInput {
  readonly projectId: string;
  readonly kind: ExtractionKind;
  /** SHA-256 of the extractor configuration (prompt versions, models, limits). */
  readonly configHash: string;
  /** Source extractions: every snapshot it covers. */
  readonly snapshotIds: readonly string[];
  /** Context extractions: the locked (or superseded) version and the tracks the reference set is built for. */
  readonly contextVersionId: string | null;
  readonly declaredTrackKeys?: readonly string[];
}

export interface CreateExtractionInput extends ExtractionIdentityInput {
  readonly actorId: string | null;
  /** The running assessment run that produced it (null for a standalone extraction). */
  readonly runId: string | null;
  /** The M3 batch (`EvidenceGraphBatchInput`): batch-local refs only, validated again by the M3 planner. */
  readonly batch: unknown;
  /** Per batch-local ref (claims: grounding; evidence: role/grounding/reference). */
  readonly claimGrounding?: Readonly<Record<string, Grounding>>;
  readonly evidence: Readonly<Record<string, EvidenceItemMeta>>;
  readonly relations?: readonly RelationItemMeta[];
}

/**
 * The derived key already names an extraction whose stored identity or content is not what the caller presented (R4 F6). Nothing was
 * written. To reuse an extraction after a crash, look it up by its identity (`lookup`) instead of re-extracting.
 */
export class ExtractionConflictError extends Error {
  constructor(readonly reason: 'identity' | 'content') {
    super(`extraction key conflict: ${reason}`);
    this.name = 'ExtractionConflictError';
  }
}

/** A caller's metadata does not fit the batch it describes. Nothing was written. */
export class ExtractionInputError extends Error {
  constructor(readonly reason: string) {
    super(`invalid extraction input: ${reason}`);
    this.name = 'ExtractionInputError';
  }
}

export interface StoredExtraction {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ExtractionKind;
  readonly extractionKey: string;
  readonly configHash: string;
  readonly snapshotIds: readonly string[];
  readonly contextVersionId: string | null;
  readonly declaredTrackKeys: readonly string[];
  readonly membersHash: string;
  readonly createdByRunId: string | null;
}

/** Members in CREATION order (the order defines the handles C-001, E-001, ...). */
export interface OrderedMembers extends ExtractionMembers {
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface ExtractionItemRow {
  readonly recordType: GraphRecordType;
  readonly recordId: string;
  readonly ordinal: number;
  readonly role: ExtractionEvidenceRole | null;
  readonly grounding: Grounding | null;
  readonly relationBasis: RelationBasis | null;
  readonly reference: EventReferenceMeta | null;
}

export interface CreatedExtraction {
  readonly extraction: StoredExtraction;
  /** False when an extraction with the same key already existed and was reused (nothing was written). */
  readonly created: boolean;
  /** Present only when `created`. */
  readonly graph: CreatedGraph | null;
  readonly members: OrderedMembers;
}

type Executor = JudgeDatabase;

const sameList = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

const toStored = (row: typeof graphExtractions.$inferSelect): StoredExtraction => ({
  id: row.id,
  projectId: row.projectId,
  kind: row.kind,
  extractionKey: row.extractionKey,
  configHash: row.configHash,
  snapshotIds: [...row.snapshotIds],
  contextVersionId: row.contextVersionId,
  declaredTrackKeys: [...row.declaredTrackKeys],
  membersHash: row.membersHash,
  createdByRunId: row.createdByRunId,
});

export class GraphExtractionStore {
  constructor(
    private readonly db: JudgeDatabase,
    private readonly graphs: EvidenceGraphStore,
  ) {}

  /**
   * Writes the graph and its membership in one transaction, or reuses the extraction with the same key. Never holds the transaction
   * across anything but database statements. Rolls back entirely on any failure (neither graph rows nor membership remain).
   */
  async createExtraction(input: CreateExtractionInput): Promise<CreatedExtraction> {
    return this.db.transaction(async (tx) => {
      // The first lock, as in createGraph: every extraction/graph writer of THIS project serializes here.
      const [project] = await tx
        .select({ id: projects.id, eventId: projects.eventId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .for('no key update');
      if (!project) throw new ExtractionInputError('the project does not exist');

      // The key is DERIVED from the key-defining inputs, read from the database (never taken from the caller).
      const identity = await this.identityOf(tx, input, project.eventId);
      const contentFingerprint = contentFingerprintOf({
        batch: input.batch,
        claimGrounding: input.claimGrounding ?? {},
        evidence: input.evidence,
        relations: input.relations ?? [],
      });

      const [existing] = await tx
        .select()
        .from(graphExtractions)
        .where(eq(graphExtractions.extractionKey, identity.key));
      if (existing) {
        // The key is a hash of the identity, so a different identity cannot reach this row except by a hash collision or a forged row:
        // every key-defining column is compared anyway, and so is the content the key was first used for.
        if (
          existing.projectId !== input.projectId ||
          existing.kind !== input.kind ||
          existing.configHash !== input.configHash ||
          existing.identityCanonical !== identity.canonical ||
          !sameList(existing.snapshotIds, input.snapshotIds) ||
          existing.contextVersionId !== input.contextVersionId ||
          !sameList(existing.declaredTrackKeys, [...(input.declaredTrackKeys ?? [])].sort())
        ) {
          throw new ExtractionConflictError('identity');
        }
        if (existing.contentFingerprint !== contentFingerprint) {
          throw new ExtractionConflictError('content');
        }
        return {
          extraction: toStored(existing),
          created: false,
          graph: null,
          members: await this.readMembers(tx, existing.id),
        };
      }

      const graph = await this.graphs.createGraphInTransaction(
        tx,
        input.projectId,
        input.batch,
        input.actorId,
      );
      const items = this.itemsFor(input, graph);
      if (input.kind === 'context_evidence') {
        await this.assertReferenceSet(tx, project.eventId, input, items, graph);
      }
      const members = membersOfItems(items);
      const hash = membersHash(members);
      const [row] = await tx
        .insert(graphExtractions)
        .values({
          projectId: input.projectId,
          eventId: project.eventId,
          kind: input.kind,
          extractionKey: identity.key,
          snapshotIds: [...input.snapshotIds],
          contextVersionId: input.contextVersionId,
          declaredTrackKeys: [...(input.declaredTrackKeys ?? [])].sort(),
          configHash: input.configHash,
          identityCanonical: identity.canonical,
          contentFingerprint,
          claimCount: members.claimIds.length,
          evidenceCount: members.evidenceIds.length,
          relationCount: members.relationIds.length,
          unknownCount: members.unknownIds.length,
          contradictionCount: members.contradictionIds.length,
          membersHash: hash,
          createdByRunId: input.runId,
        })
        .returning();
      if (!row) throw new Error('internal: the extraction insert returned no row');
      if (items.length > 0) {
        await tx.insert(graphExtractionItems).values(
          items.map((item) => ({
            recordType: item.recordType,
            recordId: item.recordId,
            extractionId: row.id,
            projectId: input.projectId,
            ordinal: item.ordinal,
            role: item.role,
            grounding: item.grounding,
            relationBasis: item.relationBasis,
            referenceBuilder: item.reference?.builder ?? null,
            referenceKind: item.reference?.kind ?? null,
            referenceApplicability: item.reference?.applicability ?? null,
            referenceTrackKey: item.reference?.trackKey ?? null,
          })),
        );
      }
      return { extraction: toStored(row), created: true, graph, members };
    });
  }

  /**
   * The committed extraction with exactly these key-defining inputs, or null. Its key is derived the same way `createExtraction`
   * derives it, so after a crash a caller finds what was already extracted (and skips the model calls) without presenting content.
   */
  async lookup(input: ExtractionIdentityInput): Promise<StoredExtraction | null> {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ eventId: projects.eventId })
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!project) return null;
      const identity = await this.identityOf(tx, input, project.eventId);
      const [row] = await tx
        .select()
        .from(graphExtractions)
        .where(eq(graphExtractions.extractionKey, identity.key));
      if (!row || row.identityCanonical !== identity.canonical) return null;
      return toStored(row);
    });
  }

  /** The canonical identity of an extraction, from the inputs and the stored state of what they name. */
  private async identityOf(
    tx: Executor,
    input: ExtractionIdentityInput,
    eventId: string,
  ): Promise<Identity> {
    if (input.kind === 'source') {
      if (
        input.contextVersionId !== null ||
        (input.declaredTrackKeys ?? []).length > 0 ||
        input.snapshotIds.length === 0 ||
        new Set(input.snapshotIds).size !== input.snapshotIds.length
      ) {
        throw new ExtractionInputError('a source extraction names distinct snapshots only');
      }
      const rows = await tx
        .select({ id: sourceSnapshots.id, contentHash: sourceSnapshots.contentHash })
        .from(sourceSnapshots)
        .where(
          and(
            eq(sourceSnapshots.projectId, input.projectId),
            inArray(sourceSnapshots.id, [...input.snapshotIds]),
            inArray(sourceSnapshots.status, ['captured', 'partial']),
          ),
        );
      if (
        rows.length !== input.snapshotIds.length ||
        rows.some((row) => row.contentHash === null)
      ) {
        throw new ExtractionInputError(
          'every snapshot must be a content-bearing snapshot of the project',
        );
      }
      return extractionIdentityOf({
        kind: 'source',
        projectId: input.projectId,
        configHash: input.configHash,
        snapshots: rows.map((row) => ({ snapshotId: row.id, contentHash: row.contentHash ?? '' })),
      });
    }
    if (input.contextVersionId === null || input.snapshotIds.length > 0) {
      throw new ExtractionInputError('a context extraction names a context version only');
    }
    const declared = [...(input.declaredTrackKeys ?? [])].sort();
    if (new Set(declared).size !== declared.length) {
      throw new ExtractionInputError('declared track keys must be distinct');
    }
    const [version] = await tx
      .select({
        status: eventContextVersions.status,
        hash: eventContextVersions.lockedContentHash,
      })
      .from(eventContextVersions)
      .where(
        and(
          eq(eventContextVersions.id, input.contextVersionId),
          eq(eventContextVersions.eventId, eventId),
        ),
      );
    if (!version?.hash || (version.status !== 'locked' && version.status !== 'superseded')) {
      throw new ExtractionInputError('the context version must be a frozen version of the event');
    }
    return extractionIdentityOf({
      kind: 'context_evidence',
      projectId: input.projectId,
      configHash: input.configHash,
      contextVersionId: input.contextVersionId,
      lockedContentHash: version.hash,
      declaredTrackKeys: declared,
    });
  }

  /** A context extraction must be exactly the reference set of the locked document for the tracks it declares (R4 F8). */
  private async assertReferenceSet(
    tx: Executor,
    eventId: string,
    input: CreateExtractionInput,
    items: readonly ExtractionItemRow[],
    graph: CreatedGraph,
  ): Promise<void> {
    const read = await new LockedContextReader().read(tx, eventId, input.contextVersionId ?? '');
    if (!read.ok)
      throw new ExtractionInputError(`the context version is unreadable: ${read.failure}`);
    const mismatch = referenceSetMismatch({
      locked: read.snapshot,
      declaredTrackKeys: [...(input.declaredTrackKeys ?? [])].sort(),
      items,
      textById: new Map(graph.evidence.map((evidence) => [evidence.id, evidence.text])),
    });
    if (mismatch !== null) {
      throw new ExtractionInputError(
        `the context extraction is not the reference set of the locked document (${mismatch})`,
      );
    }
  }

  /** The metadata rows of an extraction, in creation order. */
  async readItems(
    extractionId: string,
    executor: Executor = this.db,
  ): Promise<ExtractionItemRow[]> {
    const rows = await executor
      .select()
      .from(graphExtractionItems)
      .where(eq(graphExtractionItems.extractionId, extractionId))
      .orderBy(asc(graphExtractionItems.recordType), asc(graphExtractionItems.ordinal));
    return rows.map(toItemRow);
  }

  async getByKey(extractionKey: string): Promise<StoredExtraction | null> {
    const [row] = await this.db
      .select()
      .from(graphExtractions)
      .where(eq(graphExtractions.extractionKey, extractionKey));
    return row ? toStored(row) : null;
  }

  /** Members of one extraction in creation order. */
  async readMembers(executor: Executor, extractionId: string): Promise<OrderedMembers> {
    const rows = await executor
      .select()
      .from(graphExtractionItems)
      .where(eq(graphExtractionItems.extractionId, extractionId))
      .orderBy(asc(graphExtractionItems.ordinal));
    return membersOfItems(rows.map(toItemRow));
  }

  /** True when the project has an extraction row listing `recordId` (any type). Test helper for ownership checks. */
  async isMember(recordType: GraphRecordType, recordId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(graphExtractionItems)
      .where(
        and(
          eq(graphExtractionItems.recordType, recordType),
          eq(graphExtractionItems.recordId, recordId),
        ),
      );
    return row !== undefined;
  }

  private itemsFor(input: CreateExtractionInput, graph: CreatedGraph): ExtractionItemRow[] {
    const items: ExtractionItemRow[] = [];
    const claimRefById = new Map(Object.entries(graph.refs.claims).map(([ref, id]) => [id, ref]));
    const evidenceRefById = new Map(
      Object.entries(graph.refs.evidence).map(([ref, id]) => [id, ref]),
    );
    graph.claims.forEach((claim, index) => {
      const ref = claimRefById.get(claim.id);
      const grounding = ref === undefined ? undefined : input.claimGrounding?.[ref];
      items.push({
        recordType: 'claim',
        recordId: claim.id,
        ordinal: index + 1,
        role: null,
        grounding: grounding ?? null,
        relationBasis: null,
        reference: null,
      });
    });
    graph.evidence.forEach((evidence, index) => {
      const ref = evidenceRefById.get(evidence.id);
      const meta = ref === undefined ? undefined : input.evidence[ref];
      if (!meta) throw new ExtractionInputError(`evidence ${ref ?? evidence.id} has no metadata`);
      if (meta.role === 'event_reference' && !meta.reference) {
        throw new ExtractionInputError(
          `reference evidence ${ref ?? ''} needs its reference metadata`,
        );
      }
      if (meta.role !== 'event_reference' && meta.reference) {
        throw new ExtractionInputError('only reference evidence carries reference metadata');
      }
      items.push({
        recordType: 'evidence',
        recordId: evidence.id,
        ordinal: index + 1,
        role: meta.role,
        grounding: meta.grounding ?? null,
        relationBasis: null,
        reference: meta.reference ?? null,
      });
    });
    const basisByPair = new Map(
      (input.relations ?? []).map((relation) => [
        `${relation.claimRef}|${relation.evidenceRef}`,
        relation.basis,
      ]),
    );
    graph.relations.forEach((relation, index) => {
      const claimRef = claimRefById.get(relation.claimId);
      const evidenceRef = evidenceRefById.get(relation.evidenceId);
      const basis = basisByPair.get(`${claimRef ?? ''}|${evidenceRef ?? ''}`);
      if (!basis) throw new ExtractionInputError('a relation has no basis');
      items.push({
        recordType: 'relation',
        recordId: relation.id,
        ordinal: index + 1,
        role: null,
        grounding: null,
        relationBasis: basis,
        reference: null,
      });
    });
    graph.unknowns.forEach((unknown, index) => {
      items.push({
        recordType: 'unknown',
        recordId: unknown.id,
        ordinal: index + 1,
        role: null,
        grounding: null,
        relationBasis: null,
        reference: null,
      });
    });
    graph.contradictions.forEach((contradiction, index) => {
      items.push({
        recordType: 'contradiction',
        recordId: contradiction.id,
        ordinal: index + 1,
        role: null,
        grounding: null,
        relationBasis: null,
        reference: null,
      });
    });
    return items;
  }
}

function toItemRow(row: typeof graphExtractionItems.$inferSelect): ExtractionItemRow {
  return {
    recordType: row.recordType,
    recordId: row.recordId,
    ordinal: row.ordinal,
    role: row.role,
    grounding: row.grounding,
    relationBasis: row.relationBasis,
    reference:
      row.referenceBuilder !== null &&
      row.referenceKind !== null &&
      row.referenceApplicability !== null
        ? {
            builder: row.referenceBuilder as EventReferenceMeta['builder'],
            kind: row.referenceKind,
            applicability: row.referenceApplicability,
            trackKey: row.referenceTrackKey,
          }
        : null,
  };
}

function membersOfItems(items: readonly ExtractionItemRow[]): OrderedMembers {
  const ids = (type: GraphRecordType) =>
    items
      .filter((item) => item.recordType === type)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((item) => item.recordId);
  return {
    claimIds: ids('claim'),
    evidenceIds: ids('evidence'),
    relationIds: ids('relation'),
    unknownIds: ids('unknown'),
    contradictionIds: ids('contradiction'),
  };
}
