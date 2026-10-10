import { membersHash, type ExtractionMembers } from '@judge-copilot/assessment';
import type { EventReferenceMeta } from '@judge-copilot/assessment';
import type {
  ExtractionEvidenceRole,
  ExtractionKind,
  GraphRecordType,
  RelationBasis,
} from '@judge-copilot/schemas';
import type { FIDELITY_DISPOSITION_VALUES } from '@judge-copilot/assessment';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { JudgeDatabase } from './client.js';
import type { CreatedGraph, EvidenceGraphStore } from './evidence-graph-store.js';
import { graphExtractionItems, graphExtractions, projects } from './schema/index.js';

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

export interface CreateExtractionInput {
  readonly projectId: string;
  readonly actorId: string | null;
  /** The running assessment run that produced it (null for a standalone extraction). */
  readonly runId: string | null;
  readonly kind: ExtractionKind;
  /** SHA-256 hex of everything that determines the extraction (kind, project, snapshot hashes or version, configuration). */
  readonly extractionKey: string;
  readonly configHash: string;
  readonly snapshotIds: readonly string[];
  readonly contextVersionId: string | null;
  /** The M3 batch (`EvidenceGraphBatchInput`): batch-local refs only, validated again by the M3 planner. */
  readonly batch: unknown;
  /** Per batch-local ref (claims: grounding; evidence: role/grounding/reference). */
  readonly claimGrounding?: Readonly<Record<string, Grounding>>;
  readonly evidence: Readonly<Record<string, EvidenceItemMeta>>;
  readonly relations?: readonly RelationItemMeta[];
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

const toStored = (row: typeof graphExtractions.$inferSelect): StoredExtraction => ({
  id: row.id,
  projectId: row.projectId,
  kind: row.kind,
  extractionKey: row.extractionKey,
  configHash: row.configHash,
  snapshotIds: [...row.snapshotIds],
  contextVersionId: row.contextVersionId,
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

      const [existing] = await tx
        .select()
        .from(graphExtractions)
        .where(eq(graphExtractions.extractionKey, input.extractionKey));
      if (existing) {
        if (existing.projectId !== input.projectId || existing.kind !== input.kind) {
          throw new ExtractionInputError('the extraction key belongs to another project or kind');
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
      const members = membersOfItems(items);
      const hash = membersHash(members);
      const [row] = await tx
        .insert(graphExtractions)
        .values({
          projectId: input.projectId,
          eventId: project.eventId,
          kind: input.kind,
          extractionKey: input.extractionKey,
          snapshotIds: [...input.snapshotIds],
          contextVersionId: input.contextVersionId,
          configHash: input.configHash,
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
