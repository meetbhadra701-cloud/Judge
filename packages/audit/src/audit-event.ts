import { randomUUID } from 'node:crypto';
import { DottedIdentifier, Identifier, Uuid } from '@judge-copilot/schemas';
import { z } from 'zod';

/**
 * What a caller supplies to record an audit event.
 *
 * - `actorId` is null for system actions (no authentication exists before a later milestone).
 * - `entityType` is the snake_case name of the audited entity, e.g. `event_context_version`.
 * - `action` is a dotted identifier, e.g. `event_context.locked`.
 * - `metadata` is a JSON object. It must never contain secrets or raw project content
 *   (docs/SECURITY.md); reference evidence and snapshots by ID instead.
 */
export const AuditEventInput = z.object({
  actorId: Uuid.nullable(),
  entityType: Identifier,
  entityId: Uuid,
  action: DottedIdentifier,
  metadata: z.record(z.string(), z.json()).default({}),
});
export type AuditEventInput = z.input<typeof AuditEventInput>;

export const AuditEvent = AuditEventInput.extend({
  id: Uuid,
  createdAt: z.date(),
});
export type AuditEvent = Readonly<z.output<typeof AuditEvent>>;

export interface AuditEventFactoryOptions {
  now?: () => Date;
  newId?: () => string;
}

/**
 * Validates input and produces an immutable audit event. Audit events are append-only: they
 * are never updated or deleted once recorded (the database enforces this with a trigger).
 */
export function createAuditEvent(
  input: AuditEventInput,
  { now = () => new Date(), newId = randomUUID }: AuditEventFactoryOptions = {},
): AuditEvent {
  const event = AuditEvent.parse({ ...input, id: newId(), createdAt: now() });
  return Object.freeze(event);
}

/** A destination for audit events. Implementations must only ever append. */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}
