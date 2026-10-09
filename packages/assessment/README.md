# @judge-copilot/assessment — the trust boundary (M5, phase P3)

**Layer:** 2 (deterministic core) · depends on `@judge-copilot/context`, `@judge-copilot/evidence`, `@judge-copilot/schemas`,
`@judge-copilot/scoring` only. Pure TypeScript: no model, prompt, provider, network, filesystem, clock, randomness, database or
worker. It never imports `llm`, `prompts` or `database`; the P5 orchestrator wires those around it.

Every model output has already passed its strict Zod schema (gate 1) when it reaches this package (gate 2). Gates **reject, never
repair**. Models refer to records only through code-assigned handles; this package maps handles to ids and derives every span,
excerpt, origin and verification label itself. Issues carry gate, code and path (never source or model text).

## What is here

| Concern                        | Module                        | Public entry points                                                                 |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| Source routing                 | `routing.ts`                  | `routeArtifact`, `SOURCE_ROUTING_POLICY` (`source-routing/v1`)                      |
| Selection and windowing        | `windowing.ts`                | `buildPassages`, `passageRanges`, `statementViews`, `interpretViews`                |
| Exact quote location           | `quote.ts`                    | `locateQuote`                                                                       |
| G1 claims, G2 evidence         | `extraction.ts`               | `gateClaims`, `gateEvidence`, `pendingReviews`                                      |
| G2b fidelity                   | `extraction.ts`               | `resolveFidelity`                                                                   |
| Citable team statements        | `statements.ts`               | `buildStatementItems`                                                               |
| G3 / G3b relations             | `relations.ts`                | `gateRelations`, `pairsForVerification`, `resolveVerification`                      |
| G4 contradictions, G5 unknowns | `commentary.ts`, `neutral.ts` | `gateContradictions`, `gateUnknowns`, `containsAccusation`                          |
| Label policy (Option B)        | `label-policy.ts`             | `levelForEvidence`, `levelForClaim`, `LABEL_POLICY_ID`                              |
| Event-Context reference set    | `event-evidence.ts`           | `buildEventReferenceItems`                                                          |
| Code-authored gaps             | `source-gaps.ts`              | `sourceGapUnknowns`                                                                 |
| Graph planning and scoping     | `graph.ts`                    | `assembleExtractionBatch`, `dryRunPlan`, `verifyClosure`, `membersOf`, `scopeGraph` |
| Candidate sets, pre-gates      | `candidates.ts`               | `buildCandidateSets`, `preGate`                                                     |
| G6 judgments, post-gates       | `judgment.ts`                 | `gateJudgment`, `applyPostGates`, `buildAssessorJudgments`, `deterministicFlags`    |
| G7 critic, decision table      | `critic.ts`                   | `gateCritic`, `decideAfterCritic`                                                   |
| Aggregate technical rule       | `run-policy.ts`               | `evaluateRun`                                                                       |
| Limitations                    | `limitations.ts`              | `collectLimitations`                                                                |
| Report verification            | `verify-report.ts`            | `verifyStoredAssessment`, `storedFormOf`                                            |
| Both gates in order            | `stage.ts`                    | `validateClaimExtraction`, ... `validateCritic`                                     |

## Quote policy (F3)

Captured text is never altered and no offset is computed on a normalized copy. A quote is located by exact code-point match inside
**one passage** and must occur exactly once (overlapping occurrences count). A quote can never contain a carriage return or another
forbidden control (the `Quote` schema), so a multi-line quote **cannot be located across CRLF or lone-CR line endings**: it is
rejected as `quote_crosses_line_ending`. Single-line quotes in such text are located with exact original code-point offsets.
Characters that may not appear in passage text (C0 controls other than tab, LF, CR; DEL; lone surrogates) are excluded from every
passage and separate passages, so no quote spans them. See `docs/milestones/M5-P3-note.md`.

## Not here

No database, no migration, no model call, no worker, no API, no UI, no question generation. Persisting the graph, extraction
membership, assessment rows and reports is P4; sequencing the stages is P5.
