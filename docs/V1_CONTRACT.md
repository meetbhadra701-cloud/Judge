# Judge Copilot — V1 Delivery Contract

This contract governs how V1 is built, by humans and coding agents alike.

## Rule of progression

> **Agents must not start milestone N+1 until milestone N passes its tests and its milestone
> report has been written and accepted.**

- Each milestone ends with a **milestone report** in `docs/milestones/` listing the scope
  delivered, the commands run, exact pass/fail results, deferred items and known limitations.
- If a milestone cannot be completed as specified, stop and report. Do not quietly change the
  scope.
- A milestone may not "borrow" functionality from a later one because it seems easy.
- Any decision that would materially change [ARCHITECTURE.md](./ARCHITECTURE.md), the
  invariants, or the deterministic/LLM boundary must be raised with the project owner before it
  is implemented.
- Existing migrations are never edited. Each milestone adds new ones.

## Milestones

| #      | Milestone                              | Delivers                                                                                                                                                                                                                                 | Must not include                                                    |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **M0** | **Foundation**                         | monorepo, strict TS, lint/format/test tooling, `GET /health` API, idle worker, placeholder web page, foundational Zod vocabularies, domain lifecycle classifications, audit contract, Drizzle + 4 foundational tables, architecture docs | any judging functionality, model calls, integrations, scoring, auth |
| **M1** | **Event Context**                      | Event Context Pack data model; normalized source text with authority and hashes; extraction **port** with deterministic replay (no model); human review/edit UI; lock/supersede workflow with audit; `universal_fallback` authority      | source ingestion, project assessment, model calls                   |
| **M2** | **Immutable Source Ingestion**         | projects; read-only Devpost/GitHub/deployment/video snapshot adapters; URL/SSRF policy; immutable `SourceSnapshot` records with hashes and statuses                                                                                      | claim extraction, scoring                                           |
| **M3** | **Evidence Graph**                     | `Claim`, `EvidenceItem`, `EvidenceRelation`, `Unknown`, `Contradiction` persistence and graph queries; verification levels; ID integrity validation                                                                                      | scoring, AI assessment                                              |
| **M4** | **Scoring Engine**                     | `scoring-engine/v1`: dimension → criterion → overall aggregation, weights validation, evidence strength, coverage, confidence index, insufficient-evidence handling; fully deterministic and golden-tested                               | model calls                                                         |
| **M5** | **AI Pre-Interview Assessment**        | claim/evidence extraction and dimension assessment via the provider abstraction; schema + domain validation; critic pass; immutable `pre_interview` assessment version                                                                   | question generation                                                 |
| **M6** | **Uncertainty + Five-Question Engine** | uncertainty analysis; candidate question generation; deterministic information-gain ranking; top five                                                                                                                                    | interview capture                                                   |
| **M7** | **Interview Mode**                     | judge UI to ask questions, type team answers and record live verifications; `TeamAnswer` persistence                                                                                                                                     | reassessment                                                        |
| **M8** | **Post-Interview Reassessment**        | answer decomposition; affected-dimension selection; reassessment of affected dimensions only; immutable `post_interview` version; explained `ScoreChange` deltas                                                                         | final score                                                         |
| **M9** | **Human Final Judgment**               | authenticated judge enters the authoritative `JudgeFinalScore`; AI cannot modify it; full audit trail                                                                                                                                    | —                                                                   |

Authentication and authorization are required before any non-local deployment and no later than
M2, the first milestone that ingests team data. The human final score (M9) requires them. M1 is
local-only: the API binds to `127.0.0.1` by default.

### Refinements recorded in M1

- The first model-backed extractor (`llm`/`prompts`) moved from M1 to no earlier than M5. M1
  delivers the extraction port, validation and a deterministic replay extractor, so the workflow
  is proven before any provider behaviour exists.
- The universal fallback rubric is not materialized as data in M1. It is consumed by scoring, so
  its data definition lands with the scoring engine (M4). M1 supports `universal_fallback` as the
  lowest source authority.
- `in_review` remains in the Event Context vocabulary but is unused. The explicit lock action is
  the human review gate.

### Refinements recorded in M2

- Authentication and authorization (organizer, judge) were delivered in M2 as the contract
  requires: an `AuthVerifier` port, provider-neutral JWT/JWKS verification and an explicit,
  production-refused development verifier. They protect the M1 Event Context routes as well.
- `analysis_runs` gained the `pending` state for queued capture work (with project/snapshot links
  and a worker lease). Terminal runs are now frozen by trigger.
- Deployment inspection in M2 is a single SSRF-safe HTTP observation; the sandboxed headless
  browser (`packages/browser`) remains deferred. Video capture is metadata only.

### Refinements recorded in M3

- The evidence graph adds exactly the five artifacts the architecture names (`Claim`,
  `EvidenceItem`, `EvidenceRelation`, `Unknown`, `Contradiction`). No version or root entity was
  added. The only new vocabulary is the relation type (`supports`, `contradicts`); the existing
  vocabularies are unchanged.
- M3 has no semantic extractor and no producer. Its write path is a validated, transactional
  service (`EvidenceGraphStore.createGraph`) that M5 will call. The HTTP surface is read-only.
- `team_answer` and `judge_observation` stay in the evidence-origin vocabulary but cannot be created
  until M7 provides the records they point at. Judge verification levels are likewise unreachable
  until then.
- One compatibility change to an M2 table (`source_snapshot_artifacts(id, snapshot_id)` unique key)
  was made in a new migration so evidence can pin an artifact to its snapshot with a composite key.
  No M2 trigger or constraint was modified.
- `evidence.read` is a new permission held by both roles; there is no evidence write permission.

### Refinements recorded in M4

- The scoring engine is a **pure library**. It adds no table, migration, route, job or UI, and persists
  nothing: an assessment version (with the engine version, rubric identity, fingerprints and cited IDs
  the report already carries) is M5's artifact.
- M4 makes exactly one runtime change outside `packages/scoring` and `packages/schemas`: graph reads are
  now consistent (`loadGraph` runs in one read-only `REPEATABLE READ` transaction). `createGraph` is
  unchanged, and no migration, trigger or constraint was added or edited.
- An **official criterion is one atomic assessment unit**: no human-reviewed sub-dimension mapping
  exists, so none is pretended. The 36-dimension decomposition is the fallback rubric's.
- An unweighted official rubric never yields an official overall number; an equal-weight preview
  exists only on explicit request and is always labeled unofficial.
- Trusted attestations are internal and empty. A trusted attestation architecture is the business of
  the milestone that introduces a trusted producer (M7), under its own approval.
- Dimension judgments, their classification of cited evidence, the database-backed adapter that builds the
  trusted context, and any API or UI are M5 or later.

## Definition of done (every milestone)

- dependencies install cleanly from the lockfile;
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` are clean;
- `pnpm db:check` passes and `pnpm db:generate` reports no pending schema changes;
- `pnpm test` passes with no external network access;
- `pnpm build` succeeds;
- no secrets tracked;
- the architectural invariants still hold (milestone report includes an "architecture drift
  check");
- the milestone report is committed.

## Milestone reports

- [M0 — Foundation](./milestones/M0-report.md)
- [M1 — Event Context Pack](./milestones/M1-report.md)
- [M2 — Immutable Project-Source Ingestion](./milestones/M2-report.md)
- [M3 — Evidence Graph](./milestones/M3-report.md)
- [M4 — Deterministic Scoring Engine](./milestones/M4-report.md) (design: [M4-design](./milestones/M4-design.md))
