# packages/browser — Sandboxed deployment inspection (not yet implemented)

**Milestone:** deferred beyond M2 · **Layer:** 3 (I/O adapter)

M2 inspects deployments with a single SSRF-safe HTTP request (`packages/deployment` on top of
`packages/safe-http`); no browser is used. This package remains a placeholder.

Future responsibility: inspecting live deployments in an isolated, ephemeral, credential-less
browser behind a strict URL/SSRF policy (scheme allow-list, private/metadata address blocking
re-checked on every redirect, size/time limits). Refused URLs become `rejected` snapshots.

This directory is intentionally not a workspace package until it is implemented. See
`docs/SECURITY.md` §2.
