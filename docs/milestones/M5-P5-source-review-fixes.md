# M5 P5 — Source-review corrections

Branch `claude/m5-pre-interview-assessment`, applied on P5 head `e5559b1`. Scope: one concurrency defect, one incomplete
comparison, and one design question. No P6, no provider SDK, no live call, no migration, no scoring change, no PR, `main` untouched.

## 1. Pending-expiry versus worker-claim race

### Original vulnerability

`expirePending()` in the worker loop listed expired pending runs and then ended each one with `AssessmentRunStore.finishRun` and
**no lease token**. `finishRun` accepts a `pending` or a `running` run when the token is omitted. Interleaving:

1. the loop selects run R (pending, older than the cutoff);
2. another worker claims R (`pending → running`, lease token T) and starts spending;
3. the loop resumes and calls `finishRun({ runId: R, state: 'cancelled', failureCode: 'pending_expired' })`;
4. R is `cancelled` while worker T is mid-run. Its in-flight attempts are reaped as `unknown`, its later reservations are refused,
   and the project's live assessment is lost.

Reproduced before the fix, on PGlite and on PostgreSQL 16, with a hooked store that pauses the expiry between the list and the
cancel: `AssertionError: expected 'cancelled' to be 'running'`.

### Corrected interleavings

New additive P4 store operation (the only change under `packages/`, no migration):

```ts
AssessmentRunStore.expirePendingRun(runId: string, createdBefore: Date): Promise<boolean>
```

It opens one transaction, takes `SELECT … FOR UPDATE` on the run row, re-checks **under that lock** that the run is an assessment run,
`state = 'pending'` and `createdAt < createdBefore`, and only then cancels through the existing `terminalize` path (ledger reaped,
outcome row `cancelled / pending_expired / pending`, totals from the ledger). Otherwise it returns `false` and changes nothing. Lock
order is unchanged (run → budget → ledger rows). `finishRun`, `claimRun`, `heartbeat`, `recoverRun`/`recoverExpiredRuns` are
unchanged; the explicit lease-recovery path still ends only a running run whose lease has expired, re-checked under the lock.

| Interleaving | Result |
| --- | --- |
| A. expiry lists R, worker claims (and heartbeats), expiry resumes | `expirePendingRun` sees `running`, returns false; R stays running with its lease; no outcome row |
| A2. worker holds R's lock while claiming, expiry starts meanwhile | expiry blocks on the row lock, re-reads after the grant, sees `running`, returns false |
| B. expiry locks R first and cancels, worker then claims | the claim waits for the lock, then finds `cancelled` and returns `null`; nothing is spent |
| C. heartbeats, recovery and expiry passes racing on a claimed run | all expiry/recovery calls return false, heartbeats return true, run stays `running` |
| D. two expiry processes on one abandoned run | exactly one cancels; one outcome row; repeated calls are no-ops |
| 12 rounds of claim ‖ expiry on separate connections | every run ends either `running` with the claimer's token or `cancelled` with one outcome, never both |

The loop now calls `expirePendingRun(id, cutoff)` and no longer calls `finishRun` at all. Every worker-originated `finishRun`
(pipeline `terminate`) carries the lease token; a source scan pins both facts (`finishRun` appears only in `pipeline.ts`, built from
an object that contains `leaseToken`; `expirePendingRun` appears only in `loop.ts`).

`finishRun` without a token on a running run remains available as the existing administrative P4 path (the R4 terminalization,
reservation-race, budget and persistence tests use it). Making a token mandatory would change that contract and break those tests, so
it was **not** done; the worker-side guarantee is enforced by the scan and by the removed call site.

A new test seam `afterPendingLocked` (separate from `afterRunLocked`, so the typed hooks of existing tests are unaffected) lets a test
hold the run lock after the pending/age checks.

### Tests

* `packages/database/src/assessment-pending-expiry.test.ts`: semantics on PGlite and PostgreSQL (D idempotent, E no ledger rows and
  zero totals, age re-check, running run untouched, claim refused after expiry, terminal/unknown runs untouched, F lease recovery
  unchanged) and the forced interleavings A, A2, B, C, D and the 12-round race on **two independent PostgreSQL pools**.
* `apps/worker/src/assessment/loop.expiry-race.test.ts`: the same race through the real loop and the real `runAssessment` (A with a
  paused expiry, A with a full pipeline run, B no model call and no ledger row, D/E idempotent and no fabricated outcome).
* F: the R4 terminalization and reservation-race suites (`assessment-reservation-race`, `assessment-run-store`,
  `assessment-concurrency`, …) pass unchanged.

### Mutation proof (killed)

| Id | Defect | Killed by |
| --- | --- | --- |
| S01 | the under-lock `state = pending` check removed | the tests of `assessment-pending-expiry.test.ts` and `loop.expiry-race.test.ts` |
| S02 | the under-lock age check removed | the tests of `assessment-pending-expiry.test.ts` |
| S03 | the loop ends pending runs through a tokenless `finishRun` again (the original defect) | `loop.expiry-race.test.ts`, `source-scan.test.ts` |

## 2. Complete closed-set correspondence

### Original weakness

In `generateOnce` the closed set read back from the ledger was compared with the one the rendered prompt offered using only
`evidence`, `passages` and `unit`. `RenderedPrompt.closedSet` has five handle lists (`passages`, `claims`, `evidence`, `pairs`,
`items`) and the unit, so a binding differing only in `claims`, `pairs` or `items` was accepted and the answer reached the P3 domain
gate validated against a set that was not the one shown.

### Fix

`sameClosedSet(stored, offered)` (exported from `model-call.ts`) compares all five lists element by element **in order** (a missing,
substituted, reordered or extra handle fails) and the unit. A mismatch ends the run with `internal_error /
closed_set_differs_from_prompt` **before the validator, and therefore before the P3 domain gate, sees the answer**. The database-backed
checks of the request digest, stage and dimension are unchanged and run first.

### Tests (`model-call.test.ts`, +34)

* A control per list (exact set accepted): passages, claims, evidence, pairs, items.
* For every list, five tamperings that change only that list: missing entry, substituted handle, reordered list, extra handle, emptied
  list, plus a differing unit; each asserts the validator was never called.
* The three required adversarial bindings that differ **only** in `claims`, `pairs` or `items` while `evidence`, `passages` and `unit`
  are identical.

### Mutation proof (killed)

C01 passages, C02 claims, C03 evidence, C04 pairs, C05 items, C06 unit each removed from the comparison; C07 order ignored; C08 length
ignored. 8/8 killed by `model-call.test.ts`.

## 3. Queue claim semantics (review only; nothing implemented)

Today: the loop lists pending ids with a plain `SELECT … ORDER BY created_at, id LIMIT n`, then each worker calls `claimRun(id)`,
which does `SELECT … FOR UPDATE` on that one row and re-checks `pending` before the `UPDATE`. The approved design (§10.3) names
`FOR UPDATE SKIP LOCKED`; the capture queue uses it.

* **Non-duplicate execution: equivalent.** The row lock plus the state re-check make the claim exclusive. Verified on PostgreSQL with
  three independent pools sweeping the same ordered list: every run is claimed exactly once with `attemptCount = 1`
  (`assessment-claim-queue.test.ts`).
* **Blocking: not equivalent, but bounded.** A blocking `FOR UPDATE` waits instead of skipping. Only holders of that same row can
  delay it, and they are short transactions (claim, heartbeat, finish/recover/expire). The test shows the wait is row-scoped: while a
  lock on run X is held, a claim of run Y proceeds immediately, and the waiting claim resolves when the holder ends. Because
  `launch` is not awaited, a blocked claim occupies one of the worker's (at most two) concurrency slots, not the loop.
* **Residual cost.** Every worker contends first for the same oldest pending ids (herding), and a pathological stuck lock holder on a
  head-of-queue row would stall one slot until it ends. With ≤ 2 slots per worker and a few workers this is acceptable for P5.
* **Smallest correction, if the owner wants the design's semantics exactly.** One additive operation in the same store, no migration:
  `claimNextRun(leaseMs): Promise<{ runId: string; leaseToken: string } | null>` that, in one transaction, runs
  `SELECT id FROM analysis_runs WHERE run_type = 'pre_interview_assessment' AND state = 'pending' ORDER BY created_at, id FOR UPDATE
  SKIP LOCKED LIMIT 1` and applies the same update as `claimRun`. The loop would call it instead of list + `claimRun`; `claimRun(id)`
  stays. It is **not** implemented here because it is a second P4 API addition beyond the one authorized, and the worker may not run
  that query itself (no transaction in the worker, no second state-transition mechanism).

## 4. Documented decisions (unchanged)

1. **Empty Event Context.** No rule or evidence record is fabricated. The run still fails before any spend
   (`no_context_reference_evidence`) until an approved design can represent an empty reference extraction.
2. **Repair prompts.** P2 prompts are untouched. The single re-ask re-sends the **identical** request (same digest); critic reruns
   change only the candidate set. Proposal for separate review: a versioned **prompt v3** whose input schema has an optional
   `feedback` block (a closed list of machine codes per rejected handle, never free text or model output), rendered after the data
   blocks, included in the request digest, and counted in the preflight call plan; v2 keeps working unchanged.
3. **Fallback anchors.** Still disabled; a context without exactly one official overall rubric fails at S0.

## 5. Validation

Counts are in the delivery message and repeated here after the final run.

* Focused (affected files): PGlite 201 passed, 29 skipped (PostgreSQL-only); PostgreSQL 16.15, files sequential, 343 passed (22
  files).
* Full PostgreSQL 16 suite, `pnpm check`, `pnpm db:generate` ("No schema changes"), `git diff --check`: see the section below.

FINAL_COUNTS_PLACEHOLDER

## 6. Remaining risks

* `finishRun` without a token on a running run is still permitted for administrators; only the worker's use is constrained.
* Claim herding and slot occupation by a blocked claim (§3) until `claimNextRun` is approved.
* Same-digest re-ask and the empty-context failure remain until their separate decisions.
* The age check uses the worker's clock for the cutoff and the database's `created_at`; skew between them shifts the 15-minute
  window by the skew, never the state check.
