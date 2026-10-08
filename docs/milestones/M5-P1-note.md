# M5 phase P1 — provider-neutral interface (note)

Scope delivered (design [M5-design.md](./M5-design.md) §13, row P1): `packages/schemas/src/assessment.ts` and the new
`packages/llm`, plus guard updates. **No** Anthropic SDK, API key, network access, migration, table, prompt, route, worker job, UI
or pipeline. Fallback anchors are still a draft and disabled. P2–P7 are not started.

Verification (local; Node 22, pnpm 10.28.0, PGlite; no PostgreSQL 16 run, because P1 touches no database code):

- `pnpm install --frozen-lockfile` before P1, then `pnpm install` once to register the new workspace package in `pnpm-lock.yaml`.
- Baseline `pnpm check` (before P1, design head `93c48f6`): exit 0, 80 files passed + 1 skipped, **1,314 passed / 16 skipped**.
- After P1 `pnpm check`: exit 0, 93 files passed + 1 skipped, **1,544 passed / 16 skipped** (+230 tests: 83 schemas, 144 llm, 3 integration guards).
- `pnpm db:generate`: no schema changes. No migration, table, route, job, prompt, SDK or API key exists.
- 18 mutation proofs (each applied, shown to fail a named test, then restored): digest ignores user blocks; digest includes the timeout; budget without the
  mutex; unknown spend not counted; ambiguous failures released as free; retry of every category; retry ceiling removed; budget wrapping retry; off-by-one call limit;
  replay keyed loosely; non-strict stage schema; model-authored `missing` unknown; 5xx treated as unsent; error summary exposing the message; wall-clock ignored; timeout
  wrapper that never times out; measured usage ignored; lone surrogate allowed in a quote. All 18 were killed.

Durable facts:

- `AssessmentRunLimits` defaults/maxima (design §12.4) are in `ASSESSMENT_RUN_LIMIT_DEFAULTS` / `_MAXIMA`.
- Deviation from the design text: the per-attempt input limit is expressed as `maxReservedInputTokensPerCall` (default 100,000), a bound on
  the **byte-based reservation**, not on real tokens. A 40K-token cap (design §12.4) would refuse ordinary 14K-token prompts because the
  byte bound is ≈ 3–4× the real count.
- Costs are exact integers in **nano-USD**; the persistence layer (P4) converts to micro-USD with a ceiling.
- `ASSESSMENT_RUN_FAILURE_CATEGORY_VALUES` extends the existing six categories with `budget_exceeded`; the shared
  `ANALYSIS_RUN_FAILURE_CATEGORY_VALUES` tuple (and so the database CHECK) is deliberately unchanged until the P4 migration.
