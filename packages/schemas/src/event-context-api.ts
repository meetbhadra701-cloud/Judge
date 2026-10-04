import { z } from 'zod';
import { EventContextStatus } from './enums.js';
import {
  EventContextDocument,
  EventContextDocumentInput,
  EventSourceSummary,
} from './event-context.js';
import { Slug, Uuid } from './primitives.js';

/*
 * HTTP contract for the M1 Event Context API (apps/api) and its client (apps/web).
 * Timestamps are ISO-8601 strings on the wire.
 */

const IsoDateTime = z.iso.datetime({ offset: true });

export const CreateEventRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: Slug,
    startsAt: IsoDateTime.nullable().optional(),
    endsAt: IsoDateTime.nullable().optional(),
    judgingStartsAt: IsoDateTime.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startsAt && value.endsAt && Date.parse(value.endsAt) < Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must not precede startsAt',
      });
    }
  });
export type CreateEventRequest = z.infer<typeof CreateEventRequest>;

export const EventRecord = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  startsAt: IsoDateTime.nullable(),
  endsAt: IsoDateTime.nullable(),
  judgingStartsAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EventRecord = z.infer<typeof EventRecord>;

export const ContextVersionSummary = z.object({
  id: Uuid,
  eventId: Uuid,
  version: z.number().int(),
  status: EventContextStatus,
  createdAt: IsoDateTime,
  lockedAt: IsoDateTime.nullable(),
  supersedesId: Uuid.nullable(),
  changeReason: z.string().nullable(),
});
export type ContextVersionSummary = z.infer<typeof ContextVersionSummary>;

export const EventDetail = z.object({
  event: EventRecord,
  versions: z.array(ContextVersionSummary),
  lockedVersionId: Uuid.nullable(),
});
export type EventDetail = z.infer<typeof EventDetail>;

export const CreateContextVersionRequest = z.object({
  /** Required when a locked version exists (the new draft derives from it). */
  changeReason: z.string().trim().min(1).max(1_000).optional(),
});
export type CreateContextVersionRequest = z.infer<typeof CreateContextVersionRequest>;

export const UpdateEventContextRequest = z.object({
  document: EventContextDocumentInput,
  summary: z.string().trim().max(5_000).nullable().optional(),
});
export type UpdateEventContextRequest = z.infer<typeof UpdateEventContextRequest>;

export const EventContextIssue = z.object({
  code: z.string(),
  path: z.string(),
  message: z.string(),
});
export type EventContextIssue = z.infer<typeof EventContextIssue>;

export const UnresolvedItem = z.object({
  kind: z.enum(['unclear_fact', 'unresolved_conflict']),
  path: z.string(),
  id: Uuid,
  statement: z.string(),
});
export type UnresolvedItem = z.infer<typeof UnresolvedItem>;

export const ContextVersionDetail = ContextVersionSummary.extend({
  summary: z.string().nullable(),
  lockedContentHash: z.string().nullable(),
  /** The reviewed context (null until built or authored). */
  document: EventContextDocument.nullable(),
  /** Output of the most recent successful build, kept to distinguish source-derived facts from human edits. */
  extraction: EventContextDocument.nullable(),
  sources: z.array(EventSourceSummary),
  unresolved: z.array(UnresolvedItem),
  /** Draft versions only: whether locking would currently succeed. */
  lockReadiness: z.object({ ready: z.boolean(), issues: z.array(EventContextIssue) }).nullable(),
  /** Frozen versions only: whether the stored content still hashes to `lockedContentHash`. */
  integrity: z.enum(['verified', 'mismatch']).nullable(),
});
export type ContextVersionDetail = z.infer<typeof ContextVersionDetail>;

/** What a future assessment references: one exact, frozen Event Context version. */
export const EventContextLockedSnapshot = z.object({
  eventId: Uuid,
  versionId: Uuid,
  version: z.number().int(),
  status: z.enum(['locked', 'superseded']),
  lockedAt: IsoDateTime,
  lockedContentHash: z.string(),
  supersedesId: Uuid.nullable(),
  changeReason: z.string().nullable(),
  summary: z.string().nullable(),
  sources: z.array(EventSourceSummary),
  document: EventContextDocument,
});
export type EventContextLockedSnapshot = z.infer<typeof EventContextLockedSnapshot>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
