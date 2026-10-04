# Judge Copilot

A **human-in-the-loop** hackathon judging system. Judge Copilot prepares judges with
evidence-backed pre-reads, shows where its assessment is uncertain, suggests the five questions
most likely to resolve that uncertainty, reassesses only what the interview affects, and leaves
the **final score to the human judge**.

> **Status: Milestone 0 — engineering foundation.** There is no judging functionality yet.

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
pnpm --filter @judge-copilot/worker dev   # idle worker
pnpm --filter @judge-copilot/web dev      # placeholder web page
```

Copy `.env.example` to `.env` for local overrides. No API keys or tokens are needed in M0.
Package scripts use POSIX `VAR=value cmd` syntax; on Windows use WSL.
