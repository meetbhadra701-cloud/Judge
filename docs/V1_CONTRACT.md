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
| **M1** | **Event Context**                      | Event Context Pack data model; ingestion of official documents; AI-assisted _draft_ extraction (first `llm`/`prompts` use); human review UI; lock/supersede workflow with audit; fallback-rubric handling                                | source ingestion, project assessment                                |
| **M2** | **Immutable Source Ingestion**         | projects; read-only Devpost/GitHub/deployment/video snapshot adapters; URL/SSRF policy; immutable `SourceSnapshot` records with hashes and statuses                                                                                      | claim extraction, scoring                                           |
| **M3** | **Evidence Graph**                     | `Claim`, `EvidenceItem`, `EvidenceRelation`, `Unknown`, `Contradiction` persistence and graph queries; verification levels; ID integrity validation                                                                                      | scoring, AI assessment                                              |
| **M4** | **Scoring Engine**                     | `scoring-engine/v1`: dimension → criterion → overall aggregation, weights validation, evidence strength, coverage, confidence index, insufficient-evidence handling; fully deterministic and golden-tested                               | model calls                                                         |
| **M5** | **AI Pre-Interview Assessment**        | claim/evidence extraction and dimension assessment via the provider abstraction; schema + domain validation; critic pass; immutable `pre_interview` assessment version                                                                   | question generation                                                 |
| **M6** | **Uncertainty + Five-Question Engine** | uncertainty analysis; candidate question generation; deterministic information-gain ranking; top five                                                                                                                                    | interview capture                                                   |
| **M7** | **Interview Mode**                     | judge UI to ask questions, type team answers and record live verifications; `TeamAnswer` persistence                                                                                                                                     | reassessment                                                        |
| **M8** | **Post-Interview Reassessment**        | answer decomposition; affected-dimension selection; reassessment of affected dimensions only; immutable `post_interview` version; explained `ScoreChange` deltas                                                                         | final score                                                         |
| **M9** | **Human Final Judgment**               | authenticated judge enters the authoritative `JudgeFinalScore`; AI cannot modify it; full audit trail                                                                                                                                    | —                                                                   |

Authentication and authorization are introduced no later than the first milestone that exposes
non-public data (expected M1), and the human final score (M9) requires them.

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
