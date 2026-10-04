# packages/llm — Model/provider abstraction (not yet implemented)

**Milestone:** M1 / M5 · **Layer:** 3 (AI adapter)

Future responsibility: a provider-neutral structured-output interface (schema, timeout, retry
budget, cancellation) with concrete provider adapters behind it. SDK errors are mapped to
domain failure categories; credentials are never logged or placed in prompts. A provider
failure must never produce a fabricated score (invariant 22).

Deterministic packages (layer 2) may not depend on this package. See `docs/AI_PIPELINE.md`.
