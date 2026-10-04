# packages/questions — Question validation and ranking (not yet implemented)

**Milestone:** M6 · **Layer:** 2 (deterministic core — no I/O, no model calls)

Future responsibility: validating model-written candidate questions (bound to existing
unknown/claim/dimension IDs, valid mode, neutral non-accusatory phrasing) and ranking them
with a **deterministic information-gain score** to select the top five. Question _phrasing_ is
produced by the model via the worker; ranking is never delegated to a model.

This directory is intentionally not a workspace package until M6. See `docs/V1_CONTRACT.md`.
