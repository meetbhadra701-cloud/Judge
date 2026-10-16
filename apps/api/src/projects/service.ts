import { createHash, randomUUID } from 'node:crypto';
import { createAuditEvent, type AuditEventInput } from '@judge-copilot/audit';
import {
  normalizeDeclaredSourceUrl,
  parseDevpostProjectUrl,
  parseGithubRepositoryUrl,
  safeHost,
  codePointLength,
  normalizeSuppliedText,
  snapshotContentHash,
  suppliedDevpostResult,
  isContentResult,
} from '@judge-copilot/capture';
import {
  analysisRuns,
  AssessmentRunStore,
  createDatabaseAuditSink,
  eventContextVersions,
  events,
  projectReplacements,
  projectSources,
  projectSubmissionClaims,
  projectSubmissionRequests,
  projectSubmissions,
  projects,
  projectTrackSelections,
  projectVoids,
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
  type ProjectVoidInfo,
  type RegistryProblem,
  type SubmissionIntegrityFinding,
  type SubmissionIntegrityReport,
  type SubmitProjectRequest,
  type SubmitProjectResponse,
  type SupplyContentResponse,
  type VoidProjectRequest,
  type VoidProjectResponse,
  type SnapshotDetail,
  type SnapshotSummary,
} from '@judge-copilot/schemas';
import { and, asc, count, desc, eq, inArray, isNull, max, or, sql, sum } from 'drizzle-orm';
import { SourceIngestionError } from './errors.js';
import {
  toArtifactSummary,
  toFailureMetadata,
  toProjectRecord,
  toRunRecord,
  toSnapshotSummary,
  isUsable,
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
  projectVoided: 'project_voided',
  projectReplaced: 'project_replaced',
  contentSupplied: 'source_content_supplied',
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

/** True when the database error (anywhere in its cause chain) has this SQLSTATE and, when given, was raised for this named constraint. */
function hasPgViolation(error: unknown, code: string, constraint?: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (candidate.code !== code) continue;
    if (constraint === undefined) return true;
    if (candidate.constraint === constraint || candidate.constraint_name === constraint)
      return true;
  }
  return false;
}
const PG_OBJECT_IN_USE = '55006';
const PG_RESTRICT_VIOLATION = '23001';
const PG_CHECK_VIOLATION = '23514';

/**
 * Database refusals that the application checks should already have answered (a race, or a direct caller of the schema) become the same typed
 * errors those checks would have produced. Anything else is rethrown untouched.
 */
function translateIntegrityError(error: unknown): unknown {
  if (error instanceof SourceIngestionError) return error;
  if (hasPgViolation(error, PG_RESTRICT_VIOLATION, 'project_not_voided')) {
    return new SourceIngestionError(
      'PROJECT_VOIDED',
      'This project was voided by an organizer; start the work on its replacement',
    );
  }
  if (hasPgViolation(error, PG_OBJECT_IN_USE, 'project_voids_pending_work')) {
    return new SourceIngestionError(
      'PROJECT_HAS_PENDING_WORK',
      'A capture or run of this project is still pending; wait for it to finish, then void the project',
    );
  }
  if (hasPgViolation(error, PG_UNIQUE_VIOLATION, 'project_sources_claimed_by_submission')) {
    return new SourceIngestionError(
      'SUBMISSION_CONFLICT',
      'Another active project of this event already owns this link; void that project first if it is the erroneous one',
    );
  }
  if (hasPgViolation(error, PG_CHECK_VIOLATION, 'project_sources_submission_fixed')) {
    return new SourceIngestionError(
      'SUBMISSION_SOURCE_FIXED',
      'This project belongs to a submission with a different link; void the project and submit the corrected pair',
    );
  }
  if (hasPgViolation(error, PG_CHECK_VIOLATION, 'project_sources_canonical_url')) {
    return new SourceIngestionError('INVALID_SOURCE_URL', 'The URL is not in canonical form');
  }
  if (hasPgViolation(error, PG_UNIQUE_VIOLATION, 'projects_name_claimed')) {
    return new SourceIngestionError(
      'PROJECT_NAME_TAKEN',
      'A submission of this event already uses this name (ignoring letter case)',
    );
  }
  return error;
}

/** A refusal that came from the ownership registry (a link or a label another active project holds). */
function isIdentityClaimRefusal(error: unknown): boolean {
  return (
    error instanceof SourceIngestionError &&
    (error.code === 'SUBMISSION_CONFLICT' || error.code === 'PROJECT_NAME_TAKEN')
  );
}

interface SubmissionIntent {
  readonly eventId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly githubUrl: string;
  readonly devpostUrl: string;
  readonly name: string;
  /**
   * P6D: sorted, unique track keys the project declares; `null` when the request said nothing about tracks (an older client). An empty list is an
   * explicit "no track".
   */
  readonly trackKeys: readonly string[] | null;
  /** P6D: the locked Event Context version the submitter was shown; `null` when not stated. */
  readonly contextVersionId: string | null;
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
  /**
   * Test seam: awaited by a submission after all its read checks and before its first write. Tests hold concurrent submissions here so
   * every contender decides on stale state, which makes the database's constraints (not scheduling luck) decide the race. Production
   * never sets it.
   */
  beforeSubmissionWrite?: () => Promise<void>;
  /**
   * Test seam, the same idea for the earlier project/source routes: awaited by a source declaration or a project creation after its read
   * checks and before its write. Production never sets it.
   */
  beforeLegacyWrite?: () => Promise<void>;
  /**
   * Test seams awaited after a transaction's last write and before it commits, so that two contenders can each hold UNCOMMITTED rows at the same
   * moment (the interleaving a plain read cannot see through). Production never sets them.
   */
  afterSubmissionWrite?: () => Promise<void>;
  afterLegacyWrite?: () => Promise<void>;
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
  private readonly beforeSubmissionWrite: () => Promise<void>;
  private readonly beforeLegacyWrite: () => Promise<void>;
  private readonly afterSubmissionWrite: () => Promise<void>;
  private readonly afterLegacyWrite: () => Promise<void>;

  constructor(options: ProjectServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.beforeSubmissionWrite = options.beforeSubmissionWrite ?? (() => Promise.resolve());
    this.beforeLegacyWrite = options.beforeLegacyWrite ?? (() => Promise.resolve());
    this.afterSubmissionWrite = options.afterSubmissionWrite ?? (() => Promise.resolve());
    this.afterLegacyWrite = options.afterLegacyWrite ?? (() => Promise.resolve());
  }

  // -- Projects ------------------------------------------------------------------------------

  async createProject(
    eventId: string,
    input: CreateProjectRequest,
    actorId: string | null,
  ): Promise<ProjectRecord> {
    const trackKeys = input.trackKeys ?? [];
    try {
      const projectId = await this.retryingTransaction(() =>
        this.db.transaction(async (tx) => {
          const locked = await this.lockedContextOf(tx, eventId);
          const declared = await this.resolveDeclaredTracks(tx, locked.id, trackKeys);
          const now = this.now();
          await this.beforeLegacyWrite();
          const project = await this.insertProject(tx, {
            eventId,
            contextVersionId: locked.id,
            name: input.name.trim(),
            teamName: input.teamName?.trim() ?? null,
            trackCount: declared.length,
            actorId,
            now,
          });
          await this.declareTracks(tx, {
            projectId: project.id,
            eventId,
            contextVersionId: locked.id,
            trackKeys,
            declared,
            actorId,
            now,
          });
          await this.afterLegacyWrite();
          return project.id;
        }),
      );
      return await this.projectRecord(projectId);
    } catch (error) {
      const translated = translateIntegrityError(error);
      if (translated !== error) throw translated;
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
    const ids = rows.map((row) => row.id);
    const tracksByProject = await this.trackSelections(ids);
    const voids = await this.voidInfos(ids);
    return rows.map((row) =>
      toProjectRecord(row, tracksByProject.get(row.id) ?? [], voids.get(row.id) ?? null),
    );
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
      const row = await this.retryingTransaction(() =>
        this.db.transaction(async (tx) => {
          await this.requireProject(tx, projectId, { lock: 'update', active: true });
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
          await this.requireUnclaimedSource(tx, projectId, input.sourceType, normalized.url);
          await this.beforeLegacyWrite();
          const inserted = await this.insertSource(tx, {
            projectId,
            sourceType: input.sourceType,
            url: normalized.url,
            position: stats?.last === null || stats?.last === undefined ? 0 : stats.last + 1,
            actorId,
          });
          await this.afterLegacyWrite();
          return inserted;
        }),
      );
      return toSourceRecord(row, null);
    } catch (error) {
      const translated = translateIntegrityError(error);
      if (translated !== error) throw translated;
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
    return sources.map((source) => {
      const mine = snapshots.filter((snapshot) => snapshot.sourceId === source.id); // newest first
      return toSourceRecord(source, mine[0] ?? null, mine.find(isUsable) ?? null);
    });
  }

  // -- Captures ------------------------------------------------------------------------------

  async requestCapture(
    projectId: string,
    sourceId: string,
    actorId: string | null,
  ): Promise<CaptureRequestedResponse> {
    const { snapshot, runId } = await this.translating(() =>
      this.db.transaction(async (tx) => {
        const project = await this.requireProject(tx, projectId, { lock: 'share', active: true });
        return this.createCapture(tx, project, sourceId, actorId);
      }),
    );
    return { snapshot: toSnapshotSummary(snapshot, { artifactCount: 0, artifactBytes: 0 }), runId };
  }

  /**
   * Organizer-supplied submission text for a DEVPOST source (the fetch path is blocked in this deployment). One transaction: the source is locked
   * (capture numbers are assigned under that lock), a fetch no worker has started is cancelled (it would only fail the same way), and a snapshot is
   * recorded through the same states every capture goes through (pending -> captured), with its artifacts, content hash, run and audit event. The
   * snapshot is labelled `organizer_supplied` and says so in its metadata and in a `submission.json` note. Supplying exactly the text the latest supplied
   * snapshot already holds changes nothing (`unchanged`). A voided project is refused like every other write.
   */
  async supplyContent(
    projectId: string,
    sourceId: string,
    text: string,
    actorId: string,
  ): Promise<SupplyContentResponse> {
    const checked = normalizeSuppliedText(text);
    if (!checked.ok) {
      throw new SourceIngestionError(
        'SUPPLIED_CONTENT_INVALID',
        {
          empty: 'The submission text is empty',
          too_short: 'The submission text is too short to be a submission',
          too_long: 'The submission text is longer than the limit',
          control_characters:
            'The submission text contains control or direction-changing characters',
        }[checked.problem],
        { problem: checked.problem },
      );
    }
    const stored = await this.translating(() =>
      this.retryingTransaction(() =>
        this.db.transaction(async (tx) => {
          const project = await this.requireProject(tx, projectId, { lock: 'share', active: true });
          const [source] = await tx
            .select()
            .from(projectSources)
            .where(and(eq(projectSources.id, sourceId), eq(projectSources.projectId, project.id)))
            .for('update');
          if (!source) {
            throw new SourceIngestionError('SOURCE_NOT_FOUND', 'Source not found for this project');
          }
          if (source.sourceType !== 'devpost') {
            throw new SourceIngestionError(
              'SOURCE_NOT_SUPPLIABLE',
              'Only the Devpost submission text can be supplied by an organizer',
              { sourceType: source.sourceType },
            );
          }
          const result = suppliedDevpostResult(checked.text, source.url);
          if (!isContentResult(result)) throw new Error('supplied result is not a content result');
          const contentHash = snapshotContentHash({
            sourceType: 'devpost',
            sourceUrl: source.url,
            revision: result.revision,
            metadata: result.metadata,
            partialReasons: result.partialReasons,
            artifacts: result.artifacts,
          });

          // the same text again: nothing new to record
          const earlier = await tx
            .select()
            .from(sourceSnapshots)
            .where(
              and(
                eq(sourceSnapshots.projectSourceId, source.id),
                eq(sourceSnapshots.status, 'captured'),
              ),
            )
            .orderBy(desc(sourceSnapshots.captureNumber));
          const latestSupplied = earlier.find(
            (row) => row.metadata?.['provenance'] === 'organizer_supplied',
          );
          if (latestSupplied?.contentHash === contentHash) {
            return { result: 'unchanged' as const, snapshot: latestSupplied, cancelled: false };
          }

          // a fetch nobody started is superseded; one a worker is running is not touched
          let cancelled = false;
          if (await this.pendingSnapshot(tx, source.id)) {
            const [pendingRun] = await tx
              .select({ id: analysisRuns.id, state: analysisRuns.state })
              .from(analysisRuns)
              .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, analysisRuns.sourceSnapshotId))
              .where(
                and(
                  eq(sourceSnapshots.projectSourceId, source.id),
                  eq(sourceSnapshots.status, 'pending'),
                ),
              );
            if (
              !pendingRun ||
              pendingRun.state !== 'pending' ||
              !(await this.cancelPendingCapture(
                tx,
                pendingRun.id,
                this.now(),
                'superseded_by_supplied_content',
              ))
            ) {
              throw new SourceIngestionError(
                'CAPTURE_ALREADY_PENDING',
                'A capture of this source is being run by a worker; supply the text when it has finished',
              );
            }
            cancelled = true;
          }

          const created = await this.createCapture(tx, project, source.id, actorId);
          const completedAt = new Date(
            Math.max(this.now().getTime(), created.snapshot.createdAt.getTime() + 1),
          );
          for (const artifact of result.artifacts) {
            await tx.insert(sourceSnapshotArtifacts).values({
              snapshotId: created.snapshot.id,
              artifactKey: artifact.key,
              artifactKind: artifact.kind,
              mediaType: artifact.mediaType,
              textContent: artifact.textContent,
              metadata: artifact.metadata,
              byteLength: artifact.byteLength,
              contentHash: artifact.contentHash,
              createdAt: completedAt,
            });
          }
          const [snapshot] = await tx
            .update(sourceSnapshots)
            .set({
              status: 'captured',
              revision: null,
              metadata: result.metadata,
              contentHash,
              partialReasons: [],
              capturedAt: completedAt,
              completedAt,
            })
            .where(eq(sourceSnapshots.id, created.snapshot.id))
            .returning();
          if (!snapshot) throw new Error('snapshot update returned nothing');
          await tx
            .update(analysisRuns)
            .set({
              state: 'succeeded',
              startedAt: completedAt,
              finishedAt: completedAt,
              attemptCount: 0,
            })
            .where(eq(analysisRuns.id, created.runId));
          await this.audit(tx, actorId, {
            entityType: 'source_snapshot',
            entityId: snapshot.id,
            action: SOURCE_INGESTION_AUDIT_ACTIONS.contentSupplied,
            // never the text: only that it was supplied, by whom (the actor), how much and what it replaced
            metadata: {
              projectId: project.id,
              sourceId: source.id,
              captureNumber: snapshot.captureNumber,
              contentHash,
              textCodePoints: codePointLength(checked.text),
              cancelledPendingFetch: cancelled,
            },
          });
          return { result: 'stored' as const, snapshot, cancelled };
        }),
      ),
    );
    return {
      result: stored.result,
      snapshot: toSnapshotSummary(stored.snapshot, await this.artifactTotals(stored.snapshot.id)),
      cancelledPendingFetch: stored.cancelled,
    };
  }

  private async artifactTotals(
    snapshotId: string,
  ): Promise<{ artifactCount: number; artifactBytes: number }> {
    const [row] = await this.db
      .select({ artifactCount: count(), artifactBytes: sum(sourceSnapshotArtifacts.byteLength) })
      .from(sourceSnapshotArtifacts)
      .where(eq(sourceSnapshotArtifacts.snapshotId, snapshotId));
    return {
      artifactCount: row?.artifactCount ?? 0,
      artifactBytes: Number(row?.artifactBytes ?? 0),
    };
  }

  async requestAllCaptures(projectId: string, actorId: string | null): Promise<CaptureAllResponse> {
    return this.translating(() =>
      this.db.transaction(async (tx) => {
        const project = await this.requireProject(tx, projectId, { lock: 'share', active: true });
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
      }),
    );
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
    const intent = this.submissionIntent(eventId, input, actorId, idempotencyKey);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.db.transaction((tx) => this.submitOnce(tx, intent));
        return {
          result: outcome.result,
          project: await this.getProject(outcome.projectId),
          captureRuns: outcome.captureRuns,
        };
      } catch (error) {
        const translated = translateIntegrityError(error);
        if (translated !== error) {
          // An identity the database refused because ANOTHER transaction owns it may be a lost race: run again, and the application checks (which
          // read committed state) then give the precise answer -- the same one a request made a moment later would get. Only the last attempt
          // reports the database's own translation.
          if (isIdentityClaimRefusal(translated) && attempt < SUBMISSION_ATTEMPTS) continue;
          throw translated;
        }
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

  /** Validates and canonicalizes a submission request. The result is the only identity the rest of the flow uses. */
  private submissionIntent(
    eventId: string,
    input: SubmitProjectRequest,
    actorId: string,
    idempotencyKey: string,
  ): SubmissionIntent {
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
    const trackKeys = input.trackKeys === undefined ? null : [...new Set(input.trackKeys)].sort();
    const contextVersionId = input.contextVersionId?.toLowerCase() ?? null;
    return {
      eventId,
      actorId,
      idempotencyKey: idempotencyKey.toLowerCase(),
      githubUrl: github.canonicalUrl,
      devpostUrl: devpost.canonicalUrl,
      name: typedName ?? `${github.owner}/${github.repo}`,
      trackKeys,
      contextVersionId,
      requestHash: createHash('sha256')
        .update(
          JSON.stringify([
            'judge.submission.v1',
            eventId,
            github.canonicalUrl,
            devpost.canonicalUrl,
            typedName,
            // P6D: tracks and the context token are part of the request's identity only when stated, so every submission made before they
            // existed (and every replay of one) keeps its hash
            ...(trackKeys !== null && trackKeys.length > 0 ? [['tracks', ...trackKeys]] : []),
            ...(contextVersionId === null ? [] : [['context', contextVersionId]]),
          ]),
        )
        .digest('hex'),
    };
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
      .select({ id: projectSubmissions.id, projectId: projectSubmissions.projectId })
      .from(projectSubmissions)
      .leftJoin(projectVoids, eq(projectVoids.projectId, projectSubmissions.projectId))
      .where(
        and(
          eq(projectSubmissions.eventId, intent.eventId),
          eq(projectSubmissions.githubUrl, intent.githubUrl),
          eq(projectSubmissions.devpostUrl, intent.devpostUrl),
          isNull(projectVoids.id),
        ),
      );
    if (same) {
      // P6D: converging on an existing project must never silently drop a different track choice: declarations are history, not editable
      if (intent.trackKeys !== null) {
        const existing = (
          await tx
            .select({ key: projectTrackSelections.trackKey })
            .from(projectTrackSelections)
            .where(eq(projectTrackSelections.projectId, same.projectId))
        )
          .map((row) => row.key)
          .sort();
        if (existing.join('\n') !== intent.trackKeys.join('\n')) {
          throw new SourceIngestionError(
            'SUBMISSION_CONFLICT',
            'This project was already submitted with different tracks. A submission’s tracks cannot be changed by submitting it again: nothing was saved. Open the existing project, or ask an organizer to void it and submit the corrected tracks.',
            { projectIds: [same.projectId], reason: 'tracks_differ', declaredTrackKeys: existing },
          );
        }
      }
      await this.beforeSubmissionWrite();
      await this.insertSubmissionRequest(tx, intent, same.id, same.projectId, 'already_submitted');
      await this.audit(tx, intent.actorId, {
        entityType: 'project',
        entityId: same.projectId,
        action: SOURCE_INGESTION_AUDIT_ACTIONS.submissionConverged,
        metadata: { eventId: intent.eventId, submissionId: same.id },
      });
      return { result: 'already_submitted', projectId: same.projectId, captureRuns: [] };
    }

    // 2b. P6D: a stale form. The tracks were chosen against the Event Context the form showed; if another version has been locked since, the
    //     choice is refused rather than applied to a context its author never saw (replays and convergence above are unaffected)
    if (intent.contextVersionId !== null && intent.contextVersionId !== locked.id) {
      throw new SourceIngestionError(
        'CONTEXT_VERSION_CHANGED',
        'The hackathon’s locked Event Context changed after this form was opened. Reload the page, check the tracks again and submit again. Nothing was saved.',
        { lockedContextVersionId: locked.id },
      );
    }
    // 2c. every selected track must exist in the locked version (the same rule as creating a project directly)
    const declaredTracks = await this.resolveDeclaredTracks(tx, locked.id, intent.trackKeys ?? []);

    // 3. a partial overlap is a DIFFERENT intent: never merged, never silently adopted
    // the ownership registry holds exactly the links of the ACTIVE submissions (a void releases them)
    const overlapping = await tx
      .select({ projectId: projectSubmissionClaims.projectId })
      .from(projectSubmissionClaims)
      .where(
        and(
          eq(projectSubmissionClaims.eventId, intent.eventId),
          or(
            and(
              eq(projectSubmissionClaims.kind, 'github'),
              eq(projectSubmissionClaims.value, intent.githubUrl),
            ),
            and(
              eq(projectSubmissionClaims.kind, 'devpost'),
              eq(projectSubmissionClaims.value, intent.devpostUrl),
            ),
          ),
        ),
      );
    const legacy = await tx
      .select({ projectId: projectSources.projectId })
      .from(projectSources)
      .innerJoin(projects, eq(projects.id, projectSources.projectId))
      .leftJoin(projectVoids, eq(projectVoids.projectId, projects.id))
      .where(
        and(
          eq(projects.eventId, intent.eventId),
          isNull(projectVoids.id),
          or(
            and(eq(projectSources.sourceType, 'github'), eq(projectSources.url, intent.githubUrl)),
            and(
              eq(projectSources.sourceType, 'devpost'),
              eq(projectSources.url, intent.devpostUrl),
            ),
          ),
        ),
      );
    // an earlier-flow project that itself holds several GitHub (or Devpost) links is not a valid single submission: it must not block the
    // correct submissions of its links (integrity detection lists it; nothing is rewritten)
    const legacyIds = [...new Set(legacy.map((row) => row.projectId))];
    const mixed = new Set(await this.mixedProjectIds(tx, legacyIds));
    const conflicting = [
      ...new Set(
        [...overlapping, ...legacy.filter((row) => !mixed.has(row.projectId))].map(
          (row) => row.projectId,
        ),
      ),
    ];
    if (conflicting.length > 0) {
      throw new SourceIngestionError(
        'SUBMISSION_CONFLICT',
        'Another project in this event already uses this GitHub repository or Devpost page',
        { projectIds: conflicting },
      );
    }

    // 4. a name that differs only by case is the same label (compared by the database's own case folding, the one its name key uses)
    const [named] = await tx
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(projectVoids, eq(projectVoids.projectId, projects.id))
      .where(
        and(
          eq(projects.eventId, intent.eventId),
          isNull(projectVoids.id),
          sql`lower(btrim(${projects.name})) = lower(btrim(${intent.name}))`,
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
    await this.beforeSubmissionWrite();
    const now = this.now();
    const project = await this.insertProject(tx, {
      eventId: intent.eventId,
      contextVersionId: locked.id,
      name: intent.name,
      teamName: null,
      trackCount: declaredTracks.length,
      actorId: intent.actorId,
      now,
    });
    await this.declareTracks(tx, {
      projectId: project.id,
      eventId: intent.eventId,
      contextVersionId: locked.id,
      trackKeys: intent.trackKeys ?? [],
      declared: declaredTracks,
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
        // the database derives the stored key from the project's name (trigger); this value only satisfies the NOT NULL column
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
    await this.afterSubmissionWrite();
    return { result: 'created', projectId: project.id, captureRuns };
  }

  // -- Correction: void and replace (P6B-beta2) --------------------------------------------------

  /**
   * An authorized organizer declares a project erroneous (wrong GitHub or Devpost link, wrong submission) and, optionally in the same operation,
   * submits the corrected pair. NOTHING about the erroneous project is deleted or rewritten: its sources, snapshots, extractions, assessments
   * and reports stay exactly as they were (a historical report stays reproducible), and its label alone is marked. What changes is that it can
   * no longer start work, and the links and label it owned are released, so the corrected submission may take them. The whole operation is one
   * transaction: either the project is voided (and the replacement exists), or nothing happened.
   *
   *   same actor + same Idempotency-Key + same content   -> `replayed` (nothing is written again)
   *   same key, other content                            -> IDEMPOTENCY_KEY_REUSED
   *   already voided (any other request)                 -> PROJECT_ALREADY_VOIDED
   *   a capture or run still pending                     -> PROJECT_HAS_PENDING_WORK (retry when it has finished)
   *   a replacement that is not a NEW submission         -> SUBMISSION_CONFLICT (the whole correction is refused)
   *
   * Locks: the Event Context (share, only with a replacement), then the project row FOR UPDATE -- the order every other writer uses.
   */
  async voidProject(
    projectId: string,
    input: VoidProjectRequest,
    actorId: string,
    idempotencyKey: string,
  ): Promise<VoidProjectResponse> {
    const [head] = await this.db
      .select({ eventId: projects.eventId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!head) throw new SourceIngestionError('PROJECT_NOT_FOUND', 'Project not found');
    const key = idempotencyKey.toLowerCase();
    const reason = input.reason.trim();
    const replacement = input.replacement
      ? this.submissionIntent(head.eventId, input.replacement, actorId, key)
      : null;
    const cancelPending = input.cancelPendingWork === true;
    // the flag is part of the request's identity only when set, so every correction made before it existed keeps its hash
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          'judge.void.v1',
          projectId,
          reason,
          replacement?.requestHash ?? null,
          ...(cancelPending ? ['cancel_pending_work'] : []),
        ]),
      )
      .digest('hex');
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.db.transaction((tx) =>
          this.voidOnce(
            tx,
            { projectId, eventId: head.eventId, actorId, key, reason, requestHash, cancelPending },
            replacement,
          ),
        );
        return {
          result: outcome.result,
          cancelledPending: outcome.cancelled,
          project: await this.getProject(projectId),
          replacement:
            outcome.replacementProjectId === null
              ? null
              : {
                  result: outcome.result === 'replayed' ? 'replayed' : 'created',
                  project: await this.getProject(outcome.replacementProjectId),
                  captureRuns: outcome.captureRuns,
                },
        };
      } catch (error) {
        const translated = translateIntegrityError(error);
        if (translated !== error) {
          // An identity the database refused because ANOTHER transaction owns it may be a lost race: run again, and the application checks (which
          // read committed state) then give the precise answer -- the same one a request made a moment later would get. Only the last attempt
          // reports the database's own translation.
          if (isIdentityClaimRefusal(translated) && attempt < SUBMISSION_ATTEMPTS) continue;
          throw translated;
        }
        const lostRace =
          hasPgCode(error, PG_UNIQUE_VIOLATION) ||
          hasPgCode(error, PG_DEADLOCK) ||
          hasPgCode(error, PG_SERIALIZATION_FAILURE);
        if (!lostRace) throw error;
        if (attempt >= SUBMISSION_ATTEMPTS) {
          throw new SourceIngestionError(
            'SUBMISSION_CONFLICT',
            'This correction conflicts with another change that is being recorded right now. Try again.',
          );
        }
      }
    }
  }

  private async voidOnce(
    tx: JudgeDatabase,
    request: {
      projectId: string;
      eventId: string;
      actorId: string;
      key: string;
      reason: string;
      requestHash: string;
      cancelPending: boolean;
    },
    replacement: SubmissionIntent | null,
  ): Promise<{
    result: 'voided' | 'replayed';
    cancelled: { captures: number; assessments: number };
    replacementProjectId: string | null;
    captureRuns: SubmitProjectResponse['captureRuns'];
  }> {
    if (replacement) await this.lockedContextOf(tx, request.eventId);
    const project = await this.requireProject(tx, request.projectId, { lock: 'update' });

    // 1. the same key: a retry (same content) or a reuse (different content)
    const [earlier] = await tx
      .select()
      .from(projectVoids)
      .where(
        and(
          eq(projectVoids.voidedByActorId, request.actorId),
          eq(projectVoids.idempotencyKey, request.key),
        ),
      );
    if (earlier) {
      if (earlier.requestHash !== request.requestHash) {
        throw new SourceIngestionError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different correction',
          { projectId: earlier.projectId },
        );
      }
      const [link] = await tx
        .select({ replacementProjectId: projectReplacements.replacementProjectId })
        .from(projectReplacements)
        .where(eq(projectReplacements.voidedProjectId, earlier.projectId));
      return {
        result: 'replayed',
        cancelled: { captures: 0, assessments: 0 },
        replacementProjectId: link?.replacementProjectId ?? null,
        captureRuns: [],
      };
    }

    // 2. one void per project
    const [already] = await tx
      .select({ id: projectVoids.id })
      .from(projectVoids)
      .where(eq(projectVoids.projectId, project.id));
    if (already) {
      throw new SourceIngestionError('PROJECT_ALREADY_VOIDED', 'This project was already voided', {
        projectId: project.id,
      });
    }

    // 3. never while work on the project is in flight: a worker may be writing its snapshot right now (the database refuses it too).
    //    Work that NO worker has started (pending) can be cancelled with the void when the organizer asks (`cancelPendingWork`): the
    //    recovery for a deployment without a running worker, where such requests would otherwise block every correction forever.
    const active = await tx
      .select({ id: analysisRuns.id, runType: analysisRuns.runType, state: analysisRuns.state })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.projectId, project.id),
          inArray(analysisRuns.state, ['pending', 'running']),
        ),
      );
    const [pendingCapture] = await tx
      .select({ id: sourceSnapshots.id })
      .from(sourceSnapshots)
      .where(and(eq(sourceSnapshots.projectId, project.id), eq(sourceSnapshots.status, 'pending')))
      .limit(1);
    const cancelled = { captures: 0, assessments: 0 };
    if (active.some((run) => run.state === 'running')) {
      throw new SourceIngestionError(
        'PROJECT_HAS_PENDING_WORK',
        'A worker is running a capture or assessment of this project; wait for it to finish (or for its lease to expire), then void the project',
        { projectId: project.id },
      );
    }
    if (active.length > 0 || pendingCapture) {
      if (!request.cancelPending) {
        throw new SourceIngestionError(
          'PROJECT_HAS_PENDING_WORK',
          'A capture or run of this project is still pending; wait for it to finish, or void it with cancelPendingWork to cancel the requests no worker has started',
          { projectId: project.id, pending: active.length },
        );
      }
      const stamp = this.now();
      const runs = new AssessmentRunStore({ db: this.db, now: () => stamp });
      for (const run of active) {
        if (run.runType === 'project_source_capture') {
          if (await this.cancelPendingCapture(tx, run.id, stamp)) cancelled.captures += 1;
        } else if (await runs.cancelPendingWithin(tx, run.id, 'cancelled_by_void')) {
          cancelled.assessments += 1;
        }
      }
      // whatever the cancellation could not end (a worker took it a moment ago) still blocks the void
      const [stillRunning] = await tx
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.projectId, project.id),
            inArray(analysisRuns.state, ['pending', 'running']),
          ),
        )
        .limit(1);
      if (stillRunning) {
        throw new SourceIngestionError(
          'PROJECT_HAS_PENDING_WORK',
          'A worker started a request of this project while it was being cancelled; try again',
          { projectId: project.id },
        );
      }
    }

    await this.beforeSubmissionWrite();
    const now = this.now();
    await tx.insert(projectVoids).values({
      id: this.newId(),
      eventId: project.eventId,
      projectId: project.id,
      voidedByActorId: request.actorId,
      reason: request.reason,
      nameBefore: project.name,
      idempotencyKey: request.key,
      requestHash: request.requestHash,
      createdAt: now,
    });
    await this.audit(tx, request.actorId, {
      entityType: 'project',
      entityId: project.id,
      action: SOURCE_INGESTION_AUDIT_ACTIONS.projectVoided,
      // the reason is organizer free text: it is stored in project_voids, never copied into the audit metadata
      metadata: {
        eventId: project.eventId,
        withReplacement: replacement !== null,
        cancelledCaptures: cancelled.captures,
        cancelledAssessments: cancelled.assessments,
      },
    });
    if (!replacement) {
      return { result: 'voided', cancelled, replacementProjectId: null, captureRuns: [] };
    }

    // 4. the corrected submission, in the same transaction; it must be a NEW project (the erroneous one released its links just above)
    const created = await this.submitOnce(tx, replacement);
    if (created.result !== 'created') {
      throw new SourceIngestionError(
        'SUBMISSION_CONFLICT',
        'The corrected pair is already submitted as another project of this event; void without a replacement and use that project',
        { projectId: created.projectId },
      );
    }
    await tx.insert(projectReplacements).values({
      id: this.newId(),
      eventId: project.eventId,
      voidedProjectId: project.id,
      replacementProjectId: created.projectId,
      createdAt: now,
    });
    await this.audit(tx, request.actorId, {
      entityType: 'project',
      entityId: created.projectId,
      action: SOURCE_INGESTION_AUDIT_ACTIONS.projectReplaced,
      metadata: { eventId: project.eventId, voidedProjectId: project.id },
    });
    return {
      result: 'voided',
      cancelled,
      replacementProjectId: created.projectId,
      captureRuns: created.captureRuns,
    };
  }

  /**
   * Ends ONE capture request that no worker has started: its pending snapshot becomes `failed` (reason `cancelled_by_void`; nothing was read from
   * the source) and its run `cancelled`. Re-checks under the row locks, in the worker's own lock order (run, then snapshot), that both are still
   * pending; a worker that claimed the run first wins and this returns false.
   */
  private async cancelPendingCapture(
    tx: JudgeDatabase,
    runId: string,
    at: Date,
    reason: 'cancelled_by_void' | 'superseded_by_supplied_content' = 'cancelled_by_void',
  ): Promise<boolean> {
    const [run] = await tx
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.id, runId))
      .for('update');
    if (
      !run ||
      run.state !== 'pending' ||
      run.runType !== 'project_source_capture' ||
      !run.sourceSnapshotId
    ) {
      return false;
    }
    const [snapshot] = await tx
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.id, run.sourceSnapshotId))
      .for('update');
    if (!snapshot || snapshot.status !== 'pending') return false;
    const finished = new Date(
      Math.max(at.getTime(), snapshot.createdAt.getTime(), run.createdAt.getTime()),
    );
    await tx
      .update(sourceSnapshots)
      .set({
        status: 'failed',
        failureCategory: 'internal_error',
        failureMetadata: { reason },
        completedAt: finished,
      })
      .where(eq(sourceSnapshots.id, snapshot.id));
    await tx
      .update(analysisRuns)
      .set({ state: 'cancelled', failureCategory: null, startedAt: finished, finishedAt: finished })
      .where(eq(analysisRuns.id, run.id));
    return true;
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
      .select({ id: projects.id, voidId: projectVoids.id })
      .from(projects)
      .leftJoin(projectVoids, eq(projectVoids.projectId, projects.id))
      .where(eq(projects.eventId, eventId));
    const activeIds = new Set(
      projectRows.filter((row) => row.voidId === null).map((row) => row.id),
    );
    const sources = await this.db
      .select({
        projectId: projectSources.projectId,
        sourceType: projectSources.sourceType,
        url: projectSources.url,
      })
      .from(projectSources)
      .innerJoin(projects, eq(projects.id, projectSources.projectId))
      .leftJoin(projectVoids, eq(projectVoids.projectId, projects.id))
      .where(
        and(
          eq(projects.eventId, eventId),
          isNull(projectVoids.id),
          inArray(projectSources.sourceType, ['github', 'devpost']),
        ),
      )
      .orderBy(asc(projectSources.projectId), asc(projectSources.position));
    const recorded = await this.db
      .select({ projectId: projectSubmissions.projectId })
      .from(projectSubmissions)
      .where(eq(projectSubmissions.eventId, eventId));
    const recordedActive = recorded.filter((row) => activeIds.has(row.projectId));
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
      projectsChecked: activeIds.size,
      projectsVoided: projectRows.length - activeIds.size,
      projectsWithoutSubmissionRecord: activeIds.size - recordedActive.length,
      findings,
      registryProblems: await this.registryProblems(eventId),
    };
  }

  /**
   * Does the ownership registry still agree with the declarations it summarizes? Computed from the base tables (projects, sources, submissions),
   * never from the registry alone, so a registry that lost rows cannot vouch for itself. Ownership is compared per project: a claim is valid only
   * when its OWNER holds the identity it claims. A link declared by a project that is not the claim's owner is a conflict (`shared_identity`) when
   * the owner also holds it, and a missing claim when the owner does not. Voided projects hold nothing and own nothing.
   */
  private async registryProblems(eventId: string): Promise<RegistryProblem[]> {
    const result = await this.db.execute(sql`
      WITH active AS (
        SELECT p.id, p.name FROM projects p
         WHERE p.event_id = ${eventId} AND NOT EXISTS (SELECT 1 FROM project_voids v WHERE v.project_id = p.id)
      ), declared AS (
        -- every identity an active project holds. "expected" is false only for the links of a project that holds several links of one type and
        -- is not a recorded submission's link: those predate the registry, are not backfilled, and are the documented ambiguous case.
        SELECT project_id, kind, value, bool_or(expected) AS expected FROM (
          SELECT a.id AS project_id, 'name'::text AS kind, lower(btrim(a.name)) AS value, true AS expected FROM active a
          UNION ALL SELECT s.project_id, s.source_type, s.url,
                 (SELECT count(*) FROM project_sources s2 WHERE s2.project_id = s.project_id AND s2.source_type = s.source_type) <= 1
            FROM project_sources s JOIN active a ON a.id = s.project_id WHERE s.source_type IN ('github', 'devpost')
          UNION ALL SELECT ps.project_id, 'github', ps.github_url, true FROM project_submissions ps JOIN active a ON a.id = ps.project_id
          UNION ALL SELECT ps.project_id, 'devpost', ps.devpost_url, true FROM project_submissions ps JOIN active a ON a.id = ps.project_id
        ) all_holdings GROUP BY project_id, kind, value
      ), claims AS (
        SELECT c.project_id, c.kind, c.value,
               EXISTS (SELECT 1 FROM project_voids v WHERE v.project_id = c.project_id) AS voided
          FROM project_submission_claims c WHERE c.event_id = ${eventId}
      )
      SELECT 'missing_claim' AS problem, d.kind, d.value,
             array_agg(DISTINCT d.project_id::text) FILTER (WHERE d.expected) AS project_ids, NULL::text AS owner
        FROM declared d
       GROUP BY d.kind, d.value
      HAVING bool_or(d.expected)
         AND NOT EXISTS (SELECT 1 FROM claims c JOIN declared d2 ON d2.project_id = c.project_id AND d2.kind = c.kind AND d2.value = c.value
                          WHERE c.kind = d.kind AND c.value = d.value)
      UNION ALL
      SELECT 'shared_identity', d.kind, d.value, array_agg(DISTINCT d.project_id::text),
             (SELECT c.project_id::text FROM claims c WHERE c.kind = d.kind AND c.value = d.value
                 AND EXISTS (SELECT 1 FROM declared d3 WHERE d3.project_id = c.project_id AND d3.kind = c.kind AND d3.value = c.value))
        FROM declared d
       GROUP BY d.kind, d.value
      HAVING count(DISTINCT d.project_id) > 1
      UNION ALL
      SELECT 'stale_claim', c.kind, c.value, ARRAY[c.project_id::text], NULL::text
        FROM claims c
       WHERE NOT c.voided
         AND NOT EXISTS (SELECT 1 FROM declared d WHERE d.project_id = c.project_id AND d.kind = c.kind AND d.value = c.value)
      UNION ALL
      SELECT 'claim_owned_by_voided_project', c.kind, c.value, ARRAY[c.project_id::text], NULL::text
        FROM claims c WHERE c.voided
      ORDER BY 1, 2, 3`);
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as {
      problem: RegistryProblem['kind'];
      kind: RegistryProblem['claimKind'];
      value: string;
      project_ids: string[];
      owner: string | null;
    }[];
    return rows.map((row) => ({
      kind: row.problem,
      claimKind: row.kind,
      value: row.value,
      projectIds: [...row.project_ids].sort(),
      ...(row.owner === null ? {} : { ownerProjectId: row.owner }),
    }));
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

  /** Of these projects, the ones that declare more than one GitHub link or more than one Devpost link. */
  private async mixedProjectIds(tx: JudgeDatabase, projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await tx
      .select({ projectId: projectSources.projectId, sourceType: projectSources.sourceType })
      .from(projectSources)
      .where(
        and(
          inArray(projectSources.projectId, projectIds),
          inArray(projectSources.sourceType, ['github', 'devpost']),
        ),
      );
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.projectId}\u0000${row.sourceType}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return projectIds.filter(
      (id) =>
        (counts.get(`${id}\u0000github`) ?? 0) > 1 || (counts.get(`${id}\u0000devpost`) ?? 0) > 1,
    );
  }

  /**
   * The declared tracks of the LOCKED Event Context version named by `trackKeys`. Every key must exist in that version (the same rule for
   * `createProject` and for a submission): a key that is not there is UNKNOWN_TRACK and nothing is written.
   */
  private async resolveDeclaredTracks(
    tx: JudgeDatabase,
    contextVersionId: string,
    trackKeys: readonly string[],
  ): Promise<{ id: string; key: string }[]> {
    const declared =
      trackKeys.length === 0
        ? []
        : await tx
            .select({ id: tracks.id, key: tracks.key })
            .from(tracks)
            .where(
              and(
                eq(tracks.contextVersionId, contextVersionId),
                inArray(tracks.key, [...trackKeys]),
              ),
            );
    const known = new Set(declared.map((track) => track.key));
    const unknown = trackKeys.filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new SourceIngestionError(
        'UNKNOWN_TRACK',
        'Every declared track must exist in the locked Event Context',
        { unknownTrackKeys: unknown },
      );
    }
    return declared;
  }

  /** Writes the track declarations of a NEW project (one row and one audit event each), in the order the keys were given. */
  private async declareTracks(
    tx: JudgeDatabase,
    input: {
      projectId: string;
      eventId: string;
      contextVersionId: string;
      trackKeys: readonly string[];
      declared: readonly { id: string; key: string }[];
      actorId: string | null;
      now: Date;
    },
  ): Promise<void> {
    for (const key of input.trackKeys) {
      const track = input.declared.find((candidate) => candidate.key === key);
      if (!track) continue;
      await tx.insert(projectTrackSelections).values({
        id: this.newId(),
        projectId: input.projectId,
        eventId: input.eventId,
        contextVersionId: input.contextVersionId,
        trackId: track.id,
        trackKey: track.key,
        declaredByActorId: input.actorId,
        declaredAt: input.now,
      });
      await this.audit(tx, input.actorId, {
        entityType: 'project',
        entityId: input.projectId,
        action: SOURCE_INGESTION_AUDIT_ACTIONS.trackDeclared,
        metadata: {
          trackKey: track.key,
          trackId: track.id,
          contextVersionId: input.contextVersionId,
        },
      });
    }
  }

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
    const voids = await this.voidInfos([project.id]);
    return toProjectRecord(
      project,
      tracksByProject.get(project.id) ?? [],
      voids.get(project.id) ?? null,
    );
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

  /**
   * `lock: 'share'` is taken by everything that starts work on a project (a capture request); `'update'` by what must serialize against other
   * writers of the same project (a source declaration, a void). The two conflict, so a void and new work on the same project are never
   * interleaved. `active: true` refuses a voided project -- decided AFTER the lock, so a void that committed first is always seen.
   */
  private async requireProject(
    db: JudgeDatabase,
    projectId: string,
    options: { lock?: 'share' | 'update'; active?: boolean } = {},
  ): Promise<ProjectRow> {
    const query = db.select().from(projects).where(eq(projects.id, projectId));
    const [project] =
      options.lock === 'update'
        ? await query.for('update')
        : options.lock === 'share'
          ? await query.for('share')
          : await query;
    if (!project) throw new SourceIngestionError('PROJECT_NOT_FOUND', 'Project not found');
    if (options.active) {
      const [voided] = await db
        .select({ id: projectVoids.id })
        .from(projectVoids)
        .where(eq(projectVoids.projectId, projectId));
      if (voided) {
        throw new SourceIngestionError(
          'PROJECT_VOIDED',
          'This project was voided by an organizer; start the work on its replacement',
          { projectId },
        );
      }
    }
    return project;
  }

  /**
   * Runs one whole transaction again when PostgreSQL chose it as the victim of a deadlock or a serialization failure. A transaction that was
   * rolled back wrote nothing, so running it again is safe; the checks inside it then see whatever the other transaction committed.
   */
  private async retryingTransaction<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        const transient =
          hasPgCode(error, PG_DEADLOCK) || hasPgCode(error, PG_SERIALIZATION_FAILURE);
        if (!transient || attempt >= SUBMISSION_ATTEMPTS) throw error;
      }
    }
  }

  private async translating<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw translateIntegrityError(error);
    }
  }

  /** Void records (and the replacement, when there is one) of these projects. */
  private async voidInfos(projectIds: string[]): Promise<Map<string, ProjectVoidInfo>> {
    const result = new Map<string, ProjectVoidInfo>();
    if (projectIds.length === 0) return result;
    const rows = await this.db
      .select({
        projectId: projectVoids.projectId,
        voidedAt: projectVoids.createdAt,
        actorId: projectVoids.voidedByActorId,
        reason: projectVoids.reason,
        nameBefore: projectVoids.nameBefore,
        replacementId: projectReplacements.replacementProjectId,
      })
      .from(projectVoids)
      .leftJoin(
        projectReplacements,
        eq(projectReplacements.voidedProjectId, projectVoids.projectId),
      )
      .where(inArray(projectVoids.projectId, projectIds));
    for (const row of rows) {
      result.set(row.projectId, {
        voidedAt: row.voidedAt.toISOString(),
        voidedByActorId: row.actorId,
        reason: row.reason,
        nameBefore: row.nameBefore,
        replacedByProjectId: row.replacementId,
      });
    }
    return result;
  }

  /** A GitHub or Devpost link that another active submission of the event owns cannot be declared by a project that is not that submission. */
  private async requireUnclaimedSource(
    tx: JudgeDatabase,
    projectId: string,
    sourceType: AddProjectSourceRequest['sourceType'],
    url: string,
  ): Promise<void> {
    if (sourceType !== 'github' && sourceType !== 'devpost') return;
    const project = await this.requireProject(tx, projectId);
    const owners = await tx
      .select({ projectId: projectSubmissionClaims.projectId })
      .from(projectSubmissionClaims)
      .where(
        and(
          eq(projectSubmissionClaims.eventId, project.eventId),
          eq(projectSubmissionClaims.kind, sourceType),
          eq(projectSubmissionClaims.value, url),
        ),
      );
    const others = owners.filter((owner) => owner.projectId !== projectId);
    if (others.length > 0) {
      throw new SourceIngestionError(
        'SUBMISSION_CONFLICT',
        `Another active project of this event already owns this ${sourceType} link; void that project first if it is the erroneous one`,
        { sourceType, projectIds: others.map((owner) => owner.projectId) },
      );
    }
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
