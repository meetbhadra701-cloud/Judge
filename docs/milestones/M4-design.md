# Milestone 4 — Deterministic Scoring Engine: Design (revision 2, for approval)

**Status:** DESIGN. No scoring formula, rubric table or scoring code is implemented. Revision 2
incorporates the owner's review of revision 1: **prerequisite A approved and kept**, and decisions
D1–D11 approved with the revisions recorded in §0. The remaining tradeoffs that still need a yes/no
are in §11.

**Baseline:** `main` at `69a904b73977b6842baef3c397d5835e527598bc` (M3 merged via PR #4).
**Branch:** `claude/m4-scoring-engine`. Nothing is merged.

Implemented on this branch: **prerequisite A** (§1), a **characterization audit** of prerequisite B
(§2) and clarifying policy text in `docs/SCORING.md` (§12 and two notes). No AI calls, no assessment
persistence, no M5/M6 work, no migration; `createGraph` stays `READ COMMITTED`.

## 0. Decision log (owner review of revision 1)

| #   | Decision                                              | Revision 2 outcome                                                                                                             |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Unweighted official rubric                            | **No official overall, ever.** Per-criterion scores only; an unofficial equal-weight _preview_ only on explicit request (§4.1) |
| D2  | Trust boundary                                        | **Option A.** Attestations are internal and empty; not a caller/model input; unattested privileged labels add no trust (§2.2)  |
| D3  | Official criteria ↔ dimensions                        | Each official criterion is one atomic unit; no pretended mapping; clarified in `SCORING.md` §4/§12                             |
| D4  | Rubric precedence                                     | Conservative; no automatic official/fallback mixing (§4.2)                                                                     |
| D5  | Evidence needs of official criteria                   | **Rejected as invented.** Citation-presence proxy, labeled, never called coverage (§5.2)                                       |
| D6  | 36 fallback dimensions                                | Retained as provisional, versioned heuristics, with stated limitations (§7)                                                    |
| D7  | Directness / specificity vocabularies and multipliers | Approved as V1 heuristics, not calibrated probabilities (§5.6)                                                                 |
| D8  | Item-level noisy-OR support                           | **Replaced by the maximum effective strength** of distinct cited evidence (§5.1)                                               |
| D9  | Official-scale normalization                          | Approved; linearity is an explicit, documented assumption (§4.5)                                                               |
| D10 | Scored judgment without a usable citation             | `insufficient_evidence`; the judged value is a diagnostic only, never a score (§5.4, §8)                                       |
| D11 | `not_applicable` Track criterion                      | Fallback rubric only; never removes a criterion from an official rubric (§4.4)                                                 |

Additional guards adopted: unmapped contradictions stay visible and completeness is never claimed
(§8); a claim label never proves semantic truth (§2.3); invalid or cross-project citations fail
closed (§8); the metamorphic properties are corrected (§9).

---

## 1. Prerequisite A — consistent graph reads (IMPLEMENTED)

**Problem (confirmed).** `EvidenceGraphStore.loadGraph` ran one statement per table, each at
`READ COMMITTED` and therefore each with its own snapshot. A batch committed between two statements
was half visible: relations without their claims (false `DANGLING_REFERENCE`), evidence without its
snapshot row, or a committed contradiction silently missing. The last kind raises no error at all.

**Fix.** `loadGraph` is now ONE `db.transaction(..., { isolationLevel: 'repeatable read',
accessMode: 'read only' })` (`GRAPH_READ_TRANSACTION`). The project lookup, the five graph tables and
every dependent provenance lookup (snapshots, artifacts, context versions) run on the transaction
handle, sequentially, in the previous order (`seq`). The transaction is released by `db.transaction`
on success and on failure. `verifyIntegrity` and the API service inherit it (`loadGraph` is the only
graph reader; `apps/api` has no other read path). Public signatures are unchanged.

**Not changed, deliberately.** `createGraph` stays `READ COMMITTED`. Its `FOR NO KEY UPDATE` project
lock relies on seeing the previous writer's committed rows _after_ waiting for the lock; a
`REPEATABLE READ` snapshot would defeat that. A read-only transaction takes no row locks, so it
neither blocks nor is blocked by writers and cannot fail with a serialization error.

**Tests** (`evidence-graph-snapshot-reads.test.ts`, `testing/instrument.ts`; PGlite and PostgreSQL 16
unless noted):

| Test                                                                           | Proves                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| every `loadGraph` statement runs in one read-only REPEATABLE READ transaction  | all 9 statements (project, 5 graph tables, snapshots, artifacts, context versions): same isolation, snapshot, xact  |
| `createGraph` stays READ COMMITTED                                             | the writer's first statement is the project lock, and every writer statement is `read committed`, `read_only = off` |
| a batch committed right before the read of each graph table (5 cases, PG only) | a writer commits from another connection mid-read; the read shows the old batch whole and the new one not at all    |
| `verifyIntegrity` with a writer committing mid-read (PG only)                  | no false `DANGLING_REFERENCE`                                                                                       |
| stress: 6 writers × 8 batches vs 8 readers (PG only)                           | every observed graph has every batch complete (3 claims, 4 evidence, 3 relations, 1 unknown, 1 contradiction)       |
| failure handling                                                               | injected failure mid-read rolls back, nothing stays `idle in transaction`, the handle is immediately usable         |
| connection leak (PG only)                                                      | 40 concurrent reads (20 failing) on a pool of 2 connections; no leak, pool not exhausted                            |
| read transaction cannot write                                                  | an `INSERT` inside the read transaction is rejected                                                                 |
| unknown project / ordering / integrity                                         | `null`, unchanged `seq` order, `verifyIntegrity` empty                                                              |

**Mutation proofs (all restored afterwards).** Removing the transaction (reads become independent
statements again): 11 of 22 new tests fail, including five `DANGLING_REFERENCE` reproductions and the
stress test. Moving `createGraph` to `REPEATABLE READ`: the isolation guard fails on both databases
and the M3 cap race test fails (12 of 12 racers win instead of 1). The existing cap-race,
duplicate-race and lock-behaviour tests are unchanged and pass.

**Residual note for M4/M5.** `seq` is allocated at insert, not at commit. A consistent snapshot can
therefore contain `seq` 5 while a concurrent, not-yet-committed writer holds `seq` 4. Ordering inside
one snapshot is still total and deterministic; scoring must never treat `seq` gaps as meaningful.

**Verification of this branch** (Node 22.22.0, pnpm 10.28.0, PostgreSQL 16.15 with an `en_US.utf8` database):

| Command                                                       | Result                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm check` (format, lint, typecheck, db:check, test, build) | exit 0                                                                                   |
| `pnpm db:generate`                                            | "No schema changes, nothing to migrate" (no migration added or edited)                   |
| `pnpm test` (PGlite)                                          | 64 files (63 passed, 1 skipped), 899 tests: 883 passed, 16 skipped (M3: 871 / 8)         |
| `TEST_DATABASE_URL=… pnpm test` (PostgreSQL 16)               | 64 files, 1,158 tests: 1,157 passed, 1 skipped (M3: 1,125 / 1); 32 new tests, 0 failures |
| baseline of `main` on the same PostgreSQL                     | 62 files, 1,126 tests: 1,125 passed, 1 skipped (identical to the M3 report)              |

---

## 2. Prerequisite B — verification trust boundary (audit done; Option A approved)

### 2.1 What the stored graph can contain when `createGraph` is bypassed

Characterized against PostgreSQL 16 and PGlite in `evidence-graph-direct-sql-trust.test.ts`:

| #   | Finding                                                                                                                                                                                                                                                            | Consequence                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The database accepts a claim at **any** of the 7 levels with **no** evidence (only the vocabulary CHECK exists). `validateGraphIntegrity` reports 5 `UNJUSTIFIED_VERIFICATION`.                                                                                    | A consumer that reads `verification_level` without running the validator sees "verified" claims backed by nothing.                                                                                         |
| F2  | A source-code `machine_verified` fact (real span, unrelated text) + `machine_verified` claim + `supports` relation inserted by SQL passes `validateGraphIntegrity` with **zero issues**.                                                                           | The validator cannot distinguish this from a chain a future trusted producer would write. **It can never be the thing that authorizes a privileged label.**                                                |
| F3  | README-anchored `repo_corroborated` evidence is accepted by the database (the artifact classifier lives in application code). The validator flags the _evidence_ (`ARTIFACT_NOT_CORROBORATING`) but **not** the `repo_corroborated` claim it "justifies".          | Trust must be re-derived from structure, not read from labels.                                                                                                                                             |
| F4  | `judge_observation` and `team_answer` evidence is rejected by a CHECK (SQLSTATE `23514`). A `judge_verified` / `live_verified` _claim row alone_ is accepted (F1).                                                                                                 | Judge/live evidence cannot exist before M7, so any judge/live label in M4 is by definition unattested.                                                                                                     |
| F5  | Through the **legitimate** producer path a chain `repo_corroborated → contradicted → team_claim` is accepted. The head claim then has `team_claim`, **0** contradictions touching it, and a clean integrity audit. The contradiction is attached to the old claim. | A consumer that reads only current claims loses both the contradiction and the earlier level. Conversely, "latest level" never raises trust (a chain can also go `contradicted → repo_corroborated`, F5b). |

### 2.2 Decision: Option A, fail-closed consumer boundary (approved, with D2 tightening)

No migration, no change to M3 history. The scoring consumer never reads a verification label as trust:

- `effectiveLevel(evidence)` re-derives trust from structure and is the **only** source of the `V`
  factor. Possible results are exactly `unverified`, `team_claim` or `repo_corroborated`.
- `machine_verified`, `judge_verified` and `live_verified` labels resolve to **`unverified`** plus a
  neutral diagnostic `UNATTESTED_PRIVILEGED_LEVEL`. They never increase effective trust.
- A `repo_corroborated` label stands only for a GitHub `fact` anchored to an artifact that
  `classifyRepositoryArtifact` classifies as `source_code`, in a captured/partial GitHub snapshot of the
  same project, with the matching origin/kind/level combination; otherwise it resolves to `unverified`
  plus `UNSUPPORTED_REPO_CORROBORATION`.
- **Trusted attestations are internal and empty.** There is no `attestations` field on `ScoringRequest`,
  no parameter on any exported function, and no way for a caller or a model to supply one. The internal
  attestation set is a module-private, frozen, empty constant; a scope test fails if the public API gains
  such an input. The V1 parameter table therefore contains **no** weights for the privileged levels. The
  trusted-attestation architecture (what an attestation is, who writes it, how it is bound to a record)
  is deferred to the milestone that introduces a trusted producer (M7 for judge observations); that
  milestone will add the input and its weights together under its own approval, as a new engine version.
- A diagnostic is neutral data for the judge, never an accusation (invariant 25) and never a quality
  deduction. A row with a privileged label is _also_ distrusted for its other structure (its anchors and
  classification), because a label the validated write path cannot produce shows the row did not come
  through that path.
- Options B (CHECK migration) and C (trusted-producer records) remain unapplied. B stays available as
  optional defense in depth and fixes neither F3 nor F5; C is the M7 design.

### 2.3 Claim labels and lineage

1. **A claim's `verification_level` never proves semantic truth** and is never an input to any strength,
   score or confidence formula. Strength comes only from the cited evidence items (§5.1). Claim levels
   appear only in diagnostics.
2. **A historic maximum never raises trust.** A head that is `team_claim` after `repo_corroborated` is
   treated as `team_claim`; and `contradicted → repo_corroborated` is not read as "resolved".
3. **A contradiction on any member of a supersession chain counts against the head** (F5): there is no
   "resolved" state in M3 and a successor must not launder a contradiction. This is an uncertainty
   (confidence factor), never a score deduction.
4. The report exposes per-claim `lineage` (`headId`, ordered levels, `everContradicted`,
   `contradictionIds`) for M6 and the UI.

---

## 3. Architecture of M4

```
locked Event Context ──► selectRubric (official | fallback) ──► RubricSpec  ┐
loaded graph (one snapshot) ──► trust / lineage view (internal, empty attestations)  ├─► scoreProject ─► ScoreReport
M5-validated DimensionJudgment[] (scores on the unit's scale, citations)     ┘     (pure, no I/O)
```

- **Package:** `packages/scoring`, Layer 2, pure TypeScript. Dependencies: `schemas`, `evidence` (graph
  types, `classifyRepositoryArtifact`), `context` (the existing `rubricWeightSumIssues` /
  `RUBRIC_WEIGHT_SUM_TOLERANCE`: one definition of "valid weights"). **No `llm`, no `prompts`**, no I/O, no
  clock, no randomness, no `Math.pow`/`exp`/`log`: only `+ − × ÷`, comparisons, and max/min, which IEEE 754
  defines exactly.
- **Persists nothing, serves nothing.** No migration, table or route. Persisting an assessment version
  is M5; M4 returns what it needs (`engineVersion`, rubric identity, `inputFingerprint`,
  `graphFingerprint`, `parametersHash`, `outputHash`).
- **Never invents** dimension scores, mappings, weights, evidence, IDs or citations. It validates,
  aggregates and calculates. All numeric parameters are **transparent V1 heuristics, not calibrated
  statistical probabilities** (§5.6); the report carries the parameter set it used.

---

## 4. Rubric and aggregation policies

### 4.1 Unweighted official rubric (D1)

- Per-criterion scores are always produced and are the output.
- `overall = { state: 'not_computed', reason: 'unweighted_official_rubric' }`. It is **never** a number.
- Only when the request sets `unweightedPreview: 'equal_weight'` does the report add a separate
  `unofficialPreview` object (not inside `overall`): equal weights `1/n`, the same minimum-assessed-share
  rule as §4.6, and fixed fields `official: false`, `weightBasis: 'equal_assumed'`, and a fixed notice
  ("UNOFFICIAL PREVIEW — organizers published no weights; equal weights are an assumption of this tool").
  A weighted rubric ignores the field (and the request is rejected if it is set on a weighted rubric,
  so a caller cannot believe a preview was produced).

_Example._ Criteria Innovation 8.0, Execution 6.0, Presentation insufficient. Default: criteria
`8.0 / 6.0 / insufficient`, overall `not_computed`. With the preview requested: assessed share
`2/3 = 0.6667 ≥ 0.6` ⇒ `unofficialPreview.score10 = (8 + 6) / 2 =` **7.0**, `scored_partial`. With 4
equal criteria of which 2 are assessed: share 0.50 < 0.6 ⇒ preview `insufficient_evidence`.

### 4.2 Rubric precedence (D4)

1. The locked context has an official `overall` rubric ⇒ it is the rubric of the overall target, whole.
   A rubric that fails validation is `RUBRIC_INVALID`: **never** repaired, renormalized or replaced, and
   never a reason to fall back (a rubric with zero criteria is invalid, not absent).
2. No official `overall` rubric ⇒ the versioned fallback rubric (`fallback-rubric/v1`), whole.
3. Official and fallback criteria are never combined; an official rubric with a "gap" is not filled (the
   Event Context has no field for organizer permission, so none can be presumed).
4. Track rubrics are separate targets (`{ kind: 'track', trackKey }`), never blended into the overall.
   A track target without an official track rubric is `RUBRIC_NOT_FOUND`; it never falls back.

### 4.3 Official criteria as atomic units (D3)

An official criterion is one assessment unit `official.<criterion_key>` of weight 1. It is judged
against its own published description and anchors. The 36-dimension decomposition applies to the
fallback rubric only. See `SCORING.md` §4 (adaptation note) and §12.

### 4.4 `not_applicable` (D11)

Only criterion `track_prize_alignment` of the **fallback** rubric, and only when the project declared no
tracks (`projectContext.declaredTrackKeys` is empty). It leaves numerator and denominator, carries no
confidence penalty and does not count towards the 0.6 rule. **No criterion of an official rubric is ever
removed or marked `not_applicable`** because no track was declared; it is judged like any other and may
end up insufficient. `declaredTrackKeys` is a typed, validated input supplied by the caller from the
project's recorded track selections; the engine cannot verify it (listed in §11).

### 4.5 Official scales (D9)

Judgments for an official unit are given on the rubric's own scale `[scaleMin, scaleMax]` (the one
published scale of that rubric), validated inside it, and normalized for aggregation:
`score10 = 10 · (x − scaleMin) / (scaleMax − scaleMin)`. **Assumption, stated in the report and in
`SCORING.md`:** the published scale is linear (equal steps equally valuable). If organizers' anchors are
ordinal rather than equal-interval, cross-criterion aggregation is an approximation. The value on the
official scale, `scaleMin + score10/10 · (scaleMax − scaleMin)`, is reported next to `score10`.

### 4.6 Insufficient evidence (B, C, D10)

- **Dimension.** `assessed`, or `insufficient_evidence` (reasons: `assessor_reported_insufficient`,
  `no_usable_citation`). An insufficient dimension has **no numeric score field at all**.
- **Criterion.** Over assessed dimensions only: `Σ w·s / Σ w`, state `partial`, `assessedWeightShare`
  reported, **only if the share is ≥ 0.5**; otherwise `insufficient_evidence`. With every dimension
  assessed, the published weights are used as-is (no division, no silent renormalization).
- **Overall.** Over scored criteria, **only if their share of the applicable weight is ≥ 0.6**; otherwise
  `insufficient_evidence`. The missing criteria are named.
- **Missing evidence is never imputed as zero and never subtracts points.** Excluding a dimension is
  renormalization over what was judged, which can move an aggregate in _either_ direction.

---

## 5. Formulas — `scoring-engine/v1`

All math is unrounded and uses `+ − × ÷`, `max`, `min` in a **canonical order** (ascending ID). That
matters: in IEEE doubles `0.1 + 0.2 + 0.3 = 0.6000000000000001` but `0.3 + 0.2 + 0.1 = 0.6`.

### 5.1 Evidence strength

For one cited evidence item `e` of kind `fact` or `claim` (kinds `absence`, `unknown` and `contradiction`
have strength 0: they create uncertainty, never support — invariant 3):

```
strength(e) = V(effectiveLevel(e)) × L(directness) × L(specificity)
V : unverified 0.15 · team_claim 0.35 · repo_corroborated 0.60
L : direct | exact 1.0 · adjacent | partial 0.6 · indirect | generic 0.3
```

`strength > 0` always (minimum `0.15 × 0.3 × 0.3 = 0.0135`). `directness` and `specificity` are closed
vocabularies the assessor classifies per (dimension, evidence) citation; the model never emits a number.

**Evidence strength of a dimension = the MAXIMUM effective strength of its distinct cited, usable
evidence** (D8):

```
evidenceStrength(d) = max over distinct usable cited items of strength(e)         (0 if none)
```

_Why not noisy-OR._ `1 − Π(1 − s)` treats items as independent. They are not: ten sentences from one
Devpost page are one source, and the graph cannot establish independence (the producer chooses the
evidence text; several items may cite the same span). Ten `team_claim`/direct/exact statements gave
**0.9865** under noisy-OR; under max they give **0.35**. No independence-aware alternative is proposed for
V1, because none can be justified from the graph's data and tested as provably conservative; max can never
exceed the best single item. Consequences, stated plainly: corroboration _breadth_ is expressed only by
coverage (distinct channels), never by counting items; adding a weaker item changes nothing.

**Distinct.** Two cited items count once when they share a provenance key (same snapshot + artifact +
overlapping span, or the same context version); both stay visible in `citations`. Citing the _same
evidence ID_ twice in one judgment is rejected (`CITATION_DUPLICATE`).

### 5.2 Coverage, and the citation-presence proxy for unspecified needs (D5, D6)

**Declared needs (fallback rubric only).** A dimension declares need-groups (§7); each group is a set of
acceptable evidence _channels_. A channel is derived from structure: GitHub + `source_code` artifact →
`source_code`; other GitHub → `repository`; Devpost → `submission`; deployment → `deployment`; video →
`video`; event context → `event_context`; `team_answer`; `judge_observation`.

```
coverage(d) = (# need-groups with ≥ 1 usable cited item in an acceptable channel) / (# need-groups)
```

**Unspecified needs (every official criterion).** The Event Context does not say what evidence a
criterion requires, and the engine will not invent it. There is **no coverage value** for such a unit.
The report carries a different, differently-named quantity:

```
citationPresence(d) = 1 if the unit has ≥ 1 usable cited item, else 0              (a flag, not breadth)
```

It says "something usable was cited", nothing about whether it was enough or broad enough. Reports,
schemas and UI copy must never call it coverage; fields are separate (`needs.kind: 'declared' |
'unspecified'`) and aggregates over official units expose `coverage: null` plus `citationPresenceShare`.

### 5.3 Confidence index (independent of the score)

```
confidence(d) = basis(d) × evidenceStrength(d) × 0.7^min(k, 3)
   basis(d) = coverage(d)            when needs are declared     (confidenceBasis: 'declared_needs_coverage')
   basis(d) = citationPresence(d)    when needs are unspecified  (confidenceBasis: 'citation_presence')
   k        = number of DISTINCT recorded contradictions touching d (§8)
```

Insufficient dimensions have confidence 0. The factors for `k = 0,1,2,≥3` are `1, 0.7, 0.49, 0.343`.
Unknowns are reported as uncertainty reasons, not in the formula. Confidence is an index, not a
probability (invariant 13), and is never an input to any score. Confidences of official-rubric units
(presence basis) are **not comparable** with fallback confidences (coverage basis); the report says so.

### 5.4 Aggregation

```
dimension : assessed iff judgment is `scored` AND ≥ 1 usable citation; else insufficient_evidence
criterion : Σ w·s10 / Σ w  over assessed dimensions (§4.6)
overall   : Σ W·c   / Σ W  over scored criteria (§4.6); `not_computed` for an unweighted official rubric (§4.1)
criterion/overall confidence = weighted sum over ALL applicable children, insufficient children counting 0
```

A `scored` judgment that cites nothing usable (for example only `absence` evidence) becomes
`insufficient_evidence` / `no_usable_citation`. The judged value is kept **only** as a diagnostic
(`diagnostics[].judgedValueNotUsed`), is excluded from every aggregate and every score field, and is
never presented as a score (D10).

### 5.5 Rounding and canonical output

Computation is unrounded. Each reported number is rounded once, half-up, to 4 decimals
(`Math.round(x · 10⁴) / 10⁴`) and **rounded values never feed a later step**. Official weights are
validated to `1e-6`; with 10-point scores the un-normalized sum error is at most `1e-5`, below the
half-unit of the 4th decimal (`5e-5`). Output is canonical JSON (sorted keys, fixed array order) with a
SHA-256 `outputHash`. Display precision (1 decimal for scores, whole percent for ratios) is a
presentation helper, not stored.

### 5.6 Parameters are heuristics (D7)

| Parameter                                               | V1 value                                   | Status                                                    |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| `V` team-authored / unverified / producer-asserted repo | 0.35 / 0.15 / 0.60                         | ordinal heuristic: ordering is the claim, spacing is not  |
| `L` directness, specificity                             | 1.0 / 0.6 / 0.3                            | heuristic ladder; not calibrated against judge outcomes   |
| contradiction factor, cap                               | 0.7 per contradiction, cap 3 (floor 0.343) | heuristic; an uncertainty marker, never a score change    |
| minimum assessed share, criterion / overall             | 0.5 / 0.6                                  | heuristic; "enough of the unit judged to report a number" |
| rounding                                                | 4 decimals, half-up, once at output        | convention                                                |

None is a probability or a statistical estimate. Changing any value is a new engine version; the report
embeds `parametersHash`. Reviewers should read confidence as an ordered index to focus questions, not as
"probability the score is right".

---

## 6. Worked examples (all recomputed under revision 2; each is a golden expectation)

**E1. One dimension, `completion_functionality.core_user_flow`** (needs: `deployment|video|judge_obs` and
`source_code`). Cited: source-code span `repo_corroborated`/direct/exact ⇒ `0.60`; deployment observation
`unverified`/direct/exact ⇒ `0.15`; Devpost sentence `team_claim`/adjacent/partial ⇒ `0.35·0.6·0.6 = 0.126`.
`evidenceStrength = max(0.60, 0.15, 0.126) =` **0.60**; coverage `2/2 = 1`; **confidence 0.6000**.

**E2. Contradictions on E1** (score unchanged in every row): k = 0 ⇒ **0.6000**; k = 1 ⇒ **0.4200**;
k = 2 ⇒ **0.2940**; k = 3 or 4 ⇒ **0.2058**.

**E3. Ten statements are not ten sources.** Ten Devpost `team_claim`/direct/exact items: strength
**0.35** (noisy-OR would have said 0.9865). Ten `team_claim`/adjacent/partial: **0.126** (noisy-OR 0.7399).

**E4. High quality, low confidence.** Score 9.0 judged from one Devpost sentence (0.126) on a dimension
with two need-groups, one satisfied: coverage `1/2`; confidence `0.5 × 0.126 =` **0.0630**. Score stays 9.0.

**E5. Weak but well supported.** Score 3.0 with E1's evidence: score 3.0, confidence **0.6000**.

**E6. Coverage and strength are separate.** `track_prize_alignment.actual_implementation_evidence` needs
`source_code`. Only a Devpost `team_claim`/direct/exact item cited: strength 0.35, coverage `0/1` ⇒
confidence **0.0000** (the score is still reported). Add a `repo_corroborated`/direct/exact source-code
item: strength 0.60, coverage 1 ⇒ confidence **0.6000**. The score did not move.

**E7. More of the same does not help.** Adding a second `repo_corroborated`/direct/exact source-code item
to E1: strength 0.60 ⇒ confidence **0.6000** (unchanged, not lowered, not inflated).

**E8. Official criterion, unspecified needs.** One `team_claim`/direct/exact item: presence 1,
confidence `1 × 0.35 =` **0.3500** (`confidenceBasis: citation_presence`, `coverage: null`); one
`repo_corroborated`/direct/exact item: **0.6000**; one `team_claim`/adjacent/partial item: **0.1260**.

**E9. Privileged labels earn nothing.** Identical direct/exact source-code evidence: honest
`repo_corroborated` ⇒ **0.60**; the same row labeled `machine_verified` by direct SQL ⇒ **0.15** +
`UNATTESTED_PRIVILEGED_LEVEL`; `repo_corroborated` anchored to a README ⇒ **0.15** +
`UNSUPPORTED_REPO_CORROBORATION`.

**E10. Removing a scored dimension moves the aggregate in either direction.** Weights 0.5 / 0.3 / 0.2,
scores 9 / 7 / 3: full **7.2000**. Mark the 9-dimension insufficient ⇒ `(2.1 + 0.6)/0.5 =` **5.4000**
(lower). Mark the 3-dimension insufficient ⇒ `(4.5 + 2.1)/0.8 =` **8.2500** (higher). Mark the 7-dimension
insufficient ⇒ `(4.5 + 0.6)/0.7 =` **7.2857** (higher). Zero-filling the 3-dimension would have said 6.6.

**E11. Technical Execution with a gap** (weights 25/20/20/20/15; scores 7, 8, —, 6, 7): assessed share
0.80 ⇒ `5.60 / 0.80 =` **7.0000**. With dimension confidences 0.60/0.55/0/0.50/0.45 the criterion
confidence is `0.15 + 0.11 + 0 + 0.10 + 0.0675 =` **0.4275**.

**E12. Fallback overall.** Technical 7.0, Completion 6.5, Innovation 8.0, Impact 7.5, Design
insufficient, Demo 5.0, Track `not_applicable` (no tracks declared): applicable weight 0.90, scored weight
0.80, share 0.8889 ≥ 0.6 ⇒ `5.525 / 0.80 =` **6.9063** (`scored_partial`, `weightBasis: fallback`). On an
_official_ rubric nothing is ever `not_applicable`: an unjudged criterion stays in the denominator of
the share.

**E13. Official scale 1–5, weights 0.6 / 0.4.** Judgments 4 and 2 ⇒ `score10` 7.5 and 2.5 ⇒ overall
`4.5 + 1.0 =` **5.5000** (official-scale equivalent **3.2**, assuming linearity).

**E14. Unweighted preview** (§4.1): overall `not_computed`; preview 7.0 (share 0.6667); 2 of 4 assessed ⇒
preview `insufficient_evidence`.

---

## 7. Fallback rubric `fallback-rubric/v1` — provisional heuristics (D6)

36 dimensions with the published weights (SCORING §3–4), as **provisional, versioned heuristics**: the
dimension weights are the project's published fallback; the _evidence-need groups_ below are the
engine's own heuristic reading of what each dimension needs, are not organizer-published, and may change
only with a new engine version.

Channels: **C** `source_code`, **R** `repository` (other GitHub), **S** `submission`, **D** `deployment`,
**V** `video`, **X** `event_context`, **A** `team_answer` (M7), **O** `judge_observation` (M7). `+`
separates need-groups; `·` separates alternatives in a group. Criterion weights: Technical 20,
Completion 20, Innovation 15, Impact 15, Design 10, Demo 10, Track 10.

| Criterion → dimension (weight within criterion)                      | Need-groups         |
| -------------------------------------------------------------------- | ------------------- |
| **technical_execution**                                              |                     |
| implementation_depth (25)                                            | C                   |
| architecture_integration (20)                                        | C + (R·S·A)         |
| technical_ownership (20)                                             | (R·C) + (A·O)       |
| correctness_robustness (20)                                          | C + (D·O·V)         |
| engineering_challenge (15)                                           | (C·R) + (S·V·A)     |
| **completion_functionality**                                         |                     |
| core_user_flow (30)                                                  | (D·V·O) + C         |
| runtime_live_demonstration (25)                                      | (D·V·O)             |
| end_to_end_integration (20)                                          | (D·O·V) + C         |
| stated_vs_implemented_scope (15)                                     | (S·V·A) + (C·D·O)   |
| failure_edge_handling (10)                                           | C + (D·O·V)         |
| **innovation_creativity**                                            |                     |
| novelty_of_approach (30)                                             | (S·V·A) + (C·R)     |
| differentiation (25)                                                 | (S·V·A) + (C·R·D)   |
| original_technical_contribution (25)                                 | C + (R·S)           |
| purposeful_technology_use (20)                                       | (C·R) + (S·A)       |
| **impact_problem_fit**                                               |                     |
| problem_clarity (15)                                                 | (S·V·A)             |
| target_user_specificity (15)                                         | (S·V·A)             |
| importance_frequency (15)                                            | (S·V·A)             |
| solution_problem_fit (30)                                            | (S·V·A) + (C·D·O·V) |
| plausibility_of_benefit (15)                                         | (S·V·A) + (D·O·V)   |
| awareness_of_constraints (10)                                        | (S·V·A)             |
| **design_user_experience**                                           |                     |
| primary_task_clarity (25)                                            | (D·V·O) + S         |
| usability_interaction_flow (25)                                      | (D·V·O)             |
| visual_hierarchy_coherence (15)                                      | (D·V·O)             |
| product_specific_intentionality (15)                                 | (D·V·O) + (S·A)     |
| accessibility_responsiveness (10)                                    | (D·O) + C           |
| feedback_error_states (10)                                           | (D·O·V) + C         |
| **demo_communication**                                               |                     |
| problem_solution_clarity (20)                                        | V + S               |
| actual_proof_demonstration (30)                                      | (V·O·D)             |
| technical_explanation (20)                                           | (V·A·S)             |
| qa_understanding (20)                                                | (A·O)               |
| honesty_about_limitations (10)                                       | (S·V·A) + (C·R)     |
| **track_prize_alignment** (`not_applicable` without declared tracks) |                     |
| official_eligibility_required_technology (20)                        | X + (C·R·D·S)       |
| actual_implementation_evidence (30)                                  | C                   |
| centrality (25)                                                      | C + (S·V·A)         |
| creativity_track_fit (15)                                            | (S·V·A)             |
| demonstrated_use (10)                                                | (D·V·O)             |

**Limitations (stated in the engine README and in every fallback report):**

1. **Needs that cannot be satisfied before M7.** Channels `A` and `O` do not exist until M7. A group made
   only of `A`/`O` can never be satisfied until then: `qa_understanding` (max coverage **0**, its only
   group is `A·O`) and `technical_ownership` (max coverage **1/2**). These are expected; their
   confidence is zero/halved on purpose, and M6 should ask about them. Every other group contains at
   least one channel creatable in M3.
2. **A channel is present, not proven.** A `deployment` observation is one HTTP response; a `video` item
   is oEmbed metadata, not footage. Satisfying a group with them records that such evidence was _cited_;
   `directness`, `specificity` and the strength factors, not coverage, carry how much it shows. Dimensions
   about usability, visual quality or robustness are therefore rarely well covered in practice.
3. **`event_context` evidence is version-level** (M1 facts have no stable IDs), so `X` coverage says
   "the locked rules were cited", not which rule.
4. **Group membership is a heuristic.** Reasonable reviewers will move channels between groups; each
   change is a new engine version and re-baselines the goldens.
5. **Coverage is breadth over channels, not quantity** (consistent with max strength, §5.1).

---

## 8. Typed inputs, outputs, diagnostics, fail-closed rules

```ts
DimensionJudgment = {
  dimensionId: string,                              // must exist in the selected RubricSpec
  outcome: { kind: 'scored'; score: number }        // finite; on the unit's scale; inside [scaleMin, scaleMax]
         | { kind: 'insufficient_evidence' },
  citations: { evidenceId: Uuid; directness; specificity }[],
}
ScoringRequest = {                                  // strictObject; NO attestations field
  engineVersion: 'scoring-engine/v1',
  target: { kind: 'overall' } | { kind: 'track'; trackKey: string },
  unweightedPreview?: 'equal_weight',               // §4.1
  projectContext: { declaredTrackKeys: string[] },  // §4.4
  judgments: DimensionJudgment[],
}
```

New shared vocabularies in `@judge-copilot/schemas` as `*_VALUES` + Zod (reusable by M5): directness,
specificity, evidence channel, rubric source, weight basis, dimension/criterion/overall states,
insufficient reasons, confidence basis, scoring issue codes.

`ScoreReport` (canonical): `engineVersion`, `parametersHash`, `rubric` identity (source, context version
id and content hash or `fallback-rubric/v1`, `weightBasis`), `inputFingerprint`, `graphFingerprint`,
`outputHash`; `dimensions[]` (`state`, `scoreOnScale` and `score10` **only when assessed**,
`evidenceStrength`, `needs` / `confidenceBasis`, `confidence`, `contradictionIds`, `strongestEvidenceIds`);
`criteria[]`; `overall`; optional `unofficialPreview`; `claimLineages[]`; `diagnostics[]`.

**Fail closed, nothing scored, issues collected in deterministic order (path, then code):**
`RUBRIC_INVALID` (not all-or-none weights, outside (0,1], sum off by > `1e-6`, non-finite, duplicate keys,
zero criteria, bad scale), `RUBRIC_NOT_FOUND`, `ENGINE_VERSION_MISMATCH`, `JUDGMENT_MISSING`,
`JUDGMENT_DUPLICATE`, `UNKNOWN_DIMENSION`, `SCORE_NOT_FINITE`, `SCORE_OUT_OF_SCALE`,
`CITATION_UNKNOWN_EVIDENCE` (invented or nonexistent ID), `CITATION_CROSS_PROJECT`,
`CITATION_DUPLICATE`, `UNWEIGHTED_PREVIEW_NOT_APPLICABLE`, `GRAPH_MIXED_PROJECTS`,
`GRAPH_INTEGRITY_FAILED` (dangling, cross-project, structural). `UNJUSTIFIED_VERIFICATION` and
`ARTIFACT_NOT_CORROBORATING` are not fatal: `effectiveLevel` handles them (§2.2) and they are diagnostics.
A model/provider failure never reaches the engine as a number (invariant 22).

**Diagnostics (neutral, never accusations):** `UNATTESTED_PRIVILEGED_LEVEL`,
`UNSUPPORTED_REPO_CORROBORATION`, `JUDGED_VALUE_NOT_USED` (D10), `UNMAPPED_CONTRADICTION`,
`UNMAPPED_UNKNOWN`, `LINEAGE_CONTRADICTED_HEAD`.

**Contradictions: recorded, mapped, never claimed complete.** A contradiction is _mapped_ to a dimension
when one of its sides is a cited evidence item, a claim related to a cited item by a `supports` /
`contradicts` relation, or any member of that claim's supersession chain. A recorded contradiction that
maps to no dimension is listed in `diagnostics` as `UNMAPPED_CONTRADICTION` with its IDs, **not dropped
and not silently attributed**. The report states a fixed `contradictionCoverage: 'recorded_only'`
notice: the engine counts contradictions the graph contains; it cannot know ones nobody recorded, and
"no contradictions" never means "none exist".

**Known limitation.** AI_PIPELINE §3 wants cited evidence checked as relevant to the dimension "per the
evidence graph", but the M3 graph has no dimension link. M4 verifies existence, project and kind;
relevance is the assessor's `specificity` plus M5's domain validation.

---

## 9. Test plan

**Golden scenarios** (hand-authored judgments labeled test data; no model, nothing pretending to be real
judging). Expectations are the numbers in §6, compared by value and `outputHash`; regeneration only with
an explicit flag and reviewed diff.

| Scenario                     | Shows                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------- |
| official weighted rubric     | published weights as-is; scale 1–5 (E13); track rubric as a separate target     |
| official unweighted rubric   | per-criterion scores, `overall.not_computed`; preview only on request (E14)     |
| permitted fallback           | no official overall rubric ⇒ `fallback-rubric/v1`; Track `not_applicable` (E12) |
| official rubric, no tracks   | every official criterion still judged; none removed (D11)                       |
| missing evidence             | E10, E11                                                                        |
| weak but well supported      | E5                                                                              |
| high quality, low confidence | E4                                                                              |
| ten statements, one source   | E3                                                                              |
| coverage vs strength         | E6                                                                              |
| official presence proxy      | E8: `coverage: null`, `confidenceBasis: citation_presence`                      |
| contradictions               | E2; F5 laundering still counted; an unmapped contradiction is listed            |
| invalid weights              | sum ≠ 1, partial weights, 0, > 1, NaN, duplicate keys, zero criteria ⇒ rejected |
| invented / foreign IDs       | unknown dimension, unknown evidence, other-project evidence, malformed UUID     |
| direct-SQL privileged labels | F1–F3 graphs: E9 (0.15 + diagnostics), no uplift                                |
| determinism                  | same input ⇒ identical `outputHash` (100 runs, two processes)                   |

**Exhaustive tests:** every `V × directness × specificity` cell (3×3×3 = 27) recomputed independently;
the `0.5` and `0.6` threshold boundaries (just below, at, just above); fallback weights sum to 1 at every
level, unique IDs, non-empty needs; no public export accepts attestations.

**Metamorphic properties** (seeded generator, no `Math.random`). Corrected from revision 1:

1. **Classification changes never change a score.** Changing only level, directness, specificity or the
   cited set (keeping ≥ 1 usable item) changes strength/confidence, never any score, state or aggregate.
2. **Missing evidence is never imputed or deducted.** Marking a dimension insufficient yields exactly the
   renormalized weighted mean of the remaining assessed dimensions (checked against an independent
   reference), never the zero-filled value, and no other score changes.
3. **Removing a previously scored dimension can change an aggregate in either direction**, and the test
   asserts both directions occur (E10) and that the result equals the reference renormalization; it must
   _not_ assert monotonicity. Dropping below the 0.5 / 0.6 share yields `insufficient_evidence`.
4. **Adding independent, noncontradictory supporting evidence never lowers confidence.** Precondition:
   the added item adds no contradiction ID not already counted. With max strength and binary coverage
   groups, strength and coverage are non-decreasing, so confidence is non-decreasing (E7).
5. **Adding contradictory evidence may lower confidence** (E2) and never changes any score.
6. **Duplicating evidence from the same provenance cannot inflate support or confidence:** a copy with the
   same provenance key yields identical strength, coverage and contradiction count (E3).
7. **A claim label never matters:** changing any claim's `verification_level` (with evidence unchanged)
   changes no score, strength or confidence; only lineage diagnostics may change.
8. **Unattested privileged labels never raise trust:** relabeling any evidence to `machine_verified`,
   `judge_verified` or `live_verified` never raises its strength.
9. **Input order never matters:** permuting judgments, citations and graph record arrays gives a
   byte-identical report. **Repeat runs are bit-identical.**
10. **No rounding drift:** reported criterion/overall values equal values recomputed from unrounded
    inputs, not from reported numbers.
11. **Invalid rubrics are rejected** under every weight perturbation beyond `1e-6`; valid ones within
    `1e-6` are accepted and unchanged.
12. **Project isolation:** project B's records existing in the process never change project A's report; a
    cross-project citation is rejected.

**Scope tests updated in M4:** README-only guard for `scoring`; dependency-rule table (Layer 2; may depend on
`schemas`, `evidence`, `context`); the milestone-scope test keeps forbidding `llm`/`prompts` imports, I/O,
clock, randomness, `Math.pow`/`exp`/`log`, and any column/route/export that persists or serves an
assessment, or accepts attestations.

---

## 10. Planned file changes

| Area      | Files                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas` | `src/scoring.ts` (+ test): vocabularies, `DimensionJudgment`, `ScoringRequest`, `ScoreReport`; export from `index.ts`                                                                                                                                                                        |
| `scoring` | `package.json`, tsconfigs, `README.md` (rewritten), `src/{index,version,parameters,trust,lineage,strength,coverage,confidence,aggregate,validate,engine,canonical}.ts`, `src/rubric/{spec,fallback,official,select}.ts`, `src/testing/{builders,scenarios}.ts`, `*.test.ts`, `golden/*.json` |
| tests     | `tests/integration/dependency-rules.test.ts`, `tests/integration/milestone-scope.test.ts` (advance to M4)                                                                                                                                                                                    |
| docs      | `SCORING.md` (done: §4 note, §2 items 6, new §12), `ARCHITECTURE.md` (package state), `V1_CONTRACT.md` (M4 refinements), `SECURITY.md` (trust boundary), `milestones/M4-report.md`                                                                                                           |
| database  | **none** (no migration; M3 history untouched)                                                                                                                                                                                                                                                |

---

## 11. Remaining tradeoffs and decisions still needing your yes/no

1. **Pure max strength is coarse (D8).** It cannot reward a second independent source inside one
   dimension; breadth shows only through coverage channels (fallback) and not at all for official
   criteria. I recommend accepting that for V1 because every richer rule I can write needs an
   independence assumption the graph cannot support. _Confirm max-only._
2. **Privileged labels resolve to `unverified` (0.15), not to their structural best (D2).** A source-code
   fact mislabeled `machine_verified` scores 0.15 although the same row honestly labeled
   `repo_corroborated` would score 0.60. That is harsher than necessary but simple and strictly fail-closed
   (the label shows the row bypassed the validated path). _Confirm, or choose "demote to the structural
   ceiling" (0.60 when the structure qualifies)._
3. **Official-rubric confidence is a weaker quantity (D5).** With `citationPresence`, confidence
   collapses to `evidenceStrength × contradictionFactor`, and is not comparable with fallback
   confidence. I labeled and separated it everywhere. _Confirm, or choose to omit confidence for
   official units entirely._
4. **`projectContext.declaredTrackKeys` is caller-supplied (D11).** The engine cannot verify it; a caller
   that omits tracks changes only whether the fallback Track criterion is `not_applicable` or
   insufficient. It never affects an official rubric. _Confirm the input._
5. **Preview rejection (D1).** Setting `unweightedPreview` on a weighted rubric is rejected rather than
   ignored, so no caller believes a preview exists. _Confirm._
6. **Heuristic constants (D7, §5.6)** as listed, including thresholds 0.5 / 0.6 and the contradiction
   factor 0.7 (cap 3). _Confirm or amend any constant._
7. **Fallback need-groups (D6, §7)** as provisional v1 data. _Confirm or amend rows._
8. **Edits already made to `SCORING.md`** (policy text only, no formulas): banner, §2 items 5–6, the §4
   adaptation note and new §12. _Confirm the wording._

## 12. Next steps (only after your approval; no formula code until then)

1. Apply any amendments from §11 to this document and `SCORING.md`.
2. `schemas/scoring.ts` vocabularies and schemas, with tests.
3. `packages/scoring` skeleton plus dependency and scope tests.
4. Rubric specs (`official`, `fallback`, `select`) with weight validation.
5. Trust, lineage, strength, coverage/presence, confidence.
6. Aggregation, validation, engine, canonical output.
7. Golden scenarios, exhaustive and metamorphic tests.
8. `pnpm check`, `pnpm db:generate`, PostgreSQL 16 run, M4 report, PR (not merged by me).
