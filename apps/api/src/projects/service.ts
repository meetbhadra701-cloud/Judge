import { createHash, randomUUID } from 'node:crypto';
import { createAuditEvent, type AuditEventInput } from '@judge-copilot/audit';
import {
  normalizeDeclaredSourceUrl,
  parseDevpostProjectUrl,
  parseGithubRepositoryUrl,
  safeHost,
} from '@judge-copilot/capture';
import {
  analysisRuns,
  createDatabaseAuditSink,
  eventContextVersions,
  events,
  projectSources,
  projectSubmissionRequests,
  projectSubmissions,
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
  type SubmissionIntegrityFinding,
  type SubmissionIntegrityReport,
  type SubmitProjectRequest,
  type SubmitProjectResponse,
  type SnapshotDetail,
  type SnapshotSummary,
} from '@judge-copilot/schemas';
import { and, asc, count, desc, eq, inArray, max, or, sql, sum } from 'drizzle-orm';
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
  submissionCreated: 'project_submission_created',
  submissionConverged: 'project_submission_converged',
} as const;

const PG_UNIQUE_VIOLATION = '23505';
const PG_DEADLOCK = '40P01';
const PG_SERIALIZATION_FAILURE = '40001';
/** How often one submission request re-reads committed state after losing a race to a concurrent submission. */
const SUBMISSION_ATTEMPTS = 4;

function hasPgCode(error: unknown, code: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === code) return true;
  }
  return false;
}

interface SubmissionIntent {
  readonly eventId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly githubUrl: string;
  readonly devpostUrl: string;
  readonly name: string;
  readonly requestHash: string;
}

interface SubmissionOutcome {
  readonly result: SubmitProjectResponse['result'];
  readonly projectId: string;
  readonly captureRuns: SubmitProjectResponse['captureRuns'];
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
        const locked = await this.lockedContextOf(tx, eventId);
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
        const project = await this.insertProject(tx, {
          eventId,
          contextVersionId: locked.id,
          name: input.name.trim(),
          teamName: input.teamName?.trim() ?? null,
          trackCount: declared.length,
          actorId,
          now,
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
        await this.requireSubmissionSource(tx, projectId, input.sourceType, normalized.url);
        const inserted = await this.insertSource(tx, {
          projectId,
          sourceType: input.sourceType,
          url: normalized.url,
          position: stats?.last === null || stats?.last === undefined ? 0 : stats.last + 1,
          actorId,
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

  // -- Submissions (P6B-beta1) -----------------------------------------------------------------

  /**
   * One submission = one logical intent: a GitHub repository plus a Devpost page, for one event. Project, submission record, both source
   * declarations and both capture requests are written in ONE transaction, or not at all. Identity is the canonical (event, GitHub URL,
   * Devpost URL); a project name is a label and never identity.
   *
   *   same actor + same Idempotency-Key + same content   -> `replayed` (the original project; nothing is written or requested again)
   *   same actor + same Idempotency-Key + other content  -> IDEMPOTENCY_KEY_REUSED
   *   other request, identical GitHub + Devpost pair     -> `already_submitted` (proven-equivalent content converges on one project)
   *   any other overlap (one shared link, a name that
   *   differs only by case)                              -> SUBMISSION_CONFLICT / PROJECT_NAME_TAKEN, nothing is written
   *
   * The checks read committed state; the database's unique constraints (migration 0015) are the backstop for concurrent requests. A
   * request that loses such a race throws a unique violation, its transaction rolls back completely, and it is simply run again: the
   * checks then see the winner's committed rows and answer correctly. No answer is ever derived from an error message.
   */
  async submitProject(
    eventId: string,
    input: SubmitProjectRequest,
    actorId: string,
    idempotencyKey: string,
  ): Promise<SubmitProjectResponse> {
    const github = parseGithubRepositoryUrl(input.githubUrl);
    if (typeof github === 'string') {
      throw new SourceIngestionError('INVALID_SOURCE_URL', 'The GitHub URL is not valid', {
        sourceType: 'github',
        reason: github,
        field: 'github',
      });
    }
    const devpost = parseDevpostProjectUrl(input.devpostUrl);
    if (typeof devpost === 'string') {
      throw new SourceIngestionError('INVALID_SOURCE_URL', 'The Devpost URL is not valid', {
        sourceType: 'devpost',
        reason: devpost,
        field: 'devpost',
      });
    }
    const typedName = input.name?.trim() ?? null;
    const intent: SubmissionIntent = {
      eventId,
      actorId,
      idempotencyKey: idempotencyKey.toLowerCase(),
      githubUrl: github.canonicalUrl,
      devpostUrl: devpost.canonicalUrl,
      name: typedName ?? `${github.owner}/${github.repo}`,
      requestHash: createHash('sha256')
        .update(
          JSON.stringify([
            'judge.submission.v1',
            eventId,
            github.canonicalUrl,
            devpost.canonicalUrl,
            typedName,
          ]),
        )
        .digest('hex'),
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.db.transaction((tx) => this.submitOnce(tx, intent));
        return {
          result: outcome.result,
          project: await this.getProject(outcome.projectId),
          captureRuns: outcome.captureRuns,
        };
      } catch (error) {
        const lostRace =
          hasPgCode(error, PG_UNIQUE_VIOLATION) ||
          hasPgCode(error, PG_DEADLOCK) ||
          hasPgCode(error, PG_SERIALIZATION_FAILURE);
        if (!lostRace) throw error;
        if (attempt >= SUBMISSION_ATTEMPTS) {
          throw new SourceIngestionError(
            'SUBMISSION_CONFLICT',
            'This submission conflicts with another one that is being recorded right now. Try again.',
          );
        }
      }
    }
  }

  private async submitOnce(
    tx: JudgeDatabase,
    intent: SubmissionIntent,
  ): Promise<SubmissionOutcome> {
    const locked = await this.lockedContextOf(tx, intent.eventId);

    // 1. the same key: a retry (same content) or a reuse (different content)
    const [request] = await tx
      .select()
      .from(projectSubmissionRequests)
      .where(
        and(
          eq(projectSubmissionRequests.actorId, intent.actorId),
          eq(projectSubmissionRequests.idempotencyKey, intent.idempotencyKey),
        ),
      );
    if (request) {
      if (request.requestHash !== intent.requestHash) {
        throw new SourceIngestionError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different submission',
          { projectId: request.projectId },
        );
      }
      return { result: 'replayed', projectId: request.projectId, captureRuns: [] };
    }

    // 2. an identical pair already submitted to this event: proven-equivalent content converges on that project
    const [same] = await tx
      .select()
      .from(projectSubmissions)
      .where(
        and(
          eq(projectSubmissions.eventId, intent.eventId),
          eq(projectSubmissions.githubUrl, intent.githubUrl),
          eq(projectSubmissions.devpostUrl, intent.devpostUrl),
        ),
      );
    if (same) {
      await this.insertSubmissionRequest(tx, intent, same.id, same.projectId, 'already_submitted');
      await this.audit(tx, intent.actorId, {
        entityType: 'project',
        entityId: same.projectId,
        action: SOURCE_INGESTION_AUDIT_ACTIONS.submissionConverged,
        metadata: { eventId: intent.eventId, submissionId: same.id },
      });
      return { result: 'already_submitted', projectId: same.projectId, captureRuns: [] };
    }

    // 3. a partial overlap is a DIFFERENT intent: never merged, never silently adopted
    const overlapping = await tx
      .select({ projectId: projectSubmissions.projectId })
      .from(projectSubmissions)
      .where(
        and(
          eq(projectSubmissions.eventId, intent.eventId),
          or(
            eq(projectSubmissions.githubUrl, intent.githubUrl),
            eq(projectSubmissions.devpostUrl, intent.devpostUrl),
          ),
        ),
      );
    const legacy = await tx
      .select({ projectId: projectSources.projectId })
      .from(projectSources)
      .innerJoin(projects, eq(projects.id, projectSources.projectId))
      .where(
        and(
          eq(projects.eventId, intent.eventId),
          or(
            and(eq(projectSources.sourceType, 'github'), eq(projectSources.url, intent.githubUrl)),
            and(
              eq(projectSources.sourceType, 'devpost'),
              eq(projectSources.url, intent.devpostUrl),
            ),
          ),
        ),
      );
    const conflicting = [...new Set([...overlapping, ...legacy].map((row) => row.projectId))];
    if (conflicting.length > 0) {
      throw new SourceIngestionError(
        'SUBMISSION_CONFLICT',
        'Another project in this event already uses this GitHub repository or Devpost page',
        { projectIds: conflicting },
      );
    }

    // 4. a name that differs only by case is the same label
    const [named] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.eventId, intent.eventId),
          sql`lower(btrim(${projects.name})) = ${intent.name.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (named) {
      throw new SourceIngestionError(
        'PROJECT_NAME_TAKEN',
        'A project with this name (ignoring letter case) already exists for the event',
        { field: 'name' },
      );
    }

    // 5. write everything, or nothing
    const now = this.now();
    const project = await this.insertProject(tx, {
      eventId: intent.eventId,
      contextVersionId: locked.id,
      name: intent.name,
      teamName: null,
      trackCount: 0,
      actorId: intent.actorId,
      now,
    });
    const [submission] = await tx
      .insert(projectSubmissions)
      .values({
        id: this.newId(),
        eventId: intent.eventId,
        projectId: project.id,
        submittedByActorId: intent.actorId,
        githubUrl: intent.githubUrl,
        devpostUrl: intent.devpostUrl,
        nameKey: intent.name.toLowerCase(),
        createdAt: now,
      })
      .returning();
    if (!submission) throw new Error('submission insert returned nothing');
    await this.insertSubmissionRequest(tx, intent, submission.id, project.id, 'created');
    await this.audit(tx, intent.actorId, {
      entityType: 'project',
      entityId: project.id,
      action: SOURCE_INGESTION_AUDIT_ACTIONS.submissionCreated,
      metadata: { eventId: intent.eventId, submissionId: submission.id },
    });
    const captureRuns: SubmissionOutcome['captureRuns'] = [];
    const declarations = [
      { sourceType: 'github' as const, url: intent.githubUrl },
      { sourceType: 'devpost' as const, url: intent.devpostUrl },
    ];
    for (const [position, declaration] of declarations.entries()) {
      const source = await this.insertSource(tx, {
        projectId: project.id,
        ...declaration,
        position,
        actorId: intent.actorId,
      });
      const capture = await this.createCapture(tx, project, source.id, intent.actorId);
      captureRuns.push({
        sourceId: source.id,
        snapshotId: capture.snapshot.id,
        runId: capture.runId,
      });
    }
    return { result: 'created', projectId: project.id, captureRuns };
  }

  /**
   * Read-only detection of projects that do not form one submission: several GitHub (or Devpost) sources in one project, or one link
   * claimed by several projects. It never repairs or deletes anything; the remediation is an operator decision (docs/DEMO_RUNBOOK.md).
   */
  async submissionIntegrity(eventId: string): Promise<SubmissionIntegrityReport> {
    const [event] = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId));
    if (!event) throw new SourceIngestionError('EVENT_NOT_FOUND', 'Event not found');
    const projectRows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.eventId, eventId));
    const sources = await this.db
      .select({
        projectId: projectSources.projectId,
        sourceType: projectSources.sourceType,
        url: projectSources.url,
      })
      .from(projectSources)
      .innerJoin(projects, eq(projects.id, projectSources.projectId))
      .where(
        and(
          eq(projects.eventId, eventId),
          inArray(projectSources.sourceType, ['github', 'devpost']),
        ),
      )
      .orderBy(asc(projectSources.projectId), asc(projectSources.position));
    const recorded = await this.db
      .select({ projectId: projectSubmissions.projectId })
      .from(projectSubmissions)
      .where(eq(projectSubmissions.eventId, eventId));
    const findings: SubmissionIntegrityFinding[] = [];
    for (const sourceType of ['github', 'devpost'] as const) {
      const ofType = sources.filter((source) => source.sourceType === sourceType);
      const byProject = new Map<string, string[]>();
      const byUrl = new Map<string, Set<string>>();
      for (const source of ofType) {
        byProject.set(source.projectId, [...(byProject.get(source.projectId) ?? []), source.url]);
        const owners = byUrl.get(source.url) ?? new Set<string>();
        owners.add(source.projectId);
        byUrl.set(source.url, owners);
      }
      for (const [projectId, urls] of byProject) {
        if (urls.length > 1) {
          findings.push({
            kind: 'multiple_sources_of_one_type',
            sourceType,
            urls,
            projectIds: [projectId],
          });
        }
      }
      for (const [url, owners] of byUrl) {
        if (owners.size > 1) {
          findings.push({
            kind: 'shared_source_url',
            sourceType,
            urls: [url],
            projectIds: [...owners].sort(),
          });
        }
      }
    }
    return {
      eventId,
      projectsChecked: projectRows.length,
      projectsWithoutSubmissionRecord: projectRows.length - recorded.length,
      findings,
    };
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

  private async lockedContextOf(tx: JudgeDatabase, eventId: string): Promise<{ id: string }> {
    const [event] = await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId));
    if (!event) throw new SourceIngestionError('EVENT_NOT_FOUND', 'Event not found');
    // Serialize against a concurrent lock/supersede of this event's context.
    const [locked] = await tx
      .select({ id: eventContextVersions.id })
      .from(eventContextVersions)
      .where(
        and(eq(eventContextVersions.eventId, eventId), eq(eventContextVersions.status, 'locked')),
      )
      .for('share');
    if (!locked) {
      throw new SourceIngestionError(
        'NO_LOCKED_CONTEXT',
        'Projects require a locked Event Context for this event',
      );
    }
    return locked;
  }

  private async insertProject(
    tx: JudgeDatabase,
    input: {
      eventId: string;
      contextVersionId: string;
      name: string;
      teamName: string | null;
      trackCount: number;
      actorId: string | null;
      now: Date;
    },
  ): Promise<ProjectRow> {
    const [project] = await tx
      .insert(projects)
      .values({
        id: this.newId(),
        eventId: input.eventId,
        name: input.name,
        teamName: input.teamName,
        createdByActorId: input.actorId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (!project) throw new Error('project insert returned nothing');
    await this.audit(tx, input.actorId, {
      entityType: 'project',
      entityId: project.id,
      action: SOURCE_INGESTION_AUDIT_ACTIONS.projectCreated,
      metadata: {
        eventId: input.eventId,
        contextVersionId: input.contextVersionId,
        trackCount: input.trackCount,
      },
    });
    return project;
  }

  private async insertSource(
    tx: JudgeDatabase,
    input: {
      projectId: string;
      sourceType: AddProjectSourceRequest['sourceType'];
      url: string;
      position: number;
      actorId: string | null;
    },
  ) {
    const [inserted] = await tx
      .insert(projectSources)
      .values({
        id: this.newId(),
        projectId: input.projectId,
        sourceType: input.sourceType,
        url: input.url,
        position: input.position,
        createdByActorId: input.actorId,
        createdAt: this.now(),
      })
      .returning();
    if (!inserted) throw new Error('source insert returned nothing');
    const host = safeHost(input.url);
    await this.audit(tx, input.actorId, {
      entityType: 'project_source',
      entityId: inserted.id,
      action: SOURCE_INGESTION_AUDIT_ACTIONS.sourceAdded,
      metadata: {
        projectId: input.projectId,
        sourceType: inserted.sourceType,
        position: inserted.position,
        ...(host ? { host } : {}),
      },
    });
    return inserted;
  }

  /** A project that belongs to a submission has exactly that submission's GitHub and Devpost links. */
  private async requireSubmissionSource(
    tx: JudgeDatabase,
    projectId: string,
    sourceType: AddProjectSourceRequest['sourceType'],
    url: string,
  ): Promise<void> {
    if (sourceType !== 'github' && sourceType !== 'devpost') return;
    const [submission] = await tx
      .select()
      .from(projectSubmissions)
      .where(eq(projectSubmissions.projectId, projectId));
    if (!submission) return;
    const fixed = sourceType === 'github' ? submission.githubUrl : submission.devpostUrl;
    if (url !== fixed) {
      throw new SourceIngestionError(
        'SUBMISSION_SOURCE_FIXED',
        `This project belongs to a submission with a different ${sourceType} link; submit the other link as its own submission`,
        { sourceType },
      );
    }
  }

  private async insertSubmissionRequest(
    tx: JudgeDatabase,
    intent: SubmissionIntent,
    submissionId: string,
    projectId: string,
    result: 'created' | 'already_submitted',
  ): Promise<void> {
    await tx.insert(projectSubmissionRequests).values({
      id: this.newId(),
      actorId: intent.actorId,
      idempotencyKey: intent.idempotencyKey,
      requestHash: intent.requestHash,
      submissionId,
      projectId,
      result,
      createdAt: this.now(),
    });
  }

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
