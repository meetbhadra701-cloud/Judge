# packages/prompts — Versioned prompt templates (not yet implemented)

**Milestone:** M1 / M5 · **Layer:** 3 (AI adapter)

Future responsibility: versioned prompt templates (e.g. `dimension-assessment/v1`) that keep
instructions strictly separate from delimited, untrusted project data, and that only let the
model reference IDs supplied by code (invariant 20). Every model-backed record stores the
prompt ID and version used.

See `docs/AI_PIPELINE.md` §5 and `docs/SECURITY.md` §3.
