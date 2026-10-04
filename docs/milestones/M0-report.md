# Milestone 0 — Foundation: Report

**Status:** complete, acceptance gate passed. M1 has **not** been started.

## Scope delivered

- pnpm workspace (`apps/*`, `packages/*`), strict TypeScript 6 (ESM, NodeNext), ESLint 9
  (typescript-eslint strict type-checked + Next plugin), Prettier, Vitest 5.
- `apps/web`: Next.js 16 placeholder page identifying Judge Copilot. No dashboards, scores or
  fake functionality.
- `apps/api`: Fastify 5 with `GET /health` → `{"status":"ok","service":"judge-copilot-api"}`
  and graceful SIGINT/SIGTERM shutdown.
- `apps/worker`: boots, logs `jobHandlers: 0`, stops cleanly. No jobs, no integrations.
- `packages/schemas`: `Score10`, `Ratio`, `Uuid`, `Slug`, `Identifier`, `DottedIdentifier`, and
  the vocabularies `VerificationLevel`, `EvidenceKind`, `EvidenceOrigin`, `QuestionMode`,
  `UnknownType`, `AssessmentKind`, `SourceSnapshotStatus`, `EventContextStatus`,
  `AnalysisRunState`, `AnalysisRunFailureCategory`.
- `packages/domain`: inferred domain types re-exported; lifecycle classifications (frozen Event
  Context statuses, the official status, terminal run/snapshot states).
- `packages/shared`: env validation (`parseEnv`, `ConfigError` that never echoes values),
  structured logger with redaction and an allow-listed error serializer, shutdown handling.
- `packages/audit`: `AuditEventInput` validation, `createAuditEvent`, `AuditSink` port.
- `packages/database`: Drizzle schema + migrations for `events`, `event_context_versions`,
  `analysis_runs`, `audit_events`; append-only audit trigger; `createDatabase`;
  `createDatabaseAuditSink`.
- README-only placeholders for `context`, `evidence`, `scoring`, `uncertainty`, `questions`,
  `github`, `devpost`, `browser`, `llm`, `prompts`, and `tests/{fixtures,e2e,benchmark}`.
- Docs: `PRODUCT.md`, `ARCHITECTURE.md`, `SCORING.md`, `AI_PIPELINE.md`, `SECURITY.md`,
  `V1_CONTRACT.md`, plus `CLAUDE.md` / `AGENTS.md` guardrails for coding agents.

## Key decisions

| Decision                                                                          | Rationale                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| pnpm `-r` instead of Turborepo                                                    | topological builds are sufficient at this size; no telemetry or cache configuration                                 |
| Source-condition exports (`@judge-copilot/source`)                                | tests, typecheck and dev resolve TS source with no prior build; builds and production use `dist`                    |
| `text` + CHECK constraints generated from Zod value tuples (not `pgEnum`)         | one source of truth; vocabularies evolve via ordinary migrations                                                    |
| `analysis_runs.project_id` omitted (option A)                                     | no `projects` table until M2; smallest correct schema                                                               |
| `run_type` is a validated snake_case identifier, not an enum                      | concrete run types belong to the milestones that introduce them                                                     |
| `superseded` is a stored Event Context status                                     | enables the "one locked version per event" partial unique index while keeping old versions frozen and referenceable |
| Composite FK `(supersedes_id, event_id)`                                          | a version can only supersede a version of the same event                                                            |
| Append-only `audit_events` trigger in M0                                          | audit immutability is foundational and cheap to enforce now                                                         |
| PGlite for migration tests, optional real Postgres via `TEST_DATABASE_URL`        | migration tests need no server or network; real-server parity available on demand                                   |
| Layered dependency rules enforced by a test; `llm`/`prompts` in the adapter layer | deterministic core packages structurally cannot import model code                                                   |
| `database` implements the `AuditSink` port from `audit`                           | ports-and-adapters: core defines contracts, adapters depend on core                                                 |
| TypeScript 6.0 (not 7.0)                                                          | typescript-eslint 8 supports `<6.1`; ESLint 9 for plugin compatibility                                              |

## Acceptance gate — commands and results

All commands were run from the repository root on Node 22.22.0 / pnpm 10.28.0.

| Check                         | Command                                                                                 | Result                                          |
| ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Clean install                 | `rm -rf node_modules … && pnpm install --frozen-lockfile`                               | pass                                            |
| Formatting                    | `pnpm format:check`                                                                     | pass: all files use Prettier style              |
| Lint                          | `pnpm lint` (`--max-warnings=0`)                                                        | pass: 0 problems                                |
| Strict typecheck              | `pnpm typecheck` (8 workspace projects + root tests)                                    | pass                                            |
| Migration consistency         | `pnpm db:check`                                                                         | pass ("Everything's fine")                      |
| Schema drift                  | `pnpm db:generate`                                                                      | pass ("No schema changes, nothing to migrate")  |
| Tests                         | `pnpm test`                                                                             | pass: 11 files, 70 tests                        |
| Full build                    | `pnpm build` (incl. `next build`)                                                       | pass: 8 projects                                |
| Aggregate                     | `pnpm check`                                                                            | exit 0                                          |
| Real PostgreSQL 16 migrations | `TEST_DATABASE_URL=…/judge_copilot_test pnpm vitest run packages/database`              | pass: 24 tests (12 PGlite + 12 PostgreSQL)      |
| `drizzle-kit migrate`         | `DATABASE_URL=…/judge_copilot_dev pnpm db:migrate`                                      | pass: 4 tables + 2 audit triggers created       |
| Compiled services             | `node apps/api/dist/main.js` + `curl /health`; `node apps/worker/dist/main.js`; SIGTERM | pass: health JSON returned; both exited 0       |
| Secrets                       | regex scan of all files to be committed                                                 | pass: only documented example/test placeholders |

Test inventory:

- `packages/schemas/src/schemas.test.ts`: Score10/Ratio bounds (including NaN/±∞),
  identifier primitives, every vocabulary's exact values and rejection of unknown values.
- `packages/shared/src/env.test.ts`, `logger.test.ts`: defaults, ConfigError without value
  echo, redaction, SDK error payload dropping.
- `packages/domain/src/lifecycle.test.ts`: lifecycle classifications.
- `packages/audit/src/audit-event.test.ts`: event construction, freezing, rejection of invalid
  input.
- `packages/database/src/migrations.test.ts`: migrations apply; exact table set; every
  constraint (unique slug, slug format, date order, status vocabulary, `locked_at` ↔ status,
  one locked version per event, same-event supersession, no self-supersession, restrict delete,
  run state ↔ `finished_at` / `failure_category`, every failure category accepted, append-only
  audit for UPDATE/DELETE/TRUNCATE, object metadata, identifier formats); `AuditSink`
  persistence.
- `apps/api/src/app.test.ts`: `/health` via inject and via a real loopback socket, 404 for
  non-existent routes, clean close, env defaults without `DATABASE_URL`.
- `apps/worker/src/worker.test.ts`: start/stop lifecycle, idempotency.
- `tests/integration/dependency-rules.test.ts`: layer assignments, downward-only dependencies,
  no app dependencies, acyclic graph, imports match declarations, no deep or escaping imports.
- `tests/integration/services-boot.test.ts`: real API and worker entrypoints boot as child
  processes with the network guard preloaded and a minimal env (no DB, no credentials), and
  exit 0 on SIGTERM.
- `tests/integration/no-network-guard.test.ts`: the guard blocks non-loopback `net.connect` and
  `fetch`.

## Deferred to M1+

Event Context content and the lock workflow (M1); authentication and authorization (M1 at the
latest); projects and `analysis_runs.project_id` (M2); source snapshots (M2); evidence graph
(M3); scoring engine (M4); all model/provider calls and prompts (M1/M5); questions (M6);
interview, reassessment and final score (M7–M9); Playwright e2e; DB-level immutability
triggers for locked Event Context content (with the content columns in M1).

## Known limitations

- Package scripts use POSIX env-var syntax (`NODE_OPTIONS=… drizzle-kit`,
  `NEXT_TELEMETRY_DISABLED=1 next build`); Windows users need WSL.
- PostgreSQL < 17 reports `ON DELETE RESTRICT` violations as SQLSTATE 23503, and ≥ 17 as 23001.
  Tests accept both.
- The network guard covers `net.Socket#connect` (which includes `http`, `https`, `tls` and
  `fetch`). It does not intercept raw UDP/DNS lookups.
- The real-PostgreSQL test path only runs when `TEST_DATABASE_URL` is set. Default CI coverage
  uses PGlite.
- No CI workflow is configured yet.

## Architecture drift check

The implementation preserves the intended pipeline:

```
sources → immutable snapshots → claims/evidence → uncertainty → dimension assessments
→ deterministic scoring → information-gain questions → human answers
→ affected-dimension reassessment → human final judgment
```

- Nothing in M0 implements or shortcuts any stage. There is no score, model call, or
  single-LLM path anywhere.
- The vocabularies that later stages need (verification levels, evidence kinds and origins,
  unknown types, question modes, assessment kinds, snapshot and Event Context statuses) are
  fixed in `@judge-copilot/schemas` exactly as specified.
- `AssessmentKind` contains only `pre_interview` and `post_interview`. The human final score is
  deliberately separate.
- The deterministic/LLM boundary is enforced structurally: `scoring`, `uncertainty` and
  `questions` sit in layer 2 and cannot depend on `llm` or `prompts` (layer 3).
- Immutability groundwork: append-only audit trail, versioned Event Context with frozen
  statuses, and failed runs that carry a failure category instead of a score.
- No CruzHacks-specific or other event-specific logic exists.
