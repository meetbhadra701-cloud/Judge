import {
  buildEventReferenceItems,
  membersHash,
  referenceMetaOf,
  scopeGraph,
  type EventReferenceMeta,
  type VerifiedScopeInput,
} from '@judge-copilot/assessment';
import {
  buildEvidenceGraph,
  NO_KNOWN_ENTITIES,
  type ArtifactFacts,
  type EvidenceGraph,
  type EvidenceGraphRecords,
  type KnownEntities,
} from '@judge-copilot/evidence';
import { sha256Hex } from '@judge-copilot/context';
import {
  ASSESSMENT_RUN_TYPE,
  type EventContextLockedSnapshot,
  type ExtractionKind,
} from '@judge-copilot/schemas';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { inputsFingerprint, trackSelectionSetHash } from './assessment-hashes.js';
import type { JudgeDatabase } from './client.js';
import {
  GRAPH_READ_TRANSACTION,
  toClaimRecord,
  toContradictionRecord,
  toEvidenceRecord,
  toRelationRecord,
  toUnknownRecord,
} from './evidence-graph-store.js';
import type { ExtractionItemRow, OrderedMembers, StoredExtraction } from './extraction-store.js';
import { LockedContextReader } from './locked-context-reader.js';
import {
  analysisRuns,
  assessmentRunExtractions,
  assessmentRunInputs,
  assessmentRunInputSnapshots,
  claims,
  contradictions,
  evidenceItems,
  evidenceRelations,
  graphExtractionItems,
  graphExtractions,
  projects,
  projectTrackSelections,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  unknowns,
} from './schema/index.js';

/*
 * The trusted input reader (M5 P4, design §7.2 and §8.7). ONE read-only REPEATABLE READ transaction reads, from a single snapshot:
 * the run and its pins; the exact pinned Event Context version (recomputing its content hash from the rows it read); the declared
 * tracks; the pinned snapshots; the committed extractions and their members; the member records; and the provenance facts. It then
 * calls the VERIFIED `scopeGraph` of the assessment package with facts it loaded itself.
 *
 * It accepts no Map, hash, status, document or reference metadata from a caller: the only parameter is the run id. A self-consistent
 * set of hashes is not authorization; authorization is "PostgreSQL returned these rows to this code inside one snapshot". This does
 * not defend against a database superuser editing rows, which is outside the single-judge local threat model (docs/SECURITY.md).
 */

const TOKEN = Symbol('AuthorizedAssessmentInputs');

export interface AuthorizedExtraction {
  readonly extraction: StoredExtraction;
  /** Creation order (defines the handles). */
  readonly members: OrderedMembers;
  readonly items: readonly ExtractionItemRow[];
}

export interface AuthorizedAssessmentData {
  readonly runId: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly locked: EventContextLockedSnapshot;
  readonly declaredTrackKeys: readonly string[];
  readonly target: { readonly kind: 'overall' | 'track'; readonly trackKey: string | null };
  readonly pinnedSnapshots: readonly {
    readonly snapshotId: string;
    readonly contentHash: string;
    readonly sourceType: string;
  }[];
  readonly source: AuthorizedExtraction;
  readonly context: AuthorizedExtraction;
  readonly records: EvidenceGraphRecords;
  readonly graph: EvidenceGraph;
  readonly known: KnownEntities;
  /** Code-authored reference metadata, keyed by evidence id, VERIFIED against the pinned locked document. */
  readonly eventReferences: ReadonlyMap<string, EventReferenceMeta>;
  readonly newerDeclarationsExist: boolean;
  readonly inputsFingerprint: string;
  readonly pipelineConfigHash: string;
  readonly pipelineConfig: Record<string, unknown>;
}

/**
 * Inputs that only `AssessmentInputReader.read` can construct. The worker's single call site of `createTrustedScoringContext`
 * accepts nothing else (a source-scan test enforces that this class is constructed in exactly one place).
 */
export class AuthorizedAssessmentInputs {
  constructor(
    token: symbol,
    readonly data: AuthorizedAssessmentData,
  ) {
    if (token !== TOKEN)
      throw new Error('AuthorizedAssessmentInputs can only be created by AssessmentInputReader');
  }
}

export type AssessmentInputErrorCode =
  | 'run_not_found'
  | 'run_not_readable'
  | 'inputs_missing'
  | 'context_unreadable'
  | 'context_superseded'
  | 'context_hash_mismatch'
  | 'track_selection_mismatch'
  | 'pin_mismatch'
  | 'extraction_not_bound'
  | 'extraction_mismatch'
  | 'members_hash_mismatch'
  | 'graph_scope_failed'
  | 'reference_meta_mismatch'
  | 'fingerprint_mismatch';

export class AssessmentInputError extends Error {
  constructor(
    readonly code: AssessmentInputErrorCode,
    readonly detail: readonly string[] = [],
  ) {
    super(
      `assessment inputs rejected: ${code}${detail.length ? ` (${detail.slice(0, 5).join(', ')})` : ''}`,
    );
    this.name = 'AssessmentInputError';
  }
}

type Executor = JudgeDatabase;
const fail = (code: AssessmentInputErrorCode, ...detail: string[]): never => {
  throw new AssessmentInputError(code, detail);
};

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

export class AssessmentInputReader {
  private readonly contexts = new LockedContextReader();

  constructor(private readonly db: JudgeDatabase) {}

  /** Reads and verifies everything a pipeline step may use. Throws `AssessmentInputError`; never returns partial inputs. */
  async read(
    runId: string,
    options: { states?: readonly ('pending' | 'running')[] } = {},
  ): Promise<AuthorizedAssessmentInputs> {
    return this.db.transaction(
      (tx) => this.readInTransaction(tx, runId, options.states ?? ['running']),
      GRAPH_READ_TRANSACTION,
    );
  }

  /** The statements of `read`; `tx` must be the snapshot transaction. Sequential on purpose. */
  async readInTransaction(
    tx: Executor,
    runId: string,
    states: readonly string[],
  ): Promise<AuthorizedAssessmentInputs> {
    const [run] = await tx.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    if (!run) return fail('run_not_found');
    if (
      run.runType !== ASSESSMENT_RUN_TYPE ||
      !states.includes(run.state) ||
      !run.projectId ||
      !run.eventId
    ) {
      return fail('run_not_readable', run.runType, run.state);
    }
    const projectId = run.projectId;
    const [project] = await tx
      .select({ id: projects.id, eventId: projects.eventId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project || project.eventId !== run.eventId) return fail('run_not_readable', 'project');
    const eventId = project.eventId;

    const [inputs] = await tx
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, runId));
    if (!inputs) return fail('inputs_missing');
    if (inputs.projectId !== projectId || inputs.eventId !== eventId)
      return fail('inputs_missing', 'identity');

    // -- the pinned context version, recomputed from the rows just read -----------------------------------------------------
    const context = await this.contexts.read(tx, eventId, inputs.contextVersionId);
    if (!context.ok) {
      return fail(
        context.failure === 'content_hash_mismatch'
          ? 'context_hash_mismatch'
          : 'context_unreadable',
        context.failure,
      );
    }
    if (context.snapshot.status !== 'locked') return fail('context_superseded');
    if (
      context.recomputedHash !== inputs.lockedContentHash ||
      context.snapshot.lockedContentHash !== inputs.lockedContentHash
    ) {
      return fail('context_hash_mismatch', 'pin');
    }
    const locked = context.snapshot;

    // -- declared tracks ------------------------------------------------------------------------------------------------------
    const selectionRows = inputs.trackSelectionIds.length
      ? await tx
          .select()
          .from(projectTrackSelections)
          .where(
            and(
              eq(projectTrackSelections.projectId, projectId),
              inArray(projectTrackSelections.id, [...inputs.trackSelectionIds]),
            ),
          )
      : [];
    const keyBySelection = new Map(selectionRows.map((row) => [row.id, row.trackKey]));
    const pinnedSelections = inputs.trackSelectionIds.map((selectionId, index) => ({
      selectionId,
      trackKey: inputs.declaredTrackKeys[index] ?? '',
    }));
    if (
      selectionRows.length !== inputs.trackSelectionIds.length ||
      pinnedSelections.some((s) => keyBySelection.get(s.selectionId) !== s.trackKey) ||
      trackSelectionSetHash(pinnedSelections) !== inputs.trackSelectionSetHash
    ) {
      return fail('track_selection_mismatch');
    }
    const definedTracks = new Set(locked.document.tracks.map((track) => track.key));
    const undefinedKey = inputs.declaredTrackKeys.find((key) => !definedTracks.has(key));
    if (undefinedKey !== undefined)
      return fail('track_selection_mismatch', 'TRACK_NOT_IN_PINNED_CONTEXT', undefinedKey);
    const currentSelections = await tx
      .select({ trackKey: projectTrackSelections.trackKey })
      .from(projectTrackSelections)
      .where(eq(projectTrackSelections.projectId, projectId));
    const newerDeclarationsExist = currentSelections.some(
      (row) => !inputs.declaredTrackKeys.includes(row.trackKey),
    );

    // -- pinned snapshots -----------------------------------------------------------------------------------------------------
    const pinRows = await tx
      .select({
        snapshotId: assessmentRunInputSnapshots.snapshotId,
        pinnedHash: assessmentRunInputSnapshots.snapshotContentHash,
        snapshot: sourceSnapshots,
      })
      .from(assessmentRunInputSnapshots)
      .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, assessmentRunInputSnapshots.snapshotId))
      .where(eq(assessmentRunInputSnapshots.runId, runId))
      .orderBy(asc(assessmentRunInputSnapshots.snapshotId));
    if (pinRows.length === 0) return fail('pin_mismatch', 'no snapshots');
    for (const pin of pinRows) {
      if (
        pin.snapshot.projectId !== projectId ||
        (pin.snapshot.status !== 'captured' && pin.snapshot.status !== 'partial') ||
        pin.snapshot.contentHash !== pin.pinnedHash
      ) {
        return fail('pin_mismatch', pin.snapshotId);
      }
    }
    const pinnedSnapshots = pinRows.map((pin) => ({
      snapshotId: pin.snapshotId,
      contentHash: pin.pinnedHash,
      sourceType: pin.snapshot.sourceType,
    }));
    const recomputed = inputsFingerprint({
      contextVersionId: inputs.contextVersionId,
      lockedContentHash: inputs.lockedContentHash,
      trackSelectionSetHash: inputs.trackSelectionSetHash,
      target: { kind: inputs.targetKind, trackKey: inputs.targetTrackKey },
      snapshots: pinnedSnapshots,
      pipelineConfigHash: inputs.pipelineConfigHash,
    });
    if (recomputed !== inputs.inputsFingerprint) return fail('fingerprint_mismatch');

    // -- the committed extractions --------------------------------------------------------------------------------------------
    const bindings = await tx
      .select()
      .from(assessmentRunExtractions)
      .where(eq(assessmentRunExtractions.runId, runId));
    const sourceBinding = bindings.find((b) => b.kind === 'source');
    const contextBinding = bindings.find((b) => b.kind === 'context_evidence');
    if (!sourceBinding || !contextBinding) return fail('extraction_not_bound');
    const source = await this.loadExtraction(tx, projectId, sourceBinding.extractionId, 'source');
    const contextExtraction = await this.loadExtraction(
      tx,
      projectId,
      contextBinding.extractionId,
      'context_evidence',
    );
    const pinnedIds = new Set(pinnedSnapshots.map((pin) => pin.snapshotId));
    if (
      source.extraction.snapshotIds.some((id) => !pinnedIds.has(id)) ||
      contextExtraction.extraction.contextVersionId !== inputs.contextVersionId
    ) {
      return fail('extraction_mismatch', 'not the pinned inputs');
    }

    // -- member records (by explicit ids only; membership is never derived from a query) ---------------------------------------
    const memberIds = (pick: (m: OrderedMembers) => readonly string[]) => [
      ...pick(source.members),
      ...pick(contextExtraction.members),
    ];
    const byIds = async <T>(
      ids: readonly string[],
      load: (batch: string[]) => Promise<T[]>,
    ): Promise<T[]> => {
      const out: T[] = [];
      for (let start = 0; start < ids.length; start += 500) {
        out.push(...(await load(ids.slice(start, start + 500))));
      }
      return out;
    };
    const claimRows = await byIds(
      memberIds((m) => m.claimIds),
      (batch) =>
        tx
          .select()
          .from(claims)
          .where(and(eq(claims.projectId, projectId), inArray(claims.id, batch)))
          .orderBy(asc(claims.seq)),
    );
    const evidenceRows = await byIds(
      memberIds((m) => m.evidenceIds),
      (batch) =>
        tx
          .select()
          .from(evidenceItems)
          .where(and(eq(evidenceItems.projectId, projectId), inArray(evidenceItems.id, batch)))
          .orderBy(asc(evidenceItems.seq)),
    );
    const relationRows = await byIds(
      memberIds((m) => m.relationIds),
      (batch) =>
        tx
          .select()
          .from(evidenceRelations)
          .where(
            and(eq(evidenceRelations.projectId, projectId), inArray(evidenceRelations.id, batch)),
          )
          .orderBy(asc(evidenceRelations.seq)),
    );
    const unknownRows = await byIds(
      memberIds((m) => m.unknownIds),
      (batch) =>
        tx
          .select()
          .from(unknowns)
          .where(and(eq(unknowns.projectId, projectId), inArray(unknowns.id, batch)))
          .orderBy(asc(unknowns.seq)),
    );
    const contradictionRows = await byIds(
      memberIds((m) => m.contradictionIds),
      (batch) =>
        tx
          .select()
          .from(contradictions)
          .where(and(eq(contradictions.projectId, projectId), inArray(contradictions.id, batch)))
          .orderBy(asc(contradictions.seq)),
    );
    const records: EvidenceGraphRecords = {
      claims: claimRows.map(toClaimRecord),
      evidence: evidenceRows.map(toEvidenceRecord),
      relations: relationRows.map(toRelationRecord),
      unknowns: unknownRows.map(toUnknownRecord),
      contradictions: contradictionRows.map(toContradictionRecord),
    };

    // -- provenance facts, loaded here and ONLY for what the run pinned --------------------------------------------------------
    const artifactIds = [
      ...new Set(
        records.evidence.flatMap((e) => (e.provenance.artifactId ? [e.provenance.artifactId] : [])),
      ),
    ];
    const artifactRows = artifactIds.length
      ? await tx
          .select()
          .from(sourceSnapshotArtifacts)
          .where(inArray(sourceSnapshotArtifacts.id, artifactIds))
      : [];
    const known: KnownEntities = {
      ...NO_KNOWN_ENTITIES,
      snapshots: new Map(
        pinRows.map(({ snapshot }) => [
          snapshot.id,
          {
            id: snapshot.id,
            projectId: snapshot.projectId,
            sourceType: snapshot.sourceType,
            captureNumber: snapshot.captureNumber,
            status: snapshot.status,
            revision: snapshot.revision,
            contentHash: snapshot.contentHash,
            capturedAt: snapshot.capturedAt ? snapshot.capturedAt.toISOString() : null,
          },
        ]),
      ),
      // only artifacts OF A PINNED SNAPSHOT are authorized; the rest stay unknown and fail the provenance check
      artifacts: new Map(
        artifactRows
          .filter((row) => pinnedIds.has(row.snapshotId))
          .map((row): [string, ArtifactFacts] => {
            const points = Array.from(row.textContent);
            if (sha256Hex(row.textContent) !== row.contentHash)
              fail('pin_mismatch', 'artifact text');
            return [
              row.id,
              {
                id: row.id,
                snapshotId: row.snapshotId,
                key: row.artifactKey,
                kind: row.artifactKind,
                mediaType: row.mediaType,
                byteLength: row.byteLength,
                contentHash: row.contentHash,
                codePointLength: points.length,
                slice: (start: number, end: number) =>
                  Number.isInteger(start) &&
                  Number.isInteger(end) &&
                  start >= 0 &&
                  end >= start &&
                  end <= points.length
                    ? points.slice(start, end).join('')
                    : undefined,
              },
            ];
          }),
      ),
      contextVersions: new Map([
        [
          inputs.contextVersionId,
          {
            id: inputs.contextVersionId,
            eventId,
            version: locked.version,
            status: locked.status,
          },
        ],
      ]),
    };

    // -- verified scoping, once per extraction against its COMMITTED hash --------------------------------------------------------
    const scopeInputOf = (part: AuthorizedExtraction): VerifiedScopeInput => ({
      projectId,
      eventId,
      known,
      expectedMembersHash: part.extraction.membersHash,
      members: part.members,
    });
    const scopedSource = scopeGraph(records, scopeInputOf(source));
    const scopedContext = scopeGraph(records, scopeInputOf(contextExtraction));
    if (!scopedSource.ok || !scopedContext.ok) {
      const issues = [
        ...(scopedSource.ok ? [] : scopedSource.issues),
        ...(scopedContext.ok ? [] : scopedContext.issues),
      ];
      return fail('graph_scope_failed', ...issues.slice(0, 20).map((i) => `${i.code}@${i.path}`));
    }
    const scopedRecords: EvidenceGraphRecords = {
      claims: [...scopedSource.records.claims, ...scopedContext.records.claims],
      evidence: [...scopedSource.records.evidence, ...scopedContext.records.evidence],
      relations: [...scopedSource.records.relations, ...scopedContext.records.relations],
      unknowns: [...scopedSource.records.unknowns, ...scopedContext.records.unknowns],
      contradictions: [
        ...scopedSource.records.contradictions,
        ...scopedContext.records.contradictions,
      ],
    };

    // -- reference metadata, recomputed from the pinned locked document ----------------------------------------------------------
    const expectedReferences = buildEventReferenceItems(locked, inputs.declaredTrackKeys).items;
    const contextEvidence = contextExtraction.items.filter(
      (item) => item.recordType === 'evidence',
    );
    const textById = new Map(scopedContext.records.evidence.map((e) => [e.id, e.text]));
    if (
      contextEvidence.length !== expectedReferences.length ||
      contextEvidence.some((item, index) => {
        const expected = expectedReferences[index];
        if (!expected || item.role !== 'event_reference' || !item.reference) return true;
        const meta = referenceMetaOf(expected);
        return (
          textById.get(item.recordId) !== expected.text ||
          item.reference.kind !== meta.kind ||
          item.reference.applicability !== meta.applicability ||
          item.reference.trackKey !== meta.trackKey
        );
      })
    ) {
      return fail('reference_meta_mismatch');
    }
    const eventReferences = new Map<string, EventReferenceMeta>(
      contextEvidence.flatMap((item) =>
        item.reference ? [[item.recordId, item.reference] as const] : [],
      ),
    );

    return new AuthorizedAssessmentInputs(TOKEN, {
      runId,
      projectId,
      eventId,
      locked,
      declaredTrackKeys: [...inputs.declaredTrackKeys],
      target: { kind: inputs.targetKind, trackKey: inputs.targetTrackKey },
      pinnedSnapshots,
      source,
      context: contextExtraction,
      records: scopedRecords,
      graph: buildEvidenceGraph(scopedRecords),
      known,
      eventReferences,
      newerDeclarationsExist,
      inputsFingerprint: inputs.inputsFingerprint,
      pipelineConfigHash: inputs.pipelineConfigHash,
      pipelineConfig: inputs.pipelineConfig,
    });
  }

  private async loadExtraction(
    tx: Executor,
    projectId: string,
    extractionId: string,
    kind: ExtractionKind,
  ): Promise<AuthorizedExtraction> {
    const [row] = await tx
      .select()
      .from(graphExtractions)
      .where(eq(graphExtractions.id, extractionId));
    if (!row || row.projectId !== projectId || row.kind !== kind) {
      return fail('extraction_mismatch', kind);
    }
    const itemRows = await tx
      .select()
      .from(graphExtractionItems)
      .where(eq(graphExtractionItems.extractionId, extractionId))
      .orderBy(asc(graphExtractionItems.recordType), asc(graphExtractionItems.ordinal));
    const items: ExtractionItemRow[] = itemRows.map((item) => ({
      recordType: item.recordType,
      recordId: item.recordId,
      ordinal: item.ordinal,
      role: item.role,
      grounding: item.grounding,
      relationBasis: item.relationBasis,
      reference:
        item.referenceBuilder !== null &&
        item.referenceKind !== null &&
        item.referenceApplicability !== null
          ? {
              builder: item.referenceBuilder as EventReferenceMeta['builder'],
              kind: item.referenceKind,
              applicability: item.referenceApplicability,
              trackKey: item.referenceTrackKey,
            }
          : null,
    }));
    const ids = (type: ExtractionItemRow['recordType']) =>
      items.filter((item) => item.recordType === type).map((item) => item.recordId);
    const members: OrderedMembers = {
      claimIds: ids('claim'),
      evidenceIds: ids('evidence'),
      relationIds: ids('relation'),
      unknownIds: ids('unknown'),
      contradictionIds: ids('contradiction'),
    };
    // the committed hash is the stored one; recompute it from the rows just read (the database re-verified it at commit)
    if (membersHash(members) !== row.membersHash) return fail('members_hash_mismatch', kind);
    return { extraction: toStored(row), members, items };
  }
}
