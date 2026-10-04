# @judge-copilot/database

**Layer 3 (adapter).** PostgreSQL via Drizzle ORM.

- `src/schema/` — table definitions. M0: `events`, `event_context_versions`, `analysis_runs`,
  `audit_events`. M1: `event_sources`, `tracks`, `rubrics`, `rubric_criteria`, `rubric_anchors`.
  CHECK constraints are generated from `@judge-copilot/schemas` vocabularies.
- Hand-written trigger migrations: `0001` (append-only audit) and `0003` (frozen Event Context
  versions and children, immutable source rows, same-version provenance references).
- `drizzle/` — committed SQL migrations. Never edit an existing migration; add a new one.
- `createDatabase(url)` — opens a postgres.js pool only when explicitly called.
- `createDatabaseAuditSink(db)` — `AuditSink` adapter over `audit_events`.

Commands (from the repo root):

| Command            | Needs `DATABASE_URL` | Purpose                                  |
| ------------------ | -------------------- | ---------------------------------------- |
| `pnpm db:generate` | no                   | generate a migration from schema changes |
| `pnpm db:check`    | no                   | validate migration history consistency   |
| `pnpm db:migrate`  | yes                  | apply migrations to a database           |

Tests apply all migrations to in-process PGlite. Set `TEST_DATABASE_URL` to a disposable
`*_test` PostgreSQL database to additionally run them against a real server. Test files then run
sequentially, because each one rebuilds that database. Test helpers live in `src/testing/` and
are excluded from the build.
