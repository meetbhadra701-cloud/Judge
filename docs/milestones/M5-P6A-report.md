# M5 P6A — queue liveness hardening and offline API/UI integration

Branch `claude/m5-pre-interview-assessment`. Base: the R5-approved head `ed0259bb1532553068cef6d676bbd91ff720523e`.
**Code head measured below: `a809f34a687c02e9e83317f90e4390ccedf3565f`** (the commit that adds this report follows it and changes only this file).
69 files changed against the base (see "Changed files"). No provider, SDK, network model call, credential or paid activity. No PR, merge,
deploy, change to `main` or P6B work.

Scope: P6A only. **F-2, F-3 and the prompt v3 proposal are written up, not implemented, and wait for an owner decision**
(`docs/milestones/M5-P6A-decisions.md`).

## 1. Results at a glance

| Gate                                                                               | Result                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` (format, lint, typecheck, db:check, full PGlite test run, build)      | **exit 0** — `Test Files 167 passed \| 5 skipped (172)`, `Tests 2675 passed \| 57 skipped \| 3 todo (2735)`               |
| Full suite on PostgreSQL 16 (`TEST_DATABASE_URL`, local 16.15 server) at this head | `Tests 3348 passed \| 1 failed \| 1 skipped \| 6 todo (3356)`; the one failure is the pre-existing flaky F-9 test (below) |
| `pnpm db:generate` after the last change                                           | "No schema changes, nothing to migrate" (`db:check`: "Everything's fine")                                                 |
| `git diff --check`                                                                 | clean                                                                                                                     |
| Targeted mutation proofs                                                           | 17 mutants; 15 killed at once, **2 survived and were then killed by new tests** (section 7)                               |
| Offline replay e2e through HTTP                                                    | `tests/integration/assessment-http-e2e.test.ts` (PGlite and PG16)                                                         |
| Offline replay e2e through the UI                                                  | one-off run with a real browser (section 5); **not part of the suite**                                                    |

Honest notes on the numbers:

- **F-9 (P3, pre-existing) is still flaky.** `tests/integration/assessment-ledger-contract.test.ts` › "serializes settle against reserve"
  failed in one full PG16 run and in 1 of 6 reruns of that file alone (5 of 6 clean). The file and `packages/llm/src/testing/budget-contract.ts`
  are byte-identical to the base (`git diff ed0259b HEAD` is empty for both), and R5 reproduced the same flake on the old head. The failure direction
  is safe (never two reservations succeed). I did not touch it in P6A.
- An earlier full PG16 run (before the final test-only commits) had one different failure, `pipeline.ownership.test.ts` › "stops at once when the
  lease is lost" (30 s timeout). Cause: that test called `recoverRun` once, and recovery now **skips** a row the heartbeat holds at that
  instant. The loop retries on its next pass; the test now retries too. 3 consecutive PG16 reruns of the file: 20/20.
- The first full PGlite run (before the last fixes) had 2 failures, both stale expectations (the migration list and the API env defaults); fixed.
- `pnpm check`'s lint step found 11 problems in P6A code that I had not run lint on before (unused imports, unnecessary assertions); fixed
  and re-run.

## 2. Queue liveness (R5 F-1)

**Differential reproduction (before the fix).** `apps/worker/src/assessment/loop.liveness.test.ts` holds the oldest pending run's row lock from a
second, separate PostgreSQL connection and asserts the loop keeps working. Against the unchanged P5 code **6 of 6 failed**:

| Scenario (separate PG connections)                                     | Old code                                   |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| concurrency 1: oldest locked, later runs must complete                 | timed out waiting for run 2                |
| concurrency 2: two locked runs must not occupy both slots              | timed out waiting for run 3                |
| maintenance: locked head past the pending limit must not stop claiming | timed out waiting for run 2                |
| lease recovery while a past-limit pending run is locked                | timed out waiting for recovery             |
| `stop()` while the head is locked                                      | `expected 'STILL BLOCKED' to be 'stopped'` |
| two workers over one locked head                                       | timed out waiting for later runs           |

After the fix all six pass (PG16). `assessment-claim-next.test.ts` adds store-level coverage on PGlite and PG16.

**Fix.**

- `AssessmentRunStore.claimNextRun(leaseMs, { createdAfter })` selects the oldest claimable pending run `FOR UPDATE SKIP LOCKED`, creates the lease
  and moves the run to `running` in one transaction (`startLease`, shared with `claimRun(id)`, which is kept). A locked run is skipped, never waited on.
- `recoverRun` and `expirePendingRun` also select `FOR UPDATE SKIP LOCKED`: a row someone else holds now is left to the next pass, which re-checks
  it under the same rules. The lock order run → budget → ledger, the 15-minute pending expiry, lease ownership, heartbeat and the conservative
  `unknown` accounting are unchanged.
- The loop runs maintenance (expiry, recovery) and queue filling as **independent guarded passes**, so neither can block the other.
  `fill()` claims with `claimNextRun` until the slots are full; `createdAfter` carries the pending cutoff so a run the expiry policy is about to
  cancel is never started.
- `pipeline.ts`: `runAssessment` = `claimRun` + `runClaimedAssessment(deps, runId, leaseToken)`; the loop calls the latter, so there is **no second
  claim** and no second state-transition path.
- `stop()` awaits the passes (bounded by the grace period), then the active runs, then aborts.

**Required tests.** Oldest locked / later progresses; all slots avoid starvation; maintenance progresses; stop completes; no duplicate claims
(two workers, one locked head, each other run executes once); no post-terminal spending (the existing R4/R5 ledger tests, green);
R4 and R5 race regressions green. Two R4/R5 regression tests assumed a _blocking_ wait and were rewritten to the skip semantics with the same intent
(`assessment-pending-expiry.test.ts` A2, `assessment-reservation-race.test.ts` F4); the `pipeline.ownership` change is described in section 1.

## 3. Offline HTTP API (design §10.2)

| Method and path                                      | Permission        | Notes                                                                                                                                |
| ---------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /projects/:projectId/assessments`              | `assessment.run`  | requires `Idempotency-Key` (UUID, case-insensitive) and a strict body `{ mode: 'assess' \| 'reassess' }`; only creates a pending run |
| `GET /projects/:projectId/assessments`               | `assessment.read` | newest first; active run, latest run, launch availability and notice                                                                 |
| `GET /projects/:projectId/assessments/:assessmentId` | `assessment.read` | verified report, judgments, citations, limitations, usage                                                                            |
| `GET /projects/:projectId/assessment-runs/:runId`    | `assessment.read` | state, failure category/code, usage, local spending guard                                                                            |

- `assessment.read` and `assessment.run`: organizer and judge (`packages/domain/src/authorization.ts`, tested in `authorization.test.ts`).
- Every other method on these paths answers **405** after authentication (`ASSESSMENT_READ_ONLY`); a milestone-scope test pins exactly four handlers.
- **All P4 results are preserved** and mapped without reinterpretation: `run_created`/`run_active` (202), `assessment_ready`/`already_assessed` (200),
  `run_active_conflict` (409), `key_reused` (422), recorded historical failure replayed (200 `run_failed`), explicit reassess (new version),
  and `NO_LOCKED_CONTEXT` / `NO_SOURCE_SNAPSHOTS` / `PROJECT_NOT_FOUND` with nothing recorded.
- **Cross-project isolation:** a run or assessment of another project answers exactly like a nonexistent one (404, identical bodies); mutants A3/A4 prove it.
- **Provider gate:** `POST` opens only when `ASSESSMENT_PROVIDER=replay` is configured, a valid synthetic fixture loads, and the **existing runtime gate**
  (`assertProviderAllowed('replay')`) approves; otherwise `503 ASSESSMENT_PROVIDER_NOT_CONFIGURED` before anything is touched while reads keep working.
  `replay` is refused in production. There is no live provider.
- **No worker in a request:** `POST` calls the run store and returns; a scope test forbids the loop, the pipeline, any model call, a prompt renderer and
  `.transaction(` in the routes and service. The client chooses nothing else (no limit, model, provider or price table).
- **Read model** (`AssessmentReadStore`): project-scoped; re-verifies the stored report (text hash, schema, M4 output hash) on **every read**. A report that does
  not verify is returned as `verified:false` with **no report and no number**; an insufficient dimension or overall carries `score: null`; the replay flag comes
  from the stored provider mode; `semanticRelevance: 'not_verified'` is a literal on every judgment and on the notices.

HTTP authorization/idempotency matrix: `apps/api/src/assessments/routes.test.ts` (anonymous/malformed/unauthorized on every route, organizer = judge,
405s, key and body validation, no client-chosen limits, 503 gate, replay gate, one frozen pending run and no work started, same-key replay / new-key conflict /
changed-request reuse, case-insensitive keys, recorded-failure replay, stable error codes, cross-project 404 identity). It runs on PGlite and PG16 (both green).

## 4. Shared pipeline-configuration builder

The API and the worker previously could have built different configs for one logical request. Now there is **one builder**:

- `packages/assessment/src/pipeline-config.ts` — the pure schema, `PIPELINE_ID` and `buildPipelineConfig` taking prompt identities as arguments (layer 2: it
  imports no `prompts`/`llm`).
- `packages/prompts/src/pipeline-config.ts` — composes the builder **once** with the current frozen prompt identities (`buildPipelineConfig`,
  `checkPipelineConfig`, `currentPromptIdentities`). The worker re-exports it from `apps/worker/src/assessment/config.ts`; the API imports the same name.

Dependency rule: the "obvious" place (the worker) is unreachable from the API (apps do not import apps), and `assessment` cannot import `prompts` (layer rule 3),
so the pure builder lives in layer 2 and the composition in layer 3. Narrow and guarded: `prompts` may import `assessment` only in `pipeline-config.ts`;
the API imports one name from `prompts` and two from `llm`, each in a single file; both are pinned by scope tests. `pipeline-config.test.ts` pins the
golden config hashes, the price-table identity (`ASSESSMENT_PRICE_TABLE_ID`, now a shared constant used by `prices-v1`), request idempotency and the P4
frozen identity (mutant C1 proves the hash test notices a one-token change).

## 5. Assessment UI (`/projects/:projectId/assessment`)

Server-rendered; it calls only the four API routes; the action sends a fresh `Idempotency-Key` per rendered form (a double submit of one form replays;
a reload is a new request); reassess is a separate explicit button. Linked from the project page. Every number comes from the verified read model.

| State                 | What is shown                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| no assessment         | "No assessment has been requested… Nothing has been scored."                                                             |
| pending / running     | run panel, "no assessment exists until the run succeeds"                                                                 |
| failed / cancelled    | red alert with the category explanation, "No assessment was produced and no score is shown for this run", recorded codes |
| scored                | overall `x.x / 10`, criteria, dimensions, citations                                                                      |
| partially scored      | "partial: based on N% of the weight", the not-assessed criteria listed                                                   |
| insufficient evidence | "Insufficient evidence… No number is given, and this is not a low score"; per-dimension "no number is given"             |
| replay demonstration  | prominent "Replay demonstration" notice; values are from recorded fixtures                                               |
| (not verified)        | "could not be verified, so none of it is shown"                                                                          |

Always visible: the advisory notice (the human judge's final score is separate and authoritative), confidence "index, not a probability", the
`relevance not verified` tag per dimension and the "What this does not establish" list. Project-derived text is rendered as escaped React text only
(a repo-wide test forbids HTML/Markdown rendering). `apps/web/lib/assessment-view.ts` only _classifies_ states and never computes a number
(`tests/integration/assessment-ui-view.test.ts`; mutants U1/U2).

**Verification limit, stated plainly:** the web package has no component-test setup. The page was verified by `next build` (part of `pnpm check`), the
typecheck, the view-model tests, and **one manual end-to-end run** with a real API, the real worker loop on the offline replay provider, `next start` and
Playwright/Chromium: empty state → click "Run assessment" → "IN PROGRESS / Run waiting for a worker" → worker drains → page shows SCORED 7.0/10, the
REPLAY DEMONSTRATION notice, both criteria and dimensions with their citations and "relevance not verified", usage counters, and the launch buttons. That script
was a scratch file and is **not** in the repository or the suite.

## 6. R5 P3 findings F-4 … F-12, and F-1…F-3

| Finding                                               | Sev | Disposition                           | What was done / why not                                                                                                                                                                                                                                                             | Evidence                                                                               |
| ----------------------------------------------------- | --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| F-1 queue starvation                                  | P2  | **Fixed**                             | section 2                                                                                                                                                                                                                                                                           | `loop.liveness.test.ts` (6/6 failed before, 6/6 pass), `assessment-claim-next.test.ts` |
| F-2 critic never reviews model-declared insufficiency | P2  | **Proposal only — awaiting approval** | options A/B/C in `M5-P6A-decisions.md`; recommendation: B now, A with prompt v3                                                                                                                                                                                                     | current behavior pinned by `pipeline.f2-characterization.test.ts`                      |
| F-3 empty Event-Context reference set                 | P2  | **Proposal only — awaiting approval** | empty authenticated extraction vs request-time 422; schema/API implications in the decisions file (no existing trigger appears to forbid an empty set; to be confirmed by a spike)                                                                                                  | —                                                                                      |
| F-4 identical re-ask / re-run request                 | P3  | **Deferred**                          | needs the prompt v3 closed feedback channel; frozen prompts untouched; proposal in the decisions file                                                                                                                                                                               | before any paid live run                                                               |
| F-5 limitations lost on extraction reuse              | P3  | **Fixed locally**                     | `graph_extractions.recorded_limitations` (nullable jsonb, **additive migration 0014**, not part of any key/fingerprint) records fidelity/rejection/dropped-relation notices; a reusing run re-discloses them; an extraction without them says `extraction_limitations_not_recorded` | `pipeline.extraction.test.ts` ("R5 F-5", 2 tests); mutant F5                           |
| F-6 ledger read-back compares few fields              | P3  | **Fixed locally**                     | `bindingOf` returns model, provider, mode, prompt id/version/template hash, schema id/version; `generateOnce` compares all eight with the request and ends the run `call_identity_differs_from_request` before the answer reaches the gate                                          | `model-call.test.ts` (8 cases); mutant F6                                              |
| F-7 candidate truncation not disclosed                | P3  | **Fixed locally**                     | `candidates_omitted_for_size` limitation, subjects = affected dimension ids                                                                                                                                                                                                         | `pipeline.hostile.test.ts`; mutant F7                                                  |
| F-8 failed newer capture invisible                    | P3  | **Deferred**                          | needs a source-status policy decision (Unknown vs limitation)                                                                                                                                                                                                                       | P6B                                                                                    |
| F-9 flaky ledger-contract expectation                 | P3  | **Deferred, still flaky**             | P4 test, safe direction; see section 1                                                                                                                                                                                                                                              | P6B                                                                                    |
| F-10 completion hangs on a never-settling heartbeat   | P3  | **Fixed locally**                     | `RunSession.stop()` waits for an in-flight heartbeat at most 2 s                                                                                                                                                                                                                    | `session.test.ts`; mutant F10                                                          |
| F-11 `createExtraction` has no run/lease check        | P3  | **Deferred**                          | content-addressed and complete; an ownership check changes the P4 store contract                                                                                                                                                                                                    | P6B                                                                                    |
| F-12 pending cutoff from the worker clock             | P3  | **Deferred**                          | the injectable clock is the seam of the R4/R5 race tests; a SQL-`now()` comparison is a separate change with its own tests; not worsened by P6A                                                                                                                                     | P6B                                                                                    |

No frozen P2 prompt version, no `packages/scoring` code and no M4 golden was changed (a scope test pins the scoring package to its approved report-hash export).

## 7. Mutation proofs

Each mutant is a single edit applied to the production file, the named tests run (PG16 where the scenario needs real lock contention), then the file is restored.

| Id  | Mutation                                               | Result                                                                                                                        |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Q1  | `claimNextRun` without `SKIP LOCKED`                   | killed (7 failed)                                                                                                             |
| Q2  | `recoverRun` without `SKIP LOCKED`                     | killed (1)                                                                                                                    |
| Q3  | `expirePendingRun` without `SKIP LOCKED`               | killed (2)                                                                                                                    |
| Q4  | loop claims without the pending cutoff                 | **survived** → test `never STARTS a pending run that is past the age limit…` added → **killed** (2)                           |
| A1  | `Idempotency-Key` not required                         | killed                                                                                                                        |
| A2  | read routes without authentication                     | killed                                                                                                                        |
| A3  | assessment lookup ignores the project                  | killed                                                                                                                        |
| A4  | run lookup ignores the project                         | killed (2)                                                                                                                    |
| A5  | an unverified report is returned                       | **survived** → `read-model.tamper.test.ts` added (a corrupted immutable row must return no report and no number) → **killed** |
| A6  | POST without the 503 gate                              | killed                                                                                                                        |
| C1  | one-token change in the shared config                  | killed                                                                                                                        |
| U1  | insufficient/not-computed overall classified as scored | killed                                                                                                                        |
| U2  | failed run hidden from the page state                  | killed (2)                                                                                                                    |
| F5  | reuse limitations dropped                              | killed                                                                                                                        |
| F6  | prompt version not compared on read-back               | killed                                                                                                                        |
| F7  | truncation not disclosed                               | killed                                                                                                                        |
| F10 | `stop()` waits for the heartbeat unbounded             | killed                                                                                                                        |

The two survivors were genuine test gaps, not equivalent mutants; after the new tests both are killed (re-run individually).

## 8. Changed files (69)

Queue: `packages/database/src/assessment-run-store.ts`, `apps/worker/src/assessment/{loop,pipeline,session}.ts`, tests `loop.liveness`, `loop`, `assessment-claim-next`,
`assessment-pending-expiry`, `assessment-reservation-race`, `pipeline.ownership`, `session`.
Shared config: `packages/assessment/src/{pipeline-config,index}.ts`, `packages/prompts/src/{pipeline-config,index}.ts`, `apps/worker/src/assessment/config.ts`,
`packages/schemas/src/assessment.ts`, `packages/llm/src/prices-v1.ts`, package manifests and `pnpm-lock.yaml`.
API: `apps/api/src/assessments/{errors,pipeline-config,routes,runtime-gate,service}.ts` (+ `routes.test.ts`), `apps/api/src/{app,env,errors,http,main}.ts`,
`packages/database/src/{assessment-read,index}.ts`, `packages/schemas/src/{assessment-api,index}.ts`, `packages/domain/src/authorization.ts`, `.env.example`.
UI: `apps/web/app/projects/[projectId]/assessment/{page,actions}`, `apps/web/lib/{assessment-view,api}.ts`, `apps/web/app/projects/[projectId]/page.tsx`.
P3 fixes: `apps/worker/src/assessment/{assess,model-call,pipeline,write-extraction}.ts`, `packages/database/src/{extraction-store,assessment-input-reader,run-budget-store}.ts`,
`packages/database/src/schema/assessment.ts`, `packages/database/drizzle/0014_p6a_extraction_limitations.sql` (+ snapshot, journal).
Docs/tests: `docs/ARCHITECTURE.md` §8, `docs/milestones/M5-P6A-decisions.md`, `tests/integration/{assessment-http-e2e,assessment-ui-view,milestone-scope}.test.ts`,
`apps/worker/src/assessment/{pipeline.f2-characterization,read-model.tamper}.test.ts`.

Deliberate guard-test edits (all narrow): `milestone-scope.test.ts` (the API/web allow-list for the assessment modules, the four routes, the migration list incl. the one additive 0014),
`source-scan.test.ts` in `prompts` and `worker` (the single permitted new imports).
Migration 0014 is **one nullable column** (`ALTER TABLE "graph_extractions" ADD COLUMN "recorded_limitations" jsonb;`); no existing migration was edited.

## 9. Remaining prerequisites for P6B

1. Owner decisions on F-2 (A/B/C) and F-3 (empty extraction vs request-time refusal) and on the prompt v3 proposal; implement only what is approved.
2. A decision on the live-provider path (separate authorization, price table verification, first measurement); nothing live exists or was exercised.
3. F-8, F-9, F-11, F-12 (section 6), and the F-9 flake in particular before CI relies on the PG16 suite.
4. A component-level test setup for `apps/web` so the page states are covered in the suite rather than by one manual run.
5. A durable way to start the API and worker together with a shared replay fixture for demonstrations (today the e2e is a test).
6. Documentation of the operational pairing: the replay fixture must be recorded for exactly the models the API freezes into the run.

**STOP.** P6A is complete for independent review. No PR, merge, deploy, main change or P6B work has been done.
