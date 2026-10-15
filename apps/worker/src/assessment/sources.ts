import {
  SOURCE_TYPE_VALUES,
  type RoutedSourceType,
  type SnapshotFact,
  type SourceArtifact,
  type SourceGapStatus,
  type SourceStatus,
} from '@judge-copilot/assessment';
import {
  assessmentRunInputSnapshots,
  projectSources,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { failRun } from './stop.js';

/*
 * S1 (read): the stored text of the snapshots a run PINNED, and the capture status of every declared source (design §4.1, §10.4).
 *
 * Read-only, no transaction held across anything else, and nothing here is model-visible: the text goes to the pure windowing step.
 * The pins are the run's, written under the project lock when the run was requested; a later capture changes nothing about them.
 * Each pinned snapshot is re-checked against its pinned content hash here so that a bad pin fails the run before any money is spent;
 * the trusted reader repeats the check at scoring time.
 */

export interface PinnedSnapshot {
  readonly snapshotId: string;
  readonly projectSourceId: string;
  readonly sourceType: RoutedSourceType;
  readonly status: 'captured' | 'partial';
  readonly contentHash: string;
  /** Where the stored text came from: a capture worker read it from the source, or an organizer typed/pasted it (never verified against the source). */
  readonly provenance: 'fetched' | 'organizer_supplied';
  /** Why a `partial` capture is partial (empty for `captured`): the capture worker's own closed vocabulary. */
  readonly partialReasons: readonly string[];
}

export interface PinnedSources {
  readonly pins: readonly PinnedSnapshot[];
  readonly artifacts: readonly SourceArtifact[];
  readonly snapshotFacts: readonly SnapshotFact[];
  /** One status per source type, for the code-authored `missing` unknowns. */
  readonly statuses: readonly SourceStatus[];
}

const SEVERITY: Record<'failed' | 'rejected' | 'pending', number> = {
  failed: 3,
  rejected: 2,
  pending: 1,
};

export async function loadPinnedSources(
  db: JudgeDatabase,
  runId: string,
  projectId: string,
): Promise<PinnedSources> {
  const pinRows = await db
    .select({
      snapshotId: assessmentRunInputSnapshots.snapshotId,
      pinnedHash: assessmentRunInputSnapshots.snapshotContentHash,
      snapshot: sourceSnapshots,
    })
    .from(assessmentRunInputSnapshots)
    .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, assessmentRunInputSnapshots.snapshotId))
    .where(
      and(
        eq(assessmentRunInputSnapshots.runId, runId),
        eq(assessmentRunInputSnapshots.projectId, projectId),
      ),
    )
    .orderBy(asc(assessmentRunInputSnapshots.snapshotId));
  if (pinRows.length === 0) return failRun('source_unavailable', 'no_pinned_snapshots', 'load');
  const pins: PinnedSnapshot[] = [];
  for (const row of pinRows) {
    const { snapshot } = row;
    if (
      (snapshot.status !== 'captured' && snapshot.status !== 'partial') ||
      snapshot.contentHash !== row.pinnedHash
    ) {
      return failRun('internal_error', 'pinned_snapshot_changed', 'load');
    }
    pins.push({
      snapshotId: snapshot.id,
      projectSourceId: snapshot.projectSourceId,
      sourceType: snapshot.sourceType,
      status: snapshot.status,
      contentHash: row.pinnedHash,
      provenance:
        snapshot.metadata?.['provenance'] === 'organizer_supplied'
          ? 'organizer_supplied'
          : 'fetched',
      partialReasons: [...snapshot.partialReasons],
    });
  }

  const artifactRows = await db
    .select()
    .from(sourceSnapshotArtifacts)
    .where(
      inArray(
        sourceSnapshotArtifacts.snapshotId,
        pins.map((pin) => pin.snapshotId),
      ),
    )
    .orderBy(asc(sourceSnapshotArtifacts.snapshotId), asc(sourceSnapshotArtifacts.artifactKey));
  const byId = new Map(pins.map((pin) => [pin.snapshotId, pin]));
  const artifacts: SourceArtifact[] = artifactRows.flatMap((row) => {
    const pin = byId.get(row.snapshotId);
    return pin
      ? [
          {
            snapshotId: row.snapshotId,
            artifactId: row.id,
            sourceType: pin.sourceType,
            snapshotStatus: pin.status,
            key: row.artifactKey,
            kind: row.artifactKind,
            mediaType: row.mediaType,
            text: row.textContent,
          },
        ]
      : [];
  });

  // the capture state of every declared source: the pinned content-bearing capture, else the latest attempt
  const sources = await db
    .select({ id: projectSources.id, sourceType: projectSources.sourceType })
    .from(projectSources)
    .where(eq(projectSources.projectId, projectId));
  const perSource = new Map<string, SourceGapStatus>();
  for (const source of sources) {
    const pinned = pins.find((pin) => pin.projectSourceId === source.id);
    if (pinned) {
      perSource.set(source.id, pinned.status);
      continue;
    }
    const [latest] = await db
      .select({ status: sourceSnapshots.status })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.projectSourceId, source.id))
      .orderBy(desc(sourceSnapshots.captureNumber))
      .limit(1);
    perSource.set(
      source.id,
      latest?.status === 'failed' || latest?.status === 'rejected' ? latest.status : 'pending',
    );
  }
  const statuses: SourceStatus[] = SOURCE_TYPE_VALUES.map((sourceType) => {
    const mine = sources.filter((source) => source.sourceType === sourceType);
    if (mine.length === 0) return { sourceType, status: 'absent' as const };
    const states = mine.map((source) => perSource.get(source.id) ?? 'pending');
    if (states.every((state) => state === 'captured')) return { sourceType, status: 'captured' };
    const bearing = states.some((state) => state === 'captured' || state === 'partial');
    if (bearing) return { sourceType, status: 'partial' };
    const worst = [...states]
      .filter((state): state is 'failed' | 'rejected' | 'pending' => state in SEVERITY)
      .sort((a, b) => SEVERITY[b] - SEVERITY[a])[0];
    return { sourceType, status: worst ?? 'pending' };
  });

  return {
    pins,
    artifacts,
    snapshotFacts: pins.map((pin) => ({
      id: pin.snapshotId,
      sourceType: pin.sourceType,
      status: pin.status,
    })),
    statuses,
  };
}
