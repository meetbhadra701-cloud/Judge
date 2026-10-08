# Milestone 4 — Deterministic Scoring Engine: Design Proposal (for approval)

**Status:** PROPOSAL. No scoring formula, rubric table or scoring code is implemented. This document
exists so the owner can approve, change or reject each policy before M4 proper starts
(`docs/V1_CONTRACT.md`, rule of progression and "decisions that change the deterministic/LLM
boundary").

**Baseline:** `main` at `69a904b73977b6842baef3c397d5835e527598bc` (M3 merged via PR #4).
**Branch:** `claude/m4-scoring-engine`.

What _is_ implemented on this branch: **prerequisite A** (consistent-snapshot graph reads, §1) and a
**characterization audit** of prerequisite B (§2). Nothing else.

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

## 2. Prerequisite B — verification trust boundary (AUDIT; no schema change applied)

### 2.1 What the stored graph can contain when `createGraph` is bypassed

Characterized against PostgreSQL 16 and PGlite in `evidence-graph-direct-sql-trust.test.ts`:

| #   | Finding                                                                                                                                                                                                                                                            | Consequence                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The database accepts a claim at **any** of the 7 levels with **no** evidence (only the vocabulary CHECK exists). `validateGraphIntegrity` reports 5 `UNJUSTIFIED_VERIFICATION`.                                                                                    | A consumer that reads `verification_level` without running the validator sees "verified" claims backed by nothing.                                                                                         |
| F2  | A source-code `machine_verified` fact (real span, unrelated text) + `machine_verified` claim + `supports` relation inserted by SQL passes `validateGraphIntegrity` with **zero issues**.                                                                           | The validator cannot distinguish this from a chain a future trusted producer would write. **It can never be the thing that authorizes a privileged label.**                                                |
| F3  | README-anchored `repo_corroborated` evidence is accepted by the database (the artifact classifier lives in application code). The validator flags the _evidence_ (`ARTIFACT_NOT_CORROBORATING`) but **not** the `repo_corroborated` claim it "justifies".          | Trust must be re-derived from structure, not read from labels.                                                                                                                                             |
| F4  | `judge_observation` and `team_answer` evidence is rejected by a CHECK (SQLSTATE `23514`). A `judge_verified` / `live_verified` _claim row alone_ is accepted (F1).                                                                                                 | Judge/live evidence cannot exist before M7, so any judge/live label in M4 is by definition unattested.                                                                                                     |
| F5  | Through the **legitimate** producer path a chain `repo_corroborated → contradicted → team_claim` is accepted. The head claim then has `team_claim`, **0** contradictions touching it, and a clean integrity audit. The contradiction is attached to the old claim. | A consumer that reads only current claims loses both the contradiction and the earlier level. Conversely, "latest level" never raises trust (a chain can also go `contradicted → repo_corroborated`, F5b). |

### 2.2 Options (none applied; approval requested)

| Option                                             | What                                                                                                                                                                                                                                                                       | Pros                                                                                                                      | Cons                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Fail-closed consumer boundary (RECOMMENDED)** | M4 never reads a verification label as trust. `effectiveTrust()` re-derives it from structure and treats `machine_verified` / `judge_verified` / `live_verified` as **unattested → `unverified`** unless the caller supplies an explicit attestation (§4-E). No migration. | Smallest change; closes F1–F5 for scoring; cannot break M3; **does not choose the M7 trust architecture** (see M7 below). | A direct-SQL actor can still _store_ such rows (they are ignored by scoring, reported as diagnostics).                                                                                                                                                                   |
| B. Migration: CHECK constraints                    | `claims.verification_level` and `evidence_items.verification_level` restricted to `unverified, team_claim, repo_corroborated, contradicted`; M7 relaxes it in its own migration.                                                                                           | Defense in depth at the database; fails closed even for non-scoring readers.                                              | Rewrites the M3-reviewed 49-pair transition and matrix tests; the later relaxation is itself a trust-model change; **does not fix F3/F5** (classification and lineage are not expressible as a CHECK). M3 deliberately declined this once (report: "left to the owner"). |
| C. Explicit trusted-producer provenance (schema)   | Privileged evidence must reference a record of a trusted observation (`machine_observations`, M7 `judge_observations`), by foreign key, written only by a dedicated path/role.                                                                                             | The architecturally correct end state: a label is backed by a record, not an enum value.                                  | It **is** the M7 trust model. Designing it now would pre-empt the interview milestone and the "trusted deterministic observation producer" that M3 explicitly deferred. Needs its own approval and design.                                                               |

**Recommendation:** Option A in M4. Treat B as optional defense in depth that I can add later in a
migration of its own if you want it (it must be paired with the M7 relaxation). Defer C to the M7
design. Option A is deliberately the _interface_ that C will later satisfy: the engine consumes an
`attestations` input (empty in M4). Whatever C turns out to be, only the adapter that builds that input
changes; no formula, schema or golden test does.

**Implications for M7.** Judge observations arrive as `team_answer` / `judge_observation` evidence
with M7-created records. When they do, an adapter fills `attestations` for rows that verifiably point
at such records; the engine already has the weights for those levels (`judge_verified` / `live_verified`
1.00). Nothing in M4 hard-codes "judge levels are impossible".

### 2.3 Claim lineage (the "latest level is not the strongest historic level" problem)

Rules the M4 consumer must follow (all in the proposal below; none touches storage):

1. **Trust never comes from a claim label.** Support strength comes from the _cited evidence items_
   (§5.1). Claim levels are used only for diagnostics.
2. **A historic maximum never raises trust.** A head that is `team_claim` after `repo_corroborated` is
   `team_claim`.
3. **A contradiction on any member of a supersession chain counts against the head.** There is no
   "resolved" state in M3, and a producer-written successor must not be able to launder a contradiction.
   Dimensions whose cited evidence is related (through `supports` / `contradicts`) to any member of such
   a chain inherit the contradiction as an _uncertainty_ (confidence factor, §5.3) — never a score
   deduction.
4. The report exposes per-claim `lineage` (`headId`, ordered `levels`, `everContradicted`,
   `contradictionIds`) so M6 can ask about it and no UI has to guess.

---

## 3. Architecture of M4

```
locked Event Context ──► selectRubric (official | fallback) ──► RubricSpec  ┐
loaded graph (snapshot) + known + attestations ──► trust / lineage view      ├─► scoreProject ─► ScoreReport
M5-validated DimensionJudgment[] (scores on the unit's scale, citations)     ┘     (pure, no I/O)
```

- **Package:** `packages/scoring`, Layer 2, pure TypeScript. Dependencies: `schemas`, `evidence`
  (graph types, `classifyRepositoryArtifact`, lineage queries), `context` (the existing
  `rubricWeightSumIssues` / `RUBRIC_WEIGHT_SUM_TOLERANCE`, so there is one definition of "valid
  weights"). **No `llm`, no `prompts`** (enforced by the existing dependency test), no I/O, no clock,
  no randomness, no `Math.pow`/`exp`/`log` (only `+ − × ÷` and comparisons, which IEEE 754 defines
  exactly).
- **Persists nothing.** No migration, no table, no API route. `pnpm db:generate` stays "no changes".
  Persisting an assessment version, with its engine version, rubric source, weights, input evidence
  IDs and snapshot IDs (SCORING §11), is **M5**; M4 returns everything needed for it
  (`engineVersion`, `rubric` identity, `inputFingerprint`, `graphFingerprint`, `outputHash`).
- **The engine never invents** dimension scores, dimension mappings, weights, evidence, IDs or
  citations. It validates, aggregates and calculates.

---

## 4. The policies the spec left open (A–G), with recommendations

### A. Aggregating an unweighted official rubric

Facts: M1 stores `weight: null` for every criterion of such a rubric and says "how an unweighted rubric
is aggregated is a scoring-engine decision (M4)". `CLAUDE.md` also says "never invent … rubric weights".

**Recommendation:** per-criterion scores are **always** produced and are the primary output. The overall
is computed with **equal criterion weights `1/n`, labeled `weightBasis: 'equal_assumed'`**, carrying a
mandatory `assumption` object, and it can never be reported as `official`. Reasons: (1) equal weighting is
the only weight-neutral choice (principle of indifference — no criterion is favoured); (2) the overall is
decision support, the human final score is authoritative (invariant 15); (3) the label makes the
assumption visible and reversible — a new locked context version with weights produces new scores;
(4) nothing is written into the locked context, so the M1 "never invent weights" rule is kept for data.
**Alternative (stricter):** no overall for unweighted rubrics (`overall.state = 'not_computed'`). Choose
this if you read "never invent weights" as covering engine arithmetic too. **→ Decision D1.**

_Example._ Rubric Innovation / Execution / Presentation (no weights). Judged 8.0, 6.0, insufficient.
Equal weights ⇒ 1/3 each; assessed share = 2/3 ≥ 0.6 ⇒ overall = (8 + 6) / 2 = **7.0**, state
`scored_partial`, `weightBasis: equal_assumed`. Not `(8+6+0)/3 = 4.67`.

### B. Criteria containing insufficient dimensions

**Recommendation:** renormalize **over the assessed dimensions only**, explicitly: criterion score =
`Σ w·s / Σ w` over assessed dimensions, state `partial`, with `assessedWeightShare` reported, and only if
that share is ≥ **0.5** (`CRITERION_MIN_ASSESSED_SHARE`); otherwise the criterion is
`insufficient_evidence` with no number. Confidence is **not** renormalized: an insufficient dimension
contributes confidence 0 with its full weight, so incomplete criteria are visibly less confident while
their _score_ is unaffected (invariants 3, 14, 24). When all dimensions are assessed, the published
weights are used as-is, with no division (no silent renormalization of official weights).

Why 0.5: below half, the criterion score would extrapolate from a minority of what the criterion means.
Why renormalize at all: the alternatives are treating a gap as 0 (forbidden: missing evidence is not
negative evidence) or blocking the whole criterion on any gap (makes pre-interview scoring useless,
because e.g. `qa_understanding` can have no evidence until M7).

_Example (Technical Execution, weights 25/20/20/20/15)._ Implementation 7, Architecture 8, Ownership
insufficient (not yet interviewed), Correctness 6, Challenge 7. Assessed share 0.80. Score
`(0.25·7 + 0.20·8 + 0.20·6 + 0.15·7) / 0.80 = 5.60 / 0.80 =` **7.0**. If the gap were scored 0 the
criterion would be 5.6 — a 1.4-point deduction for missing evidence, which the design forbids.

### C. When the whole assessment is "insufficient evidence"

**Recommendation:** the overall is `insufficient_evidence` (no number) when the **assessed weight share of
the applicable criteria is below 0.6** (`OVERALL_MIN_ASSESSED_SHARE`); otherwise it is `scored`
(everything assessed) or `scored_partial` (renormalized over scored criteria, with the missing criteria
named). The same rule makes a rubric with **one** criterion all-or-nothing, and blocks e.g. 2 of 4 equal
criteria (0.50) while allowing 3 of 4 (0.75). Overall confidence is `Σ W·conf` over all applicable
criteria, so a partial overall is also visibly less confident. `not_applicable` criteria (§4-F, Track)
leave both numerator and denominator.

Why 0.6: a clear majority with margin, so one large criterion (≤ 0.4) may be missing but a minority
assessment cannot masquerade as a project score. The threshold is a version-controlled engine
constant; changing it is a new engine version.

_Example (fallback rubric)._ Technical 7.0, Completion 6.5, Innovation 8.0, Impact 7.5, Design
insufficient, Demo 5.0, Track `not_applicable` (project declared no tracks). Applicable weight 0.90
(Track excluded), scored weight 0.80, share 0.889 ≥ 0.6 ⇒ overall
`(0.20·7 + 0.20·6.5 + 0.15·8 + 0.15·7.5 + 0.10·5) / 0.80 = 5.525 / 0.80 =` **6.9063**
(`scored_partial`, `weightBasis: fallback`).

### D. Exact formulas

See §5 (normative) and the worked examples there.

### E. Producer-asserted `repo_corroborated` vs trusted verification

`repo_corroborated` is a **provenance-bounded, producer-asserted label** (M3 R1). It gets its own, lower
trust factor than a genuine trusted observation, so the shared tier number in the M3 transition table
(`repo_corroborated = machine_verified = 2`, which exists for supersession ordering only) is **never** used
for strength. Privileged levels are accepted only through an explicit `attestations` input, which is
empty in M4:

| Label on the evidence row                                                       | Effective level in M4                                      | Strength factor `V` |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- |
| `unverified`                                                                    | `unverified`                                               | 0.15                |
| `team_claim`                                                                    | `team_claim`                                               | 0.35                |
| `repo_corroborated`, re-derived (§5.1)                                          | `repo_corroborated` (producer-asserted)                    | 0.60                |
| `repo_corroborated`, **not** re-derivable (F3)                                  | `unverified` + diagnostic `UNSUPPORTED_REPO_CORROBORATION` | 0.15                |
| `machine_verified` / `judge_verified` / `live_verified`, **unattested** (F1–F2) | `unverified` + diagnostic `UNATTESTED_PRIVILEGED_LEVEL`    | 0.15                |
| `machine_verified`, attested                                                    | `machine_verified`                                         | 0.90                |
| `judge_verified` / `live_verified`, attested                                    | as labeled                                                 | 1.00                |

_Example._ One piece of direct, exact evidence: producer-asserted `repo_corroborated` ⇒ strength 0.60; the
same row labeled `machine_verified` by direct SQL ⇒ **0.15**; the same row attested by a future trusted
path ⇒ **0.90**. A diagnostic is neutral data for the judge — never an accusation (invariant 25) and
never a quality deduction.

### F. The seven fallback criteria and their dimensions as typed engine inputs

36 dimensions with the published weights (SCORING §3–4). Each has a stable ID
`<criterion_key>.<dimension_key>` and a **declared evidence-need**: groups of acceptable evidence
_channels_ (used only for coverage, §5.2). The full table is §6. Dimension scores arrive as typed
`DimensionJudgment`s (§7); the engine requires **exactly one judgment per dimension of the selected
rubric** (missing, duplicate or unknown IDs are rejected — invariant 20, never repaired).

Fallback definitions live in code (`fallback-rubric/v1`) as part of `scoring-engine/v1`; they are data
of the engine version, not of the database or the Event Context.

### G. New data in the locked Event Context?

**No, and none is needed for v1.** Two gaps exist and are handled without touching a locked version
(frozen by triggers and a content hash):

1. **No dimension mapping exists.** M1 never stored one, although SCORING §4 assumes it. **Recommendation:**
   an official criterion is its own _single dimension_ (`official.<criterion_key>`, weight 1) judged
   against the criterion's own published description and anchors. That is a deterministic structural
   identity, not an invention. If organizers or reviewers later want a criterion split into dimensions,
   that is a **separate, human-reviewed, immutable mapping artifact bound to a locked version's content
   hash** (new tables and a review workflow — an architecture change that needs its own approval), never an
   edit of the locked version and never created at assessment time.
2. **No "fallback permitted" field exists.** The context cannot say "organizers allow filling gaps".
   **Recommendation (v1):** the fallback applies **only when the locked context has no official `overall`
   rubric at all**; partial-official-plus-fallback gap filling is **not supported** (it would be exactly
   the silent rubric rewrite invariants 1 and 16 forbid). A rubric with zero criteria is `RUBRIC_INVALID`,
   not a reason to fall back. Supporting organizer-permitted gap filling needs a new Event Context field
   (an M1 extension and a new context version).

Official **track** rubrics are scored as separate targets (`target: { kind: 'track', trackKey }`), never
blended into the overall. Official scales (`scaleMin`/`scaleMax`, e.g. 1–5) are respected: judgments are
given on the rubric's own scale, validated inside it, and normalized to 0–10 (`10·(x−min)/(max−min)`) for
aggregation; the report returns both.

**→ Decisions D3 (identity mapping), D4 (fallback only when no overall rubric).**

---

## 5. Formulas — `scoring-engine/v1` (normative proposal)

All constants live in one frozen `SCORING_PARAMETERS` object and are part of the engine version.
Arithmetic uses only `+ − × ÷` in a **canonical order** (sort by ID, then fold). This is not a nicety:
in IEEE doubles `0.1 + 0.2 + 0.3 = 0.6000000000000001` but `0.3 + 0.2 + 0.1 = 0.6`, so unsorted input
order would otherwise change outputs.

### 5.1 Evidence strength

For a cited evidence item `e` (kinds `fact` / `claim` only; `absence`, `unknown` and `contradiction` kinds
have strength 0 — they create uncertainty, never support, invariant 3):

```
strength(e) = V(effectiveLevel(e)) × L(directness) × L(specificity)        ∈ [0, 1]
V:  unverified 0.15 · team_claim 0.35 · repo_corroborated 0.60 · machine_verified 0.90 · judge/live 1.00
L:  direct | exact 1.0 · adjacent | partial 0.6 · indirect | generic 0.3
```

`directness` (`direct | adjacent | indirect`) and `specificity` (`exact | partial | generic`) are closed
vocabularies classified by the assessor per (dimension, evidence) citation (SCORING §8: the model
classifies from defined options and never emits a number). `effectiveLevel` is the fail-closed re-derivation
of §2/§4-E: a `repo_corroborated` label stands only if the item is a GitHub `fact` anchored to an artifact
that `classifyRepositoryArtifact` classifies as `source_code` in a captured/partial GitHub snapshot of the
same project; any privileged label stands only with an attestation; anything else falls to `unverified`.
Raw commit counts, LOC, stars, keyword counts, dependency counts and AI-tool use are **not inputs** and no
function accepts them (invariants 5, 6, SCORING §7).

### 5.2 Support, coverage

```
support(d)  = 1 − Π (1 − strength(eᵢ))   over distinct cited items, folded in ascending evidence-ID order
              (noisy-OR: monotone, saturating, bounded, and one item cannot be counted twice)
coverage(d) = (# need-groups of d with ≥ 1 cited usable item in an acceptable channel) / (# need-groups)
```

An item is _usable_ when its kind is `fact` or `claim` (and its strength is > 0). The **channel** of an
item is derived from structure: GitHub + `source_code` artifact → `source_code`; other GitHub →
`repository`; Devpost → `submission`; deployment → `deployment`; video → `video`; event context →
`event_context`; `team_answer` → `team_answer`; `judge_observation` → `judge_observation`. A dimension
without declared needs (every official criterion) uses the **generic need**: group 1 = any
_observation_ channel (`source_code`, `deployment`, `video`, `judge_observation`), group 2 = any
_description_ channel (`submission`, `team_answer`, `event_context`, `repository`). **→ Decision D5.**

### 5.3 Confidence index (independent of the score)

```
confidence(d) = coverage(d) × support(d) × 0.7^min(k, 3)       k = distinct contradictions that touch d
```

`k` counts distinct Contradiction records that touch any cited item, or any member of the supersession
chain of any claim related to a cited item (§2.3). 0.7, cap 3 ⇒ factors 1, 0.7, 0.49, 0.343. Unknowns are
reported as uncertainty reasons, not in the formula (SCORING §5 lists coverage, verification, directness,
specificity and contradictions). Insufficient dimensions have confidence 0. It is an _index_, not a
probability (invariant 13), and it is never an input to any quality score.

### 5.4 Aggregation

```
dimension → assessed (judgment `scored` AND ≥ 1 citation with strength > 0) | insufficient_evidence
criterion = Σ w·s / Σ w over assessed dims            (no division when all assessed: published weights)
            state: assessed | partial (share ≥ 0.5) | insufficient_evidence | not_applicable
overall   = Σ W·c / Σ W over scored criteria          state: scored | scored_partial | insufficient_evidence (share < 0.6)
coverage/confidence (criterion, overall) = weighted sum over ALL applicable children, insufficient = 0
```

A `scored` judgment that cites nothing usable (for example only `absence` evidence) is **not** used: the
dimension becomes `insufficient_evidence` with reason `no_usable_citation`, the original judgment is kept
in the report as `suppressedScore`, and a warning is emitted. A low score justified by missing evidence
is exactly what invariant 3 forbids, and the engine does not "repair" it into a number.

### 5.5 Rounding and canonical output

All math runs unrounded. Each reported number is rounded once, half-up, to **4 decimals**
(`Math.round(x·10⁴)/10⁴`), and rounded values are **never** inputs to any later step (no compounding
drift). Reported display precision: 1 decimal for scores, whole percent for ratios (presentation helpers,
not stored). Official weights validated to `1e-6`; with 10-point scores the un-normalized sum error is at
most `1e-5`, below the half-unit of the 4th decimal (`5e-5`), so using published weights as-is cannot
change a reported value. The report is canonical JSON (sorted keys, fixed array order) with a SHA-256
`outputHash`.

### 5.6 Worked examples (computed by a prototype; reproduced by the golden tests)

1. **One dimension, `completion_functionality.core_user_flow`** (needs: observation ∈ {deployment, video,
   judge_observation} and `source_code`). Cited: source-code span `repo_corroborated`/direct/exact ⇒ 0.600;
   deployment observation `unverified`/direct/exact ⇒ 0.150; Devpost sentence `team_claim`/adjacent/partial ⇒
   0.35·0.6·0.6 = 0.126. `support = 1 − 0.4·0.85·0.874 =` **0.7028**; coverage 2/2 = 1; confidence **0.7028**.
2. **Contradictions** on example 1: k = 1 ⇒ **0.4920**; k = 2 ⇒ **0.3444**; k ≥ 3 ⇒ **0.2411**. The dimension
   _score_ is identical in all four.
3. **More evidence, same score** (invariant 24): add a second source-code item (0.600). Support 0.7028 ⇒
   **0.8811**, confidence rises, the judged score and every aggregate score are unchanged.
4. **High quality, low confidence:** score 9.0 judged from one Devpost sentence (`team_claim`/adjacent/partial,
   0.126; coverage 1/2): confidence **0.063**. Score 9.0 stays 9.0.
5. **Weak but well supported:** score 3.0 with the evidence of example 1: score 3.0, confidence **0.7028**.
6. **Criterion confidence with a gap** (Technical Execution, dimension confidences 0.60/0.55/0/0.50/0.45,
   weights 25/20/20/20/15): `0.25·0.60 + 0.20·0.55 + 0 + 0.20·0.50 + 0.15·0.45 =` **0.4275**.
7. **Fallback overall with a gap and a `not_applicable` Track criterion:** **6.9063**, share 0.889 (§4-C).

---

## 6. Fallback rubric data (`fallback-rubric/v1`) and evidence needs

Channels: **C** `source_code`, **R** `repository` (other GitHub material), **S** `submission` (Devpost),
**D** `deployment`, **V** `video`, **X** `event_context`, **A** `team_answer` (M7), **O** `judge_observation`
(M7). A need-group is a set of acceptable channels; `+` separates groups. Criterion weights: Technical 20,
Completion 20, Innovation 15, Impact 15, Design 10, Demo 10, Track 10 (sum 100). Keys are
`snake_case` of the published names.

| Criterion → dimension (weight within criterion)          | Need-groups         |
| -------------------------------------------------------- | ------------------- |
| **technical_execution** (20)                             |                     |
| implementation_depth (25)                                | C                   |
| architecture_integration (20)                            | C + (R·S·A)         |
| technical_ownership (20)                                 | (R·C) + (A·O)       |
| correctness_robustness (20)                              | C + (D·O·V)         |
| engineering_challenge (15)                               | (C·R) + (S·V·A)     |
| **completion_functionality** (20)                        |                     |
| core_user_flow (30)                                      | (D·V·O) + C         |
| runtime_live_demonstration (25)                          | (D·V·O)             |
| end_to_end_integration (20)                              | (D·O·V) + C         |
| stated_vs_implemented_scope (15)                         | (S·V·A) + (C·D·O)   |
| failure_edge_handling (10)                               | C + (D·O·V)         |
| **innovation_creativity** (15)                           |                     |
| novelty_of_approach (30)                                 | (S·V·A) + (C·R)     |
| differentiation (25)                                     | (S·V·A) + (C·R·D)   |
| original_technical_contribution (25)                     | C + (R·S)           |
| purposeful_technology_use (20)                           | (C·R) + (S·A)       |
| **impact_problem_fit** (15)                              |                     |
| problem_clarity (15)                                     | (S·V·A)             |
| target_user_specificity (15)                             | (S·V·A)             |
| importance_frequency (15)                                | (S·V·A)             |
| solution_problem_fit (30)                                | (S·V·A) + (C·D·O·V) |
| plausibility_of_benefit (15)                             | (S·V·A) + (D·O·V)   |
| awareness_of_constraints (10)                            | (S·V·A)             |
| **design_user_experience** (10)                          |                     |
| primary_task_clarity (25)                                | (D·V·O) + S         |
| usability_interaction_flow (25)                          | (D·V·O)             |
| visual_hierarchy_coherence (15)                          | (D·V·O)             |
| product_specific_intentionality (15)                     | (D·V·O) + (S·A)     |
| accessibility_responsiveness (10)                        | (D·O) + C           |
| feedback_error_states (10)                               | (D·O·V) + C         |
| **demo_communication** (10)                              |                     |
| problem_solution_clarity (20)                            | V + S               |
| actual_proof_demonstration (30)                          | (V·O·D)             |
| technical_explanation (20)                               | (V·A·S)             |
| qa_understanding (20)                                    | (A·O)               |
| honesty_about_limitations (10)                           | (S·V·A) + (C·R)     |
| **track_prize_alignment** (10) — only if tracks declared |                     |
| official_eligibility_required_technology (20)            | X + (C·R·D·S)       |
| actual_implementation_evidence (30)                      | C                   |
| centrality (25)                                          | C + (S·V·A)         |
| creativity_track_fit (15)                                | (S·V·A)             |
| demonstrated_use (10)                                    | (D·V·O)             |

Notes: `qa_understanding` and `technical_ownership` cannot reach full coverage before the interview
(M7 channels), which is intended — the engine reports it, and M6 will ask. `track_prize_alignment` is
`not_applicable` (excluded from numerator and denominator, no confidence penalty) when the project
declared no tracks. **→ Decision D6 (approve the need-group table as v1 data).**

---

## 7. Typed inputs and outputs (Zod, `strictObject`; vocabularies as `*_VALUES` tuples in `@judge-copilot/schemas`)

```ts
// New shared vocabularies (schemas): EVIDENCE_DIRECTNESS, EVIDENCE_SPECIFICITY, EVIDENCE_CHANNEL,
// RUBRIC_SOURCE, WEIGHT_BASIS, DIMENSION/CRITERION/OVERALL_STATE, INSUFFICIENT_REASON, SCORING_ISSUE_CODE

DimensionJudgment = {
  dimensionId: string,                       // must exist in the selected RubricSpec
  outcome:
    | { kind: 'scored'; score: number }      // on the unit's scale; finite; inside [scaleMin, scaleMax]
    | { kind: 'insufficient_evidence' },
  citations: { evidenceId: Uuid; directness; specificity }[],   // ids must exist in the loaded graph
}
ScoringRequest = {
  engineVersion: 'scoring-engine/v1',
  target: { kind: 'overall' } | { kind: 'track'; trackKey: string },
  judgments: DimensionJudgment[],
}
// Not Zod-parsed because they are trusted in-process values: RubricSpec (built by selectRubric from the
// locked snapshot or fallback), LoadedProjectGraph (graph + known), attestations (empty in M4).

ScoreReport = {
  engineVersion, rubric: { source, contextVersionId?, contentHash?, weightBasis, assumption? },
  inputFingerprint, graphFingerprint, outputHash,
  dimensions[]: { id, state, scoreOnScale?, score10?, suppressedScore?, support, coverage, confidence,
                  strongestEvidenceIds, uncertainty: { contradictionIds, unattestedIds, ... } },
  criteria[]:   { key, state, score10?, assessedWeightShare, coverage, confidence },
  overall:      { state, score10?, assessedWeightShare, coverage, confidence, missingCriterionKeys },
  claimLineages[], diagnostics[]    // neutral, never accusations
}
```

**Errors are collected and deterministic (path, then code), like the evidence planner, and nothing is
scored on any of them:** `RUBRIC_INVALID` (weights not all-or-none, outside (0,1], sum off by > 1e-6,
duplicate keys, empty criteria, bad scale), `ENGINE_VERSION_MISMATCH`, `JUDGMENT_MISSING`,
`JUDGMENT_DUPLICATE`, `UNKNOWN_DIMENSION`, `SCORE_NOT_FINITE`, `SCORE_OUT_OF_SCALE`,
`CITATION_UNKNOWN_EVIDENCE`, `CITATION_CROSS_PROJECT`, `CITATION_DUPLICATE`, `GRAPH_MIXED_PROJECTS`,
`GRAPH_INTEGRITY_FAILED` (dangling / cross-project / structural), whereas
`UNJUSTIFIED_VERIFICATION` and `ARTIFACT_NOT_CORROBORATING` are not fatal — they are exactly what the
fail-closed `effectiveLevel` handles — and are reported as diagnostics. A model/provider failure never
reaches the engine as a number (invariant 22): there is nothing to score without judgments.

Known limitation to state in the report: AI_PIPELINE §3 wants "a cited evidence item is relevant to that
dimension, per the evidence graph", but the M3 graph has no dimension link. M4 verifies existence, project
and kind; relevance is the assessor's `specificity` plus M5's domain validation.

---

## 8. Test plan

**Golden fixtures** (hand-authored judgments labeled as test data; no model, no fake "real" judging).
Scenario graphs are built through the real `EvidenceGraphStore` where a database is available and as pure
`EvidenceGraph` fixtures elsewhere. Goldens are JSON files compared by `outputHash` and by value;
regeneration only with an explicit env flag, and reviewed in diff.

| Scenario                     | Shows                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| official weighted rubric     | published weights used as-is; both scales; track rubric scored separately                       |
| official unweighted rubric   | equal-weight overall labeled `equal_assumed` (or `not_computed` if D1 says so)                  |
| permitted fallback           | no official overall rubric ⇒ `fallback-rubric/v1`; Track `not_applicable` without tracks        |
| missing evidence             | insufficient dimension ⇒ renormalized criterion, confidence reduced, score not reduced          |
| weak but well supported      | score 3.0, confidence 0.7028                                                                    |
| high quality, low confidence | score 9.0, confidence 0.063                                                                     |
| contradictions               | k = 0..4 confidence factors; scores unchanged; supersession laundering (F5) still counted       |
| invalid weights              | sum ≠ 1, partial weights, 0, > 1, NaN, duplicate keys, zero criteria ⇒ rejected, never repaired |
| invented / foreign IDs       | unknown dimension, unknown evidence, other-project evidence, malformed UUID ⇒ rejected          |
| direct-SQL privileged labels | F1–F3 graphs: labels ignored (0.15), diagnostics present, no score uplift                       |
| attested vs asserted         | 0.60 vs 0.90 vs 0.15 for identical structure                                                    |
| determinism                  | same input ⇒ identical `outputHash`, 100 runs, in two processes                                 |

**Exhaustive / property tests:** every cell of `V × directness × specificity` (6×3×3); every
dimension/criterion/overall state transition around the 0.5 and 0.6 thresholds; fallback weights sum to 1
at every level; every fallback dimension has a unique ID and a non-empty need.

**Metamorphic tests** (seeded generator, no `Math.random`): (1) changing only evidence classifications
(level, directness, specificity, citation set that keeps ≥ 1 usable item) never changes any score; (2)
adding evidence never lowers a confidence input and never changes a score; (3) a missing/insufficient
dimension never lowers any criterion or overall score; (4) permuting judgments, citations and graph record
arrays never changes the report; (5) no rounding drift (reported criterion/overall equal values recomputed
from unrounded inputs, not from reported numbers); (6) invalid rubrics are rejected in every mutation
(weight perturbations beyond 1e-6); (7) repeated runs are bit-identical; (8) project B's graph present in
the process never changes project A's report, and a cross-project citation is rejected.

**Scope tests updated in this milestone:** the README-only guard for `scoring`, the dependency-rule table
(Layer 2; may depend on `schemas`, `evidence`, `context`), and the milestone-scope test (still forbids
`llm`/`prompts` imports, I/O, clock, randomness, `Math.pow`/`exp`/`log` in the package, and any
column/route/export that persists or serves an assessment).

---

## 9. Planned file changes

| Area       | Files                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas`  | `src/scoring.ts` (+ test): vocabularies, `DimensionJudgment`, `ScoringRequest`, `ScoreReport` schemas; export from `index.ts`                                                                                                                                                                                                                               |
| `scoring`  | `package.json`, `tsconfig*.json`, `README.md` (rewritten), `src/index.ts`, `version.ts`, `parameters.ts`, `rubric/{spec,fallback,official,select}.ts`, `trust.ts`, `lineage.ts`, `strength.ts`, `coverage.ts`, `confidence.ts`, `aggregate.ts`, `validate.ts`, `engine.ts`, `canonical.ts`, `testing/{builders,scenarios}.ts`, `*.test.ts`, `golden/*.json` |
| `evidence` | a small exported helper (`claimLineage`) if it belongs with the graph queries; otherwise inside `scoring`                                                                                                                                                                                                                                                   |
| tests      | `tests/integration/dependency-rules.test.ts` (assign `scoring` its layer/deps), `tests/integration/milestone-scope.test.ts` (advance to M4)                                                                                                                                                                                                                 |
| docs       | `docs/SCORING.md` (replace "specification only" with the approved policies), `docs/ARCHITECTURE.md` (§5–6 package state), `docs/V1_CONTRACT.md` (M4 refinements), `docs/SECURITY.md` (trust boundary), `docs/milestones/M4-report.md`                                                                                                                       |
| database   | **none** (no migration unless Option B is approved)                                                                                                                                                                                                                                                                                                         |

---

## 10. Decisions requiring approval

| #   | Decision                                                                       | Recommendation                                                                                       | Alternative                                       |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| D1  | Overall for an unweighted official rubric                                      | equal weights, labeled `equal_assumed`, always shown with per-criterion scores                       | no overall (`not_computed`)                       |
| D2  | Verification trust boundary                                                    | Option A (consumer fail-closed, `attestations` interface, no migration); defer C to M7               | add B (CHECK migration) now; or design C now      |
| D3  | Official criteria ↔ dimensions                                                 | identity mapping (`official.<key>`, one dimension each); split mapping is a later, separate artifact | block until a mapping artifact exists             |
| D4  | When the fallback applies                                                      | only when the locked context has no official `overall` rubric; no gap filling                        | add an Event Context permission field (M1 change) |
| D5  | Generic evidence need for official criteria                                    | observation group + description group                                                                | per-criterion human-declared needs                |
| D6  | Fallback need-group table (§6) as v1 data                                      | approve as is                                                                                        | amend rows                                        |
| D7  | New shared vocabularies directness / specificity / channel (M5 will emit them) | approve names and the 1.0 / 0.6 / 0.3 ladder                                                         | different labels or ladder                        |
| D8  | Parameters: V table, κ = 0.7 cap 3, thresholds 0.5 / 0.6, 4-decimal rounding   | approve                                                                                              | adjust (any change is just a constant)            |
| D9  | Official scale handling (judge on the rubric's scale, normalize to 0–10)       | approve                                                                                              | require judging on 0–10 only                      |
| D10 | `scored` judgment with no usable citation                                      | becomes `insufficient_evidence`, original kept as `suppressedScore`, warning                         | reject the whole request                          |
| D11 | Track criterion without declared tracks                                        | `not_applicable` (excluded, no penalty)                                                              | keep as insufficient (counts toward the 0.6 rule) |

## 11. Next implementation steps (after approval)

1. Apply decisions to `docs/SCORING.md`; record the engine parameters.
2. `schemas/scoring.ts` vocabularies and schemas with tests.
3. `packages/scoring` skeleton, dependency/scope tests.
4. Rubric specs (`official`, `fallback`, `select`) with weight validation.
5. Trust, lineage, strength, coverage, confidence.
6. Aggregation, validation, engine, canonical output.
7. Golden scenarios, exhaustive and metamorphic tests.
8. `pnpm check`, `pnpm db:generate`, PostgreSQL 16 run, M4 report, PR (not merged by me).
