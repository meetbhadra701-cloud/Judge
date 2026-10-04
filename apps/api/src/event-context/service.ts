import { randomUUID } from 'node:crypto';
import { createAuditEvent, type AuditEventInput } from '@judge-copilot/audit';
import {
  applyHumanEdit,
  collectSourceIds,
  documentFromExtraction,
  draftStateFingerprint,
  EventContextError,
  hasReviewedChanges,
  listFacts,
  listUnresolved,
  lockedContentHash,
  normalizeSourceText,
  remapSourceIds,
  sourceContentHash,
  sourceSetFingerprint,
  validateForLock,
  type EventContextExtractor,
  type VersionSources,
} from '@judge-copilot/context';
import {
  analysisRuns,
  createDatabaseAuditSink,
  eventContextVersions,
  eventSources,
  events,
  rubricAnchors,
  rubricCriteria,
  rubrics,
  tracks,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { isFrozenEventContextStatus } from '@judge-copilot/domain';
import {
  EVENT_CONTEXT_LIMITS,
  EventContextContent,
  EventContextDocument,
  EventContextExtraction,
  type AnalysisRunFailureCategory,
  type ContextVersionDetail,
  type CreateContextVersionRequest,
  type CreateEventRequest,
  type EventContextLockedSnapshot,
  type EventDetail,
  type EventRecord,
  type EventSourceInput,
  type EventSourceRecord,
  type UpdateEventContextRequest,
} from '@judge-copilot/schemas';
import { and, asc, count, desc, eq, inArray, max } from 'drizzle-orm';
import type { z } from 'zod';
import {
  toEventRecord,
  toSourceRecord,
  toSourceSummary,
  toVersionSummary,
  type EventRow,
  type SourceRow,
  type VersionRow,
} from './mappers.js';

export const EVENT_CONTEXT_BUILD_RUN_TYPE = 'event_context_build';

/** Audit actions recorded by the Event Context workflow (M1). */
export const EVENT_CONTEXT_AUDIT_ACTIONS = {
  eventCreated: 'event_created',
  versionCreated: 'context_version_created',
  sourceAdded: 'event_source_added',
  built: 'event_context_built',
  buildFailed: 'event_context_build_failed',
  buildCancelled: 'event_context_build_cancelled',
  edited: 'event_context_edited',
  locked: 'event_context_locked',
  superseded: 'context_version_superseded',
} as const;

const PG_UNIQUE_VIOLATION = '23505';
const PG_RESTRICT_VIOLATION = '23001';

export interface EventContextServiceOptions {
  db: JudgeDatabase;
  /** Null when no extractor is configured: drafts are then authored by hand. */
  extractor: EventContextExtractor | null;
  now?: () => Date;
  newId?: () => string;
  /** The authenticated actor recorded in audit events (M2); null for system actions. */
  actorId?: string | null;
}

/**
 * The Event Context Pack workflow: events, draft versions, sources, build, human edit, lock and
 * supersession. Every state change is transactional and audited; frozen history is additionally
 * protected by database triggers. No scoring, projects or model providers are involved.
 */
export class EventContextService {
  private readonly db: JudgeDatabase;
  private readonly extractor: EventContextExtractor | null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly actorId: string | null;
  private readonly options: EventContextServiceOptions;

  constructor(options: EventContextServiceOptions) {
    this.options = options;
    this.db = options.db;
    this.extractor = options.extractor;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.actorId = options.actorId ?? null;
  }

  /** The same workflow, with audit events attributed to an authenticated actor. */
  forActor(actorId: string): EventContextService {
    return new EventContextService({ ...this.options, actorId });
  }

  // -- Events --------------------------------------------------------------------------------

  async createEvent(input: CreateEventRequest): Promise<EventRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(events)
          .values({
            name: input.name,
            slug: input.slug,
            startsAt: toDate(input.startsAt),
            endsAt: toDate(input.endsAt),
            judgingStartsAt: toDate(input.judgingStartsAt),
          })
          .returning();
        const event = required(row);
        await this.audit(tx, {
          entityType: 'event',
          entityId: event.id,
          action: EVENT_CONTEXT_AUDIT_ACTIONS.eventCreated,
          metadata: { slug: event.slug },
        });
        return toEventRecord(event);
      });
    } catch (error) {
      if (hasPgCode(error, PG_UNIQUE_VIOLATION)) {
        throw new EventContextError('EVENT_SLUG_TAKEN', 'An event with this slug already exists');
      }
      throw error;
    }
  }

  async listEvents(): Promise<EventRecord[]> {
    const rows = await this.db
      .select()
      .from(events)
      .orderBy(desc(events.createdAt), asc(events.id));
    return rows.map(toEventRecord);
  }

  async getEvent(eventId: string): Promise<EventDetail> {
    const event = await this.requireEvent(this.db, eventId);
    const versions = await this.db
      .select()
      .from(eventContextVersions)
      .where(eq(eventContextVersions.eventId, eventId))
      .orderBy(asc(eventContextVersions.version));
    return {
      event: toEventRecord(event),
      versions: versions.map(toVersionSummary),
      lockedVersionId: versions.find((version) => version.status === 'locked')?.id ?? null,
    };
  }

  // -- Context versions ----------------------------------------------------------------------

  /**
   * Creates the next draft version. When a locked version exists, the draft derives from it: its
   * sources are copied (new rows, `copied_from_id` set) and its document is copied with source
   * references remapped. The locked version itself is never touched.
   */
  async createContextVersion(
    eventId: string,
    input: CreateContextVersionRequest,
  ): Promise<ContextVersionDetail> {
    const versionId = await this.db.transaction(async (tx) => {
      await this.requireEvent(tx, eventId, { forUpdate: true });
      const [locked] = await tx
        .select()
        .from(eventContextVersions)
        .where(
          and(eq(eventContextVersions.eventId, eventId), eq(eventContextVersions.status, 'locked')),
        );
      if (locked && !input.changeReason) {
        throw new EventContextError(
          'CHANGE_REASON_REQUIRED',
          'A change reason is required to create a new version of a locked Event Context',
        );
      }
      const [latest] = await tx
        .select({ value: max(eventContextVersions.version) })
        .from(eventContextVersions)
        .where(eq(eventContextVersions.eventId, eventId));
      const [inserted] = await tx
        .insert(eventContextVersions)
        .values({
          eventId,
          version: (latest?.value ?? 0) + 1,
          status: 'draft',
          supersedesId: locked?.id ?? null,
          changeReason: input.changeReason ?? null,
          summary: locked?.summary ?? null,
        })
        .returning();
      const version = required(inserted);

      let copiedSourceCount = 0;
      if (locked) {
        const baseSources = await this.loadSources(tx, locked.id);
        const idMap = new Map<string, string>();
        if (baseSources.length > 0) {
          const copies = await tx
            .insert(eventSources)
            .values(
              baseSources.map((source) => ({
                contextVersionId: version.id,
                sourceType: source.sourceType,
                authority: source.authority,
                title: source.title,
                url: source.url,
                normalizedText: source.normalizedText,
                contentHash: source.contentHash,
                capturedAt: source.capturedAt,
                position: source.position,
                copiedFromId: source.id,
              })),
            )
            .returning({ id: eventSources.id, copiedFromId: eventSources.copiedFromId });
          for (const copy of copies) {
            if (copy.copiedFromId) idMap.set(copy.copiedFromId, copy.id);
          }
          copiedSourceCount = copies.length;
        }
        const baseDocument = await this.loadDocument(tx, locked);
        if (baseDocument) {
          await this.writeDocument(
            tx,
            version.id,
            remapSourceIds(baseDocument, (id) => required(idMap.get(id))),
          );
        }
      }

      await this.audit(tx, {
        entityType: 'event_context_version',
        entityId: version.id,
        action: EVENT_CONTEXT_AUDIT_ACTIONS.versionCreated,
        metadata: {
          eventId,
          version: version.version,
          basedOnVersionId: locked?.id ?? null,
          copiedSourceCount,
        },
      });
      return version.id;
    });
    return this.getContextVersion(eventId, versionId);
  }

  async getContextVersion(eventId: string, versionId: string): Promise<ContextVersionDetail> {
    const version = await this.requireVersion(this.db, eventId, versionId);
    const sources = await this.loadSources(this.db, version.id);
    const document = await this.loadDocument(this.db, version);
    const frozen = isFrozenEventContextStatus(version.status);

    let lockReadiness: ContextVersionDetail['lockReadiness'] = null;
    if (version.status === 'draft') {
      const issues = validateForLock(document, versionSources(sources));
      lockReadiness = { ready: issues.length === 0, issues };
    }
    const extraction = loadExtraction(version);
    const rebuildWouldReplaceReviewedChanges =
      version.status === 'draft' ? hasReviewedChanges({ document, extraction }) : null;
    let integrity: ContextVersionDetail['integrity'] = null;
    if (frozen && document && version.lockedContentHash) {
      const recomputed = lockedContentHash({ document, sources: sources.map(toSourceSummary) });
      integrity = recomputed === version.lockedContentHash ? 'verified' : 'mismatch';
    }

    return {
      ...toVersionSummary(version),
      summary: version.summary,
      lockedContentHash: version.lockedContentHash,
      document,
      extraction,
      sources: sources.map(toSourceSummary),
      unresolved: document ? listUnresolved(document) : [],
      lockReadiness,
      rebuildWouldReplaceReviewedChanges,
      integrity,
    };
  }

  /** The currently locked Event Context of an event — what future assessments reference. */
  async getLockedContext(eventId: string): Promise<EventContextLockedSnapshot> {
    await this.requireEvent(this.db, eventId);
    const [locked] = await this.db
      .select()
      .from(eventContextVersions)
      .where(
        and(eq(eventContextVersions.eventId, eventId), eq(eventContextVersions.status, 'locked')),
      );
    if (!locked) {
      throw new EventContextError(
        'NO_LOCKED_CONTEXT',
        'This event has no locked Event Context yet',
      );
    }
    const sources = await this.loadSources(this.db, locked.id);
    const document = await this.loadDocument(this.db, locked);
    if (!document || !locked.lockedAt || !locked.lockedContentHash) {
      throw new Error(`Locked version ${locked.id} is missing its frozen content`);
    }
    return {
      eventId,
      versionId: locked.id,
      version: locked.version,
      status: 'locked',
      lockedAt: locked.lockedAt.toISOString(),
      lockedContentHash: locked.lockedContentHash,
      supersedesId: locked.supersedesId,
      changeReason: locked.changeReason,
      summary: locked.summary,
      sources: sources.map(toSourceSummary),
      document,
    };
  }

  // -- Sources -------------------------------------------------------------------------------

  async addSource(
    eventId: string,
    versionId: string,
    input: z.output<typeof EventSourceInput>,
  ): Promise<EventSourceRecord> {
    const normalizedText = normalizeSourceText(input.normalizedText);
    if (
      normalizedText.length === 0 ||
      normalizedText.length > EVENT_CONTEXT_LIMITS.sourceTextMaxChars
    ) {
      throw new EventContextError(
        'INVALID_SOURCE_TEXT',
        `Source text must be 1-${String(EVENT_CONTEXT_LIMITS.sourceTextMaxChars)} characters after normalization`,
      );
    }
    return this.mutation(() =>
      this.db.transaction(async (tx) => {
        const version = await this.requireVersion(tx, eventId, versionId, { forUpdate: true });
        assertDraft(version);
        // The version row is locked FOR UPDATE, so this count is a safe next position.
        const [existing] = await tx
          .select({ value: count() })
          .from(eventSources)
          .where(eq(eventSources.contextVersionId, version.id));
        const position = existing?.value ?? 0;
        if (position >= EVENT_CONTEXT_LIMITS.sourcesPerVersionMax) {
          throw new EventContextError(
            'SOURCE_LIMIT_REACHED',
            `A context version can have at most ${String(EVENT_CONTEXT_LIMITS.sourcesPerVersionMax)} sources`,
          );
        }
        const [inserted] = await tx
          .insert(eventSources)
          .values({
            contextVersionId: version.id,
            sourceType: input.sourceType,
            authority: input.authority,
            title: input.title,
            url: input.url ?? null,
            normalizedText,
            contentHash: sourceContentHash(normalizedText),
            capturedAt: input.capturedAt ? new Date(input.capturedAt) : this.now(),
            position,
          })
          .returning();
        const source = required(inserted);
        await this.audit(tx, {
          entityType: 'event_source',
          entityId: source.id,
          action: EVENT_CONTEXT_AUDIT_ACTIONS.sourceAdded,
          metadata: {
            contextVersionId: version.id,
            authority: source.authority,
            sourceType: source.sourceType,
            contentHash: source.contentHash,
            textLength: normalizedText.length,
          },
        });
        return toSourceRecord(source);
      }),
    );
  }

  async listSources(eventId: string, versionId: string): Promise<EventSourceRecord[]> {
    const version = await this.requireVersion(this.db, eventId, versionId);
    return (await this.loadSources(this.db, version.id)).map(toSourceRecord);
  }

  // -- Build ---------------------------------------------------------------------------------

  /**
   * sources → extractor → schema validation → domain validation → draft.
   *
   * Safety rules:
   * - A rebuild never silently discards human review: when the draft's reviewed document differs
   *   from its last extraction (or has none), the build is refused with
   *   HUMAN_EDITS_WOULD_BE_REPLACED unless `replaceHumanEdits` is explicitly true.
   * - The extractor runs with NO transaction open. Fingerprints of the source set and the draft
   *   state are taken first and re-checked under `FOR UPDATE` before writing; if either changed,
   *   the result is discarded (CONTEXT_BUILD_STALE) and the newer state is left intact.
   * - Any failure marks the analysis run failed (or cancelled, for stale/locked input) and leaves
   *   the previous draft untouched.
   */
  async buildContext(
    eventId: string,
    versionId: string,
    options: { replaceHumanEdits?: boolean } = {},
  ): Promise<ContextVersionDetail> {
    const version = await this.requireVersion(this.db, eventId, versionId);
    assertDraft(version);
    if (!this.extractor) {
      throw new EventContextError(
        'EXTRACTOR_NOT_CONFIGURED',
        'No Event Context extractor is configured; author the draft manually instead',
      );
    }
    const event = await this.requireEvent(this.db, eventId);
    const sources = await this.loadSources(this.db, version.id);
    if (sources.length === 0) {
      throw new EventContextError('NO_CONTEXT_SOURCES', 'Add at least one source before building');
    }

    const startState = {
      document: await this.loadDocument(this.db, version),
      extraction: loadExtraction(version),
    };
    const replacesReviewedChanges = hasReviewedChanges(startState);
    if (replacesReviewedChanges && options.replaceHumanEdits !== true) {
      throw new EventContextError(
        'HUMAN_EDITS_WOULD_BE_REPLACED',
        'This draft contains reviewed or manual changes that a rebuild would replace. Confirm with replaceHumanEdits to rebuild anyway.',
      );
    }
    const sourceFingerprint = sourceSetFingerprint(sources);
    const draftFingerprint = draftStateFingerprint(startState);

    const [run] = await this.db
      .insert(analysisRuns)
      .values({
        eventId,
        contextVersionId: version.id,
        runType: EVENT_CONTEXT_BUILD_RUN_TYPE,
        state: 'running',
        startedAt: this.now(),
      })
      .returning({ id: analysisRuns.id });
    const runId = required(run).id;

    // No transaction is open while the extractor runs (it may be a slow model call later).
    let output: unknown;
    try {
      output = await this.extractor.extract({
        eventName: event.name,
        sources: sources.map((source) => ({
          id: source.id,
          sourceType: source.sourceType,
          authority: source.authority,
          title: source.title,
          url: source.url,
          normalizedText: source.normalizedText,
          contentHash: source.contentHash,
        })),
      });
    } catch {
      return this.failBuild(version.id, runId, 'provider_error');
    }

    const parsed = EventContextExtraction.safeParse(output);
    if (!parsed.success) {
      return this.failBuild(version.id, runId, 'schema_validation_failed', {
        schemaIssues: parsed.error.issues.slice(0, 50).map((schemaIssue) => ({
          path: schemaIssue.path.join('.'),
          message: schemaIssue.message,
        })),
      });
    }

    let document: EventContextDocument;
    try {
      document = documentFromExtraction(parsed.data, {
        sources: versionSources(sources),
        newId: this.newId,
      });
    } catch (error) {
      if (error instanceof EventContextError) {
        return this.failBuild(version.id, runId, 'domain_validation_failed', {}, error.issues);
      }
      return this.failBuild(version.id, runId, 'internal_error');
    }

    try {
      await this.db.transaction(async (tx) => {
        const current = await this.requireVersion(tx, eventId, versionId, { forUpdate: true });
        assertDraft(current);
        const currentSources = await this.loadSources(tx, current.id);
        const currentState = {
          document: await this.loadDocument(tx, current),
          extraction: loadExtraction(current),
        };
        const staleInputs = [
          ...(sourceSetFingerprint(currentSources) === sourceFingerprint ? [] : ['sources']),
          ...(draftStateFingerprint(currentState) === draftFingerprint ? [] : ['draft']),
        ];
        if (staleInputs.length > 0) {
          throw new EventContextError(
            'CONTEXT_BUILD_STALE',
            'The sources or the draft changed while the build was running; the build result was discarded and your newer changes were kept',
            { details: { runId, staleInputs } },
          );
        }

        await this.writeDocument(tx, current.id, document);
        await tx
          .update(eventContextVersions)
          .set({ extractedContent: document })
          .where(eq(eventContextVersions.id, current.id));
        await tx
          .update(analysisRuns)
          .set({ state: 'succeeded', finishedAt: this.now() })
          .where(eq(analysisRuns.id, runId));
        const replacedDocument = currentState.document;
        await this.audit(tx, {
          entityType: 'event_context_version',
          entityId: current.id,
          action: EVENT_CONTEXT_AUDIT_ACTIONS.built,
          metadata: {
            runId,
            extractor: this.extractor?.name ?? null,
            sourceCount: sources.length,
            sourceFingerprint,
            ruleCount: document.rules.length,
            trackCount: document.tracks.length,
            rubricCount: document.rubrics.length,
            conflictCount: document.conflicts.length,
            replacedHumanEdits: replacesReviewedChanges,
            replacedDraftFingerprint: replacedDocument ? draftFingerprint : null,
            replacedHumanItemCount:
              replacesReviewedChanges && replacedDocument ? countHumanItems(replacedDocument) : 0,
          },
        });
      });
    } catch (error) {
      if (error instanceof EventContextError && error.code === 'CONTEXT_BUILD_STALE') {
        await this.cancelBuild(version.id, runId, 'stale_input', error.details);
        throw error;
      }
      if (error instanceof EventContextError || hasPgCode(error, PG_RESTRICT_VIOLATION)) {
        // The version stopped being a draft while extraction ran.
        await this.cancelBuild(version.id, runId, 'version_no_longer_draft');
        throw new EventContextError(
          'LOCKED_CONTEXT_IMMUTABLE',
          'The version was locked while it was being built; create a new version instead',
        );
      }
      return this.failBuild(version.id, runId, 'internal_error');
    }

    return this.getContextVersion(eventId, versionId);
  }

  // -- Human edit ----------------------------------------------------------------------------

  async editContext(
    eventId: string,
    versionId: string,
    input: UpdateEventContextRequest,
  ): Promise<ContextVersionDetail> {
    await this.mutation(() =>
      this.db.transaction(async (tx) => {
        const version = await this.requireVersion(tx, eventId, versionId, { forUpdate: true });
        assertDraft(version);
        const sources = await this.loadSources(tx, version.id);
        const sourceMap = versionSources(sources);

        const foreign = [...collectSourceIds(input.document)].filter((id) => !sourceMap.has(id));
        if (foreign.length > 0) {
          const elsewhere = await tx
            .select({ id: eventSources.id })
            .from(eventSources)
            .where(inArray(eventSources.id, foreign));
          if (elsewhere.length > 0) {
            throw new EventContextError(
              'CROSS_EVENT_REFERENCE',
              'The document references sources that belong to another context version or event',
            );
          }
        }

        const previous = await this.loadDocument(tx, version);
        const { document, changes } = applyHumanEdit(previous, input.document, {
          sources: sourceMap,
          newId: this.newId,
        });
        await this.writeDocument(tx, version.id, document);
        if (input.summary !== undefined) {
          await tx
            .update(eventContextVersions)
            .set({ summary: input.summary })
            .where(eq(eventContextVersions.id, version.id));
        }
        await this.audit(tx, {
          entityType: 'event_context_version',
          entityId: version.id,
          action: EVENT_CONTEXT_AUDIT_ACTIONS.edited,
          metadata: {
            added: changes.added.slice(0, 100),
            modified: changes.modified.slice(0, 100),
            removed: changes.removed.slice(0, 100),
            summaryChanged: input.summary !== undefined && input.summary !== version.summary,
          },
        });
      }),
    );
    return this.getContextVersion(eventId, versionId);
  }

  // -- Lock ----------------------------------------------------------------------------------

  /**
   * Locks a draft. In one transaction (serialized per event): validate, supersede the currently
   * locked version if any, then lock this one with its content hash. At most one version per
   * event is ever locked (also enforced by a partial unique index).
   */
  async lockContext(eventId: string, versionId: string): Promise<ContextVersionDetail> {
    await this.mutation(() =>
      this.db.transaction(async (tx) => {
        await this.requireEvent(tx, eventId, { forUpdate: true });
        const version = await this.requireVersion(tx, eventId, versionId, { forUpdate: true });
        if (version.status !== 'draft') {
          throw new EventContextError(
            'CONTEXT_NOT_DRAFT',
            `Only a draft can be locked (status: ${version.status})`,
          );
        }
        const [current] = await tx
          .select()
          .from(eventContextVersions)
          .where(
            and(
              eq(eventContextVersions.eventId, eventId),
              eq(eventContextVersions.status, 'locked'),
            ),
          );
        if ((current?.id ?? null) !== version.supersedesId) {
          throw new EventContextError(
            'STALE_CONTEXT_BASE',
            'This draft is not based on the currently locked version; create a new version from it instead',
          );
        }

        const sources = await this.loadSources(tx, version.id);
        const document = await this.loadDocument(tx, version);
        const issues = validateForLock(document, versionSources(sources));
        const [first] = issues;
        if (first || !document) {
          throw new EventContextError(
            first?.code ?? 'CONTEXT_CONTENT_MISSING',
            first?.message ?? 'No content',
            {
              issues,
            },
          );
        }

        const hash = lockedContentHash({ document, sources: sources.map(toSourceSummary) });
        if (current) {
          await tx
            .update(eventContextVersions)
            .set({ status: 'superseded' })
            .where(eq(eventContextVersions.id, current.id));
          await this.audit(tx, {
            entityType: 'event_context_version',
            entityId: current.id,
            action: EVENT_CONTEXT_AUDIT_ACTIONS.superseded,
            metadata: { supersededByVersionId: version.id, version: current.version },
          });
        }
        await tx
          .update(eventContextVersions)
          .set({ status: 'locked', lockedAt: this.now(), lockedContentHash: hash })
          .where(eq(eventContextVersions.id, version.id));
        await this.audit(tx, {
          entityType: 'event_context_version',
          entityId: version.id,
          action: EVENT_CONTEXT_AUDIT_ACTIONS.locked,
          metadata: {
            version: version.version,
            lockedContentHash: hash,
            supersededVersionId: current?.id ?? null,
            unresolvedCount: listUnresolved(document).length,
          },
        });
      }),
    );
    return this.getContextVersion(eventId, versionId);
  }

  // -- Internals -----------------------------------------------------------------------------

  private async failBuild(
    versionId: string,
    runId: string,
    failureCategory: AnalysisRunFailureCategory,
    details: Record<string, unknown> = {},
    issues: EventContextError['issues'] = [],
  ): Promise<never> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(analysisRuns)
        .set({ state: 'failed', finishedAt: this.now(), failureCategory })
        .where(eq(analysisRuns.id, runId));
      await this.audit(tx, {
        entityType: 'event_context_version',
        entityId: versionId,
        action: EVENT_CONTEXT_AUDIT_ACTIONS.buildFailed,
        metadata: { runId, failureCategory },
      });
    });
    throw new EventContextError(
      'CONTEXT_BUILD_FAILED',
      'The Event Context build failed; the previous draft is unchanged',
      { issues, details: { runId, failureCategory, ...details } },
    );
  }

  /**
   * A build whose input went stale (or whose version was locked) mid-flight is not a provider
   * failure: the run is `cancelled` and the sanitized reason is recorded in the audit trail.
   */
  private async cancelBuild(
    versionId: string,
    runId: string,
    reason: 'stale_input' | 'version_no_longer_draft',
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(analysisRuns)
        .set({ state: 'cancelled', finishedAt: this.now() })
        .where(eq(analysisRuns.id, runId));
      await this.audit(tx, {
        entityType: 'event_context_version',
        entityId: versionId,
        action: EVENT_CONTEXT_AUDIT_ACTIONS.buildCancelled,
        metadata: {
          runId,
          reason,
          staleInputs: Array.isArray(details['staleInputs'])
            ? (details['staleInputs'] as string[])
            : [],
        },
      });
    });
  }

  /** Maps database guard violations raised during a race to the domain error. */
  private async mutation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (hasPgCode(error, PG_RESTRICT_VIOLATION)) {
        throw new EventContextError(
          'LOCKED_CONTEXT_IMMUTABLE',
          'Locked Event Context versions cannot be changed',
        );
      }
      if (hasPgCode(error, PG_UNIQUE_VIOLATION)) {
        throw new EventContextError(
          'STALE_CONTEXT_BASE',
          'Another version of this event was locked concurrently; create a new version instead',
        );
      }
      throw error;
    }
  }

  private async audit(db: JudgeDatabase, input: Omit<AuditEventInput, 'actorId'>): Promise<void> {
    // M2: requests are authenticated; the actor is null only for unattributed system calls.
    await createDatabaseAuditSink(db).append(
      createAuditEvent({ actorId: this.actorId, ...input }, { now: this.now, newId: this.newId }),
    );
  }

  private async requireEvent(
    db: JudgeDatabase,
    eventId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<EventRow> {
    const query = db.select().from(events).where(eq(events.id, eventId));
    const [event] = options.forUpdate ? await query.for('update') : await query;
    if (!event) {
      throw new EventContextError('EVENT_NOT_FOUND', 'Event not found');
    }
    return event;
  }

  /** Loads a version only through its own event: a version of another event is "not found". */
  private async requireVersion(
    db: JudgeDatabase,
    eventId: string,
    versionId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<VersionRow> {
    const query = db
      .select()
      .from(eventContextVersions)
      .where(
        and(eq(eventContextVersions.id, versionId), eq(eventContextVersions.eventId, eventId)),
      );
    const [version] = options.forUpdate ? await query.for('update') : await query;
    if (!version) {
      await this.requireEvent(db, eventId);
      throw new EventContextError(
        'CONTEXT_VERSION_NOT_FOUND',
        'Context version not found for this event',
      );
    }
    return version;
  }

  private loadSources(db: JudgeDatabase, versionId: string): Promise<SourceRow[]> {
    return db
      .select()
      .from(eventSources)
      .where(eq(eventSources.contextVersionId, versionId))
      .orderBy(asc(eventSources.position));
  }

  /** Reassembles the document from its JSONB content and normalized rubric tables. */
  private async loadDocument(
    db: JudgeDatabase,
    version: VersionRow,
  ): Promise<EventContextDocument | null> {
    if (version.content === null) {
      return null;
    }
    const content = EventContextContent.parse(version.content);
    const trackRows = await db
      .select()
      .from(tracks)
      .where(eq(tracks.contextVersionId, version.id))
      .orderBy(asc(tracks.displayOrder));
    const rubricRows = await db
      .select()
      .from(rubrics)
      .where(eq(rubrics.contextVersionId, version.id))
      .orderBy(asc(rubrics.displayOrder));
    const criterionRows =
      rubricRows.length === 0
        ? []
        : await db
            .select()
            .from(rubricCriteria)
            .where(
              inArray(
                rubricCriteria.rubricId,
                rubricRows.map((rubric) => rubric.id),
              ),
            )
            .orderBy(asc(rubricCriteria.displayOrder));
    const anchorRows =
      criterionRows.length === 0
        ? []
        : await db
            .select()
            .from(rubricAnchors)
            .where(
              inArray(
                rubricAnchors.criterionId,
                criterionRows.map((criterion) => criterion.id),
              ),
            )
            .orderBy(asc(rubricAnchors.score));
    const trackKeyById = new Map(trackRows.map((track) => [track.id, track.key]));

    return {
      ...content,
      tracks: trackRows.map((track) => ({
        key: track.key,
        name: track.name,
        description: track.description,
        sourceIds: track.sourceIds,
        origin: track.origin,
        humanModified: track.humanModified,
      })),
      rubrics: rubricRows.map((rubric) => ({
        scope: rubric.scope,
        trackKey: rubric.trackId ? required(trackKeyById.get(rubric.trackId)) : null,
        name: rubric.name,
        scaleMin: rubric.scaleMin,
        scaleMax: rubric.scaleMax,
        sourceIds: rubric.sourceIds,
        origin: rubric.origin,
        humanModified: rubric.humanModified,
        criteria: criterionRows
          .filter((criterion) => criterion.rubricId === rubric.id)
          .map((criterion) => ({
            key: criterion.key,
            name: criterion.name,
            description: criterion.description,
            weight: criterion.weight,
            sourceIds: criterion.sourceIds,
            origin: criterion.origin,
            humanModified: criterion.humanModified,
            anchors: anchorRows
              .filter((anchor) => anchor.criterionId === criterion.id)
              .map((anchor) => ({ score: anchor.score, description: anchor.description })),
          })),
      })),
    };
  }

  /** Replaces a draft's document: JSONB content plus normalized tracks and rubrics. */
  private async writeDocument(
    db: JudgeDatabase,
    versionId: string,
    document: EventContextDocument,
  ): Promise<void> {
    await db.delete(rubrics).where(eq(rubrics.contextVersionId, versionId)); // cascades to criteria and anchors
    await db.delete(tracks).where(eq(tracks.contextVersionId, versionId));

    const trackIdByKey = new Map<string, string>();
    if (document.tracks.length > 0) {
      const inserted = await db
        .insert(tracks)
        .values(
          document.tracks.map((track, i) => ({
            contextVersionId: versionId,
            key: track.key,
            name: track.name,
            description: track.description,
            displayOrder: i,
            sourceIds: track.sourceIds,
            origin: track.origin,
            humanModified: track.humanModified,
          })),
        )
        .returning({ id: tracks.id, key: tracks.key });
      for (const row of inserted) trackIdByKey.set(row.key, row.id);
    }

    for (const [i, rubric] of document.rubrics.entries()) {
      const [rubricRow] = await db
        .insert(rubrics)
        .values({
          contextVersionId: versionId,
          trackId: rubric.trackKey === null ? null : required(trackIdByKey.get(rubric.trackKey)),
          name: rubric.name,
          scope: rubric.scope,
          scaleMin: rubric.scaleMin,
          scaleMax: rubric.scaleMax,
          displayOrder: i,
          sourceIds: rubric.sourceIds,
          origin: rubric.origin,
          humanModified: rubric.humanModified,
        })
        .returning({ id: rubrics.id });
      const rubricId = required(rubricRow).id;
      if (rubric.criteria.length === 0) continue;
      const criterionRows = await db
        .insert(rubricCriteria)
        .values(
          rubric.criteria.map((criterion, j) => ({
            rubricId,
            key: criterion.key,
            name: criterion.name,
            description: criterion.description,
            weight: criterion.weight,
            displayOrder: j,
            sourceIds: criterion.sourceIds,
            origin: criterion.origin,
            humanModified: criterion.humanModified,
          })),
        )
        .returning({ id: rubricCriteria.id, key: rubricCriteria.key });
      const criterionIdByKey = new Map(criterionRows.map((row) => [row.key, row.id]));
      const anchors = rubric.criteria.flatMap((criterion) =>
        criterion.anchors.map((anchor) => ({
          criterionId: required(criterionIdByKey.get(criterion.key)),
          score: anchor.score,
          description: anchor.description,
        })),
      );
      if (anchors.length > 0) {
        await db.insert(rubricAnchors).values(anchors);
      }
    }

    const { tracks: _tracks, rubrics: _rubrics, ...content } = document;
    await db
      .update(eventContextVersions)
      .set({ content })
      .where(eq(eventContextVersions.id, versionId));
  }
}

function assertDraft(version: VersionRow): void {
  if (isFrozenEventContextStatus(version.status)) {
    throw new EventContextError(
      'LOCKED_CONTEXT_IMMUTABLE',
      `Version ${String(version.version)} is ${version.status} and cannot be changed; create a new version instead`,
    );
  }
  if (version.status !== 'draft') {
    throw new EventContextError(
      'CONTEXT_NOT_DRAFT',
      `Version ${String(version.version)} is not a draft`,
    );
  }
}

function loadExtraction(version: VersionRow): EventContextDocument | null {
  return version.extractedContent ? EventContextDocument.parse(version.extractedContent) : null;
}

/** Items a human authored or edited — reported (as a count) when an explicit rebuild replaces them. */
function countHumanItems(document: EventContextDocument): number {
  const items = [
    ...listFacts(document).map(({ fact }) => fact),
    ...document.conflicts,
    ...document.tracks,
    ...document.rubrics,
    ...document.rubrics.flatMap((rubric) => rubric.criteria),
  ];
  return items.filter((item) => item.origin === 'human' || item.humanModified).length;
}

function versionSources(sources: readonly SourceRow[]): VersionSources {
  return new Map(sources.map((source) => [source.id, source.authority]));
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error('Expected a value to be present');
  }
  return value;
}

function hasPgCode(error: unknown, code: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === code) return true;
  }
  return false;
}
