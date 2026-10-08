# @judge-copilot/scoring — the deterministic scoring engine (`scoring-engine/v1`)

**Milestone:** M4 · **Layer:** 2 (deterministic core — pure TypeScript, **never** imports `llm`/`prompts`)

Specified in [`docs/SCORING.md`](../../docs/SCORING.md) (§12 policies, §13 formulas) and designed in
[`docs/milestones/M4-design.md`](../../docs/milestones/M4-design.md). Same inputs and engine version
always give a byte-identical report (invariant 9).

## What it does

dimension → criterion → overall weighted aggregation; rubric selection (official vs. fallback);
evidence strength; coverage (or the labeled citation-presence flag); the confidence index;
explicit insufficient-evidence states; canonical output with fingerprints and hashes.

## What it never does

- call a model, build a prompt, or touch the network, filesystem, clock, randomness or a database;
- invent a dimension score, a dimension mapping, a weight, an evidence item, an ID or a citation;
- persist or serve anything: no table, migration, route or UI. Persisting an assessment version is M5;
- let commit counts, lines of code, stars, keyword counts, dependency counts or AI-tool use affect a
  score (no function accepts them);
- verify that a cited item is **semantically relevant** to its dimension. It checks structure only.

## Entry points

```ts
const context = createTrustedScoringContext({
  projectId,
  eventId,
  graph,
  known, // one consistent snapshot: EvidenceGraphStore.loadGraph
  locked, // the locked Event Context snapshot (status, schema, event and hash re-verified)
  target, // { kind: 'overall' } | { kind: 'track', trackKey }
  declaredTrackKeys, // TRUSTED project facts, never an assessor payload
});
const result = scoreProject(context.context, judgments /* untrusted */, options /* explicit */);
```

Three inputs, three trust levels:

| Input       | Trust     | Content                                                                                      |
| ----------- | --------- | -------------------------------------------------------------------------------------------- |
| `context`   | trusted   | rubric, evidence graph and source facts, declared tracks; branded, frozen, factory-built     |
| `options`   | caller    | only the explicit request for the unofficial equal-weight preview                            |
| `judgments` | untrusted | a score or `insufficient_evidence` per dimension, plus citations classified from closed sets |

The factory copies and deep-freezes everything it consumes (the locked snapshot, the graph and the
source facts) _before_ validating and fingerprinting, and keeps the authoritative copy in module-private
state; the returned context carries no `graph` or `known` property, so mutating the objects you passed in
afterwards cannot change a report. The locked-snapshot checks are structural: they do not prove the
snapshot is authentic (that is the trusted database adapter's job, M5).

`judgments` is a strict schema: there is **no field** for attestations, verification levels, weights,
rubric content or track declarations, and unknown keys are an error. An object that did not come from
`createTrustedScoringContext` is refused. A trusted context is deliberately not constructible from
JSON, so a model response can never be one.

## Policies in one place

- **Official rubric wins, whole.** The fallback applies only when the locked context has no official
  `overall` rubric. Official and fallback criteria are never mixed. An invalid official rubric is
  rejected (`RUBRIC_INVALID`), never repaired, renormalized or replaced.
- **An official criterion is one atomic unit** (no sub-dimension mapping exists).
- **Unweighted official rubric:** per-criterion scores, **no official overall** (`not_computed`). An
  unofficial equal-weight preview exists only on explicit request and is reported outside `overall`.
- **Insufficient evidence is a state, never a zero.** Excluded units can move an aggregate either way.
- **Trust is re-derived from structure.** `repo_corroborated` is producer-asserted and gets its own lower
  factor; privileged labels (`machine_verified`, `judge_verified`, `live_verified`) resolve to
  `unverified`. Claim labels are never an input.
- **Exact arithmetic.** All quantities are exact rationals (BigInt); thresholds are compared exactly and
  each reported number is rounded once, exactly half-up, to four decimals. There is no epsilon.
- **Official scales must be safe:** finite, within ±1,000,000, `min < max`, range ≥ 0.01; otherwise
  `RUBRIC_INVALID`.
- **Strength = the maximum over provenance groups** (repetition adds nothing; a group is as strong as its weakest record, so a weaker citation that overlaps
  a stronger one **lowers** strength and confidence, by design); contradictions lower
  confidence, never the score; only recorded contradictions are counted, and the report says so.

## Provisional heuristics and their limits

All constants are **transparent V1 heuristics, not calibrated probabilities**; confidence is an index.
The fallback rubric's evidence needs are provisional, versioned heuristics. Dimensions whose needs only
the interview can satisfy (`qa_understanding`, `technical_ownership`) cannot reach full coverage before
M7, by design. Official criteria carry a citation-presence flag instead of coverage, and their
confidence is **not comparable** with fallback confidence.

## Tests

`pnpm test` runs, without network or database: exhaustive ladder tests, published-weight invariants,
provenance grouping, trust resolution, fail-closed validation, the worked numerical examples, 14
golden full-report fixtures in `golden/` (regenerate only with `UPDATE_GOLDEN=1`, then review the
diff), a cross-process determinism check, seeded metamorphic properties and the model-trust-boundary
and purity guards.
