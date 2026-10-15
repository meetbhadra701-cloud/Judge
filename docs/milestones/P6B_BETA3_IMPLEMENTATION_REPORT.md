# P6B-β3 — Evidence Coverage, Source Identity and Capture Safety: implementation report

**Verdict: `READY_FOR_R7D`** (every required gate below passed; the limits that remain are listed in §8 and §10 and none is hidden).

Nothing in this milestone enables a live model, a paid model call, question generation or final reassessment. The ledger was never written to by any of the work described here (every test uses scripted or replayed providers; see §9.6).

## 1. Baseline and new commits

|                   |                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted baseline | `f0d861bdaa2c66cd647061cb05cfda6eabb0efd5` (branch `claude/p6b-beta2-real-capture`), verified as an ancestor of the new branch                                                                                                    |
| New branch        | `claude/p6b-beta3-coverage-identity` (no accepted commit rewritten, no force-push)                                                                                                                                                |
| Final commit      | the tip of the branch (a report cannot contain its own commit id; the exact SHA is verified against the remote and given in the hand-off message). Last implementation commit before the browser tests and this report: `d158374` |

Commits on top of the baseline, oldest first:

```
8668b6c P6B-beta3 (checkpoint 1): identity registry for every write path; safe output paths
ef0f1d7 P6B-beta3 (checkpoint 2): evidence-coverage experiments, oracle, thresholds, v1 baseline
59424ea P6B-beta3: source-selection/v2 with coverage report, coverage gate and assessor notices
7ffdb94 P6B-beta3: component-fair capture order, secondary rate limits, class-reserved prose heads, larger real recording
7539429 P6B-beta3: recovery without a worker, organizer-supplied Devpost text, docs and threat-model review
af7dd1e P6B-beta3: per-bucket file-share metric, typed test fixes
ce21888 P6B-beta3: pin the new configuration identity, keep v1-frozen configurations valid
c568ea7 P6B-beta3: re-run a request that lost an identity race so the application gives the precise answer
ab35255 P6B-beta3: drop the redundant per-file cap passes; tests that kill the surviving selection, writer and cancellation mutants
d158374 P6B-beta3: lint fix in the coverage oracle test
```

## 2. Root causes

### 2.1 R9-B1 — misleading evidence coverage (traced end to end)

The path is: GitHub capture → artifact routing → windowing/selection → token budgeting (preflight) → extraction → assessor input → report limitations. Findings, each reproduced before it was changed:

1. **Capture order** (`compareSelection`): priority, then depth, then path across the whole repository. For a repository above the 400-file limit the alphabet decided which packages existed in the snapshot at all (reproduced: a 30-package synthetic repository kept the first few packages and lost the rest). On the real 410-candidate capture the loss was small (the cap was _not_ the main cause there) but real: 7 of 14 `apps/web` files were dropped.
2. **Selection v1** consumed whole files one after another in a fixed order and closed a bucket at the first passage that did not fit. It ranked every document equal, so the alphabetical tie-break let `CHANGELOG.md` starve `README.md` (huge-README experiment: **0 of 1,500,000** README code points shown). It grouped a monorepo's packages as one top-level directory (`packages`), so shallow manifests were read before any package's source. Tests and generated snapshots competed with implementation on equal terms (tests were **52 %** of the shown source; one document used **59 %** of the prose budget).
3. **The detail was discarded.** Windowing recorded _that_ a bucket was sampled, never _which_ artifacts or ranges. The assessor's `notices` were empty unless its own candidate list was cut (`partial_capture` was never set by any code); a partly seen repository was assessed as if it were whole.
4. **Nothing stopped an assessment of an unseen implementation.** No component of the pipeline asked whether the implementation had been seen at all.

Reconciliation of the real case (reconstructed from metadata, `tests/fixtures/real-github/coverage-profile-judge-9459c98.json`): 404 artifacts = 108 fully visible + 2 partial + 291 excluded by budget + 3 skipped by routing — exactly R7C's count (the harness shows the same as 110 artifacts with at least one passage, `budget_exhausted` 293 of which 2 are the partial ones, 3 skipped).

### 2.2 R9-1 — identity race between the legacy routes and submissions

Before 0019 only a recorded _submission_ wrote to `project_submission_claims`. The earlier project/source routes were guarded by _reading_ other projects' rows, and a concurrent transaction's uncommitted rows are invisible to a read. A legacy declaration and a submission (two legacy declarations, two labels differing by case, a correction racing a plain submission) could each find the identity free and both commit. Reproduced with held transactions before the repair (`beforeLegacyWrite`/`afterLegacyWrite` seams: both contenders decide on stale state, then both commit); the same cases are the permanent regression tests and are killed by mutants I2/I3 below, which restore the old design.

### 2.3 R9-7 — hostile repository paths escaping `capture:smoke --out`

`apps/worker/src/testing/real-capture-smoke.ts` did `join(out, 'artifacts', key)` for every artifact key, and keys come from the repository's tree. `files/../../../escaped.txt` resolves outside `--out` (reproduced; `safe-output.test.ts` keeps the reproduction as a test). No other code turns an artifact key into a file name (checked: the API serves artifacts by id from the database; the web renders keys as text).

## 3. Evidence-selection results — before and after at identical budgets

Budgets for every row: statement 120,000, source 240,000, metadata 30,000 code points (the production defaults). The thresholds were **committed before v2 was written** (`packages/assessment/src/testing/coverage-thresholds.ts`, commit `ef0f1d7`), measured by an oracle (`testing/coverage-metrics.ts`) that imports no selection code. The v1 baseline is kept as characterization tests, and v1 remains selectable (`SELECTION_POLICY_V1`).

| Threshold (fixed beforehand)                                                        | Value                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| implementation components with ≥ 1 shown file                                       | ≥ 0.9 (≥ 0.5 above 100 components)                              |
| one file's share of its bucket while another eligible file of that bucket is unseen | ≤ 0.25 (+ one 1,200-code-point passage of granularity)          |
| root README                                                                         | first 6,000 code points (or all)                                |
| deployment files (when ≤ 10 % of the source budget together)                        | head of every one                                               |
| tests' share of shown source while some component is uncovered                      | ≤ 0.30                                                          |
| generated files' share while distinct implementation is unseen                      | ≤ 0.10                                                          |
| budget used when more is eligible than fits                                         | ≥ 0.98                                                          |
| coverage metadata vs the oracle's recomputation                                     | exact                                                           |
| hostile instructions in files; any permutation of the input                         | selection and result unchanged                                  |
| v2 never worse than v1 on any of the above                                          | and strictly better on component coverage in the monorepo cases |

Results (all thresholds met; `packages/assessment/src/coverage-experiments.test.ts`, 42 tests):

| scenario                                     | implementation components seen, v1 → v2 | largest single file's share of its bucket, v1 → v2 | root README shown, v1 → v2 | tests' share of shown source, v1 → v2 | coverage verdict (v2) |
| -------------------------------------------- | --------------------------------------- | -------------------------------------------------- | -------------------------- | ------------------------------------- | --------------------- |
| conflicting-documentation-and-implementation | 1/1 → 1/1                               | 0.029 → 0.029                                      | 2840/2840 → 2840/2840      | 0 → 0                                 | complete              |
| deployment-in-other-directories              | 1/1 → 1/1                               | 0.050 → 0.034                                      | 4000/4000 → 4000/4000      | 0 → 0                                 | partial               |
| duplicates-and-generated                     | 2/2 → 2/2                               | 0.417 → 0.250                                      | 4000/4000 → 4000/4000      | 0 → 0                                 | partial               |
| huge-readme                                  | 1/1 → 1/1                               | 0.943 → 0.438                                      | 0/1500000 → 52514/1500000  | 0 → 0                                 | partial               |
| implementation-late-in-traversal             | 4/21 → 21/21                            | 0.042 → 0.042                                      | 5000/5000 → 5000/5000      | 0.15 → 0.096                          | partial               |
| large-monorepo                               | 1/22 → 22/22                            | 0.100 → 0.075                                      | 7300/7300 → 7300/7300      | 0.75 → 0.149                          | partial               |
| large-test-suites                            | 1/1 → 1/1                               | 0.037 → 0.033                                      | 4000/4000 → 4000/4000      | 0.696 → 0.696                         | partial               |
| many-tiny-files                              | 1/1 → 1/1                               | 0.021 → 0.021                                      | 2500/2500 → 2500/2500      | 0 → 0                                 | partial               |
| real-judge-404                               | 3/18 → 18/18                            | 0.590 → 0.061                                      | 7307/7307 → 7307/7307      | 0.525 → 0.158                         | partial               |
| small-simple                                 | 1/1 → 1/1                               | 0.025 → 0.025                                      | 3000/3000 → 3000/3000      | 0.149 → 0.149                         | complete              |

**The real 404-artifact case**

|                                                         | v1                            | v2                                                               |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| implementation components with a shown file             | 3 / 18                        | **18 / 18**                                                      |
| implementation files with a shown passage               | 21 / 170                      | **151 / 170**                                                    |
| implementation code points shown                        | 86,267 / 888,902 (9.7 %)      | **157,013 / 888,902 (17.7 %)**                                   |
| prose files with a shown passage                        | 7 / 40                        | **40 / 40**                                                      |
| prose code points shown                                 | 119,393 / 397,987 (30 %)      | 118,954 / 397,987 (30 %) — the 120,000 prose budget is the limit |
| manifests / config files seen                           | 16/19, 36/60                  | **19/19, 59/60**                                                 |
| largest file's share of its bucket                      | 59 % (`docs/ARCHITECTURE.md`) | **6.1 %** (`README.md`)                                          |
| tests' share of shown source                            | 52.5 %                        | **15.8 %**                                                       |
| artifacts: full / partial / unseen / skipped by routing | 108 / 2 / 291 / 3             | **132 / 176 / 93 / 3**                                           |

Honest reading: v2 sees every component and 89 % of implementation _files_, but only 17.7 % of implementation _code points_ — most files are read by their head, and the verdict for this repository is **`partial`**, not `complete`. The budget, not a bug, is the remaining constraint, and the pipeline says so (§5).

**Other scenarios worth reading.** `huge-readme`: README shown 0 → 52,514 of 1,500,000 code points; its 43.8 % share is allowed because every other prose file is already fully shown (work conservation). `large-test-suites`: tests are still 69.6 % of the shown source — the repository is almost all tests, there is one implementation component, and it is fully seen; the threshold applies only while components are uncovered. `implementation-late-in-traversal`: 4/21 → 21/21 components.

**Oracle refinements made after the first v2 run (disclosed, not hidden).** (1) A deployment file's "head shown" means its first passage was shown (passages end at line boundaries, so the first may hold fewer than 1,200 code points); (2) byte-identical copies of a shown file no longer count as unseen implementation (a copy carries no unseen content); (3) the "one file ≤ 25 %" threshold, first measured over the source bucket only, is now judged per bucket, which is what its text always said. No threshold value was changed. The per-file cap passes of v2 were later removed as redundant (a mutation run showed they changed nothing the round-robin did not already guarantee); results on the corpus are identical except `huge-readme` (README 47,938 → 52,514), still within every threshold.

## 4. Full artifact coverage accounting

Every artifact is accounted for exactly once (asserted in the experiments): `full`, `partial`, `unseen`, `duplicate` (a byte-identical copy of a shown file, naming it), or skipped by routing with its stable reason. `WindowingResult.coverage` carries, per artifact: role, component, status, total and shown code points, the exact `shownRanges` and `unshownRanges` (offsets into the original text; recomputed independently by the oracle, tolerance 0), and per component the implementation files and code points shown. Provenance to source file, snapshot and range is the existing `(snapshotId, artifactKey, start, end)` of every passage.

## 5. Selection and omission semantics

- **Policy `source-selection/v2`** (`selection-v2.ts`, `repository-roles.ts`; docs/ARCHITECTURE.md "Evidence coverage"): heads before depth, fair across components in a fixed scrambled (not alphabetical) order, roles from the path alone, a guaranteed share for deployment/manifest/config and a reserved share for tests, duplicates reported not counted, work-conserving. It never reads file content (a test with hostile instructions in the files moves nothing) and is invariant under any permutation of its input.
- **What an unseen range means:** _unknown_. It is never evidence of absence, of quality or of copying. Duplicates, generated files and the budget are the only reasons a range is unshown; each is recorded.
- **Verdicts** (`COVERAGE_POLICY`): `insufficient` — implementation exists and none of it was shown, or fewer than half of its components have a shown file; `partial` — anything eligible went unshown; `complete`.
- **Enforced now:** `insufficient` stops the run **before any spend** (`source_unavailable` / `source_coverage_insufficient`; the web page explains it) and is never turned into a low score. `partial` is disclosed as report limitations (`source_sampled`, `implementation_components_unseen`, `implementation_partially_seen`, `documentation_partially_seen`, `configuration_partially_seen`, `tests_partially_seen`; bounded sorted subjects, true counts) **and** as the closed notices `sampled_source` / `partial_capture` on **every** dimension's input. Canonical score calculations are untouched.
- **Reproducibility:** the policy id is part of the frozen pipeline configuration. A configuration frozen under v1 is still accepted and reproduced by v1 (test). The canonical hash of a _new_ configuration changed deliberately (pinned values updated with the reason in the test).
- **Capture** takes README and manifests first, then one file of every component before a second of any (`orderCandidatesForCapture`; a parity test pins capture's and selection's definition of "component" together).
- **Gated for later (documented exactly in ARCHITECTURE.md):** a reviewer-visible "assess with partial coverage" flow; read-only recomputation of coverage for historic runs; per-dimension coverage requirements (which part of a repository a criterion needs); a second, deeper pass over parts the first left unseen.

## 6. Concurrency race: reproduction and repair

- **Repair (migration `0019_p6b_beta3_identity_registry`, hand-written, no existing migration edited):** `project_claim()` inserts `(event, kind, value)` with `ON CONFLICT DO NOTHING` and re-checks ownership in a new snapshot; a second writer of the same key _waits_ on the unique index until the first transaction ends, then yields. Triggers on `projects` (label), `project_sources` (GitHub/Devpost) and `project_submissions` call it in the same transaction as the row. One serialization point for every route.
- **Scenarios, all with two or more independent PostgreSQL connections** (`tests/integration/identity-races.test.ts`): legacy source vs submission (GitHub and Devpost links), two legacy declarations, same URL with different names, case-colliding labels (legacy vs submission, legacy vs legacy), a correction releasing a pair vs a plain submission of that pair, void vs a source declaration on the same project, cross-event separation, a lost response retried with the same key. **Independent operating-system processes** (`identity-processes.test.ts`: two `tsx` children with different pids, file rendezvous, hold-before-commit): legacy vs submission ×3 rounds, two legacy declarations, case-colliding labels, two processes with the same key. PGlite runs the same suites sequentially (its single connection cannot race).
- **Historical data untouched:** the backfill claims only the unambiguous and skips (`DO NOTHING`) what was already shared; `registryProblems` in `GET /events/:id/submission-integrity` reports a missing claim, a stale claim and an identity held by several projects, computed from the base tables; reading it changes nothing.
- **One flake found by the PG16 run and fixed:** when two submissions shared a GitHub link their _derived names_ also collided, so under load the loser could be refused on the label (`PROJECT_NAME_TAKEN`) instead of the link (`SUBMISSION_CONFLICT`) depending on which claim the registry reached first. Both refusals are safe; the request is now re-run when the database refused an identity another transaction owns, so the application's checks (which read committed state) give the precise answer. The last attempt reports the database's own translation.
- **Recovery without a worker:** `POST /projects/:id/void` takes `cancelPendingWork`; it cancels only requests no worker has started (captures: snapshot `failed` with reason `cancelled_by_void`, run `cancelled`; assessments through the run store's terminal path), re-checked under row locks in the workers' lock order, in the same transaction as the void, recorded in the audit event, part of the idempotent request's identity, and refused as a whole if the correction cannot complete. A request a worker has started still blocks. The correction page has the checkbox; cancelled captures display "CAPTURE CANCELLED".

## 7. Filesystem safety evidence

Two independent barriers. (1) The adapter refuses unsafe paths (`isSafeRepositoryPath`: absolute, traversal, backslash, drive letter, empty segment, control characters) with the omission reason `unsafe_path`; the content is never fetched. (2) The smoke tool's writer (`safe-output.ts`) resolves the root once, `lstat`s every component (no symlink followed, wherever it points), creates with `O_EXCL|O_NOFOLLOW`, never overwrites (`_collisions/`, unsafe keys to `_unsafe/`), and the tool refuses a non-empty `--out`. Tests run in disposable directories beside sentinel files and assert nothing outside the root is created, changed or reached: 17 hostile keys (absolute, `..`, Windows drive/UNC/mixed separators, NUL, newline, trailing dot/space, device names, over-long), a symlinked directory, a symlink to another in-root directory, a symlink in place of the file, a symlinked root, case collisions, a file where a directory is needed, a pre-existing file; and the CLI end to end against the recorded repository with six hostile paths injected (all `unsafe_path`, six counted, nothing written outside, sentinel intact). Normal paths (unicode, dotfiles, nested) keep mirroring exactly.

## 8. Remaining Devpost limitations

- Live Devpost capture is **not** possible from this deployment: the environment's egress proxy refuses the CONNECT before the request reaches Devpost. That is an environment policy, not a statement of Devpost's rules, and it was not bypassed.
- **Permission-respecting alternative implemented:** an organizer pastes the text they can see (`POST /projects/:id/sources/:sid/supplied-content`, capture page form). It is an immutable `devpost` snapshot labelled `organizer_supplied` in its metadata, a `submission.json` note ("not fetched from Devpost … not compared with the Devpost page"), the snapshot summary, the capture-page wording "TEXT SUPPLIED BY AN ORGANIZER", and the report limitation `organizer_supplied_source`. Derived evidence is a **team claim** only. Bounded (60,000 code points), normalized, control/bidi characters refused, idempotent, replaces a fetch no worker started and never touches a running one, audit event without the text, organizers only.
- **Known gap:** the evidence _origin_ vocabulary is not split, so supplied text still carries origin `devpost` (with `team_claim`) and is distinguished by the limitation and the labels, not by a separate origin. The Devpost URL field is unchanged and still required for identity.
- **Real-source readiness for Devpost stays BLOCKED** until a person has demonstrated the input path on a real submission; the tests demonstrate it only on synthetic text. The adapter is verified only against synthetic markup.

## 9. Test results and mutation evidence

### 9.1 `pnpm check` (format, lint, typecheck, database check, tests, build)

Run on the final tree: format ✓ · `eslint . --max-warnings=0` ✓ · typecheck (all packages and apps) ✓ · `db:check` ✓ · **PGlite suite: 204 files passed, 6 skipped; 3,865 tests passed, 61 skipped, 3 todo; 0 failed** · build ✓ (exit 0).

### 9.2 Full PostgreSQL 16.15 (ICU) suite

Full suite against PostgreSQL 16.15 with ICU collation (`TEST_DATABASE_URL`, disposable database): **210 files passed, 0 failed; 4,798 tests passed, 1 skipped, 6 todo (4,805)**. The first PostgreSQL run of this milestone had one failure, `submission-intent` R7-1 (a flaky error code under load, §6); it was repaired and the final run above is green. The identity race and independent-process suites (`identity-races`, `identity-processes`) run only here and passed.

### 9.3 Chromium browser tests

`pnpm test:browser` (real Chromium against the built web app, the real API and worker on PGlite, synthetic fixture network): **1 file, 18 tests passed**, including two new journeys — cancelling unstarted work through the correction page's checkbox (cancelled captures show "CAPTURE CANCELLED") and pasting the Devpost text (labelled "TEXT SUPPLIED BY AN ORGANIZER", pasting it again stores nothing). The first browser run failed one existing test whose expected wording changed with the recovery text; the expectation was updated, not weakened.

### 9.4 Mutation tests

Method (as in β2): one source mutation at a time, the file restored in a `finally`, the named tests run on PGlite and on PostgreSQL 16; a mutant is _killed_ when a test fails. The harness reads an aborted suite (a `beforeAll` error) as "survived"; those are noted.

| mutant                                       | PGlite                    | PostgreSQL 16             | note                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1-claim-recheck-removed                     | SURVIVED (35 passed (35)) | KILLED (3 failed)         | PGlite cannot race (one connection); killed on PostgreSQL by the race and process tests                                                                                                                                     |
| I2-project-label-not-claimed                 | KILLED (3 failed)         | KILLED (7 failed)         |                                                                                                                                                                                                                             |
| I3-source-link-not-claimed                   | KILLED (1 failed)         | KILLED (5 failed)         |                                                                                                                                                                                                                             |
| I4-claim-steals-on-conflict                  | KILLED (34 failed)        | KILLED (74 failed)        |                                                                                                                                                                                                                             |
| I5-claims-truncate-allowed                   | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| I6-backfill-name-without-skip                | suite aborted (3 skipped) | suite aborted (6 skipped) | killed: the migration aborts with a duplicate-key error in `beforeAll` (shown as "skipped" tests; the harness reads that as survived — verified by hand)                                                                    |
| V1-no-per-file-cap                           | survived                  | survived                  | code deleted: a mutation run showed the cap passes changed nothing the one-passage-per-visit round-robin does not already guarantee; corpus results identical except `huge-readme` (within thresholds)                      |
| V2-component-order-alphabetical              | KILLED (1 failed)         | KILLED (1 failed)         | survived the first run; a test was added in this milestone and the re-run kills it                                                                                                                                          |
| V3-duplicates-not-suppressed                 | KILLED (1 failed)         | KILLED (1 failed)         |                                                                                                                                                                                                                             |
| V4-prose-class-no-reserve                    | KILLED (3 failed)         | KILLED (3 failed)         |                                                                                                                                                                                                                             |
| V5-no-test-reserve-cap                       | KILLED (2 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| V6-head-ignores-waiting-files                | KILLED (1 failed)         | KILLED (1 failed)         |                                                                                                                                                                                                                             |
| V7-verdict-never-insufficient                | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| V8-unshown-range-from-zero                   | KILLED (7 failed)         | KILLED (7 failed)         | survived the first run; a test was added in this milestone and the re-run kills it                                                                                                                                          |
| V9-coverage-gate-removed                     | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| V10-notices-dropped                          | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| V11-partial-capture-notice-dropped           | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| V12-limitation-subjects-uncapped-count-wrong | KILLED (1 failed)         | KILLED (1 failed)         | survived the first run; a test was added in this milestone and the re-run kills it                                                                                                                                          |
| V13-spill-pass-removed                       | survived                  | survived                  | code deleted with V1 (same reason)                                                                                                                                                                                          |
| V14-policy-config-forced-v1                  | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| C1-capture-order-by-alphabet                 | KILLED (1 failed)         | KILLED (1 failed)         |                                                                                                                                                                                                                             |
| C2-backslash-path-allowed                    | KILLED (3 failed)         | KILLED (3 failed)         |                                                                                                                                                                                                                             |
| C3-writer-follows-symlinks                   | KILLED (1 failed)         | KILLED (1 failed)         | survived the first run; a test was added in this milestone and the re-run kills it                                                                                                                                          |
| C4-writer-overwrites                         | KILLED (2 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| C5-secondary-limit-not-detected              | KILLED (4 failed)         | KILLED (4 failed)         |                                                                                                                                                                                                                             |
| C6-retry-after-uncapped                      | KILLED (1 failed)         | KILLED (1 failed)         |                                                                                                                                                                                                                             |
| S1-supplied-not-labelled                     | KILLED (3 failed)         | KILLED (5 failed)         |                                                                                                                                                                                                                             |
| S2-control-characters-allowed                | KILLED (7 failed)         | KILLED (9 failed)         |                                                                                                                                                                                                                             |
| S3-supply-any-source-type                    | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| S4-supply-dedupe-removed                     | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| S5-supply-touches-running-fetch              | SURVIVED (13 passed (13)) | SURVIVED (26 passed (26)) | EQUIVALENT: `cancelPendingCapture` re-checks the run state itself and refuses, so the earlier check only gives the same answer sooner (defence in depth)                                                                    |
| S6-supply-limitation-dropped                 | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| S7-cancel-ignores-running                    | KILLED (1 failed)         | KILLED (2 failed)         | survived the first run; a test was added in this milestone and the re-run kills it                                                                                                                                          |
| S8-cancel-flag-not-in-request-hash           | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| S9-capture-cancel-skips-pending-recheck      | SURVIVED (22 passed (22)) | SURVIVED (44 passed (44)) | EQUIVALENT: a pending run implies a pending snapshot (database invariant); the extra re-check is defence in depth                                                                                                           |
| S10-assessment-cancel-state-unchecked        | KILLED (1 failed)         | KILLED (2 failed)         |                                                                                                                                                                                                                             |
| I7-identity-refusal-never-retried            | —                         | —                         | not deterministically killable: it removes the re-run that makes the loser's error code stable under load (the flake the PG16 run exposed); covered by `submission-intent` R7-1 only probabilistically. Stated, not claimed |

37 mutants defined; 28 killed on both targets in the first run, 5 more after strengthening tests (V2, V8, V12, C3, S7), 1 killed on PostgreSQL only by nature (I1: PGlite has one connection), 1 killed by an aborted migration (I6), 2 removed as redundant code (V1, V13), 2 equivalent defence-in-depth (S5, S9), 1 not deterministically killable and stated as such (I7).

### 9.5 Other gates

`git diff --check` clean · `pnpm db:generate` produces no pending migration (checked by `db:check`) · no existing migration edited (only `0019` added, with its journal entry and snapshot) · no network access in tests · no secrets (the extended recording was scanned for token/key patterns).

### 9.6 No model execution, no spending

The assessment tests run on scripted/replayed providers; the coverage gate test asserts zero provider calls and zero ledger rows when coverage is insufficient. No test or tool in this milestone configures a live provider.

## 10. Remaining pre-live blockers

1. A reviewer-visible way to proceed (or deliberately not) on a `partial` repository, and per-dimension coverage requirements (§5, "gated").
2. Devpost input path demonstrated on a real submission (§8); evidence-origin vocabulary for organizer-supplied text.
3. Capture still cannot fetch more than the file/byte limits allow; a second, deeper pass over the unseen part does not exist.
4. Roles are global: organizers of unrelated events must not share one deployment (`docs/SECURITY.md` §17; characterized by `cross-event-authorization.test.ts`, deliberately not redesigned).
5. Unauthenticated GitHub capture reads ~55 files/hour/IP; real use needs a read-only `GITHUB_TOKEN`.
6. Recorded real fixtures cover one repository (the only one this environment can reach); a second language/structure could not be recorded here. The recording was extended with 36 further real blobs (forty-file capture).

## 11. Recommended next milestone

**P6B-γ — one genuine preliminary assessment.** Build the reviewer-visible coverage decision (proceed / abstain / widen), per-dimension coverage requirements and the deeper second pass; split the evidence origin for organizer-supplied text; then, with a real Devpost submission pasted by an organizer and a read-only GitHub token, run exactly one preliminary assessment of one real project under an explicit, small budget approved by the owner (the first and only step that enables a live model), and have R7 review that run's report against the coverage it records.
