# @judge-copilot/questions — Question validation, ranking and selection (M6)

**Layer:** 2 (deterministic core — no I/O, no model calls). Question _phrasing_ is a model's task and lives behind the `llm` provider port and the
`prompts` package; everything in this package is code and may never import them.

| Module           | What it does                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed-set.ts`  | assigns the request-scoped **handles** a model may name (`O-001` uncertainties, `D-001` criteria, `C-` claims, `X-` unknowns, `E-` evidence, `K-`, `R-`, `T-`, `V-`)  |
| `prompt-view.ts` | the plain-data view of that closed set which the candidate prompt renders (handles and bounded labels only, never a persisted id)                                     |
| `validate.ts`    | the **domain gate**: strict schema, every handle in the closed set, references belong to the cited uncertainties, wording rules, per-uncertainty and duplicate limits |
| `rank.ts`        | the information-gain **ordering heuristic**                                                                                                                           |
| `select.ts`      | greedy selection by **marginal** value: exactly five when five independent, worthwhile questions exist; never padded; an explained shortfall otherwise                |

The ranking value is `R × S × D × (0.5 + 0.5·O) ÷ (1 + C)` in basis points (decision relevance, severity, distinguishing power capped by the kind of
uncertainty, observability, cost). It is an ordering rule, **not a probability and not calibrated**. A model can only lower a candidate's value (its
proposals are capped by code tables); it can add no handle, rank, score or weight. Ties end in a total order, so identical input gives identical output.
Policy version: `question-engine/v1`. See `docs/milestones/M6_FIVE_QUESTION_ENGINE_REPORT.md`.
