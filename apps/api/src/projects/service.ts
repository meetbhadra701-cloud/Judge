import { randomUUID } from 'node:crypto';
import { createAuditEvent, type AuditEventInput } from '@judge-copilot/audit';
import { normalizeDeclaredSourceUrl, safeHost } from '@judge-copilot/capture';
import {
  analysisRuns,
  createDatabaseAuditSink,
  eventContextVersions,
  events,
  projectSources,
  projects,
  projectTrackSelections,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  tracks,
  type JudgeDatabase,
} from '@judge-copilot/database';
import {
  SOURCE_INGESTION_LIMITS,
  type AddProjectSourceRequest,
  type ArtifactDetail,
  type CaptureAllResponse,
  type CaptureRequestedResponse,
  type CreateProjectRequest,
  type ProjectDetail,
  type ProjectRecord,
  type ProjectSourceRecord,
  type ProjectTrackSelectionRecord,
  type SnapshotDetail,
  type SnapshotSummary,
} from '@judge-copilot/schemas';
import { and, asc, count, desc, eq, inArray, max, sql, sum } from 'drizzle-orm';
import { SourceIngestionError } from './errors.js';
import {
  toArtifactSummary,
  toFailureMetadata,
  toProjectRecord,
  toRunRecord,
  toSnapshotSummary,
  toSourceRecord,
  type ProjectRow,
  type SnapshotRow,
} from './mappers.js';

export const SOURCE_CAPTURE_RUN_TYPE = 'project_source_capture';

/** Audit actions recorded by the project-source workflow (M2). Metadata is always safe. */
export const SOURCE_INGESTION_AUDIT_ACTIONS = {
  projectCreated: 'project_created',
  trackDeclared: 'project_track_declared',
  sourceAdded: 'project_source_added',
  captureRequested: 'source_capture_requested',
} as const;

const PG_UNIQUE_VIOLATION = '23505';

function hasPgCode(error: unknown, code: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === code) return true;
  }
  return false;
}

export interface ProjectServiceOptions {
  db: JudgeDatabase;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Projects, declared sources and capture requests. Requesting a capture only creates a new
 * pending snapshot plus a pending analysis run (the durable work item); the worker performs the
 * capture outside any request. Nothing here fetches a URL, scores, or creates evidence.
 */
export class ProjectService {
  private readonly db: JudgeDatabase;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: ProjectServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  // -- Projects ------------------------------------------------------------------------------

  async createProject(
    eventId: string,
    input: CreateProjectRequest,
    actorId: string | null,
  ): Promise<ProjectRecord> {
    const trackKeys = input.trackKeys ?? [];
    try {
      const projectId = await this.db.transaction(async (tx) => {
        const [event] = await tx
          .select({ id: events.id })
          .from(events)
          .where(eq(events.id, eventId));
        if (!event) throw new SourceIngestionError('EVENT_NOT_FOUND', 'Event not found');
        // Serialize against a concurrent lock/supersede of this event's context.
        const [locked] = await tx
          .select({ id: eventContextVersions.id })
          .from(eventContextVersions)
          .where(
            and(
              eq(eventContextVersions.eventId, eventId),
              eq(eventContextVersions.status, 'locked'),
            ),
          )
          .for('share');
        if (!locked) {
          throw new SourceIngestionError(
            'NO_LOCKED_CONTEXT',
            'Projects require a locked Event Context for this event',
          );
        }
        const declared =
          trackKeys.length === 0
            ? []
            : await tx
                .select({ id: tracks.id, key: tracks.key })
                .from(tracks)
                .where(and(eq(tracks.contextVersionId, locked.id), inArray(tracks.key, trackKeys)));
        const known = new Set(declared.map((track) => track.key));
        const unknown = trackKeys.filter((key) => !known.has(key));
        if (unknown.length > 0) {
          throw new SourceIngestionError(
            'UNKNOWN_TRACK',
            'Every declared track must exist in the locked Event Context',
            { unknownTrackKeys: unknown },
          );
        }
        const now = this.now();
        const [project] = await tx
          .insert(projects)
          .values({
            id: this.newId(),
            eventId,
            name: input.name.trim(),
            teamName: input.teamName?.trim() ?? null,
            createdByActorId: actorId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!project) throw new Error('project insert returned nothing');
        await this.audit(tx, actorId, {
          entityType: 'project',
          entityId: project.id,
          action: SOURCE_INGESTION_AUDIT_ACTIONS.projectCreated,
          metadata: { eventId, contextVersionId: locked.id, trackCount: declared.length },
        });
        for (const key of trackKeys) {
          const track = declared.find((candidate) => candidate.key === key);
          if (!track) continue;
          await tx.insert(projectTrackSelections).values({
            id: this.newId(),
            projectId: project.id,
            eventId,
            contextVersionId: locked.id,
            trackId: track.id,
            trackKey: track.key,
            declaredByActorId: actorId,
            declaredAt: now,
          });
          await this.audit(tx, actorId, {
            entityType: 'project',
            entityId: project.id,
            action: SOURCE_INGESTION_AUDIT_ACTIONS.trackDeclared,
            metadata: { trackKey: track.key, trackId: track.id, contextVersionId: locked.id },
          });
        }
        return project.id;
      });
      return await this.projectRecord(projectId);
    } catch (error) {
      if (hasPgCode(error, PG_UNIQUE_VIOLATION)) {
        throw new SourceIngestionError(
          'PROJECT_NAME_TAKEN',
          'A project with this name already exists for the event',
        );
      }
      throw error;
    }
  }

  async listProjects(eventId: string): Promise<ProjectRecord[]> {
    const [event] = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId));
    if (!event) throw new SourceIngestionError('EVENT_NOT_FOUND', 'Event not found');
    const rows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.eventId, eventId))
      .orderBy(asc(projects.createdAt), asc(projects.name));
    const tracksByProject = await this.trackSelections(rows.map((row) => row.id));
    return rows.map((row) => toProjectRecord(row, tracksByProject.get(row.id) ?? []));
  }

  async getProject(projectId: string): Promise<ProjectDetail> {
    const record = await this.projectRecord(projectId);
    return { ...record, sources: await this.listSources(projectId) };
  }

  // -- Sources -------------------------------------------------------------------------------

  async addSource(
    projectId: string,
    input: AddProjectSourceRequest,
    actorId: string | null,
  ): Promise<ProjectSourceRecord> {
    const normalized = normalizeDeclaredSourceUrl(input.sourceType, input.url);
    if (!normalized.ok) {
      throw new SourceIngestionError(
        'INVALID_SOURCE_URL',
        'The URL is not valid for this source type',
        {
          sourceType: input.sourceType,
          reason: normalized.reason,
        },
      );
    }
    try {
      const row = await this.db.transaction(async (tx) => {
        await this.requireProject(tx, projectId, { lock: true });
        const [stats] = await tx
          .select({ total: count(), last: max(projectSources.position) })
          .from(projectSources)
          .where(eq(projectSources.projectId, projectId));
        if ((stats?.total ?? 0) >= SOURCE_INGESTION_LIMITS.sourcesPerProject) {
          throw new SourceIngestionError(
            'SOURCE_LIMIT_REACHED',
            'This project already has the maximum number of sources',
            {
              limit: SOURCE_INGESTION_LIMITS.sourcesPerProject,
            },
          );
        }
        const [inserted] = await tx
          .insert(projectSources)
          .values({
            id: this.newId(),
            projectId,
            sourceType: input.sourceType,
            url: normalized.url,
            position: stats?.last === null || stats?.last === undefined ? 0 : stats.last + 1,
            createdByActorId: actorId,
            createdAt: this.now(),
          })
          .returning();
        if (!inserted) throw new Error('source insert returned nothing');
        const host = safeHost(normalized.url);
        await this.audit(tx, actorId, {
          entityType: 'project_source',
          entityId: inserted.id,
          action: SOURCE_INGESTION_AUDIT_ACTIONS.sourceAdded,
          metadata: {
            projectId,
            sourceType: inserted.sourceType,
            position: inserted.position,
            ...(host ? { host } : {}),
          },
        });
        return inserted;
      });
      return toSourceRecord(row, null);
    } catch (error) {
      if (hasPgCode(error, PG_UNIQUE_VIOLATION)) {
        throw new SourceIngestionError(
          'DUPLICATE_SOURCE',
          'This source is already declared for the project',
          {
            sourceType: input.sourceType,
          },
        );
      }
      throw error;
    }
  }

  async listSources(projectId: string): Promise<ProjectSourceRecord[]> {
    await this.requireProject(this.db, projectId);
    const sources = await this.db
      .select()
      .from(projectSources)
      .where(eq(projectSources.projectId, projectId))
      .orderBy(asc(projectSources.position));
    const snapshots = await this.snapshotSummaries(projectId);
    return sources.map((source) =>
      toSourceRecord(source, snapshots.find((snapshot) => snapshot.sourceId === source.id) ?? null),
    );
  }

  // -- Captures ------------------------------------------------------------------------------

  async requestCapture(
    projectId: string,
    sourceId: string,
    actorId: string | null,
  ): Promise<CaptureRequestedResponse> {
    const { snapshot, runId } = await this.db.transaction(async (tx) => {
      const project = await this.requireProject(tx, projectId);
      return this.createCapture(tx, project, sourceId, actorId);
    });
    return { snapshot: toSnapshotSummary(snapshot, { artifactCount: 0, artifactBytes: 0 }), runId };
  }

  async requestAllCaptures(projectId: string, actorId: string | null): Promise<CaptureAllResponse> {
    return this.db.transaction(async (tx) => {
      const project = await this.requireProject(tx, projectId);
      const sources = await tx
        .select({ id: projectSources.id })
        .from(projectSources)
        .where(eq(projectSources.projectId, projectId))
        .orderBy(asc(projectSources.position));
      const requested: CaptureRequestedResponse[] = [];
      const skippedSourceIds: string[] = [];
      for (const source of sources) {
        const pending = await this.pendingSnapshot(tx, source.id);
        if (pending) {
          skippedSourceIds.push(source.id);
          continue;
        }
        const created = await this.createCapture(tx, project, source.id, actorId);
        requested.push({
          snapshot: toSnapshotSummary(created.snapshot, { artifactCount: 0, artifactBytes: 0 }),
          runId: created.runId,
        });
      }
      return { requested, skippedSourceIds };
    });
  }

  // -- Snapshots -----------------------------------------------------------------------------

  /** Newest first. */
  async listSnapshots(projectId: string): Promise<SnapshotSummary[]> {
    await this.requireProject(this.db, projectId);
    return this.snapshotSummaries(projectId);
  }

  async getSnapshot(projectId: string, snapshotId: string): Promise<SnapshotDetail> {
    await this.requireProject(this.db, projectId);
    const [row] = await this.db
      .select()
      .from(sourceSnapshots)
      .where(and(eq(sourceSnapshots.id, snapshotId), eq(sourceSnapshots.projectId, projectId)));
    if (!row) throw new SourceIngestionError('SNAPSHOT_NOT_FOUND', 'Snapshot not found');
    const artifacts = await this.db
      .select({
        id: sourceSnapshotArtifacts.id,
        snapshotId: sourceSnapshotArtifacts.snapshotId,
        artifactKey: sourceSnapshotArtifacts.artifactKey,
        artifactKind: sourceSnapshotArtifacts.artifactKind,
        mediaType: sourceSnapshotArtifacts.mediaType,
        metadata: sourceSnapshotArtifacts.metadata,
        byteLength: sourceSnapshotArtifacts.byteLength,
        contentHash: sourceSnapshotArtifacts.contentHash,
        createdAt: sourceSnapshotArtifacts.createdAt,
      })
      .from(sourceSnapshotArtifacts)
      .where(eq(sourceSnapshotArtifacts.snapshotId, snapshotId))
      // Byte order (`COLLATE "C"`), so the listing is identical whatever the database locale.
      .orderBy(sql`${sourceSnapshotArtifacts.artifactKey} COLLATE "C"`);
    const [run] = await this.db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.sourceSnapshotId, snapshotId));
    const summaries = artifacts.map(toArtifactSummary);
    return {
      ...toSnapshotSummary(row, {
        artifactCount: summaries.length,
        artifactBytes: summaries.reduce((total, artifact) => total + artifact.byteLength, 0),
      }),
      metadata: (row.metadata as SnapshotDetail['metadata']) ?? null,
      failureMetadata: toFailureMetadata(row.failureMetadata),
      artifacts: summaries,
      run: run ? toRunRecord(run) : null,
    };
  }

  async getArtifact(
    projectId: string,
    snapshotId: string,
    artifactId: string,
  ): Promise<ArtifactDetail> {
    await this.requireProject(this.db, projectId);
    const [row] = await this.db
      .select({ artifact: sourceSnapshotArtifacts })
      .from(sourceSnapshotArtifacts)
      .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, sourceSnapshotArtifacts.snapshotId))
      .where(
        and(
          eq(sourceSnapshotArtifacts.id, artifactId),
          eq(sourceSnapshotArtifacts.snapshotId, snapshotId),
          eq(sourceSnapshots.projectId, projectId),
        ),
      );
    if (!row) throw new SourceIngestionError('ARTIFACT_NOT_FOUND', 'Artifact not found');
    return { ...toArtifactSummary(row.artifact), textContent: row.artifact.textContent };
  }

  // -- Internals -----------------------------------------------------------------------------

  private async createCapture(
    tx: JudgeDatabase,
    project: ProjectRow,
    sourceId: string,
    actorId: string | null,
  ): Promise<{ snapshot: SnapshotRow; runId: string }> {
    // Row lock on the (immutable) declaration serializes capture-number assignment.
    const [source] = await tx
      .select()
      .from(projectSources)
      .where(and(eq(projectSources.id, sourceId), eq(projectSources.projectId, project.id)))
      .for('update');
    if (!source)
      throw new SourceIngestionError('SOURCE_NOT_FOUND', 'Source not found for this project');
    if (await this.pendingSnapshot(tx, source.id)) {
      throw new SourceIngestionError(
        'CAPTURE_ALREADY_PENDING',
        'A capture of this source is already pending',
      );
    }
    const [last] = await tx
      .select({ number: max(sourceSnapshots.captureNumber) })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.projectSourceId, source.id));
    const captureNumber = (last?.number ?? 0) + 1;
    const now = this.now();
    const [snapshot] = await tx
      .insert(sourceSnapshots)
      .values({
        id: this.newId(),
        projectId: project.id,
        projectSourceId: source.id,
        captureNumber,
        sourceType: source.sourceType,
        sourceUrl: source.url,
        status: 'pending',
        requestedByActorId: actorId,
        createdAt: now,
      })
      .returning();
    if (!snapshot) throw new Error('snapshot insert returned nothing');
    const runId = this.newId();
    await tx.insert(analysisRuns).values({
      id: runId,
      eventId: project.eventId,
      projectId: project.id,
      sourceSnapshotId: snapshot.id,
      runType: SOURCE_CAPTURE_RUN_TYPE,
      state: 'pending',
      startedAt: null,
      createdAt: now,
    });
    await this.audit(tx, actorId, {
      entityType: 'source_snapshot',
      entityId: snapshot.id,
      action: SOURCE_INGESTION_AUDIT_ACTIONS.captureRequested,
      metadata: {
        projectId: project.id,
        sourceId: source.id,
        sourceType: source.sourceType,
        captureNumber,
        runId,
      },
    });
    return { snapshot, runId };
  }

  private async pendingSnapshot(tx: JudgeDatabase, sourceId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: sourceSnapshots.id })
      .from(sourceSnapshots)
      .where(
        and(eq(sourceSnapshots.projectSourceId, sourceId), eq(sourceSnapshots.status, 'pending')),
      )
      .limit(1);
    return row !== undefined;
  }

  private async snapshotSummaries(projectId: string): Promise<SnapshotSummary[]> {
    const rows = await this.db
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.projectId, projectId))
      .orderBy(desc(sourceSnapshots.createdAt), desc(sourceSnapshots.captureNumber));
    if (rows.length === 0) return [];
    const totals = await this.db
      .select({
        snapshotId: sourceSnapshotArtifacts.snapshotId,
        artifactCount: count(),
        artifactBytes: sum(sourceSnapshotArtifacts.byteLength),
      })
      .from(sourceSnapshotArtifacts)
      .where(
        inArray(
          sourceSnapshotArtifacts.snapshotId,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(sourceSnapshotArtifacts.snapshotId);
    const byId = new Map(totals.map((total) => [total.snapshotId, total]));
    return rows.map((row) => {
      const total = byId.get(row.id);
      return toSnapshotSummary(row, {
        artifactCount: total?.artifactCount ?? 0,
        artifactBytes: Number(total?.artifactBytes ?? 0),
      });
    });
  }

  private async projectRecord(projectId: string): Promise<ProjectRecord> {
    const project = await this.requireProject(this.db, projectId);
    const tracksByProject = await this.trackSelections([project.id]);
    return toProjectRecord(project, tracksByProject.get(project.id) ?? []);
  }

  private async trackSelections(
    projectIds: string[],
  ): Promise<Map<string, ProjectTrackSelectionRecord[]>> {
    const result = new Map<string, ProjectTrackSelectionRecord[]>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select({
        selection: projectTrackSelections,
        trackName: tracks.name,
        contextVersion: eventContextVersions.version,
      })
      .from(projectTrackSelections)
      .innerJoin(tracks, eq(tracks.id, projectTrackSelections.trackId))
      .innerJoin(
        eventContextVersions,
        eq(eventContextVersions.id, projectTrackSelections.contextVersionId),
      )
      .where(inArray(projectTrackSelections.projectId, projectIds))
      .orderBy(asc(projectTrackSelections.trackKey));
    for (const row of rows) {
      const list = result.get(row.selection.projectId) ?? [];
      list.push({
        id: row.selection.id,
        trackId: row.selection.trackId,
        trackKey: row.selection.trackKey,
        trackName: row.trackName,
        contextVersionId: row.selection.contextVersionId,
        contextVersion: row.contextVersion,
        declaredAt: row.selection.declaredAt.toISOString(),
      });
      result.set(row.selection.projectId, list);
    }
    return result;
  }

  private async requireProject(
    db: JudgeDatabase,
    projectId: string,
    options: { lock?: boolean } = {},
  ): Promise<ProjectRow> {
    const query = db.select().from(projects).where(eq(projects.id, projectId));
    const [project] = options.lock ? await query.for('update') : await query;
    if (!project) throw new SourceIngestionError('PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }

  private async audit(
    db: JudgeDatabase,
    actorId: string | null,
    input: Omit<AuditEventInput, 'actorId'>,
  ): Promise<void> {
    await createDatabaseAuditSink(db).append(
      createAuditEvent({ actorId, ...input }, { now: this.now, newId: this.newId }),
    );
  }
}
