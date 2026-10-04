# packages/context — Event Context (not yet implemented)

**Milestone:** M1 · **Layer:** 2 (deterministic core — no I/O, no model calls)

Future responsibility:

- the Event Context Pack data model: official rules, official rubric (criteria, weights,
  dimension mapping), prize/track requirements, sponsor requirements, judging format, event
  dates, allowed prior work, organizer guidance;
- structural validation (for example rubric weights must sum to 100%);
- lifecycle rules for `draft → in_review → locked → superseded`, including "official assessment
  requires a locked version" (invariant 18);
- the universal fallback rubric as _data_, used only when no official rubric exists.

AI-assisted extraction of a draft from official documents is orchestrated by the worker using
`llm` + `prompts`. This package validates the result and never calls a model itself.

This directory is intentionally not a workspace package until M1. See `docs/V1_CONTRACT.md`.
