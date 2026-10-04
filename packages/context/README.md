# @judge-copilot/context

**Layer 2 (deterministic core).** Event Context Pack domain rules. No I/O, no database, no model
calls; persistence and HTTP live in `apps/api`.

- `authority.ts` — explicit source-authority precedence table (not array order).
- `hash.ts` — source text normalization, SHA-256 content hashes, canonical JSON and the locked
  content hash.
- `conflicts.ts` — deterministic authority-based conflict resolution that keeps every position.
- `document.ts` — builds reviewed documents from extractions and applies human edits while
  preserving source provenance.
- `validation.ts` — structural (draft) and lock-time validation, including rubric weights
  (sum = 1 within `RUBRIC_WEIGHT_SUM_TOLERANCE`).
- `extractor.ts` — the `EventContextExtractor` port; its output is untrusted (`unknown`) and is
  schema- then domain-validated by callers.
- `replay-extractor.ts` — exact-match replay of recorded extractions for tests and local demos.
  It performs no semantic analysis.
