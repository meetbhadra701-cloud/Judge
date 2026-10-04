# Judge Copilot

A **human-in-the-loop** hackathon judging system. Judge Copilot prepares judges with
evidence-backed pre-reads, shows where its assessment is uncertain, suggests the five questions
most likely to resolve that uncertainty, reassesses only what the interview affects, and leaves
the **final score to the human judge**.

> **Status: Milestone 2 — Immutable project-source ingestion.** Events with versioned, locked
> official context (M1); projects, declared Devpost/GitHub/deployment/video sources and immutable,
> hashed source snapshots captured read-only through an SSRF-safe client (M2), behind
> organizer/judge authentication. There is no claim extraction, evidence, scoring or model use yet.

## Read first

| Document                                     | What it covers                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| [docs/PRODUCT.md](docs/PRODUCT.md)           | the problem, the human-in-the-loop loop, the Event Context Pack                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | pipeline, deterministic vs. LLM boundary, invariants, packages, dependency rules       |
| [docs/SCORING.md](docs/SCORING.md)           | 0–10 scale, rubric precedence, fallback rubric and dimensions, coverage vs. confidence |
| [docs/AI_PIPELINE.md](docs/AI_PIPELINE.md)   | model-backed stages, validation, prompt versioning, failure semantics                  |
| [docs/SECURITY.md](docs/SECURITY.md)         | no code execution, SSRF, prompt injection, secrets                                     |
| [docs/V1_CONTRACT.md](docs/V1_CONTRACT.md)   | milestone sequence M0–M9 and the definition of done                                    |

## Requirements

- Node.js ≥ 22.12
- pnpm 10 (`corepack enable`)
- PostgreSQL ≥ 16 — only for `pnpm db:migrate`; tests use in-process PGlite

## Commands

```sh
pnpm install          # install workspace dependencies
pnpm check            # everything below, in order

pnpm format:check     # Prettier
pnpm lint             # ESLint (strict, type-checked)
pnpm typecheck        # tsc --noEmit for every package, app and the root tests
pnpm db:check         # drizzle-kit migration consistency
pnpm test             # Vitest — unit, migration and integration tests (no network)
pnpm build            # build every package and app in dependency order

pnpm db:generate      # generate a migration after changing packages/database/src/schema
pnpm db:migrate       # apply migrations (requires DATABASE_URL)

pnpm --filter @judge-copilot/api dev      # API on http://127.0.0.1:3001/health
pnpm --filter @judge-copilot/worker dev   # capture worker (idle without DATABASE_URL)
pnpm --filter @judge-copilot/web dev      # Event Context UI on http://localhost:3000
```

### Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`.
Both jobs must pass:

- **Quality** runs `pnpm check` after a frozen-lockfile install.
- **PostgreSQL 16** runs `pnpm test` against a disposable PostgreSQL 16 service
  (`TEST_DATABASE_URL=…/judge_copilot_test`).

CI uses a read-only token and no secrets.

### Running the Event Context workflow locally

```sh
pnpm build                                            # web consumes built workspace packages
DATABASE_URL=postgres://… pnpm db:migrate
DATABASE_URL=postgres://… pnpm --filter @judge-copilot/api dev
JUDGE_API_URL=http://127.0.0.1:3001 pnpm --filter @judge-copilot/web dev
```

No extractor is configured by default, so you author drafts in the edit view. To replay the
synthetic recorded extractions in `tests/fixtures/event-context/` (development only), start the
API with `EVENT_CONTEXT_EXTRACTOR=replay EVENT_CONTEXT_REPLAY_DIR=tests/fixtures/event-context`
and paste a fixture's source texts with matching authorities.

### Authentication (M2)

Every API route except `/health` requires a bearer credential. Without `AUTH_MODE` the API fails
closed (503). Locally, enable the development actors explicitly (refused in production):

```sh
AUTH_MODE=dev DATABASE_URL=postgres://… pnpm --filter @judge-copilot/api dev
JUDGE_API_TOKEN=dev-organizer JUDGE_API_URL=http://127.0.0.1:3001 pnpm --filter @judge-copilot/web dev
```

`dev-organizer` may do everything; `dev-judge` may read and request captures. Deployments use
`AUTH_MODE=jwt` with `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_JWKS_URL` (and optionally
`AUTH_JWT_ROLES_CLAIM`, default `roles`) from any OIDC/OAuth provider issuing signed JWTs.

### Capturing project sources (M2)

```sh
DATABASE_URL=postgres://… pnpm --filter @judge-copilot/worker dev
```

Create a project on a locked event, declare its sources, and request captures (the API answers
202; the worker captures). To use the synthetic fixture network instead of the internet
(development only, refused in production), start the worker with
`CAPTURE_NETWORK=fixture CAPTURE_FIXTURE_DIR=tests/fixtures/source-capture`. `GITHUB_TOKEN`
(optional, read-only) raises GitHub's rate limit for public repositories; it is never logged or
stored.

Copy `.env.example` to `.env` for local overrides. Never commit real values.
Package scripts use POSIX `VAR=value cmd` syntax; on Windows use WSL.
