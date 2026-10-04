# packages/github — read-only GitHub snapshot adapter

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

GET-only access to `https://api.github.com`: repository metadata → default branch → **exact
commit SHA** (one ref lookup per snapshot) → commit, recursive tree, bounded history
(`commits?sha=`) and blobs, all addressed by Git object id. Each blob is verified against its Git
SHA-1. No clone, no git executable, no GraphQL, no writes. Repository content is never executed,
installed, built or imported. Secret-prone paths are never fetched; limits (20,000 tree entries,
250 commits, 256 KiB per file, 8 MiB total, 400 files, 120 s) produce `partial` snapshots with
explicit reasons. The optional `GITHUB_TOKEN` is sent only to the API origin and never logged or
stored. Commit counts, stars and file counts are data only (invariant 5).

`githubFixtureRoutes` expands a synthetic repository description into REST responses for tests.
