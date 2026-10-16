# M6 — Uncertainty Analysis and Five-Question Engine: implementation report

Branch `claude/m6-five-question-engine`, started from the accepted P6D head. Nothing here calls a live model, spends money, deploys or merges. Every text in the
journeys and screenshots below is **synthetic**; the questions shown are produced by an **offline scripted demonstrator** (fixed templates), not by an AI, and the
product says so on every screen that shows them.

The goal of the milestone is not five sentences. It is to help a human judge spend limited interview time on the questions most likely to clarify
**consequential uncertainty**: the five that, together, would most change what the judge understands about the project, with the reasons and the evidence
visible, and without ever pretending that a missing document is a weak project.

## 1. Starting point and implementation identity

|                              |                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Starting head (accepted P6D) | `b64564040faac6e30e02cdfc6816518751c517be`                                                                   |
| Branch                       | `claude/m6-five-question-engine`                                                                             |
| Implementation head          | `ff1d09747ac30d5483c43504dc9e29f25a862303` (this report is committed on top of it; see §10)                  |
| Phase 0 commit               | `a9c502f` (R8B P3 repairs)                                                                                   |
| Migrations added             | `0021_m6_outcome_accounting` (phase 0), `0022_m6_question_sets`, `0023_m6_question_set_integrity`            |
| New packages                 | `@judge-copilot/uncertainty`, `@judge-copilot/questions` (layer 2, pure)                                     |
| Scope kept out               | M7 team-answer collection, M8 reassessment, M9 final human score, live providers, paid inference, deployment |

## 2. Phase 0: the four R8B P3 findings

Repaired first, with focused regression tests, before any M6 feature work (commit `a9c502f`).

| Finding                                                                                      | What was wrong                                                                                                                           | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P3-1** source authority was inconsistent between editor, lock, API and assessment input    | an `explicit` statement with no source, or citing only a lower-authority source, could be labelled official in one place and not another | **one rule** (`statementBasisOf`, `@judge-copilot/context`): a statement is _official_ only when it is `explicit` **and** cites at least one official-authority source (`official_event_rules`, `official_judging_rubric`, `official_track_rules`); otherwise _organizer-interpreted_ or _unverified_. Lock refuses unsourced or lower-authority "explicit" statements and unsourced rubrics for **every writer** (structured editor, advanced editor, direct API); the API returns the derived basis of every statement; assessment reference evidence excludes non-official statements; the report's rubric label uses the same rule. Locked history is never rewritten (read-time derivation only) | `apps/api/src/event-context/provenance.test.ts` (unsourced rules, lower-authority citations, direct API calls, dates / requirements / judging format / prior-work policy, rubrics, authorization), `packages/assessment/src/event-evidence.test.ts`, `edit/*.test.tsx` |
| **P3-2** deleting a track silently widened its requirements to every project                 | a requirement bound to a deleted track lost its track and became global                                                                  | the editor warns, marks the choice, and **blocks saving** until each affected requirement is reassigned or removed; a crafted post with a stale or dangling track key is refused; renaming a track keeps its identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/integration/context-editor-model.test.ts` (deletion, renaming, stale keys, crafted posts), editor component tests                                                                                                                                               |
| **P3-3** the report showed the raw code `official_track_rubrics_not_assessed`                | a judge could not tell which rubric was scored                                                                                           | the report names the **declared tracks** and states that only the **overall rubric** was assessed; a track's own rubric is listed as _not assessed_, in words, and never folded into the number. `AssessmentDetail.trackContext` is derived at read time                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/integration/track-disclosure.test.ts`, `view.test.tsx`, Chromium journey B (updated to assert the explanation)                                                                                                                                                  |
| **P3-4** "settled calls" in outcome reporting suggested paid provider calls for offline runs | `settled_calls` counts ledger entries (local stage executions)                                                                           | migration `0021` adds `stage_executions` and `provider_calls` to the outcome row (additive, idempotent; history is **not** rewritten and old rows read `NULL` = "not recorded"); `docs/ACCOUNTING.md` states what every counter means; **zero spend is preserved** (`provider_calls = 0`, tokens and cost 0 for every offline run)                                                                                                                                                                                                                                                                                                                                                                    | `demonstration-accounting.test.ts`, `assessment-run-store.test.ts`, migration tests                                                                                                                                                                                    |

A lint-debt note: while closing M6 I found that three of these phase-0 test files (and one assertion in a P6D browser journey that still expected the raw code) had never
passed `pnpm lint` / the browser run. They were repaired properly (typed, no `any`, no non-null assertions) rather than suppressed.

## 3. The uncertainty model (Phase 1)

`@judge-copilot/uncertainty` (`analyzeUncertainty`, engine `uncertainty-engine/v1`) is a **pure function** of a frozen input that the database adapter
(`QuestionInputReader`) reads from a **verified** assessment and the immutable records it was scored from: the verified report (criteria, weights, states,
confidence indices, cited evidence ids), the assessment's **own pinned** claims, evidence, relations, unknowns and contradictions, the verified coverage view (missing
sources, unseen implementation, partial captures), the declared tracks and the event's requirements. It reads no clock, database, network or environment and calls no model: the same
input gives byte-identical output, independent of the order of its lists.

Every opportunity has a reproducible id (`opp-` + 16 hex of its kind and subject ids), a **kind**, a **severity**, the rubric criteria it bears on, `relevanceMilli` (the
share of the overall rubric those criteria carry, used only for ordering), a **neutral observation written by code**, what kind of answer could settle it, and a **trail of
stored ids that all exist in the input** (an inconsistent input is refused with `UncertaintyInputError`, never guessed at).

| Kind                        | Raised when                                                                                                                                   | Severity                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `dimension_not_assessed`    | a criterion has no number (insufficient evidence)                                                                                             | critical ≥ 25 % of the rubric, high ≥ 10 %, else moderate                         |
| `dimension_rests_on_claims` | an assessed criterion cites only team statements (no repository or deployment observation)                                                    | high ≥ 10 %, else moderate                                                        |
| `claim_unverified`          | a team claim bears on a criterion and nothing beyond the team's say-so corroborates it                                                        | high if it touches a dominant criterion, else moderate                            |
| `contradiction_recorded`    | a recorded inconsistency                                                                                                                      | high, raised one step if a dominant criterion is touched                          |
| `unknown_recorded`          | a recorded unknown (by type: eligibility/contradictory high, ambiguous/unverifiable/missing moderate, subjective low)                         | from the type and the weight                                                      |
| `source_missing`            | GitHub or Devpost has no usable capture                                                                                                       | critical (GitHub), high (Devpost)                                                 |
| `coverage_partial`          | part of the implementation was never shown, a capture was partial, or coverage was **never recorded** (unknown, not "complete")               | critical if the verdict is insufficient, high below 50 % inspected, else moderate |
| `requirement_unaddressed`   | a track requirement, or the event's general rules, are cited only as what the event requires                                                  | high (track), moderate/low (general)                                              |
| `track_rubric_not_assessed` | the project's track publishes its own rubric that this version does not score                                                                 | high                                                                              |
| `thin_evidence`             | the assessment's own confidence/evidence-strength indices are low, or the criterion cites only event requirements (nothing about the project) | high on a dominant criterion, else moderate                                       |

What it deliberately does **not** do:

- **Missing evidence is not a deficiency.** No rule reads a low score as a defect; a low score with strong evidence yields nothing. Every observation says what is _unknown_, and several
  say so in words ("This is missing evidence, not a low score / not a finding about the project").
- **A claim stays a claim.** Material that is only a team statement is flagged as resting on claims, never as false.
- **Presentation is not a deficiency.** Thin or absent documentation yields no opportunity of any kind (tested as the strong-implementation / limited-documentation negative control).
- **Nothing accuses.** Contradictions are "recorded inconsistencies to ask about, not conclusions"; the test suite asserts no accusatory vocabulary in any output.
- **It can change no score and no weight**: it has no output any scorer reads.

**Quality tests (named in the brief).** _Polished README claims + incomplete implementation coverage_: the README claim is an unverified claim, the criterion that cites only it
_rests on claims_, and the unseen 80 % of the implementation is a high-severity coverage gap; nothing is treated as verified (`analyze.test.ts`, "the judging-quality cases"). _Strong
implementation + limited documentation_: the analysis produces **no** opportunity about documentation or presentation.

### Worked example (Chromium journey C, synthetic)

An event with an official three-criterion rubric (Innovation 40 %, Execution 35 %, Impact 25 %), one project whose Devpost text was supplied by an organizer, scripted placeholder
scores. The analysis found six opportunities: three _small amount of evidence_ (every criterion's confidence index is 15 %, an artefact of the scripted placeholder), two _recorded gaps
(missing: no deployment, no video)_, and one _requirement not yet shown to be met_ (two event-wide rules cited only as requirements). All six are shown to the judge under "All 6 open
uncertainties" (§8).

## 4. The candidate-generation contract (Phases 2 and 5)

A model (or here, an offline stand-in) only **phrases** candidate questions for uncertainties that code already found. The contract is provider-neutral and strict.

- **Closed set.** Code assigns request-scoped handles from the frozen analysis: `O-001` uncertainties, `D-001` criteria, `C-` claims, `X-` unknowns, `E-` evidence, `K-` contradictions, `R-` requirements, `T-` tracks, `V-` coverage signals.
  A model sees handles and bounded labels, **never a persisted id** (asserted on the rendered prompt); an output naming a handle outside the set is refused, never repaired.
- **Output schema** (`question-candidates`, `v1`, Zod `strictObject`, the same schema the provider is sent as JSON Schema): per candidate `mode` (`ask | clarify | show_me | demonstrate | verify`),
  `text` (≤ 400 chars), `reason` (≤ 600), `expectedInformation`, `opportunities` (≥ 1 handles), `dimensions`, `references` (handles of claims / unknowns / evidence / … that must belong to the cited
  uncertainties), `distinguishes` (`weak | moderate | strong`, a _proposal_), `effort` (`brief | moderate | extended`, a _proposal_). A smuggled `id`, `rank`, `score`, `weight` or evidence text is a schema error.
  At most 40 candidates, 3 per uncertainty.
- **Domain gate** (`validateCandidates`): every handle in the closed set; every reference and criterion belongs to a cited uncertainty; **accusatory wording**, **questions that presuppose an unverified claim**
  (a team statement must be attributed: "Your README states that …"), **several questions disguised as one**, markup / links / injected instructions, empty or over-long text, flooding one uncertainty, and
  near-duplicates are each refused with a stable code. The wording rules are conservative heuristics (documented as such in the source); they cannot prove a sentence harmless and are not a substitute for the judge reading it.
  A refused candidate is **counted by code and never shown**.
- **Prompt** `question-candidates/v1`: frozen identity pinned by a golden hash file (template hash `3efdf00c…f7f3`, output-schema hash `5bc1a9f4…1eae`); trusted instructions only in the system message; every project-derived character only inside
  hash-derived, collision-checked record markers (the existing structural framing); a configured secret in any field aborts the render; the model is told it cannot rank, score, select or weight.
- **Providers.** `StructuredRequest.stage` now also admits `question_generation`; the request goes through the standard `retry( budget( timeout( provider ) ) )` composition, so the budget
  guard, timeout and bounded retry apply unchanged. The only providers are **offline**: the **scripted demonstrator** (fixed templates keyed by the _kind_ of uncertainty and the rubric criterion
  or track names; it never reads what a team wrote) and the **replay provider** (digest-matched, hand-written synthetic fixtures; a request with no entry is a replay miss and stores nothing).
  Both are refused outside development and test by the existing gate. **No live provider exists in this branch.**

## 5. The ranking formula (Phase 3)

`question-engine/v1`. An explicit, documented, testable **ordering rule**; the number it produces is an information-gain _heuristic_ in basis points. It is **not a probability and not calibrated**, and it never alters a score or a weight.

```
value(q) = R × S × D × (0.5 + 0.5·O) ÷ (1 + C)                       each factor in [0, 1]; scaled ×10 000
```

| Factor                     | Meaning                                                            | How it is computed                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R** decision relevance   | how much of the official rubric the question's uncertainties touch | noisy-or over its uncertainties of the rubric share of their criteria (equal share _for ordering only_ when the rubric publishes no weights); fixed floors for an uncertainty with no scored criterion (track requirement .5, track rubric .5, general rule .25, other .2) |
| **S** severity             | how much it could change the picture                               | the largest severity among its uncertainties: critical 1.00, high .75, moderate .50, low .25                                                                                                                                                                               |
| **D** distinguishing power | how well an answer tells the competing readings apart              | the model's _proposal_ (weak .4 / moderate .7 / strong 1.0) **capped by a code table per kind of uncertainty** (contradiction 1.0 … thin evidence .5): a proposal can lower D, never raise it above what the uncertainty supports                                          |
| **O** observability        | whether the judge can _see_ the answer                             | demonstrate 1.0, show_me .9, verify .85, clarify .4, ask .3                                                                                                                                                                                                                |
| **C** interview cost       | time and effort                                                    | the larger of the mode's floor (ask .1 … demonstrate .5) and the proposed effort (brief .1 / moderate .3 / extended .6)                                                                                                                                                    |

**Selection** is greedy by **marginal** value: `marginal(q | S) = value(q) × Π(1 − overlap(q, s))` over the already selected `s`, where overlap is the largest of: shared uncertainties, shared records
(×0.8 when about the same uncertainty or criterion, ×0.4 otherwise), half the shared criteria, and — only when near-identical (≥ 0.95), or similar (≥ 0.7) **and** about the same uncertainty or criterion —
the wording similarity. The loop stops at five, or when the best remaining marginal value is below **3 %** (`MIN_MARGINAL_BP = 300`): **the list is never padded**. Ties end in a total order
(value, severity, cost, candidate key), so identical input always gives identical output. Diversity is therefore built in: five questions about one feature cannot all be chosen, and
templated phrasing around _different_ criteria is correctly treated as different questions (a Chromium run showed the opposite behaviour first; see §9).

Shortfall codes when fewer than five are selected, each with a judge-readable explanation: `no_uncertainty`, `no_valid_candidates`, `fewer_defensible_candidates`, `redundant_candidates`.

## 6. Selection examples (Phase 4)

All executed in `packages/questions/src/select.test.ts` and the API/Chromium suites (§9–10).

| Situation                                                     | Result                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| more than five meaningful independent uncertainties           | exactly five, ranks 1–5, falling marginal value, never two questions for one uncertainty                                                |
| exactly five candidates                                       | five, no shortfall                                                                                                                      |
| three defensible candidates                                   | three, `fewer_defensible_candidates` ("not padded … ask your own questions"), open uncertainties listed as the manual path              |
| nothing uncertain                                             | none, `no_uncertainty` ("without a real uncertainty behind it would only fill space")                                                   |
| every candidate refused                                       | none, `no_valid_candidates`, refusals counted by code                                                                                   |
| every criterion insufficient and no source captured           | questions about the missing material and the unscored criteria; no number anywhere                                                      |
| a recorded contradiction among many low-severity gaps         | the contradiction is selected                                                                                                           |
| uneven weights                                                | the heaviest criterion's uncertainty is asked first; re-weighting the rubric re-orders it (golden)                                      |
| one issue dominating the pool (3 variants of one uncertainty) | exactly one of them selected                                                                                                            |
| multiple tracks and sponsor requirements                      | each track requirement and track rubric is its own question; none dropped                                                               |
| golden reference world (6 uncertainties)                      | `[1800, 1350, 1050, 850, 638]` basis points with novelty `[1000, 1000, 1000, 500, 500]` pinned in a test; any change is a policy change |

## 7. Persistence and immutability (Phase 6)

Tables `question_sets`, `question_set_opportunities`, `question_set_questions` (migrations `0022`, `0023`; both **idempotent** so the documented §6.4 recovery still works).

- **What a set records:** project, **verified assessment** (composite foreign key, same project), the **report output hash**, locked **context version** and extraction it was derived from, policy and engine versions,
  the canonical **input hash**, the **prompt** id/version/template hash/output-schema hash, the **provider** mode/id/model, the request digest and candidate-output hash, counts, the shortfall and its explanation, refusal counts by code,
  the ordered questions with their justification (reason, ranking value, marginal value, factors) and the uncertainties with their reproducible trails and **snapshotted reference labels**.
- **Immutable.** The database refuses `UPDATE`, `DELETE` and `TRUNCATE` on all three tables; a set must agree with the assessment row it names (report hash, context version, extraction) and is refused for a
  voided project; a deferred constraint trigger checks **at commit** that a set holds exactly the opportunities and ranked questions it declares and that every question cites opportunities of its own set. A later capture, a
  context revision or a new assessment never changes a stored set; it yields a different generation key.
- **Idempotent.** `generation_key` = hash of (assessment, report hash, context version, policy, engine, prompt identity, provider, model, input hash) is unique. A repeated request is answered from the stored set **without
  calling the provider** (asserted by a counting provider); eight racing requests create exactly one set.
- **Verified or withheld.** A set is read only after the assessment it belongs to is re-verified (same two-step verification as every read) **and** its report hash equals the one the set recorded; otherwise the questions and
  opportunities are not returned (`assessmentVerified: false`). An unverified assessment cannot generate a set at all (`409 ASSESSMENT_NOT_VERIFIED`).
- **Failure modes store nothing.** A provider failure or a malformed output answers 502 and stores no set, so a transient failure is never frozen as "the" result.
- **Authorization.** New permissions `question.read` and `question.generate` (both roles), every lookup keyed by the project in the URL; another project's assessment or set is indistinguishable from a missing one (no existence leak),
  and the body accepts no field (a client cannot choose provider, model, count or rank). `PUT/PATCH/DELETE` answer 405.

## 8. UI (Phase 7)

The **Five Questions** section on the verified preliminary report (`/projects/<id>/assessment`): rank, wording, mode, **why it matters**, the **uncertainty it addresses** (with its severity in words), the **rubric criteria and their share**, the
**linked evidence and unknowns** (each with its recorded verification label, rendered as text), and **what would settle it**; a "How these were chosen" note; the full list of open uncertainties as the manual path (open when fewer than five). It has
**no answer field** and no score; its only control is the single _Generate_ button before a set exists. Offline demonstrations carry a red banner, _OFFLINE DEMONSTRATION — NOT AI-GENERATED_. The section is absent for an assessment that does not verify,
says so when questions are withheld or cannot be loaded, and explains when generation is unavailable.

Screenshots (Chromium, `docs/milestones/m6-screenshots/`):

| File                                                                         | Shows                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `C3-section-before-generating.png`                                           | the section before generation: one button, no answer field                                                    |
| `C4-five-questions-section.png`                                              | a generated set (3 of 5, with the shortfall explanation and all 6 open uncertainties)                         |
| `D2-missing-source-section.png`                                              | a project whose Devpost page is missing: questions about the missing material, described as unknown, not weak |
| `C4-five-questions.png`, `C5-reloaded.png`, `C2-report.png`, `D1-report.png` | the full page, after a reload (unchanged), and the report                                                     |

## 9. Browser journeys (Phase 8)

`tests/browser/m6.browser.ts`, real Chromium against the production web build, the real API over loopback, the real capture and assessment workers, **no database write and no JSON typed** (the last test checks its own source and the checkout).

**BROWSER_RESULTS**

## 10. Verification

**VERIFICATION**

## 11. Known limitations

1. **No live generation exists.** Every question set in this branch is a scripted demonstration (or a hand-written replay). The wording quality of a real model is untested by design; the validator's wording rules are heuristics.
2. **The scripted demonstrator is intentionally plain.** Its templates are keyed by the kind of uncertainty and the rubric/track names; they are good enough to exercise and show the pipeline, not to interview a team.
3. **A set is pinned to one identity.** Because the generation key includes the provider and prompt, a second provider or prompt version creates a second set (listed newest first); a set produced under a bad prompt stays as history. There is no "regenerate" and no
   delete (immutability); a live attempt counter would be needed before real generation (see §13).
4. **Redundancy is a heuristic.** The overlap formula is documented and tested but its weights are policy choices, not calibrated; unusual wording could slip through or be judged redundant.
5. **Scripted placeholder assessments produce uniform uncertainty.** The reference journeys' "small amount of evidence" opportunities on every criterion come from the scripted placeholder (confidence 15 % everywhere); a real assessment is expected to be more varied.
6. **Track requirements need a declared track.** For an assessment scored against the fallback rubric (no trackContext) track-specific requirements are not turned into questions.
7. **The reference labels are snapshotted** at generation time; they are immutable records so this is exact, but a label cannot be corrected later (by design).
8. **PostgreSQL 16 was exercised with an ICU-provider database; other collations were not.**

## 12. M7 integration contract

M7 (interview mode: the judge records team answers and live verifications) may rely on, and must not break:

- A question set is **immutable and addressable** by `GET /projects/:projectId/question-sets/:setId`; a question has a stable `id`, a `rank` (1–5) and the `opp-…` ids of the uncertainties it addresses; those uncertainties' trails reference **stored ids** (claims, unknowns, evidence, contradictions, requirements).
- An answer must reference a **question id of a verified set** and is a new record; it never edits a set. An answer is a **team statement** (a claim) until verified; a judge-observed live verification is a separate origin. `team_answer` and `judge_observation` are already in the evidence-origin vocabulary and refused by the database until M7 supplies their records.
- The question set tells M8 which assessment dimensions to reassess: `dimensions[].id` per question and `opportunity.dimensionIds` (empty means the uncertainty is not about a scored criterion). M8 must reassess **only affected dimensions**.
- **Answers and questions never change a score by themselves**: scores change only through the deterministic scoring engine over new evidence, and the human final score stays authoritative (M9).
- The `QuestionService.create` idempotency key and the `question.generate` permission are the model for M7's write paths; M7 needs its own immutability triggers and its own permission, and must keep the project-scoped lookup pattern.

## 13. Conditions for eventually enabling live question generation

Not authorized by this milestone. Before any live provider may phrase questions, **all** of the following must be in place and independently reviewed:

1. The owner's explicit authorization and a verified price/quota for the model, with the existing local spending guard (calls, tokens, cost, wall-clock) in force; the question stage must run through the same guarded composition.
2. An **attempt identity** in the generation key (or an explicit new-attempt record) so a failed or poor live generation can be retried without mutating history, and without a retry storm.
3. A **secret-handling review** of the live adapter (no key in logs, prompts or the repository) and an offline replay recording of every prompt used in review.
4. Wording evaluation on synthetic and owner-approved material: refusal rates by code, human review of a sample for presupposition, accusation and leading phrasing, with the heuristics tightened where the sample shows misses; a golden set of known-bad outputs kept in the suite.
5. A decision on what text may leave the system (the prompt carries claim and evidence excerpts); the existing "no project text leaves this system" notice must be replaced by an accurate one for live mode, and the UI must stop saying "not AI-generated" only for demonstrations.
6. Verified-assessment-only generation stays a hard rule, and a model failure must continue to yield **no** set (never a partial one).

## Verdict

**VERDICT**
