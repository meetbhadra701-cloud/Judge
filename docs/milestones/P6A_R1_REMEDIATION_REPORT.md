# P6A-R1 — Hostile review remediation report

- Audited head (R6A): `0932bc879f07eb5568510809dd77029126bd1d74`. Remote `main` was `9459c9830086e9c7bf889ff22aaf9c19a1369d5d` (verified by `git fetch`; the branch
  head was still `0932bc8`, working tree clean, before any change).
- Remediation code commit: **`2423138862853dfe2565ead11e2f043e02f3dd9b`** (local, branch `claude/m5-pre-interview-assessment`). The three deliverable documents are in the
  commit that follows it. **Nothing was pushed**, merged, deployed, or started on P6B.
- Companion documents: `P6A_R1_SECURITY_INVARIANTS.md`, `P6A_R1_TEST_EVIDENCE.md`.
- **Verdict: `READY_FOR_R6B`** — meaning the implementation-side gates are green (section 6). It does not claim that independent review passed.

## 1. The P2 defect, as reproduced

`AssessmentReadStore.getDetail` verified the stored report but built its `judgments` from the separate judgment tables regardless of the result. So for an
assessment with `verified:false` and `report:null` the response still carried every judgment's numeric `score`, `rationale`, citation notes and the evidence
text. Worse, a _verified_ report was never compared with the judgment rows, so a valid report (7/7) could be returned next to rows edited to 1/1 and be labelled
`verified:true`. My P6A report claimed the opposite for the first case ("no report and no number"); that sentence was wrong and is now struck through with a pointer.

Exact before/after of each attack: `P6A_R1_TEST_EVIDENCE.md` §2.

## 2. What changed

### Priority 1 — an unverified assessment exposes nothing but safe metadata

`packages/database/src/assessment-read.ts`: one private `inspect(row)` decides, for both the list and the detail, whether the assessment verified. If not, `getDetail`
returns only metadata (id, project, run, version, time, provider mode, replay flag, pipeline identity, usage, notices) with `verified:false`, a stable
`verificationFailure`, `report:null`, `judgments:[]`, `limitations:[]`; `list` returns `verified:false`, `overall:null`. Nothing stored is altered. Scores that do
not exist are `null` (an insufficient dimension never gets a `0`). The API contract header in `packages/schemas/src/assessment-api.ts` and the design §10.2
describe exactly this.

### Priority 2 — canonical source of truth and fail-closed consistency

The **report** is canonical. `inspect` parses the report from the stored canonical text (not the JSONB mirror), then `verifyJudgmentsAgainstReport` (new, pure, layer 2)
checks the judgment rows against it: same dimension set, same state and **same number** per dimension, `scored` disposition iff assessed, same cited evidence
ids. Any disagreement fails closed (the whole assessment is withheld; no partial data). In a verified response the displayed `score` and `outcomeKind` are _taken
from the report_. Partial and insufficient semantics are untouched (the report already carries them). No migration was needed. What the verifier does and does not
authenticate is in `P6A_R1_SECURITY_INVARIANTS.md` — notably, the free text of the rows is not hash-covered, and the hashes live in the same database.

### Priority 3 — permanent regression tests

Section 3 of the test evidence maps every required case to a committed test. New/changed: `read-model.hostile.test.ts` (16, PGlite + PG16, replaces the earlier single
tamper test), HTTP cases in `assessment-http-e2e.test.ts`, `view.test.tsx` (7; the page was split into `page.tsx` for fetching and `view.tsx` for presentation so the real
component can be rendered with plain data), classifier case in `assessment-ui-view.test.ts`, `runtime-gate.test.ts` (14), `verify-judgments.test.ts` (16).
`vitest.config.ts` gained the web test pattern and `esbuild.jsx: 'automatic'`. Corruption is done only by a test-only helper (`apps/worker/src/testing/corrupt.ts`) on
disposable databases; there is no production tampering facility. A permanent real-browser test was **not** added (Playwright is not a repo dependency); see the test
evidence for what is permanent instead and the one-off browser run.

### Priority 4 — small P3 repairs

| Item                                      | Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Misleading `valid_insufficiency` wording  | The API/UI no longer say it. New `dispositionAttribution` (`scored`, `insufficient_by_assessor` — "declared by the assessor (not independently reviewed)" —, `insufficient_by_code`, `insufficient_by_critic`, `technical`) from `attributeDisposition`. The internal failure-policy class (`classifyDisposition`, used by the frozen run policy and its tests) is unchanged, and the design now says what it means and does not mean. The API field `dispositionClass` was renamed (no consumer outside the P6A page). |
| Stale architecture dependency docs        | `docs/ARCHITECTURE.md` §6 "Current actual dependencies" regenerated from the `workspace:` entries (prompts → assessment; api → llm, prompts; the notes about who imports llm/prompts corrected).                                                                                                                                                                                                                                                                                                                        |
| Documented empty Event Context assumption | `M5-design.md` §4.7 assumed reference evidence always exists; a withdrawn-assumption note now states it can be empty and the consequence (such a project cannot be assessed, `no_context_reference_evidence`), pointing to `M5-P6A-decisions.md` F-3. `M5-P5-report.md` wording fixed ("none of the project's declared tracks defined", not "no declared tracks"). **F-3 itself is not redesigned.**                                                                                                                    |
| Flaky ledger test                         | The assertion now states the true invariant (never two) and both orders are pinned deterministically; the spending check is untouched (mutant R11 still fails when loosened).                                                                                                                                                                                                                                                                                                                                           |

## 3. Deferred findings (recorded, not silently dropped)

| Id  | Finding                                                                                                                                         | Risk if left                                                                                 | Phase gate                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | F-2: critic never reviews model-declared insufficiency                                                                                          | a mistaken/injected "insufficient" can only raise the overall (≤ 40 % of weight)             | owner decision in `M5-P6A-decisions.md`; before any live provider                                                   |
| D2  | F-3: empty Event Context reference set cannot be assessed                                                                                       | such an event gets no assessment at all (fails closed, nothing fabricated)                   | owner decision; before real events are onboarded                                                                    |
| D3  | F-4: re-ask re-sends an identical request                                                                                                       | wasted budget; replay cannot express "invalid then valid"                                    | prompt v3 before any paid live run                                                                                  |
| D4  | F-8: a failed newer capture is invisible while an older one is pinned                                                                           | the judge is not told the newest attempt failed                                              | before P7 / any real submission is judged                                                                           |
| D5  | F-11: `createExtraction` has no run/lease check                                                                                                 | a worker that lost its lease can still write a valid, complete, content-addressed extraction | before running more than one worker host                                                                            |
| D6  | F-12: pending-expiry cutoff from the worker clock                                                                                               | clock skew could expire or keep a pending run early/late                                     | before multi-host deployment                                                                                        |
| D7  | Free text of a verified assessment's rows (rationale, notes, limitation codes) is not covered by any hash                                       | a writer can alter that text undetected (numbers/state/citations are protected)              | before a live provider or multi-writer deployment: add a row-text digest (schema migration), or sign the assessment |
| D8  | Hashes are stored with the data (no signature, no external anchor)                                                                              | a database writer able to recompute all columns can forge a self-consistent assessment       | database role separation and an anchoring decision before any hosted multi-tenant use                               |
| D9  | "Show assessment for current material" on a withheld assessment answers `already_assessed` pointing at it; only "Reassess" yields a new version | UX dead-end for a corrupted version                                                          | P6B UX pass (also: surface `verificationFailure` guidance to organizers)                                            |
| D10 | No automated real-browser test (no Playwright dependency)                                                                                       | a regression in browser-only behavior would not be caught in CI; rendered markup is covered  | when the UI grows beyond this page                                                                                  |
| D11 | The API field rename (`dispositionClass` → `dispositionAttribution`) is a contract change                                                       | none today (no external consumer)                                                            | note for any client built before P6B                                                                                |

## 4. Files changed (code commit `2423138`, against `0932bc8`)

```
A apps/api/src/assessments/runtime-gate.test.ts
M apps/web/app/projects/[projectId]/assessment/page.tsx
A apps/web/app/projects/[projectId]/assessment/view.test.tsx
A apps/web/app/projects/[projectId]/assessment/view.tsx
A apps/worker/src/assessment/read-model.hostile.test.ts
D apps/worker/src/assessment/read-model.tamper.test.ts      (superseded by the hostile suite)
A apps/worker/src/testing/corrupt.ts                         (test-only helper, excluded from build)
M docs/ARCHITECTURE.md
M docs/milestones/M5-P5-report.md
M docs/milestones/M5-P6A-report.md                           (strikes the incorrect claim)
M docs/milestones/M5-design.md
M packages/assessment/src/index.ts
M packages/assessment/src/judgment.ts                        (attributeDisposition)
A packages/assessment/src/verify-judgments.test.ts
M packages/assessment/src/verify-report.ts                   (verifyJudgmentsAgainstReport)
M packages/database/src/assessment-read.ts                   (the fix)
M packages/llm/src/testing/budget-contract.ts                (race assertions)
M packages/schemas/src/assessment-api.ts                     (contract + attribution)
M tests/integration/assessment-http-e2e.test.ts
M tests/integration/assessment-ui-view.test.ts
M vitest.config.ts
```

Plus, in the following commit: `docs/milestones/P6A_R1_REMEDIATION_REPORT.md`, `P6A_R1_SECURITY_INVARIANTS.md`, `P6A_R1_TEST_EVIDENCE.md`.
No migration, no change to `packages/scoring`, the frozen prompts, the run store, the worker pipeline or the API routes.

## 5. Residual risk the reviewer should attack

- Whether "the report is canonical, rows must agree" is the right policy when the _rows_ are the correct ones and the report is wrong (the design and persist-time re-scoring
  say the report is recomputed from the inputs, so the report wins; if the reviewer disagrees, the change is one function).
- The completeness of the equality set in `verifyJudgmentsAgainstReport` (it does not compare `position`, attempt counts, critic flags, or `directness`/`specificity` per citation —
  the report does not state them).
- D7/D8 above.

## 6. Gate summary

Format, lint, typecheck, `db:check`, `db:generate` (no changes), production build, `git diff --check`: clean. Full PGlite suite (inside `pnpm check`): 2734 passed, 0 failed.
Full PostgreSQL 16 ICU suite: 3427 passed, 0 failed. New hostile tests: all pass on both targets, and fail on the pre-fix code (section 2 of the evidence).
No failing test was deferred, skipped or weakened; the one test whose assertion changed (the ledger race) was flaky for a stated, reproduced reason and now asserts the real invariant.

**Verdict: `READY_FOR_R6B`.**
