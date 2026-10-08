# Judge Copilot — Architecture

> **Status:** Milestone 4 (deterministic scoring engine) on top of M0, M1 (Event Context Pack), M2
> (immutable project-source ingestion) and M3 (evidence graph). Everything after the scoring engine
> (model-backed extraction and assessment, uncertainty, questions, interview, reassessment) is
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

M3 persists the five graph artifacts (`Claim`, `EvidenceItem`, `EvidenceRelation`, `Unknown`,
`Contradiction`) and the rules around them (§12). Their producers arrive later: model-backed
extraction in M5, team answers in M7. M3 has no producer, only a validated write path.

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

| Invariant                  | M0 mechanism                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10, 17 (immutability)      | `audit_events` is append-only via DB trigger; Event Context versions are append-only rows with `UNIQUE(event_id, version)`                                                                                                                                        |
| 18 (locked context)        | `event_context_versions`: `locked_at` is required exactly for frozen statuses; at most one `locked` version per event (partial unique index); a version can only supersede a version of the same event (composite FK)                                             |
| 21 (no execution)          | ESLint forbids `child_process` and `vm` in all non-test code, plus `eval`/`new Function`                                                                                                                                                                          |
| 22 (no fabricated scores)  | `analysis_runs`: a `failed` run must carry a `failure_category`; "insufficient evidence" is deliberately not a failure category                                                                                                                                   |
| 13                         | `Ratio` is documented as a closed interval, not a probability                                                                                                                                                                                                     |
| Secrets (SECURITY.md)      | logger redacts secret-bearing keys and serializes errors through an allow-list                                                                                                                                                                                    |
| Dependency direction       | `tests/integration/dependency-rules.test.ts`                                                                                                                                                                                                                      |
| 1 (official context wins)  | M1: explicit source-authority precedence; conflicts are resolved by authority in deterministic code, a human may only choose between tied top-authority positions, and losing positions are kept                                                                  |
| 3, 14 (unclear ≠ guessed)  | M1: every Event Context fact carries `certainty`; `unclear` facts need no source, may be locked, and are listed as unresolved; unweighted official rubrics stay unweighted                                                                                        |
| 10, 17, 18 (frozen)        | M1: triggers freeze locked/superseded versions and their sources, tracks, rubrics, criteria and anchors; lock stores a SHA-256 content hash that later reads recompute (`integrity: verified`)                                                                    |
| 19, 20 (validated output)  | M1: extractor output is `unknown` → Zod (`EventContextExtraction`, which forbids IDs) → domain validation; code assigns all IDs; DB triggers reject provenance references to sources of another version                                                           |
| 22 (no fabrication)        | M1: a failed build records a `failed` analysis run with a sanitized category and leaves the previous draft untouched                                                                                                                                              |
| 7, 21 (no execution)       | M2: repositories are read through GET-only GitHub REST calls as data; no clone, git, install, build or import; a source scan test forbids process/VM/worker/dynamic-import code paths                                                                             |
| 17 (immutable snapshots)   | M2: `source_snapshots` go `pending` → terminal exactly once (trigger); terminal rows, their artifacts and declared sources can never change or be deleted; GitHub snapshots pin an exact commit SHA                                                               |
| 3, 14 (missing ≠ negative) | M2: refused URLs are `rejected` (an unknown), network problems `failed`, limits `partial` with explicit reasons; deployment HTTP 404/500 are observations                                                                                                         |
| 5 (commit counts)          | M2: commit, file, star and LOC counts are stored as data only; nothing reads them as a score                                                                                                                                                                      |
| 8, 23 (untrusted content)  | M2: captured text is stored verbatim as bounded data, never logged, never rendered as HTML, never sent to a model                                                                                                                                                 |
| 2, 19, 20 (ID integrity)   | M3: producers name new entities with batch-local refs; trusted code assigns every UUID; references to existing entities are resolved against the authoritative set and classified (nonexistent / wrong type / other project)                                      |
| 3 (missing ≠ negative)     | M3: `absence` and `unknown` evidence can neither support nor contradict a claim nor be a contradiction side (domain rule and trigger); Unknowns carry no score                                                                                                    |
| 4 (team statements)        | M3: Devpost/video prose and README-like text cap at `team_claim`; a relation never changes a claim's level; `repo_corroborated` needs source-code anchors and supporting evidence; producers cannot reach `machine_verified`, `judge_verified` or `live_verified` |
| 17 (exact snapshots)       | M3: evidence cites an exact captured/partial snapshot of its own project, an artifact of that snapshot and a verified code-point span; no "latest" pointer exists                                                                                                 |
| 25 (no accusations)        | M3: a Contradiction is two structural sides plus a neutral note, with no accusation, penalty or score field; creating one changes nothing                                                                                                                         |
| 8, 23 (untrusted content)  | M3: evidence text is stored and returned as inert data (tests with prompt-injection, script and tool-call text); there is no model and nothing is executed                                                                                                        |
| 1, 16 (official rubric)    | M4: an official overall rubric is used whole or not at all; the fallback applies only when none exists; invalid official weights are rejected, never repaired; no official/fallback mixing                                                                        |
| 3, 14 (missing ≠ negative) | M4: insufficient evidence is a state with no numeric field; excluded units are never zero-filled; a score with no usable citation is not used                                                                                                                     |
| 4, 20 (no invented trust)  | M4: trust is re-derived from structure; privileged labels resolve to `unverified`; trusted attestations are internal and empty; a trusted context cannot be built from model output                                                                               |
| 5, 6 (no raw signals)      | M4: no function accepts commit counts, LOC, stars, keywords, dependency counts or AI-tool use                                                                                                                                                                     |
| 9, 13, 24 (determinism)    | M4: byte-identical reports and hashes; confidence is an index independent of the score; more evidence can raise confidence without changing a score                                                                                                               |
| 22 (no fabricated score)   | M4: nothing is scored on any validation issue; a model failure produces no judgments and so no number                                                                                                                                                             |
| 25 (no accusations)        | M4: contradictions and label diagnostics are neutral data; a contradiction lowers confidence, never a score                                                                                                                                                       |

---

## 5. Monorepo layout

```
judge-copilot/
├── apps/
│   ├── web/        Next.js UI (M1 Event Context views, M2 project/snapshot views, M3 read-only evidence view)
│   ├── api/        Fastify HTTP API (GET /health, M1 Event Context, M2 projects/sources/snapshots, M3 read-only evidence graph)
│   └── worker/     background runner (M2: project-source capture jobs)
├── packages/
│   ├── shared/     env validation, structured logger, shutdown handling        [implemented]
│   ├── schemas/    foundational Zod schemas and vocabularies                   [implemented]
│   ├── domain/     domain types + lifecycle classifications                    [implemented]
│   ├── audit/      append-only audit event contract (AuditSink port)           [implemented]
│   ├── database/   Drizzle schema, migrations, persistence adapters            [implemented]
│   ├── context/    Event Context domain rules + extraction port                [implemented, M1]
│   ├── capture/    capture ports, URL/path rules, hashing, HTML extraction     [implemented, M2]
│   ├── evidence/   evidence graph rules, ID integrity, graph queries           [implemented, M3]
│   ├── scoring/    deterministic score engine (scoring-engine/v1)              [implemented, M4]
│   ├── uncertainty/ coverage, confidence, uncertainty analysis                 [M6, README only]
│   ├── questions/  question validation + information-gain ranking              [M6, README only]
│   ├── safe-http/  SSRF-safe HTTP client (DNS pinning, redirect policy)        [implemented, M2]
│   ├── github/     read-only GitHub snapshot adapter                           [implemented, M2]
│   ├── devpost/    Devpost snapshot adapter                                    [implemented, M2]
│   ├── deployment/ deployment HTTP observation adapter                         [implemented, M2]
│   ├── video/      video metadata adapter                                      [implemented, M2]
│   ├── auth/       AuthVerifier adapters (JWT/JWKS, dev-only)                  [implemented, M2]
│   ├── browser/    sandboxed headless-browser inspection                       [deferred, README only]
│   ├── llm/        model/provider abstraction                                  [M5, README only]
│   └── prompts/    versioned prompt templates                                  [M5, README only]
├── tests/
│   ├── support/    test-only helpers (network guard)
│   ├── integration/ cross-package tests (dependency rules, process boot)
│   ├── fixtures/   Event Context recordings (M1), source-capture worlds A–I (M2)
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

| Layer                     | Packages                                                                                                 | May depend on                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 0 — foundation            | `shared`, `schemas`                                                                                      | external libraries only                          |
| 1 — domain                | `domain`                                                                                                 | layer 0                                          |
| 2 — deterministic core    | `audit`, `context`, `capture`, `evidence`, `scoring`, `uncertainty`, `questions`                         | layers 0–1, and other layer-2 packages (acyclic) |
| 3 — adapters (I/O and AI) | `database`, `auth`, `safe-http`, `github`, `devpost`, `deployment`, `video`, `browser`, `llm`, `prompts` | layers 0–2                                       |
| 4 — apps                  | `api`, `worker`, `web`                                                                                   | layers 0–3                                       |

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
shared     → (none)
schemas    → (none)
domain     → schemas
audit      → schemas
context    → schemas
capture    → domain, schemas
evidence   → domain, schemas
scoring    → context, evidence, schemas
database   → audit, domain, evidence, schemas
auth       → domain, schemas
safe-http  → capture, schemas
github     → capture, schemas
devpost    → capture, schemas
deployment → capture, schemas
video      → capture, schemas
api        → audit, auth, capture, context, database, domain, evidence, schemas, shared
worker     → audit, capture, database, deployment, devpost, domain, github, safe-http, schemas, shared, video
web        → context, schemas
```

The capture adapters cannot depend on `safe-http` (both are layer 3). They depend only on the
`HttpFetcher` port in `capture` (layer 2); the worker composes them with the SSRF-safe client, so
no adapter can open a connection that bypasses the policy.

`apps/api` composes the Event Context workflow (`EventContextService`) from the database
adapter, the `context` domain rules, the `audit` port and an optional `EventContextExtractor`.
When a second consumer needs the workflow (for example the worker running model-backed builds
asynchronously), it moves into its own package rather than being duplicated.

Adding a new package requires assigning it a layer in the test and in this table.

---

## 7. Database

Migrations live in `packages/database/drizzle/` and are applied in order. Each milestone adds
its own migrations; existing migrations are never edited after being committed.

| Migration                                     | Contents                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_m0_foundation`                          | `events`, `event_context_versions`, `analysis_runs`, `audit_events`                                                                                                                                                 |
| `0001_audit_events_append_only`               | trigger rejecting UPDATE/DELETE/TRUNCATE on `audit_events`                                                                                                                                                          |
| `0002_m1_event_context`                       | `event_sources`, `tracks`, `rubrics`, `rubric_criteria`, `rubric_anchors`; `event_context_versions.content/extracted_content/locked_content_hash`; `analysis_runs.context_version_id`                               |
| `0003_m1_event_context_immutability`          | freeze triggers for frozen versions and all their children; immutable source rows; same-version provenance triggers (JSONB and `source_ids` arrays)                                                                 |
| `0004_m2_source_ingestion`                    | `actors`, `projects`, `project_track_selections`, `project_sources`, `source_snapshots`, `source_snapshot_artifacts`; `analysis_runs` `pending` state, project/snapshot links and lease; `audit_events.actor_id` FK |
| `0005_m2_source_ingestion_immutability`       | identity/immutability triggers for actors, projects, track selections, sources, snapshots and artifacts; capture-number sequencing; no TRUNCATE; terminal analysis runs frozen                                      |
| `0006_m2_partial_reason_html_structure_limit` | adds `html_structure_limit` to the `source_snapshots` partial-reason CHECK (the vocabulary is generated from the shared tuple)                                                                                      |
| `0007_m3_evidence_graph`                      | `claims`, `evidence_items`, `evidence_relations`, `unknowns`, `contradictions`; the composite-key target `source_snapshot_artifacts(id, snapshot_id)`                                                               |
| `0008_m3_evidence_graph_integrity`            | append-only triggers (UPDATE/DELETE/TRUNCATE), supersession verification guard, evidence provenance guard, relation/contradiction kind guards, unknown reference guard                                              |
| `0009_m3_supersession_guard_hardening`        | redefines `claims_supersession_guard`: a predecessor that is not already visible is rejected (no forward references) instead of deferring to the end-of-statement foreign key                                       |

- UUID primary keys (`gen_random_uuid()`), `timestamptz` timestamps.
- Vocabulary CHECK constraints are generated from the same tuples as the Zod schemas
  (`@judge-copilot/schemas`), so the database and validation cannot drift.
- `analysis_runs.project_id` and `source_snapshot_id` link capture runs (M2).
- `audit_events.actor_id` references `actors` (M2); it is null for system actions (the worker).

---

## 8. Runtime processes

- **api** binds `API_HOST:API_PORT` (default `127.0.0.1:3001`), exposes `GET /health` →
  `{"status":"ok","service":"judge-copilot-api"}` (never touches the database) and the M1 Event
  Context routes (§9). Without `DATABASE_URL` it still boots; Event Context routes then answer
  `503 DATABASE_NOT_CONFIGURED`. It closes cleanly on SIGINT/SIGTERM.
- **worker** without `DATABASE_URL` idles with `jobHandlers: 0` and contacts nothing. With a
  database it runs the project-source capture loop (§10) with bounded concurrency and stops
  cleanly on SIGINT/SIGTERM.
- **web** renders the M1 Event Context views and the M2 project, source and snapshot views using
  server components and server actions that call the API server-side (`JUDGE_API_URL`,
  `JUDGE_API_TOKEN`). It binds **127.0.0.1** explicitly (its scripts pass `--hostname 127.0.0.1`): it
  has no per-user login, so exposing it beyond the local machine is unsupported (SECURITY §10).
  M3 adds a read-only evidence view per project. No scoring or fake judging UI exists.

Only the worker contacts external services, and only through `safe-http` (source capture) or, for
JWT verification, the configured identity provider's JWKS (API). The database pool connects lazily.

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
`INVALID_REQUEST` 400). Since M2 every route except `/health` requires authentication (§11).

---

## 10. Immutable project-source ingestion (M2)

```
locked Event Context → project (+ declared tracks) → declared sources
→ capture request (202: pending snapshot + pending run) → worker claims (SKIP LOCKED, lease)
→ adapter capture through SafeHttpClient, no transaction open → validate result
→ one transaction: artifacts + terminal snapshot + terminal run + audit
```

### Data model

- **`projects`** — belongs to exactly one event for life (trigger); name, team name, creator.
  Creating one requires a locked Event Context and never starts an assessment. No score,
  evidence or summary columns.
- **`project_track_selections`** — declared tracks, validated against the event's _locked_
  context at declaration time (trigger + composite FKs to the same event, version and track). Each
  row keeps the context version it was validated against; a later version never rewrites it.
  Immutable.
- **`project_sources`** — immutable declarations (`devpost`, `github`, `deployment`, `video`) with
  a canonical URL (`normalizeDeclaredSourceUrl`); identical declarations are rejected; a
  replacement URL is a new declaration.
- **`source_snapshots`** — one capture of one declaration: `capture_number` (gapless, monotonic per
  source, trigger), source type and URL (composite FK to the declaration), status, `revision`
  (exact commit SHA, required exactly for GitHub content snapshots), normalized `metadata`,
  aggregate `content_hash`, `partial_reasons`, sanitized `failure_category` and allow-listed
  `failure_metadata` (DB checks the keys), request/capture/completion times.
- **`source_snapshot_artifacts`** — bounded UTF-8 text (≤ 4 MiB each, ≤ 1,000 per snapshot) with
  key, kind, media type, metadata, byte length and SHA-256; the database recomputes length and
  hash from the stored text. Insertable only while the parent is pending.
- **`analysis_runs`** — `run_type = project_source_capture`, one per snapshot:
  `pending → running → succeeded | failed | cancelled`, with a lease (`lease_token`,
  `lease_expires_at`) and `attempt_count`. Terminal runs are frozen (trigger).

### Immutability

A snapshot is inserted `pending` and may transition exactly once to `captured`, `partial`,
`failed` or `rejected`; identity columns never change; terminal rows, their artifacts and all
declarations reject UPDATE/DELETE/TRUNCATE in PostgreSQL itself. Re-capturing always creates a new
snapshot. The API has no mutation route for snapshots or sources (PUT/PATCH/DELETE answer 405).

### Status semantics

| Outcome                              | Status                | Example                                                                                                                                                                                           |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| content captured within limits       | `captured`            | repository at an exact SHA; deployment answering 404                                                                                                                                              |
| content captured, a limit or gap hit | `partial` + reasons   | tree/commit/file/total caps, truncated body, missing Devpost sections, generic video metadata                                                                                                     |
| fetching attempted, did not succeed  | `failed` + category   | `dns_failure`, `timeout`, `tls_failure`, `connection_failure`, `rate_limited`, `not_found`, `http_api_error`, `response_too_large`, `unsupported_content_type`, `parse_failure`, `internal_error` |
| refused by policy                    | `rejected` + category | `invalid_url`, `unsupported_source`, `ssrf_rejected`, `too_many_redirects`                                                                                                                        |

`rejected` is an unknown for later stages, never negative evidence. Capture runs for `captured`,
`partial` and `rejected` snapshots succeed (the policy decision is completed work); `failed`
snapshots fail their run with `timeout`, `internal_error` or `source_unavailable` (provider
categories are never used for policy rejections).

### Hashes

Each artifact has its own SHA-256. `snapshotContentHash` (`snapshot-content/v1`) hashes source
type, source URL, revision, normalized metadata, partial reasons and the sorted artifact keys with
their hashes, media types, lengths and metadata — never timestamps or IDs. Identical content
captured twice yields two snapshots with the same content hash.

### Worker

PostgreSQL-backed queue: claim = `SELECT … FOR UPDATE SKIP LOCKED` on pending capture runs plus a
fresh lease token, committed before the adapter runs. Finalize re-locks run and snapshot and
discards the result if the lease token changed or the snapshot is no longer pending, so two
workers can never both finalize one snapshot. Bounded concurrency (`CAPTURE_CONCURRENCY`, default
3, max 8); a transient network failure is retried once inside the run; if persisting a result fails,
only ids and a SQLSTATE are logged and a sanitized `finalization_failed` outcome is recorded in a
second transaction (SECURITY §13); expired leases are failed
(`internal_error`, `worker_lease_expired`); on shutdown in-flight captures get a grace period, then
are aborted (snapshot `failed` with `worker_shutdown`, run `cancelled`). One failed capture never
stops the loop.

### Adapters (all GET-only, all through the `HttpFetcher` port)

| Adapter    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub     | repository metadata (public repositories only: anything not clearly public is `rejected` / `unsupported_source` before any further request) → default branch → exact SHA (single ref lookup) → commit, recursive tree, history (`commits?sha=`), blobs by object id, each blob verified against its Git SHA-1. Secret-prone paths never fetched; omissions recorded. Limits: 20,000 tree entries (entries inside ignored directories such as `node_modules` do not count), a 3 MiB byte budget for the entries listed in `tree.json` (the longest path-ordered prefix that fits; the rest is `partial` / `tree_entry_limit`, never a failed snapshot), 250 commits, 256 KiB per file, 8 MiB total text, 400 files, 120 s. |
| Devpost    | one public project page, parsed deterministically; missing sections stay null; structure gaps → `partial`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Deployment | one GET; status, final URL, redirects, allow-listed headers, page metadata, bounded visible text; HTTP errors are observations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Video      | YouTube/Vimeo/Loom via fixed oEmbed endpoints; other URLs as page metadata (`partial`); never media.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 11. Authentication and authorization (M2)

`AuthVerifier` is a port in `domain`; `auth` implements a provider-neutral JWT/JWKS verifier
(`jose`; issuer, audience, expiry, asymmetric algorithms only) and an explicit development
verifier (`dev-organizer`, `dev-judge`) that is refused in production and whenever `API_HOST` is not
loopback. The API (`AUTH_MODE` =
`none` | `jwt` | `dev`, default `none` = fail closed with 503) requires a bearer credential on every
route except `/health`, records the verified `(issuer, subject)` as an `actors` row, and audits
writes with that actor. Production with a database requires `AUTH_MODE=jwt`.

| Permission                                | organizer | judge |
| ----------------------------------------- | --------- | ----- |
| `event_context.read`, `project.read`      | ✓         | ✓     |
| `event_context.write`, `project.write`    | ✓         | —     |
| `source.capture` (request a new snapshot) | ✓         | ✓     |
| `evidence.read` (M3 evidence graph)       | ✓         | ✓     |

### M2 API

| Method   | Path                                                               | Purpose                                             |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| GET      | `/me`                                                              | the authenticated actor                             |
| GET/POST | `/events/:eventId/projects`                                        | list / create (with `trackKeys`)                    |
| GET      | `/projects/:projectId`                                             | project, tracks, sources with latest snapshot       |
| GET/POST | `/projects/:projectId/sources`                                     | list / declare                                      |
| POST     | `/projects/:projectId/sources/:sourceId/captures`                  | 202: new pending snapshot + run                     |
| POST     | `/projects/:projectId/captures`                                    | 202: capture every source without a pending capture |
| GET      | `/projects/:projectId/snapshots`                                   | newest first                                        |
| GET      | `/projects/:projectId/snapshots/:snapshotId`                       | detail, artifacts (no text), run                    |
| GET      | `/projects/:projectId/snapshots/:snapshotId/artifacts/:artifactId` | one artifact's text                                 |

---

## 12. Evidence graph (M3)

```
immutable snapshots → [producer: fixture today, model-backed extractor in M5]
→ validated batch (batch-local refs, no IDs) → trusted planner (IDs, ID integrity, provenance,
  verification rules) → one transaction: Claim / EvidenceItem / EvidenceRelation / Unknown /
  Contradiction + audit event → read-only graph queries
```

M3 is the deterministic substrate later milestones consume. It has **no semantic extractor**:
claims are never derived from source text by code, and the content in tests and the demo is
explicit fixture data. It contains no scoring, weight, strength, coverage, confidence, ranking,
question or model code. No new root or version entity was introduced: the five artifacts named in
§2 are the whole model.

### Persisted entities

| Table                | Entity             | Key columns and rules                                                                                                                                                                                                                               |
| -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claims`             | `Claim`            | `project_id`, normalized single-line `text` (≤ 1,000), `verification_level`, `supersedes_id`, creator, `created_at`. Composite FK `(supersedes_id, project_id)` → same project only; `UNIQUE(supersedes_id)` → one successor; `supersedes_id <> id` |
| `evidence_items`     | `EvidenceItem`     | `project_id`, `event_id`, `kind`, `origin`, `verification_level`, `text` (≤ 2,000), provenance (below)                                                                                                                                              |
| `evidence_relations` | `EvidenceRelation` | `claim_id`, `evidence_id`, `relation_type` (`supports` \| `contradicts`); composite FKs to the same project; `UNIQUE(claim_id, evidence_id)`                                                                                                        |
| `unknowns`           | `Unknown`          | `unknown_type` (existing vocabulary), `text` (≤ 1,000), `claim_ids[]`, `evidence_ids[]` (≤ 50 each, validated by trigger)                                                                                                                           |
| `contradictions`     | `Contradiction`    | exactly two sides, each a claim or an evidence item (four composite FKs to the same project), generated `side_a_key` / `side_b_key`, neutral `description` (≤ 1,000)                                                                                |

Every table also has `id` (UUID), `seq` (a database-generated identity value: the persisted
insertion/allocation order, used as the deterministic, locale-independent ordering key of all
queries; it is not content-derived, and values are allocated at insert time, not at commit),
`created_by_actor_id` (null for system writers) and `created_at`. There is no score,
weight, strength, confidence, coverage, rank, penalty or accusation column anywhere. Claims
contain no dimension or rubric field. Relation vocabulary: `supports`, `contradicts` (the smallest
set the documents require; the existing vocabularies of §2 are unchanged).

### Immutability

All five tables are append-only in PostgreSQL itself: triggers reject UPDATE, DELETE and TRUNCATE
(also by `CASCADE`). A corrected claim is a **new** claim that supersedes the old one; the old row
is never touched and stays queryable. Supersession is single-successor (a unique constraint),
same-project (a composite foreign key) and never self (CHECK). **No forward references:** a new
immutable claim may only reference a predecessor that already exists and is visible to the
`claims_supersession_guard` trigger (migration `0009` closed a fail-open in `0008` that let one
multi-row statement list a successor before its predecessor, or reference rows inserted later in
the same statement, and so form a cycle or skip the verification-transition check). Cycles are
impossible because of the combination: every edge points at a row that existed before the
referencing row, that row is never updated (so an edge can never be rewired), and a claim has at
most one successor. Within one `INSERT ... VALUES` a predecessor-first chain is accepted, and a
successor-first chain is rejected. Siblings of one data-modifying CTE are not guaranteed to see each
other's rows (it depends on an execution order PostgreSQL does not define), so nothing may rely on
it; the invariant is only that the predecessor must already be visible to the trigger. The store
inserts claims one statement at a time and never relies on same-statement visibility. A race for the
same predecessor is won by exactly one writer (`CLAIM_ALREADY_SUPERSEDED` for the other).

### Provenance

| Origin                                     | Structural provenance                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devpost`, `github`, `deployment`, `video` | `snapshot_id` → an **exact** M2 snapshot of the same project, `captured` or `partial`, of the matching source type; optionally `artifact_id` (must belong to **that** snapshot) and a span |
| `event_context`                            | `context_version_id` → a `locked` or `superseded` version of the project's own event (version-level provenance: M1 facts have no stable per-item ID; documented limitation)                |
| `team_answer`, `judge_observation`         | vocabulary only; refused until M7 supplies the records they would point at (CHECK + domain rule)                                                                                           |

A **span** is `[span_start, span_end)` in **Unicode code points** of the artifact's stored text
(not UTF-16 units, not bytes; PostgreSQL's `substr`/`char_length` use the same unit). The stored
`excerpt` is the span's exact text; the planner derives it from the artifact (a producer may also
supply one, which must match exactly) and a trigger re-verifies it against the persisted text.
Spans are at most 2,000 code points, and a span needs an artifact, which needs a snapshot. An
excerpt is a convenience copy, never an independent source of truth. A recapture is a different
snapshot: evidence keeps pointing at the snapshot it names.

### Verification rules (`packages/evidence/src/verification.ts`)

Team statement ≠ verified fact. Capturing text proves the text existed, not that it is true.

- **Ladder** (SCORING.md §8): `unverified` < `team_claim` < `repo_corroborated` = `machine_verified` <
  `judge_verified` = `live_verified`; `contradicted` is off the ladder.
- **Evidence levels** are fixed at creation and restricted per origin and kind (full matrix in
  the source and its tests): project-authored prose (Devpost, video, README-like text) tops out at
  `team_claim`; only GitHub facts can be `repo_corroborated` (and, in the rule tables kept for the
  future, `machine_verified`, which GitHub and deployment facts could carry); `absence`/`unknown` are
  `unverified`; `contradicted` never applies to an evidence item.
- **What a span proves.** An evidence span proves **provenance**: that the quoted text exists at
  that place in an immutable snapshot. It does **not** prove that the evidence item's semantic `text`
  or any claim is true. M3 has no trusted code that establishes that equivalence, so a span never
  verifies anything by itself.
- **`machine_verified` is unreachable for producers in M3.** The level means "established by
  trusted deterministic machine observation". A producer (a fixture today, a model in M5) must not
  grant it by choosing the enum value, so `EvidenceGraphStore.createGraph` / the planner refuse
  `machine_verified`, `judge_verified` and `live_verified` on both evidence items and claims
  (`VERIFICATION_NOT_AVAILABLE`), whatever evidence the batch also contains. The vocabulary, the
  origin/kind/level matrix, the claim-justification rules and the 49-pair transition matrix are
  unchanged and kept for the trusted path a later milestone adds when a deterministic observation
  producer exists. Reachable producer levels in M3 (`M3_PRODUCER_VERIFICATION_LEVELS`):
  `unverified`, `team_claim`, `repo_corroborated` and (for claims, with a Contradiction)
  `contradicted`. The validator for stored graphs (`validateGraphIntegrity`) does not apply this
  producer gate, so a graph written by that future path still validates.
- **`repo_corroborated` needs source code, not prose.** It needs an artifact anchor, and the
  artifact must classify as repository source (`classifyRepositoryArtifact`, using only the M2
  artifact key, kind and media type): kind `file`, key `files/<path>`, a programming-language
  extension, and not documentation. README\*, `*.md`, `*.mdx`, `*.rst`, `*.txt`, `*.adoc`, HTML,
  CHANGELOG/CONTRIBUTING-style names and anything under `docs/`, `doc/`, `documentation/` or `wiki/`
  (even example code in them) are `team_prose`; metadata artifacts (`repository.json`,
  `commits.json`, `tree.json`, `omissions.json`), configuration, data and unrecognized files are
  `unclassified`. Only `source_code` may corroborate (`ARTIFACT_NOT_CORROBORATING` otherwise). A
  README is still team-authored prose, so README evidence stays at most `team_claim`. Limitation:
  classification is per file, so a span inside a source file may still quote a team-written comment.
- **`repo_corroborated` is producer-asserted and limited.** Trusted code verifies only that the
  cited artifact belongs to the right project's immutable GitHub snapshot, that it classifies as
  source code, and that a `supports` relation exists for a corroborated claim. The producer chooses
  the semantic evidence text, the claim text and the `supports` relationship; M3 does not prove that
  those descriptions reflect the code, so a valid reference to a code file can support an unrelated
  claim (characterized by a test through `createGraph`). It is a provenance-bounded label, **not**
  machine-verified semantic truth.
- **Claim levels** are checked against graph material: `repo_corroborated` needs a `supports`
  GitHub fact at `repo_corroborated`; `contradicted` needs a Contradiction naming the claim;
  `unverified`/`team_claim` need nothing; the rules for the other levels remain defined but producers
  cannot reach them in M3. A relation **never** changes a claim's level.
- **Transitions** (a new claim superseding an old one): to or from `contradicted` always; otherwise
  the new tier may not be lower than the old one. No claim silently loses verification. The
  database enforces the same 49-pair matrix in a trigger; a test compares it to the domain rule.
- `absence` and `unknown` evidence can neither support nor contradict a claim and cannot be a
  contradiction side (missing evidence is not negative evidence, invariant 3). They feed Unknowns.
- `absence` (a defined source was searched and nothing was found), `unknown` (it cannot be
  established) and `contradiction` (two established pieces of material conflict) stay distinct.
  None is a score, a penalty or an accusation (invariant 25): a Contradiction is data for a judge.

### ID integrity (invariants 19 and 20)

Producers never choose persisted IDs. A batch (`EvidenceGraphBatchInput`, Zod `strictObject`, so a
smuggled `id`, `createdAt`, `origin` override or score is rejected) names **new** entities with
batch-local `ref`s; trusted code (`IdAllocator`: random by default, deterministic in tests and
demos) assigns every UUID. A reference to something that **exists** is `{ id }` and is resolved
against the authoritative set, looked up in every project so it can be classified exactly:
`*_NOT_FOUND` (well-formed but nonexistent), `WRONG_ENTITY_TYPE`, `CROSS_PROJECT_REFERENCE`.
Provenance adds `SNAPSHOT_NOT_CONTENT_BEARING`, `SOURCE_TYPE_MISMATCH`, `ARTIFACT_SNAPSHOT_MISMATCH`,
`SPAN_OUT_OF_BOUNDS`, `EXCERPT_MISMATCH` and so on. All issues are collected and returned in a
deterministic order (path, then code). `validateGraphIntegrity` re-checks a stored graph for
dangling and cross-project references and every rule above.

### Write path and audit

`EvidenceGraphStore.createGraph(projectId, batch, actorId)` (`packages/database`) is the only
writer and the integration point M5 will call. One transaction: lock the project row with
`SELECT ... FOR NO KEY UPDATE` as the **first** locking operation (it conflicts with itself, so all
`createGraph` writers of one project serialize before they count the project's records for the caps
or read the state they extend; it does not conflict with the `FOR KEY SHARE` locks the graph tables'
foreign keys take, and other projects' writers never touch the row; an earlier `FOR SHARE` let any
number of writers see the same totals and exceed the caps), load exactly the
referenced entities and the prefetched artifact spans, plan, insert in batch order (claims one by
one so a superseding claim sees its predecessor), append the `evidence_graph.created` audit
event, commit. Any issue means nothing is written. Unexpected database failures surface as
`EvidenceGraphPersistenceError` carrying only a SQLSTATE and constraint name (driver errors embed
untrusted text). Audit metadata holds counts and IDs, never claim, evidence or excerpt text. No
transaction wraps model or network work (M3 has none).

Per-batch limits: 100 claims, 200 evidence items, 400 relations, 50 unknowns, 50 contradictions.
Per-project caps (2,000 / 5,000 / 10,000 / 1,000 / 1,000) keep every graph load bounded.

### Queries (pure, deterministic, in `packages/evidence`)

Claim with supporting/contradicting evidence; evidence with the claims it affects; unknowns of a
claim; contradictions touching a node; bounded breadth-first neighbors (depth ≤ 4, ≤ 500 nodes,
cycle-safe); supersession chain and current claim; provenance trace (evidence → snapshot →
artifact → span); a plain-count summary; keyset pagination. Ordering is always `seq` (then ID), never
database locale or hash-map order. Results contain no score, ranking or confidence.

### API (read-only, `evidence.read`: organizer and judge)

| Method | Path                                                     | Purpose                                                           |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/projects/:projectId/evidence-graph`                    | plain-count summary                                               |
| GET    | `/projects/:projectId/evidence-graph/neighbors`          | bounded neighborhood of a node (`type`, `id`, `depth ≤ 4`)        |
| GET    | `/projects/:projectId/claims`, `/claims/:claimId`        | page (`limit ≤ 200`, `after`, `current`) / claim detail           |
| GET    | `/projects/:projectId/evidence`, `/evidence/:evidenceId` | page (`kind`, `origin` filters) / evidence detail with provenance |
| GET    | `/projects/:projectId/unknowns`, `/contradictions`       | pages                                                             |

POST/PUT/PATCH/DELETE on these paths answer `405 GRAPH_READ_ONLY`. A claim or evidence ID of another
project is answered exactly like a nonexistent one (`404`). There is no score, assess, analyze,
question, rank or winner route and no endpoint that triggers a model.

---

## 13. Scoring engine (M4)

```
locked Event Context ─► selectRubric ─► RubricSpec      ┐   TRUSTED, in-process, frozen
loaded graph (one snapshot) + source facts + tracks     ├─► createTrustedScoringContext
assessor judgments (strict schema, UNTRUSTED)  ─────────┴─► scoreProject ─► ScoreReport (canonical, hashed)
```

`packages/scoring` is a pure Layer-2 package (`context`, `evidence`, `schemas`). It persists nothing,
serves nothing and has no migration, table, route or UI. Persisting an assessment version, with the
engine version, rubric identity, fingerprints and cited IDs the report carries, is M5. The full policy
is in [SCORING.md](./SCORING.md) §12–13 and the rationale in
[milestones/M4-design.md](./milestones/M4-design.md).

- **Three inputs, three trust levels.** The trusted context (rubric, graph, declared tracks) is built by
  a validating factory and branded; the assessor payload is a strict schema with no field for
  attestations, verification levels, weights, rubric content or tracks; the caller options only know
  the explicit preview request.
- **Fail closed.** A graph of mixed projects, a structurally broken graph, a rubric whose published
  weights are invalid, a locked snapshot that no longer matches its hash, an invented or foreign
  evidence ID, a duplicate citation, a score outside the published scale: nothing is scored.
- **Consistent reads.** Scoring reads the graph through `EvidenceGraphStore.loadGraph`, which since M4
  runs in one read-only `REPEATABLE READ` transaction, so a batch committed mid-read is never half
  visible. `createGraph` stays `READ COMMITTED` (its project row lock depends on it).
- **Verification boundary.** The database still stores any verification label that its CHECK allows, and
  the M3 integrity validator cannot tell a privileged chain written around the validated path from a
  legitimate one. The engine therefore never reads a label as trust (SECURITY §15).
- **Limits.** Structure is validated, semantic relevance is not (an M5 prerequisite); only recorded
  contradictions are counted; constants are heuristics.
