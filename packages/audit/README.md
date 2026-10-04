# @judge-copilot/audit

**Layer 2.** The append-only audit contract: `AuditEventInput` validation, `createAuditEvent`
(immutable, ID- and timestamp-stamped events) and the `AuditSink` port. Persistence is provided
by adapters (`createDatabaseAuditSink` in `@judge-copilot/database`). Audit metadata must never
contain secrets or raw project content.
