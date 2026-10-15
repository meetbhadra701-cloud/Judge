import { z } from 'zod';
import { AnalysisRunFailureCategory, AnalysisRunState, SourceSnapshotStatus } from './enums.js';
import { Identifier, Uuid } from './primitives.js';
import {
  ActorRole,
  CaptureFailureCategory,
  CaptureFailureMetadata,
  CapturePartialReason,
  ProjectSourceType,
  SnapshotArtifactKind,
  SOURCE_INGESTION_LIMITS,
} from './source-ingestion.js';

/*
 * HTTP contract for M2 projects, declared sources and immutable source snapshots (apps/api) and
 * its client (apps/web). Timestamps are ISO-8601 strings on the wire.
 */

const IsoDateTime = z.iso.datetime({ offset: true });
const JsonObject = z.record(z.string(), z.json());

/**
 * Free text that is a LABEL (a name, a reason): no control characters, no line or paragraph separators. PostgreSQL text cannot store NUL at all
 * (it would otherwise surface as an unexpected 500), and a label with a line break can impersonate a second line of any page that shows it.
 */
export const NO_CONTROL_CHARACTERS = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u;
export const LabelText = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL_CHARACTERS, {
    message: 'must not contain control characters or line breaks',
  });

export const CreateProjectRequest = z.strictObject({
  name: LabelText(SOURCE_INGESTION_LIMITS.projectNameMaxChars),
  teamName: LabelText(SOURCE_INGESTION_LIMITS.teamNameMaxChars).nullable().optional(),
  /** Track keys of the event's currently locked Event Context. Validated, never invented. */
  trackKeys: z
    .array(Identifier)
    .max(SOURCE_INGESTION_LIMITS.tracksPerProject)
    .refine((keys) => new Set(keys).size === keys.length, 'Track keys must be unique')
    .default([]),
});
export type CreateProjectRequest = z.input<typeof CreateProjectRequest>;

export const ProjectTrackSelectionRecord = z.object({
  id: Uuid,
  trackId: Uuid,
  trackKey: z.string(),
  trackName: z.string(),
  /** The locked Event Context version the declaration was validated against. */
  contextVersionId: Uuid,
  contextVersion: z.number().int(),
  declaredAt: IsoDateTime,
});
export type ProjectTrackSelectionRecord = z.infer<typeof ProjectTrackSelectionRecord>;

/** Set when an authorized organizer voided the project (P6B-beta2). A voided project is history: it starts no new work. */
export const ProjectVoidInfo = z.object({
  voidedAt: IsoDateTime,
  voidedByActorId: Uuid,
  reason: z.string(),
  /** The label the project had before it was marked as void. */
  nameBefore: z.string(),
  /** The project that replaced it, when the correction was made with a replacement. */
  replacedByProjectId: Uuid.nullable(),
});
export type ProjectVoidInfo = z.infer<typeof ProjectVoidInfo>;

export const ProjectRecord = z.object({
  id: Uuid,
  eventId: Uuid,
  name: z.string(),
  teamName: z.string().nullable(),
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  tracks: z.array(ProjectTrackSelectionRecord),
  voided: ProjectVoidInfo.nullable(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const AddProjectSourceRequest = z.strictObject({
  sourceType: ProjectSourceType,
  url: z.string().trim().min(1).max(SOURCE_INGESTION_LIMITS.urlMaxChars),
});
export type AddProjectSourceRequest = z.infer<typeof AddProjectSourceRequest>;

export const SnapshotSummary = z.object({
  id: Uuid,
  projectId: Uuid,
  sourceId: Uuid,
  captureNumber: z.number().int().min(1),
  sourceType: ProjectSourceType,
  sourceUrl: z.string(),
  status: SourceSnapshotStatus,
  /** Exact commit SHA for GitHub snapshots; null otherwise. */
  revision: z.string().nullable(),
  contentHash: z.string().nullable(),
  partialReasons: z.array(CapturePartialReason),
  failureCategory: CaptureFailureCategory.nullable(),
  requestedAt: IsoDateTime,
  capturedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  artifactCount: z.number().int().min(0),
  artifactBytes: z.number().int().min(0),
});
export type SnapshotSummary = z.infer<typeof SnapshotSummary>;

export const ProjectSourceRecord = z.object({
  id: Uuid,
  projectId: Uuid,
  sourceType: ProjectSourceType,
  /** Normalized declared URL. Immutable: a replacement URL is a new declaration. */
  url: z.string(),
  position: z.number().int().min(0),
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
  latestSnapshot: SnapshotSummary.nullable(),
});
export type ProjectSourceRecord = z.infer<typeof ProjectSourceRecord>;

export const ProjectDetail = ProjectRecord.extend({
  sources: z.array(ProjectSourceRecord),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const ArtifactSummary = z.object({
  id: Uuid,
  key: z.string(),
  kind: SnapshotArtifactKind,
  mediaType: z.string(),
  byteLength: z.number().int().min(0),
  contentHash: z.string(),
  metadata: JsonObject,
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

export const ArtifactDetail = ArtifactSummary.extend({
  /** Untrusted captured text. Clients must render it as text, never as HTML or code. */
  textContent: z.string(),
});
export type ArtifactDetail = z.infer<typeof ArtifactDetail>;

export const CaptureRunRecord = z.object({
  id: Uuid,
  state: AnalysisRunState,
  failureCategory: AnalysisRunFailureCategory.nullable(),
  attemptCount: z.number().int().min(0),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type CaptureRunRecord = z.infer<typeof CaptureRunRecord>;

export const SnapshotDetail = SnapshotSummary.extend({
  metadata: JsonObject.nullable(),
  failureMetadata: CaptureFailureMetadata.nullable(),
  artifacts: z.array(ArtifactSummary),
  run: CaptureRunRecord.nullable(),
});
export type SnapshotDetail = z.infer<typeof SnapshotDetail>;

export const CaptureRequestedResponse = z.object({
  snapshot: SnapshotSummary,
  runId: Uuid,
});
export type CaptureRequestedResponse = z.infer<typeof CaptureRequestedResponse>;

export const CaptureAllResponse = z.object({
  requested: z.array(CaptureRequestedResponse),
  /** Sources skipped because a capture is already pending for them. */
  skippedSourceIds: z.array(Uuid),
});
export type CaptureAllResponse = z.infer<typeof CaptureAllResponse>;

/*
 * P6B-beta1: a SUBMISSION is one logical intent -- one GitHub repository plus one Devpost page, submitted to one event -- recorded and
 * performed atomically by `POST /events/:eventId/submissions` (header `Idempotency-Key`: a UUID). Project, both source declarations and
 * both capture requests are created in ONE transaction or not at all. Identity is the canonical (event, GitHub URL, Devpost URL), never a
 * project name. The project name is a label only.
 */
export const SubmitProjectRequest = z.strictObject({
  githubUrl: z.string().trim().min(1).max(SOURCE_INGESTION_LIMITS.urlMaxChars),
  devpostUrl: z.string().trim().min(1).max(SOURCE_INGESTION_LIMITS.urlMaxChars),
  /** Optional label. Derived from the GitHub repository (`owner/repo`) when absent. */
  name: LabelText(SOURCE_INGESTION_LIMITS.projectNameMaxChars).nullable().optional(),
});
export type SubmitProjectRequest = z.input<typeof SubmitProjectRequest>;

/** What a request RECORDED (stored with the idempotency key). A replay is not stored: it is the answer to a repeated key. */
export const SUBMISSION_RECORDED_RESULT_VALUES = ['created', 'already_submitted'] as const;
export const SUBMISSION_RESULT_VALUES = [...SUBMISSION_RECORDED_RESULT_VALUES, 'replayed'] as const;
/**
 * `created`: this request created the project. `replayed`: the same Idempotency-Key with the same content already created it (a retry
 * after a lost response). `already_submitted`: a DIFFERENT request with an identical GitHub + Devpost pair in this event already created
 * it -- proven-equivalent content, so it converges on that project instead of creating a second one.
 */
export const SubmissionResult = z.enum(SUBMISSION_RESULT_VALUES);
export type SubmissionResult = z.infer<typeof SubmissionResult>;

export const SubmitProjectResponse = z.object({
  result: SubmissionResult,
  project: ProjectDetail,
  /** Capture runs requested by THIS request (empty for `replayed` / `already_submitted`: nothing is requested twice). */
  captureRuns: z.array(z.object({ sourceId: Uuid, snapshotId: Uuid, runId: Uuid })),
});
export type SubmitProjectResponse = z.infer<typeof SubmitProjectResponse>;

/**
 * `POST /projects/:projectId/void` (header `Idempotency-Key`; organizer permissions `project.write` + `source.capture`, as for a submission): an authorized
 * organizer declares the project erroneous, with a reason, and optionally submits the corrected GitHub + Devpost pair in the same operation.
 * Nothing about the voided project is deleted or rewritten; see ARCHITECTURE.md (submission correction).
 */
export const VoidProjectRequest = z.strictObject({
  reason: LabelText(1_000),
  replacement: z
    .strictObject({
      githubUrl: z.string().trim().min(1).max(SOURCE_INGESTION_LIMITS.urlMaxChars),
      devpostUrl: z.string().trim().min(1).max(SOURCE_INGESTION_LIMITS.urlMaxChars),
      name: LabelText(SOURCE_INGESTION_LIMITS.projectNameMaxChars).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type VoidProjectRequest = z.input<typeof VoidProjectRequest>;

export const VoidProjectResponse = z.object({
  /** `voided`: this request voided it. `replayed`: the same key and content already did. */
  result: z.enum(['voided', 'replayed']),
  project: ProjectDetail,
  replacement: SubmitProjectResponse.nullable(),
});
export type VoidProjectResponse = z.infer<typeof VoidProjectResponse>;

export const SUBMISSION_INTEGRITY_KIND_VALUES = [
  'multiple_sources_of_one_type',
  'shared_source_url',
] as const;
export const SubmissionIntegrityFinding = z.object({
  kind: z.enum(SUBMISSION_INTEGRITY_KIND_VALUES),
  sourceType: z.enum(['github', 'devpost']),
  /** The declared URLs involved (canonical). */
  urls: z.array(z.string()),
  projectIds: z.array(Uuid),
});
export type SubmissionIntegrityFinding = z.infer<typeof SubmissionIntegrityFinding>;

export const REGISTRY_PROBLEM_KIND_VALUES = ['missing_claim', 'stale_claim'] as const;
/**
 * The ownership registry (project_submission_claims) is the database's authority on who owns a link or a label. This is the read-only check that the
 * registry and the rows it summarizes still agree, computed from the base tables so it does not trust the registry it checks:
 *   missing_claim: an active project holds a link/label that nobody has claimed (registry rows were lost, or the row predates the registry and
 *                  was not claimed because it is ambiguous -- see docs/MIGRATIONS.md);
 *   stale_claim:   a claim belongs to a voided project, or to a link/label its project no longer holds.
 */
export const RegistryProblem = z.object({
  kind: z.enum(REGISTRY_PROBLEM_KIND_VALUES),
  claimKind: z.enum(['github', 'devpost', 'name']),
  value: z.string(),
  projectIds: z.array(Uuid),
});
export type RegistryProblem = z.infer<typeof RegistryProblem>;

/** Read-only detection of projects that do not form one submission. Nothing is repaired or deleted by reading it. */
export const SubmissionIntegrityReport = z.object({
  eventId: Uuid,
  projectsChecked: z.number().int().min(0),
  /** Voided projects are history: they are not checked and never appear in the findings. */
  projectsVoided: z.number().int().min(0),
  /** Projects not created through the submission operation (earlier flows): their provenance cannot be proven either way. */
  projectsWithoutSubmissionRecord: z.number().int().min(0),
  findings: z.array(SubmissionIntegrityFinding),
  /** Disagreements between the ownership registry and the declarations it summarizes (empty when consistent). */
  registryProblems: z.array(RegistryProblem),
});
export type SubmissionIntegrityReport = z.infer<typeof SubmissionIntegrityReport>;

export const ActorRecord = z.object({
  id: Uuid,
  issuer: z.string(),
  subject: z.string(),
  roles: z.array(ActorRole),
});
export type ActorRecord = z.infer<typeof ActorRecord>;
