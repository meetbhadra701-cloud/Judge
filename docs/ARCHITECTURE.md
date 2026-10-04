# Judge Copilot — Architecture

> **Status:** Milestone 1 (Event Context Pack) on top of the M0 foundation. Everything after
> Event Context (ingestion, evidence, scoring, questions, interview, reassessment) is
> intentionally **not implemented yet**. This document specifies the target architecture so that every
> milestone builds toward it. It is binding on human and AI contributors.

---

## ⚠️ DO NOT SIMPLIFY THE ASSESSMENT PIPELINE

**DO NOT SIMPLIFY THE ASSESSMENT PIPELINE INTO:**

```
rubric + devpost + github + answers -> one LLM -> score
```

**The intended pipeline is:**

```
sources
-> immutable snapshots
-> atomic claims
-> evidence
-> contradictions / unknowns
-> dimension assessments
-> deterministic weighted scoring
-> uncertainty analysis
-> information-gain question selection
-> verified human answers
-> new evidence
-> affected-dimension-only reassessment
-> explainable deltas
-> human final judgment
```

Every stage exists for a reason (traceability, auditability, fairness, resistance to prompt
injection, honest uncertainty). Collapsing stages — even "temporarily", even "for a demo" — is
an architecture violation. If a milestone seems to require collapsing stages, **stop and raise
it** instead of shipping the shortcut.

---

## 1. System overview

Judge Copilot is a human-in-the-loop hackathon judging system. It has two phases.

### Before the hackathon — Event Context

```
official event rules
+ official judging rubric
+ prize/track requirements
+ sponsor requirements
+ judging format
+ event dates
+ allowed prior work
+ organizer guidance
        │
        ▼
human-reviewed, versioned, locked EVENT CONTEXT
```

An Event Context version is the official frame for every assessment of that event. It is
assembled (possibly with AI help, M1), reviewed by a human, and **locked**. A locked version is
frozen; changes create a new version that supersedes it. Official assessment is impossible
without a locked version (invariant 18).

### During judging — the assessment loop

```
Devpost + GitHub + live deployment + demo/video + entered prize tracks
        │
        ▼
immutable source snapshots                                  (deterministic capture)
        │
        ▼
atomic claims + evidence + contradictions + unknowns        (LLM extraction, validated)
        │
        ▼
dimension-level rubric assessment                           (LLM judgment against anchors, validated)
        │
        ▼
deterministic score engine                                  (code)
        │
        ▼
score + evidence coverage + confidence + uncertainty        (code)
        │
        ▼
"What could make this assessment wrong?"                    (code identifies, LLM phrases)
        │
        ▼
candidate questions → deterministic information-gain ranking → top five questions
        │
        ▼
judge asks the team, types answers, verifies things live    (human)
        │
        ▼
answers become new claims/evidence                          (LLM decomposition, validated)
        │
        ▼
ONLY affected dimensions are reassessed                     (code selects, LLM re-judges)
        │
        ▼
explainable pre → post score deltas                         (code)
        │
        ▼
HUMAN JUDGE enters the final score                          (authoritative)
```

The human judge's final score is authoritative. AI output is decision support.

---

## 2. Core artifact chain

| Artifact                                                 | Produced by                                   | Mutability                                                   |
| -------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `EventContextVersion`                                    | humans (+ extractor drafting via a port, M1)  | editable while `draft`/`in_review`; **frozen** once `locked` |
| `SourceSnapshot`                                         | ingestion (deterministic)                     | immutable once terminal                                      |
| `Claim`                                                  | LLM extraction / team answers                 | immutable; new versions supersede                            |
| `EvidenceItem`                                           | LLM extraction, judge observation             | immutable                                                    |
| `EvidenceRelation`                                       | LLM matching, validated                       | immutable                                                    |
| `Unknown`                                                | LLM + deterministic coverage analysis         | immutable per assessment version                             |
| `Contradiction`                                          | LLM detection, validated                      | immutable per assessment version                             |
| `AssessmentVersion` (`pre_interview` / `post_interview`) | pipeline                                      | immutable                                                    |
| `CriterionAssessment` / dimension assessments            | LLM judgment + deterministic aggregation      | immutable, part of an assessment version                     |
| `JudgeQuestion`                                          | LLM phrasing + deterministic ranking          | immutable once presented                                     |
| `TeamAnswer`                                             | judge types it                                | immutable                                                    |
| `ScoreChange`                                            | deterministic diff of two assessment versions | immutable                                                    |
| `JudgeFinalScore`                                        | human judge                                   | authoritative; AI can never write it                         |
| `AuditEvent`                                             | every state-changing action                   | append-only (DB-enforced)                                    |

Every assessment references the exact snapshot IDs and the exact locked Event Context version it
used (invariant 17). Re-running ingestion creates _new_ snapshots; it never rewrites old ones.

### Verification, kinds, origins (vocabularies implemented in `@judge-copilot/schemas`)

- **Verification levels:** `unverified`, `team_claim`, `repo_corroborated`, `machine_verified`,
  `judge_verified`, `live_verified`, `contradicted`.
- **Evidence kinds:** `fact`, `claim`, `absence`, `unknown`, `contradiction`.
- **Evidence origins:** `event_context`, `devpost`, `github`, `deployment`, `video`,
  `team_answer`, `judge_observation`.
- **Question modes:** `ask`, `clarify`, `show_me`, `demonstrate`, `verify`.
- **Unknown types:** `missing`, `ambiguous`, `contradictory`, `unverifiable`, `subjective`,
  `eligibility`.
- **Assessment kinds:** `pre_interview`, `post_interview`. The human final score is a separate
  record, not a third assessment kind.
- **Source snapshot status:** `pending`, `captured`, `partial`, `failed`, `rejected`.
- **Event Context status:** `draft`, `in_review`, `locked`, `superseded`.

---

## 3. Deterministic code vs. LLM responsibilities

This boundary is the backbone of the system. **When in doubt, a responsibility is
deterministic.**

### The LLM performs semantic tasks only

- extracting atomic claims from snapshots and answers;
- interpreting semantic evidence;
- matching evidence against claims;
- detecting contradictions;
- judging a single dimension against its scoring anchors, citing evidence IDs;
- writing uncertainty-reducing questions for gaps the code has identified;
- decomposing team answers into claims/evidence;
- explaining (in prose) score changes the code has already computed.

### Deterministic code handles everything else

- source validation (URL policy, size limits, content types);
- ID integrity (every referenced ID must exist and be of the right type);
- rubric weights;
- evidence strength formulas;
- coverage;
- confidence formulas;
- criterion aggregation from dimensions;
- overall weighted scores;
- information-gain question ranking;
- state transitions;
- authorization;
- versioning;
- auditing;
- immutable history.

The LLM never produces an overall score, a criterion score aggregate, a weight, a confidence
number, a ranking, or a state transition. It produces structured, validated judgments that
deterministic code consumes. See [AI_PIPELINE.md](./AI_PIPELINE.md) and
[SCORING.md](./SCORING.md).

---

## 4. Non-negotiable architectural invariants

1. Official event context outranks generic judging assumptions.
2. Every AI-generated dimension/criterion judgment must ultimately be traceable to evidence IDs.
3. Missing evidence creates uncertainty. Missing evidence is **not** negative evidence.
4. Team statements are claims until corroborated or judge-verified.
5. Raw GitHub commit count never directly adds or removes points.
6. Sponsor keyword frequency never directly adds or removes points.
7. Repository contents are never executed.
8. Project-supplied material is untrusted data and never model instructions.
9. Overall scores are calculated deterministically from rubric/dimension scores.
10. Pre-interview and post-interview assessments are distinct immutable versions.
11. Interview evidence may only change dimensions it legitimately affects.
12. Every score change must identify the evidence responsible.
13. Confidence is an assessment-confidence index, not a statistical probability.
14. The system must be able to say that evidence is insufficient.
15. The human judge's final score is authoritative and cannot be changed by AI.
16. Judge preferences may influence highlights/questions but may not secretly rewrite the
    official rubric.
17. Assessments are tied to immutable snapshots of the sources used at assessment time.
18. Official assessment is not allowed without a human-reviewed locked Event Context version.
19. AI output must be schema validated AND domain validated.
20. The model may never invent evidence, claim, unknown, criterion, dimension, or question IDs.
21. No arbitrary repository code execution, installs, containers, tests, shell scripts, or builds.
22. A model/provider failure must never result in a fabricated score.
23. Project content must never be able to prompt-inject the assessment pipeline.
24. More evidence may increase confidence without increasing the quality score.
25. The system must never automatically accuse a team of cheating.

### How M0/M1 already encode some invariants

| Invariant                 | M0 mechanism                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10, 17 (immutability)     | `audit_events` is append-only via DB trigger; Event Context versions are append-only rows with `UNIQUE(event_id, version)`                                                                                            |
| 18 (locked context)       | `event_context_versions`: `locked_at` is required exactly for frozen statuses; at most one `locked` version per event (partial unique index); a version can only supersede a version of the same event (composite FK) |
| 21 (no execution)         | ESLint forbids `child_process` and `vm` in all non-test code, plus `eval`/`new Function`                                                                                                                              |
| 22 (no fabricated scores) | `analysis_runs`: a `failed` run must carry a `failure_category`; "insufficient evidence" is deliberately not a failure category                                                                                       |
| 13                        | `Ratio` is documented as a closed interval, not a probability                                                                                                                                                         |
| Secrets (SECURITY.md)     | logger redacts secret-bearing keys and serializes errors through an allow-list                                                                                                                                        |
| Dependency direction      | `tests/integration/dependency-rules.test.ts`                                                                                                                                                                          |
| 1 (official context wins) | M1: explicit source-authority precedence; conflicts are resolved by authority in deterministic code, a human may only choose between tied top-authority positions, and losing positions are kept                      |
| 3, 14 (unclear ≠ guessed) | M1: every Event Context fact carries `certainty`; `unclear` facts need no source, may be locked, and are listed as unresolved; unweighted official rubrics stay unweighted                                            |
| 10, 17, 18 (frozen)       | M1: triggers freeze locked/superseded versions and their sources, tracks, rubrics, criteria and anchors; lock stores a SHA-256 content hash that later reads recompute (`integrity: verified`)                        |
| 19, 20 (validated output) | M1: extractor output is `unknown` → Zod (`EventContextExtraction`, which forbids IDs) → domain validation; code assigns all IDs; DB triggers reject provenance references to sources of another version               |
| 22 (no fabrication)       | M1: a failed build records a `failed` analysis run with a sanitized category and leaves the previous draft untouched                                                                                                  |

---

## 5. Monorepo layout

```
judge-copilot/
├── apps/
│   ├── web/        Next.js UI (M1: Event Context setup, review and lock views)
│   ├── api/        Fastify HTTP API (GET /health + M1 Event Context routes)
│   └── worker/     background pipeline runner (boots/stops, no jobs yet)
├── packages/
│   ├── shared/     env validation, structured logger, shutdown handling        [implemented]
│   ├── schemas/    foundational Zod schemas and vocabularies                   [implemented]
│   ├── domain/     domain types + lifecycle classifications                    [implemented]
│   ├── audit/      append-only audit event contract (AuditSink port)           [implemented]
│   ├── database/   Drizzle schema, migrations, persistence adapters            [implemented]
│   ├── context/    Event Context domain rules + extraction port                [implemented, M1]
│   ├── evidence/   claims, evidence graph, relations, contradictions, unknowns [M3, README only]
│   ├── scoring/    deterministic score engine                                  [M4, README only]
│   ├── uncertainty/ coverage, confidence, uncertainty analysis                 [M6, README only]
│   ├── questions/  question validation + information-gain ranking              [M6, README only]
│   ├── github/     read-only GitHub snapshot adapter                           [M2, README only]
│   ├── devpost/    Devpost snapshot adapter                                    [M2, README only]
│   ├── browser/    sandboxed deployment inspection adapter                     [M2+, README only]
│   ├── llm/        model/provider abstraction                                  [M5, README only]
│   └── prompts/    versioned prompt templates                                  [M5, README only]
├── tests/
│   ├── support/    test-only helpers (network guard)
│   ├── integration/ cross-package tests (dependency rules, process boot)
│   ├── fixtures/   [later milestones]
│   ├── e2e/        [Playwright, later milestones]
│   └── benchmark/  [later milestones]
└── docs/
```

Packages marked _README only_ are directories with a README describing their future
responsibility. They are not workspace packages until the milestone that implements them.

### Tooling

- TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM throughout.
- pnpm workspaces. `pnpm -r run <script>` runs in topological order; Turborepo was not added
  because it brings no benefit at this size and adds telemetry/caching configuration.
- Next.js (web), Fastify (api), plain Node.js (worker).
- PostgreSQL + Drizzle ORM + drizzle-kit migrations. PGlite (in-process PostgreSQL) for tests.
- Zod 4 for runtime validation; Vitest for tests; ESLint (typescript-eslint strict, type-checked)
  and Prettier. Playwright is reserved for later e2e work.

### Internal package resolution

Each package's `exports` has three conditions:

```json
"@judge-copilot/source": "./src/index.ts",
"types": "./dist/index.d.ts",
"default": "./dist/index.js"
```

- Typechecking (`customConditions` in `tsconfig.base.json`), Vitest and `tsx` dev runs resolve
  workspace packages to **source**, so no build is needed to test or typecheck.
- `tsconfig.build.json` clears `customConditions`, so builds compile against each dependency's
  emitted `dist` types, in topological order. Production (`node dist/main.js`) uses `default`.

---

## 6. Package dependency rules

These rules are **enforced** by `tests/integration/dependency-rules.test.ts`.

| Layer                     | Packages                                                              | May depend on                                    |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 0 — foundation            | `shared`, `schemas`                                                   | external libraries only                          |
| 1 — domain                | `domain`                                                              | layer 0                                          |
| 2 — deterministic core    | `audit`, `context`, `evidence`, `scoring`, `uncertainty`, `questions` | layers 0–1, and other layer-2 packages (acyclic) |
| 3 — adapters (I/O and AI) | `database`, `llm`, `prompts`, `github`, `devpost`, `browser`          | layers 0–2                                       |
| 4 — apps                  | `api`, `worker`, `web`                                                | layers 0–3                                       |

Rules:

1. Dependencies only point downward (except the acyclic layer-2 allowance).
2. Packages never depend on apps.
3. The workspace graph is acyclic.
4. A source file may import a workspace package only if its `package.json` declares it, only
   via the package root (no deep imports), and relative imports may not escape the package.
5. **Layer 2 is pure and deterministic:** no network, filesystem, database, environment access or
   model calls. Because `llm` and `prompts` are layer 3, the scoring, uncertainty and question
   ranking code _cannot_ import a model client. This is how the deterministic/LLM boundary is
   enforced structurally.
6. Adapters implement ports defined in lower layers (e.g. `database` implements the `AuditSink`
   port from `audit`). Apps compose adapters with core logic.

Current actual dependencies:

```
shared   → (none)
schemas  → (none)
domain   → schemas
audit    → schemas
context  → schemas
database → audit, domain, schemas
api      → audit, context, database, domain, schemas, shared
worker   → shared
web      → context, schemas
```

`apps/api` composes the Event Context workflow (`EventContextService`) from the database
adapter, the `context` domain rules, the `audit` port and an optional `EventContextExtractor`.
When a second consumer needs the workflow (for example the worker running model-backed builds
asynchronously), it moves into its own package rather than being duplicated.

Adding a new package requires assigning it a layer in the test and in this table.

---

## 7. Database

Migrations live in `packages/database/drizzle/` and are applied in order. Each milestone adds
its own migrations; existing migrations are never edited after being committed.

| Migration                            | Contents                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_m0_foundation`                 | `events`, `event_context_versions`, `analysis_runs`, `audit_events`                                                                                                                   |
| `0001_audit_events_append_only`      | trigger rejecting UPDATE/DELETE/TRUNCATE on `audit_events`                                                                                                                            |
| `0002_m1_event_context`              | `event_sources`, `tracks`, `rubrics`, `rubric_criteria`, `rubric_anchors`; `event_context_versions.content/extracted_content/locked_content_hash`; `analysis_runs.context_version_id` |
| `0003_m1_event_context_immutability` | freeze triggers for frozen versions and all their children; immutable source rows; same-version provenance triggers (JSONB and `source_ids` arrays)                                   |

- UUID primary keys (`gen_random_uuid()`), `timestamptz` timestamps.
- Vocabulary CHECK constraints are generated from the same tuples as the Zod schemas
  (`@judge-copilot/schemas`), so the database and validation cannot drift.
- `analysis_runs.project_id` is deliberately omitted until projects exist (M2).
- `audit_events.actor_id` has no foreign key until authentication exists.

---

## 8. Runtime processes

- **api** binds `API_HOST:API_PORT` (default `127.0.0.1:3001`), exposes `GET /health` →
  `{"status":"ok","service":"judge-copilot-api"}` (never touches the database) and the M1 Event
  Context routes (§9). Without `DATABASE_URL` it still boots; Event Context routes then answer
  `503 DATABASE_NOT_CONFIGURED`. It closes cleanly on SIGINT/SIGTERM.
- **worker** starts, logs `worker started` with `jobHandlers: 0`, and stops cleanly. It registers
  no jobs and contacts nothing (unchanged in M1).
- **web** renders the M1 Event Context setup/review/lock views using server components and
  server actions that call the API server-side (`JUDGE_API_URL`). No project, scoring or fake
  judging UI exists.

No process contacts an external service. The database pool connects lazily on first query.

---

## 9. Event Context Pack (M1)

```
create event → create draft version → add sources (authority, normalized text, SHA-256)
→ build (EventContextExtractor → Zod → domain validation → draft)   or author by hand
→ review: dates, judging format, rules, submission requirements, prior-work policy, guidance,
  tracks, rubrics, conflicts, unresolved items
→ human edit (provenance preserved)
→ lock (validated, hashed, supersedes the previous locked version atomically)
```

### Data model

- **Relational:** `event_sources` (provenance roots), `tracks`, `rubrics`, `rubric_criteria`,
  `rubric_anchors` (normalized rubric structure). Tracks, rubrics and criteria carry
  `source_ids`, `origin` and `human_modified`.
- **Typed JSONB** `event_context_versions.content` (`EventContextContent`): dates, judging format,
  rules, submission requirements (optionally per track), prior-work policy, organizer guidance and
  conflicts. Every fact has a server-assigned `id`, `statement`, `certainty`
  (`explicit | interpreted | unclear`), `sourceIds`, `origin` (`source_derived | human`) and
  `humanModified`.
- `extracted_content` keeps the last successful build output, so a source-derived fact and its
  human correction can always be compared.
- The API assembles both into one `EventContextDocument`.

### Lifecycle

`draft → locked → superseded`. `in_review` stays in the vocabulary but no M1 workflow uses it:
the explicit lock action is the human review gate (invariant 18). Locking:

1. serializes on the event row (`FOR UPDATE`);
2. requires `status = draft` and that the draft derives from the currently locked version (else
   `STALE_CONTEXT_BASE`);
3. runs `validateForLock`: structure, source references within the version, unique criterion
   keys, valid scales and anchors, and weights all-or-none summing to 1 ± `1e-6`;
4. supersedes the current locked version (status-only change, allowed by trigger), then locks
   this one with `locked_at` and `locked_content_hash`;
5. writes `event_context_locked` (and `context_version_superseded`) audit events.

A partial unique index guarantees at most one locked version per event. New versions copy the
locked version's sources (new rows with `copied_from_id`) and document (source IDs remapped), and
require a change reason.

### Rebuild safety (M1 hardening)

- **Human review is never silently replaced.** A build first checks `hasReviewedChanges`: a
  document exists with no extraction baseline, or it differs from the last extraction by canonical
  JSON comparison (not only by `humanModified` flags). In that case the build is refused with
  `409 HUMAN_EDITS_WOULD_BE_REPLACED` unless the request sets `"replaceHumanEdits": true`. That
  option defaults to false. An explicit replacement is recorded in the `event_context_built`
  audit metadata: `replacedHumanEdits`, `replacedDraftFingerprint` and `replacedHumanItemCount`.
  There is no automatic semantic merge.
- **Builds are optimistically guarded.** At build start the service fingerprints the source set
  (`sourceSetFingerprint` over id, position, authority, type, title, URL and content hash) and the
  draft state (`draftStateFingerprint`: canonical document plus extraction baseline). The
  extractor then runs with **no transaction open**. Before writing, the service locks the version
  row `FOR UPDATE`, re-checks that it is a draft, reloads the sources and draft, and recomputes
  both fingerprints. If either changed, the result is discarded with `409 CONTEXT_BUILD_STALE`,
  the run becomes `cancelled`, and an `event_context_build_cancelled` audit event records the
  reason (`stale_input`, plus which inputs changed). A version locked mid-build is cancelled the
  same way (`version_no_longer_draft`). Neither case is reported as a provider failure.

### Authority and conflicts

Source authority precedence is an explicit table (`SOURCE_AUTHORITY_PRECEDENCE`: 100, 95, 90, 85,
60, 40), never array order. Extractors report conflicting _positions_; deterministic code resolves
them. A unique highest-authority position prevails (`resolved_by_authority`). Tied top positions
stay `unresolved` unless a human chooses among them (`resolved_by_human` with a note). No
resolution ever deletes a position or a source.

### Provenance rules (enforced by `applyHumanEdit`)

- IDs and origins are server-controlled. New items are `human`.
- A source-derived item may be reworded (`humanModified: true`), but it may never drop a source it
  cites (`PROVENANCE_REMOVED`).
- A non-`unclear` source-derived fact must cite a source. To answer a previously unclear question,
  add the organizer's statement as a new source and cite it.
- Source-derived conflicts cannot be removed or lose positions.

### API

| Method    | Path                                           | Purpose                                                                                     |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET/POST  | `/events`                                      | list / create events                                                                        |
| GET       | `/events/:eventId`                             | event + version summaries                                                                   |
| POST      | `/events/:eventId/context-versions`            | create the next draft (derives from the locked version)                                     |
| GET/PATCH | `/events/:eventId/context-versions/:versionId` | detail (document, extraction, unresolved, lock readiness, integrity) / human edit           |
| GET/POST  | `…/:versionId/sources`                         | list / add sources                                                                          |
| POST      | `…/:versionId/build`                           | build through the configured extractor (`{ "replaceHumanEdits"?: boolean }`, default false) |
| POST      | `…/:versionId/lock`                            | lock                                                                                        |
| GET       | `/events/:eventId/context`                     | the currently locked `EventContextLockedSnapshot`                                           |

Errors are `{ "error": { "code", "message", "details?" } }` with stable codes (for example
`INVALID_RUBRIC_WEIGHTS` 422, `LOCKED_CONTEXT_IMMUTABLE` 409, `CONTEXT_VERSION_NOT_FOUND` 404,
`INVALID_REQUEST` 400). There is no authentication yet (see V1_CONTRACT.md).
