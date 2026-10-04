# Instructions for coding agents

Judge Copilot is a human-in-the-loop hackathon judging system. Before changing anything, read
`docs/ARCHITECTURE.md` and `docs/V1_CONTRACT.md`.

## Hard rules

1. **Never collapse the pipeline** into "rubric + devpost + github + answers → one LLM → score".
   The pipeline is: sources → immutable snapshots → atomic claims → evidence → contradictions /
   unknowns → dimension assessments → deterministic weighted scoring → uncertainty analysis →
   information-gain question selection → verified human answers → new evidence →
   affected-dimension-only reassessment → explainable deltas → human final judgment.
2. **Respect the 25 invariants** in `docs/ARCHITECTURE.md` §4. In particular: missing evidence is
   not negative evidence; overall scores are deterministic; the model never invents IDs; model
   failure never yields a score; the human final score is authoritative; no automatic cheating
   accusations; repository contents are never executed.
3. **Deterministic vs. LLM boundary.** Weights, aggregation, coverage, confidence, ranking, state
   transitions, versioning and auditing are code. Models only do the semantic tasks listed in
   `docs/ARCHITECTURE.md` §3. Layer-2 packages must never import `llm` or `prompts`.
4. **One milestone at a time.** Do not start milestone N+1 until milestone N passes its tests
   and its report in `docs/milestones/` is written. Do not pull later-milestone features forward.
5. **Stop and ask** before any change that would materially alter the architecture, the
   invariants or the dependency rules.
6. **Never edit an existing migration.** Add a new one with `pnpm db:generate`.
7. **No fake functionality.** No sample scores, mock projects or fake evidence in the real UI or
   API. Empty packages get a README describing their future role, not stub code.
8. **No secrets** in the repository, logs or prompts.

## Before you finish

Run `pnpm check` (format, lint, typecheck, migration check, tests, build) and report exact
results. Tests must not make external network calls.

## Conventions

- TypeScript strict ESM; relative imports use `.js` extensions; import workspace packages only
  via `@judge-copilot/<name>` roots declared in `package.json`.
- Shared vocabularies live in `@judge-copilot/schemas` as `*_VALUES` tuples + Zod enums; reuse
  them (including for DB CHECK constraints) instead of redefining values.
- Use the `Logger` from `@judge-copilot/shared`; `console` is lint-banned.
