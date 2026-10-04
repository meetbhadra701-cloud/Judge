# packages/capture — deterministic source-capture core

**Milestone:** M2 · **Layer:** 2 (deterministic core: no I/O, no model calls)

- **Ports:** `HttpFetcher` (implemented by `@judge-copilot/safe-http`) and `ProjectSourceAdapter`
  (implemented by `github`, `devpost`, `deployment`, `video`). Adapters return bounded, structured
  data; they never write to the database, score, create evidence or interpret judging criteria.
- **Declared-URL rules** (`normalizeDeclaredSourceUrl`): one canonical form per source type
  (GitHub repository roots only, Devpost `/software/{slug}` pages, YouTube/Vimeo/Loom detection).
- **Repository path rules** (`classifyRepositoryPath`): secret-prone paths, ignored directories,
  binaries, lockfiles and deterministic selection order.
- **Hashing:** per-artifact SHA-256 and `snapshotContentHash` (excludes timestamps and IDs).
- **Validation:** `validateCaptureResult` checks every adapter result before it is persisted.
- **HTML extraction:** non-executing parse (scripts never run, script/style text discarded), with a
  linear fallback for pathological markup.
