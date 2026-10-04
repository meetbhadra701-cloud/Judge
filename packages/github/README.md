# packages/github — Read-only GitHub snapshot adapter (not yet implemented)

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

Future responsibility: fetching repository trees, file contents and commit metadata through
read-only API access and producing immutable source snapshots. Never clones-and-runs, installs,
builds or executes anything (invariants 7, 21). Never writes to team repositories. Commit
counts are never a score input (invariant 5).

This directory is intentionally not a workspace package until M2. See `docs/SECURITY.md`.
