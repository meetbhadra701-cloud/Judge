# Offline demonstration runbook (P6B-alpha)

What this runs: the **offline** Judge Copilot experience that exists today, end to end on one machine: hackathon with a locked Event Context →
GitHub + Devpost links → capture of the two pages (synthetic fixture network) → the **preliminary report** page, where assessments run on a
**recorded offline replay provider**. It is a demonstration of the workflow, **not** an AI analysis of a real submission.

Read these limits first; the pages say the same:

| What you will see                                      | What it is                                                                                                                                             | What it is not                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| "CAPTURED" for GitHub / Devpost                        | the page text was stored as an immutable snapshot (here: from a synthetic **fixture network**, no internet)                                            | an analysis, a verification that the project works, or a check of the live site |
| A preliminary report with scores                       | hand-written, recorded answers replayed for the **built-in synthetic HydroTrack project only**, then scored by the deterministic engine                | a live model's opinion, or a score for the project you submitted                |
| "RUN DID NOT COMPLETE" for a submitted project         | the expected, honest outcome offline: no recorded answer exists for that material (or the event context has no reference evidence, a known limitation) | a bug in your submission                                                        |
| Anything about five questions, answers, a final report | **not part of this version**                                                                                                                           | —                                                                               |

No live model provider exists in this repository, no API key is used, and nothing is spent.

## 0. The fast path: the automated real-browser walkthrough

```sh
pnpm install
pnpm build                       # workspace packages
pnpm test:browser                # builds the web app, then drives Chromium through the whole journey (about 20 s)
BROWSER_SMOKE_SHOTS=/tmp/shots pnpm test:browser   # keep screenshots 01..10 of each step
```

It starts its own database (in-process PGlite), the real API on a loopback port, the real capture worker, the real assessment loop on the replay
provider and the production web build; it needs no setup beyond a Chromium that Playwright can find (`PLAYWRIGHT_BROWSERS_PATH`, or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`). `playwright` is a pinned **development-only** dependency. This test is not part of `pnpm check` (it needs a
browser); `pnpm check` covers the same pages with rendered-markup component tests.

## 1. The manual path

Requirements: Node ≥ 22.12, pnpm, PostgreSQL 16 with an empty database. Four processes: API, worker, web (and the database).

```sh
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/judge_demo
pnpm install && pnpm build
pnpm db:migrate
```

### 1.1 API (loopback, development actors, offline replay assessments)

```sh
AUTH_MODE=dev API_HOST=127.0.0.1 API_PORT=3001 \
EVENT_CONTEXT_EXTRACTOR=replay EVENT_CONTEXT_REPLAY_DIR=tests/fixtures/event-context \
ASSESSMENT_PROVIDER=replay ASSESSMENT_REPLAY_FIXTURE=/path/to/replay-fixture.json \
pnpm --filter @judge-copilot/api dev
```

`ASSESSMENT_PROVIDER` defaults to `none`: then `POST /projects/:id/assessments` answers `503 ASSESSMENT_PROVIDER_NOT_CONFIGURED` and the page says assessments cannot be run.
`replay` is refused in production. The replay fixture is a hand-written synthetic file; **one is not shipped for the submit flow** (see 1.5).

### 1.2 Worker (capture on the synthetic fixture network; assessments on replay)

```sh
CAPTURE_NETWORK=fixture CAPTURE_FIXTURE_DIR=tests/fixtures/source-capture \
ASSESSMENT_PROVIDER=replay ASSESSMENT_REPLAY_FIXTURE=/path/to/replay-fixture.json \
pnpm --filter @judge-copilot/worker dev
```

Without `CAPTURE_NETWORK=fixture` the capture worker would use the real network through the SSRF-safe client; that path has **never been smoke-tested against real github.com / devpost.com** and is not
claimed to be production-ready. Use the fixture network for demonstrations.

### 1.3 Web (loopback only)

```sh
JUDGE_API_URL=http://127.0.0.1:3001 JUDGE_API_TOKEN=dev-organizer pnpm --filter @judge-copilot/web dev
```

### 1.4 The journey

1. Open `http://127.0.0.1:3000/`, create an event, open it, create a draft Event Context version, paste the sources of a fixture in
   `tests/fixtures/event-context/` (matching authorities, see the README), **Build**, review and **Lock**. (Or use the Event Context editor to author the JSON.)
2. On the event page choose **Submit a project …** (`/events/<id>/submit`). The page names the hackathon and its locked Event Context.
3. Enter the fixture links: GitHub `https://github.com/synthetic/atlas`, Devpost `https://devpost.com/software/synthetic-atlas`. Wrong or swapped links are explained next to the field. Click **Start analysis**.
4. You land on the capture page (`/projects/<id>/capture`): both sources "WAITING FOR THE CAPTURE WORKER"; within seconds the worker captures them and the page refreshes itself to "CAPTURED".
   Try `https://github.com/synthetic/does-not-exist`: that source shows "CAPTURE FAILED" with a plain reason and a **Retry capture** button; the other source is unaffected.
   Submitting the same links again never creates a second project or a second pending capture.
5. **Open the preliminary report page.** With replay configured, **Run assessment** is a separate click. For a submitted project the run ends "RUN DID NOT COMPLETE" with the reason (see the table above).
6. To see a full report offline, use the built-in synthetic project: it is what `pnpm test:browser` does (step 9 of the screenshots): scored report, relative highs and lows, unknowns and missing information,
   limits, and the withheld view after deliberate corruption.

### 1.5 Why a submitted project has no demonstration report

A replay answer is looked up by the digest of the exact request (prompt text, model, the project's captured passages, the event's rubric). Recorded answers exist only for the built-in synthetic
HydroTrack material (`apps/worker/src/testing/`, hand-authored). Material you submit through the form has no recorded answer, so an offline run on it ends with `replay_miss`, and the page says so.
Making a submitted project assessable needs either a recorded fixture for that exact material or a real provider, neither of which is part of this slice. If the models the API freezes into a run
differ from the models a fixture was recorded for, every digest differs and the first call is also a `replay_miss`; the API's models are `ASSESSMENT_MODEL_EXTRACTION` / `_ASSESSMENT` / `_CRITIC`.

## 2. Checking the experience does not mislead

| Question                                  | Where the page answers it                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is capture an analysis?                   | Submit and capture pages: "not an AI analysis", "not verified".                                                                                               |
| Is a model used?                          | Submit, capture and report pages: "Temporary offline workflow", "recorded demonstration data only", "nothing is spent"; replay banner on every replay report. |
| Is a missing source a judgment?           | Capture page: "missing evidence, never a negative judgment"; report: "Missing information is not negative evidence".                                          |
| Is a relative high/low a quality verdict? | Report: "compares … with each other only … not necessarily strong … not necessarily weak".                                                                    |
| Can a tampered record be shown?           | No: a failed integrity check withholds the whole assessment with guidance by code.                                                                            |

## 3. Cleanup

Stop the three processes. The demonstration data lives only in the database you created; drop it. Nothing outside the repository and that database is written.
