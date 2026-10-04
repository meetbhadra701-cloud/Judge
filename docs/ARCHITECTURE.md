# Judge Copilot — Architecture

> **Status:** Milestone 0 (foundation). Most of the pipeline described here is intentionally
> **not implemented yet**. This document specifies the target architecture so that every
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
| `EventContextVersion`                                    | humans (+ AI drafting in M1)                  | editable while `draft`/`in_review`; **frozen** once `locked` |
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

### How M0 already encodes some invariants

| Invariant                 | M0 mechanism                                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10, 17 (immutability)     | `audit_events` is append-only via DB trigger; Event Context versions are append-only rows with `UNIQUE(event_id, version)`                                                                                            |
| 18 (locked context)       | `event_context_versions`: `locked_at` is required exactly for frozen statuses; at most one `locked` version per event (partial unique index); a version can only supersede a version of the same event (composite FK) |
| 21 (no execution)         | ESLint forbids `child_process` and `vm` in all non-test code, plus `eval`/`new Function`                                                                                                                              |
| 22 (no fabricated scores) | `analysis_runs`: a `failed` run must carry a `failure_category`; "insufficient evidence" is deliberately not a failure category                                                                                       |
| 13                        | `Ratio` is documented as a closed interval, not a probability                                                                                                                                                         |
| Secrets (SECURITY.md)     | logger redacts secret-bearing keys and serializes errors through an allow-list                                                                                                                                        |
| Dependency direction      | `tests/integration/dependency-rules.test.ts`                                                                                                                                                                          |

---

## 5. Monorepo layout

```
judge-copilot/
├── apps/
│   ├── web/        Next.js UI (M0: placeholder page only)
│   ├── api/        Fastify HTTP API (M0: GET /health)
│   └── worker/     background pipeline runner (M0: boots/stops, no jobs)
├── packages/
│   ├── shared/     env validation, structured logger, shutdown handling        [implemented]
│   ├── schemas/    foundational Zod schemas and vocabularies                   [implemented]
│   ├── domain/     domain types + lifecycle classifications                    [implemented]
│   ├── audit/      append-only audit event contract (AuditSink port)           [implemented]
│   ├── database/   Drizzle schema, migrations, persistence adapters            [implemented]
│   ├── context/    Event Context rules and locking                             [M1, README only]
│   ├── evidence/   claims, evidence graph, relations, contradictions, unknowns [M3, README only]
│   ├── scoring/    deterministic score engine                                  [M4, README only]
│   ├── uncertainty/ coverage, confidence, uncertainty analysis                 [M6, README only]
│   ├── questions/  question validation + information-gain ranking              [M6, README only]
│   ├── github/     read-only GitHub snapshot adapter                           [M2, README only]
│   ├── devpost/    Devpost snapshot adapter                                    [M2, README only]
│   ├── browser/    sandboxed deployment inspection adapter                     [M2+, README only]
│   ├── llm/        model/provider abstraction                                  [M1/M5, README only]
│   └── prompts/    versioned prompt templates                                  [M1/M5, README only]
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
database → audit, domain, schemas
api      → shared
worker   → shared
web      → (none)
```

Adding a new package requires assigning it a layer in the test and in this table.

---

## 7. M0 database foundation

Migrations live in `packages/database/drizzle/` and are applied in order. Each milestone adds
its own migrations; existing migrations are never edited after being committed.

| Migration                       | Contents                                                            |
| ------------------------------- | ------------------------------------------------------------------- |
| `0000_m0_foundation`            | `events`, `event_context_versions`, `analysis_runs`, `audit_events` |
| `0001_audit_events_append_only` | trigger rejecting UPDATE/DELETE/TRUNCATE on `audit_events`          |

- UUID primary keys (`gen_random_uuid()`), `timestamptz` timestamps.
- Vocabulary CHECK constraints are generated from the same tuples as the Zod schemas
  (`@judge-copilot/schemas`), so the database and validation cannot drift.
- `analysis_runs.project_id` is deliberately omitted until projects exist (M2).
- `audit_events.actor_id` has no foreign key until authentication exists.

---

## 8. Runtime processes

- **api** binds `API_HOST:API_PORT` (default `127.0.0.1:3001`), exposes `GET /health` →
  `{"status":"ok","service":"judge-copilot-api"}`, and closes cleanly on SIGINT/SIGTERM.
- **worker** starts, logs `worker started` with `jobHandlers: 0`, and stops cleanly. It registers
  no jobs and contacts nothing in M0.
- **web** is a static placeholder page. No dashboards, sample scores or fake functionality.

No process connects to a database or any external service at boot. A database connection
exists only when explicitly created (`createDatabase(url)`) or via `pnpm db:migrate`.
