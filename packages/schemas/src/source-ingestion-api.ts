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

export const CreateProjectRequest = z.strictObject({
  name: z.string().trim().min(1).max(SOURCE_INGESTION_LIMITS.projectNameMaxChars),
  teamName: z
    .string()
    .trim()
    .min(1)
    .max(SOURCE_INGESTION_LIMITS.teamNameMaxChars)
    .nullable()
    .optional(),
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

export const ProjectRecord = z.object({
  id: Uuid,
  eventId: Uuid,
  name: z.string(),
  teamName: z.string().nullable(),
  createdByActorId: Uuid.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  tracks: z.array(ProjectTrackSelectionRecord),
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

export const ActorRecord = z.object({
  id: Uuid,
  issuer: z.string(),
  subject: z.string(),
  roles: z.array(ActorRole),
});
export type ActorRecord = z.infer<typeof ActorRecord>;
