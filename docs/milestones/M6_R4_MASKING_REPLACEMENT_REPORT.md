# M6-R4 — Replacing official-title masking

Branch `claude/m6-r4-title-masking-replacement`. Nothing here calls a live model, spends money, deploys or merges. R9D failed M6-R3 because the wording validator deleted a
verified official title before checking for accusations, and every compensating test (people, punctuation, charging verbs, project nouns) was a finite list that the next
probe defeated. This change **removes the exemption** instead of patching it: the validator checks the complete text as written, and the offline demonstrator no longer
needs a title in its wording. No ranking, selection, concurrency, void, database, provider or UI behaviour changed; no migration.

## 1. Commits

|                     |                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Starting head (R9D) | `e0b0f0f53e0dc5222a6b40dd2db2de8a6a452420`                                                                                                                   |
| Branch              | `claude/m6-r4-title-masking-replacement`                                                                                                                     |
| Reproduction commit | `df6f9b0` (the bypass, failing on the unchanged code)                                                                                                        |
| Implementation head | `869efec04ef0d39dd87460464aef8f55efdb5a63` (this report is committed on top of it; the pushed head is the commit that carries this file)                     |
| Files changed       | `packages/questions/src/validate.ts`, `apps/api/src/questions/{demonstration,generation,service}.ts`, tests. No migration, schema, API, UI or database file. |

## 2. Baseline failures reproduced (unchanged `e0b0f0f`)

Real `validateCandidates()`; 19 official titles (the 7 R9C titles, the R9D titles `Fake News`, `Fake Reviews`, `Fraud Cases`, `Cheating Scandal`, `Plagiarism Report`, and `Fraud`, `Plagiarism`, `Cheating`, `Fraud Prevention`, `Plagiarism Detection`, `Fake News Detection`, `Fraud & Cheating Detection`), each as a verified **track** and as a **rubric criterion**, cited by the candidate.

| Family                                                                                                                                                                                                                                                                                       | Accusations accepted on `e0b0f0f`           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 13 frames × 22 subjects (team, 14 other people, submission, project, demo, implementation, source code, results, evidence)                                                                                                                                                                   | **4 374 of 10 868**                         |
| 15 punctuation splits (`behind: T?`, `behind... T?`, `the following? T.`, dash, newline, semicolon, quotes, brackets…)                                                                                                                                                                       | **180 of 570**                              |
| 4 accusations placed in the _reason_                                                                                                                                                                                                                                                         | **54 of 152**                               |
| the six exact R9D examples (`Is your group behind Fake News?`, `Are the founders responsible for Fake Reviews?`, `Is your team behind: Fake News?`, `Did your team commit the following: Fake News?`, `Is this submission a case of Fake News?`, `Does your project amount to Fraud Cases?`) | all six accepted, as track and as criterion |

`title-no-exemption.test.ts` at the reproduction commit: 34 of 65 tests fail.

## 3. The removed trust exception

Deleted from `validate.ts` (186 lines): `withoutNeutralWords` (title masking **and** the attributed-team-words masking), `endsInMisconductWord`, `TITLE_FILLER`, `TEAM_SUBJECT`, `TEAM_REFERENCE`, `NEUTRAL_TEAM_FORMS`, `titleInTeamSentence`, `CHARGED_WITH_BEFORE`, `CHARGED_WITH_PERSON_BEFORE`, `PROJECT_IS_BEFORE`, `DOUBT_AROUND_TITLE`, `titleInAccusingPosition`, `containsRun`, `escapeRegExp`, `WORD_GAP`, and the computation of the `titles` list. The check is now exactly:

```ts
if (ACCUSATORY.test(text) || ACCUSATORY.test(reason)) return refuse('accusatory_wording');
```

on the complete question and the complete reason, as written. Kept: the accusation vocabulary and structures (including the guilt/blame additions of R2), the presupposition, attribution-based “treats a team statement as fact” check, markup, several-questions, duplicate, per-opportunity-limit and every closed-set handle/identity check. Provenance of a title is still verified through the closed-set handles; the title is trusted as a source identifier and shown as reference metadata, never as a licence. The attributed-team-words exception was removed too: it was the same idea (delete trusted-looking text before judging) and no offline path uses it.

## 4. The neutral-template replacement (`demonstration.ts`)

- **No official name is quoted** — not for “sensitive” names (that would again need a word list), but for all of them. A criterion is referred to as `the rubric criterion cited with the third open uncertainty` (`… and its related criteria` when several), a track as `the event track cited with the fifth open uncertainty`; with no track, `the event’s general rules`; with none, `this project`.
- **The ordinal is code-assigned** (the uncertainty’s handle `O-003` is the third), so the same-kind questions about different uncertainties never produce the same sentence. It must be a word, not a digit: the duplicate check ignores tokens shorter than three characters, so `4` vs `5` would have been merged. Ordinal words `first…twentieth`, then `21st`, `22nd`…
- **Variation by question type is kept**: show-me, demonstrate, verify (claims), clarify (contradiction, ambiguity, open points), ask (requirements, criteria, missing material), code walkthrough, and the unknown-type variants are unchanged templates; only the subject phrase changed.
- **The judge still sees exactly which criterion or track**: the question card already lists `Rubric criteria` (name and weight) and `Linked evidence and unknowns`; the demonstrator now also puts the cited **track handle** into the candidate’s own references (before R4 the track was dropped from them and only its name in the wording identified it), and the cited criteria stay in `dimensions`.

## 5. Evidence and source-identity preservation

- The dedup signature is the **source identity**: `kind | recorded unknown type | cited track handle | sorted cited criterion handles` — never the rendered text. Two same-kind uncertainties on different criteria stay two candidates with different wording and their own criterion (tested).
- Every selected question keeps `opportunityKeys`, `dimensions` (real names, as metadata), and `references` including the real track (`id`, `label`). Tested: every question that addresses a track-bound uncertainty is linked to that track; every question that addresses criteria lists them.
- Nothing was erased from the evidence: the uncertainty observation, the linked unknowns/claims and the sources are unchanged. Nothing was invented (no new requirement, claim or accomplishment appears in any template).

## 6. Usability: before (R3) and after (R4), measured with the real demonstrator

Opportunities / candidates / refused / selected, shortfall. R3 = `e0b0f0f`, R4 = this branch.

| Official name                                                                                                          | R3                                       | R4                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| no accusatory name (control)                                                                                           | 6/6/0/5                                  | 6/6/0/5                                           |
| track _Fraud Prevention_ · _Plagiarism Detection_ · _Fake News Detection_ · _Fraud & Cheating Detection_ · _Fake News_ | 8/8/0/5                                  | 8/8/0/5                                           |
| criterion with each of those names                                                                                     | 6/6/0/5                                  | 6/6/0/5                                           |
| track _Payment Fraud_ · _Exam Cheating_ · _Fraud_                                                                      | 8/6/**2**/5                              | 8/8/**0**/5                                       |
| one criterion _Payment Fraud_ · _Exam Cheating_ · _Fraud_                                                              | 6/4/**2**/**3** (`redundant_candidates`) | 6/6/**0**/**5**                                   |
| all four criteria misconduct-named                                                                                     | 6/2/**4**/**1**                          | 6/6/**0**/**5**                                   |
| all four criteria topic-named                                                                                          | 6/6/0/5                                  | 6/6/0/5                                           |
| mixed: track _Payment Fraud_ + criteria _Fake News_, _Exam Cheating_                                                   | —                                        | asserted in the test suite: 0 refused, 5 selected |
| mixed: ordinary track + misconduct-named criteria                                                                      | —                                        | asserted: 0 refused, 5 selected                   |

In every scenario (20 in `question-demonstration-neutral.test.ts`) no official name occurs in any generated question or reason (all candidates, not only the selected), nothing is refused, the same number of questions as the control is selected, and the list is still never padded (`selected = min(5, valid candidates)`). Sample (control): _“Could you show us how one of the statements in your materials about the rubric criterion cited with the second open uncertainty can be checked on the project itself?”_ · _“Could you walk us through the parts of the code that carry the core of the project?”_ · _“Could you demonstrate, on the project itself, what your materials describe for the rubric criterion cited with the first open uncertainty?”_ — comprehensible, with the criterion named beside the question. The wording is more generic than a quoted name; that is the cost, and it is bounded to the offline demonstrator.

## 7. Adversarial outcomes: before and after

| Family (same 19 titles × track and criterion)                                                         | R3 accepted    | R4 accepted                 |
| ----------------------------------------------------------------------------------------------------- | -------------- | --------------------------- |
| frames × subjects (incl. unlisted people, the submission, the demo, the implementation, the evidence) | 4 374 / 10 868 | **0 / 10 868**              |
| punctuation / sentence splits                                                                         | 180 / 570      | **0 / 570**                 |
| accusations in the reason                                                                             | 54 / 152       | **0 / 152**                 |
| R9B original 4 structures × Fraud/Plagiarism/Cheating                                                 | refused        | refused                     |
| R9C 7 titles × 25 frames × track/criterion (350) and the five exact examples                          | refused        | refused                     |
| every question mode (ask, clarify, show_me, demonstrate, verify)                                      | —              | refused in all five         |
| a title absent from the frozen analysis / a candidate that “declares” an official title               | refused        | refused (nothing to exempt) |
| accusation beside several titles in one candidate                                                     | refused        | refused                     |

**Price, stated as tests:** a neutral question that _quotes_ an accusatory-word title (`Can you demonstrate the Plagiarism Detection workflow?`) is now refused, and so is a quotation of a team statement containing a sensitive word. The same question without the title is accepted. Model-phrased candidates (a future live model, or replay recordings) that quote such a title will be refused and counted under `rejections`; the prompt was not changed in this task (a prompt change is a prompt-version bump with its own golden file and belongs to the live-model milestone), so a live model should be instructed to refer to criteria by handle before being enabled.

## 8. Generation identity and historical records

- `generationKeyOf()` gains an optional `demonstration` part, set only for scripted generations (`question-demonstration/v2`, exported next to the templates). A scripted set generated under the new templates is therefore a **new identity** and never reuses — or hides behind — a set stored under the old ones; a replay (or future live) identity is unchanged byte for byte (tested). The demonstrator’s served-model tag is `scripted-demonstration/v2`. The selection policy stays `question-engine/v2`: selection did not change.
- Tested end to end: a set stored under the previous identity (with the old quoted wording) keeps its text and its id, the next request creates a second set (`201 created`), both are listed and readable, and a third request returns the new one (`200 already_generated`).
- **Do old stored sets need a warning or a display restriction? Measured: no.** Sets are written only from the scripted templates (code-written, neutral by construction) and, in tests, replay fixtures — no live provider exists, and the repository holds no question replay fixture. Re-screening what the previous templates produced for the 14 sensitive-name contexts with the new validator: 28 of 98 candidates would now be refused, **all** solely because they quote the title (`…the requirements listed for the “Payment Fraud” track?`); none contains an accusation or a person-directed structure. Historical audit records are therefore neither rewritten nor annotated.
- No schema migration: `policy_version` / generation-key are free text under the existing CHECKs.

## 9. Mutation results (unmutated source restored and re-run after each)

Suite per mutation: `packages/questions` + the demonstrator matrix + the identity/history test (182 tests; control green each time). **15 mutations: 14 killed, 1 equivalent.**

| ID  | Mutation                                                                   | Result                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | title masking restored (titles deleted before the check)                   | KILLED (86)                                                                                                                                                                                         |
| N2  | an official title in the text disables the accusation check                | KILLED (73)                                                                                                                                                                                         |
| N3  | the reason is not checked                                                  | KILLED (31)                                                                                                                                                                                         |
| N4  | candidate-declared “official” wording trusted (forged title)               | KILLED (1)                                                                                                                                                                                          |
| N5  | one mode (`verify`) skips the accusation check                             | **first SURVIVED** (my mode test used `ask` for every mode — a copy error in the helper) → fixed → KILLED (1)                                                                                       |
| N6  | one mode (`ask`) skips the accusation check                                | KILLED (90)                                                                                                                                                                                         |
| N7  | the “reference is inside the cited trail” closed-set check removed         | KILLED (1)                                                                                                                                                                                          |
| N8  | demonstrator strips the candidate’s own references                         | **EQUIVALENT**: the pipeline links a question with no references of its own to the records of the uncertainties it addresses (`generation.ts`, “inherited”), so the persisted question is identical |
| N9  | demonstrator forges a closed-set reference handle                          | KILLED (22)                                                                                                                                                                                         |
| N10 | demonstrator drops only the cited track from the references                | **first SURVIVED** → test strengthened (every question bound to a track must be linked to it) → KILLED (1)                                                                                          |
| N11 | raw criterion and track names interpolated into all demonstrator questions | KILLED (21)                                                                                                                                                                                         |
| N12 | source identities collapsed (signature = kind and type only)               | KILLED (11)                                                                                                                                                                                         |
| N13 | ordinal dropped (identical sentences for different uncertainties)          | KILLED (22)                                                                                                                                                                                         |
| N14 | generation identity ignores the template version                           | KILLED (2)                                                                                                                                                                                          |
| N15 | demonstrator strips the cited criteria from every candidate                | KILLED (1)                                                                                                                                                                                          |

## 10. Verification (final, unmutated source)

| Gate                                                                                                                                                                               | Result                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `format:check`, `lint` (`--max-warnings=0`), `typecheck`, `db:check` (journal + drizzle), `build`, `git diff --check`                                                              | all pass (two lint/type fixes to the new tests were made and the gates re-run from the start) |
| `packages/questions`                                                                                                                                                               | 5 files, **181 tests pass**                                                                   |
| R9A–R9D regressions + M6-R1 concurrency / void / shortfall / store on PostgreSQL 16 (`question-engine-r1`, `-http`, `-r4`, `question-demonstration-neutral`, `question-set-store`) | 5 files, **119 tests pass**                                                                   |
| Full suite, **PGlite**                                                                                                                                                             | **244 files passed, 6 skipped (250); 4 460 tests passed, 61 skipped, 2 todo; 0 failed**       |
| Full suite, **PostgreSQL 16.15, ICU** (`judge_r4full_test`, `locale_provider icu`, `icu_locale en-US`, `LC_COLLATE C.UTF-8`)                                                       | **250 files passed (250); 5 546 tests passed, 1 skipped, 4 todo; 0 failed**                   |
| Chromium                                                                                                                                                                           | **4 files, 43 tests passed**                                                                  |

**Why the totals fell** (R3: 5 246 PGlite / 6 331 PostgreSQL): four test files tested the exemption itself and were deleted (R2 `accusation-context` 22, `official-title-bypass` 76, R3 `compound-title-bypass` 524, `r9c-attack-matrix` 286 = 908 tests, most of them “this title is set aside” assertions that no longer apply); 122 tests were added (96 title-matrix, 25 demonstrator/usability/identity, 1 history), +1 for the second database target. 5 246 − 908 + 122 = 4 460; 6 331 − 908 + 123 = 5 546. The refusal coverage of the deleted files was folded into `title-no-exemption.test.ts` (R9B, R9C and R9D matrices reconstructed).

No unrelated M6 component changed: the diff touches `validate.ts`, three files under `apps/api/src/questions/` and tests; nothing under `drizzle/`, `packages/{database,schemas,uncertainty,llm,prompts,domain}`, `apps/web`, `apps/worker`.

## 11. Remaining bounded limitations

This is still a vocabulary-and-structure heuristic over text, not semantic understanding. Not claimed solved: Unicode confusables and zero-width characters inside an accusation word; keyword-free insinuations (`Is X a lie?`, a word missing from the vocabulary such as `Deepfake`); arbitrary paraphrase; `and` vs `&` is moot (titles are no longer matched). Costs of the design: (a) model-phrased wording that quotes an accusatory-word title is refused (fail closed); (b) the offline questions are more generic than before; (c) the live-model prompt should be told to cite criteria by handle (not changed here); (d) historical sets keep their original quoted wording. The strategy is now one rule with no exemption, so a further bypass would be a _vocabulary_ gap, not a trust-boundary gap.

## 12. Verdict

```
M6_R4: READY_FOR_R9E
QUESTION_WORDING_SAFETY: PASS
FIVE_QUESTION_WORKFLOW: PASS
M7_READINESS: READY_FOR_REVIEW
LIVE_MODEL_READINESS: NOT AUTHORIZED
```

`QUESTION_WORDING_SAFETY: PASS` is scoped: the structural bypass of R9A–R9D (an official title exempting its own accusation) cannot occur because no title is exempted; vocabulary-level limits remain as listed. R9E should retest the removal of the exemption, the neutral demonstrator on sensitive and ordinary names, and the identity/history handling. Not done, by instruction: merge, deploy, live provider, M7.
