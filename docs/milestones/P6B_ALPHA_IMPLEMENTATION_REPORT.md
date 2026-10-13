# P6B-alpha — implementation report

| Item                                 | Value                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                               | `claude/p6b-alpha-implementation` (from the accepted P6A baseline; the P6A branch is untouched; nothing merged, `main` untouched)                                         |
| Accepted baseline                    | `43673782132ede84a04ab4ab0f365887937d19ee`                                                                                                                                |
| Planning commit (included)           | `b74e247`                                                                                                                                                                 |
| **Implementation commit**            | `2d89813d754e34682a8fd7ccc6513d9c8ce273a8` — all code, tests and docs below. This report is added by the following commit (a report cannot contain its own commit's SHA). |
| Live model, paid call, key, deploy   | none. No provider exists in the repository; nothing was spent.                                                                                                            |
| Migrations / new routes / new tables | none (`pnpm db:generate`: "No schema changes, nothing to migrate"). Only existing API routes are used.                                                                    |

## 1. What was implemented

### Workstream A — R6C P3 repairs

- **D12** (`apps/web/lib/assessment-view.ts`): a score is shown as the verified report's canonical decimal text (never binary-rounded to one
  decimal; at least one decimal is always shown). Percentages are rounded half-up on the decimal digits with `BigInt`, not `Math.round(value*100)`.
  The precision notice now says scores are shown exactly as the verified report states them and that the canonical value is the report's.
- **D13** (`assessment/view.tsx`): the raw `scored` disposition tag is rendered only for assessed dimensions, so an insufficient dimension with
  `no_usable_citation` no longer carries a contradictory `scored` tag.
- **D15** (`packages/assessment/src/verify-judgments.test.ts`): a permanent pure-verifier regression (no database) — a `no_usable_citation` row whose
  disposition is anything but `scored` is rejected with `mismatch: 'disposition'` (one case per non-`scored` disposition value).
  Removing the protection from `verify-report.ts` fails 14 tests (see §3).
- **D14** stays a documented deferred integrity limitation (unchanged; see `P6B_PREFLIGHT_PLAN.md`).

### Workstream B — submission interface (existing APIs only)

- `/events/:eventId/submit` — names the active hackathon and its **locked** Event Context; without a locked context it shows an explanation and **no form**.
  GitHub and Devpost URL fields with actionable errors (`describeUrlRejection`, using the pure declared-URL parsers of `@judge-copilot/capture`), an
  optional project name (derived from the URL when empty), and a "Temporary offline workflow" notice. The submit button is disabled while pending
  (`useFormStatus`).
- Server action → `runSubmission(api, eventId, input)` (`apps/web/lib/submission.ts`): create or reuse the project (`POST /events/:id/projects`), register
  both sources (`POST /projects/:id/sources`), request a capture only for sources that have none or a failed/rejected one
  (`POST …/captures`). It is **idempotent by construction**: every step tolerates the API's uniqueness answers (`PROJECT_NAME_TAKEN` → reuse if the
  existing project's sources agree, otherwise a visible name-conflict failure; `DUPLICATE_SOURCE`; `CAPTURE_ALREADY_PENDING`). A double click or a
  concurrent resubmit therefore converges on one project, two sources and at most one pending capture per source. **It never calls an assessment route.**
- `/projects/:projectId/capture` — per-source stage (`not requested`, `waiting`, `captured`, `partial`, `failed`, `rejected`) with the failure category
  and any partial gaps in words, "Attempt #N", a per-source retry (tolerates `CAPTURE_ALREADY_PENDING`), a 3 s auto-refresh (≤ 100 ticks) while a
  capture is in flight, and the next step offered only when at least one source has content. Captured text says it is _not an analysis_ and _not
  verified_. The assessment remains a separate explicit click.
- SSRF protection, timeouts and source attribution are unchanged (the worker's `safe-http` path is not touched).

### Workstream C — preliminary report

- The assessment page is titled **Preliminary report** and states it is preliminary and advisory; the human judge's final score is authoritative.
- **Unknowns section**: the existing stored unknowns (`GET /projects/:id/unknowns?limit=50`) for a verified assessment only; nothing is synthesized.
- **Relative section** (`relativeDimensions`): highest and lowest _assessed_ dimensions, compared with each other only. Insufficient / not-assessed
  dimensions are never treated as zero and are counted separately; ties show all tied dimensions; fewer than two assessed dimensions shows no
  comparison; all-equal scores say there is no highest or lowest. No claim of absolute quality.
- Withheld (unverified) assessments stay fully withheld (only safe metadata) with per-failure-code guidance; failed / cancelled / replay runs get
  specific explanations (`FAILURE_CODE_EXPLANATIONS`, including `replay_miss` and `no_context_reference_evidence`); the launch control offers "show
  the newest withheld assessment" when applicable.
- No M6 question generation was started.

### Workstream D — runbook and browser validation

- `docs/DEMO_RUNBOOK.md` (new; linked from `README.md`): the fast automated path, the manual API / worker / web path, what each page means and does not
  mean. `docs/ARCHITECTURE.md` updated (web → capture dependency, the two new pages).
- `tests/browser/journey.browser.ts` + `vitest.browser.config.ts` + `pnpm test:browser`: `playwright` **1.56.1**, a **development-only** dependency,
  driven as a library from vitest. It starts in-process PGlite, the real API, the real capture worker (fixture network), the real assessment loop
  (replay provider) and the production web build.

## 2. Test results (actually executed)

| Gate                                                                                | Result                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` (format, lint, typecheck, `db:check`, PGlite test suite, build)        | **exit 0**. `prettier`: all files formatted; `eslint --max-warnings=0` clean; typecheck clean; `Test Files 176 passed \| 5 skipped (181)`, `Tests 2928 passed \| 57 skipped \| 3 todo (2988)`; build clean (routes include `/events/[eventId]/submit`, `/projects/[projectId]/capture`) |
| Full suite on **PostgreSQL 16.15, ICU locale `en-US`**, disposable `judge_icu_test` | `Test Files 181 passed (181)`, `Tests 3677 passed \| 1 skipped \| 6 todo (3684)`                                                                                                                                                                                                        |
| `pnpm db:generate`                                                                  | "No schema changes, nothing to migrate"                                                                                                                                                                                                                                                 |
| `git diff --check`                                                                  | clean                                                                                                                                                                                                                                                                                   |
| `pnpm test:browser` (real Chromium, not part of `pnpm check`)                       | `Test Files 1 passed (1)`, `Tests 8 passed (8)`                                                                                                                                                                                                                                         |

New / extended tests: `tests/integration/submission-flow.test.ts` (19; real API through `app.inject`, real capture worker), `submission-rules.test.ts`
(29), `assessment-ui-view.test.ts` (38 in total, extended), the `assessment/view.test.tsx` component tests (23), the capture and submit view tests, the D15
block in `verify-judgments.test.ts`, and the 8 browser tests. They cover: URL validation, project reuse and name conflict, duplicate sources, retries,
double submits and concurrent submits, per-source failure isolation (one source failing does not hide the other), navigation, no assessment started by
submission, ties / single / partial / insufficient relative sections, withheld guidance, and the canonical-precision display.
Tests make no external network call.

The PostgreSQL server was started for this run from a fresh data directory (the earlier one no longer existed) with `initdb … --locale-provider=icu --icu-locale=en-US`.
The Node warning about `NODE_TLS_REJECT_UNAUTHORIZED` comes from the sandbox environment, not from this repository.

## 3. Mutation proofs

Each mutation was applied to the source, the relevant test files were run (the runner prints the number of test files so a filter that silently
matches nothing is visible), and the source was restored. **19 of 19 applied mutations were killed** (plus one extra, below):

| Mutation                                                                                 | Result | Failing tests |
| ---------------------------------------------------------------------------------------- | ------ | ------------- |
| D15: disposition check removed from the `no_usable_citation` branch (`verify-report.ts`) | killed | 14            |
| D13: disposition tag always rendered                                                     | killed | 1             |
| D12: `formatScore10` back to `toFixed(1)`                                                | killed | 9             |
| D12: percentage via `Math.round(value * 100)`                                            | killed | 3             |
| Form: GitHub URL errors not reported                                                     | killed | 22            |
| Flow: existing project not reused on `PROJECT_NAME_TAKEN`                                | killed | 4             |
| Flow: conflicting existing project not detected                                          | killed | 1             |
| Flow: capture requested on every submit                                                  | killed | 2             |
| Flow: `DUPLICATE_SOURCE` from a concurrent submit treated as an error                    | killed | 1             |
| Flow: an assessment is requested after the captures                                      | killed | 1             |
| Capture status: a failed capture reported as having content                              | killed | 3             |
| Capture page: retry offered for a waiting capture                                        | killed | 2             |
| Capture page: next step offered with no captured source                                  | killed | 1             |
| Relative: a missing dimension counted as zero                                            | killed | 5             |
| Relative: only the first of tied dimensions shown                                        | killed | 2             |
| Relative: a comparison made from a single dimension                                      | killed | 2             |
| Guidance: one failure code left unexplained                                              | killed | 1             |
| Failure text: `replay_miss` explained as a provider outage                               | killed | 1             |
| Withheld: "show the newest withheld assessment" not offered                              | killed | 1             |
| Capture text: "not an analysis" removed (run separately)                                 | killed | 2             |

One entry in the runner's table had no test files assigned (a placeholder) and was not run; it is not counted above.

## 4. Unresolved limitations (stated plainly)

1. **No live model.** Assessments run only on the recorded offline replay provider. Nothing here is an AI analysis of a real submission.
2. **A submitted project gets no demo report.** Replay fixtures are keyed by request digest and exist only for the built-in synthetic HydroTrack
   material, so an offline run on a submitted project ends with `replay_miss` or `no_context_reference_evidence` (known finding **F-3**, still
   undecided). The UI explains this; the real-browser run reproduces it. The scored-report states are exercised on the synthetic project.
3. **Capture is validated on controlled fixtures only.** Real GitHub / Devpost capture is not claimed production-ready; the fixture network is
   deterministic and offline.
4. **D14** (integrity limitation) and **F-2 / F-3 / F-4 / F-8 / F-9 / F-11 / F-12** remain as recorded in the P6A decisions and the preflight plan.
5. **The browser test is outside `pnpm check`** (it needs a Chromium) and is a single end-to-end journey plus state checks; it is not a cross-browser matrix.
6. The relative section compares verified scores that already exist. It is not a new assessment, and with few assessed dimensions it deliberately shows less.
7. The web app still has no per-user login (loopback only, SECURITY §10); the submission flow inherits that.

## 5. Short user walkthrough (offline demonstration)

1. Open the hackathon page; follow **Submit a project** (needs a locked Event Context).
2. Paste a GitHub and a Devpost link and press **Analyze Project**. This creates the project, registers both sources and queues two captures — it does
   **not** start an assessment.
3. The capture page shows each source: waiting → captured / partial / failed. A failure names its category; **Retry** re-queues only that source.
4. When at least one source is captured, open the **Preliminary report**. Press the assessment control yourself (a separate, explicit step on the
   offline replay provider).
5. For a project without recorded answers the page says plainly that the run did not complete and why. For a verified assessment it shows scores
   exactly as the report states them, insufficient dimensions as insufficient, the stored unknowns, and the relative highest / lowest assessed
   dimensions, always as preliminary and advisory. The human judge's final score is authoritative.
6. Questions, interview and reassessment (M6–M8) do not exist yet.

Exact commands: `docs/DEMO_RUNBOOK.md`.

## 6. Verdict

READY_FOR_R7A
