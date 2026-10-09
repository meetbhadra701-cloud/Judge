# M5 phase P3 — the trust boundary (`packages/assessment`) (note)

Scope delivered (design [M5-design.md](./M5-design.md) §3.1, §4, §5.3, §8.7–§8.9, §9, §13 row P3), plus the P2 corrections F1–F3 below. **No** model call, SDK, API key,
migration, table, PostgreSQL write, worker, route, UI, question generation or interview functionality. Fallback anchors are still a disabled draft. P4–P7 are not started.

## P2 corrections (review of `80973eb`)

- **F1 — the exact locked version.** `officialUnitFromLockedSnapshot` now requires `{ versionId, lockedContentHash, eventId }`. The snapshot's version id (compared case-insensitively),
  event id and content hash must all match, in that order of checks after `not_locked`/`event_mismatch`; a different version with byte-identical content fails with `version_mismatch`.
  Tests: correct version, identical-content twin (both directions), mismatched event, changed hash, superseded context, missing version in the expectation. Structural only: authenticity is P4.
- **F2 — marker instructions.** The record-marker formats are defined once (`ITEM_BEGIN` / `ITEM_END` in `frame.ts`); the renderer emits them and the system-text clause describes them from the same
  functions, with `{handle}` and `{code}` placeholders (the old clause wrote four closing brackets). Because trusted text changed: `FRAMING_VERSION` is `framing/v2`, `PROMPT_VERSION` is `v2`
  (every prompt id/version/schema version/template hash changed), template and rendering goldens were regenerated, and the old table is kept untouched as `golden/history/v1-template-hashes.json`
  (a test proves every stage has a new identity and unchanged output-schema hash). `markers.test.ts` instantiates the described template with each emitted record's handle and code and requires
  the exact emitted lines, for all nine stages.
- **F3 — carriage returns and quotes.** Policy, chosen and documented: captured text is never altered; no offset is ever computed on a normalized copy; a quote can never contain a carriage return or
  another forbidden control (the P1 `Quote` schema is unchanged); therefore a **multi-line quote cannot be located across CRLF or lone-CR line endings** and is rejected as
  `quote_crosses_line_ending` (a diagnostic that never produces a position), while single-line quotes in CRLF/CR text are located with exact original code-point offsets. The extraction prompts now say so.
  Passages are exact slices of the original; characters that may not appear in passage text separate passages (they are excluded, offsets stay those of the original). The limitation is honest and
  visible: long multi-line quotes over CRLF files will be rejected and counted (`item_rejected`), not silently repaired.

## What exists in `packages/assessment` (Layer 2, pure)

Routing `source-routing/v1`, selection/windowing (`source-selection/v1`, `windowing/v1`), exact quote location, gates G1 (claims), G2 (interpreted evidence), G2b (fidelity), G3/G3b (relations),
G4 (contradictions), G5 (unknowns), G6 (dimension judgments), G7 (critic), deterministic pre- and post-gates, the critic decision table, the aggregate technical-failure rule, the label policy
(`label-policy/b-no-promotion/v1`), citable team statements, code-authored `missing` unknowns, Event-Context reference evidence, graph assembly + dry-run planning + closure, extraction membership
and the scoped graph, candidate sets, limitations, the exact `AssessorJudgmentsInput` builder and `verifyStoredAssessment`. Module table: `packages/assessment/README.md`. The only change to
`scoring` is the approved additive `reportOutputHash` / `verifyScoreReportHash` export (`report-hash.ts`); `engine.ts` is not edited.

## Decisions worth reviewing

1. **Source routing was verified against the real M2 adapters (risk U8): no mismatch.** The adapters emit exactly: Devpost `submission.json` + `submission.txt`; GitHub `files/<path>`, `repository.json`,
   `commits.json`, `tree.json`, `omissions.json`; deployment `response.json`, `page.json`, `page.txt`; video `metadata.json`. Statements: `submission.txt`, README/docs (`team_prose`), `page.txt`,
   video `metadata.json`. Interpretation: source files, configuration/manifests (class `repository_metadata`, because M4's channel for them is `repository`), `repository.json`, `response.json`, `page.json`.
   Skipped with a recorded reason: `submission.json` (structured twin), `commits.json` (commit messages are team prose and commit volume must never be a signal), `tree.json`, `omissions.json`
   (code-authored gaps). An integration test scans the adapter sources and fails if an adapter emits a key the table does not decide.
2. **Candidate handles are per unit** (`E-001`… in the unit's candidate order), not the extraction's numbering, so a prompt does not depend on extraction history; code keeps the handle → persisted-id map.
3. **A claim always has a statement item** (assembly refuses otherwise); the statement item's text is the verbatim quote even for a reviewed paraphrase.
4. **Relations carry a basis** (`source_statement`, `independent_observation`, `team_restatement`) for P4 to persist; agreement between two team statements is never "independent".
5. **Event-Context reference items are never project evidence**: they are shown after project evidence (at most eight), a unit with no project-derived candidate is `no_candidate_evidence`, and citing them
   alone converts a score to `insufficient_evidence` (`event_reference_only`).
6. **Injection-flagged evidence is removed from re-run candidates but keeps its handle** (`withoutCandidates`), so the codes-and-handles feedback still refers to what the assessor saw.
7. **`mostly_unassessable`** is computed literally from the approved text (more than half the units insufficient for SUBSTANTIVE reasons); `insufficientTotal` is also returned for display.
8. **Neutral-language screen** applies to model commentary only (contradictions, unknowns, critic notes), never to the team's own quoted words; it is a heuristic backstop with documented false positives
   (for example "fraud detection") and documented evasions.

## Verification (local; Node 22, pnpm 10.28.0; PostgreSQL not run, P3 touches no database code)

- `pnpm check`: exit 0. 123 test files passed + 1 skipped; **2,096 tests passed / 16 skipped** (P2 head: 1,768).
- New or changed counts: `packages/assessment` 272 tests (18 files); `packages/prompts` 151 (was 131); `packages/scoring` 417 (20 new in `report-hash.test.ts`); `tests/integration` 109, of which 70 are
  the P2/P3 contract files (`prompts-llm-compat` 58, `assessment-compat` 6, `assessment-source-routing` 6).
- `pnpm db:generate`: "No schema changes, nothing to migrate". No M5 migration exists.
- M3/M4 compatibility: every dry-run plan goes through the real `planEvidenceGraphBatch`; every scored path goes through the real `createTrustedScoringContext` and `scoreProject`; the 14 complete M4
  golden reports (of 16 golden files) and every golden scenario verify with `verifyScoreReportHash`, with negative controls; all pre-existing M4 tests and goldens pass unchanged
  (`SCORING_ENGINE_VERSION` and `parametersHash` equal in every golden report). The scoring diff is: `index.ts` (+1 export), `boundary.test.ts` (+3 lines, the closed export list), and the new
  `report-hash.ts` / `report-hash.test.ts`.
- Mutation proofs: 64 mutations, each applied, shown to fail at least one named test, then restored; **all 64 killed, none survived**. 61 target P3 (exactly-once quote rule, normalized-copy matching,
  offset base and unit, forbidden characters, cluster splitting, CRLF diagnostic, barrier characters, CRLF cut, passage trimming, commit-history routing; G1/G2 route checks; the fidelity gate for
  claims and evidence, duplicate verdicts, review skipped; statement text from a paraphrase; G3 own-statement and basis; G3b keep-any-verdict and drop-to-contradiction; neutral-language screens at G4/G5/G7;
  G4 own statement; label policy; G6 handle membership, scale, missing citations, event-reference classification, duplicates; the event-reference-only, zero-coverage and Track post/pre-gates; M4 input
  leakage and critic-rejected scoring; critic feedback prose, re-run cap, unavailable critic, second re-run, ignored injection; run-policy rule 2, valid-as-technical, `>` vs `>=`, the floor of two,
  substantive-as-technical; closure over relation endpoints, contradiction sides, unknown claim/evidence references and supersession, membership filter, members hash; M4 outputHash over the full report,
  canonical fixed point, the scoring verifier including and not stripping `outputHash`) and 3 target the P2 corrections (version id unchecked, four-bracket marker text, wording change without a version
  bump). One mutation (interpreted facts labelled `team_claim`) is killed at suite load by M3's own origin/kind/level matrix in the real planner rather than by a named assertion.

## Risks and assumptions before P4

1. **Project record caps.** One extraction can add up to ≈180 evidence items and ≈80 claims; the per-project caps (evidence 5,000; claims 2,000) bound the number of extractions a project can keep
   (≈25). P4's extraction-reuse key and a clear `PROJECT_LIMIT_EXCEEDED` path matter.
2. **Dry-run ids are deterministic stand-ins.** `dryRunPlan` uses a deterministic allocator; P4 must re-plan inside the write transaction with the real allocator and take `membersOf` from the AUTHORITATIVE
   plan. Reports from different allocations differ in ids and `graphFingerprint` by design (design §12.1).
3. **Two member sets.** Project-derived records and the Event-Context reference set are planned separately; the scoped reader takes the concatenation of both member lists (`scopeGraph` accepts any explicit list).
4. **The scoped reader's integrity classification mirrors M4's label-only list** (three codes). A cross-check test asserts both accept a label-only finding and both reject a dangling relation; a change to
   M4's list would need the same change here.
5. **Multi-line quotes over CRLF are rejected** (F3); a CRLF-heavy repository will lose multi-line quotes. Normalizing line endings at capture would be an M2 change and is not proposed.
6. **Video `metadata.json` mixes title/description with HTTP and URL fields**; a quoted URL or status from it becomes a `team_claim`-labelled statement. Conservative (never stronger) but imprecise.
7. **Lockfiles and generated files** that were not excluded at capture can use source budget; selection never ranks by size, so they are not deprioritized.
8. **Cluster-splitting rejection** (`quote_splits_character`) is applied only at the edges of a quote inside one passage; a combining mark that starts the next passage after a hard cut is not detected.
9. **The prompt wording has never met a real model** (carried from P2); fallback anchors remain disabled.
10. **Channel derivation is mirrored, not shared**: `channelOfEvidence` repeats M4's private `channelOf`; a cross-check test compares them through the engine's own need-group coverage.
