# Offline demonstration runbook (P6B-alpha, revised in P6B-beta1)

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
pnpm test:browser                # builds the web app, then drives Chromium through the whole journey (about a minute)
BROWSER_SMOKE_SHOTS=/tmp/shots pnpm test:browser   # choose where the screenshots 01..10 go (default: your OS temp directory, never the checkout)
```

It starts its own database (in-process PGlite), the real API on a loopback port, the real capture worker, the real assessment loop on the replay
provider and the production web build; it needs no setup beyond a Chromium that Playwright can find (`PLAYWRIGHT_BROWSERS_PATH`, or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome`). `playwright` is a pinned **development-only** dependency. This test is not part of `pnpm check` (it needs a
browser); `pnpm check` covers the same pages with rendered-markup component tests. A run leaves the checkout exactly as it found it (the test asserts it).

## 1. The manual path

Requirements: Node ≥ 22.12, pnpm, PostgreSQL 16 with an **empty database you can drop afterwards**. Four processes: API, worker, web (and the database).
Run every command from the repository root. **Use absolute paths** for fixture directories and files (`$PWD/...`): `pnpm --filter` starts each
process inside its own package directory, so a relative path such as `tests/fixtures/...` would not be found.

```sh
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/judge_demo
pnpm install && pnpm build
pnpm db:migrate
pnpm demo:prepare --seed       # writes demo-data/replay-fixture.json and creates the labelled SYNTHETIC DEMO hackathon + project
```

`pnpm demo:prepare` records the replay fixture from the hand-written scripted model that tests use (no model is involved), and `--seed` inserts one hackathon
named `SYNTHETIC DEMO hackathon (offline replay)` with a locked Event Context and one project named `SYNTHETIC DEMO project (HydroTrack)`. It prints the URLs of
both. It refuses `NODE_ENV=production`, uses no network and writes nothing outside `demo-data/` (git-ignored) except the rows you asked for.

### 1.1 API (loopback, development actors, offline replay assessments)

```sh
NODE_ENV=development AUTH_MODE=dev API_HOST=127.0.0.1 API_PORT=3001 \
EVENT_CONTEXT_EXTRACTOR=replay EVENT_CONTEXT_REPLAY_DIR=$PWD/tests/fixtures/event-context \
ASSESSMENT_PROVIDER=replay ASSESSMENT_REPLAY_FIXTURE=$PWD/demo-data/replay-fixture.json \
pnpm --filter @judge-copilot/api dev
```

`ASSESSMENT_PROVIDER` defaults to `none`: then `POST /projects/:id/assessments` answers `503 ASSESSMENT_PROVIDER_NOT_CONFIGURED` and the page says assessments cannot be run.
`replay` (and `scripted`) are refused in production, and since P6D also when `NODE_ENV` is unset or empty: **set `NODE_ENV=development` (or `test`) explicitly** in both the API and the worker, as the commands here do. The fixture is for the models the API freezes by default (`ASSESSMENT_MODEL_EXTRACTION` / `_ASSESSMENT` / `_CRITIC`); leave those at their defaults.

### 1.2 Worker (capture on the synthetic fixture network; assessments on replay)

```sh
NODE_ENV=development CAPTURE_NETWORK=fixture CAPTURE_FIXTURE_DIR=$PWD/tests/fixtures/source-capture \
ASSESSMENT_PROVIDER=replay ASSESSMENT_REPLAY_FIXTURE=$PWD/demo-data/replay-fixture.json \
pnpm --filter @judge-copilot/worker dev
```

Without `CAPTURE_NETWORK=fixture` the capture worker would use the real network through the SSRF-safe client; that path has **never been smoke-tested against real github.com /
devpost.com** and is not claimed to be production-ready. Use the fixture network for demonstrations.

### 1.3 Web (loopback only)

```sh
JUDGE_API_URL=http://127.0.0.1:3001 JUDGE_API_TOKEN=dev-organizer pnpm --filter @judge-copilot/web dev
```

The web app listens on `http://127.0.0.1:3000`. Running it creates no file in the checkout.

### 1.4 The journey

1. Open `http://127.0.0.1:3000/`. Open the **SYNTHETIC DEMO** hackathon that `demo:prepare` printed (to build your own, create an event, a draft Event Context version, paste the sources of
   a fixture in `tests/fixtures/event-context/`, **Build**, review and **Lock**).
2. Choose **Submit a project …** (`/events/<id>/submit`). The page names the hackathon and its locked Event Context.
3. Enter the fixture links: GitHub `https://github.com/synthetic/atlas`, Devpost `https://devpost.com/software/synthetic-atlas`. Wrong or swapped links are explained next to the field,
   and keyboard focus moves to the first field to fix. Click **Submit and start capture** (it registers the two links and queues their capture; it starts no analysis).
4. You land on the capture page (`/projects/<id>/capture`): both sources "WAITING FOR THE CAPTURE WORKER"; within seconds the worker captures them and the page, which checks
   for progress every 3 seconds for up to 5 minutes (and says so), re-renders itself to "CAPTURED". After 5 minutes of no change it tells you to reload.
   Try `https://github.com/synthetic/does-not-exist`: that source shows "CAPTURE FAILED" with a plain reason and a **Retry capture** button; the other source is unaffected.
5. **Open the preliminary report** of the SYNTHETIC DEMO project (`/projects/<id>/assessment`, URL printed by `demo:prepare`). **Run assessment** is a separate click: the worker replays the recorded
   answers and the page shows a scored, verified, replay-labelled report with relative highs and lows and the unknowns **of that assessment's own material**.
   For a project you submitted yourself the run ends "RUN DID NOT COMPLETE" with the reason (§1.5).

### 1.5 Why a submitted project has no demonstration report

A replay answer is looked up by the digest of the exact request (prompt text, model, the project's captured passages, the event's rubric). Recorded answers exist only for the built-in synthetic
HydroTrack material. Material you submit through the form has no recorded answer, so an offline run on it ends with `replay_miss`, and the page says so. Making a submitted project assessable
needs either a recorded fixture for that exact material or a real provider, neither of which is part of this version. Since P6C there is a third, clearly labelled offline option for walking the
interface on arbitrary captured material: `ASSESSMENT_PROVIDER=scripted` (§1.10). Its scores are fixed placeholders, not an assessment.

### 1.6 What "Submit and start capture" promises: submission identity (P6B-beta1)

A submission is one **GitHub repository + one Devpost page** sent to one hackathon. The server creates the project, both source declarations and both capture requests in **one transaction**
(`POST /events/:id/submissions`, header `Idempotency-Key`), or nothing at all. The page generates the key when it is rendered, so pressing the button twice, a lost response, or a back-and-forward
all retry the **same** request. The rules, enforced by unique constraints in the database:

| You send                                                          | You get                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| the same form again (same key, same links)                        | the same project (`replayed`); nothing is created or queued again                                                        |
| the same two links with a new key (a reloaded page, someone else) | the same project (`already_submitted`): identical content is the same submission                                         |
| the same repository **or** the same Devpost page with other links | refused (`SUBMISSION_CONFLICT`), pointing at the project that holds the link; **nothing is merged and nothing is saved** |
| a project name that differs from another only by letter case      | refused (`PROJECT_NAME_TAKEN`); a name is a label, never an identity, and an existing project is never adopted by name   |
| the same key with different links or a different typed name       | refused (`IDEMPOTENCY_KEY_REUSED`); reload the page to start a new submission                                            |
| the same links in **another hackathon**                           | an independent project: identity is per hackathon                                                                        |

Not guaranteed: the page cannot know whether two _different_ links are the same project in reality (a renamed repository, a second Devpost page). Those are two submissions; the organizer decides.

### 1.7 Mixed projects (created before submission records existed)

Earlier versions composed a submission from separate calls and adopted an existing project by name, so two simultaneous submissions could end up in one project holding both submissions' links.
Nothing is repaired or deleted automatically.

- **Detect.** `GET /events/<id>/submission-integrity` (any signed-in organizer or judge) lists projects with several GitHub or several Devpost links, and links claimed by more than one project, and
  counts projects without a submission record. A mixed project also shows a red notice on its capture and report pages.
- **Handle.** Do not rely on a flagged project's captures or assessments: they mix more than one submission. Leave it as history. Submit each correct GitHub + Devpost pair on its own through the
  form; a flagged (mixed) project does **not** block the correct submissions of its links, so they create new, clean projects. The mixed project then shows as sharing those links in the integrity list,
  which is correct: it is the record of what happened.
- **Why not delete.** Projects, declarations and snapshots are append-only by design (audit and reproducibility). Instead an organizer can **void** a project (§1.8); the project and everything captured for it stay on record.
- Legacy routes (`POST /projects/:id/sources`) still exist for operators. A project **created by a submission** refuses any GitHub or Devpost link other than its own (`SUBMISSION_SOURCE_FIXED`, also enforced by a database trigger).

### 1.8 Correcting a wrong submission: void and replace (P6B-beta2)

A submission cannot be edited. If the wrong repository or Devpost page was entered, open the project's capture page and choose **Wrong links? Void and replace this submission**
(`/projects/<id>/correct`), give the reason, and enter the corrected GitHub and Devpost links (or untick the box to void without a replacement).

- **What happens.** In one step the project is marked **voided** (its reason, the organizer and the time are recorded) and the corrected pair becomes a new project whose captures are queued. The voided project keeps every capture,
  assessment and report it had; it only stops accepting new captures, sources and assessments, and the link to the replacement is shown on its pages. This cannot be undone; the voided project is not deleted and its links are
  free again for the replacement and for later submissions.
- **Wait for captures first.** If a capture of the project is still queued or running, the correction is refused and **nothing changes** (`PROJECT_HAS_PENDING_WORK`). Let the worker finish (the capture page shows progress), then correct.
- **Safe to retry.** The page's key travels with the form: pressing the button twice, or after a lost answer ("we could not confirm whether the correction was applied"), can only return the original result; it never creates a
  second replacement. If you are unsure, reload the project page: a voided project shows the red-bordered notice.
- **Refusals.** The corrected pair overlaps another project's links, is invalid, or uses a label another project already has: nothing is voided and nothing is created. The reason is shown; fix the links and send again.
- **Conservative defaults.** Only organizers can void. A judge sees voided projects as history. Upgrading an existing database: [MIGRATIONS](./MIGRATIONS.md).

### 1.9 No worker is running, and a correction or the Devpost text is needed (P6B-beta3)

A submission queues two captures. If no capture worker is running they stay queued, and the correction in §1.8 is refused with `PROJECT_HAS_PENDING_WORK`. Two safe ways out:

- **Start the worker** (`pnpm --filter @judge-copilot/worker start`, §1.2), let the captures finish, then correct. Nothing is lost.
- **Cancel what has not been started.** On the correction page tick **Also cancel requests that have not been started**. The captures (and any assessment request) that no worker has started are cancelled _in the same
  step_ as the void; the cancelled captures show **CAPTURE CANCELLED** ("nothing was read"). A request a worker has already started is never cancelled; the correction is refused until it finishes or its lease
  expires. If the correction cannot be completed for another reason, nothing is cancelled.

**Devpost cannot be fetched from this deployment** (the environment's network policy blocks it before the request leaves; that is not a statement about Devpost). Open the project's capture page, expand
**Provide the submission text yourself** on the Devpost row, paste the text you can see on the Devpost page, and store it. It becomes a snapshot labelled **TEXT SUPPLIED BY AN ORGANIZER**: it was not fetched and has
not been compared with the page; anything derived from it stays a team claim, and the report lists `organizer_supplied_source`. Pasting the same text twice stores nothing new; changed text becomes a new numbered
snapshot and the old one stays.

### 1.10 The offline journey for a real event (P6C, revised in P6D)

Operator preparation is in [PILOT_OPERATOR_SETUP.md](./PILOT_OPERATOR_SETUP.md). As the organizer or judge, with the web app open. **You never type JSON or an identifier.**

1. **Events → Create event**, then **Create draft version**. Add the hackathon's official texts as sources, one by one: a title, an **Authority** (official rules, official judging rubric,
   official track rules, organizer guidance), and the pasted text. The authority matters: only a statement tied to an _official_ source can be marked official.
2. Click **Edit Event Context**. This is a form, not a data file. Work through it from the top (you can save at any time and come back):
   - **Dates and how judging works** — leave a date empty if the sources do not state it. A date you fill in is marked official or an interpretation, and tied to its source.
   - **Official judging criteria** — _Add the overall judging rubric_; give its name, the lowest and highest score (for example 1 and 5), tick the official rubric source, then add each criterion with its
     weight **in percent** (they must total 100 %; leave every weight empty if the rubric publishes none: nothing is invented for you) and, optionally, a scoring guide.
   - **Event rules**, **Participation and submission requirements** — each statement is marked **Official** (it needs an official source ticked; the form refuses it otherwise), **Organizer’s
     interpretation** (your reading) or **Unverified note**. Only _Official_ statements are reference material for a report.
   - **Tracks and sponsor challenges** — add each track (name, and the source that defines it). A sponsor challenge is a track with its own requirement and, if published, its own rubric.
     A requirement can apply to every project or to one track.
   - **Organizer guidance** is advice to judges, never an official rule.
     Press **Save draft**. Problems are shown next to the field and listed at the top, in words. Weights that do not total 100 % can be saved but not locked.
3. On the review page check what is **Official**, what is an **Organizer’s interpretation** and what is an **Unverified note**, fix anything under **Cannot lock yet**, then **Lock context**.
   A locked version is frozen; later changes go into a new version (**Create new version**), which supersedes it.
4. **Submit a project** (`/events/<id>/submit`): paste the GitHub repository URL and the Devpost URL. **If the event has tracks, tick the project’s tracks on this same page.** The page tells you when a
   track is required (the event has no event-wide rule, so a report can only refer to a track). Tracks are recorded with the submission and are not edited afterwards; to change them, **Wrong links? Void and
   replace this submission** offers the same track choice. Capture starts.
5. On the capture page, GitHub shows `CAPTURED` or `CAPTURED (PARTIAL)` with the **exact commit**; what was not read is listed and is not negative evidence. If Devpost cannot be fetched it says
   `CAPTURE FAILED` with the reason; open **Provide the submission text yourself** and paste the authorized text. It is labelled `TEXT SUPPLIED BY AN ORGANIZER`. If a later retry fails, the earlier capture is
   still stored and is what a report uses; the page says so.
6. **Open the preliminary report page → Run assessment.** A request is refused at once, with the real reason and nothing queued, when the locked context has nothing to refer to for this project (no official
   event-wide rule or requirement, and no declared track) or no overall rubric. Otherwise the scripted demonstrator runs offline.
7. The report opens with **Offline demonstration, not an AI estimate** and a red **NOT AN AI ASSESSMENT** banner. Read the structure (coverage, dimensions, citations, unknowns, limitations); **ignore every
   number** — each is the same fixed placeholder. No model was called and nothing was spent: the page says "0 provider calls, no tokens, no cost". Limitations explain in words when a partial number leaves out
   dimensions the assessor itself declared insufficient (`partial_score_excludes_model_declared_insufficient`), when a newer capture attempt failed so that an older capture was assessed
   (`newer_capture_unusable`), and the coverage panel says when an expected source (GitHub or Devpost) had no usable capture.

(The raw JSON editor still exists at `…/edit/advanced` for developers and recovery. Organizers do not need it.)

What a person judging the _usefulness_ of this pilot should check is in [PILOT_USEFULNESS_CHECKLIST.md](./PILOT_USEFULNESS_CHECKLIST.md).

## 2. Checking the experience does not mislead

| Question                                  | Where the page answers it                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is capture an analysis?                   | Submit and capture pages: "not an AI analysis", "not verified".                                                                                               |
| Are these the project's current gaps?     | Report: unknowns are those of _that assessment's_ material; newer captures are listed and a new assessment is needed to refresh them.                         |
| What does 0.0 / 10 mean on a 1–5 rubric?  | Report: scores show the rubric's own scale and the normalization ("1.0 on the rubric's scale of 1 to 5 (0.0 / 10 normalized)"); no evidence means no number.  |
| Is a model used?                          | Submit, capture and report pages: "Temporary offline workflow", "recorded demonstration data only", "nothing is spent"; replay banner on every replay report. |
| Is a missing source a judgment?           | Capture page: "missing evidence, never a negative judgment"; report: "Missing information is not negative evidence".                                          |
| Is a relative high/low a quality verdict? | Report: "compares … with each other only … not necessarily strong … not necessarily weak".                                                                    |
| Can a tampered record be shown?           | No: a failed integrity check withholds the whole assessment with guidance by code.                                                                            |

## 3. Cleanup

Stop the three processes. The demonstration data lives only in the database you created; drop it. Nothing outside the repository and that database is written.
