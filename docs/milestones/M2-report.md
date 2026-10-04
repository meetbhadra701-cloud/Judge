# Milestone 2 — Immutable Project-Source Ingestion: Report

**Baseline:** `main` at `eba962b60f36bf3d3b1976ad708e881b70cf8050` (Merge CI infrastructure).
**Branch:** `claude/m2-source-ingestion`.

M2 implements only this segment of the pipeline:

```
locked Event Context → project → declared sources → read-only capture → immutable source snapshots
```

There is no claim extraction, evidence graph, scoring, AI assessment, question generation, model
call, cheating detection or winner selection.

## Scope delivered

### Database (migrations `0004_m2_source_ingestion`, `0005_m2_source_ingestion_immutability`)

- `actors` — verified `(issuer, subject)` identities; immutable; referenced by
  `audit_events.actor_id` (new FK) and by `created_by`/`declared_by`/`requested_by` columns.
- `projects` — one event for life (trigger), name (unique per event), team name, creator. No
  score, evidence or summary columns.
- `project_track_selections` — declared tracks with composite FKs pinning event, context version
  and track together; a trigger requires the version to be the event's **locked** version at
  declaration time and the key to match. Immutable, so a later version never rewrites history.
- `project_sources` — immutable declarations (`devpost`, `github`, `deployment`, `video`), unique
  `(project, type, url)`, unique position.
- `source_snapshots` — unique `(project_source_id, capture_number)`; gapless monotonic numbers
  (trigger); composite FK `(project_source_id, project_id, source_type, source_url)` to the
  declaration; status/hash/failure/partial/revision consistency checks; failure metadata keys
  allow-listed in SQL; GitHub content snapshots require a 40-hex revision.
- `source_snapshot_artifacts` — bounded UTF-8 text; the database recomputes `byte_length` and the
  SHA-256 `content_hash` from `text_content` in CHECK constraints.
- `analysis_runs` — `pending` state, `project_id`, `source_snapshot_id` (unique: one run per
  snapshot, composite FKs to the same project and event), `lease_token`, `lease_expires_at`,
  `attempt_count`; `started_at` is null exactly while pending; terminal runs frozen by trigger.
- Triggers: snapshots insert only as `pending`, transition exactly once to a terminal status with
  unchanged identity, never delete; artifacts insert only under a pending parent (row-locked) and
  never change; sources, track selections and actors never change; projects keep their event; no
  TRUNCATE on any M2 table.

### Packages

| Package      | Layer | Role                                                                                                                                                                       |
| ------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`    | 2     | `HttpFetcher` and `ProjectSourceAdapter` ports, declared-URL rules, repository path rules, artifact and snapshot hashing, result validation, non-executing HTML extraction |
| `safe-http`  | 3     | SSRF-safe client: URL policy, `ipaddr.js` address policy, DNS with all-answers check, pinned connections, manual redirects, limits; fixture network for tests/dev          |
| `github`     | 3     | read-only REST adapter with exact-SHA pinning and blob verification; synthetic fixture builder                                                                             |
| `devpost`    | 3     | public project-page parser                                                                                                                                                 |
| `deployment` | 3     | single-GET HTTP observation                                                                                                                                                |
| `video`      | 3     | oEmbed/page metadata only                                                                                                                                                  |
| `auth`       | 3     | JWT/JWKS verifier (`jose`) and development verifier                                                                                                                        |

`schemas` gained the M2 vocabularies (`PROJECT_SOURCE_TYPE_VALUES`,
`CAPTURE_FAILURE_CATEGORY_VALUES`, `CAPTURE_PARTIAL_REASON_VALUES`,
`SNAPSHOT_ARTIFACT_KIND_VALUES`, `ACTOR_ROLE_VALUES`), limits and the HTTP contract; `domain`
gained snapshot/run classifications, `CAPTURE_REJECTION_CATEGORIES` and the authorization policy
with the `AuthVerifier` port.

### API (`apps/api`)

Authentication guard on every route except `/health` (M1 routes included); `/me`; project, source,
capture (202) and snapshot/artifact routes (ARCHITECTURE.md §11). PUT/PATCH/DELETE on snapshots and
sources answer `405 SNAPSHOT_IMMUTABLE` / `SOURCE_IMMUTABLE`. Typed errors: `PROJECT_NOT_FOUND`,
`SOURCE_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`, `ARTIFACT_NOT_FOUND`, `NO_LOCKED_CONTEXT`,
`PROJECT_NAME_TAKEN`, `DUPLICATE_SOURCE`, `CAPTURE_ALREADY_PENDING`, `UNKNOWN_TRACK`,
`INVALID_SOURCE_URL`, `SOURCE_LIMIT_REACHED`, `UNAUTHENTICATED`, `FORBIDDEN`,
`AUTH_NOT_CONFIGURED`. `EventContextService.forActor` attributes M1 audit events to the actor.

### Worker (`apps/worker`)

PostgreSQL-backed capture queue (claim with `FOR UPDATE SKIP LOCKED` + lease, capture with no
transaction open, transactional finalize with lease re-check), bounded concurrency (default 3,
max 8), one retry for transient network failures, lease reaper, graceful shutdown, safe logging.
Without `DATABASE_URL` it idles exactly as before (`jobHandlers: 0`).

### Web (`apps/web`)

Event page: project list and creation with track checkboxes from the locked context. Project
page: tracks, sources, add-source form for all four types, per-source and capture-all buttons,
snapshots newest first. Snapshot page: type, URL, status, capture number, revision, timestamps,
content hash, partial reasons, failure category, run state, metadata and artifacts; artifact text
shown escaped in `<pre>`. The server forwards `JUDGE_API_TOKEN`; the browser never calls the API.

## Behaviour

- **Capture lifecycle:** request → new pending snapshot + pending run (same transaction, audited
  `source_capture_requested`) → worker claim → adapter → validation → one transaction storing
  artifacts, terminal snapshot, terminal run and audit (`source_snapshot_captured|partial|failed|rejected`,
  actor null). A second request while one is pending is refused (`CAPTURE_ALREADY_PENDING`).
- **GitHub exact SHA:** a single `git/ref/heads/<default branch>` lookup yields the SHA; the
  commit, tree, history and blobs are then requested by object id only, each blob verified
  against its Git SHA-1. A later branch move only affects later snapshots.
- **File selection:** tree order sorted; classification (secret-prone → never fetched; ignored
  directories; binaries; lockfiles; unsupported types; symlinks; submodules; over-long paths);
  candidates ordered by priority (root README, root manifests/licence, other READMEs/docs, rest),
  depth, path; caps 256 KiB per file, 400 files, 8 MiB total; content with NUL bytes or invalid
  UTF-8 is dropped as binary. Omission counts and paths (≤ 200 per reason) are an artifact.
- **Devpost:** title, tagline, the seven standard sections, other sections, built-with, submitted
  hackathons and labels, GitHub/video/demo links. Missing sections stay null.
- **Deployment:** HTTP 404/500 are `captured` with `metadata.httpStatus`; non-text bodies are not
  read (`partial`, `body_not_captured`); bodies over 1 MiB are truncated (`partial`).
- **Video:** YouTube/Vimeo/Loom oEmbed; generic pages give metadata only (`partial`); duration
  only when the provider states it; media never read.
- **Limits:** see ARCHITECTURE.md §10 and the adapter READMEs; every limit yields `partial` with an
  explicit reason or a sanitized failure, never silent truncation.

## Tests

`pnpm test` (PGlite): **403 tests in 40 files** (baseline 182). With `TEST_DATABASE_URL`
(PostgreSQL 16): **481 tests in 40 files** (baseline 230). New test files:

| File                                                    | Covers (brief test numbers)                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/capture/src/*.test.ts`                        | URL rules (7–9, 63–64), path rules (33–34), artifact/snapshot hashing and timestamp/ID independence (18–20), result validation (21–22, 74), non-executing HTML and hostile-markup cost (44, 70)                                                                                                                            |
| `packages/safe-http/src/*.test.ts`                      | IPv4/IPv6/mapped ranges (56–62), schemes/credentials/ports (63–64), mixed DNS answers (66), rebinding (67), public→private and downgrade redirects (65), redirect limit (68), body limit, timeout, content type, encoding, header stripping, cookies, real pinned loopback transport with preserved Host (67)              |
| `packages/github/src/adapter.test.ts`                   | exact SHA and object-id-only reads (28, 30), branch movement (29), secrets/binaries/vendor (33–34), inert scripts and injection text (31–32, 70), per-file/count/total caps (35–36), tree/commit caps (37), token only to the API and never in output (38), unauthenticated mode (39), sanitized API failures, determinism |
| `packages/devpost/src/adapter.test.ts`                  | parsing (40–41), missing sections (42), partial on unrecognized/truncated pages (43), scripts never executed (44)                                                                                                                                                                                                          |
| `packages/deployment/src/adapter.test.ts`               | 200/404/500 (45–47), timeout/TLS/connection (48–49), body limit (50), disallowed content type (51)                                                                                                                                                                                                                         |
| `packages/video/src/adapter.test.ts`                    | metadata only (52), no media download (53), absent duration (54), generic → partial (55)                                                                                                                                                                                                                                   |
| `packages/auth/src/auth.test.ts`                        | JWT signature/issuer/audience/expiry/`none`, asymmetric-only, roles, dev verifier refused in production (79)                                                                                                                                                                                                               |
| `packages/domain/src/authorization.test.ts`             | permission matrix, rejection classification                                                                                                                                                                                                                                                                                |
| `packages/database/src/source-ingestion-guards.test.ts` | project/event immutability (3), track validation (4), duplicate/immutable sources (10–11), cross-project mismatches (12), capture numbers, terminal immutability in SQL (16), artifacts (17), failure/hash requirements (21–22), GitHub revision, DB hash recomputation, run links, actors                                 |
| `apps/api/src/projects/routes.test.ts`                  | create/invalid event (1–2), track history across versions (5), four source types and duplicates (6–10), immutable/cross-project routes (11–12, 15), 202 pending snapshot and new capture numbers (13–14), auth on M1+M2 routes (76–78), credentials never stored/echoed/logged (80), no score/evidence/analyze routes (71) |
| `apps/worker/src/capture/fixtures.test.ts`              | fixtures A–I end to end through the real SafeHttpClient and adapters (28–29, 33, 37, 38, 45–48, 58, 65, 67, 70, 73), reconstruction on reload                                                                                                                                                                              |
| `apps/worker/src/capture/queue.test.ts`                 | single claim (23), no double finalize (24), lease expiry, no open transaction during capture (25), failure isolation and raw-error containment (26, 74), one retry only for transient failures, bounded concurrency and graceful shutdown (27)                                                                             |
| `tests/integration/milestone-scope.test.ts`             | M2 scope guard (71), no execution path (31–32, 69), adapters off the filesystem/sockets, only `safe-http` opens connections                                                                                                                                                                                                |

Test 72 (no external network) is enforced by the preloaded network guard for every file; the
fixture network and loopback transport test never leave the machine. Test 75: all M0/M1 tests pass.

### Deliberate updates to M0/M1 tests

- `schemas.test.ts`, `lifecycle.test.ts`: `ANALYSIS_RUN_STATE_VALUES` now starts with `pending`.
- `migrations.test.ts`: the table list includes the six M2 tables.
- `event-context-guards.test.ts`: "no project columns in M1" became "Event Context tables have no
  project columns and no table has score columns".
- `event-context/routes.test.ts`: requests carry a (fake) organizer credential; apps are built
  with a fake verifier.
- `app.test.ts`: the env defaults include `AUTH_MODE` and `AUTH_JWT_ROLES_CLAIM`; new auth env
  test.
- `milestone-scope.test.ts`, `dependency-rules.test.ts`: advanced to M2 (new layers; github and
  devpost no longer placeholders; M3+ still guarded).

## Manual demo (compiled API and worker, PostgreSQL 16, dev auth, fixture network)

Run twice from a clean process start; both runs produced identical revisions and content hashes.

1. Unauthenticated and forged credentials → 401. Demo Hackathon Event Context (fixture E sources)
   built and locked as `dev-organizer`; `dev-judge` creating a version → 403.
2. Project "Synthetic Atlas" created with track `health` (validated against v1).
3. Sources declared: Devpost (normalized to `https://devpost.com/software/synthetic-atlas`),
   GitHub (`…/synthetic/moving.git` → `https://github.com/synthetic/moving`), deployment,
   YouTube (`youtu.be/…` → canonical watch URL).
4. `POST /projects/:id/captures` → 202, four pending snapshots; the worker produced four
   `captured` snapshots.
5. GitHub snapshot 1: revision `7b8a335a3124ac93d60dda99dc52b4489db2a0e9`, artifacts
   `commits.json`, `files/README.md` (`# Moving v1`), `files/src/app.py`, `omissions.json`,
   `repository.json`, `tree.json`.
6. Branch moved; a judge requested a re-capture (202): snapshot 2 at
   `57b651440322b954cfee7dd4eecdd263844203b0`; snapshot 1's full JSON byte-identical before/after.
7. PATCH/PUT/DELETE of snapshot 1 → `405 SNAPSHOT_IMMUTABLE`.
8. Direct SQL UPDATE/DELETE of snapshot 1, UPDATE of its artifacts and a late artifact INSERT were
   all rejected by triggers.
9. `https://gone.example.org/` → `captured`, `httpStatus: 404`.
10. `http://redirect.example.org/` → 302 to `169.254.169.254` → `rejected`, `ssrf_rejected`,
    metadata `{adapter, reason: address_not_public, host: 169.254.169.254, redirectCount: 1}`,
    0 artifacts; the metadata response was never fetched.
11. `synthetic/leaky` → files `README.md`, `src/server.ts` only; omissions
    `secret_prone_path: [.env, config/credentials.json, id_rsa]`, `ignored_directory: 1`; synthetic
    secret strings in the database: 0; the worker's `GITHUB_TOKEN` in database/worker log/API log:
    0/0/0.
12. Reloading every snapshot and artifact twice gave the same SHA-256 of the full dump; 0 artifact
    rows whose stored hash differs from SHA-256 of their text; audit actions recorded:
    `project_created`, `project_track_declared`, `project_source_added`,
    `source_capture_requested`, `source_snapshot_captured`, `source_snapshot_rejected`.
13. Web UI (Next.js production build, Playwright): project page lists sources, tracks and
    snapshots newest first; the snapshot page shows `files/README.md` as escaped text; no secret
    content is present.

The optional live adapter smoke test against real third-party services was not run: acceptance
does not depend on external network access.

## Verification commands (final run)

| Command                                         | Result                                  |
| ----------------------------------------------- | --------------------------------------- |
| `pnpm format:check`                             | all files formatted                     |
| `pnpm lint`                                     | 0 problems                              |
| `pnpm typecheck`                                | clean                                   |
| `pnpm db:check`                                 | "Everything's fine"                     |
| `pnpm db:generate`                              | "No schema changes, nothing to migrate" |
| `pnpm test`                                     | 40 files, 403 tests passed              |
| `TEST_DATABASE_URL=… pnpm test` (PostgreSQL 16) | 40 files, 481 tests passed              |
| `pnpm build`                                    | all packages and apps built             |
| `pnpm check`                                    | exit 0                                  |
| dev database migration (existing M1 data)       | applied 0004 and 0005 successfully      |

## Decisions and refinements

- **Authentication now covers M1 routes too** (organizer writes, judge reads), strengthening the
  M1 boundary. Without `AUTH_MODE` the API fails closed.
- **`pending` analysis-run state** added (suggested by the M2 brief) for queued capture work.
- **Rejected captures complete their run successfully**: the policy decision is completed work;
  only `failed` snapshots fail their run, with `timeout`, `internal_error` or `source_unavailable`.
- **Projects require a locked Event Context**, so track declarations always have a validation
  basis.
- **One capture at a time per source** (`CAPTURE_ALREADY_PENDING`) bounds queue growth.
- **GitHub content via blobs, not archives:** matches SECURITY.md (trees, blobs, commits), allows
  per-blob SHA-1 verification and avoids parsing untrusted archives; the cost is one request per
  file (bounded at 400).
- **Raw HTML is not persisted** for Devpost or deployments: normalized structured and text
  artifacts are stored instead.
- **HTML parser hardening:** `node-html-parser` is quadratic on unclosed tags by default; it now runs
  with `parseNoneClosedTags` and falls back to a linear text extractor on stack-exhausting nesting.

## Deferred to M3+

Claims, evidence items and relations, unknowns, contradictions (M3); scoring (M4); AI assessment,
model providers and prompts (M5); uncertainty and questions (M6); interview (M7); reassessment
(M8); final human score (M9). Also deferred: sandboxed browser inspection and screenshots,
per-event role assignment, web UI user login.

## Known limitations

- Roles are global (organizer/judge), not per event.
- The web UI has no per-user login: it forwards one server-side `JUDGE_API_TOKEN`, so it must stay
  on a trusted network until a login flow exists. The API itself is fully protected.
- Unauthenticated GitHub access is limited to 60 requests/hour; larger captures need
  `GITHUB_TOKEN` (read-only). Private repositories are out of scope.
- Devpost parsing depends on the public page's server-rendered structure; changes surface as
  `partial` (`sections_missing`), never as invented data.
- Deployment inspection does not run JavaScript, so client-rendered apps may show little text.
- Compressed (`content-encoding` other than `identity`) responses are refused rather than decoded.
- Allowed fetch ports are 80, 443, 8080 and 8443.
- Capture timing uses the worker's clock; captures are not scheduled automatically.

## Architecture drift check

M2 did **not** implement: `Claim`, `EvidenceItem`, `EvidenceRelation`, `Unknown`, `Contradiction`,
a scoring engine, AI assessment, an LLM provider, a prompt system, uncertainty scoring, question
generation, interview, reassessment or a final judging score. `packages/evidence`, `scoring`,
`uncertainty`, `questions`, `llm`, `prompts` and `browser` remain README-only (enforced by the scope
test); no model SDK or provider host appears anywhere; no migration creates claim, evidence,
score, question or assessment tables; no route exposes scoring, evidence or analysis.

The pipeline is unchanged: M2 produces immutable source snapshots and stops. Deterministic code
does all capture work (URL policy, limits, hashing, status, state transitions, authorization,
auditing); no model is involved. Layer rules hold: layer-3 adapters depend only on the layer-2
`capture` port, the worker composes them with `safe-http`, and the dependency test passes. All 25
invariants still hold; M2 additionally enforces invariants 3, 5, 7, 8, 14, 17, 21 and 23 for
source material (ARCHITECTURE.md §4 table).
