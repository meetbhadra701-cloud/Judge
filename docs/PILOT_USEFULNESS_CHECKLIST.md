# Pilot usefulness checklist (human-created)

For a **person** to complete after walking the pilot journey ([DEMO_RUNBOOK §1.10](./DEMO_RUNBOOK.md)). It judges whether the _product's structure_ is useful to a judge. It must **not** be used to claim
that any AI judged the project well: with the scripted demonstrator every score is a placeholder, so score-quality questions are explicitly out of scope until a live model is separately authorized.

Mark each: ✔ yes · ✘ no · n/a. Add one line of evidence (screen, URL, quote) for every ✘.

## A. What the interface can be judged on now (offline, scripted)

| #   | Question                                                                                                                                                                   | ✔/✘ | Evidence |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------- |
| 1   | The report is structured by **the event's own rubric** (its criteria and weights), not a generic one.                                                                      |     |          |
| 2   | Every claim or score can be traced to the **evidence cited** for it, and the evidence shows where it came from (GitHub commit, Devpost text) and who supplied it.          |     |          |
| 3   | What the **team claims** (Devpost text) is visibly separate from what is **verified in the implementation** (repository); organizer-supplied text is labelled as supplied. |     |          |
| 4   | **Missing evidence is not penalized**: a dimension without enough evidence shows no number and a reason, never a low score.                                                |     |          |
| 5   | **Partial coverage is stated honestly**: what was not read (files, commits, a source that failed) is listed, and the page says it is not negative evidence.                |     |          |
| 6   | **Insufficient dimensions and abstentions** are visible and explained, and a partial overall number says what share of the rubric it covers.                               |     |          |
| 7   | A failed or older capture is disclosed (`newer_capture_unusable`), and a refused request says why and what to do (`NO_CONTEXT_REFERENCE_EVIDENCE`).                        |     |          |
| 8   | The page is **unmistakable about being a demonstration**: banner, labels in the version list, no usage/cost presented as real.                                             |     |          |
| 9   | Nothing in the report rewards **proxies**: polished documentation, commit count, or use of AI appear nowhere as a reason for a score.                                      |     |          |
| 10  | The human judge's own final score is clearly separate and authoritative.                                                                                                   |     |          |

## B. What can only be judged with a live model (do **not** answer from the scripted pilot)

| #   | Question                                                                                           | Status                                    |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 11  | The strengths and weaknesses it names are accurate and specific to the project.                    | Not assessable: scores are placeholders.  |
| 12  | The follow-up questions it would suggest are the ones a judge would want to ask.                   | Not assessable: no question feature yet.  |
| 13  | Rationales cite evidence that actually supports them (citation relevance is not verified by code). | Not assessable: rationales are templated. |

Reviewer: ______________ Date: ____________ Project / event used: ______________________________
