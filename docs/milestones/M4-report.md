# Milestone 4 — Deterministic Scoring Engine: Report

**Baseline:** `main` at `69a904b73977b6842baef3c397d5835e527598bc` (Merge pull request #4, M3).
**Branch:** `claude/m4-scoring-engine`. **Approved design:** commit `fb82fe2`
([M4-design.md](./M4-design.md)).

M4 implements this segment of the pipeline and nothing else:

```
evidence graph (one consistent snapshot) + locked Event Context + dimension judgments
→ deterministic scoring-engine/v1 → canonical, hashed ScoreReport
```

There is **no** model call, prompt, provider code, assessment persistence, assessment API or UI,
question generation, interview mode, human final score, migration, table or route. `packages/scoring`
is a pure library that nothing in the repository calls yet. No score is computed or shown for any real
project. M5 is not started.

## Scope delivered

### Prerequisite A — consistent graph reads (approved, kept)

`EvidenceGraphStore.loadGraph` reads the project, the five graph tables and every provenance lookup in
**one read-only `REPEATABLE READ` transaction**; a batch committed mid-read is never half visible (no
false `DANGLING_REFERENCE`, no silently missing contradiction). `createGraph` is unchanged and stays
`READ COMMITTED`: its `FOR NO KEY UPDATE` project lock depends on it. Real-PostgreSQL regressions:
deterministic interleavings with a committing writer for each graph table, a 6-writer × 8-reader stress
test, failure cleanup, a connection-leak check on a 2-connection pool, and a guard that `createGraph`
runs at `read committed`. Mutation proofs: dropping the transaction fails 11 tests; moving `createGraph`
to `REPEATABLE READ` fails the isolation guard and the cap race (12 of 12 racers win). The M3 cap-race,
duplicate-race and lock-behaviour tests are unchanged and pass.

### Prerequisite B — verification trust boundary (Option A, approved)

Characterized, with tests, what direct SQL can store (F1–F5 in the design): any claim label without
evidence; a self-consistent privileged chain that **passes** `validateGraphIntegrity`; README-anchored
`repo_corroborated`; and a legitimate `repo_corroborated → contradicted → team_claim` chain whose head
shows no contradiction. **No migration and no change to M3 history.** The scoring consumer fails
closed instead (below). Options B (CHECK migration) and C (trusted-producer records) remain unapplied.

### `packages/schemas/src/scoring.ts`

Vocabularies as `*_VALUES` tuples plus Zod enums (directness, specificity, evidence channel, rubric
source, weight basis, states, insufficient reasons, confidence basis, issue and diagnostic codes); the
strict untrusted input `AssessorJudgmentsInput`; caller `ScoringOptions`; and the report as
discriminated unions in which an insufficient dimension, criterion or overall has **no score field of
any kind**, and the unofficial preview and the fixed notices are schema literals.

### `packages/scoring` (new Layer-2 package; depends on `context`, `evidence`, `schemas` only)

| Module                                     | Contents                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `parameters.ts`, `parameters-hash.ts`      | every constant in one deep-frozen object; `parametersHash` over constants **and** the fallback definition |
| `rubric/{spec,fallback,select,weights}.ts` | `fallback-rubric/v1` (36 dimensions), official/fallback selection, published-weight validation            |
| `trust.ts`                                 | fail-closed effective level and evidence channel from structure                                           |
| `groups.ts`                                | deterministic provenance grouping (connected components, minimum within a group)                          |
| `lineage.ts`                               | contradiction mapping through supersession chains; claim lineage                                          |
| `strength.ts`, `dimension.ts`              | strength, coverage / citation presence, confidence, contradiction factor                                  |
| `aggregate.ts`                             | dimension → criterion → overall, thresholds, `not_applicable`, unofficial preview                         |
| `context.ts`                               | the branded, frozen `TrustedScoringContext` and its validating factory; graph fingerprint                 |
| `engine.ts`, `canonical.ts`, `freeze.ts`   | `scoreProject`, canonical JSON, hashing, the single rounding rule                                         |

Public exports are a closed list of eight names (asserted by a test): `createTrustedScoringContext`,
`isTrustedScoringContext`, `scoreProject`, `selectRubric`, `validatePublishedWeights`,
`SCORING_PARAMETERS`, `parametersHash`, `FALLBACK_RUBRIC_DEFINITION`.

### Documentation

`SCORING.md` no longer implies an existing human-reviewed official dimension mapping (§4 rewritten,
adaptation note, §12 policies, §13 formulas and constants); `ARCHITECTURE.md` (§13, invariant rows,
package table), `V1_CONTRACT.md`, `SECURITY.md` (§15) and the package README are updated.

## Scoring formulas and every constant

All constants are **transparent V1 heuristics, not calibrated statistical probabilities**. Changing any
is a new engine version. They live in one frozen object and are hashed into every report.

| Constant                                    | Value                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `V` effective level                         | `unverified` 0.15 · `team_claim` 0.35 · `repo_corroborated` 0.60            |
| `L` directness (`direct/adjacent/indirect`) | 1.0 · 0.6 · 0.3                                                             |
| `L` specificity (`exact/partial/generic`)   | 1.0 · 0.6 · 0.3                                                             |
| contradiction factor `F(k)`                 | k = 0, 1, 2, ≥ 3 → 1, 0.7, 0.49, 0.343 (explicit table, cap 3)              |
| minimum assessed share                      | criterion 0.5 · overall 0.6; comparison tolerance `1e-9`                    |
| rounding                                    | 4 decimals, half-up, once, at output; rounded values never feed back        |
| fallback scale                              | 0 to 10                                                                     |
| privileged levels                           | **no entry at all** (`machine_verified`, `judge_verified`, `live_verified`) |

```
strength(e)       = V(effectiveLevel) × L(directness) × L(specificity)         (fact | claim; else 0)
groupStrength     = MIN strength of the records of one provenance group
evidenceStrength  = MAX groupStrength over the distinct cited, usable evidence  (0 if none)
coverage          = satisfied need-groups / need-groups                         (fallback; declared needs)
citationPresence  = 1 if ≥ 1 usable item is cited, else 0                       (official; a flag, not breadth)
confidence        = (coverage | citationPresence) × evidenceStrength × F(k)
criterion         = Σ w·s / Σ w over assessed dimensions           (≥ 0.5 assessed, else insufficient;
                    published weights as they are, without division, when all are assessed)
overall           = Σ W·c / Σ W over scored criteria               (≥ 0.6, else insufficient;
                    as published only when every criterion of the rubric is scored)
coverage, citationPresence, confidence of criteria and overall = weighted means over ALL applicable children
```

**Provenance group.** Records of one scope (event-context version; or snapshot + artifact, where a
snapshot-level reference is its own scope) whose spans overlap (no span covers the whole artifact),
as connected components. Components do not depend on input order; ten copies of one passage are one
source, and inconsistent classifications of the same passage resolve to the lowest strength.

**Effective level** is re-derived from structure and capped at the label: `repo_corroborated` only for a
GitHub `fact` anchored to repository source code (`classifyRepositoryArtifact`) in a captured or
partial snapshot of the same project; `machine_verified` / `judge_verified` / `live_verified` →
`unverified` (diagnostic `UNATTESTED_PRIVILEGED_LEVEL`); anything unsupported → `unverified`. A claim's
label is never read.

## Official and fallback behavior

| Situation                                             | Behavior                                                                                                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locked context has an official `overall` rubric       | Used whole. Its published weights and scale are retained exactly. Each criterion is **one atomic unit** (`official.<key>`).                                                        |
| Official rubric invalid (weights, scale, keys, empty) | `RUBRIC_INVALID`; never repaired, renormalized or replaced, and never a reason to fall back.                                                                                       |
| No official `overall` rubric                          | `fallback-rubric/v1`: 7 criteria, 36 dimensions, provisional evidence-need groups. Never mixed with an official rubric.                                                            |
| Unweighted official rubric                            | Per-criterion scores; `overall = not_computed`. Equal-weight preview only on `{ unweightedPreview: 'equal_weight' }`, reported outside `overall`, `official: false`, fixed notice. |
| Official scale ≠ 0–10                                 | Judged and validated on the rubric's scale; normalized `10·(x−min)/(max−min)` (**assumes the scale is linear**); both values reported.                                             |
| Track target                                          | Scored against its own official track rubric, only if declared; never blended; no fallback for a track.                                                                            |
| No declared tracks                                    | Fallback Track criterion → `not_applicable`; **no official criterion is ever removed this way**.                                                                                   |
| Official criteria                                     | No evidence needs are invented: `coverage: null`, a labeled `citation_presence` flag, confidence **not comparable** with fallback confidence.                                      |

## Insufficient evidence

A dimension is `assessed` only with a judged score **and** at least one usable citation (kind `fact` or
`claim`); otherwise `insufficient_evidence` (`assessor_reported_insufficient` or `no_usable_citation`).
The judged value of an unusable score appears only as text inside a `JUDGED_VALUE_NOT_USED` diagnostic,
never in a numeric field. Excluding a unit is renormalization over what was judged; it moves an
aggregate in either direction and is never a deduction or a zero. Below 0.5 (criterion) or 0.6
(overall) of the weight assessed there is no number.

## Approved design clarifications implemented

- **Trusted track context.** `declaredTrackKeys` is part of the in-process `TrustedScoringContext`,
  not of the model-facing payload. M5 supplies the database adapter; M4 adds no persistence or API.
- **Weight validation property.** The tested invariant is the **total** (finite weights in (0, 1],
  all-or-none, `|Σ − 1| ≤ 1e-6`), not each weight: compensating changes are valid and accepted with their
  published values retained (seeded: 500 valid vectors, 500 compensating perturbations, 500 single-weight
  breaks, 200 out-of-range or non-finite, 200 partially weighted, and 400 vectors checked for parity with Event
  Context locking).
- **Provenance deduplication.** Duplicate citation of one evidence ID rejects (`CITATION_DUPLICATE`).
  Different records of one passage form one group (rule above); the result is order-independent.
- **Model trust boundary.** No input provides attestations, overrides verification, supplies privileged
  weights or alters the rubric (strict schema, branded context, closed export list, source scan).
- **Output safety.** No score field on any insufficient state (schema-enforced); official/unofficial
  results are distinguishable (`rubric.official`, `overall.weightBasis`, the preview literals);
  unmapped recorded contradictions are listed; no completeness claim (`contradictionCoverage:
recorded_only`); hashes cover the engine version, every parameter, the fallback definition, the
  rubric, options, judgments, declared tracks and the graph facts that can influence the result.

## Deviations from the approved design (for review)

1. **Input split** (guard A): the design's `ScoringRequest` became `AssessorJudgmentsInput`
   (untrusted, strict, carries `engineVersion`), `ScoringOptions` (caller) and `TrustedScoringContext`.
2. **`CITATION_CROSS_PROJECT` was dropped.** The engine sees one project's graph, so an invented ID and
   another project's ID are indistinguishable there; both are `CITATION_UNKNOWN_EVIDENCE` and reject.
   A graph that contains records of another project/event fails earlier (`GRAPH_MIXED_PROJECTS`).
3. **Added fail-closed codes:** `UNTRUSTED_CONTEXT`, `LOCKED_CONTEXT_MISMATCH` (the locked snapshot's
   content hash is re-verified, and its event must match), `TARGET_TRACK_NOT_DECLARED`,
   `JUDGMENT_FOR_NOT_APPLICABLE_DIMENSION`, `GRAPH_INTEGRITY_FAILED`.
4. **Published weights "as they are"** applies only when _every_ criterion of the rubric is scored. A
   first implementation divided by nothing when a `not_applicable` criterion had been excluded and
   returned 7.2 instead of 8; a test caught it and it is fixed (mutation-checked).
5. **`shareEpsilon` (1e-9)** is a documented parameter: scoring completion + impact + innovation + track
   is exactly 0.60 of the fallback weight but IEEE arithmetic gives `0.5999999999999999` (a regression test).
6. **Provenance scope is specified more precisely than the design text:** a snapshot-level reference is
   its own scope, so a whole-snapshot statement never merges with (and never weakens) a code span.
7. **Structural integrity findings that no valid database row can produce stay fatal**
   (`INVALID_VERIFICATION`, `MISSING_ANCHOR`, `ORIGIN_NOT_SUPPORTED`, …); only
   `UNJUSTIFIED_VERIFICATION`, `ARTIFACT_NOT_CORROBORATING` and `INVALID_VERIFICATION_TRANSITION` (label
   findings that effective trust already neutralizes) become diagnostics. **Consequence for M7:**
   `validateGraphIntegrity` still rejects `team_answer`/`judge_observation` origins, so M7 must update it
   before interview evidence can be scored.
8. **Graph-level label diagnostics are aggregated** per code with the first 200 IDs listed, and an
   internal engine defect (a report violating its own schema) throws rather than returning a partial
   report.
9. `LINEAGE_CONTRADICTION_IN_HISTORY`, `DUPLICATE_PROVENANCE_GROUPED`,
   `INCONSISTENT_CLASSIFICATION_RESOLVED` and `GRAPH_LABEL_NOT_JUSTIFIED` were added to the diagnostic
   vocabulary; dimensions of a `not_applicable` criterion are omitted from `dimensions[]`.

## Tests

| Run                                                              | Result                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                 | "Lockfile is up to date" (the lockfile gained the `scoring` importer)                              |
| `pnpm check` (format, lint, typecheck, db:check, test, build)    | exit 0                                                                                             |
| `pnpm db:generate`                                               | "No schema changes, nothing to migrate"; no migration added or edited                              |
| `pnpm test` (PGlite)                                             | 77 files (76 passed, 1 skipped), 1,239 tests: **1,223 passed, 16 skipped** (M3: 62 files, 871 / 8) |
| `TEST_DATABASE_URL=… pnpm test` (PostgreSQL 16.15, `en_US.utf8`) | 77 files, 1,498 tests: **1,497 passed, 1 skipped** (M3: 62 files, 1,125 / 1)                       |
| Secrets scan; `git diff --check`                                 | no matches; clean                                                                                  |
| External network in tests                                        | none (the preloaded network guard is unchanged)                                                    |

New tests by file: `packages/scoring/src/` — `strength` 36, `rubric/weights` 18, `rubric/rubric` 36,
`groups` 14, `trust` 17, `aggregate` 17, `engine.validation` 31, `engine.scenarios` 51, `engine.hashes`
20, `golden` 28, `metamorphic` 14, `boundary` 23 (**305 in the package**); `schemas/scoring` 31;
database: `evidence-graph-snapshot-reads` 15 (8 PostgreSQL-only) and `evidence-graph-direct-sql-trust`
5; integration: 18 in `milestone-scope` and 5 in `dependency-rules` (new M4 guards included).

### Golden results

Fourteen full canonical reports are stored in `packages/scoring/golden/` and compared byte for byte
(official weighted on a 1–5 scale, official unweighted, unweighted with preview, fallback with gaps and
no tracks, fallback with a declared track, missing evidence, weak-but-well-supported,
high-quality-low-confidence, contradictions with lineage and an unmapped one, direct-SQL privileged
labels, ten statements from one source, the official presence proxy, a scored judgment with no usable
citation, nothing assessed), plus two rejection goldens (eight invalid-weight configurations and seven
invalid or invented identifier cases). Headline numbers are asserted **inline** in the test so a
regenerated file cannot silently change them:

| Example (design §6)                                                 | Reported                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| E1 core user flow: strengths 0.60 / 0.15 / 0.126                    | strength 0.60, coverage 2/2, confidence **0.6000**                  |
| E2 contradictions k = 1 / 2 / 3 / 4                                 | **0.4200 / 0.2940 / 0.2058 / 0.2058**, score unchanged              |
| E3 ten statements: one Devpost snapshot / ten snapshots             | **0.35** / **0.35** (noisy-OR would have said 0.9865)               |
| E4 score 9.0 from one sentence, coverage 1/2                        | confidence **0.0630**                                               |
| E5 score 3.0, same evidence as E1                                   | confidence **0.6000**                                               |
| E6 wrong evidence kind                                              | coverage 0 → confidence **0**, score still reported                 |
| E7 a second source-code item                                        | confidence **0.6000** (unchanged)                                   |
| E8 official criterion, one item                                     | **0.3500** / **0.6000** / **0.1260**, `coverage: null`              |
| E9 label `machine_verified` / README `repo_corroborated`            | **0.15** with neutral diagnostics (honest source code: 0.60)        |
| E10 removing a scored dimension (weights 0.5/0.3/0.2, scores 9/7/3) | **7.2 → 5.4 / 7.2857 / 8.25** (zero-filling would give 6.6)         |
| E11 Technical Execution with one gap                                | **7.0** (zero-filling: 5.6); confidence 0.4275 on controlled inputs |
| E12 fallback overall with a gap and `not_applicable` Track          | **6.9063**, share 0.8889, `scored_partial`                          |
| E13 scale 1–5, weights 0.6/0.4, judgments 4 and 2                   | **5.5** (3.2 on the official scale, assuming linearity)             |
| E14 unweighted: default / preview / 2 of 4 assessed                 | `not_computed` / **7.0** (share 0.6667, unofficial) / insufficient  |

### Mutation proofs (each restored)

Seventeen deliberate breakages are each caught by at least three tests: noisy-OR instead of max (23
failures), group strength = max (4), privileged label trusted (10), missing evidence zero-filled (12),
epsilon removed (15), contradiction chain not followed (3), published weights used with a
`not_applicable` criterion (3), a score kept without a usable citation (10), a claim label boosting
strength (3), invented coverage for official criteria (8), a contradiction deducting from the score (8),
snapshot-level merged with artifact-level provenance (4), overall confidence renormalized (7), an
unweighted rubric silently equal-weighted (9), a preview claiming to be official (7); and, for
prerequisite A, removing the read transaction (11) and moving `createGraph` to `REPEATABLE READ` (3).

### Metamorphic properties (seeded, no `Math.random`)

Classification changes never change a score; missing evidence is never imputed (every criterion and the
overall equal an independent renormalized reference); removing a scored dimension changes an aggregate
in **both** directions (asserted, not monotonicity); independent, noncontradictory support never lowers
confidence, strength or coverage; contradictory evidence may lower confidence and never a score;
duplicated provenance never inflates strength or confidence; claim labels and privileged relabeling
never matter; input order never matters; no rounding drift; project isolation. Plus cross-process
determinism: two fresh `tsx` processes print the same `outputHash` for all 14 scenarios.

## Architecture drift check

| Invariant          | Holds in M4 because                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1, 16              | an official overall rubric is used whole; no mixing; invalid weights rejected, never repaired                                        |
| 2, 20              | every citation must be an evidence ID of this project; invented or foreign IDs reject the request                                    |
| 3, 14              | insufficient evidence is a state with no score field; nothing is zero-filled or deducted                                             |
| 4                  | team statements stay `team_claim` (0.35) and a claim's label is never read                                                           |
| 5, 6               | no function accepts commit counts, keywords, stars, LOC, dependency counts or AI-tool use                                            |
| 7, 21              | nothing is executed; the package has no I/O                                                                                          |
| 8, 23              | project text is never read by the engine                                                                                             |
| 9, 13, 24          | byte-identical reports; confidence is an index independent of the score; more evidence can raise confidence without changing a score |
| 15                 | no final-score code exists                                                                                                           |
| 19                 | the assessor payload is schema-validated, then domain-validated; the report must satisfy its own schema                              |
| 22                 | nothing is scored on any validation issue; there is no model                                                                         |
| 25                 | contradictions and label diagnostics are neutral data; contradictions lower confidence, never a score                                |
| 10, 11, 12, 17, 18 | unchanged: no assessment version, interview or reassessment code exists (M5+)                                                        |

Dependency rules hold: `scoring` is Layer 2, depends on `context`, `evidence`, `schemas`, and cannot
reach `llm`, `prompts`, `database` or any adapter, even transitively (tested). The pipeline was not
collapsed: M4 adds the deterministic scoring stage only.

## Known limitations

- **Structure, not semantics.** A cited item may be semantically unrelated to its dimension.
- **Only recorded contradictions** are counted; "no contradictions" never means none exist.
- **Heuristics are uncalibrated.** Confidence is an ordered index, not a probability. Pure max strength
  cannot reward a second independent source inside one dimension; breadth shows only through coverage
  channels (fallback) and not at all for official criteria.
- **Official-criteria confidence** (presence basis) is not comparable with fallback confidence.
- **Linear-scale assumption** for non-0–10 official scales.
- **Fallback need-groups are provisional heuristics.** `qa_understanding` (max coverage 0) and
  `technical_ownership` (max 1/2) cannot be satisfied before M7; a deployment observation is one HTTP
  response and a video item is oEmbed metadata; event-context evidence is version-level.
- **A privileged label on a row that would otherwise qualify as `repo_corroborated` scores 0.15, not 0.60**
  (the label shows the row did not come through the validated path).
- `seq` is allocated at insert, not commit; a consistent snapshot can contain gaps. Ordering inside one
  snapshot is still total and deterministic.

## Deferred and M5 prerequisites

1. **Semantic relevance of citations** is not verified. Before an LLM assessor is connected (M5):
   require meaningful provenance spans, establish the model-output trust boundary (what a model may
   assert, how its text is tied to the cited span, who may assign verification levels), and validate that
   a cited item is relevant to its dimension per the graph and its text.
2. **The database adapter** that builds `TrustedScoringContext` from stored project track selections, the
   locked Event Context and `loadGraph`. The locked snapshot and the graph should be read consistently
   together (pin the version, or read both in one snapshot).
3. **Persisting an assessment version** (engine version, `parametersHash`, rubric fingerprint, input and
   graph fingerprints, `outputHash`, cited evidence and snapshot IDs). The report carries all of them.
4. **Trusted attestations** (judge observations, deterministic machine observation) and the update of
   `validateGraphIntegrity` for `team_answer`/`judge_observation` origins: M7, under its own approval.
5. Optional database defense in depth (**Option B**, CHECK constraints) was **not** applied; the F1–F5
   characterization tests flip deliberately if it is. It fixes neither F3 nor F5.
6. **Unmapped contradictions and unknowns** are surfaced for M6's question engine.
7. **Calibration** of the heuristic constants against judge outcomes, if wanted.
8. A human-reviewed sub-dimension mapping for official criteria, a "fallback permitted" Event Context
   field, and any API or UI for scores are separate, separately approved changes.
9. The M2 and M3 P2 backlogs are untouched.

## Decisions that still need review

- The three deviations with a consequence beyond M4: dropping `CITATION_CROSS_PROJECT` (2), keeping the
  M3 integrity validator strict about M7 origins (7), and the privileged-label rule above.
- Whether the report should expose per-criterion `coverage` for official rubrics as `null` (as now) or
  omit the field.

## M5 NOT STARTED

No assessment, model, prompt, provider, extraction, question, interview or final-score code exists. The
milestone-scope guard (now advanced to M4) fails if any appears before its milestone.
