# P6D — real-event usability and demonstration honesty

| Item                         | Value                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                       | `claude/p6d-real-event-usability`, from the accepted P6C head. Nothing merged, nothing deployed, `main` untouched.                                                                                                                       |
| **Baseline SHA**             | `a42224f6441dbe4b5c95a7d0784e0439d0f3a54f` (accepted P6C)                                                                                                                                                                                |
| **Final implementation SHA** | `d1b7ac4ce12f6590f5e67bd361432a03772ac7c2` (all code, tests, fixtures and docs except this report and its screenshots; a report cannot contain the SHA of the commit that adds it. This report and its screenshots are the next commit.) |
| Live model / paid call       | **none.** No live provider exists in any code path used. No key, no network model, no spend.                                                                                                                                             |
| Migrations / schema          | **none added, none edited.** `git diff a42224f HEAD` touches no file under `packages/scoring` or any migration. No broad schema hardening.                                                                                               |
| Diff                         | 65 files changed, 6 559 insertions, 225 deletions (`git diff --stat a42224f d1b7ac4`).                                                                                                                                                   |

```
P6D_IMPLEMENTATION: READY_FOR_R8B
REAL_EVENT_UI: PASS
REAL_SOURCE_END_TO_END: BLOCKED
```

`REAL_EVENT_UI: PASS` means: in a real Chromium, against the real API, worker and database, an organizer can configure an event through forms alone, lock it, submit projects (with tracks), capture, and
read a correctly labelled offline report, with no SQL, no raw JSON and no typed UUIDs (§7). It is **not** a claim about a real hackathon: §10 explains why `REAL_SOURCE_END_TO_END` stays `BLOCKED`.

## 1. Findings addressed

| R8A finding                                                           | Resolution                                                                                                                      | Where                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| P2-1 tracks cannot be chosen when submitting; the remedy did not work | Track selector in the submit and correction flows; API validates against the locked context; refusal text names the real remedy | §2                       |
| P2-2 Event Context needed raw JSON and typed UUIDs                    | Structured editor; ids generated internally; raw editor kept as an advanced tool                                                | §3                       |
| Scripted run exposed ~9 settled calls, 9 000 / 1 800 tokens, $0.017   | Fixed at the source, in the read model and on the page; history reinterpreted, not rewritten                                    | §4, `docs/ACCOUNTING.md` |
| P3 wording A–D                                                        | Fixed, with tests                                                                                                               | §5                       |
| P3 safety tests only matched message text                             | Behavioral tests at every layer, 19-mutant experiment                                                                           | §6                       |
| (found by the journeys) empty criterion description failed a run      | Prompt input states that the rubric publishes no description; nothing invented                                                  | §7                       |
| (found by the journeys) refusal text cut mid-sentence (400-char cap)  | Cap raised to 1 200, a cut message ends with ` […]`                                                                             | §7                       |

## 2. P2-1 — track selection in the normal submit flow

### Design

- `POST /events/:id/submissions` (and the void-and-replace `replacement`) accept `trackKeys: string[]` (default `[]`) and `contextVersionId` (the version the form was rendered against).
- The server re-reads the event's **locked** context. Evaluation order inside the single transaction: idempotent replay → convergence on the same owner pair (the identical pair with the identical tracks converges;
  the identical pair with **different** tracks is a conflict and changes nothing) → stale context (`CONTEXT_VERSION_CHANGED`, 409: the page was built against an older locked version) → unknown/duplicate/malformed
  track keys (`UNKNOWN_TRACK`, 422; a malformed key is 400) → ownership overlap → name → writes. Nothing is written for a refused submission; ownership uniqueness, authorization, atomicity and historical immutability are unchanged.
- The selection is stored as the project's declared tracks, exactly as before (the assessment preflight already read them). Tracks are still chosen at submission and are never edited afterwards; correction is
  void-and-replace, which now offers the same selector.
- Web: `TrackSelector` lists the **locked** context's declared tracks (keys never typed), says whether the event has event-wide reference material (`trackContextOf`, which mirrors the preflight's F-3 rule), and
  says in words when a track is _needed_ (a track-only event) versus _optional_.
- F-3 refusal text now depends on what is actually true: a track-only event with no declared track says "ask an organizer to void this submission and submit it again with its track selected, or add an explicit
  event rule…" (a remedy that works); an event with neither tracks nor rules says so. A context with **no overall rubric** is refused early as `no_overall_rubric` (422, nothing queued, nothing spent) instead of
  failing late with `fallback_anchors_not_approved`.
- Only the **overall** rubric is assessed. A track-scoped rubric is shown as disclosed-not-assessed (`official_track_rubrics_not_assessed`); it never substitutes for a missing overall rubric (mutant P12).

### Tests

| Suite                                                                                  | Count (PGlite)    | Covers                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/submission-tracks.test.ts`                                          | 13                | global-rule event, track-only event, multiple tracks, no tracks, unknown/malformed/repeated keys, stale context, idempotent retry, convergence with different tracks, void-and-replace, authorization, nothing written on refusal |
| `tests/integration/submission-tracks-web.test.ts`                                      | 7                 | server-action form parsing, flash explanations, `trackContextOf` equals the preflight for every context shape                                                                                                                     |
| `apps/web/.../submit/view.test.tsx`                                                    | 7                 | selector rendering, needed/optional wording                                                                                                                                                                                       |
| `apps/worker/src/assessment/pipeline.context.test.ts` + `assessment-run-store.test.ts` | in the full suite | track-scoped rubric behaviour, early refusals                                                                                                                                                                                     |
| Chromium Journey B                                                                     | 4 steps           | the whole flow in a real browser (§7)                                                                                                                                                                                             |

Mutants P7 (unknown tracks not validated), P8 (stale token ignored), P9 (different tracks silently accepted), P12 (no-overall-rubric not refused) are each **killed** (§6).

## 3. P2-2 — the structured Event Context editor

Route: **Event → version → Edit Event Context** (`/events/:id/versions/:versionId/edit`). The previous raw editor is now `/edit/advanced` ("advanced: edit the document as JSON"), reached from a link at the bottom; it
is unchanged in behaviour.

### Walkthrough (what an organizer does)

1. **Add sources** (pasted rules, rubric text, FAQ) with an authority (official rules, official rubric, official track rules, organizer guidance, judge context) as before.
2. **Edit Event Context.** Sections, all forms: _Judging format and guidance_; _Rules_ (statement, basis, which sources support it); _Submission requirements_; _Tracks_ (name; a key is generated), each with its
   own _requirements_ and optionally its own _rubric_; _Overall rubric_ (scale minimum/maximum, criteria with name, optional description, **weight as a percentage**, anchors as "score → description"); _Sources and
   provenance_ (read-only list of which sources exist).
3. **Identifiers are generated** from names (`keyFromName`, collision-suffixed), never typed; the document's UUID-style ids are assigned by the server (`applyHumanEdit`), never by the client or the editor.
4. **Basis on every statement:** _Official_ (stated by the organizers' own documents; requires at least one **official-authority** source to be ticked), _Interpreted by the organizer_ (the organizer's reading), or
   _Unverified/unclear_. Nothing is promoted silently: a source-derived statement keeps its sources, an unsourced statement cannot be labelled official, ambiguity stays `unclear`, and the editor **never fills in a
   criterion, weight or date** (a new rubric starts empty; weights are blank).
5. **Validate** (the same document validation the lock uses): errors appear next to the field and are summarised above, in organizer language ("weights must total 100 %; they total 85 %"), never as a JSON path.
6. **Review** on the version page: official vs organizer-interpreted vs unverified is shown per fact with a basis tag (`basisOf` in `FactView`), conflicts are carried through, and "why this version cannot be locked
   yet" is explained when it cannot (`explainLockIssue`).
7. **Lock** → an immutable version. A locked version cannot be edited (application check + the existing DB triggers); changes go into a new draft.

### Design decisions and limits (stated, not hidden)

- The Event Context schema has **no event "description"** field; _judging format and guidance_ serves that purpose. **Sponsor challenges** are modelled as tracks (own requirements, own rubric). The editor does not add
  schema fields.
- **Provenance rules are enforced in the web tier** (the form model and the server action re-validate every post; the browser checks are advisory). The API's `validateDocument` is unchanged, so a caller of the API
  (or the advanced raw editor) can still store a human-authored statement without a source. This is a pre-existing API property and was not hardened (no broad schema/API hardening was in scope).
- The editor re-derives the document through the canonical `EventContextDocumentInput` shape and `applyHumanEdit`; nothing bypasses `documentFromExtraction`/`validateDocument`, and the canonical document shape is
  preserved (tests round-trip it).

### Tests

| Suite                                                    | Count | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/context-editor-model.test.ts`         | 19    | missing criteria, weights not 100 %, half-weighted rubrics, out-of-range and non-numeric weights, malformed scales (min ≥ max), anchors outside the scale, duplicate criterion/track names and generated-id collisions, invalid tracks, a second overall rubric, contradictory content (an event that ends before it starts, an unconfirmed date), official-without-official-source, round-trip to the canonical shape, `keyFromName` |
| `apps/web/.../edit/actions.test.tsx`                     | 4     | a form post made **without the browser's checks** cannot promote an unsourced statement to official (nothing reaches the API); unauthorized edit is refused; a locked or superseded version and unreadable input are refused without touching the draft; the API's refusal is returned as field issues                                                                                                                                |
| `tests/integration/context-editor-authorization.test.ts` | 2     | over HTTP: only an organizer edits a draft (judge 403, no role 403, anonymous 401; the stored draft is unchanged); a locked version cannot be edited by anyone and stays unchanged                                                                                                                                                                                                                                                    |
| `apps/web/.../edit/context-editor.test.tsx`              | 4     | rendering: no JSON, no id inputs, basis controls, field-level errors                                                                                                                                                                                                                                                                                                                                                                  |
| Chromium Journey A step A2/A3, Journey B step B1         | —     | the whole editor against the real API                                                                                                                                                                                                                                                                                                                                                                                                 |

Mutants P14 (official without an official source accepted) and P15 (weights not required to total 100) are **killed**.

## 4. Accounting — before and after

**Before** (R8A): a scripted demonstration wrote a fixed placeholder (1 000 input, 200 output tokens per stage) into the call ledger; the ledger priced it; the API's `usage` returned ≈ 9 settled calls,
9 000 / 1 800 tokens and **≈ $0.017**. The web page hid the numbers; the API, the ledger and the per-run outcome (billing summary) did not.

**After:** four terms are separated (full definitions in `docs/ACCOUNTING.md`):

| Term                | Meaning                                                                                     | For an offline demonstration |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| **Stage execution** | one pass of a pipeline stage through the local call ledger; bookkeeping, never a model call | counted (e.g. 11)            |
| **Provider call**   | an actual invocation of an external model (only a `live` provider makes them; none exists)  | **0**                        |
| **Reserved budget** | a _local_ software limit held while a stage runs (not money, not a provider quota)          | unchanged guard              |
| **Actual cost**     | money incurred with a provider: tokens and `cost_nano_usd` of settled **live** rows         | **0 / 0 / 0**                |

Invariant: _an offline demonstration is never represented as an actual paid model invocation or as actual incurred cost._ Kept in three places:

1. **Source.** The demonstrator (`demonstration-model.ts`) reports `{0, 0}` tokens: it is local code and consumes nothing. Ledger rows and the terminal outcome row ("billing summary") record zeros.
2. **Read model.** `AssessmentReadStore.usageOf` splits the ledger by provider mode. Only `live` rows feed `inputTokens`, `outputTokens`, `costNanoUsd` and the provider-call counters. Every other row (`replay`,
   `scripted`, or a row older than the mode column) counts only as a stage execution; whatever it reported is returned under `usage.simulated` as a labelled diagnostic with `notionalCostNanoUsd` ("not spent"),
   and `usage.basis` is `simulated`. (`AssessmentUsageView` in `@judge-copilot/schemas`.)
3. **Page.** "No model was called and nothing was spent: 0 provider calls, no tokens, no cost. This offline run executed 11 local demonstration stage(s); stage executions are bookkeeping, not model usage."

**History is not rewritten.** Runs made before P6D keep their stored rows (including the old priced placeholder) and are **reinterpreted at read time** (provider mode ≠ `live` ⇒ `basis: simulated`, cost 0, the old
figure visible only as `simulated.notionalCostNanoUsd`). Residual, stated: the stored `assessment_run_outcomes` row of a pre-P6D scripted run still holds the old totals; no aggregate spend report exists in this
repository, and any future one must treat non-live rows as simulated (documented in `docs/ACCOUNTING.md`).

**Spending guards stay testable.** The budget guards run over the same ledger for every provider; their tests use explicitly synthetic usage (`FakeModel`, `ScriptedProvider` steps in the test harness) and still trip
the limits (`demonstration-accounting.test.ts`: "explicitly synthetic fixtures still trip the spend guards").

Scripted mode remains impossible in production (§6).

Tests: `tests/integration/demonstration-accounting.test.ts` (4: ledger, outcome row, API list/detail/run view, pre-P6D reinterpretation, guards, notice), `tests/integration/demonstration-safety.test.ts` (layer 6:
what a scripted run records), `tests/browser/p6d.browser.ts` (A7: the page and the API agree). Mutants P10 (every ledger row counted as a provider call), P11 (priced placeholder returns), P13 ("AI estimate" notice returns)
are **killed**.

## 5. Judge-facing wording (A–D), provenance, no score or hash changed

| Finding                                                  | Fix                                                                                                                                                                                                                                                                                  | Test                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| A. "AI estimate" shown for a scripted run                | `ASSESSMENT_DEMONSTRATION_NOTICE`: "Offline demonstration, not an AI estimate: no model was used…" in the list notice, detail notice and page; scripted/replay dimension attribution ("fixed placeholder value (no assessor, no model)") and citation text ("placeholder citation…") | `demonstration-accounting.test.ts`, assessment `view.test.tsx`, P13 |
| B. missing GitHub evidence looked like complete coverage | coverage summary carries `missingSources`; headline "EXPECTED SOURCE MISSING"; the overall qualifier says "expected source missing"; the capture page shows the earlier-capture and failed-retry state                                                                               | assessment-view tests, `capture/view.test.tsx`, P16                 |
| C. unknown coverage integrity                            | "…could not be verified, so this page does not say that it was, and does not say that it was not." (also in the one-line qualifier: "source coverage could not be verified")                                                                                                         | `view.test.tsx`, `journey.browser.ts`, P17                          |
| D. capture-page consistency                              | usable-content counts, supplied counts and the failed-retry notice are computed from the same snapshot data as the report                                                                                                                                                            | `capture/view.test.tsx` (21)                                        |

No scoring code, score, hash or verified-report byte was changed; the 9.0 and 6.9 goldens and the hash tests pass unchanged. The existing browser journey's one assertion that matched the old text
(`source coverage UNKNOWN`) was updated to the new wording (and now asserts the old text is gone).

## 6. Demonstration-safety tests (behavioral) and mutation evidence

`tests/integration/demonstration-safety.test.ts` (34 tests; moved out of `apps/worker` because it imports API source and the package-boundary rule correctly refused that), each layer tried with the others permissive:

1. **Environment loaders** (API and worker): `scripted`/`replay` refused in production with the provider named; an unrecognised `NODE_ENV` (`Production`, `prod`, `staging`, `live`, padded values) never enables
   a demonstration provider; an **unset or empty `NODE_ENV` also refuses** a demonstration provider ("requires NODE_ENV to be set explicitly" — new in P6D, `assertExplicitDevelopmentEnvironment`); an invalid
   `ASSESSMENT_PROVIDER` value (`Scripted`, ` scripted`, `live`, `anthropic`, `1`…) is an error, never a fallback; an unrelated invalid setting fails the whole configuration.
2. **API runtime gate** (`openOfflineGate`) refuses scripted and replay when the _process_ environment is `production`, `staging`, `Production`, `prod` or empty, and opens for scripted only in development and test.
3. **Provider constructor** refuses in production and a caller-supplied environment name can only tighten it.
4. **Worker runtime with validation bypassed** (hand-made env) still refuses to build the scripted provider in production.
5. **API/worker mismatch:** a run frozen by a scripted API is refused by a worker holding a replay provider: no assessment, no ledger row.
6. **What a scripted run records** (zero tokens, zero cost).
7. **Real processes:** `tests/integration/demonstration-entrypoints.test.ts` (2) spawns the built API and worker entry points with `NODE_ENV=production` and a demonstration provider and requires them to exit non-zero before serving.

**Unset/empty `NODE_ENV` decision.** Everything that is not a demonstration provider keeps the existing contract (unset ⇒ development, tested). A demonstration provider additionally requires an explicit
`development`/`test`, and the runtime gate and provider constructor hold regardless of the loaders (layers 2–4), so a deployment that forgets `NODE_ENV` cannot run a demonstration provider.

### Mutation experiment (`scripted in-place mutation, source restored after each, 19 mutants`)

| #   | Mutation                                              | Result     | First failing test                                                                             |
| --- | ----------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| P1  | explicit-`NODE_ENV` rule becomes a no-op              | killed (3) | unset/empty `NODE_ENV` does not enable a demonstration provider                                |
| P2  | worker env: production refusal of scripted removed    | killed (2) | refuses scripted and replay in production                                                      |
| P3  | API env: production refusal of scripted removed       | killed (2) | same                                                                                           |
| P4  | API loader skips the explicit-`NODE_ENV` check        | killed (3) | unset/empty `NODE_ENV`…                                                                        |
| P5  | worker loader skips the explicit-`NODE_ENV` check     | killed (3) | unset/empty `NODE_ENV`…                                                                        |
| P6  | API runtime gate: scripted assertion removed          | killed (5) | the gate refuses scripted and replay when the process environment is `production`              |
| P7  | submission: unknown tracks not validated              | killed (3) | an unknown track is refused (`UNKNOWN_TRACK`) and not one row is written                       |
| P8  | submission: stale context token ignored               | killed (1) | stale context: a selection made against an older locked version is refused                     |
| P9  | submission: converging with different tracks accepted | killed (1) | convergence: identical pair/same tracks converges; different tracks is a conflict              |
| P10 | read model: all ledger rows counted as provider calls | killed (3) | a scripted demonstration records zero tokens and zero cost…                                    |
| P11 | demonstrator reports a priced placeholder again       | killed (2) | same                                                                                           |
| P12 | preflight: no overall rubric not refused              | killed (3) | track-scoped rubric does not substitute for a missing overall one                              |
| P13 | project notice leads with "AI estimate" again         | killed (1) | no advisory line of a demonstration says "AI estimate"                                         |
| P14 | editor: official without an official source accepted  | killed (2) | a form post without the browser's checks cannot promote an unsourced statement to official     |
| P15 | editor: weights not required to total 100             | killed (1) | weights that do not total 100 %…                                                               |
| P16 | coverage: missing expected sources ignored            | killed (1) | when the GitHub repository was never captured, the headline says an expected source is missing |
| P17 | coverage: unknown coverage claims "it was not" again  | killed (2) | an assessment from before coverage records is "not recorded": coverage UNKNOWN, never complete |
| P18 | empty criterion description passed through unchanged  | killed (1) | an official criterion published without a description is assessed…                             |
| P19 | flash cap back to 400 characters                      | killed (1) | caps the length and produces a URL-safe parameter                                              |

**19 / 19 killed, 0 survivors.** (An earlier version of the safety tests passed vacuously for some mutants because a production API also fails for lack of JWT configuration; the tests now use a production
baseline that is valid in every other respect — `production configurations are valid without a demonstration provider` — so a refusal can only come from the provider.) The experiment script is a development
aid in the session scratchpad and is not committed; its results are the table above.

## 7. The two Chromium journeys (real API, worker, database, browser)

`tests/browser/p6d.browser.ts` (12 tests). Synthetic fixtures only (the repository's fixture network serves `github.com/synthetic/atlas` and `devpost.com/software/synthetic-atlas`). The file performs **no
database write and no raw JSON editing** (a test asserts the file contains neither; it also asserts the checkout was left untouched). A failing step writes a screenshot and the page text. Screenshots:
`docs/milestones/p6d-screenshots/`.

**Journey A — global-rule event** (A1–A7): create hackathon, add sources → structured editor (criteria, weights, scale, anchors, a rule, a requirement; deliberate mistakes explained in words:
`A2-editor-issue.png`) → review says what is official, what is interpretation and what is unverified, and why the version cannot be locked yet (`A2-review-cannot-lock.png`) → lock; a locked version cannot be edited
(`A4-locked.png`) → submit GitHub + Devpost (no track section: the event has no tracks) → GitHub captured at an exact commit, Devpost cannot be fetched (`A5-captured.png`) → organizer supplies the Devpost text,
labelled as supplied, never as fetched (`A6-supplied.png`) → request the scripted assessment → report labelled "NOT AN AI ASSESSMENT", "fixed placeholder value (no assessor, no model)", **no cost, no tokens, 0
provider calls**, and the API agrees (`A7-report.png`).

**Journey B — track-only event** (B1–B4): author tracks, a track requirement, a track rubric and the overall rubric, **no event-wide rule**, and lock (`B1-editor.png`, `B1-locked.png`) → the normal submit page
offers the tracks and says a track is needed (`B2-submit-form.png`); submitting without one is accepted but the report is **refused with the real remedy** (`B2-refused.png`: nothing queued, nothing spent; "ask an
organizer to void this submission and submit it again with its track selected…") → that remedy works: void-and-replace offers the same selector, the corrected submission declares the track and the voided project
keeps its history (`B3-replaced.png`) → capture, scripted assessment, report for the overall rubric with the track rubric disclosed as not assessed (`B4-report.png`).

Defects the journeys found and that were fixed (with tests and mutants P18, P19):

- An official criterion with an **empty description** (valid in the context, optional in the editor) produced a run that failed `prompt_input_invalid`. The prompt input now states that the rubric publishes no
  description beyond the criterion's name; nothing is invented.
- The sealed flash message was cut at 400 characters, mid-sentence, in exactly the refusal that tells an organizer what to do. The cap is 1 200 and a cut message says so.

## 8. Gates (exact results, final tree `d1b7ac4`)

| Gate                                                                                                                          | Result                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                                                           | All matched files use Prettier code style                                                                                                                                                                                               |
| `pnpm lint` (`eslint . --max-warnings=0`)                                                                                     | exit 0                                                                                                                                                                                                                                  |
| `pnpm typecheck` (all packages + root)                                                                                        | exit 0                                                                                                                                                                                                                                  |
| `pnpm db:check`                                                                                                               | "Everything's fine"                                                                                                                                                                                                                     |
| `pnpm db:generate`                                                                                                            | "No schema changes, nothing to migrate" (no migration added)                                                                                                                                                                            |
| `pnpm build`                                                                                                                  | exit 0                                                                                                                                                                                                                                  |
| `git diff --check a42224f HEAD`                                                                                               | clean                                                                                                                                                                                                                                   |
| **Full suite, PGlite** (`pnpm test`, `TEST_DATABASE_URL` unset)                                                               | **228 files passed, 6 skipped (234); 4 154 tests passed, 61 skipped, 2 todo (4 217); 0 failed**; 309 s                                                                                                                                  |
| **Full suite, PostgreSQL 16.15, ICU** (`judge_p6d_icu_test`, `locale_provider icu`, `icu_locale en-US`, `LC_COLLATE C.UTF-8`) | **234 files passed (234); 5 174 tests passed, 1 skipped, 4 todo (5 179); 0 failed**; 1 062 s                                                                                                                                            |
| **Chromium** (`pnpm test:browser`: journey + pilot + P6D)                                                                     | **3 files, 34 tests passed, 0 failed** (P6D: 12); 60 s                                                                                                                                                                                  |
| New/changed focused suites (PGlite, 13 files, before the authorization test was added)                                        | 218 passed / 218 (submission-tracks 13, -web 7, context-editor-model 19, safety 34, entrypoints 2, accounting 4, flash 5, assessment-ui-view 42, submit view 7, assessment view 56, capture view 21, editor actions 4, editor render 4) |
| `context-editor-authorization.test.ts` (added in the second implementation commit; included in the full runs above)           | 2 tests, passing on PGlite and on PostgreSQL 16                                                                                                                                                                                         |
| Mutation experiment                                                                                                           | 19 / 19 killed (§6)                                                                                                                                                                                                                     |

Honest account of the gate history: the **first** full PGlite run failed **one** test (`dependency-rules`: the safety test, then located in `apps/worker`, imported API source). The test was moved to
`tests/integration/` and the full run above is the re-run. The **first** Chromium run failed one test (`journey.browser.ts` still asserted the old coverage text `source coverage UNKNOWN`, which finding C
changed deliberately); the assertion was updated and the run above is the re-run. After the second implementation commit (the editor-authorization test, requested by the milestone's "unauthorized edits" item) lint, typecheck and all three suites above were re-run on the final tree `d1b7ac4`; the numbers in the table are from those runs. No test was skipped, disabled or weakened to get green. Tests make no external network call.

## 9. Preserved integrity and fairness

- **Pipeline not collapsed.** No pipeline stage, invariant or dependency rule changed. `packages/scoring` and all migrations are byte-identical to the baseline. Layer-2 packages import no `llm`/`prompts`.
- **F-2 Option B stays disclosure only.** The limitation `partial_score_excludes_model_declared_insufficient` and its wording are unchanged; this milestone does not claim that independent criticism resolves the
  assessor's own "insufficient". Option A is still open (§11).
- **F-3 early refusal and F-8 disclosures kept**, extended only with the no-overall-rubric refusal and track-aware wording.
- **R7F coverage, provenance and snapshots preserved.** Coverage gained `missingSources` (a derived read-model field) and wording; the verified-report hashes and the 9.0 / 6.9 goldens are unchanged.
- **Provenance is server-controlled.** Clients and the editor never set ids, `origin` or `humanModified`; `applyHumanEdit` does.
- **No fake functionality.** The editor starts empty; no sample criteria, weights or dates anywhere in the UI or API. The demonstration is labelled a demonstration on every surface.
- **Authorization** is the existing role model; unauthorized submission and editor writes are tested.

## 10. Real-source readiness: BLOCKED

Unchanged from P6C, and deliberately not papered over by this milestone. The synthetic journeys prove the **interface and the plumbing**; they cannot prove a real hackathon because:

- no real Devpost submission page and no authentic event rubric/rules have been supplied to this repository (and a live Devpost fetch is unavailable here), so no **matching real pair + real rubric** exists;
- a real GitHub capture here is limited to recorded real responses (P6C), and a live capture attempt was rate-limited;
- the scripted demonstrator's scores are placeholders and say nothing about a project.

`REAL_SOURCE_END_TO_END` therefore stays **BLOCKED**. It becomes provable when an owner supplies (a) a real Devpost submission URL or its text, (b) its GitHub repository at a commit, and (c) that event's authentic
rules/rubric — all through the interface built here, with no developer assistance.

## 11. Remaining blockers for any live use (not started, not authorized)

- **F-2 Option A:** independent critic review of an assessor's own "insufficient" claim (critic prompt v2).
- **F-4:** a feedback channel from the critic to the assessor, designed together with F-2 Option A.
- **Live provider:** an adapter contract-tested on recorded HTTP; `assertProviderAllowed('live')` gated by explicit configuration **and** an approval flag; a verified price table; human confirmation of each paid
  run; owner authorization and a hard spend cap.
- An aggregate spend report (none exists) must treat non-live rows as simulated.
- API-level provenance enforcement (§3 "limits") is a possible later hardening, not required for this milestone.
- M6 and M8 are not started.

## 12. Readiness checklist (updated)

| Item                                                                                              | Status                                    |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| An organizer configures an Event Context without JSON, SQL or typed UUIDs, validates and locks it | **Done** (Journeys A, B)                  |
| Tracks are selectable in the normal submit flow; stale and invalid selections refused             | **Done** (13 + 7 tests, Journey B)        |
| The refusal for an unassessable event names a remedy that works                                   | **Done** (B2 → B3)                        |
| An offline demonstration is never shown, stored or billed as a model call or a cost               | **Done** (API, ledger, outcome row, page) |
| Wording A–D                                                                                       | **Done**                                  |
| Production cannot run a demonstration provider (loader, gate, constructor, runtime, real process) | **Done**, behavioral, 19/19 mutants       |
| Scoring engine, migrations, schema untouched                                                      | **Confirmed** (`git diff`)                |
| F-2 Option A, F-4                                                                                 | **Open** (blockers for live use)          |
| Live provider / spend                                                                             | **Not authorized, not started**           |
| Real matching Devpost + GitHub pair and real rubric                                               | **Missing** → real-source BLOCKED         |
| Merge, deploy, PR                                                                                 | **Not done**                              |

```
P6D_IMPLEMENTATION: READY_FOR_R8B
REAL_EVENT_UI: PASS
REAL_SOURCE_END_TO_END: BLOCKED
```
