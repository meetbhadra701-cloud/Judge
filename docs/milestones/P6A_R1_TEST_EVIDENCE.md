# P6A-R1 — Test evidence

Code commit under test: `2423138862853dfe2565ead11e2f043e02f3dd9b` (branch `claude/m5-pre-interview-assessment`, parent `0932bc879f07eb5568510809dd77029126bd1d74`).
Environment: Node, vitest 5.0.3, PGlite (in-process) and a local PostgreSQL **16.15** server (Ubuntu build; database created with the ICU locale `en-US`;
`TEST_DATABASE_URL` points at a disposable `*_test` database that each file rebuilds). No network model call, no credential, no provider.
These are implementation tests. They are **not** an independent review (R6B).

## 1. Gates

| Gate                                                  | Result                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                   | "All matched files use Prettier code style!"                                                                                                             |
| `pnpm lint` (`eslint . --max-warnings=0`)             | clean                                                                                                                                                    |
| `pnpm typecheck`                                      | clean (all packages and apps, including `apps/web` with the new `.tsx` test)                                                                             |
| `pnpm db:check`                                       | "Everything's fine"                                                                                                                                      |
| `pnpm db:generate`                                    | "No schema changes, nothing to migrate" (this remediation adds **no** migration)                                                                         |
| `pnpm build` (all packages, `next build`)             | success                                                                                                                                                  |
| `pnpm check` (the five above + the full PGlite suite) | **exit 0** — `Test Files 170 passed \| 5 skipped (175)`, `Tests 2734 passed \| 57 skipped \| 3 todo (2794)` (was 2675 at P6A: +59)                       |
| Full suite on PostgreSQL 16 (`TEST_DATABASE_URL`)     | **exit 0** — `Test Files 175 passed (175)`, `Tests 3427 passed \| 1 skipped \| 6 todo (3434)` (was 3348 + 1 flaky failure at P6A: +79, 0 failed)         |
| `git diff --check`                                    | clean                                                                                                                                                    |
| Diff review                                           | `git diff --name-status 0932bc8 HEAD`: 21 paths, all intended (listed in the remediation report); no migration, no scoring, no prompt, no unrelated file |

The 57 PGlite-run skips are the PostgreSQL-only suites; the single PG16 skip and 6 todos are pre-existing (the 3 PGlite todos are the F-2 placeholders).

## 2. R6A attack cases — exact before / after

Method: the unchanged P6A `assessment-read.ts` (`0932bc8`) and the remediated one were each run over the same five attacks on a PGlite database. Each attack builds
a real, verified, fully scored assessment (two dimensions at 7, rationale and cited evidence present) through the real pipeline with the replay provider, applies one
corruption (immutability trigger disabled only for that statement), then calls `getDetail` and `list`. Raw output: `r1-diff-before.json`, `r1-diff-after.json`
in the session scratchpad; the table is a transcription.

| #   | Attack                                                                          | BEFORE (P6A `0932bc8`) detail                                                                                                       | AFTER detail                                                                                                                          | list before → after                                                      |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A1  | JSONB mirror edited (`overall.score10 → 10`)                                    | `verified:false`, `failure: jsonb_mirror`, `report:null`, **2 judgments, scores `[7,7]`, rationale EXPOSED, evidence text EXPOSED** | `verified:false`, `failure: jsonb_mirror`, `report:null`, **0 judgments, `scores:[]`, no rationale, no evidence text, 0 limitations** | `verified:false, overall:null` → same                                    |
| A2  | canonical report text altered (`score10 7→9`)                                   | `verified:false`, `text_hash`, report null, **scores `[7,7]`, rationale + evidence EXPOSED**                                        | `verified:false`, `text_hash`, nothing else                                                                                           | same → same                                                              |
| A3  | text hash broken (`repeat('0',64)`)                                             | `verified:false`, `text_hash`, **scores `[7,7]`, text EXPOSED**                                                                     | `verified:false`, `text_hash`, nothing else                                                                                           | same → same                                                              |
| A4  | schema-invalid body (`notices` removed) with text hash + mirror made consistent | `verified:false`, `schema`, **scores `[7,7]`, text EXPOSED**                                                                        | `verified:false`, `schema`, nothing else                                                                                              | same → same                                                              |
| A5  | judgment scores `7 → 1`, report untouched and valid                             | **`verified:true`, report PRESENT (7), judgments with scores `[1,1]`** — a verified report beside contradictory numbers             | **`verified:false`, `failure: judgment_mismatch_score`, `report:null`, no judgments, no numbers, no text**                            | **`verified:true, overall:{scored,7}` → `verified:false, overall:null`** |

Additional attacks pinned in the committed hostile suite (all fail on the old code, pass on the new): body changed with every hash recomputed except the M4
`outputHash` (`output_hash`); scored → insufficient flip (`judgment_mismatch_outcome_state`); number (even `0`) claimed for an insufficient dimension
(`judgment_mismatch_outcome_state`); deleted judgment row (`…_dimension_set`); deleted citation row (`…_citations`); the same corruptions observed through the
**HTTP API** (`GET …/assessments/:id` and the list).

Old code against the committed tests (`r1-before.log`): `15 failed | 6 passed` — the 12 withheld/consistency attack tests fail for the right reason; 3 more fail
only because they read the renamed field `dispositionAttribution`.

## 3. Required coverage → tests

| Required                                            | Test (file › name)                                                                                                                                           | Targets                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Corrupted JSONB report mirror                       | `read-model.hostile.test.ts` › step 1 › corrupted JSONB mirror; `assessment-http-e2e.test.ts` › over HTTP … JSONB mirror                                     | PGlite + PG16          |
| Altered canonical text / broken text hash           | hostile › altered canonical report text; › a broken text hash                                                                                                | PGlite + PG16          |
| Schema-invalid report with valid hashes             | hostile › schema-invalid report whose text hash and mirror were made consistent; › body changed with every hash recomputed except the M4 output hash         | PGlite + PG16          |
| Modified judgment score, valid report               | hostile › step 2 › modified judgment score…; e2e › over HTTP … judgment scores that disagree                                                                 | PGlite + PG16          |
| Unverified → no judgment scores                     | `expectWithheld` (no `"score"`, `"score10"`, `"scoreOnScale"` key) in every attack test                                                                      | PGlite + PG16          |
| Unverified → no rationale / citation evidence text  | `expectWithheld` (rationale, citation note and evidence text strings absent from the serialized JSON)                                                        | PGlite + PG16          |
| Legitimately scored stays readable                  | hostile › a legitimately scored assessment is fully readable                                                                                                 | PGlite + PG16          |
| Partial keeps weight and missing-dimension behavior | hostile › a partial assessment keeps its weight… (`scored_partial`, 9, share 0.7, missing `hard_part`)                                                       | PGlite + PG16          |
| Insufficient is null, never zero                    | hostile › partial (missing dimension null, no `0` score), › an overall that is insufficient has no number; `view.test.tsx` › insufficient overall; mutant R9 | PGlite + PG16 / render |
| Cross-project isolation                             | hostile › another project…; `routes.test.ts` › 404 identity                                                                                                  | PGlite + PG16          |
| Provider gate rejects production / staging          | `runtime-gate.test.ts` (14 tests: production, staging, casings, `prod`, `preview`, blank; env schema)                                                        | process-level          |
| UI classifier rejects unverified reports            | `assessment-ui-view.test.ts` › classifies an unverified assessment as unverified however much content it carries                                             | node                   |
| UI renders no number for insufficient/unverified    | `view.test.tsx` (7 tests, `renderToStaticMarkup` of the real component)                                                                                      | node                   |
| Pure verifier                                       | `verify-judgments.test.ts` (16: every mismatch reason reachable; attribution table)                                                                          | node                   |

**Browser-level regression.** A permanent automated real-browser test is **not** in the suite: Playwright is not a repository dependency (it exists only in the
sandbox's tool directory), and adding a browser to CI is outside this remediation. What _is_ permanent is the rendered-markup test of the real component
(`view.test.tsx`). A one-off real-browser run (Chromium via Playwright, real API on a socket, real worker loop, `next start`) was done against the final build and
recorded here as manual evidence (script kept outside the repo):

| Step                     | Page text (main)                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verified assessment      | `SCORED`, `7.0 / 10`, criteria and dimensions with citations                                                                                            |
| judgment scores tampered | `NOT VERIFIED` — "The stored assessment could not be verified, so none of it is shown. (judgment_mismatch_score)"; no number, no rationale, no criteria |
| mirror also corrupted    | `NOT VERIFIED … (jsonb_mirror)`                                                                                                                         |

## 4. Mutation proofs of this remediation

Each mutant is one edit to a production file; the named tests run; the file is restored. Raw: `r1-mut.log`.

| Id  | Mutation                                                               | Result                                          |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| R1  | step 2 (judgment consistency) skipped                                  | killed (7 failed)                               |
| R2  | an unverified detail still returns judgments                           | killed (12)                                     |
| R3  | verifier ignores the number                                            | killed (5)                                      |
| R4  | verifier ignores citations                                             | killed (2)                                      |
| R5  | list reports `verified` from step 1 only                               | killed (11)                                     |
| R6  | UI classifier trusts content over the `verified` flag                  | killed (2)                                      |
| R7  | page renders the content of an unverified detail                       | killed (1)                                      |
| R8  | gate does not consult the runtime environment                          | killed (7)                                      |
| R9  | insufficient dimension number defaults to 0                            | killed (3)                                      |
| R10 | (invalid mutant: weakened the _test's_ assertion, so no test can fail) | not counted                                     |
| R11 | budget allows the cost cap to be exceeded by one reservation           | killed (7), including the new ledger-race tests |

## 5. Flaky ledger test

`tests/integration/assessment-ledger-contract.test.ts` › "serializes settle against reserve" (shared contract in `packages/llm/src/testing/budget-contract.ts`)
failed in 1 of 6 isolated PG16 runs at P6A (and on the R5 base). Cause: it demanded _exactly one_ of two reservations racing a settlement succeed, which is true
only if both reservations are serialized after the settlement; before it both are correctly denied. The safety invariant is _at most one_ (the freed budget is
never spent twice). It now asserts that invariant under the race (plus total counted cost ≤ the cap) and pins both orders deterministically in two new tests
(after settlement: two racing reservations → exactly one; before settlement: denied, then exactly one slot). The spending check itself is unchanged and mutant R11
shows it still fails when the cap is loosened. After the change: 12 consecutive isolated PG16 runs of the file, 12 passed, and the full PG16 suite passed.
(P6A baseline: 5 of 6 passed. 12/12 is consistent with, not proof of, the removal of the flake.)

## 6. Operational notes

- The local PostgreSQL server (port 5433) stopped between two runs of this session; the first PG16 attempt failed with `ECONNREFUSED`, was discarded, the server
  restarted and the whole suite re-run from scratch. The reported PG16 numbers are from that clean re-run.
- Nothing was pushed (instruction). The commit is local on `claude/m5-pre-interview-assessment`.
