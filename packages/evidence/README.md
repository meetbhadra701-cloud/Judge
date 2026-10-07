# packages/evidence — Evidence graph rules (M3)

**Layer:** 2 (deterministic core — no I/O, no database, no model calls, no scoring)

The pure domain logic of the evidence graph: `Claim`, `EvidenceItem`, `EvidenceRelation`, `Unknown`
and `Contradiction`. Persistence lives in `packages/database`, HTTP in `apps/api`. Record types and
Zod creation inputs are defined in `@judge-copilot/schemas`; this package contains the rules.

| Module            | Responsibility                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verification.ts` | verification ladder; the 7 × 7 claim transition matrix; allowed levels per evidence origin and kind; anchors levels need; claim justification rules; the levels a producer can reach in M3 |
| `artifacts.ts`    | conservative classification of repository artifacts (`team_prose` / `source_code` / `unclassified`) from the M2 key, kind and media type                                                   |
| `provenance.ts`   | provenance shape and reference rules (snapshot, artifact, code-point span, verbatim excerpt, frozen event context version)                                                                 |
| `known.ts`        | the authoritative entity set and reference classification (nonexistent / wrong type / other project)                                                                                       |
| `plan.ts`         | `planEvidenceGraphBatch`: the ID-integrity validator and trusted ID assignment for a creation batch (all-or-nothing)                                                                       |
| `integrity.ts`    | `validateGraphIntegrity`: dangling, cross-project and rule violations in a loaded graph                                                                                                    |
| `graph.ts`        | in-memory graph with deterministic ordering (`seq`), contradiction pair canonicalization                                                                                                   |
| `queries.ts`      | claim/evidence views, unknowns, contradictions, bounded neighbors, supersession, provenance trace, plain-count summary, pagination                                                         |
| `ids.ts`          | `IdAllocator` port: random (production) and deterministic (tests, demos)                                                                                                                   |
| `issues.ts`       | typed issue codes, `EvidenceGraphError`, `EvidenceGraphInputError`, `EvidenceGraphPersistenceError`                                                                                        |

Rules that matter (see `docs/ARCHITECTURE.md` §12 and `docs/SCORING.md` §8):

- A team statement is a claim, not a fact: project-authored prose never exceeds `team_claim`. A
  README is team-authored prose even inside a GitHub snapshot, so only source-code artifacts may
  carry `repo_corroborated`.
- `repo_corroborated` is producer-asserted and limited: trusted code checks the artifact (right
  project, immutable GitHub snapshot, classified as source code) and that a `supports` relation
  exists, but the producer chooses the evidence text, the claim text and the relationship, so a valid
  code-file reference can support an unrelated claim. It is not machine-verified semantic truth.
- A span proves provenance, not truth. `machine_verified` (and `judge_verified`/`live_verified`) are
  unreachable for producers in M3: the planner refuses them (`VERIFICATION_NOT_AVAILABLE`). The rules
  for those levels are kept for the trusted path a later milestone adds.
- Producers never choose persisted IDs (invariant 20); a well-formed UUID proves nothing.
- Missing evidence is not negative evidence: absence/unknown evidence cannot support or contradict.
- Relations never change a claim; a corrected claim supersedes the old one (verification never
  silently drops).
- A contradiction is data for a judge: two structural sides and a neutral note, never an accusation.

Nothing here scores, weighs, ranks, estimates confidence or coverage, generates questions or calls
a model; those are M4, M5 and M6.
