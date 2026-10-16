# @judge-copilot/uncertainty — Uncertainty analysis (M6)

**Layer:** 2 (deterministic core — no I/O, no model calls, no clock, no environment)

Answers one question about a **verified** pre-interview assessment: _what could make it wrong, incomplete or materially misleading?_
`analyzeUncertainty(input)` is a pure function of a frozen `UncertaintyInput` (built by the database adapter from the assessment's verified report
and the immutable records it was scored from) and returns structured **opportunities**: each has a reproducible id (`opp-` + 16 hex of its kind and
subject ids), a kind, a severity, the rubric criteria it bears on, a neutral observation written by code, what kind of answer could settle it, and a
trail of stored ids that all exist in the input.

Principles (invariants 3, 4, 14, 25 of `docs/ARCHITECTURE.md`):

- **Missing evidence is uncertainty, never a deficiency.** No rule reads a low score as a defect; an assessed criterion with strong evidence yields nothing.
- **A team statement is a claim** until something beyond the team's own say-so corroborates it: such material is flagged as _resting on claims_, never as false.
- **Presentation is not a deficiency.** Thin or absent documentation is not an opportunity of any kind. Only an expected source with no usable capture,
  or an unseen part of the implementation, is.
- **Nothing accuses.** A recorded contradiction is an inconsistency for a judge to ask about.
- **Event requirements** (`event_context` records) say what the _event_ requires, never what the project does: a criterion that cites only them has examined nothing about the project.
- It has **no output that any scorer reads**: it changes no score and no weight. The rubric share of a criterion only _orders_ opportunities.

The ten kinds, their thresholds (`THRESHOLDS`) and the engine version (`uncertainty-engine/v1`) are documented in `docs/milestones/M6_FIVE_QUESTION_ENGINE_REPORT.md`.
A change of any rule or threshold is a new engine version.
