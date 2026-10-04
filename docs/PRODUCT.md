# Judge Copilot — Product

## The problem

Hackathon judging is fast, high-stakes and under-informed. A judge typically gets a few
minutes per team, a Devpost write-up, a GitHub link, maybe a demo video, and a rubric. In
that time they have to work out:

- what the team actually built, as opposed to what the write-up claims;
- whether the demo shows real functionality or a mock-up;
- whether the project really uses the sponsor technology for the prize track it entered;
- whether prior work was allowed and how much of the project predates the event;
- how the project measures against _this event's_ rubric, not a generic idea of "good".

Judges end up relying on presentation polish, and teams with strong but under-explained work
get under-scored. Judges also lack time to verify claims, so confident claims often stand in for
evidence.

## What Judge Copilot is

Judge Copilot is a **human-in-the-loop** judging assistant. It prepares the judge before they
talk to a team, tells them what it is unsure about and why, suggests the few questions that
would most reduce that uncertainty, and then updates its assessment based on what the judge
learns. **The human judge then enters the final score.** Judge Copilot never replaces the
judge.

## What Judge Copilot is not

It is **not** "rubric + Devpost + GitHub → one LLM → score". A single opaque model call
cannot show its evidence, cannot tell missing evidence from negative evidence, can be
prompt-injected by project content, and cannot be audited. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the pipeline that replaces it.

## Human-in-the-loop philosophy

1. **The judge is the decision-maker.** AI output is decision support: a pre-read, a list of
   uncertainties, suggested questions and an explained draft assessment.
2. **Uncertainty is surfaced, not hidden.** A score always comes with how much evidence covers
   it, how confident the system is, and what it does not know.
3. **Absence of evidence is not evidence of absence.** If the system could not find something,
   it says so and asks. It does not quietly deduct points.
4. **Claims are not facts.** What a team says about its project is a claim until the repository,
   a live check or the judge corroborates it.
5. **No automated accusations.** The system can flag inconsistencies for the judge to ask about.
   It never labels a team as cheating.
6. **The official event rules win.** Organizer rules and rubrics outrank any generic judging
   heuristics built into the product.

## The judging loop

```
          ┌──────────────────────────────────────────────────────────────┐
          │                 Locked Event Context version                 │
          └──────────────────────────────────────────────────────────────┘
                                         │
  1. PRE-READ             sources → snapshots → claims/evidence → dimension assessments
                          → deterministic score + coverage + confidence + uncertainty
                                         │
  2. QUESTIONS            "What could make this assessment wrong?"
                          → candidate questions → information-gain ranking → top five
                                         │
  3. INTERVIEW            judge asks, team answers, judge verifies things live
                          → answers become new claims/evidence
                                         │
  4. POST-INTERVIEW       only affected dimensions are reassessed
                          → explainable pre → post deltas
                                         │
  5. FINAL HUMAN SCORE    judge enters the authoritative final score
```

1. **Pre-read.** Before the team arrives, the judge sees what the project claims, what evidence
   supports or contradicts each claim, a per-dimension draft assessment with cited evidence, and
   an explicit list of unknowns.
2. **Questions.** The system works out which uncertainties matter most to the score and suggests
   five questions for the team, ranked by expected information gain. Each question has a mode:
   `ask`, `clarify`, `show_me`, `demonstrate` or `verify`.
3. **Interview.** The judge talks with the team, types the answers, and records what they
   verified live (for example "watched the deployment process a real upload").
4. **Post-interview reassessment.** Answers become new claims and evidence. Only the dimensions
   that evidence legitimately affects are reassessed. Every score change cites the evidence that
   caused it.
5. **Final human score.** The judge enters the final score. It is authoritative and the system
   cannot change it.

Pre-interview and post-interview assessments are separate, immutable versions. The judge can
always see what changed and why.

## The Event Context Pack

Before judging starts, organizers (or the judging lead) assemble the event's official context:

- official event rules;
- the official judging rubric (criteria, weights and descriptions);
- prize/track requirements;
- sponsor requirements (required technologies, eligibility rules);
- judging format (for example expo vs. stage, time per team);
- event dates (start, end, judging start);
- the allowed prior work policy;
- organizer guidance.

This becomes a **versioned Event Context**. AI may help extract structure from the official
documents (M1), but a human reviews it and **locks** it. Locked versions are frozen. A
correction creates a new version that supersedes the old one, with a recorded reason. No
official assessment runs without a locked Event Context, and every assessment records which
version it used.

When an event has no official rubric, Judge Copilot uses a documented universal fallback rubric
(see [SCORING.md](./SCORING.md)). It is only ever a fallback.

## Why evidence and uncertainty matter

- **Fairness.** Teams are assessed on what they demonstrably built, not on how confidently they
  wrote their Devpost.
- **Explainability.** Every dimension judgment points to evidence IDs. A judge or organizer can
  ask "why?" and get a concrete answer.
- **Better interviews.** Knowing _where_ the assessment is uncertain lets the judge spend scarce
  minutes on the questions that matter.
- **Honesty.** The system can and must say "the evidence is insufficient to assess this".
- **Robustness.** Project content is untrusted data. Separating extraction, validation and
  deterministic scoring keeps a hostile README from steering the score.

Coverage and confidence are separate from quality. More evidence can make the system _more
sure_ of a score without making the score _higher_.

## Why AI is not the final judge

- Judging is a value judgment that belongs to the people the organizers appointed.
- Models can be wrong, inconsistent, manipulated by project content, or unavailable. A
  provider failure must produce _no_ score, never an invented one.
- Teams deserve accountability from a human, not a model.
- Organizers need an auditable process. The human final score, kept separate from AI
  assessments, makes the responsibility clear.

The AI's job is to make the human judge better informed, faster and more consistent. It is
not there to make the decision.
