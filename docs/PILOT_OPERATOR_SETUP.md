# Pilot operator setup (P6C)

This page is for the **operator** who prepares the machine. The judge's own steps are in [DEMO_RUNBOOK §1.10](./DEMO_RUNBOOK.md) and need none of this. Nothing here
enables a live model, spends money or deploys anything. Everything runs on loopback.

## What the pilot is, and is not

- It runs the real web app, API, capture worker and assessment worker on a real PostgreSQL (or PGlite for tests).
- The assessment is the **scripted demonstrator** (`ASSESSMENT_PROVIDER=scripted`): rules that read no project and give every dimension the same fixed placeholder (70 % of its scale).
  It exists so that a judge can walk the whole interface on a genuinely captured project. **Its numbers carry no information about the project**, and every screen says so. It is refused when
  `NODE_ENV=production` (API and worker environment validation, and the runtime gate).
- The alternative `replay` mode answers only the built-in synthetic HydroTrack material.
- There is no live provider. Authorizing one is a separate decision (see the P6C report, "Requirements for the first live-model experiment").

## Environment

| Variable                  | Pilot value                                                           | Notes                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | a PostgreSQL 16 database                                              | Run `pnpm db:migrate`, then `pnpm db:verify-schema` (read-only; must report nothing missing).                                                                                                                                                       |
| `AUTH_MODE=dev`           | development actors                                                    | Loopback only. Never expose this API.                                                                                                                                                                                                               |
| `EVENT_CONTEXT_EXTRACTOR` | `none` (default) or `replay`                                          | `none`: **Build context from sources** is unavailable; edit the draft by hand (**Edit draft**) and lock it. `replay` answers only the recorded synthetic fixtures.                                                                                  |
| `ASSESSMENT_PROVIDER`     | `scripted` on **both** the API and the worker                         | They must agree: the API freezes the provider and models into each run.                                                                                                                                                                             |
| `CAPTURE_NETWORK`         | `live` for a real GitHub capture, `fixture` for the synthetic network | See "Capturing real sources" below.                                                                                                                                                                                                                 |
| `GITHUB_TOKEN`            | optional, read-only, **never committed**                              | Anonymous GitHub access is limited to 60 requests/hour per IP and a shared IP exhausts it at once (observed in P6C: first request 403, `rateRemaining: "0"`). A repository needs several requests; with ~55+ files a token is practically required. |

Start the API, worker and web as in [DEMO_RUNBOOK §1.1–1.3](./DEMO_RUNBOOK.md), with `ASSESSMENT_PROVIDER=scripted` instead of `replay` (no fixture file is needed).

## Capturing real sources

- **GitHub.** The production adapter reads the public repository through the SSRF-safe client and stores an immutable snapshot of one exact commit. If the live API rate-limits you, the capture page
  says `rate_limited` and offers **Retry capture**; nothing is lost and nothing is scored. A recorded set of real responses for `meetbhadra701-cloud/Judge @ 9459c98` is in
  `tests/fixtures/real-github/` and is what the automated pilot test replays (`pnpm test:browser`); it proves the pipeline handles real response shapes, not GitHub's current behaviour.
- **Devpost.** Devpost could not be fetched from the build environment (egress policy; the capture says the host could not be resolved). The supported alternative is that an **organizer pastes
  authorized text** on the capture page (**Provide the submission text yourself**). It is stored as an immutable snapshot, labelled `TEXT SUPPLIED BY AN ORGANIZER`, never treated as verified, and
  everything derived from it stays a team claim. Do not paste text you are not authorized to share, and do not paste anything you did not take from the actual submission.
- **The hackathon's rubric.** Official criteria, weights, rules and tracks are entered as sources with their authority (`official_judging_rubric`, `official_event_rules`, `official_track_rules`),
  separate from `organizer_guidance`. An assessment is refused up front (`NO_CONTEXT_REFERENCE_EVIDENCE`) when the locked context has no explicit rule, no explicit submission requirement and no
  declared track for the project: add an explicit rule or requirement in a new version (never invent one), lock it, and request again.

## Production-readiness checklist carried forward from R7F

None of these blocks the isolated offline pilot above. Each blocks a production or shared deployment until done.

| #   | Item                                                                                                              | Status / what to do                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The startup schema check (`assertSchemaReady`) compares table, column and trigger **names**, not full definitions | Open. A drifted column type or a changed trigger body is not detected at startup. `pnpm db:verify-schema` is the operator tool; a definition-level comparison is future work. Do not rely on startup alone.                                      |
| 2   | Some runtime roles lack permission to read the migration ledger                                                   | Open (documented). The check reads `drizzle.__drizzle_migrations`; a role without `USAGE` on schema `drizzle` and `SELECT` on that table cannot start the service. Grant exactly those two, or run the check with the migration role.            |
| 3   | No root `db:verify-schema` command                                                                                | **Fixed in P6C:** `pnpm db:verify-schema` now exists at the repository root.                                                                                                                                                                     |
| 4   | Migration 0020's history needs careful operator handling                                                          | Open (documented in [MIGRATIONS.md §6.5](./MIGRATIONS.md)): back up, run `pnpm db:migrate`, then `pnpm db:verify-schema`; never edit `__drizzle_migrations` on a database holding data you cannot rebuild.                                       |
| 5   | Concurrent cold coverage verification reads are expensive                                                         | Open. The first read of a worst-case repository costs about 0.4 s of CPU plus the text transfer, per process; N simultaneous cold readers pay it N times. Fine for one judge; add a shared cache or a single-flight guard before concurrent use. |
| 6   | The coverage-integrity error wording was misleading                                                               | **Fixed in P6C:** a record that could not be _checked_ (source unreadable) is no longer described as having _failed its integrity checks_ (test in `view.test.tsx`).                                                                             |
| 7–9 | Three further P3 findings                                                                                         | Not enumerated in the P6C task text and not reproducible from the repository; the operator should copy the remaining three from the R7F report into this table before any production decision.                                                   |

## Cleanup

Stop the three processes, and drop the pilot database. Nothing in the checkout is modified by running the pilot (the browser test asserts this).
