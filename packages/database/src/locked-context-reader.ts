import { authorityRank, lockedContentHash } from '@judge-copilot/context';
import {
  EventContextContent,
  type EventContextDocument,
  type EventContextLockedSnapshot,
  type EventSourceSummary,
} from '@judge-copilot/schemas';
import { asc, eq, inArray } from 'drizzle-orm';
import type { JudgeDatabase } from './client.js';
import {
  eventContextVersions,
  eventSources,
  rubricAnchors,
  rubricCriteria,
  rubrics,
  tracks,
} from './schema/index.js';

/*
 * A READ-ONLY reader of one frozen Event Context version (M5 P4, design §7.2). It reassembles the locked document exactly as the API's
 * EventContextService does (a parity test in tests/integration keeps the two from drifting), then RECOMPUTES the content hash from the
 * rows it just read and requires it to equal the stored column. It takes no lock and accepts no document, hash or status from a caller.
 */

type Executor = JudgeDatabase;

const iso = (date: Date): string => date.toISOString();
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('internal: a required row is missing');
  return value;
};

export type LockedContextReadFailure =
  | 'version_not_found'
  | 'wrong_event'
  | 'not_frozen'
  | 'missing_frozen_content'
  | 'content_hash_mismatch';

export type LockedContextRead =
  | {
      readonly ok: true;
      readonly snapshot: EventContextLockedSnapshot;
      readonly recomputedHash: string;
    }
  | { readonly ok: false; readonly failure: LockedContextReadFailure };

export class LockedContextReader {
  /** Reads version `versionId` of `eventId`. `status` is reported exactly as stored ('locked' or 'superseded'). */
  async read(executor: Executor, eventId: string, versionId: string): Promise<LockedContextRead> {
    const [version] = await executor
      .select()
      .from(eventContextVersions)
      .where(eq(eventContextVersions.id, versionId));
    if (!version) return { ok: false, failure: 'version_not_found' };
    if (version.eventId !== eventId) return { ok: false, failure: 'wrong_event' };
    if (version.status !== 'locked' && version.status !== 'superseded') {
      return { ok: false, failure: 'not_frozen' };
    }
    if (
      version.content === null ||
      version.lockedAt === null ||
      version.lockedContentHash === null
    ) {
      return { ok: false, failure: 'missing_frozen_content' };
    }
    const sourceRows = await executor
      .select()
      .from(eventSources)
      .where(eq(eventSources.contextVersionId, versionId))
      .orderBy(asc(eventSources.position));
    const sources: EventSourceSummary[] = sourceRows.map((row) => ({
      id: row.id,
      contextVersionId: row.contextVersionId,
      sourceType: row.sourceType,
      authority: row.authority,
      authorityRank: authorityRank(row.authority),
      title: row.title,
      url: row.url,
      contentHash: row.contentHash,
      textLength: row.normalizedText.length,
      capturedAt: iso(row.capturedAt),
      createdAt: iso(row.createdAt),
      copiedFromId: row.copiedFromId,
    }));
    const document = await this.loadDocument(executor, versionId, version.content);
    const recomputedHash = lockedContentHash({ document, sources });
    if (recomputedHash !== version.lockedContentHash) {
      return { ok: false, failure: 'content_hash_mismatch' };
    }
    return {
      ok: true,
      recomputedHash,
      snapshot: {
        eventId,
        versionId,
        version: version.version,
        status: version.status,
        lockedAt: iso(version.lockedAt),
        lockedContentHash: version.lockedContentHash,
        supersedesId: version.supersedesId,
        changeReason: version.changeReason,
        summary: version.summary,
        sources,
        document,
      },
    };
  }

  /** Reassembles the document from its JSONB content and the normalized track/rubric tables. */
  private async loadDocument(
    executor: Executor,
    versionId: string,
    storedContent: unknown,
  ): Promise<EventContextDocument> {
    const content = EventContextContent.parse(storedContent);
    const trackRows = await executor
      .select()
      .from(tracks)
      .where(eq(tracks.contextVersionId, versionId))
      .orderBy(asc(tracks.displayOrder));
    const rubricRows = await executor
      .select()
      .from(rubrics)
      .where(eq(rubrics.contextVersionId, versionId))
      .orderBy(asc(rubrics.displayOrder));
    const criterionRows =
      rubricRows.length === 0
        ? []
        : await executor
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
        : await executor
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
}
