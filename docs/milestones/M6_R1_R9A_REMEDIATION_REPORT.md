# M6-R1 — Remediation of the four R9A P2 failures

Branch `claude/m6-r1-r9a-remediation`. Nothing here calls a live model, spends money, deploys or merges. Every provider in the tests and in the browser journey is
an **offline scripted/replay demonstrator**; the product still labels it as such on every screen that shows questions.

R9A (independent review of M6 at `0ae02eb`) failed M6 on four confirmed P2 findings. The five-question workflow itself, the full suites and the independent
ranking oracle passed. This repair is deliberately narrow: the four findings, their regression evidence, and a tracked list of the R9A P3 findings that were
**not** addressed. The ranking heuristic is unchanged.

## 1. Starting point and identity

|                              |                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline (failed R9A head)   | `0ae02eb89b067491081118aca824666e634fac6b`                                                                                                                                                                                  |
| Branch                       | `claude/m6-r1-r9a-remediation`                                                                                                                                                                                              |
| Baseline-reproduction commit | `c8dfa7a` (the four failures, failing on the baseline code)                                                                                                                                                                 |
| Implementation head          | `aa610cec3ac24f0237b55f5538fcaf32214ce7b0` (this report is committed on top of it; the final head is the commit that carries this file, see the push output)                                                                |
| Migration added              | `0024_m6_r1_generation_claims` (one new numbered migration; no existing migration was edited)                                                                                                                               |
| Scope kept out               | M7 answer collection, ranking redesign, live providers, paid inference, deployment, merge                                                                                                                                   |
| R9A artefacts                | `R9A_INDEPENDENT_REVIEW.md` and `R9A_evidence/` were **not present** in this environment. The four findings were taken from the task text and reproduced independently below; no R9A result is claimed to have been re-run. |

## 2. The four failures, reproduced on the baseline first

Both reproduction files were committed first (`c8dfa7a`) and run against the **unchanged baseline implementation**. Raw outputs:

| #    | R9A finding                                                | Baseline result (exact)                                                                                                                                                      |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | 8 identical simultaneous requests → 8 provider calls       | `eight simultaneous identical requests in one process` failed: `expected 8 to be 1` (provider calls); the two-API-instance test failed the same way: `expected 8 to be 1`    |
| P2-2 | a voided project reached the provider, then HTTP 500       | `voided before generation` and `voided while the provider is running` both failed: `expected 500 to be 409`                                                                  |
| P2-3 | legitimate “Fraud Prevention” track rejected as accusatory | `a legitimate “Fraud Prevention” track is not an accusation` failed: rejected `[{ code: 'accusatory_wording', index: 0 }]`                                                   |
| P2-4 | shortfall claimed the left-out candidates were repeats     | `six valid candidates that all fall below the minimum marginal value are NOT reported as repeats` failed: `expected 'redundant_candidates' not to be 'redundant_candidates'` |

The same tests, unchanged in intent, pass on the repaired code (§9).

## 3. Changes made

| Area               | Change                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database (layer 3) | New table `question_generation_claims`; `QuestionSetStore.claimGeneration / renewGeneration / releaseGeneration / failGeneration / publish / projectVoided / generationClaim`; typed `QuestionClaimLostError`, `QuestionProjectVoidedError`, `isVoidedProjectRefusal` |
| API                | `QuestionService` claim loop, heartbeat, fenced publication, failure recording, void preflight and recheck; error codes `QUESTION_GENERATION_IN_PROGRESS`, `QUESTION_GENERATION_SUPERSEDED`; `Retry-After` header                                                     |
| Questions (pure)   | `withoutNeutralWords` in `validate.ts` (context-aware accusation check); `SelectionResult.excluded` and the shortfall classification in `select.ts` (ranking and overlap unchanged)                                                                                   |
| Schemas            | policy version `question-engine/v2` (`QUESTION_POLICY_VERSION_VALUES` keeps `v1`), shortfall values `below_minimum_value` and `mixed_causes`, view fields `excluded` and `policyNote`                                                                                 |
| Web                | the shortfall block shows the stored cause, the counts and which uncertainties are covered / still open; no cause is computed in the browser                                                                                                                          |
| Documentation      | `docs/MIGRATIONS.md` §8; this report                                                                                                                                                                                                                                  |

## 4. P2-1 — concurrent generation design

**Identity.** The generation identity is the existing unique `generation_key` (assessment report + context + policy + prompt + provider). A claim row is keyed by it.

**Claim (atomic, before any provider call).** One statement per attempt:

```
INSERT INTO question_generation_claims (generation_key, …, claim_token, state='running', attempt, lease_expires_at = now() + lease)
ON CONFLICT (generation_key) DO UPDATE … WHERE
   (existing.state = 'running' AND existing.lease_expires_at < now())      -- abandoned: lease lapsed
OR (existing.state = 'failed'  AND existing.lease_expires_at < now())      -- failed: cool-down over
RETURNING attempt
```

Exactly one concurrent statement returns a row; every other request gets "not acquired" and learns the claim's state. All time comparisons use the **database clock**,
so two API processes with different clocks agree on who holds the lease. No transaction is open while the provider runs: the claim is a committed row, not a lock.

**Loop of a request.** (1) a set for the key already exists → return it (`200 already_generated`); (2) otherwise try to claim; (3) _acquired_ → look for a set once more
(the claim row is deleted together with a published set, so a claim can be won just after another publication; if one exists the claim is given back and the
set returned, **no provider call**); then generate as holder; (4) _held by another live holder_ → poll (200 ms by default) until a set appears, the claim becomes
claimable, or the bounded wait (20 s) ends → `409 QUESTION_GENERATION_IN_PROGRESS` with `Retry-After`; (5) _recently failed_ → replay the recorded typed error
(`failure_category`) until the cool-down (5 s) passes, then one request may take over.

**Holder.** Renews the lease every 15 s on a 60 s lease (heartbeat). Calls the provider with no transaction open. Before publishing it re-checks: project not voided,
assessment still verifies, input fingerprint unchanged. Publication is one short transaction: lock the claim row `FOR UPDATE` and require **its own token** and
`running` (fencing); check `project_voids`; insert the set and its children; delete the claim. The claim and the set commit or roll back together.

**Failure.** A provider failure or an invalid output stores **no** set (nothing half-written), records the typed error on the claim (`state = failed`, cool-down) and
every waiting request receives that same error. After the cool-down one new request may try again: a controlled retry, not a storm.

**Crash / abandonment.** A holder that dies stops renewing; after the lease lapses the next request takes the claim over (`attempt` increments, new token).

**Stale holder.** If the old holder's provider answers after a takeover, its publication fails the fencing check. It then returns the set that now exists
(`200 already_generated`) or, when none exists yet, `409 QUESTION_GENERATION_SUPERSEDED`. It never publishes, so a superseded worker cannot create a second set
or overwrite the new holder's.

**What this does and does not promise.** _Publication_ is at-most-once per identity (unique key + fenced single-transaction publish). The **provider call is not
exactly-once across crashes**: a holder that crashes after the provider answered but before it published, or whose lease lapses while its provider call is
still running, can cause a second provider invocation by the next holder. In this repository every provider is an offline demonstrator, so this costs nothing
today; if a metered provider is ever authorised this limit must be revisited (e.g. provider-side idempotency keys) before billing is relied on. The test
`a stale holder cannot publish after its claim was taken over` asserts the documented behaviour: both providers were called, one set exists.

### API contract (new or changed answers)

| Situation                                                | Status                     | Code                                 | Notes                                                                  |
| -------------------------------------------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| First request for an identity                            | 201                        | —                                    | `result: generated`                                                    |
| Same identity again / waited for another request's set   | 200                        | —                                    | `result: already_generated`; no provider call                          |
| Another request is generating and the bounded wait ended | 409                        | `QUESTION_GENERATION_IN_PROGRESS`    | `Retry-After` header (seconds, from `details.retryAfterMs`)            |
| Holder superseded and no set exists yet                  | 409                        | `QUESTION_GENERATION_SUPERSEDED`     | nothing was published; retry                                           |
| Last attempt failed, cool-down running                   | (the recorded typed error) | e.g. `QUESTION_OUTPUT_INVALID` (502) | `Retry-After` while the cool-down lasts                                |
| Project voided (before the provider, or while it ran)    | 409                        | `PROJECT_VOIDED`                     | existing project-lifecycle code; zero provider calls when already void |

## 5. P2-2 — voided projects

- **Preflight.** `generate` reads `project_voids` through the store **before** building a provider or claiming anything: a voided project answers `409 PROJECT_VOIDED`
  with **zero provider invocations** (using the existing lifecycle code and status the project service already uses).
- **Void after the first check.** The holder re-checks before publishing, and the publication transaction checks `project_voids` again under the claim lock.
- **Void during a blocked provider.** The provider finishes, publication is refused, nothing is stored, the response is `409 PROJECT_VOIDED` (not 500). The attempt is recorded as failed on its claim (typed `PROJECT_VOIDED`), and every later request is refused by the preflight before any claim or provider call.
- **DB guard still authoritative.** The migration-0023 trigger ("a voided project cannot receive a question set") is untouched. `isVoidedProjectRefusal` recognises
  exactly that refusal anywhere in the error's cause chain and the store translates it to `QuestionProjectVoidedError`. A test invokes the guard directly
  (bypassing the explicit check) and asserts the typed answer.
- **History.** Existing question sets of a voided project stay readable (`GET` returns them; `launch.available` is false for new generation). No assessment or question-set row
  is changed by this repair.
- **Scope.** The project in the URL is the only one consulted: another user's/event's project cannot be probed through it, and an unrelated project is unaffected while one is voided.

## 6. P2-3 — neutral official terminology

The accusation guard is **kept**. Before the accusation patterns run on a question or its reason, `withoutNeutralWords` masks two kinds of text:

1. **Official titles** from the frozen, verified analysis only: the names of the rubric dimensions the question cites (plus the dimensions of the cited uncertainties) and the labels
   of the tracks in the cited trail. A candidate cannot declare a title: the same sentence is refused when no such title exists in the verified analysis (test
   `refuses the same wording when no such title exists…`). Matching is whole-word, case-insensitive and tolerant of hyphen/space variants, never inside a longer word.
2. **The team's own words**, only inside a sentence that attributes them to the team's materials, only runs of three or more words, and only text taken from the cited claims.

Additional patterns now refuse presupposed violations (violated / broke / bypassed the rules, get around, sneak, slip past), concealment (hide / conceal / cover up) and
“why … lie”. Closed-reference validation (handles, IDs, citations) is unchanged.

| Text                                                                                      | Result                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| “Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?” | accepted (title from the verified track) |
| same with FRAUD PREVENTION / fraud-prevention / extra spaces                              | accepted                                 |
| accusatory word in a rubric criterion title the cited uncertainty bears on                | accepted                                 |
| team-authored claim containing the word, in an attributed sentence                        | accepted                                 |
| “Why did your team fake the results of the Fraud Prevention demo?”                        | **refused** `accusatory_wording`         |
| “Did you plagiarize the Fraud Prevention module from another project?”                    | **refused**                              |
| “Did your team cheat while building the Fraud Prevention feature?”                        | **refused**                              |
| “How did you get around the rules for Fraud Prevention?”                                  | **refused**                              |
| “Why did your team hide how Fraud Prevention works?” / “…violated the requirements…”      | **refused**                              |
| “You never actually built the Fraud Prevention feature, did you?” (leading)               | **refused**                              |
| “Is the Fraud Prevention entry itself a fraud?” (title used as a weapon)                  | **refused**                              |
| “Does your fraud checker catch anything at all?” (only part of the title)                 | **refused**                              |
| “Is your fraud detection genuine?” (no official title around it)                          | **refused** (fails closed; see limits)   |
| an accusation placed in the _reason_                                                      | **refused**                              |
| a quotation that is not the team's recorded words, even when attributed                   | **refused**                              |

The R9A scenario (a “Fraud Prevention” track) now keeps all four candidates. **Limit:** this is a vocabulary-and-context heuristic. It reduces false refusals of official terms
and keeps refusing the tested accusations and reformulations; it is **not** a guarantee of semantic safety. It fails closed on ambiguous cases (a legitimate question using a
sensitive word outside an official title or attributed team text is refused).

## 7. P2-4 — truthful shortfall

`question-engine/v2`: selection itself (ranking, overlap, `MIN_MARGINAL_BP = 300`, no padding) is **unchanged**. After selection, each valid candidate that was not
selected is classified from its **own numbers**: value below the minimum → _below minimum value_; value at/above it but pushed under by overlap with a selected
question → _redundant_. The pool size is never used.

| Code                          | When                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `no_uncertainty`              | the analysis found no material uncertainty                     |
| `no_valid_candidates`         | uncertainties exist, no candidate passed validation            |
| `fewer_defensible_candidates` | fewer than five valid candidates existed and all were selected |
| `redundant_candidates`        | all left-out candidates repeated a selected question           |
| `below_minimum_value`         | all left-out candidates were below the minimum worth asking    |
| `mixed_causes`                | both kinds                                                     |

Examples (equal pools of six valid candidates, different causes — `select-shortfall.test.ts`):

- six below the minimum → `below_minimum_value`, 0 selected: “6 valid candidates were generated and 0 were selected. The other 6 were left out because the value of asking each … was below the minimum worth asking.”
- six repeats of one question → `redundant_candidates`, 1 selected, 5 repeats.
- two good, two repeats, two low → `mixed_causes` with “2 … repeated … and 2 … below the minimum”.
- five distinct among six → no shortfall.

Every shortfall ends with “The list is not padded: the uncertainties listed below are what is still open for your own questions.” and the page lists which uncertainties are
covered by the selected questions and which remain open for manual follow-up. The same pool in any order gives the same selection and the same words.

**Versioning.** New sets are stored with `question-engine/v2`, `excluded_redundant` and `excluded_below_minimum`. Sets stored under `v1` are **not** reinterpreted or
back-filled: they keep their stored wording, their counters read `NULL`, and a `v1` `redundant_candidates` set is returned with a `policyNote` saying that policy v1 could not
tell a repeat from a below-minimum value and that the wording may describe the second case as the first. The page shows that note.

## 8. Migration compatibility

`0024_m6_r1_generation_claims` is additive and idempotent (re-runnable, as `docs/MIGRATIONS.md` §6.4 requires): new table + FK + index, two nullable columns on
`question_sets`, a new CHECK `question_sets_excluded_shape`, and `question_sets_shortfall_shape` dropped and re-added to admit the two new codes. Every existing row satisfies
the widened constraint; no row is rewritten. The journal `when` increases monotonically (`db:check`). An application from before 0024 can still read the new schema; a 0024
application refuses to start on an older one (`SchemaNotReadyError`). Checked: `pnpm db:check` (journal chronology + `drizzle-kit check`) → "Everything's fine"; `pnpm db:generate` → "No schema changes, nothing to migrate"; a fresh PostgreSQL 16 ICU database migrated with `pnpm db:migrate` (25 bookkeeping rows) and `pnpm db:verify-schema` reported `journal problems: 0`, `migrations not applied: none`, `schema objects missing: 0`.

## 9. Validation

All gates were run on the final, **unmutated** implementation (every mutation restored; the restored code re-ran green after each one and in the final runs below).

| Gate                                                                                                                         | Result                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                                                          | pass                                                                                                                               |
| `pnpm lint` (`--max-warnings=0`)                                                                                             | pass                                                                                                                               |
| `pnpm typecheck`                                                                                                             | pass (all workspaces)                                                                                                              |
| `pnpm db:check` (journal chronology + drizzle check); `pnpm db:generate`                                                     | pass; "No schema changes"                                                                                                          |
| `pnpm db:verify-schema` on a fresh migrated PostgreSQL 16 ICU database                                                       | 0 journal problems, 0 unapplied, 0 missing objects                                                                                 |
| `pnpm build`                                                                                                                 | pass                                                                                                                               |
| `git diff --check`                                                                                                           | clean                                                                                                                              |
| Full suite, **PGlite** (`pnpm test`, final code)                                                                             | **242 files passed, 6 skipped (248); 4 360 tests passed, 61 skipped, 2 todo; 0 failed**                                            |
| Full suite, **PostgreSQL 16.15, ICU** (`judge_r1full_test`, `locale_provider icu`, `icu_locale en-US`, `LC_COLLATE C.UTF-8`) | **248 files passed (248); 5 445 tests passed, 1 skipped, 4 todo; 0 failed**                                                        |
| Focused concurrency + store + migration + scope tests on PostgreSQL 16 (real concurrent connections)                         | 5 files, 146 tests passed (`question-engine-r1` 18, `question-engine-http`, `question-set-store`, `migrations`, `milestone-scope`) |
| Chromium (`pnpm test:browser`, four journeys incl. the M6 shortfall-truthfulness assertions)                                 | 4 files, 43 tests passed                                                                                                           |
| Targeted mutations (§10)                                                                                                     | 21 killed (incl. V2b, and C8 after strengthening); 1 equivalent mutant (V2) explained; negative controls green                     |

Counts relative to M6 (`0ae02eb`): PostgreSQL 16 went from 245 files / 5 375 tests to 248 files / 5 445 tests. The skipped and todo counts are unchanged
by this repair except where PostgreSQL-only tests are skipped on PGlite, as before. No test was removed or weakened; the baseline-reproduction file
`packages/questions/src/r1-repro.test.ts` was folded into the permanent `accusation-context.test.ts` and `select-shortfall.test.ts` (same assertions, broader coverage), and the API
reproductions live on in `tests/integration/question-engine-r1.test.ts`.

The tests make no external network call; every provider is a scripted or replay demonstrator.

## 10. Mutation results

Each mutation was applied to the real implementation, the named tests were run, the file was restored, and the **same tests were run again on the restored code**
(negative control: they pass). Harness: a scratchpad script with per-mutation old/new text; a mutation whose pattern no longer matched was reported as such and fixed, not counted.

| ID  | Mutation (what was broken)                                                         | Tests                    | Result                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | cross-process coordination removed: every request acquires the claim               | `question-engine-r1`     | KILLED (5 failed)                                                                                                                                        |
| C2  | a live, unexpired running claim can be taken over                                  | `question-engine-r1`     | KILLED (5 failed)                                                                                                                                        |
| C3  | an expired claim is never taken over (abandoned claim blocks forever)              | `question-engine-r1`     | KILLED (3 failed)                                                                                                                                        |
| C4  | fencing removed: a stale holder may publish                                        | `question-engine-r1`     | KILLED (2 failed)                                                                                                                                        |
| C5  | a failure is not recorded on the claim (no shared failure, no cool-down)           | `question-engine-r1`     | KILLED (1 failed)                                                                                                                                        |
| C6  | no recheck that the assessment still verifies before publishing                    | `question-engine-r1`     | KILLED (1 failed)                                                                                                                                        |
| C7  | heartbeat removed: a live holder's lease lapses                                    | `question-engine-r1`     | KILLED (1 failed)                                                                                                                                        |
| C8  | a claim won just after another publication still calls the provider                | `question-engine-r1`     | **SURVIVED at first** → test added (`a claim won just AFTER another request published…`) → KILLED (1 failed)                                             |
| V1  | void preflight bypassed (provider reached for a voided project)                    | `question-engine-r1`     | KILLED (2 failed)                                                                                                                                        |
| V2  | in-transaction void check removed **alone**                                        | `question-engine-r1`     | SURVIVED: _equivalent mutant_ — the migration-0023 DB guard raises and the translation (V3) still answers `PROJECT_VOIDED`. Defence in depth, not a gap. |
| V2b | in-transaction void check **and** the guard translation removed                    | `question-engine-r1`     | KILLED (1 failed)                                                                                                                                        |
| V3  | the database guard's refusal is no longer recognised (incorrect error translation) | `question-engine-r1`     | KILLED (1 failed)                                                                                                                                        |
| V4  | the void refusal answers a generic error instead of the typed one                  | `question-engine-r1`     | KILLED (4 failed)                                                                                                                                        |
| W1  | overbroad accusation vocabulary: official titles no longer set aside               | `packages/questions`     | KILLED (7 failed)                                                                                                                                        |
| W2  | team words no longer set aside in attributed sentences                             | `packages/questions`     | KILLED (2 failed)                                                                                                                                        |
| W3  | the accusation guard removed from the reason                                       | `packages/questions`     | KILLED (2 failed)                                                                                                                                        |
| W4  | any phrase the candidate mentions is accepted as an official title                 | `packages/questions`     | KILLED (2 failed)                                                                                                                                        |
| W5  | titles match inside longer words                                                   | `packages/questions`     | KILLED (1 failed)                                                                                                                                        |
| S1  | cause calculation removed (below-minimum candidates not counted)                   | questions + `r1`         | KILLED (3 failed)                                                                                                                                        |
| S2  | every left-out candidate called a repeat (inferred from the pool)                  | questions + `r1`         | KILLED (14 failed)                                                                                                                                       |
| S3  | the policy-v1 note dropped                                                         | `question-engine-r1`     | KILLED (1 failed)                                                                                                                                        |
| S4  | the page invents its own cause instead of the stored one                           | web `questions.test.tsx` | KILLED (3 failed)                                                                                                                                        |

Two mutants needed attention: **C8** survived the first run, which showed that the "claim won just after another publication" path had no deterministic test; the test was added (it makes the store report "no set" twice, then lets the real publication through, and asserts zero provider calls, `200 already_generated` and no claim row left) and C8 is now killed. **V2** (removing only the explicit in-transaction void check) survives because the database guard plus its translation give the identical, correct answer — it is an equivalent mutant, and V2b (removing both) is killed. Two harness patterns (C1, S3) initially did not match the formatted source and were corrected before being counted.

## 11. Residual risks (tracked, not fixed here)

The R9A **P3** findings are recorded and deliberately left as they are; the ranking heuristic was not redesigned in this repair.

| ID   | Finding (from R9A)                                                 | Status / risk                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-a | relevance inflation when one candidate cites several uncertainties | open — can rank a multi-citation question higher than its evidence warrants; ranking is a decision aid, the judge chooses. Candidate for a ranking-policy revision (new policy version) |
| P3-b | acronym collisions in the novelty/overlap comparison               | open — two unrelated questions sharing an acronym can look more alike than they are, which can only make selection more conservative (fewer than five), never invent evidence           |
| P3-c | gaps in leading-phrasing detection                                 | open — the accusation/leading guard is a heuristic (§6); human review of questions remains the control                                                                                  |

Additional limits found or kept while repairing:

1. **Provider invocation is not exactly-once across crashes** (§4). Publication is at-most-once.
2. **The wording guard is a heuristic**, fails closed on ambiguous sensitive words, and is not a semantic-safety guarantee.
3. **`v1` question sets keep v1 wording** (with a `policyNote`); they are not re-classified because the excluded counts were not recorded.
4. The default waits (lease 60 s, heartbeat 15 s, poll 200 ms, wait 20 s, cool-down 5 s) are constants of `DEFAULT_GENERATION_COORDINATION`; they have not been tuned against any real provider latency.
5. **R9A's own artefacts were unavailable**; the four failures were reproduced from their description, not from R9A's scripts.
6. PostgreSQL 16 was exercised with an ICU-provider database only (as in M6).

## 12. M7 implications

- Answer collection (M7) will add answers and new evidence tied to a question set; it can rely on: immutable question sets, the generation identity, the fencing/lease
  pattern (reusable for any long-running per-identity work), `PROJECT_VOIDED` as a refusal for new work, and `policyVersion` on every set.
- M7 must treat `v1` and `v2` sets alike for answers (the selection policy does not change what a question is) but display `policyNote` for `v1`.
- If a metered provider is ever authorised, the provider-invocation limit (§4) must be closed first; that is **not** authorised here.

## 13. Verdict

```
M6_R1: READY_FOR_R9B
FIVE_QUESTION_WORKFLOW: PASS
M7_READINESS: READY_FOR_REVIEW
LIVE_MODEL_READINESS: NOT AUTHORIZED
```

`READY_FOR_R9B` means every gate in §9 passed and the four findings are fixed with regression evidence; it is not an acceptance. R9B should retest the four failures independently. Not done here, by instruction: merge, deploy, live model,
paid inference, M7.
