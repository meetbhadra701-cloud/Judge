# M6-R2 — Closing the R9B official-title accusation bypass

Branch `claude/m6-r2-r9b-wording-fix`. Nothing here calls a live model, spends money, deploys or merges. A deliberately narrow repair of **one** defect: R9B found
that an official title made of an accusatory word turned the title mask into a general bypass for explicit accusations. The concurrency system, the void
handling, ranking, selection, the shortfall policy and the database are untouched.

## 1. Identity

|                      |                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Failed R9B head      | `e9662b755e351b8382dc0d931b518ef64077fa18` (verified as the starting commit of the branch)                                               |
| Branch               | `claude/m6-r2-r9b-wording-fix`                                                                                                           |
| Reproduction commit  | `869ff27` (the bypass, failing on the unchanged code)                                                                                    |
| Implementation head  | `78457b9ca9adb7d055f620524a19829bb22d38f3` (this report is committed on top of it; the pushed head is the commit that carries this file) |
| Files changed        | `packages/questions/src/validate.ts`, `packages/questions/src/official-title-bypass.test.ts` (new). No migration, no schema, no API.     |
| R9B review artefacts | not present in this environment; the findings were reproduced from the examples in the task, not by re-running R9B's scripts.            |

## 2. Reproduction at `e9662b7` (before any change)

A frozen, verified synthetic context with an official **track** (and, separately, a rubric **criterion**) named `Fraud`, `Plagiarism` or `Cheating`; four sentences
each, validated through the real `validateCandidates()` entry point with the candidate citing an uncertainty bound to that title:

1. `Did your team commit <T> when you built this?`
2. `Why did your team engage in <T>?`
3. `Is your whole project <T>?`
4. `Your team is guilty of <T>, correct?`

**All 24 (4 sentences × 3 titles × {track, criterion}) were ACCEPTED** (`[]` rejections; baseline output kept in the scratchpad). R9B's 16 is the subset with
four titles on tracks; the same mechanism also accepted the compound-title forms (`Did your team commit Fraud Prevention?`, `Your team is guilty of Fraud
Prevention, correct?`, `Is your whole project Fraud Prevention?`) and challenge forms (`Did your team really build the Fake News Detection model?`).
With the final test file, **51 of its 76 tests fail on `e9662b7`** (the 25 that pass are the neutral-acceptance cases, which were never broken).

## 3. Exact root cause

`withoutNeutralWords()` replaced **every** occurrence of a cited official title with a neutral token _before_ the accusation patterns ran. The title came from
the frozen analysis, so it was trustworthy as a _subject_ — but the code treated it as licence to ignore the words it contains. When the title is itself an
accusatory word (`Fraud`) the very word the guard exists to catch was deleted wherever it appeared, and with it the keyword the guard keys on. Compound titles
had the same weakness in a smaller form: `Did your team commit Fraud Prevention?` lost its only accusatory token.

The mistake is a trust-boundary one: a verified title proves what may be **discussed**; it never proves that the team did anything.

## 4. The changed validation policy

Everything is in `packages/questions/src/validate.ts`; `validateCandidates()` still passes the question text **and** the reason through the same check, and still
sets titles from the closed set only (never from the candidate).

1. **A title made only of accusatory words is never set aside** (`Fraud`, `Plagiarism`, `Cheating`, `Fraud and Plagiarism`; filler such as _and/of/the_ ignored).
   Consequence, accepted on purpose: even a neutral sentence that uses such a bare title is refused (fail closed).
2. **A compound title is set aside per occurrence, and only in a neutral position.** The occurrence is **kept as written** (so the accusatory word inside it is
   checked like any other) when it sits:
   - directly after a charge: _commit(ted), guilty of, accused of, suspected of, convicted of, charged with, blamed for, perpetrate…_; or, for verbs that are only
     an accusation when a person does them, after a team subject: _your team … engaged in / resorted to / indulged in / participated in / took part in_;
   - as the predicate of a verdict on the project: _is / was … your (whole) project / entry / submission / demo / results … <title>_;
   - in a sentence that doubts or challenges: _really, actually, truly, supposedly, allegedly, so-called, yourselves, on your own, isn't it true, is it true that, be
     honest, too good to be true, hard to believe, expect us to believe, did you even/ever/really…_.
3. **Keyword-independent accusation vocabulary** added to the existing patterns, checked on the text as written: _guilty, culpable, convicted, misconduct,
   wrongdoing_, and the structure _“you / your team / the team / they … accused of / suspected of / blamed for / charged with”_ — so an accusation cannot hide behind any
   noun, official or not.
4. **Team-statement attribution is unchanged and cannot authorize anything else**: only a run of ≥ 3 consecutive words that also occurs in a cited team claim, and
   only in an attributed sentence, is set aside; the rest of that sentence and every other sentence are checked in full.
5. Unchanged: forged or unrelated titles never authorize anything; closed-set identity validation; the fail-closed default; presupposition and several-questions rules.

## 5. Neutral-title acceptance matrix (all ACCEPTED through `validateCandidates()`)

| Official title (track and criterion) | Question                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Fraud Prevention                     | Can you demonstrate how your Fraud Prevention feature handles a suspicious transaction?         |
| Fake News Detection                  | Could you show how the Fake News Detection component classifies an article?                     |
| Plagiarism Detection                 | Can you demonstrate the Plagiarism Detection workflow?                                          |
| Fraud Prevention                     | Which implementation supports the Fraud Prevention track requirement? _(track)_                 |
| Fraud Prevention                     | … `FRAUD PREVENTION` / `Fraud   Prevention` / `fraud-prevention` (case, whitespace, hyphen)     |
| Fake News Detection                  | … `fake-news-detection`                                                                         |
| Fraud & Cheating Detection           | Could you show the Fraud & Cheating Detection workflow on one example?                          |
| Fraud Prevention                     | a neutral mention in the _reason_ (“The Fraud Prevention track requirement is not yet shown …”) |

## 6. Accusation rejection matrix (all REFUSED `accusatory_wording`, exact official title present)

| Official title                              | Text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fraud                                       | Did your team commit Fraud? · Your team is guilty of Fraud, correct? · Is your project Fraud? · (R9B set of four, also as criterion)                                                                                                                                                                                                                                                                                                                                                                         |
| Plagiarism                                  | Why did your team engage in Plagiarism? · (R9B set of four, track and criterion)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cheating                                    | Did you deliberately cheat during the Cheating track? · (R9B set of four, track and criterion)                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fraud Prevention                            | Why did your team fake the results of Fraud Prevention? · **Did your team commit Fraud Prevention?** · **Your team is guilty of Fraud Prevention, correct?** · **Is your whole project Fraud Prevention?** · Isn’t it true that the Fraud Prevention numbers were not yours? · Is it true that you actually wrote the Fraud Prevention rules yourselves? · Fraud Prevention was supposedly built by your team, wasn’t it? · You have been accused of copying it. Can you show the Fraud Prevention workflow? |
| Fake News Detection                         | Did your team fabricate the Fake News Detection evaluation? · Was your team charged with Fake News Detection? · Did your team really build the Fake News Detection model?                                                                                                                                                                                                                                                                                                                                    |
| Plagiarism Detection                        | Why did your team engage in Plagiarism Detection? · Was your team accused of Plagiarism Detection evasion? · Did you build the Plagiarism Detection module on your own, honestly?                                                                                                                                                                                                                                                                                                                            |
| Fraud and Plagiarism (all words accusatory) | Did your team commit Fraud and Plagiarism? · even the neutral “Can you demonstrate the Fraud and Plagiarism workflow?” (fail closed)                                                                                                                                                                                                                                                                                                                                                                         |
| Fraud Prevention                            | guilt without a noun: Is your team guilty of anything in connection with the Fraud Prevention track? · Is the team culpable … · Was there any misconduct behind … · Was anyone convicted of anything related to the Plagiarism Detection module?                                                                                                                                                                                                                                                             |

Also tested and refused: an accusation in the **reason** (four variants, compound and bare titles); a title **absent from the frozen assessment** (three titles, plus a
_different_ official title); a title **declared by the candidate** in its text or reason; a title **inside a longer word** (`Fraudulent Fraud Prevention`,
`Superfraud Prevention`); a **direct allegation beside an attributed team statement** (same sentence, next sentence, “so …” clause, semicolon clause); and the
original attributed neutral sentence, which stays accepted.

## 7. Independent mutation results

Each mutation was applied to the real source, the `packages/questions` suite run, the file restored, and the **same suite re-run on the restored code** (control).
Final run on the final test file; **15 mutations, 15 killed, 0 survived, 0 equivalent, 0 invalid**; every control passed.

| ID  | Mutation                                                                                                   | Result                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| W1  | unconditional masking of standalone (only-accusatory) official titles restored                             | KILLED (3 failed)                                                        |
| W2  | a masked official title disables the direct-accusation check for the text                                  | KILLED (16)                                                              |
| W3  | the candidate's reason is not checked                                                                      | KILLED (8)                                                               |
| W4  | candidate-declared titles (capitalised phrases of its own text/reason) are trusted                         | KILLED (10)                                                              |
| W5  | legitimate neutral compound titles are rejected (never set aside)                                          | KILLED (24)                                                              |
| W6  | accusatory wording inside an attributed sentence is permitted (the whole attributed sentence is set aside) | KILLED (4)                                                               |
| X1  | titles masked in every position (position test always “neutral”)                                           | KILLED (11)                                                              |
| X2  | “commit / guilty of / accused of …” position test removed                                                  | KILLED (4)                                                               |
| X3  | “your team engaged in / resorted to …” position test removed                                               | KILLED (2)                                                               |
| X4  | “is your project <title>” verdict test removed                                                             | KILLED (2)                                                               |
| X5  | doubt / challenge test removed                                                                             | KILLED (6)                                                               |
| X6  | only single-word titles count as “only accusatory”                                                         | KILLED (2)                                                               |
| X7  | title match no longer whole-word                                                                           | KILLED (2)                                                               |
| X8  | new guilt/blame vocabulary removed                                                                         | **first SURVIVED** → four noun-free guilt/blame tests added → KILLED (3) |
| X9  | “<team> … accused of / suspected of …” structure removed                                                   | KILLED (1)                                                               |

X8 was a genuine gap in my first tests (the position test and the keyword already covered every sentence I had written); it is closed, not dismissed as equivalent.

## 8. Verification (on the final, unmutated source)

| Gate                                                                                                                                            | Result                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                                                                                                                             | pass                                                                                                               |
| `pnpm lint` (`--max-warnings=0`)                                                                                                                | pass (an earlier run flagged two void-expression arrows in the new test helpers; fixed in `78457b9`, then re-run)  |
| `pnpm typecheck`                                                                                                                                | pass                                                                                                               |
| `pnpm db:check` (journal chronology + drizzle check)                                                                                            | pass; no migration added, 0021–0024 untouched (`git diff e9662b7..HEAD` touches no `drizzle` path)                 |
| `pnpm build`                                                                                                                                    | pass                                                                                                               |
| `git diff --check`                                                                                                                              | clean                                                                                                              |
| Focused: `official-title-bypass.test.ts` (new)                                                                                                  | 76 tests pass (51 of them fail on `e9662b7`)                                                                       |
| Focused: all of `packages/questions`                                                                                                            | 6 files, **158 tests pass** (was 82 with the M6-R1 files)                                                          |
| Existing M6-R1 concurrency / void / shortfall regressions on PostgreSQL 16 (`question-engine-r1`, `question-engine-http`, `question-set-store`) | 3 files, **92 tests pass**                                                                                         |
| Full suite, **PGlite** (`pnpm test`)                                                                                                            | **243 files passed, 6 skipped (249); 4 436 tests passed, 61 skipped, 2 todo; 0 failed** (was 4 360: +76 new tests) |
| Full suite, **PostgreSQL 16.15, ICU** (`judge_r2full_test`, `locale_provider icu`, `icu_locale en-US`, `LC_COLLATE C.UTF-8`)                    | **249 files passed (249); 5 521 tests passed, 1 skipped, 4 todo; 0 failed** (was 5 445: +76)                       |
| Chromium (`pnpm test:browser`)                                                                                                                  | **4 files, 43 tests passed** (unchanged)                                                                           |
| Targeted mutations                                                                                                                              | 15 / 15 killed, controls green                                                                                     |

## 9. No unrelated M6-R1 behaviour changed

- The diff against the failed head is **two files** (`validate.ts`: 93 changed lines, all in the wording policy; one new test file). No file under `apps/`, `packages/database`, `packages/schemas`, `packages/uncertainty`, `packages/llm`, `drizzle/` or `tests/` is touched.
- Consequently the claim/lease/heartbeat/fencing code, void handling, immutable question sets, `question-engine/v2` shortfall policy, ranking, selection, verified-assessment-only generation, provenance, offline-only provider restrictions and the zero-spend posture are byte-identical; their tests (4 360 previously accepted PGlite, 5 445 PostgreSQL, 43 Chromium) still pass inside the new totals.
- The wording policy gets **stricter only**: every text refused at `e9662b7` is still refused (the title mask can now only do less, and three groups of words were added to the patterns). The sole texts that change from accepted to refused are accusations that used an official title as cover.

## 10. Residual heuristic limits (honest)

This remains a conservative vocabulary-and-structure heuristic over text. It is **not** a semantic-safety guarantee.

1. **Implication without a keyword or a doubt marker passes.** `Wasn’t the Fraud Prevention demo suspiciously perfect?`, `Were the Fraud Prevention results a bit too convenient?` and `Did your team really build it?` (no title in the sentence) are accepted; so are the known leading phrasings of R9A P3-c (`Did your team lie about …`, `really your own work`, `pass off … as yours`).
2. **Fail-closed false refusals remain** (R9B F2, unchanged and tracked): `How does your system recognise fraudulent transactions?` and `Can you demonstrate how you detect fraud in the Fraud Prevention track?` are refused because only the exact title is set aside, not domain vocabulary around it. New, deliberate false refusals: a bare accusatory-word title is never set aside even in a neutral sentence; and the position tests can refuse an innocent sentence (`When did you commit Fraud Prevention changes to main?`).
3. The position and doubt tests look at a bounded window of text before the title and at its sentence; an accusation phrased in a way none of them recognises, with a title that contains no accusatory word, is not stopped by this layer (nor was it before).
4. Team-statement masking is unchanged: a sentence that attributes and then accuses is checked in full, but an accusation made _only_ in words copied from a recorded team claim is, by design, treated as the team's own words.
5. Sentences about things that merely _sound_ neutral are accepted only when none of the above is detected; the judge reading the question remains the final control.

The other R9A/R9B P3 items (multi-uncertainty relevance inflation, acronym collisions, F3 “largely repeated” wording at the margin, F4 claim-binding hardening, F5 report wording) are **tracked and untouched** by this repair.

## 11. Verdict

```
M6_R2: READY_FOR_R9C
QUESTION_WORDING_SAFETY: PASS
M7_READINESS: READY_FOR_REVIEW
LIVE_MODEL_READINESS: NOT AUTHORIZED
```

`READY_FOR_R9C` means every gate in §8 passed and the 24 reproduced accusations (and the compound-title and challenge forms) are refused while the neutral matrix is accepted; it is not an
acceptance. R9C should retest the wording bypass independently (single-word and compound titles, criteria and tracks, reason, attribution, forged titles) and
the heuristic limits in §10. Not done here, by instruction: merge, deploy, live provider, M7.
