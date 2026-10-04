import type {
  analysisRuns,
  projectSources,
  projects,
  sourceSnapshotArtifacts,
  sourceSnapshots,
} from '@judge-copilot/database';
import {
  CaptureFailureMetadata,
  type ArtifactSummary,
  type CapturePartialReason,
  type CaptureRunRecord,
  type ProjectRecord,
  type ProjectSourceRecord,
  type ProjectTrackSelectionRecord,
  type SnapshotSummary,
} from '@judge-copilot/schemas';

export type ProjectRow = typeof projects.$inferSelect;
export type SourceRow = typeof projectSources.$inferSelect;
export type SnapshotRow = typeof sourceSnapshots.$inferSelect;
export type ArtifactRow = typeof sourceSnapshotArtifacts.$inferSelect;
export type RunRow = typeof analysisRuns.$inferSelect;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toProjectRecord(
  row: ProjectRow,
  tracks: ProjectTrackSelectionRecord[],
): ProjectRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    name: row.name,
    teamName: row.teamName,
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    tracks,
  };
}

export function toSnapshotSummary(
  row: SnapshotRow,
  totals: { artifactCount: number; artifactBytes: number },
): SnapshotSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceId: row.projectSourceId,
    captureNumber: row.captureNumber,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    status: row.status,
    revision: row.revision,
    contentHash: row.contentHash,
    partialReasons: row.partialReasons as CapturePartialReason[],
    failureCategory: row.failureCategory,
    requestedAt: iso(row.createdAt),
    capturedAt: isoOrNull(row.capturedAt),
    completedAt: isoOrNull(row.completedAt),
    artifactCount: totals.artifactCount,
    artifactBytes: totals.artifactBytes,
  };
}

export function toSourceRecord(
  row: SourceRow,
  latest: SnapshotSummary | null,
): ProjectSourceRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceType: row.sourceType,
    url: row.url,
    position: row.position,
    createdByActorId: row.createdByActorId,
    createdAt: iso(row.createdAt),
    latestSnapshot: latest,
  };
}

export function toArtifactSummary(row: Omit<ArtifactRow, 'textContent'>): ArtifactSummary {
  return {
    id: row.id,
    key: row.artifactKey,
    kind: row.artifactKind,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
    contentHash: row.contentHash,
    metadata: row.metadata as ArtifactSummary['metadata'],
  };
}

export function toRunRecord(row: RunRow): CaptureRunRecord {
  return {
    id: row.id,
    state: row.state,
    failureCategory: row.failureCategory,
    attemptCount: row.attemptCount,
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

export function toFailureMetadata(value: unknown): CaptureFailureMetadata | null {
  if (value === null || value === undefined) return null;
  const parsed = CaptureFailureMetadata.safeParse(value);
  return parsed.success ? parsed.data : {};
}
