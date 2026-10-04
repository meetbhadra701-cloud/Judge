import type { AuditEvent, AuditSink } from '@judge-copilot/audit';
import type { JudgeDatabase } from './client.js';
import { auditEvents } from './schema/index.js';

/** Persists audit events to the append-only `audit_events` table. */
export function createDatabaseAuditSink(db: JudgeDatabase): AuditSink {
  return {
    async append(event: AuditEvent) {
      await db.insert(auditEvents).values({
        id: event.id,
        actorId: event.actorId,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        metadata: event.metadata,
        createdAt: event.createdAt,
      });
    },
  };
}
