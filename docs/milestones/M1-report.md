# Milestone 1 — Event Context Pack: Report

**Status:** complete, acceptance gate passed. M2 has **not** been started.

Baseline: `main` = approved M0 commit `ad07353e32f96e4dcf0d3b996735755286008cfe`. Work branch:
`claude/m1-event-context`.

## Scope delivered

The Event Context workflow: event → draft version → sources (authority, normalized text,
SHA-256) → build through an extraction port, or author by hand → review → human edit with
preserved provenance → lock (validated, hashed, immutable) → new version → supersession.

### Database (migrations `0002_m1_event_context`, `0003_m1_event_context_immutability`)

- New tables: `event_sources`, `tracks`, `rubrics`, `rubric_criteria`, `rubric_anchors`.
- New columns:
  - `event_context_versions.content` (typed JSONB `EventContextContent`);
  - `event_context_versions.extracted_content` (last build output);
  - `event_context_versions.locked_content_hash`;
  - `analysis_runs.context_version_id`.
- Constraints:
  - vocabulary CHECKs generated from the Zod tuples;
  - source hash format and text and title limits, `url_text` requires a URL, `http(s)` only;
  - unique source positions;
  - track rubrics must use a track of the same version (composite FK);
  - one overall rubric per version and one rubric per track;
  - `scale_min < scale_max`, weight in (0, 1], unique criterion keys, unique anchor scores.
- Triggers:
  - locked/superseded versions are frozen; the only permitted change is the status transition
    locked → superseded with every other column unchanged;
  - draft identity is immutable;
  - sources, tracks, rubrics, criteria and anchors of frozen versions reject
    INSERT/UPDATE/DELETE;
  - source rows are always immutable;
  - every provenance reference (JSONB `sourceIds`, `sourceId`, `prevailingSourceIds` and the
    `source_ids` arrays) must point at sources of the same version.
- No M0 migration was edited. The journal only gained entries.

### Schemas (`@judge-copilot/schemas`)

- **Vocabularies:** `EventSourceType`, `EventSourceAuthority`, `SourceCertainty`, `RubricScope`,
  `FactOrigin`, `PriorWorkStance`, `ConflictResolutionStatus`.
- **Shapes:**
  - `EventSourceInput` / `Summary` / `Record`, and the input-side `ContextFactInput`,
    `DateFactInput`, `EventContextDocumentInput`;
  - `EventContextExtraction`, which forbids IDs and human resolutions;
  - the stored shapes `ContextFact`, `DateFact`, `StructuredEventRule`, `SubmissionRequirement`,
    `PriorWorkPolicy`, `OrganizerGuidance`, `TrackDefinition`, `RubricDefinition`,
    `RubricCriterionDefinition`, `RubricAnchorDefinition`, `ContextConflict`,
    `EventContextContent`, `EventContextDocument`;
  - the HTTP contract (`CreateEventRequest`, `ContextVersionDetail`,
    `EventContextLockedSnapshot`, `ApiErrorBody`, …).

### Domain (`@judge-copilot/context`, new layer-2 package)

- The explicit `SOURCE_AUTHORITY_PRECEDENCE` table (100, 95, 90, 85, 60, 40).
- `normalizeSourceText` and `sourceContentHash` (SHA-256), `canonicalJson`, `lockedContentHash`.
- `resolveConflict`: authority decides. Ties stay unresolved, a human may only choose among tied
  top-authority positions, and no position is ever removed.
- `documentFromExtraction`: code assigns IDs; every item is `source_derived`.
- `applyHumanEdit`: provenance preservation, `humanModified` flags and a change summary.
- `validateDocument` (storable) and `validateForLock`, with `RUBRIC_WEIGHT_SUM_TOLERANCE = 1e-6`
  and no weight normalization or invention.
- `listUnresolved` and `blankDocumentInput`.
- The `EventContextExtractor` port, whose output is `unknown`, plus `createReplayExtractor`,
  which replays recordings on exact source match only.
- Typed `EventContextError` codes.

### API (`apps/api`)

`EventContextService`, a transactional and audited application service:

- `GET/POST /events`
- `GET /events/:eventId`
- `POST /events/:eventId/context-versions`
- `GET/PATCH …/context-versions/:versionId`
- `GET/POST …/sources`
- `POST …/build`
- `POST …/lock`
- `GET /events/:eventId/context`

Requests are validated with Zod: UUID params and bodies return `400 INVALID_REQUEST` with issue
paths that never echo values. Domain errors map to stable codes (404/409/422/503). Unexpected
errors return a generic 500, and their details go only to the redacting logger. Without
`DATABASE_URL` the routes answer `503 DATABASE_NOT_CONFIGURED`. The extractor defaults to
`none`. `replay` is development-only and refused in production.

### Web (`apps/web`)

Server components and server actions; the browser never calls the API.

- **Event list and create.**
- **Event page:** versions with status badges, plus "Create draft version" or, once a version is
  locked, "Create new version" with a required change reason.
- **Version page:**
  - sources, with expandable escaped text, authority and rank, type, hash and length;
  - add pasted-text source, build, edit draft and lock (draft only);
  - lock-readiness issues and unresolved/unclear items;
  - the dates, judging format, prior-work stance, rules, submission requirements (per track),
    organizer guidance, conflicts (prevailing and overridden positions), tracks and rubrics
    (criteria, weights, anchors), each with certainty, origin, human-edited marker and cited
    sources.
- **Locked view:** **LOCKED**, version number, lock timestamp, content hash and integrity. Editing
  controls are removed; "Create new version" is the only path.
- **Edit page:** a JSON editor for the draft, with validation errors listed by code and path.

## Behaviour

- **Versioning.** v1 is created without a base. Later versions copy the locked version's sources
  (new rows with `copied_from_id` and the same hashes) and its document (source IDs remapped),
  and require a change reason. Locking v2 supersedes v1 in the same transaction, serialized on
  the event row. A partial unique index keeps at most one locked version per event. A draft not
  based on the current locked version fails with `STALE_CONTEXT_BASE`.
- **Reconstruction.** Lock stores `locked_content_hash`, a SHA-256 over the canonical document
  plus the sources' identities and hashes. Every later read recomputes it and reports
  `integrity: verified`.
- **Provenance.**
  - Facts, tracks, rubrics and criteria carry `sourceIds`, `origin` and `humanModified`.
  - Human rewording keeps every cited source; dropping one fails with `PROVENANCE_REMOVED`.
  - New items are `human` and may carry no source.
  - `extracted_content` keeps the original extraction.
  - A non-unclear source-derived fact must cite a source. To answer a previously unclear question,
    add the organizer's statement as a source and cite it.
- **Authority and conflicts.** Extractors report positions and code resolves them. In fixture C
  the official rule (100) prevails over the judge note (60), and the conflict and the judge-note
  source remain stored and visible after locking.
- **Audit.** Recorded actions: `event_created`, `context_version_created`, `event_source_added`
  (hash and length, never text), `event_context_built`, `event_context_build_failed`,
  `event_context_edited` (added/modified/removed IDs), `event_context_locked` (hash) and
  `context_version_superseded`. The actor is null because no authentication exists yet.
- **Analysis runs.** Each build is `run_type = event_context_build`. On failure the run records
  `provider_error`, `schema_validation_failed`, `domain_validation_failed` or `internal_error`,
  and the draft is unchanged.

## Tests

162 tests in 22 files. All run with no external network access, and 40 of them run again on
real PostgreSQL when `TEST_DATABASE_URL` is set (202 in total).

New M1 test files (91 tests):

| File                                                 | Tests | Covers                                                                                                                                                                |
| ---------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schemas/src/event-context.test.ts`         | 15    | vocabularies, URL/size/NUL rules, certainty consistency, extraction rejects IDs and human resolutions                                                                 |
| `packages/context/src/authority.test.ts`             | 2     | explicit precedence, order independent of array position                                                                                                              |
| `packages/context/src/hash.test.ts`                  | 5     | SHA-256 vector, determinism, normalization, canonical JSON                                                                                                            |
| `packages/context/src/conflicts.test.ts`             | 5     | official outranks judge note, ties unresolved, human tie-break only, no override                                                                                      |
| `packages/context/src/document.test.ts`              | 13    | ID assignment, conflicts kept, unknown sources, missing provenance, unclear preserved, duplicate keys, scales, provenance on edit, unknown fact IDs, manual authoring |
| `packages/context/src/validation.test.ts`            | 5     | weights sum and tolerance, no normalization, unweighted allowed, partial weights, content required                                                                    |
| `packages/context/src/replay-extractor.test.ts`      | 7     | all five fixtures replay schema-valid in any order; inexact sources refused                                                                                           |
| `packages/database/src/event-context-guards.test.ts` | 5     | immutable source rows, source constraints, locked → superseded only, JSONB cross-version refs rejected, no project/score columns                                      |
| `apps/api/src/event-context/service.test.ts`         | 23    | required tests 1–27 and the domain invariants (see below)                                                                                                             |
| `apps/api/src/event-context/routes.test.ts`          | 8     | full HTTP workflow with contract parsing, UUID/body validation, error mapping, 503 paths                                                                              |
| `tests/integration/milestone-scope.test.ts`          | 3     | M2+ packages still placeholders, no model SDK dependencies, no provider endpoints                                                                                     |

Required tests:

| #     | Test                                                | Where                                |
| ----- | --------------------------------------------------- | ------------------------------------ |
| 1–3   | event, v1, sources                                  | service                              |
| 4     | deterministic hash                                  | hash, service                        |
| 5     | authority vocabulary                                | schemas, authority                   |
| 6–8   | build, valid-only writes, failed build leaves draft | service                              |
| 9–10  | human edit and provenance                           | document, service                    |
| 11–14 | lock: weighted / malformed / unweighted / unclear   | service, validation                  |
| 15    | one locked version per event                        | service                              |
| 16–17 | locked immutability through the app and the DB      | service, routes, guards              |
| 18–20 | v2 derivation, atomic supersession, reconstruction  | service                              |
| 21    | cross-event references                              | service, guards, document            |
| 22    | duplicate criterion keys                            | document, service                    |
| 23    | invalid scale                                       | document, service                    |
| 24–27 | build/edit/lock/supersession audit events           | service                              |
| 28    | UUID and body validation                            | routes                               |
| 29    | no network                                          | the M0 guard is preloaded everywhere |
| 30    | no model invoked                                    | milestone-scope, replay-only         |
| 31    | M0 tests still pass                                 | —                                    |

Three M0 tests were updated because M1 deliberately tightened behaviour:

1. **Table list** (`migrations.test.ts`): the exact list now includes the five M1 tables.
2. **Self-supersession** (`migrations.test.ts`): it updated a frozen row, which the freeze
   trigger now rejects with 23001 before the CHECK constraint runs. The test now asserts that
   rejection and checks self-supersession through an INSERT, where the CHECK still applies.
3. **API env defaults** (`app.test.ts`): the defaults now include `EVENT_CONTEXT_EXTRACTOR:
'none'`. A new test covers the replay-extractor env rules.

## Manual demo (live, against real PostgreSQL 16, compiled API and web)

The M1 migrations were applied incrementally with `pnpm db:migrate` to a database that already
held M0 (4 migrations, 9 tables, 12 triggers). The API ran with the development replay
extractor.

1. Created "Demo Hackathon". 2. Created v1. 3. Added the official rules (authority 100).
2. Added the judge-context note (authority 60). 5. Built: prior-work policy `allowed`, cited to
   the rules. 6. The conflict was `resolved_by_authority` with the rules prevailing, and both
   positions were kept. 7. Edited the judging format: `humanModified: true`, rules source still
   cited, original extraction retained. 8. Locked v1 with integrity `verified`. 9. PATCH, add
   source and build returned `409 LOCKED_CONTEXT_IMMUTABLE`, and lock again returned
   `409 CONTEXT_NOT_DRAFT`. Direct SQL UPDATE/DELETE on v1 and its sources was rejected by
   triggers. 10. Creating v2 without a reason returned `422 CHANGE_REASON_REQUIRED`; with a
   reason, v2 got copied sources (new IDs, same hashes). 11. Added an organizer announcement
   source to v2 and set the judging start citing it. 12. Locked v2. 13. v1 was `superseded` and
   byte-identical to its lock-time response except for status; v2 was `locked`. 14. Reloaded both:
   integrity `verified`, and `GET /events/:id/context` returned v2.

The audit trail held the 12 expected actions. A headless-Chromium walkthrough of the UI covered:

- creating an event and a draft, adding three sources, building and seeing the rubric;
- a provenance-removing edit, rejected in the edit form;
- a valid edit, which showed the human-edited marker;
- locking, after which LOCKED, the version and timestamp appeared and the edit controls were
  removed.

## Verification commands (final run)

| Command                                                                | Result                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `rm -rf node_modules … && pnpm install --frozen-lockfile`              | pass                                           |
| `pnpm check` (format:check, lint, typecheck, db:check, test, build)    | exit 0                                         |
| `pnpm db:generate`                                                     | "No schema changes, nothing to migrate"        |
| `TEST_DATABASE_URL=…/judge_copilot_test pnpm test`                     | 22 files, 202 tests passed                     |
| `DATABASE_URL=…/judge_copilot_dev pnpm db:migrate` (on an M0 database) | applied                                        |
| secrets scan of all files to be committed                              | only the documented placeholders already in M0 |

## Decisions and refinements (documented in the architecture docs)

- **Hybrid storage.** Sources and rubric structure are relational. Policy facts are typed JSONB
  with server-assigned fact IDs. Provenance is enforced in the domain _and_ by DB triggers.
- `in_review` is unused; the lock action is the human review gate.
- **No authentication in M1** (the user's M1 brief; the contract wording was "expected M1"). The
  API binds to `127.0.0.1`, and V1_CONTRACT now requires authentication before any non-local
  deployment and no later than M2.
- **Model-backed extraction moved to ≥ M5.** M1 provides the port and the replay extractor only.
- **Fallback rubric data moved to M4.** M1 supports the `universal_fallback` authority.
- **Explicit source positions.** `event_sources.position` was added for deterministic order,
  because copied sources share a transaction timestamp.
- **Sequential real-Postgres runs.** With `TEST_DATABASE_URL` set, test files run sequentially
  because each one rebuilds the shared disposable database.

## Deferred to M2+

Projects and project source ingestion (M2), authentication and authorization (≤ M2), evidence
graph (M3), scoring engine and fallback-rubric data (M4), model-backed extraction via
`llm`/`prompts` (≥ M5), questions (M6), interview, reassessment and final score (M7–M9),
Playwright e2e in the repository, document parsing and URL fetching.

## Hardening (review of PR #1)

A follow-up commit on top of `01c4751` addressed two review findings.

1. **A rebuild can no longer silently erase human review.** `hasReviewedChanges` compares the
   reviewed document with the last extraction baseline by canonical JSON, and treats a document
   with no baseline (hand-authored, or a v2 copied from a locked version) as reviewed. Without
   `replaceHumanEdits: true`, such a build is refused with `409 HUMAN_EDITS_WOULD_BE_REPLACED`:
   no run is created and the draft is untouched. With confirmation the build proceeds, and
   `event_context_built` records `replacedHumanEdits: true`, `replacedDraftFingerprint` and
   `replacedHumanItemCount`. The UI shows a warning and replaces the normal Build button with a
   required checkbox and a "Rebuild and replace my reviewed draft" button.
2. **Builds are optimistically guarded against stale input.** Before the extractor runs, the build
   records `sourceSetFingerprint` and `draftStateFingerprint`; no transaction is open while the
   extractor runs. Before writing, it locks the version row and recomputes both. Any change
   (source added, human edit, another build) discards the result with `409 CONTEXT_BUILD_STALE`.
   The run becomes `cancelled`, and `event_context_build_cancelled` records
   `reason: stale_input` with the changed inputs. A version locked mid-build is cancelled with
   `reason: version_no_longer_draft`.

New tests (20):

- `packages/context/src/fingerprints.test.ts` (11): fingerprint determinism and sensitivity,
  reviewed-change detection, key-order independence.
- `service.test.ts` (8):
  - an untouched rebuild is allowed;
  - an edited draft is refused, with document and extraction bit-for-bit unchanged and no run
    created;
  - a copied v2 without a baseline is refused;
  - a confirmed replacement is audited;
  - an edit during extraction causes a stale cancel;
  - a source added during extraction causes a stale cancel;
  - of two overlapping builds, the second is cancelled as stale rather than winning silently;
  - a lock during extraction causes a cancel, and the locked hash is unchanged.
- `routes.test.ts` (1): 409 without confirmation, 400 for a non-boolean flag, 200 with
  confirmation.

The existing failed-build and locked-immutability tests are unchanged and still pass. The totals
are now 182 tests in 23 files, and 230 with PostgreSQL 16.

## Known limitations

- The edit UI is a JSON editor, not field-level forms.
- No authentication, so audit actors are null; M1 is local-only.
- With no extractor configured, drafts must be authored by hand. The replay extractor only
  matches its synthetic fixtures exactly.
- The UI walkthrough was run manually with a throwaway Playwright install, not as a committed
  test.
- An explicitly confirmed rebuild (`replaceHumanEdits: true`) replaces the reviewed draft. The
  replacement is audited (flag, fingerprint and count of human items), but the replaced document
  itself is not kept as a separate snapshot. There is no automatic merge of human edits.
- Scripts use POSIX env syntax; Windows users need WSL.

## Architecture drift check

M1 did **not** introduce project source ingestion, scoring, project evidence, question
generation, model calls, fake semantic extraction or scoring, or repository execution:

- No project table or column exists (asserted by test).
- The `scoring`, `evidence`, `questions`, `uncertainty`, `github`, `devpost`, `browser`, `llm` and
  `prompts` packages are still README-only (asserted by test).
- No model SDK or provider endpoint exists anywhere (asserted by test).
- The replay extractor does exact hash matching only.
- ESLint still forbids `child_process`/`vm`/`eval` outside tests.

The intended pipeline is intact. Every future assessment will reference one exact, frozen,
hash-verified Event Context version. Official authority outranks contextual guidance by explicit
precedence, and ambiguity stays `unclear`.
