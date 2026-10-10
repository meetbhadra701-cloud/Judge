# M5 phase P4 — assessment persistence (`packages/database`) (note)

Scope delivered (design [M5-design.md](./M5-design.md) §7, §8 and the P4 row of §13), after the R3 corrections to P3 ([M5-P3-r3-corrections.md](./M5-P3-r3-corrections.md)).
**No** worker pipeline (P5), API route, UI or Anthropic adapter (P6), question, interview or reassessment functionality, **no** provider SDK, credential or model call. Fallback anchors
remain an unapproved, disabled draft. Existing migrations `0000`–`0009` are untouched.

## What exists

| Surface                                                               | Purpose                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration `0010_m5_assessment_schema` (generated)                     | twelve tables, the partial unique index (one active assessment run per project), run link CHECKs, `budget_exceeded` (assessment runs only)                                           |
| Migration `0011_m5_assessment_integrity` (hand-written, as 0005/0008) | immutability, ownership, state machine, deferred completeness, budget backstop, report integrity                                                                                     |
| `EvidenceGraphStore.createGraphInTransaction`                         | the M3 write body, unchanged, runnable inside a caller's transaction; `createGraph` is now a thin wrapper (same parse-before-transaction, same locks, same errors, same audit event) |
| `GraphExtractionStore`                                                | graph records + extraction + membership rows in ONE transaction from the ids the database just allocated; reuse by `extraction_key`                                                  |
| `LockedContextReader`                                                 | read-only reconstruction of a frozen context; recomputes `lockedContentHash` from the rows it read                                                                                   |
| `AssessmentInputReader`                                               | the ONLY constructor of `AuthorizedAssessmentInputs`; one read-only `REPEATABLE READ` transaction; accepts only a run id                                                             |
| `AssessmentRunStore`                                                  | §8.6 idempotency matrix, pins, claim/heartbeat, binding of extractions, `finishRun`, `recoverExpiredRuns`                                                                            |
| `DatabaseRunBudget`                                                   | the durable local spending guard / call ledger (same contract as `packages/llm`'s in-memory ledger)                                                                                  |
| `AssessmentStore`                                                     | one atomic, immutable `pre_interview` assessment with judgments and citations; `getVerified` re-runs `verifyStoredAssessment`                                                        |

### Tables

`assessment_requests`, `assessment_run_inputs`, `assessment_run_input_snapshots`, `assessment_run_budget`, `assessment_run_calls`, `assessment_run_outcomes`, `assessment_run_extractions`,
`graph_extractions`, `graph_extraction_items`, `pre_interview_assessments`, `assessment_dimension_judgments`, `assessment_judgment_citations`. Every one is append-only except the ledger
row, which makes exactly one `reserved → settled | released | unknown` transition. `UPDATE`, `DELETE` and `TRUNCATE` (also by `CASCADE`) are rejected by trigger.

## Decisions and reconciliations (each differs from, or sharpens, the design text)

1. **Money is exact nano-USD, never micro-USD.** The model port (`packages/llm`) computes and enforces every limit in integer nano-USD; the design text said micro-USD. Converting would round
   usage away. All cost columns are `bigint` nano-USD (CHECK `0 ≤ x ≤ 2^53−1`, so JavaScript reads them exactly); there is no micro-USD column. Display conversion is `nanoToMicroUsdCeil`
   (always rounds **up**) and `microToNanoUsd` (exact, refuses an unrepresentable amount). Tested at the boundaries.
2. **Totals are derived, not stored.** `assessment_run_budget` holds the immutable LIMITS and is the row every reserve/settle locks (`FOR UPDATE`); settled/unknown/reserved totals are computed
   from the ledger under that lock. A counter therefore can never disagree with the calls it summarizes. The insert trigger re-checks the same limits as a backstop for direct SQL.
3. **Dispositions use the real P3 codes.** `assessment_dimension_judgments.disposition` is `UNIT_DISPOSITION_VALUES` (including `scored`, `no_applicable_context_cited`, `official_requirement_omitted_by_limit`);
   the design's `accepted`/`accepted_after_rerun` became `scored` plus the attempt counters. A CHECK ties `disposition = 'scored'` to `outcome_kind = 'scored'`.
4. **Membership is the item rows.** `graph_extraction_items` (primary key `(record_type, record_id)`: a record is a member of at most one extraction) replaces the id arrays; `members_hash` is **recomputed by the
   database** (SQL `sha256` over the same canonical JSON as `membersHash`) at commit. The binding of a run to its two extractions is its own immutable table (`assessment_run_extractions`), so the reader
   gets the committed hash independently of the assessment.
5. **The model answer is stored as bounded canonical text** (`response_canonical`, ≤ 262,144 bytes), not jsonb: jsonb does not preserve key order or numeric text and the ledger contract returns a key-sorted frozen copy.
6. **Opaque port strings.** `request_digest` and `response_hash` are bounded non-space strings (1–128), not hex-64: the `RunBudget` contract treats them as opaque. Real digests are SHA-256 hex.
7. **Closed set bound to its call (R3 A5.3).** `assessment_run_calls.closed_set` + `closed_set_hash = sha256(canonical(stage, requestDigest, closedSet))` are written at reservation (`register(digest, metadata)` then `reserve`), immutable
   afterwards; `bindingOf(callId)` recomputes the hash. A caller cannot attach another call's handles. Prompt text, system text, schema text, headers and credentials have no column.
8. **Track judgments (R3 A4).** CHECKs: a scored `track_prize_alignment.*` judgment must have `critic_review_required`, and a required review must be `critic_reviewed` with critic call numbers. `semantic_relevance` is the literal `not_verified`.
   Citations carry the code-authored `reference_applicability/track_key`; a trigger requires them to equal the cited member's stored metadata and the track to be one the run declared.
9. **Shared vocabulary change.** `budget_exceeded` joined `ANALYSIS_RUN_FAILURE_CATEGORY_VALUES`; CHECK `analysis_runs_budget_exceeded_only_for_assessments` confines it. Two existing tests changed deliberately: `migrations.test.ts`
   (the table list and the failure-category loop) and `event-context-guards.test.ts` (the "no score column anywhere" guard now exempts the assessor's per-dimension rating `assessment_dimension_judgments.score`).
   No M3 test was modified.
10. **Stale context cancels (decision D3).** Persisting under a superseded version cancels the run in the same transaction (`context_superseded`) and writes no assessment.

## `xmin` feasibility (P4 exit criterion): feasible, with one stated limit

The deferred trigger on `graph_extractions` requires every member to have been **created by the committing transaction** (`xmin = pg_current_xact_id()::xid`), and every graph row the transaction created for the project to be a member of
some extraction. Verified on PostgreSQL 16.15 and on PGlite, including the attack tests (a foreign earlier record, a missing member, a wrong hash, a broken closure, wrong counts).
**Limit:** rows inserted inside a `SAVEPOINT` carry the subtransaction id, so the check fails **closed** there (it rejects; it can never accept a record it should not) — a test pins this behavior. The extraction writer
never opens a savepoint (`createGraphInTransaction` documents the rule). No replacement was needed; the alternatives (an `extraction_id` on the M3 rows) would change M3 tables. A transaction that creates graph rows of the same project
outside an extraction while also creating an extraction is refused: the extraction transaction must contain exactly its records.

## Transactions and locks

Every operation is one short transaction; none spans a model call (there is no model code in this package). Lock order, identical everywhere: **project row (`FOR NO KEY UPDATE`) → pinned `event_context_versions` row (`FOR SHARE`) → run row (`FOR UPDATE`) → budget row (`FOR UPDATE`)**.
M1's lock/supersede takes event → version rows and never a project or run row, so the orders cannot cycle (20 interleavings tested without a deadlock). The reader takes no row lock. `createGraphInTransaction` takes the project lock first (a test shows the writer blocked on it before anything is read or written).

## Idempotency and recovery (§8.6)

Implemented as one transaction under the project lock; replay is derived from stable relations (`assessment_requests.run_id` → run state → `pre_interview_assessments.run_id`), never by editing a request row. Simultaneous identical requests create exactly one run; different keys: one run and the rest `run_active_conflict`; a retry after
failure returns the recorded outcome and never starts a run; `assess` with an equal key returns the existing assessment; `reassess` is a new salted version that reuses equal extractions. A crash after the extraction commits leaves a complete, reusable extraction, `recoverExpiredRuns` fails the run (`internal_error / worker_lease_expired`, in-flight calls become `unknown` at their worst case) and no assessment exists.

## Not in this phase / prerequisites for P5

- The worker orchestrator (S0–S14), lease heartbeats on a timer, the model-output → `JudgmentInput` mapping, the critic loop and the failure matrix; `assessmentKey` composition from the real extraction keys; the API `Idempotency-Key` plumbing (P6).
- P5 must read each call's closed set from the ledger (`bindingOf`) when validating its answer, must not persist a scored Track judgment before its critic review completed (the database refuses it), and must call `AssessmentInputReader.read` for every scoring step (it is the only source of `AuthorizedAssessmentInputs`).
- Residual risks: a database superuser can still edit rows (outside the single-judge threat model; the reader re-verifies hashes and provenance, which detects most such edits); `report_text_sha256` and the jsonb mirror are verified by the database, the M4 `outputHash` only by `verifyStoredAssessment` (the database cannot recompute canonical JSON hashes).

## Verification (final tree)

- `pnpm check` (PGlite): format, lint, typecheck, `db:check`, tests (137 files passed, 2 skipped; 2347 tests passed, 25 skipped — the skips are the PostgreSQL-only files) and build all pass.
- Full suite on **PostgreSQL 16.15** (`TEST_DATABASE_URL`, ICU `en-US` database, files run sequentially): 139 files, 2794 tests passed, 1 skipped. On a cluster with the `C` collation exactly one existing M3 test (the artifact-order canary) fails because it needs a non-C collation; it is unrelated to M5 and passes on the ICU database.
- `pnpm db:generate`: "No schema changes, nothing to migrate". No committed migration was edited (0000–0009 untouched; new 0010/0011 only). M3 database tests are preserved except the deliberate updates to the table list / failure-category loop in `migrations.test.ts` and the "no score columns" guard in `event-context-guards.test.ts`.
- `git diff --check`: clean. Scoring goldens and prompts are unchanged.

### Mutation proofs (45 mutants, each applied to the tree and run against the focused tests)

43 killed, 2 survived:

- `reader does not compare the recomputed context hash with the pin` — redundant by construction: `LockedContextReader` already rejects a recomputed hash that differs from the version's stored hash (`locked-context-reader.ts`), the pin is written only with that stored hash (database guard `inputs can be pinned only to the CURRENTLY locked version`) and is immutable, and the same comparison is repeated against the snapshot's hash in the reader; removing one of the three equal comparisons cannot change any outcome.
- `a cited reference may concern a track the run did not declare` — defense in depth in the citation trigger: the reader recomputes the exact reference set from the declared tracks and rejects any other member before a judgment can cite it, so the only way to reach the trigger is to forge a context extraction. Not reachable by an honest or by a direct-SQL path without first forging an extraction that the reader refuses.
