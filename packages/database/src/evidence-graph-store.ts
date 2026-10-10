import { createAuditEvent } from '@judge-copilot/audit';
import {
  buildEvidenceGraph,
  EvidenceGraphError,
  EvidenceGraphInputError,
  EvidenceGraphPersistenceError,
  NO_KNOWN_ENTITIES,
  planEvidenceGraphBatch,
  randomIdAllocator,
  relationPairKey,
  validateGraphIntegrity,
  type ArtifactFacts,
  type EvidenceGraph,
  type GraphIssue,
  type IdAllocator,
  type KnownClaim,
  type KnownEntities,
  type PlannedGraph,
  type PlanContext,
} from '@judge-copilot/evidence';
import {
  EvidenceGraphBatchInput,
  SPAN_UNIT,
  type ClaimRecord,
  type ContradictionRecord,
  type EvidenceRecord,
  type EvidenceRelationType,
  type RelationRecord,
  type UnknownRecord,
} from '@judge-copilot/schemas';
import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { JudgeDatabase } from './client.js';
import { createDatabaseAuditSink } from './audit-sink.js';
import {
  claims,
  contradictions,
  eventContextVersions,
  evidenceItems,
  evidenceRelations,
  projects,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  unknowns,
} from './schema/index.js';

/*
 * Persistence of the M3 evidence graph (Layer 3 adapter around the pure rules in
 * @judge-copilot/evidence). The write path is `createGraph`: ONE transaction that validates the
 * project, every reference (in every project, so references can be classified), every snapshot,
 * artifact and span, plans trusted IDs, inserts all records and appends the audit event, or
 * inserts nothing. No model or network call ever happens inside it (M3 has none).
 */

export const EVIDENCE_GRAPH_AUDIT_ACTIONS = { created: 'evidence_graph.created' } as const;

/** The project does not exist. */
export class GraphProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'GraphProjectNotFoundError';
  }
}

export interface EvidenceGraphStoreOptions {
  db: JudgeDatabase;
  /** Trusted ID assignment. Defaults to random v4; tests and demos inject a deterministic one. */
  ids?: IdAllocator;
  now?: () => Date;
}

export interface CreatedGraph {
  /** Batch-local ref -> the trusted ID assigned to it. */
  refs: { claims: Record<string, string>; evidence: Record<string, string> };
  claims: ClaimRecord[];
  evidence: EvidenceRecord[];
  relations: RelationRecord[];
  unknowns: UnknownRecord[];
  contradictions: ContradictionRecord[];
}

export interface LoadedProjectGraph {
  projectId: string;
  eventId: string;
  graph: EvidenceGraph;
  /** Source facts the stored provenance points at (snapshots, artifacts, context versions). */
  known: KnownEntities;
}

type Executor = JudgeDatabase;

/**
 * The transaction `loadGraph` runs in: one snapshot for every read, and no write possible. Writers
 * (`createGraph`) do NOT use this; they stay at the default READ COMMITTED (see `loadGraph`).
 */
export const GRAPH_READ_TRANSACTION = {
  isolationLevel: 'repeatable read',
  accessMode: 'read only',
} as const;

const iso = (value: Date): string => value.toISOString();
const uniq = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function toClaimRecord(row: typeof claims.$inferSelect): ClaimRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    text: row.text,
    verificationLevel: row.verificationLevel,
    supersedesId: row.supersedesId,
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
  };
}

export function toEvidenceRecord(row: typeof evidenceItems.$inferSelect): EvidenceRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    eventId: row.eventId,
    seq: row.seq,
    kind: row.kind,
    origin: row.origin,
    verificationLevel: row.verificationLevel,
    text: row.text,
    provenance: {
      snapshotId: row.snapshotId,
      artifactId: row.artifactId,
      span:
        row.spanStart !== null && row.spanEnd !== null
          ? { start: row.spanStart, end: row.spanEnd, unit: SPAN_UNIT }
          : null,
      excerpt: row.excerpt,
      contextVersionId: row.contextVersionId,
    },
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
  };
}

export function toRelationRecord(row: typeof evidenceRelations.$inferSelect): RelationRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    claimId: row.claimId,
    evidenceId: row.evidenceId,
    type: row.relationType,
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
  };
}

export function toUnknownRecord(row: typeof unknowns.$inferSelect): UnknownRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    unknownType: row.unknownType,
    text: row.text,
    claimIds: [...row.claimIds],
    evidenceIds: [...row.evidenceIds],
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
  };
}

export function toContradictionRecord(
  row: typeof contradictions.$inferSelect,
): ContradictionRecord {
  const side = (claimId: string | null, evidenceId: string | null) =>
    claimId !== null
      ? ({ type: 'claim', id: claimId } as const)
      : ({ type: 'evidence', id: evidenceId ?? '' } as const);
  return {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    sideA: side(row.sideAClaimId, row.sideAEvidenceId),
    sideB: side(row.sideBClaimId, row.sideBEvidenceId),
    description: row.description,
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
  };
}

function sqlStateOf(error: unknown): { code: string | null; constraint: string | null } {
  let code: string | null = null;
  let constraint: string | null = null;
  for (let current = error; current instanceof Error; current = current.cause) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      code === null &&
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      code = candidate.code;
    }
    const name = candidate.constraint ?? candidate.constraint_name;
    if (constraint === null && typeof name === 'string') constraint = name;
  }
  return { code, constraint };
}

/** Constraints that a concurrent writer can legitimately win; reported as typed issues. */
const RACE_ISSUES: Record<string, GraphIssue> = {
  claims_supersedes_id_key: {
    code: 'CLAIM_ALREADY_SUPERSEDED',
    path: 'claims',
    message: 'A claim was superseded concurrently',
  },
  evidence_relations_claim_evidence_key: {
    code: 'DUPLICATE_RELATION',
    path: 'relations',
    message: 'A relation was created concurrently',
  },
  contradictions_pair_key: {
    code: 'DUPLICATE_CONTRADICTION',
    path: 'contradictions',
    message: 'A contradiction was recorded concurrently',
  },
};

type ParsedGraphBatch = ReturnType<typeof EvidenceGraphBatchInput.parse>;

function parseGraphBatch(rawBatch: unknown): ParsedGraphBatch {
  const parsed = EvidenceGraphBatchInput.safeParse(rawBatch);
  if (!parsed.success) {
    throw new EvidenceGraphInputError(
      parsed.error.issues.slice(0, 50).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/** The error mapping of the write path, shared by `createGraph` and `createGraphInTransaction`. Returns the error to throw. */
export function mapGraphPersistenceError(error: unknown): Error {
  if (
    error instanceof EvidenceGraphError ||
    error instanceof GraphProjectNotFoundError ||
    error instanceof EvidenceGraphInputError
  ) {
    return error;
  }
  const { code, constraint } = sqlStateOf(error);
  const race = code === '23505' && constraint ? RACE_ISSUES[constraint] : undefined;
  if (race) return new EvidenceGraphError([race]);
  return new EvidenceGraphPersistenceError(code, constraint);
}

export class EvidenceGraphStore {
  private readonly db: JudgeDatabase;
  private readonly ids: IdAllocator;
  private readonly now: () => Date;

  constructor(options: EvidenceGraphStoreOptions) {
    this.db = options.db;
    this.ids = options.ids ?? randomIdAllocator();
    this.now = options.now ?? (() => new Date());
  }

  // -- Write path ------------------------------------------------------------------------------

  /**
   * Validates and atomically inserts one batch. Throws `EvidenceGraphInputError` (shape),
   * `EvidenceGraphError` (domain/ID-integrity issues) or `GraphProjectNotFoundError`; on any
   * throw nothing was written.
   */
  async createGraph(
    projectId: string,
    rawBatch: unknown,
    actorId: string | null,
  ): Promise<CreatedGraph> {
    const batch = parseGraphBatch(rawBatch);
    try {
      return await this.db.transaction((tx) => this.writeGraph(tx, projectId, batch, actorId));
    } catch (error) {
      throw mapGraphPersistenceError(error);
    }
  }

  /**
   * The body of `createGraph`, runnable inside a caller's transaction so a caller can write other rows atomically with the graph
   * (M5: the extraction membership). It parses and validates exactly like `createGraph`, takes the same project lock first, and
   * throws the same typed errors AFTER mapping them with `mapGraphPersistenceError`; the CALLER owns the transaction, so any throw
   * must roll it back. It never opens a savepoint (the extraction completeness trigger relies on that).
   */
  async createGraphInTransaction(
    tx: JudgeDatabase,
    projectId: string,
    rawBatch: unknown,
    actorId: string | null,
  ): Promise<CreatedGraph> {
    const batch = parseGraphBatch(rawBatch);
    try {
      return await this.writeGraph(tx, projectId, batch, actorId);
    } catch (error) {
      throw mapGraphPersistenceError(error);
    }
  }

  private async writeGraph(
    tx: Executor,
    projectId: string,
    batch: ParsedGraphBatch,
    actorId: string | null,
  ): Promise<CreatedGraph> {
    // The FIRST locking operation: FOR NO KEY UPDATE conflicts with itself, so every
    // createGraph writer of THIS project serializes here, before it counts the project's
    // records for the caps or reads any state it is about to extend. (FOR SHARE did not: any
    // number of writers could hold it at once and all see the same totals.) It does not
    // conflict with the FOR KEY SHARE lock that inserts into the graph tables take on the
    // project row through their foreign keys, and writers of other projects never touch
    // this row, so they stay independent. No other lock is taken before it, so it adds no
    // new lock-ordering hazard.
    const [project] = await tx
      .select({ id: projects.id, eventId: projects.eventId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('no key update');
    if (!project) throw new GraphProjectNotFoundError();

    const context = await this.loadPlanContext(tx, projectId, batch);
    const plan = planEvidenceGraphBatch(
      batch,
      { projectId, eventId: project.eventId },
      context,
      this.ids,
    );
    if (!plan.ok) throw new EvidenceGraphError(plan.issues);

    const created = await this.insertPlan(tx, plan.graph, actorId);
    await createDatabaseAuditSink(tx).append(
      createAuditEvent({
        actorId,
        entityType: 'project',
        entityId: projectId,
        action: EVIDENCE_GRAPH_AUDIT_ACTIONS.created,
        // Counts and IDs only: never claim, evidence or excerpt text.
        metadata: {
          claimCount: created.claims.length,
          evidenceCount: created.evidence.length,
          relationCount: created.relations.length,
          unknownCount: created.unknowns.length,
          contradictionCount: created.contradictions.length,
          claimIds: created.claims.map((claim) => claim.id),
          evidenceIds: created.evidence.map((item) => item.id),
          relationIds: created.relations.map((relation) => relation.id),
          unknownIds: created.unknowns.map((unknown) => unknown.id),
          contradictionIds: created.contradictions.map((contradiction) => contradiction.id),
        },
      }),
    );
    return created;
  }

  /** Reads exactly what the batch can reference (in every project) and what it could collide with. */
  private async loadPlanContext(
    tx: Executor,
    projectId: string,
    batch: ParsedGraphBatch,
  ): Promise<PlanContext> {
    const mentioned = new Set<string>();
    const mention = (ref: { id?: string } | { ref: string } | undefined) => {
      if (ref && 'id' in ref && ref.id) mentioned.add(ref.id);
    };
    for (const claim of batch.claims) mention(claim.supersedes);
    for (const relation of batch.relations) {
      mention(relation.claim);
      mention(relation.evidence);
    }
    for (const unknown of batch.unknowns) {
      unknown.claims.forEach(mention);
      unknown.evidence.forEach(mention);
    }
    for (const contradiction of batch.contradictions) {
      mention(contradiction.sideA);
      mention(contradiction.sideB);
    }
    for (const item of batch.evidence) {
      for (const id of [
        item.provenance.snapshotId,
        item.provenance.artifactId,
        item.provenance.contextVersionId,
      ]) {
        if (id) mentioned.add(id);
      }
    }
    const ids = [...mentioned].sort();

    const claimRows = ids.length
      ? await tx.select().from(claims).where(inArray(claims.id, ids))
      : [];
    const evidenceRows = ids.length
      ? await tx.select().from(evidenceItems).where(inArray(evidenceItems.id, ids))
      : [];
    const artifactRows = ids.length
      ? await tx
          .select({
            id: sourceSnapshotArtifacts.id,
            snapshotId: sourceSnapshotArtifacts.snapshotId,
            key: sourceSnapshotArtifacts.artifactKey,
            kind: sourceSnapshotArtifacts.artifactKind,
            mediaType: sourceSnapshotArtifacts.mediaType,
            byteLength: sourceSnapshotArtifacts.byteLength,
            contentHash: sourceSnapshotArtifacts.contentHash,
            codePointLength:
              sql<number>`char_length(${sourceSnapshotArtifacts.textContent})`.mapWith(Number),
          })
          .from(sourceSnapshotArtifacts)
          .where(inArray(sourceSnapshotArtifacts.id, ids))
      : [];
    const snapshotIds = uniq([...ids, ...artifactRows.map((row) => row.snapshotId)]).sort();
    const snapshotRows = snapshotIds.length
      ? await tx.select().from(sourceSnapshots).where(inArray(sourceSnapshots.id, snapshotIds))
      : [];
    const versionRows = ids.length
      ? await tx
          .select({
            id: eventContextVersions.id,
            eventId: eventContextVersions.eventId,
            version: eventContextVersions.version,
            status: eventContextVersions.status,
          })
          .from(eventContextVersions)
          .where(inArray(eventContextVersions.id, ids))
      : [];

    // Successors of known claims (a claim may be superseded once).
    const claimIds = claimRows.map((row) => row.id);
    const successors = claimIds.length
      ? await tx
          .select({ id: claims.id, supersedesId: claims.supersedesId })
          .from(claims)
          .where(inArray(claims.supersedesId, claimIds))
      : [];
    const successorOf = new Map(successors.map((row) => [row.supersedesId ?? '', row.id]));

    // Artifact text slices for exactly the spans this batch cites.
    const sliceByArtifact = new Map<string, Map<string, string>>();
    const lengthByArtifact = new Map(artifactRows.map((row) => [row.id, row.codePointLength]));
    for (const item of batch.evidence) {
      const { artifactId, span } = item.provenance;
      if (!artifactId || !span || span.end <= span.start) continue;
      const length = lengthByArtifact.get(artifactId);
      if (length === undefined || span.end > length || span.end - span.start > 4_000) continue;
      const key = `${String(span.start)}:${String(span.end)}`;
      const slices = sliceByArtifact.get(artifactId) ?? new Map<string, string>();
      if (!slices.has(key)) {
        const [row] = await tx
          .select({
            text: sql<string>`substr(${sourceSnapshotArtifacts.textContent}, ${span.start + 1}, ${span.end - span.start})`,
          })
          .from(sourceSnapshotArtifacts)
          .where(eq(sourceSnapshotArtifacts.id, artifactId));
        if (row) slices.set(key, row.text);
      }
      sliceByArtifact.set(artifactId, slices);
    }

    const artifactsMap = new Map<string, ArtifactFacts>(
      artifactRows.map((row) => {
        const slices = sliceByArtifact.get(row.id);
        return [
          row.id,
          {
            ...row,
            slice: (start: number, end: number) => slices?.get(`${String(start)}:${String(end)}`),
          },
        ];
      }),
    );

    // Existing relations/contradictions the batch could duplicate.
    const evidenceIds = evidenceRows.map((row) => row.id);
    const relationRows =
      claimIds.length && evidenceIds.length
        ? await tx
            .select({
              claimId: evidenceRelations.claimId,
              evidenceId: evidenceRelations.evidenceId,
              type: evidenceRelations.relationType,
            })
            .from(evidenceRelations)
            .where(
              and(
                inArray(evidenceRelations.claimId, claimIds),
                inArray(evidenceRelations.evidenceId, evidenceIds),
              ),
            )
        : [];
    const sideKeys = [
      ...claimIds.map((id) => `claim:${id}`),
      ...evidenceIds.map((id) => `evidence:${id}`),
    ];
    const contradictionRows = sideKeys.length
      ? await tx
          .select({ a: contradictions.sideAKey, b: contradictions.sideBKey })
          .from(contradictions)
          .where(
            and(
              eq(contradictions.projectId, projectId),
              or(
                inArray(contradictions.sideAKey, sideKeys),
                inArray(contradictions.sideBKey, sideKeys),
              ),
            ),
          )
      : [];

    const totals = {
      claims: await this.countFor(tx, claims, claims.projectId, projectId),
      evidence: await this.countFor(tx, evidenceItems, evidenceItems.projectId, projectId),
      relations: await this.countFor(tx, evidenceRelations, evidenceRelations.projectId, projectId),
      unknowns: await this.countFor(tx, unknowns, unknowns.projectId, projectId),
      contradictions: await this.countFor(tx, contradictions, contradictions.projectId, projectId),
    };

    return {
      claims: new Map<string, KnownClaim>(
        claimRows.map((row) => [
          row.id,
          { ...toClaimRecord(row), successorId: successorOf.get(row.id) ?? null },
        ]),
      ),
      evidence: new Map(evidenceRows.map((row) => [row.id, toEvidenceRecord(row)])),
      snapshots: new Map(
        snapshotRows.map((row) => [
          row.id,
          {
            id: row.id,
            projectId: row.projectId,
            sourceType: row.sourceType,
            captureNumber: row.captureNumber,
            status: row.status,
            revision: row.revision,
            contentHash: row.contentHash,
            capturedAt: row.capturedAt ? iso(row.capturedAt) : null,
          },
        ]),
      ),
      artifacts: artifactsMap,
      contextVersions: new Map(versionRows.map((row) => [row.id, row])),
      relationPairs: new Map<string, EvidenceRelationType>(
        relationRows.map((row) => [relationPairKey(row.claimId, row.evidenceId), row.type]),
      ),
      contradictionPairs: new Set(contradictionRows.map((row) => `${row.a ?? ''}|${row.b ?? ''}`)),
      totals,
    };
  }

  private async countFor(
    tx: Executor,
    table: PgTable,
    column: PgColumn,
    projectId: string,
  ): Promise<number> {
    const [row] = await tx.select({ value: count() }).from(table).where(eq(column, projectId));
    return row?.value ?? 0;
  }

  private async insertPlan(
    tx: Executor,
    plan: PlannedGraph,
    actorId: string | null,
  ): Promise<CreatedGraph> {
    const createdAt = this.now();
    const refs = {
      claims: Object.fromEntries(plan.claims.map((claim) => [claim.ref, claim.id])),
      evidence: Object.fromEntries(plan.evidence.map((item) => [item.ref, item.id])),
    };

    // One statement per claim, so a superseding claim can see its predecessor in the trigger.
    const claimRecords: ClaimRecord[] = [];
    for (const claim of plan.claims) {
      const [row] = await tx
        .insert(claims)
        .values({
          id: claim.id,
          projectId: claim.projectId,
          text: claim.text,
          verificationLevel: claim.verificationLevel,
          supersedesId: claim.supersedesId,
          createdByActorId: actorId,
          createdAt,
        })
        .returning();
      if (row) claimRecords.push(toClaimRecord(row));
    }

    const evidenceRecords = plan.evidence.length
      ? (
          await tx
            .insert(evidenceItems)
            .values(
              plan.evidence.map((item) => ({
                id: item.id,
                projectId: item.projectId,
                eventId: item.eventId,
                kind: item.kind,
                origin: item.origin,
                verificationLevel: item.verificationLevel,
                text: item.text,
                snapshotId: item.provenance.snapshotId,
                artifactId: item.provenance.artifactId,
                spanStart: item.provenance.span?.start ?? null,
                spanEnd: item.provenance.span?.end ?? null,
                excerpt: item.provenance.excerpt,
                contextVersionId: item.provenance.contextVersionId,
                createdByActorId: actorId,
                createdAt,
              })),
            )
            .returning()
        ).map(toEvidenceRecord)
      : [];

    const relationRecords = plan.relations.length
      ? (
          await tx
            .insert(evidenceRelations)
            .values(
              plan.relations.map((relation) => ({
                id: relation.id,
                projectId: relation.projectId,
                claimId: relation.claimId,
                evidenceId: relation.evidenceId,
                relationType: relation.type,
                createdByActorId: actorId,
                createdAt,
              })),
            )
            .returning()
        ).map(toRelationRecord)
      : [];

    const unknownRecords = plan.unknowns.length
      ? (
          await tx
            .insert(unknowns)
            .values(
              plan.unknowns.map((unknown) => ({
                id: unknown.id,
                projectId: unknown.projectId,
                unknownType: unknown.unknownType,
                text: unknown.text,
                claimIds: unknown.claimIds,
                evidenceIds: unknown.evidenceIds,
                createdByActorId: actorId,
                createdAt,
              })),
            )
            .returning()
        ).map(toUnknownRecord)
      : [];

    const contradictionRecords = plan.contradictions.length
      ? (
          await tx
            .insert(contradictions)
            .values(
              plan.contradictions.map((contradiction) => ({
                id: contradiction.id,
                projectId: contradiction.projectId,
                sideAClaimId: contradiction.sideA.type === 'claim' ? contradiction.sideA.id : null,
                sideAEvidenceId:
                  contradiction.sideA.type === 'evidence' ? contradiction.sideA.id : null,
                sideBClaimId: contradiction.sideB.type === 'claim' ? contradiction.sideB.id : null,
                sideBEvidenceId:
                  contradiction.sideB.type === 'evidence' ? contradiction.sideB.id : null,
                description: contradiction.description,
                createdByActorId: actorId,
                createdAt,
              })),
            )
            .returning()
        ).map(toContradictionRecord)
      : [];

    const bySeq = <T extends { seq: number }>(records: T[]) =>
      records.sort((a, b) => a.seq - b.seq);
    return {
      refs,
      claims: bySeq(claimRecords),
      evidence: bySeq(evidenceRecords),
      relations: bySeq(relationRecords),
      unknowns: bySeq(unknownRecords),
      contradictions: bySeq(contradictionRecords),
    };
  }

  // -- Read path -------------------------------------------------------------------------------

  /**
   * Loads a project's whole graph plus the source facts its provenance points at, from ONE
   * consistent PostgreSQL snapshot.
   *
   * The graph is written by one `createGraph` transaction but read here with several statements.
   * At READ COMMITTED every statement takes its own snapshot, so a writer that commits between two
   * of them is seen by the later statements only: relations whose claims were not read, a
   * contradiction without its sides, a snapshot row missing for loaded evidence. That produced
   * false DANGLING_REFERENCE findings and, worse, silently incomplete graphs. A read-only
   * REPEATABLE READ transaction fixes one snapshot at its first statement, so the project lookup,
   * the five graph tables and every dependent provenance lookup see exactly the same committed
   * state: each committed batch is either entirely visible or entirely absent.
   *
   * Only this READ path uses the stronger isolation. `createGraph` deliberately stays at READ
   * COMMITTED: its `FOR NO KEY UPDATE` project lock relies on re-reading the previous writer's
   * committed rows after waiting for the lock, which a REPEATABLE READ snapshot taken before the
   * wait would not show (the M3 cap race). A read-only transaction takes no row locks, so it never
   * blocks or is blocked by writers, and it cannot fail with a serialization error. The
   * transaction is released by `db.transaction` on both success and failure.
   */
  async loadGraph(projectId: string): Promise<LoadedProjectGraph | null> {
    return this.db.transaction((tx) => this.readGraph(tx, projectId), GRAPH_READ_TRANSACTION);
  }

  /** The statements of `loadGraph`; `tx` must be the snapshot transaction. Sequential on purpose. */
  private async readGraph(tx: Executor, projectId: string): Promise<LoadedProjectGraph | null> {
    const [project] = await tx
      .select({ id: projects.id, eventId: projects.eventId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return null;

    const claimRows = await tx
      .select()
      .from(claims)
      .where(eq(claims.projectId, projectId))
      .orderBy(asc(claims.seq));
    const evidenceRows = await tx
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.projectId, projectId))
      .orderBy(asc(evidenceItems.seq));
    const relationRows = await tx
      .select()
      .from(evidenceRelations)
      .where(eq(evidenceRelations.projectId, projectId))
      .orderBy(asc(evidenceRelations.seq));
    const unknownRows = await tx
      .select()
      .from(unknowns)
      .where(eq(unknowns.projectId, projectId))
      .orderBy(asc(unknowns.seq));
    const contradictionRows = await tx
      .select()
      .from(contradictions)
      .where(eq(contradictions.projectId, projectId))
      .orderBy(asc(contradictions.seq));
    const evidence = evidenceRows.map(toEvidenceRecord);
    const graph = buildEvidenceGraph({
      claims: claimRows.map(toClaimRecord),
      evidence,
      relations: relationRows.map(toRelationRecord),
      unknowns: unknownRows.map(toUnknownRecord),
      contradictions: contradictionRows.map(toContradictionRecord),
    });

    const snapshotIds = uniq(
      evidence.flatMap((item) => (item.provenance.snapshotId ? [item.provenance.snapshotId] : [])),
    );
    const artifactIds = uniq(
      evidence.flatMap((item) => (item.provenance.artifactId ? [item.provenance.artifactId] : [])),
    );
    const versionIds = uniq(
      evidence.flatMap((item) =>
        item.provenance.contextVersionId ? [item.provenance.contextVersionId] : [],
      ),
    );

    const snapshotRows = snapshotIds.length
      ? await tx.select().from(sourceSnapshots).where(inArray(sourceSnapshots.id, snapshotIds))
      : [];
    const artifactRows = artifactIds.length
      ? await tx
          .select({
            id: sourceSnapshotArtifacts.id,
            snapshotId: sourceSnapshotArtifacts.snapshotId,
            key: sourceSnapshotArtifacts.artifactKey,
            kind: sourceSnapshotArtifacts.artifactKind,
            mediaType: sourceSnapshotArtifacts.mediaType,
            byteLength: sourceSnapshotArtifacts.byteLength,
            contentHash: sourceSnapshotArtifacts.contentHash,
            codePointLength:
              sql<number>`char_length(${sourceSnapshotArtifacts.textContent})`.mapWith(Number),
          })
          .from(sourceSnapshotArtifacts)
          .where(inArray(sourceSnapshotArtifacts.id, artifactIds))
      : [];
    const versionRows = versionIds.length
      ? await tx
          .select({
            id: eventContextVersions.id,
            eventId: eventContextVersions.eventId,
            version: eventContextVersions.version,
            status: eventContextVersions.status,
          })
          .from(eventContextVersions)
          .where(inArray(eventContextVersions.id, versionIds))
      : [];

    const known: KnownEntities = {
      ...NO_KNOWN_ENTITIES,
      snapshots: new Map(
        snapshotRows.map((row) => [
          row.id,
          {
            id: row.id,
            projectId: row.projectId,
            sourceType: row.sourceType,
            captureNumber: row.captureNumber,
            status: row.status,
            revision: row.revision,
            contentHash: row.contentHash,
            capturedAt: row.capturedAt ? iso(row.capturedAt) : null,
          },
        ]),
      ),
      artifacts: new Map(artifactRows.map((row) => [row.id, row])),
      contextVersions: new Map(versionRows.map((row) => [row.id, row])),
    };
    return { projectId, eventId: project.eventId, graph, known };
  }

  /** Re-validates a project's stored graph: dangling, cross-project and rule violations. */
  async verifyIntegrity(projectId: string): Promise<GraphIssue[] | null> {
    const loaded = await this.loadGraph(projectId);
    return loaded ? validateGraphIntegrity(loaded.graph, loaded.known) : null;
  }
}
