# P6A-R2 — Remediation of the R6B failure

- Reviewed head (R6B): `06d09f1715800d00f6cada5c13202db706932963`; verified before any change: branch `claude/m5-pre-interview-assessment`, remote = local = that SHA,
  `0932bc8` an ancestor, working tree clean.
- Code commit under test: **`afbf7be03e4093249ccdfcd3f74bac3bc0b92c59`**. This report is added in the commit after it; the pushed head is stated in the final message and was verified against the remote.
- No force-push, merge, deploy or P6B work. **Verdict: `READY_FOR_R6C`** (implementation gates only; R6C is the independent gate).

## 1. Root cause (P2-1)

The P6A-R1 verifier compared the judgment row's raw `score` with the report's `scoreOnScale` using `===`. The two are never the same number when the raw score has more
than four decimals:

```
assessor output  --validate-->  persisted row (double precision, RAW)          7.33333
                                        |
                                        v  M4: fromNumber(String(score)) -> exact rational ("the decimal it prints as")
                              report.scoreOnScale = roundHalfUp(rational, 4)   7.3333    <- hashed, canonical
                                        |
                                        v  verifier (R1):  7.33333 === 7.3333 ?  false  -> judgment_mismatch_score
```

Reproduced by me through the real pipeline (replay provider) on PGlite on the unfixed code (R6B reported the same on PostgreSQL 16; I did not re-run the unfixed code on PG16, but the new precision tests pass on PG16 after the fix): `7.33333` and `6.666666666666667` persisted fine and were then
withheld. Also `7.12345` (a half-up boundary), which R6B did not name.

## 2. The canonical score precision contract

| Stage                                        | Representation                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assessor output / validation                 | a finite JavaScript number within the rubric scale (unchanged)                                                                                                                                                                                                                              |
| Persisted judgment row                       | the **raw** double (`assessment_dimension_judgments.score`), unchanged; round-trips exactly through PostgreSQL                                                                                                                                                                              |
| Report (`dimensions[].scoreOnScale`, hashed) | `roundReported(raw)`: parse the decimal the number **prints as** (`String(raw)`) into an exact rational, round **once**, **half-up**, to `SCORING_PARAMETERS.roundingDecimals` = **4** places; **negative zero becomes zero** (`packages/scoring/src/canonical.ts`)                         |
| Verifier (R2)                                | `canonicalReportedScore(row.score) === dimension.scoreOnScale`, where `canonicalReportedScore` is **the engine's own `roundReported`** (exported additively from `@judge-copilot/scoring`; no second implementation, no epsilon) turned into `null` for a value it refuses (NaN, ±Infinity) |
| API response / UI                            | the number comes from the **verified report** (`score = scoreOnScale`), so 7.33333 is shown as 7.3333; `null` for every insufficient dimension; the raw double is never returned as a judgment score                                                                                        |

**What is authenticated.** The _canonical report-level score_: an equivalence class of raw values. 7.33333, 7.33334 and 7.3333 all canonicalize to 7.3333 and cannot be told
apart; 7.33335 canonicalizes to 7.3334 and is refused. A change inside a bucket is **not** detected (pinned by tests named `DOCUMENTED EQUIVALENCE CLASS`). The raw value is
covered only by the report's `inputFingerprint`, which cannot be recomputed here without the whole authorized scoring context. **Stronger raw-value authenticity would need** either a persisted
digest of the raw judgments (a schema migration adding e.g. a `judgments_digest` column checked at read time) or a read-time re-score through `AssessmentInputReader`; neither
was added because no demonstrated invariant requires it and the R6B ask was the false positive.

**Legacy records.** The writer is unchanged and no migration exists: every pre-R2 row has exactly the (raw row, rounded report) shape the new verifier handles, so legacy assessments
that were previously withheld for this reason become readable, and ones that were readable stay readable. The pipeline matrix asserts the stored raw value is untouched.

**Engine-version coupling.** The comparison uses the _current_ `roundingDecimals`; reports are pinned to one engine version by schema (`engineVersion` is a literal). A future change of
the rounding parameter or the engine version must version the verifier together with it.

## 3. Changes

| File                                            | Change                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/scoring/src/index.ts`                 | additive export `roundReported` (no behavior change); `boundary.test.ts` and the milestone-scope guard updated deliberately, narrowly                                                  |
| `packages/assessment/src/verify-report.ts`      | `canonicalReportedScore`; score comparison at canonical precision; the `no_usable_citation` shape (below); precision contract documented in the header                                 |
| `packages/database/src/assessment-read.ts`      | judgment `insufficiencyReason` from the report; attribution `insufficient_by_code` for an unused value; `notices.storedText`                                                           |
| `packages/schemas/src/assessment-api.ts`        | contract: canonical precision, `insufficiencyReason`, `storedText` notice                                                                                                              |
| `apps/web/.../assessment/view.tsx`              | reason text for both insufficiency reasons; "stored text, not hash-verified" tag and notice; "scores are shown at four decimals"                                                       |
| tests (new/changed)                             | `score-precision.test.ts`, `assessment-read-direct.test.ts`, `verify-judgments.test.ts`, `view.test.tsx`, `assessment-http-e2e.test.ts`, `milestone-scope.test.ts`, `boundary.test.ts` |
| `docs/milestones/P6A_R1_SECURITY_INVARIANTS.md` | R2 amendment                                                                                                                                                                           |

No migration, no change to the writer, the pipeline, the scoring computations, prompts, queue, budget or routes.

## 4. P3 findings

- **P3-1 (unusable evidence kinds).** M4 lists every cited id in `citedEvidenceIds` but only `fact`/`claim` items are _usable_. A _scored_ judgment citing only absence/unknown/
  contradiction evidence is stored as scored, and M4 reports `insufficient_evidence / no_usable_citation` ("missing evidence is not negative evidence"). R1 compared a scored row with an
  insufficient report dimension and withheld a legitimate assessment. The verifier now accepts exactly that shape — row `scored`, finite score, disposition `scored` — **and still requires**
  the row's cited ids to equal the report's, so a swapped, added, removed or foreign evidence id withholds the assessment (tests: a different own-project id → `judgment_mismatch_citations`;
  a foreign-project id is refused by the database or withholds). The API shows `score: null`, `insufficiencyReason: 'no_usable_citation'`, attribution `insufficient_by_code`; the raw judged value is not
  returned as a judgment score (the verified report's own `JUDGED_VALUE_NOT_USED` diagnostic may state it — that is hash-covered content). Regression: `assessment-read-direct.test.ts` (reproduces the case through the real
  store with an `absence` evidence item), `verify-judgments.test.ts`.
  _Note:_ the M5 extractor only creates `claim`/`fact` evidence, so the shape cannot arise from the worker pipeline today; it arises with graphs written by other trusted paths (the R6B reproduction).
- **P3-2 (unauthenticated free text).** Documentation corrected (contract header, invariants doc), and the response now carries `notices.storedText: 'not_hash_covered'`; each dimension on the page shows a
  "rationale, notes and limitations: stored text, not hash-verified" tag and the page states it under "What this does not establish". No claim of authenticity is made for rationale, citation notes,
  limitation lists, disposition or its attribution. The disposition is partly cross-checked (scored iff the report says assessed, or an unused value) but is not hash-covered.
- **P3-3 (test gaps).** `assessment-read-direct.test.ts` persists non-empty limitations, corrupts the assessment, and asserts the limitations are withheld (and were present before); the HTTP corruption tests also
  check the **run view** carries no score/text. The stale `dispositionClass` annotation in `assessment-http-e2e.test.ts` is replaced by the real fields (`dispositionAttribution`, `insufficiencyReason`) and asserted.

## 5. Before / after (real pipeline, replay provider, PGlite; raw output in the session scratchpad)

| Raw scores (dimension 1 / 2)                     | BEFORE (`06d09f1`)                                                                            | AFTER                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 7.33333 / 6.666666666666667                      | `verified:false`, `judgment_mismatch_score`, report null, no judgments; list `verified:false` | `verified:true`, scores **[7.3333, 6.6667]**, report present; list verified |
| 7.12345 / 2.675                                  | `verified:false`, `judgment_mismatch_score`                                                   | `verified:true`, scores **[7.1235, 2.675]**                                 |
| 7 / 3, 7.5 / 0.1, 7.1234 / 9.9999 (≤ 4 decimals) | verified, scores unchanged                                                                    | unchanged                                                                   |

The original five R6A attacks are unchanged and still blocked (the `read-model.hostile.test.ts` suite, 16 tests × 2 targets, plus the HTTP cases): corrupted JSONB mirror → `jsonb_mirror`;
altered canonical text → `text_hash`; broken text hash → `text_hash`; schema-invalid report with consistent hashes → `schema`; changed judgment score → `judgment_mismatch_score`. Each withholds report,
judgments, limitations, numbers and text in detail, list and run view.

## 6. Why this preserves security

- The report stays the single source of truth; displayed numbers come from it. Verification step 1 is untouched.
- The comparison is _exact at the report's own precision_: a material change, a bucket change, `NaN`/`±Infinity`, `null`, a number on an insufficient dimension, a flipped outcome, a deleted or added judgment, and any citation change all
  still fail closed (tamper matrix: 8 material cases × 2 targets, plus unit tests).
- No epsilon: an arbitrary tolerance was tried as a mutant and is caught (it would accept a one-bucket change).
- Cross-project isolation, authentication, provider gate, idempotency, queue and budget code paths were not touched; their suites pass.
- The only widening is the `no_usable_citation` shape, which accepts a row only when the _hash-verified report itself_ says that M4 did not use the value, and still binds the citations.

## 7. Remaining trust limitations (unchanged or newly explicit)

1. Same-bucket raw-score changes are not detected (equivalence class). Raw-value authenticity needs a persisted digest or a read-time re-score.
2. Free text (rationale, citation notes, limitation lists, disposition/attribution, assessment-level limitations) is not hash-covered; the response, UI and docs now say so.
3. Hashes live with the data; no signature or external anchor (D8 of the R1 report).
4. Evidence text is project data shown as quoted, labelled content, not part of any assessment hash.
5. The verifier binds to the current rounding parameter / engine version (section 2).

## 8. Mutation evidence

Each mutant is one edit to a production file; named tests run; file restored (raw: session scratchpad `r2-mut.log`). **12 of 12 killed.**

| Id  | Mutation                                                       | Failed tests |
| --- | -------------------------------------------------------------- | ------------ |
| P1  | strict equality (the R6B defect)                               | 30           |
| P2  | arbitrary epsilon (0.001) instead of canonical rounding        | 6            |
| P3  | `toFixed(4)` instead of the engine's rounding                  | 2            |
| P4  | unusable-kind (`no_usable_citation`) branch removed            | 4            |
| P5  | non-finite scores accepted (refusal turned into the raw value) | 4            |
| P6  | an insufficient row may keep a number                          | 1            |
| P7  | displayed score taken from the row, not the report             | 17           |
| P8  | unused judged value shown as the judgment score                | 18           |
| P9  | stored-text notice removed from the page                       | 1            |
| P10 | stored-text notice removed from the API                        | 1            |
| P11 | unverified detail keeps limitations                            | 1            |
| P12 | round-down instead of half-up                                  | 38           |

## 9. Tests and gates (executed)

| Gate                                                                                        | Result                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` = format, lint, typecheck, `db:check`, full PGlite suite, production build     | **exit 0**; `Test Files 172 passed \| 5 skipped (177)`, `Tests 2803 passed \| 57 skipped \| 3 todo (2863)` (R1: 2734 passed)                                                                                                                                                                               |
| `pnpm db:generate`                                                                          | "No schema changes, nothing to migrate" (no migration)                                                                                                                                                                                                                                                     |
| Full suite on PostgreSQL 16.15 (ICU locale provider, `en-US`), disposable `*_test` database | **exit 0**; `Test Files 177 passed (177)`, `Tests 3533 passed \| 1 skipped \| 6 todo (3540)` (R1: 3427 passed)                                                                                                                                                                                             |
| `git diff --check`                                                                          | clean                                                                                                                                                                                                                                                                                                      |
| Precision regression tests                                                                  | `score-precision.test.ts` 26 tests/target (13 value pairs incl. integers, 1–4 decimals, 5+ decimals, repeating, near-boundary, min/max, negative zero; the two R6B values; partial; 8 fail-closed tampers; 3 same-bucket cases), `verify-judgments.test.ts` 46, `assessment-read-direct.test.ts` 11/target |
| Security regression tests                                                                   | `read-model.hostile.test.ts` 16/target, HTTP corruption cases, `runtime-gate.test.ts` 14 — all green                                                                                                                                                                                                       |
| Failures                                                                                    | none. (Earlier in this session a lint error in a new test and a closed-export-list scoring test failed `pnpm check`; both were fixed and the gate re-run from scratch. The local PostgreSQL had to be restarted once before the PG16 run.)                                                                 |

Legacy-readability and "tamper still fails" are both asserted against the same persisted rows: the matrix reads the unchanged raw values back from the database, verifies, then corrupts them.

## 10. Unresolved findings

None of R6B's four findings is left open. Carried forward unchanged from R1 (see its D1–D11): F-2/F-3 owner decisions, prompt v3, text digest/signature (D7/D8), UX dead-end on a withheld assessment (D9), no permanent real-browser test (D10).

**Verdict: `READY_FOR_R6C`.**
