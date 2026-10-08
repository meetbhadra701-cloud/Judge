# Judge Copilot — Scoring Model

> **Status:** Specification and implementation. The scoring engine (`scoring-engine/v1`) is
> **Milestone 4** and is implemented in `packages/scoring`. Its adopted policies are in §12, its
> formulas and constants in §13, and its design rationale and worked examples in
> `docs/milestones/M4-design.md`. Nothing computes a score for a real project yet: assessments, the
> dimension judgments that feed the engine, and any API or UI arrive in later milestones.

---

## 1. Scale

- All dimension, criterion and overall scores use a **0.0–10.0** scale (`Score10`).
- Weights, coverage and the confidence index are ratios in **[0, 1]** (`Ratio`).
- Display precision and rounding rules are defined by the scoring engine version, not by the
  model.

## 2. Rubric precedence

1. **The official event rubric (from the locked Event Context) always wins.** Its criteria,
   weights and descriptions are used as published (invariant 1).
2. Only when an event has no official rubric, or the official rubric leaves a gap the organizers
   explicitly allow us to fill, does the **universal fallback rubric** apply.
3. Judge preferences may influence which highlights and questions are shown. They may **never**
   silently change criteria, weights or anchors (invariant 16). Any rubric change is a new,
   human-reviewed Event Context version.
4. No event-specific logic (for example for a particular named hackathon) is ever hard-coded.
   Event specifics live in Event Context data.
5. **Official weights are validated, never repaired (implemented in M1).** A weighted official
   rubric must have a weight in (0, 1] on every criterion, summing to 1 within an absolute
   tolerance of `1e-6` (`RUBRIC_WEIGHT_SUM_TOLERANCE`). Otherwise the context cannot lock
   (`INVALID_RUBRIC_WEIGHTS`), and the weights are not normalized. An official rubric without
   weights stays unweighted (`weight: null`). M1 never invents equal weights; how an unweighted
   rubric is aggregated is a scoring-engine decision (M4), recorded in §12: the engine never
   creates an official overall score from an unweighted rubric.
6. **No automatic mixing (M4).** An official rubric is used whole or not at all. The fallback
   applies only when the locked context has no official `overall` rubric. See §12.

## 3. Universal fallback rubric

| Criterion                   | Weight |
| --------------------------- | ------ |
| Technical Execution & Depth | 20%    |
| Completion & Functionality  | 20%    |
| Innovation & Creativity     | 15%    |
| Impact & Problem Fit        | 15%    |
| Design & User Experience    | 10%    |
| Demo & Communication        | 10%    |
| Track / Prize Alignment     | 10%    |

This is **only a fallback**. Official event rubrics override it.

## 4. Dimensions

The **fallback** rubric's criteria are decomposed into dimensions. The LLM judges **dimensions**
against scoring anchors. Code aggregates dimensions into criteria with these weights. An
**official** rubric is different: no human-reviewed mapping of its criteria to dimensions exists in
the Event Context, and none is created at assessment time. Each official criterion is itself one
atomic assessment unit (see the adaptation note at the end of this section and §12).

**Technical Execution & Depth**

| Dimension                  | Weight |
| -------------------------- | ------ |
| Implementation depth       | 25%    |
| Architecture / integration | 20%    |
| Technical ownership        | 20%    |
| Correctness / robustness   | 20%    |
| Engineering challenge      | 15%    |

**Completion & Functionality**

| Dimension                    | Weight |
| ---------------------------- | ------ |
| Core user flow               | 30%    |
| Runtime / live demonstration | 25%    |
| End-to-end integration       | 20%    |
| Stated vs. implemented scope | 15%    |
| Failure / edge handling      | 10%    |

**Innovation & Creativity**

| Dimension                       | Weight |
| ------------------------------- | ------ |
| Novelty of approach             | 30%    |
| Differentiation                 | 25%    |
| Original technical contribution | 25%    |
| Purposeful technology use       | 20%    |

**Impact & Problem Fit**

| Dimension                | Weight |
| ------------------------ | ------ |
| Problem clarity          | 15%    |
| Target-user specificity  | 15%    |
| Importance / frequency   | 15%    |
| Solution / problem fit   | 30%    |
| Plausibility of benefit  | 15%    |
| Awareness of constraints | 10%    |

**Design & User Experience**

| Dimension                       | Weight |
| ------------------------------- | ------ |
| Primary-task clarity            | 25%    |
| Usability / interaction flow    | 25%    |
| Visual hierarchy / coherence    | 15%    |
| Product-specific intentionality | 15%    |
| Accessibility / responsiveness  | 10%    |
| Feedback / error states         | 10%    |

**Demo & Communication**

| Dimension                    | Weight |
| ---------------------------- | ------ |
| Problem → solution clarity   | 20%    |
| Actual proof / demonstration | 30%    |
| Technical explanation        | 20%    |
| Q&A understanding            | 20%    |
| Honesty about limitations    | 10%    |

**Track / Prize Alignment**

| Dimension                                  | Weight |
| ------------------------------------------ | ------ |
| Official eligibility / required technology | 20%    |
| Actual implementation evidence             | 30%    |
| Centrality                                 | 25%    |
| Creativity / track fit                     | 15%    |
| Demonstrated use                           | 10%    |

Weights within each criterion sum to 100%. The scoring engine must reject a rubric whose
weights do not sum correctly.

> **Adaptation for official rubrics (M4).** No human-reviewed mapping of official criteria to
> dimensions exists: the Event Context (M1) never stored one, and the engine does not pretend
> otherwise. In `scoring-engine/v1` each official criterion is **one atomic assessment unit** (a
> single dimension of weight 1), judged against that criterion's own published description and
> anchors, on the rubric's own published scale. The 36-dimension decomposition above applies to the
> **fallback rubric only**. A human-reviewed sub-dimension mapping for official criteria would be a
> separate, immutable artifact bound to a locked version's content hash (a future, separately
> approved change); the locked Event Context is never edited and a mapping is never created at
> assessment time.

## 5. Score vs. coverage vs. confidence vs. uncertainty

These are four different things and must never be conflated.

| Concept               | Meaning                                                                                                                                                                                                           | Computed by                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Score**             | Assessed quality on 0–10 for a dimension, criterion or overall                                                                                                                                                    | LLM judges dimensions against anchors; **code** aggregates |
| **Evidence coverage** | Share of the evidence a dimension needs that is actually available                                                                                                                                                | code                                                       |
| **Confidence**        | An _assessment-confidence index_ in [0, 1]: how well-supported the assessment is, from coverage, verification level, directness, specificity and contradictions. **Not a statistical probability** (invariant 13) | code                                                       |
| **Uncertainty**       | The concrete reasons the assessment could be wrong: unknowns, contradictions, unverified claims, subjective calls                                                                                                 | code identifies; LLM may phrase                            |

Consequences:

- **More evidence may raise confidence without raising the score** (invariant 24). Confirming
  that a feature is only half-built makes us _more sure_ of a _modest_ score.
- A dimension can have a score with low confidence. That combination is exactly where the
  interview questions should focus.
- The system must be able to return **"insufficient evidence"** for a dimension instead of a
  number (invariant 14). How insufficient dimensions affect criterion and overall aggregation
  (for example re-normalization plus a confidence penalty, versus blocking an overall score) is
  decided in M4 and recorded in §12 and §13. It must never be modeled as a low score.

## 6. Missing evidence ≠ negative evidence

- `absence` (we looked and did not find it) and `unknown` (we could not determine it) are
  evidence _kinds_ that **create uncertainty and questions**. They do not deduct points
  (invariant 3).
- Only evidence that positively shows a weakness (for example a contradiction between the
  write-up and the code, or a live demo that fails) can lower a dimension score, and it must be
  cited.
- A project with no video is not penalized for "bad demo". Its demo-related dimensions get low
  coverage and generate a `show_me` / `demonstrate` question.

## 7. Signals that never directly award or remove points

These may be _context_ for a semantic judgment, but **no formula may add or subtract points
based on them**:

- raw GitHub commit count (invariant 5);
- sponsor keyword frequency (invariant 6);
- repository stars, forks or watchers;
- lines of code;
- number of dependencies;
- the use of AI tools (by itself, AI-assisted development is neither a bonus nor a penalty;
  only event rules in the locked Event Context can make it relevant, for example eligibility).

Commit history may inform _questions_ (for example about prior work, per the event's
allowed-prior-work policy) and _technical ownership_ judgments with cited evidence. It is never
a score input on its own, and it never becomes an accusation (invariant 25).

## 8. Evidence quality concepts

Each evidence item relevant to a dimension is characterized by:

- **Verification level:** `unverified` < `team_claim` < `repo_corroborated` / `machine_verified`
  < `judge_verified` / `live_verified`. `contradicted` is a separate state that creates a
  `Contradiction` and an uncertainty, not an automatic penalty.
- **Directness:** does the evidence show the thing itself (a working endpoint observed live),
  or only something adjacent (a README section describing it)?
- **Specificity:** does it address this exact dimension and claim, or is it generic?
- **Origin:** `event_context`, `devpost`, `github`, `deployment`, `video`, `team_answer`,
  `judge_observation`.

Evidence strength is a **deterministic formula** over these attributes, defined and versioned in
M4 (§13). The LLM classifies attributes from defined options. It does not output strength numbers.

A verification **label stored on a row is never trusted**: `repo_corroborated` is producer-asserted
and limited, and `machine_verified`, `judge_verified` and `live_verified` cannot raise trust in M4
(§12.7, §13).

## 9. Determinism of the overall score

- Criterion score = deterministic weighted aggregation of its dimension scores.
- Overall score = deterministic weighted aggregation of criterion scores using the rubric from
  the locked Event Context (or the fallback).
- Same inputs + same scoring engine version ⇒ same outputs, bit for bit (invariant 9).
- The LLM never computes or adjusts an aggregate.

## 10. Information-gain questions (future, M6)

After the pre-interview assessment, code asks _"what could make this assessment wrong?"_:

1. Code enumerates uncertainty sources per dimension: unknowns, low coverage, unverified team
   claims, contradictions, eligibility questions.
2. The LLM writes candidate questions, each bound to existing unknown/claim/dimension IDs and a
   mode (`ask`, `clarify`, `show_me`, `demonstrate`, `verify`).
3. Code validates the candidates (IDs exist, no invented IDs, no accusatory phrasing) and ranks
   them with a **deterministic information-gain score**. Roughly, a question ranks higher when
   the dimensions it could resolve carry more weight, are more uncertain, and could move more
   depending on the answer, and when the question can be resolved within the interview
   (`show_me` and `verify` beat unverifiable asks).
4. The top five are shown to the judge.

Judge preferences may re-order or highlight questions. They cannot change the rubric.

## 11. Versioned scoring engine

- The engine is identified by a version string (`scoring-engine/v1`, …).
- Every assessment version records the engine version, rubric source (official Event Context
  version ID or `fallback`), weights, input evidence IDs and snapshot IDs.
- Changing a formula, weight default or aggregation rule creates a new engine version. Old
  assessments stay reproducible under their recorded version.
- Pre → post deltas are computed by diffing two immutable assessment versions. Each changed
  dimension lists the evidence IDs responsible (invariants 11, 12).

## 12. Policies adopted for `scoring-engine/v1` (M4)

These are policy decisions; formulas and parameters are specified in `docs/milestones/M4-design.md`
and are **transparent V1 heuristics, not calibrated statistical probabilities** (invariant 13).

1. **Unweighted official rubric.** The engine returns per-criterion scores and **no overall number**
   (`overall.state = not_computed`). An overall is produced only on an explicit request for a visibly
   unofficial equal-weight **preview**, reported outside `overall` and labeled as an assumption. It is
   never an official overall score.
2. **Rubric precedence.** An official `overall` rubric, if the locked context has one, is the only
   rubric for the overall target. The fallback rubric applies only when there is none. Official and
   fallback criteria are never mixed. Track rubrics are separate targets and never blended.
3. **Official criteria are atomic units** (see the adaptation note in §4).
4. **Insufficient evidence is a state, never a score.** A dimension judged `insufficient_evidence`, or
   judged with a score but without a usable citation, has no numeric value in the report. Insufficient
   dimensions are excluded from (not zero-filled into) their criterion, which is renormalized over the
   assessed dimensions only when enough weight is assessed; otherwise the criterion has no number. The
   same rule applies from criteria to the overall.
5. **`not_applicable`** (excluded from numerator and denominator, no penalty) exists only for the
   Track / Prize Alignment criterion of the **versioned fallback rubric** when the project declared no
   tracks. A criterion of an official rubric is never removed because no track was declared.
6. **Official scales** are normalized to 0–10 for aggregation by `10·(x − min)/(max − min)`. This
   **assumes the published scale is linear** (equal steps are equally valuable); the value on the
   official scale is reported alongside.
7. **Evidence trust is re-derived, never read from a label.** A claim's verification level is never
   proof of semantic truth. `repo_corroborated` is producer-asserted and gets its own, lower factor.
   `machine_verified`, `judge_verified` and `live_verified` labels cannot increase effective trust in M4:
   trusted attestations are internal, empty, and not an input of any caller or model.
8. **Evidence strength of a dimension is the maximum effective strength of its distinct cited evidence**
   (no independence assumption between items). Coverage, confidence and score are separate quantities.
9. **Coverage** is measured only against evidence needs that are actually declared (fallback rubric).
   Where none are declared (every official criterion) the report carries a **citation-presence proxy**,
   labeled as such, and no coverage breadth.
10. **Contradictions are uncertainty, never a deduction**, and only those recorded in the graph are
    counted; the report states that recorded contradictions are not a complete discovery.

## 13. `scoring-engine/v1`: formulas and constants

Implemented in `packages/scoring`. **Every constant is a transparent V1 heuristic, not a calibrated
statistical probability.** Order is the claim (producer-asserted repository corroboration is stronger
than a team statement, which is stronger than an unlabeled item; direct beats adjacent beats indirect);
the spacing is a judgment that has not been fitted to judge outcomes. Changing any value is a new
engine version. All constants and the fallback rubric definition (weights and evidence needs) are
hashed into every report as `parametersHash`.

**Effective level of an evidence item** (never read from a label): `unverified`, `team_claim`, or
`repo_corroborated` only for a GitHub `fact` anchored to repository source code in a captured or
partial snapshot of the same project; privileged labels and unsupported corroboration resolve to
`unverified` with a neutral diagnostic.

```
strength(e)        = V(effectiveLevel) × L(directness) × L(specificity)       e of kind fact | claim, else 0
V                  : unverified 0.15 · team_claim 0.35 · repo_corroborated 0.60
L (both)           : direct | exact 1.0 · adjacent | partial 0.6 · indirect | generic 0.3
group strength     = MIN strength of the records of one provenance group
evidenceStrength   = MAX group strength among the distinct cited, usable evidence      (0 if none)
coverage           = satisfied need-groups / need-groups        (fallback rubric only; declared needs)
citationPresence   = 1 if ≥ 1 usable item is cited, else 0       (official criteria; a flag, NOT coverage)
confidence         = (coverage | citationPresence) × evidenceStrength × F(k)
F(k)               : k = 0, 1, 2, ≥ 3 distinct recorded contradictions → 1, 0.7, 0.49, 0.343
```

**Provenance group.** Records in the same scope (event-context version; or snapshot + artifact, where a
snapshot-level reference is its own scope) whose passages overlap (spans intersect; no span covers the
whole artifact), taken as connected components. Repetition can never add strength, and inconsistent
classifications of the same passage resolve to the lowest.

**Aggregation.** A dimension is `assessed` only with a judged score and at least one usable citation,
else `insufficient_evidence`. Criterion: `Σ w·s / Σ w` over assessed dimensions when at least 0.5 of
the weight is assessed, else `insufficient_evidence`; published weights are used as they are, without
division, when every dimension is assessed. Overall: the same over scored criteria at 0.6; `not_applicable`
criteria leave numerator and denominator. Coverage, citation presence and confidence are weighted means
over all applicable children (insufficient ones contribute their own, possibly zero, values).

**Output.** Computation is unrounded; each reported number is rounded once, half-up, to four decimals,
and rounded values are never inputs to another step. Reports are canonical JSON with a SHA-256
`outputHash`; `inputFingerprint`, `graphFingerprint`, the rubric fingerprint and `parametersHash`
identify what was computed from what.

**What a report never establishes** (fixed notices in every report): contradiction coverage is
`recorded_only` (only contradictions recorded in the graph are counted); `semanticRelevance` is
`not_verified` (the engine validates IDs, project, kind and structure, not whether a cited item is
relevant to its dimension); claim labels are `never_proof_of_truth`; parameters are
`heuristic_not_calibrated`; confidence is an `index_not_probability`.
