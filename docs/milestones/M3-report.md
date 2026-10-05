# Milestone 3 — Evidence Graph: Report

**Baseline:** `main` at `839e1bee92da7faa20d4f01080ea64bec4db5a46` (Merge pull request #3, M2).
**Branch:** `claude/m3-evidence-graph`.

M3 implements only this segment of the pipeline:

```
immutable snapshots → [producer: not in M3] → validated graph batch → trusted planner
→ Claim / EvidenceItem / EvidenceRelation / Unknown / Contradiction (immutable) → graph queries
```

There is **no semantic extractor** in M3: nothing derives claims or evidence from source text, and
the graph content in tests and the demo is explicit fixture data. There is no scoring, weight,
evidence strength, coverage, confidence, uncertainty ranking, question generation, interview
mode, assessment version, model call, prompt, embedding or LLM. No new root or version entity was
added: the five artifacts the architecture names are the whole model.

## Scope delivered

### Package `packages/evidence` (new Layer-2 workspace package, pure)

| Module            | Contents                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `verification.ts` | ladder, 7 × 7 claim transition rule, evidence origin/kind/level matrix, anchor requirements, claim justification rules |
| `provenance.ts`   | provenance shape and reference rules, code-point span helpers                                                          |
| `known.ts`        | `KnownEntities` (authoritative set) and `resolveKnown` (nonexistent / wrong type / other project)                      |
| `plan.ts`         | `planEvidenceGraphBatch`: ID-integrity validator, trusted ID assignment, all-or-nothing                                |
| `integrity.ts`    | `validateGraphIntegrity` for loaded graphs (dangling, cross-project, every rule)                                       |
| `graph.ts`        | indexed in-memory graph, `seq` ordering, contradiction pair canonicalization                                           |
| `queries.ts`      | claim/evidence views, unknowns, contradictions, bounded neighbors, supersession, provenance trace, summary, pagination |
| `ids.ts`          | `IdAllocator` port: `randomIdAllocator` (production), `deterministicIdAllocator` (tests, demo)                         |
| `issues.ts`       | 35 typed issue codes, `EvidenceGraphError`, `EvidenceGraphInputError`, `EvidenceGraphPersistenceError`                 |

It imports only `@judge-copilot/domain` and `@judge-copilot/schemas` plus `node:crypto` (hashing
for deterministic test IDs). A scope test forbids filesystem, network, process, database,
environment, clock and random access in the package, and any scoring-like export.

### Schemas (`packages/schemas`)

`evidence-graph.ts`: the one new vocabulary (`EVIDENCE_RELATION_TYPE_VALUES = supports | contradicts`),
`GRAPH_NODE_TYPE_VALUES`, `SPAN_UNIT`, `EVIDENCE_GRAPH_LIMITS`, deterministic text normalization
(`normalizeGraphText`, `normalizeClaimText`), and the **creation inputs** (`strictObject` everywhere):
`ClaimInput`, `EvidenceItemInput`, `EvidenceProvenanceInput`, `EvidenceRelationInput`,
`UnknownInput`, `ContradictionInput`, `EvidenceGraphBatchInput`. `evidence-graph-api.ts`: persisted
record schemas (`ClaimRecord`, `EvidenceRecord`, `RelationRecord`, `UnknownRecord`,
`ContradictionRecord`) and the HTTP contract (summary, claim/evidence detail, provenance trace,
neighborhood, pages). The existing vocabularies (`VerificationLevel`, `EvidenceKind`,
`EvidenceOrigin`, `UnknownType`) were reused unchanged.

### Database (migrations `0007_m3_evidence_graph`, `0008_m3_evidence_graph_integrity`, `0009_m3_supersession_guard_hardening`)

Exactly five new tables, no later-milestone table and no junction table:

| Table                | Notes                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claims`             | `supersedes_id`; composite FK `(supersedes_id, project_id)`; `UNIQUE(supersedes_id)` (one successor); `supersedes_id <> id`; single-line NFC text ≤ 1,000           |
| `evidence_items`     | `event_id` repeated for the composite FKs; snapshot/artifact/context-version composite FKs; span columns; CHECKs generated from the shared rule tables              |
| `evidence_relations` | composite FKs to the same project; `UNIQUE(claim_id, evidence_id)` (no duplicate or conflicting relation)                                                           |
| `unknowns`           | `claim_ids[]` / `evidence_ids[]` (GIN-indexed, ≤ 50 each) validated by trigger                                                                                      |
| `contradictions`     | exactly two sides in four composite FKs; generated `side_a_key` / `side_b_key`; `side_a_key < side_b_key COLLATE "C"`; `UNIQUE(project_id, side_a_key, side_b_key)` |

Every table has `seq`, a database-generated identity value: the persisted insertion/allocation order, used as the deterministic, locale-independent ordering key of all queries (not content-derived; allocated at insert, not at commit). Migration
`0007` also adds `UNIQUE(id, snapshot_id)` to `source_snapshot_artifacts`, the composite-key target
that lets evidence pin an artifact to its snapshot (an M2 compatibility change in a **new**
migration; no M2 trigger or constraint was changed). Migration `0008` (hand-written) adds:

- append-only triggers: UPDATE/DELETE reject on all five tables, TRUNCATE rejects (also `CASCADE`);
- `claims_supersession_guard`: the verification-never-silently-drops rule (the 49-pair matrix);
- `evidence_items_provenance_guard`: snapshot is `captured`/`partial`, its source type matches the
  origin, the span lies inside the artifact's persisted text and the excerpt equals it exactly,
  the context version is `locked`/`superseded`;
- `evidence_relations_kind_guard` and `contradictions_kind_guard`: absence/unknown evidence cannot
  support, contradict or be a side;
- `unknowns_reference_guard`: every referenced claim/evidence item exists in the same project, no
  duplicates, no nulls.

The existing migrations 0000–0006 were not edited. `0007` was reordered by hand once (the generated
file added the artifact unique key after the foreign key that needs it) before it was ever committed.

### API (`apps/api`)

New permission `evidence.read` (organizer and judge; there is no evidence write permission).
Read-only routes, all authenticated:

`GET /projects/:projectId/evidence-graph`, `…/evidence-graph/neighbors`, `…/claims`,
`…/claims/:claimId`, `…/evidence`, `…/evidence/:evidenceId`, `…/unknowns`, `…/contradictions`.

Lists use keyset pagination (`limit` 1–200, default 50; `after`), claims have `current=true`,
evidence has `kind`/`origin` filters. POST/PUT/PATCH/DELETE on those paths answer
`405 GRAPH_READ_ONLY`. A claim or evidence ID of another project answers exactly like a
nonexistent one (`404 CLAIM_NOT_FOUND` / `EVIDENCE_NOT_FOUND`). Typed errors:
`PROJECT_NOT_FOUND`, `CLAIM_NOT_FOUND`, `EVIDENCE_NOT_FOUND`, `NODE_NOT_FOUND`, `GRAPH_READ_ONLY`,
`INVALID_REQUEST`. There is no score, assess, analyze, question, rank or winner route and nothing
triggers a model.

### Write path (`packages/database`)

`EvidenceGraphStore.createGraph(projectId, batch, actorId)`, the only writer and the integration
point M5 will use. Audit action `evidence_graph.created` (counts and IDs only).
`loadGraph` and `verifyIntegrity` read it back.

### Web (`apps/web`)

A read-only project Evidence view (`/projects/:id/evidence`) and a claim page. All text is React
text (escaped); no HTML/Markdown rendering; no scores, AI buttons, generated questions or cheating
labels. A scope test forbids `dangerouslySetInnerHTML` and Markdown renderers in `apps/web`.

## Design decisions

1. **Claim, EvidenceItem, EvidenceRelation, Unknown, Contradiction only.** No version/root entity.
   Re-verification of a claim is expressed through supersession, the "approved immutable-history
   mechanism" of the architecture; evidence levels are fixed at creation.
2. **Trusted IDs.** Producers submit batch-local refs and `{ id }` references to existing
   entities, never IDs for new records. `IdAllocator` assigns every UUID; production uses random v4
   (`randomIdAllocator`), tests and the demo use `deterministicIdAllocator` so runs are
   reproducible. _Interpretation to confirm:_ "deterministic UUID assignment" was read as "assigned
   by deterministic, trusted code (injectable and reproducible)", not "content-addressed". A
   content-addressed scheme (UUIDv5 of the batch) is a small change inside `ids.ts` if the owner
   prefers idempotent replays.
3. **Span semantics.** Offsets are Unicode **code points** into the artifact's stored text,
   half-open `[start, end)`, ≤ 2,000 long. Code points are what PostgreSQL's `substr`/`char_length`
   count, so the database can verify spans without parsing hostile content. The stored `excerpt` is
   the verbatim span text, derived by the planner (a producer-supplied excerpt must match exactly)
   and re-verified by a trigger. No normalization is applied to excerpts: they are verbatim copies.
4. **Contradiction = exactly two sides.** "At least two distinct sides" is satisfied literally;
   n-way inconsistencies are several pairwise records. A pair is canonical (`claim:` sorts before
   `evidence:`, then by ID, byte order) and unique, so (A, B) and (B, A) are one record.
5. **Unknown references as validated arrays**, not junction tables. Referenced rows can never
   change or disappear (all tables are append-only), so a trigger check is equivalent to a foreign
   key, and the Unknown stays one immutable row. This is the M1 precedent (`source_ids` arrays).
6. **Event-context provenance is version-level**: M1 facts have no stable per-item ID, and
   redesigning M1 was out of scope.
7. **`team_answer` and `judge_observation` are refused** (domain rule and CHECK
   `evidence_items_origin_supported_in_m3`) until M7 supplies the records they would point at.
   Consequently `judge_verified` and `live_verified` claims are unreachable in M3, although their
   rules and the full transition matrix are implemented and tested.
8. **Absence is not negative evidence.** `absence` and `unknown` evidence cannot support or
   contradict a claim and cannot be a contradiction side; they feed Unknowns.
9. **Whole-project reads.** Detail, summary and neighbor endpoints load one project's graph
   (bounded by per-project caps) and apply the pure queries, so there is one definition of every
   query.

## Verification rules

**Ladder** (docs/SCORING.md §8): `unverified` < `team_claim` < `repo_corroborated` = `machine_verified`
< `judge_verified` = `live_verified`; `contradicted` is off the ladder.

**Claim transitions** (a new claim superseding an old one): to or from `contradicted` is always
allowed; otherwise the new tier may not be lower. Allowed (36 of 49):

| From                                    | May become                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `unverified`                            | any level                                                                                                |
| `team_claim`                            | `team_claim`, `repo_corroborated`, `machine_verified`, `judge_verified`, `live_verified`, `contradicted` |
| `repo_corroborated`, `machine_verified` | `repo_corroborated`, `machine_verified`, `judge_verified`, `live_verified`, `contradicted`               |
| `judge_verified`, `live_verified`       | `judge_verified`, `live_verified`, `contradicted`                                                        |
| `contradicted`                          | any level                                                                                                |

The 13 rejected pairs are every move to a lower tier (for example `machine_verified → team_claim`,
`live_verified → unverified`). The domain function and the database trigger agree on all 49 pairs
(a test inserts each pair).

**Evidence levels by origin and kind** (fixed at creation; `contradicted` never applies):

| Origin                   | `fact`                                                | `claim`                    | `absence`, `unknown`, `contradiction`                                                       |
| ------------------------ | ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `devpost`, `video`       | `unverified`, `team_claim`                            | `unverified`, `team_claim` | `unverified`                                                                                |
| `github`                 | `unverified`, `repo_corroborated`, `machine_verified` | `unverified`, `team_claim` | `unverified`                                                                                |
| `deployment`             | `unverified`, `machine_verified`                      | `unverified`, `team_claim` | `unverified`                                                                                |
| `event_context`          | `unverified`                                          | not allowed                | `unverified`                                                                                |
| `team_answer` (M7)       | not allowed                                           | `unverified`, `team_claim` | `unverified` (unknown, contradiction)                                                       |
| `judge_observation` (M7) | `judge_verified`, `live_verified`                     | not allowed                | `judge_verified`, `live_verified` (absence); `unverified`, `judge_verified` (contradiction) |

Anchors: `repo_corroborated` needs an artifact, which must be repository **source code** (see the
hardening pass below); `machine_verified` would need an artifact **and** a span. Claim levels need
graph material: `repo_corroborated` needs a `supports` GitHub `fact` at `repo_corroborated`;
`contradicted` needs a Contradiction naming the claim; `unverified` / `team_claim` need nothing; the
rules for `machine_verified`, `judge_verified` and `live_verified` stay defined for later but are
**unreachable for producers in M3** (hardening pass). A relation never changes a claim's level.
Devpost text captured successfully stays `team_claim` at most. A span proves provenance, never that
the evidence text or a claim is true.

## Hardening pass (post-review): three P1 blockers

An independent hostile review found three P1 blockers in the first M3 commit (`15818f5`, kept
intact). Only these were fixed, in one follow-up commit.

**P1-1 — `machine_verified` trust boundary.** The old rules let a producer label a GitHub
span-backed `fact` `machine_verified`, add a `supports` relation and so obtain a `machine_verified`
claim, although a span only proves the cited text exists. Now:

- The vocabulary and all rules for `machine_verified`, `judge_verified` and `live_verified` are
  unchanged, but the producer path refuses them on evidence items **and** claims
  (`VERIFICATION_NOT_AVAILABLE`), whatever else the batch contains. `machine_verified` means
  "established by trusted deterministic machine observation"; M3 has no such producer. A later
  milestone adds a separate trusted path. `validateGraphIntegrity` does not apply the producer gate.
- Producer-reachable levels in M3 (`M3_PRODUCER_VERIFICATION_LEVELS`): `unverified`, `team_claim`,
  `repo_corroborated` and `contradicted` (claims only, with a Contradiction).
- `repo_corroborated` needs source code. `classifyRepositoryArtifact` (fail closed, from the real M2
  key/kind/media type) returns `team_prose` for README\*, `*.md/.mdx/.markdown/.rst/.txt/.adoc/.asciidoc`,
  HTML, CHANGELOG/CONTRIBUTING-style names and anything under `docs/`, `doc/`, `documentation/`,
  `wiki/` (even code in them); `source_code` only for a `file` artifact with a programming-language
  extension; `unclassified` for metadata artifacts (`repository.json`, `commits.json`, `tree.json`,
  `omissions.json`), configuration, data and unknown files. Only `source_code` may corroborate
  (`ARTIFACT_NOT_CORROBORATING`). Limitation: per file, so a span may still quote a team-written
  comment in a source file.
- Synthetic Atlas now demonstrates `repo_corroborated` ("The project implements an offline tile
  cache", backed by a span in `src/cache.ts`) and records the deployment observation ("The captured
  deployment response records HTTP status 200") as an `unverified` fixture observation with the same
  exact span, because M3 has no trusted deterministic observation producer. A new demo test
  refuses `machine_verified` and README corroboration over the real captured artifacts.
- No database CHECK was added for the producer-reachable levels (the review accepted
  planner-level enforcement as the write boundary). _Proposal, not implemented:_ a small CHECK
  forbidding `judge_verified`/`live_verified` on `claims` could be added now, but the future
  trusted path for `machine_verified` would need a migration to relax it; it is left to the owner.

**P1-2 — per-project writers.** `createGraph` locked the project with `FOR SHARE`, which does not
serialize writers: with 1,999 of 2,000 claims, 12 concurrent one-claim batches all saw 1,999 and
wrote 2,011 claims. It now takes `FOR NO KEY UPDATE` as its first locking operation, so writers of
one project serialize (and the cap holds) while writers of other projects, FK inserts into the graph
tables (`FOR KEY SHARE`) and the lock ordering are unaffected. A PostgreSQL-only test with real
connections shows exactly one of 12 racers wins, 11 get `PROJECT_LIMIT_EXCEEDED`, 2,000 claims
remain, one audit event was written and no loser left a partial graph; with `FOR SHARE` restored
the same test fails (all 12 succeed). Further tests hold the lock on project A and show project B's
writer and direct FK inserts for A proceed while A's second writer waits, that 24 mixed concurrent
batches across two projects finish without deadlock, and that concurrent duplicate supersessions,
relations and contradiction pairs (either side order) have exactly one winner.
`seq` is documented as persisted insertion/allocation order, not a canonical content order.

**P1-3 — supersession bypass.** `0008`'s trigger returned `NEW` when the predecessor was not found,
trusting the end-of-statement foreign key; in one multi-row statement that allowed A→B/B→A cycles,
a three-cycle through data-modifying CTEs, and a verification downgrade by listing the successor
first. Migration `0009` (0008 untouched) redefines the guard: a predecessor that is not already
visible to the trigger is rejected (SQLSTATE `23503`); self-supersession is still left to the clean
`claims_not_self_superseding` CHECK; the transition check is unchanged. A predecessor-first chain in
one `INSERT ... VALUES` is accepted (tested on PGlite and PostgreSQL 16) but nothing relies on it;
successor-first chains and CTE siblings fail closed. "Cycle-free by construction" was reworded to the
real mechanism: no forward references, immutable rows and a single successor. With the old behaviour
restored in `0009`, the three bypass tests fail.

Mutation proofs: removing the producer gate and the prose classification fails 17 regression tests;
restoring `FOR SHARE` fails the cap-race test; restoring the fail-open trigger fails the three
bypass tests. All were restored.

## ID-integrity algorithm

1. Parse the batch with the strict Zod schema (no IDs, origins, timestamps or scores can be smuggled).
2. Collect every ID the batch mentions and look it up in **every table and every project**
   (`KnownEntities`), plus snapshots of mentioned artifacts, existing relation/contradiction pairs
   and per-project totals.
3. Allocate trusted IDs for new claims and evidence; register batch-local refs (duplicates reported).
4. Resolve each reference in a fixed order: not known → `*_NOT_FOUND`; known as another entity
   type → `WRONG_ENTITY_TYPE`; of another project/event → `CROSS_PROJECT_REFERENCE`.
5. Apply provenance, verification, relation, unknown, contradiction and supersession rules;
   collect **all** issues, sorted by path then code.
6. Any issue → no plan, nothing written. Otherwise insert in one transaction.

## Graph queries

Claim with supporting/contradicting evidence; evidence with the claims it affects; unknowns of a
claim; contradictions touching a node; breadth-first neighbors (depth ≤ 4, ≤ 500 nodes,
cycle-safe, deterministic order); supersession chain and current claim; provenance trace
(evidence → snapshot → artifact → span); plain-count summary (zeros included, no scores);
keyset pagination; dangling/cross-project audit (`validateGraphIntegrity`, `verifyIntegrity`).

## Tests

New test files: `packages/schemas/src/evidence-graph.test.ts`; in `packages/evidence/src/`:
`verification`, `plan`, `integrity`, `queries`, `ids`; in `packages/database/src/`:
`evidence-graph-guards` (direct SQL), `evidence-graph-store`, `m3-migration-upgrade`;
`apps/api/src/evidence-graph/routes.test.ts`; `apps/worker/src/capture/evidence-graph-demo.test.ts`.
Updated: `migrations.test.ts` (table list), `authorization.test.ts`, `milestone-scope.test.ts`.
Every database-backed test file runs on PGlite and, with `TEST_DATABASE_URL`, on real
PostgreSQL 16 (FK, trigger, generated-column, TRUNCATE-by-cascade, rollback and collation
behaviour). The PostgreSQL-only test runs two real concurrent supersessions through separate
connections and requires exactly one winner.

| Area         | Proves                                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schemas      | every vocabulary accepted/rejected; bounds; NFC/single-line normalization; smuggled `id`/`createdAt`/`score`/`isCheating` rejected; UUID canonicalization                                                                                                             |
| Verification | complete 7 × 7 transition matrix, complete origin × kind × level matrix, team statements capped at `team_claim`, judge levels unreachable without judge evidence                                                                                                      |
| ID integrity | well-formed nonexistent UUIDs; wrong entity type; other-project IDs; wrong snapshot/artifact; duplicate and conflicting relations; self/cross-project/second-successor supersession; deterministic issue ordering                                                     |
| Provenance   | every origin; failed/rejected/pending snapshots; source-type mismatch; artifact of another snapshot; code-point spans (emoji); out-of-range/empty/reversed/oversized spans; excerpt mismatch                                                                          |
| Graph        | claim↔evidence↔claim, unknown and contradiction traversal, provenance trace, supersession chain/current, cycle and branch safety, bounded neighbors, order independence                                                                                               |
| Database     | UPDATE/DELETE/TRUNCATE rejected on all five tables; FK and same-project integrity; no UPDATE-rewired cycles and (0009) no single-statement cycles; transition matrix in SQL; excerpt/bounds triggers; rollback on one bad member; M2 → M3 upgrade over populated data |
| API          | 401/403/503; organizer and judge read; cross-project IDs answer like nonexistent; bounded paging; 405 on writes with nothing changed; no scoring routes; no score-like key in any response; inert hostile text                                                        |
| Security     | prompt-injection, tool-call JSON, script, SQL and cheating-accusation text stored and returned verbatim; no verification change; audit metadata free of project text; no source execution                                                                             |

## Manual deterministic demo (compiled API and worker, PostgreSQL 16)

Fresh database, `pnpm db:migrate`, the compiled worker with `CAPTURE_NETWORK=fixture` captured
fixture A (Devpost, GitHub, deployment) as real snapshots; a throwaway script (not committed)
inserted a small graph through `EvidenceGraphStore.createGraph`; the compiled API
(`AUTH_MODE=dev`) then answered (this run predates the hardening pass and labelled one claim
`machine_verified`, which M3 now refuses; the transport, auth, immutability and provenance results
stand, and the hardening probes below were re-run):

- unauthenticated `GET /projects/:id/claims` → `401`;
- summary → 2 claims, 2 evidence items, 1 relation, 1 unknown, 0 contradictions;
- claims → `machine_verified | The project implements an offline tile cache.` and
  `team_claim | Offline state survives a process restart.`;
- evidence provenance → `source_snapshot`, GitHub snapshot `captured`, artifact `files/src/cache.ts`,
  span `{start: 0, end: 25, unit: code_points}`, excerpt `export function cacheTile`, no issues;
- `POST /projects/:id/claims` → `405 GRAPH_READ_ONLY`; `GET /projects/:id/score` → `404`;
- `UPDATE claims …` and `TRUNCATE claims CASCADE` in `psql` → `ERROR: claims rows are immutable …`
  / `claims cannot be truncated: the evidence graph is append-only`; the counts were unchanged;
- audit: one `evidence_graph.created` event with counts only.

The committed, automated equivalent is `evidence-graph-demo.test.ts` ("Synthetic Atlas"): real
captures of fixtures A and D through the real SSRF-safe client and adapters, then explicit fixture
claims, evidence (with exact spans), relations, an unknown, a contradiction and a supersession;
it asserts provenance, traversal, verification labels, determinism (two independent databases give
identical IDs), rejected invented IDs, immutability against direct SQL, rollback, inert injection
text and the absence of scores. The claims are fixture data; the demo content follows what the
synthetic fixtures actually contain rather than the example wording in the task.

## Verification commands (final run)

Run locally on Node 22.22.0 / pnpm 10.28.0 after the hardening pass (the first M3 commit measured
59 files / 806 tests on PGlite and 59 files / 1,034 on PostgreSQL 16):

| Command                                                          | Result                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                 | clean ("Already up to date")                                                                                                                                                                                                                                                                                                                                    |
| `pnpm check` (format, lint, typecheck, db:check, test, build)    | exit 0                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm db:check` / `pnpm db:generate`                             | "Everything's fine" / "No schema changes, nothing to migrate" (after migration `0009` and its metadata)                                                                                                                                                                                                                                                         |
| `pnpm test` (PGlite)                                             | **62 files (61 passed, 1 skipped), 878 tests: 870 passed, 8 skipped** (the PostgreSQL-only concurrency file and test) — M2 baseline 48 / 482                                                                                                                                                                                                                    |
| `TEST_DATABASE_URL=… pnpm test` (PostgreSQL 16.14, `en_US.utf8`) | **62 files, 1,124 tests: 1,123 passed, 1 skipped** (the same race test on PGlite) — M2 baseline 48 / 572                                                                                                                                                                                                                                                        |
| `pnpm build`                                                     | succeeds (all packages, API, worker, Next.js)                                                                                                                                                                                                                                                                                                                   |
| Secrets scan                                                     | no matches (AWS/GitHub/OpenAI/Slack/Google key patterns, private keys, tracked `.env`)                                                                                                                                                                                                                                                                          |
| External network in tests                                        | none: the preloaded network guard rejects non-loopback connections; the capture demo uses the in-process fixture network                                                                                                                                                                                                                                        |
| Hostile probes (fresh PostgreSQL 16, fully migrated)             | P1-1: `machine_verified`/judge/live and README corroboration refused, README `team_claim` and source `repo_corroborated` accepted; P1-2: 12 racers at 1,999/2,000 → 1 wins, 11 `PROJECT_LIMIT_EXCEEDED`, 2,000 claims; P1-3: 2-cycle, CTE 3-cycle and successor-first downgrade rejected (`23503`), predecessor-first chain accepted, self-supersession `23514` |

The local PostgreSQL was created with an `en_US.utf8` default collation like the CI service image
(the M2 collation canary test requires a non-`C` default). Pull-request results (Quality and
PostgreSQL 16) are reported with the pull request.

## M3 SECURITY / INTEGRITY PROOF

- **No dangling IDs.** Every reference is a composite foreign key (claims, relations, contradiction
  sides, evidence provenance) or a trigger-validated array (unknowns); `verifyIntegrity` returns
  `[]` after every demo and store test; `validateGraphIntegrity` reports `DANGLING_REFERENCE` for
  damaged graphs (unit-tested).
- **No cross-project edges.** All foreign keys carry `project_id` (and `event_id`/`snapshot_id`
  where relevant); the planner reports `CROSS_PROJECT_REFERENCE` first; direct-SQL tests show the
  database rejects every cross-project insert independently of the application.
- **No fabricated IDs.** Creation inputs are strict schemas without persisted IDs; trusted code
  allocates every UUID; syntactically valid but nonexistent IDs are rejected for claims, evidence,
  snapshots, artifacts, context versions, unknown references and contradiction sides.
- **Provenance cannot point at the wrong snapshot or artifact.** Composite foreign keys pin the
  snapshot to the project and the artifact to that snapshot; triggers reject failed, rejected and
  pending snapshots, a mismatching source type and a span or excerpt that is not in the persisted text.
- **The graph is immutable.** UPDATE, DELETE and TRUNCATE (including by cascade) fail in PostgreSQL
  on all five tables on PGlite and PostgreSQL 16; a correction is a new, superseding claim.
- **Source material remains inert data.** Hostile text is stored verbatim, returned as JSON
  strings, rendered as React text, never verified, scored or executed; the scope tests forbid
  process/VM/eval/dynamic-import code paths and HTML/Markdown rendering.
- **No scoring or model functionality exists.** No score/weight/confidence/coverage/rank column,
  record field, export, route or UI element; no model SDK, provider endpoint, prompt or
  embedding; the milestone-scope test enforces all of it on implementation surfaces.

## Architecture drift check

| Invariant                 | Holds in M3 because                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2                         | every graph record is addressable by ID and carries structural provenance                                                |
| 3, 14                     | `absence`/`unknown` establish nothing, cannot support/contradict, Unknowns exist; insufficient evidence is representable |
| 4                         | team statements cap at `team_claim`; relations never upgrade a claim                                                     |
| 5, 6                      | commit counts and keywords never raise a level (nothing reads them)                                                      |
| 7, 21                     | nothing is executed; repository text is read as data                                                                     |
| 8, 23                     | project text is inert data end to end                                                                                    |
| 9, 13, 24                 | no scoring, confidence or aggregation exists                                                                             |
| 17                        | evidence pins an exact snapshot; recapture is a different snapshot                                                       |
| 19, 20                    | schema validation, then domain/ID validation; the producer never chooses IDs                                             |
| 22                        | there is no model; a failed batch writes nothing                                                                         |
| 25                        | contradictions are neutral structural data with no accusation, penalty or score                                          |
| 1, 10, 11, 12, 15, 16, 18 | unchanged: no assessment, interview, final score or official-assessment code exists                                      |

The dependency rules held: `evidence` is Layer 2 (depends on `domain`, `schemas`); `database`
(Layer 3) depends on it; `api` and the worker's tests depend on it; `llm`/`prompts` are not reachable.
The pipeline was not collapsed: M3 adds the claims/evidence/contradictions/unknowns stage only.

## Known limitations

- Event-context evidence is provenance at **version level**; M1 facts are not individually
  addressable. Per-fact provenance would need an M1 change.
- `team_answer` / `judge_observation` evidence and judge/live-verified claims are unreachable until M7.
- The database does not enforce claim-level **justification** (it needs the relations, which are
  inserted after the claim); the planner enforces it on the only write path, and
  `validateGraphIntegrity` re-checks stored graphs. A direct administrative insert could bypass it.
- Excerpts and the NFC check depend on PostgreSQL's and Node's Unicode tables agreeing; a rare
  mismatch would surface as an `EvidenceGraphPersistenceError` (no data written), not as bad data.
- Detail/summary/neighbor endpoints load a whole project graph. Per-project caps (2,000 claims,
  5,000 evidence items, 10,000 relations, 1,000 unknowns, 1,000 contradictions) bound it; larger
  projects would need query-level pagination.
- A snapshot that is still `pending` when a batch is planned is rejected even if it finishes a
  moment later.
- `EvidenceGraphStore` does not wrap the write in a retry for serialization conflicts; a concurrent
  supersession or duplicate is reported as a typed issue and the caller may re-plan.
- The web view shows the first 200 records of each list and says so.

## Deferred (not started)

M2's documented P2 backlog was **not** touched (DNS fallback, final-origin adapter checks, GitHub
401/403 categorization, content secret scanning, lease heartbeat, capture cooldown, Unicode display
ordering, `truncateUtf8`, giant GitHub tree behaviour, and the miscellaneous M2 cleanups). No M3
feature depended on any of them.

M4 (scoring engine), M5 (model-backed extraction and assessment), M6 (uncertainty and questions),
M7 (interview), M8 (reassessment) and M9 (final judgment) are not started.

## M4 NOT STARTED

No scoring, weight, evidence-strength, coverage, confidence, uncertainty, question, interview,
assessment, model, prompt or embedding code exists. The milestone-scope guard (now advanced to M3)
fails if any appears before its milestone.
