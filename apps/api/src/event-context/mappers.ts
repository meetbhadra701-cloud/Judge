import { authorityRank } from '@judge-copilot/context';
import type { eventContextVersions, eventSources, events } from '@judge-copilot/database';
import type {
  ContextVersionSummary,
  EventRecord,
  EventSourceRecord,
  EventSourceSummary,
} from '@judge-copilot/schemas';

export type EventRow = typeof events.$inferSelect;
export type VersionRow = typeof eventContextVersions.$inferSelect;
export type SourceRow = typeof eventSources.$inferSelect;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    startsAt: isoOrNull(row.startsAt),
    endsAt: isoOrNull(row.endsAt),
    judgingStartsAt: isoOrNull(row.judgingStartsAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toVersionSummary(row: VersionRow): ContextVersionSummary {
  return {
    id: row.id,
    eventId: row.eventId,
    version: row.version,
    status: row.status,
    createdAt: iso(row.createdAt),
    lockedAt: isoOrNull(row.lockedAt),
    supersedesId: row.supersedesId,
    changeReason: row.changeReason,
  };
}

export function toSourceSummary(row: SourceRow): EventSourceSummary {
  return {
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
  };
}

export function toSourceRecord(row: SourceRow): EventSourceRecord {
  return { ...toSourceSummary(row), normalizedText: row.normalizedText };
}
