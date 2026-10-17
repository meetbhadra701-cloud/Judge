# M6-R3 — Closing the R9C compound-title accusation bypass

Branch `claude/m6-r3-r9c-compound-title-fix`. Nothing here calls a live model, spends money, deploys or merges. One defect, in one function family of
`packages/questions/src/validate.ts`: R9C showed that an official title ending in a misconduct word (`Payment Fraud`, `Exam Cheating`, …) was still set aside as
a neutral subject, so explicit accusations beside it passed. Migrations, API, ranking, selection, concurrency and provider behaviour are untouched.

## 1. Commits

|                       |                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Failed R9C head       | `738c7905f8c5663cd3f6aa514e37941f97fa0b54`                                                                                               |
| Branch                | `claude/m6-r3-r9c-compound-title-fix`                                                                                                    |
| Reproduction commit   | `46b0090` (the bypass, failing on the unchanged code)                                                                                    |
| Implementation commit | `2afb2ea987fc9e677215d9a8d437c82d72e6f601` (this report is committed on top of it; the pushed head is the commit that carries this file) |
| Files changed         | `packages/questions/src/validate.ts` (55 lines), two new test files in `packages/questions/src/`. No other path.                         |

## 2. Reproduction on the unchanged head (`738c790`)

The 175 R9C accusations are reconstructed from the R9C probe table that was available in this environment (7 official titles × 25 frames): `Payment Fraud`,
`Identity Fraud`, `Insurance Fraud`, `Academic Plagiarism`, `Exam Cheating`, `Academic Dishonesty`, `Online Scams`; the five exact examples of the task are among
the frames. Each is validated through `validateCandidates()` as a **verified track** and as a **rubric criterion**, with the title cited by the candidate.

- **126 of 175 accepted as a track and 126 of 175 as a criterion (252 of 350)** — R9C's figure, reproduced. In total **258 of the 357 checks of the first test file failed** (the 350 frame checks, the five exact examples as track+criterion, the reason variant).
- The final test file (`compound-title-bypass.test.ts`, 524 checks) fails **403** times on `738c790`; the adapted R9C attack matrix (`r9c-attack-matrix.test.ts`, 286 checks) fails 100 (the 10-frame × 5-title × 2-context evidence section) and passes 186.
- The complete reviewer suite was not used as such: its attack file is available here and was adapted verbatim (only import paths changed), but the _reviewer's own_ environment is not.

## 3. Root cause and the rule change

`onlyAccusatoryWords()` protected a title from masking only when **every** substantive word was accusatory (`Fraud`), never `Payment Fraud`.

**Rule 1 (the requested one).** `endsInMisconductWord()`: a title whose **last substantive word** is an accusatory word is never set aside. Trailing punctuation, a trailing
parenthetical qualifier, a bare number and filler (`and / of / the / …`) are ignored when finding the last word. Protected: `Fraud`, `Payment Fraud`, `Identity Fraud`, `Exam Cheating`,
`Fraud and Plagiarism`, `Anti-Fraud`, `Prevention of Fraud`, `Payment Fraud (beta)`, `Payment Fraud 2025`. Eligible for the neutral treatment: `Fraud Prevention`, `Plagiarism Detection`,
`Fake News Detection`, `Fraud & Cheating Detection`.

**Rule 2 (found while probing, as the task required).** Rule 1 alone is not enough: an _eligible_ title can still name the misconduct. With only Rule 1, **20 of 20** team-directed accusation frames were accepted for _each_
of `Fake News`, `Fake Reviews`, `Fraud Cases`, `Plagiarism Report`, `Cheating Scandal` (and `Fraud Prevention`, `Plagiarism Detection`, `Fake News Detection`, `Fraud & Cheating Detection`
where those frames are nonsense but also accepted): `Is your team behind Fake News?`, `Can you explain how your team got away with Fraud Cases?`, `Did your team spread Fake News?`.
The lexical test of a title cannot distinguish `Fraud Prevention` (a topic) from `Fake News` (a thing that can be done), so the boundary was moved from the title to the **sentence**:

> A title is set aside only if its sentence refers to no person (`you, yours, yourself/ves, team(s), team members, participants, developers, authors, creators, contestants, entrants`)
> except in four closed, structural forms of a neutral question: a polite request (`can / could / would / will / may / might / shall you …`), the team's own materials
> (`the team's materials / README / claims / statements …`), reported speech (`the team states / claims / describes …`, `a claim by the team`) and the code-written
> `the team can point to it / say more`. Any other reference to the team next to the title leaves the title as written, so the accusatory word inside it is checked like any other.

This replaces the idea “enumerate more charging verbs” (the earlier position/doubt tests are kept as defence in depth, untouched). It is positive licensing: an unknown phrasing is refused.
Two earlier candidate boundaries were tried and rejected on evidence — treating `they/them/their` as the team (broke the code-written demonstration reasons: “…so the interview is the place to cover **them**”), and
treating `this/your project|submission|…` as the team (refused ordinary neutral questions such as “Which part of your project covers …”).

## 4. Results

| Measure                                                                                                                                                                                                                                       | `738c790`          | this branch     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------- |
| 175 R9C accusations as track (126 accepted before)                                                                                                                                                                                            | 126 accepted       | **0 accepted**  |
| the same 175 as criterion                                                                                                                                                                                                                     | 126 accepted       | **0 accepted**  |
| the five exact task examples, track and criterion                                                                                                                                                                                             | accepted           | refused         |
| the same accusations in the _reason_                                                                                                                                                                                                          | accepted           | refused         |
| original R9B bare-title attacks (Fraud / Plagiarism / Cheating × 4 structures × track / criterion)                                                                                                                                            | refused (R2)       | refused         |
| team-directed frames (14) × `Fake News`, `Fraud Cases`, `Fake Reviews`, `Cheating Scandal`, `Plagiarism Report`, `Fraud Prevention`, `Plagiarism Detection`, `Fake News Detection`, `Fraud & Cheating Detection`, track, criterion and reason | all accepted       | **all refused** |
| R9C attack matrix (286 checks)                                                                                                                                                                                                                | 186 pass, 100 fail | **286 pass**    |
| new `compound-title-bypass.test.ts` (524 checks)                                                                                                                                                                                              | 403 fail           | **524 pass**    |

### Neutral-question acceptance (eligible titles, track and criterion, through `validateCandidates()`)

Accepted: `Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?`, `Which implementation supports the Fraud Prevention track requirement?`,
`Can you demonstrate the Plagiarism Detection workflow?`, `Could you show how the Fake News Detection component classifies an article?`,
`Could you show the Fraud & Cheating Detection workflow on one example?` (+ case / hyphen / spacing variants), `Which part of the project covers <title>?`, neutral reasons, and
**all eight code-written demonstration templates** (text and reason, copied from `demonstration.ts`, five kept as a permanent test) for `Fraud Prevention`, `Fake News Detection`, `Plagiarism Detection`, `Fraud & Cheating Detection`, `Fake News`.

## 5. Targeted mutations

Mutation → run the whole `packages/questions` suite → restore → re-run (control). Final code, **12 mutations, 12 killed, 0 survived, 0 invalid**; every control (968 tests) passed.
T5 and T6 disable the same behaviour through two different code paths and are therefore redundant with each other, not with other mutations.

| ID  | Mutation                                                                              | Result             |
| --- | ------------------------------------------------------------------------------------- | ------------------ |
| T1  | the new title-end condition removed (back to “every word accusatory”, the M6-R2 rule) | KILLED (84 failed) |
| T2  | title-end condition removed entirely (unconditional masking)                          | KILLED (158)       |
| T3  | title-end condition inspects the first word instead of the last                       | KILLED (152)       |
| T4  | trailing parenthetical no longer ignored                                              | KILLED (1)         |
| T5  | sentence boundary removed from the position test                                      | KILLED (137)       |
| T6  | sentence boundary: no person is ever found                                            | KILLED (137)       |
| T7  | sentence boundary too generous (`you` licensed everywhere)                            | KILLED (36)        |
| T8  | reason validation bypassed                                                            | KILLED (21)        |
| T9  | forged / candidate-declared titles trusted                                            | KILLED (53)        |
| T10 | neutral compound titles rejected (nothing ever set aside)                             | KILLED (71)        |
| T11 | every occurrence masked (position and sentence tests off)                             | KILLED (152)       |
| T12 | attribution excuses the whole sentence                                                | KILLED (5)         |

## 6. Verification (final, unmutated source)

| Gate                                                                                                                         | Result                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `format:check`, `lint` (`--max-warnings=0`), `typecheck`, `db:check` (journal + drizzle), `build`, `git diff --check`        | all pass                                                                                                      |
| `packages/questions`                                                                                                         | **968 tests pass** (was 158 at M6-R2)                                                                         |
| Existing M6-R1 concurrency / void / shortfall regressions on PostgreSQL 16 + all of `packages/questions`                     | 11 files, **1 060 tests pass**                                                                                |
| Full suite, **PGlite**                                                                                                       | **245 files passed, 6 skipped (251); 5 246 tests passed, 61 skipped, 2 todo; 0 failed** (was 4 436: +810 new) |
| Full suite, **PostgreSQL 16.15, ICU** (`judge_r3full_test`, `locale_provider icu`, `icu_locale en-US`, `LC_COLLATE C.UTF-8`) | **251 files passed (251); 6 331 tests passed, 1 skipped, 4 todo; 0 failed** (was 5 521: +810)                 |
| Chromium                                                                                                                     | **4 files, 43 tests passed** (unchanged)                                                                      |

## 7. No unrelated M6 component changed

`git diff 738c790..HEAD` touches three files: `validate.ts` (55 changed lines, only the title-masking helpers: `endsInMisconductWord`, the new person-reference boundary and its call
site) and two new test files. **No** path under `drizzle/`, `apps/`, `tests/`, `packages/{database,schemas,uncertainty,llm,prompts,domain}`. The claim / lease / fencing code, void handling, immutable sets,
`question-engine/v2` shortfall, ranking, selection, closed-reference validation, presupposition and several-questions guards, scoring, authorization and provider restrictions are byte-identical; their suites are inside the green totals above.
The change only ever refuses more: a title that used to be set aside may now stay as written; nothing is newly accepted.

## 8. False positives (deliberate) and residual limits

**Accepted costs of failing closed (separate from safety):**

1. A title ending in a misconduct word is never set aside, so even neutral questions about `Payment Fraud` / `Identity Fraud` / `Exam Cheating` are refused (`Which feature addresses Payment Fraud?`, `How does your project detect Payment Fraud?`). **Consequence for the offline demonstrator:** all eight of its code-written templates that mention such a title are refused for an event with a track or criterion of that kind; the questions about its other uncertainties are unaffected, and the set may be short (`no_valid_candidates` / fewer than five, never padded). The judge may rephrase.
2. A neutral sentence that puts the team next to any eligible title is refused unless it is one of the four licensed forms: `Did your team implement Fraud Prevention?`, `Could you walk us through how you evaluate Fraud Prevention?` (a second `you`), `Why did you choose Plagiarism Detection?`.
3. Carried over from earlier rounds, unchanged: natural domain vocabulary (`fraudulent transactions`, `fraud alert`) and exact-title matching (`and` ≠ `&`).

**Known residual P3 limitations (tracked, not fixed here):**

- **Unicode confusables**: zero-width / soft-hyphen / Cyrillic / fullwidth characters inside an accusation word are not recognised (pre-existing at every earlier head).
- **Keyword-free insinuations**: `Is Fraud Prevention a lie?`, `Did you build X or just claim it?`, `Deepfake` (not in the vocabulary at all, so `Is your team behind Deepfake?` passes regardless of any title).
- **`and` versus `&`** title matching and other re-wordings of a title.
- **Overly conservative false refusals** (above).
- **Third-person pronouns** (`they / them / their`) are not treated as the team (they refer to non-persons in the code-written reasons).

## 9. Flag for R9D: a surviving class, and the limits of this strategy

**A comparable class survives and is not closed by this change:** insinuations whose only target is the **artifact**, with no person named, next to an _eligible_ title that can name misconduct
(`Fake News`, `Fraud Cases`, `Cheating Scandal`): `Is this submission a case of Fake News?`, `Does your project amount to Fraud Cases?` (2 of the 20 probed frames per such title; 0 for titles that end in a misconduct word, and nonsense, not an accusation, for topic titles such as `Fraud Prevention`).
I judged these not materially equivalent to the R9C bypass (no person is accused, the wording is an inference about the work), and closing them required either treating `this / your project` as the team (which refuses a large share of ordinary neutral questions — measured and rejected) or yet another phrase list.
That is the point of the warning in the task: **the masking strategy is now a stack of heuristics (head-word rule, sentence boundary, position tests, doubt tests) around a core idea — exempt a title from a keyword filter — that cannot be made complete lexically.**
If R9D finds another materially equivalent bypass, the right response is to **replace the strategy** (for example: never exempt a title that contains an accusatory word and have question templates reference criteria by neutral identifiers, or license a title only inside closed, code-written sentence frames), not to add another pattern.

## 10. Verdict

```
M6_R3: READY_FOR_R9D
QUESTION_WORDING_SAFETY: PASS
M7_READINESS: READY_FOR_REVIEW
LIVE_MODEL_READINESS: NOT AUTHORIZED
```

`QUESTION_WORDING_SAFETY: PASS` is scoped to what was tested: the R9B and R9C bypasses, the 175 + 350 reproductions and the title-masking boundary, with the §9 flag. It is not a claim about natural-language accusation detection in general.
Not done, by instruction: merge, deploy, live provider, M7.
