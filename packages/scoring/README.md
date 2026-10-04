# packages/scoring — Deterministic score engine (not yet implemented)

**Milestone:** M4 · **Layer:** 2 (deterministic core — no I/O, **never** imports `llm`/`prompts`)

Future responsibility: `scoring-engine/v1` — dimension → criterion → overall weighted
aggregation, rubric weight validation, evidence strength formula, coverage, the
assessment-confidence index, insufficient-evidence handling, and pre → post delta computation.
Specified in `docs/SCORING.md`.

Same inputs and engine version must always yield the same outputs (invariant 9). Commit counts,
keyword counts, stars, LOC, dependency counts and AI use never directly award or remove points.

This directory is intentionally not a workspace package until M4. See `docs/V1_CONTRACT.md`.
