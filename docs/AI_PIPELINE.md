# Judge Copilot — AI Pipeline

> **Status:** No model or provider calls exist (M0–M3; M2 source capture and the M3 evidence graph
> are deterministic). `packages/llm` (M5 phase P1) now holds the provider-neutral interface, request digest,
> retry/timeout, the local spending guard and the offline replay/scripted providers, with **no vendor adapter, no
> API key handling and no pipeline**; `packages/prompts` (M5 phase P2) holds the nine frozen prompt templates and the pure renderer (trusted instructions separated from deterministically delimited untrusted data, code-assigned handles only), also with **no pipeline**; `packages/assessment` (M5 phase P3) is the pure trust boundary that validates every model output (gates G1–G7), plans the graph and builds the scorer input, with no orchestration. M3 implemented the deterministic half of stages 3–5 — trusted ID
> assignment, ID-integrity validation, provenance to snapshot spans, relation and verification
> rules, never an accusation — behind a validated write path (`EvidenceGraphStore.createGraph`);
> the model-backed producer that feeds it arrives in M5. M1 implemented stage 1's **port** (`EventContextExtractor`) and its
> full schema → domain validation path, exercised by a deterministic replay extractor. The first
> model-backed implementation arrives no earlier than M5 (see §11).

---

## 1. Stage map

| #   | Stage                                              | Model?                                                            | Deterministic responsibilities                                       |
| --- | -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Event Context extraction (port in M1; model later) | **yes** (future): structure official documents into a draft       | validate structure, weights sum, human review gate, lock and version |
| 2   | Source snapshot capture (M2)                       | no                                                                | URL policy, fetch limits, hashing, immutability, status              |
| 3   | Claim extraction (M3/M5)                           | **yes**: atomic claims from snapshots                             | ID assignment, provenance to snapshot spans, validation              |
| 4   | Evidence interpretation and claim matching (M3/M5) | **yes**                                                           | relation types, ID integrity, verification level rules               |
| 5   | Contradiction detection (M3/M5)                    | **yes**: proposes contradictions                                  | validates both sides exist; never escalates to an accusation         |
| 6   | Unknown identification (M5/M6)                     | partially: semantic gaps                                          | coverage analysis, unknown typing rules                              |
| 7   | Dimension assessment (M5)                          | **yes**: judges one dimension against anchors, cites evidence IDs | validation, then aggregation into criteria and overall               |
| 8   | Scoring (M4)                                       | **no**                                                            | weights, evidence strength, coverage, confidence, aggregation        |
| 9   | Critic pass (M5)                                   | **yes**: reviews stage-7 output                                   | decides accept / re-run / mark insufficient by rule                  |
| 10  | Question generation (M6)                           | **yes**: phrases candidate questions                              | binds to IDs, validates, ranks by information gain, picks top five   |
| 11  | Team-answer decomposition (M7/M8)                  | **yes**: answers → claims/evidence                                | ID integrity, verification level from who verified what              |
| 12  | Affected-dimension selection (M8)                  | **no**                                                            | graph traversal from new evidence to dimensions                      |
| 13  | Reassessment of affected dimensions (M8)           | **yes**: stage 7 for selected dimensions only                     | validation, re-aggregation, deltas                                   |
| 14  | Delta explanation (M8)                             | **yes**: prose for computed deltas                                | deltas themselves are computed by code                               |
| 15  | Final score (M9)                                   | **no**                                                            | the human enters it; AI cannot write it                              |

The model never computes weights, aggregates, confidence, rankings or state transitions. See
[ARCHITECTURE.md §3](./ARCHITECTURE.md#3-deterministic-code-vs-llm-responsibilities).

## 2. Structured output only

- Every model call requests **structured output** that conforms to a Zod schema owned by the
  calling stage. Free-text output is only allowed inside schema fields designed for prose (for
  example a rationale string), never as the primary result.
- Outputs are parsed, never `eval`-ed, and never executed.

## 3. Two-step validation: schema, then domain

Every model output passes **both** steps before anything downstream sees it (invariant 19):

1. **Schema validation (Zod):** shape, types, enums, ranges (`Score10`, `Ratio`), string limits.
2. **Domain validation (deterministic code):**
   - every referenced ID exists in the current assessment context and has the right type
     (evidence ID is an evidence ID, dimension ID belongs to this rubric, …);
   - the model invented no evidence, claim, unknown, criterion, dimension or question IDs
     (invariant 20). Models refer to items **only** by IDs supplied in the prompt;
   - each dimension judgment cites at least one evidence ID, or explicitly reports
     insufficient evidence (invariants 2, 14);
   - a cited evidence item is actually relevant to that dimension, per the evidence graph;
   - post-interview changes only touch dimensions selected as affected (invariant 11);
   - no output asserts cheating or misconduct (invariant 25). Contradictions are phrased as
     questions for the judge.

Output that fails either step is rejected. The stage may retry within a bounded budget.
After that the run fails with `schema_validation_failed` or `domain_validation_failed` and
**produces no score**.

## 4. Evidence-ID integrity

- IDs are generated by deterministic code (UUIDs), never by models.
- The prompt shows the model a closed set of `{id, content}` items. The model's output
  references that set.
- Any reference outside the set fails domain validation. The output is not "repaired" by
  guessing.

## 5. Prompt versioning

- Prompts live in `packages/prompts` as versioned templates (for example
  `dimension-assessment/v3`).
- Every model-backed record stores the prompt ID and version, the model identifier, the
  provider, and the schema version used.
- Changing a prompt's wording is a new prompt version. Old outputs remain attributable to the
  exact prompt that produced them.
- Prompts keep **instructions** and **untrusted project data** strictly separate (see
  [SECURITY.md](./SECURITY.md#prompt-injection)).

## 6. Critic pass

After dimension assessment, a separate critic call reviews each judgment against its cited
evidence and anchors. It looks for unsupported claims, missing-evidence-treated-as-negative,
over-reliance on team claims, keyword/commit-count reasoning, and rubric drift. The critic's
output is itself schema- and domain-validated. Deterministic rules decide the result: accept,
re-run the dimension, or mark it insufficient. The critic never edits scores directly.

## 7. Team-answer decomposition

The judge types team answers and records live verifications. A model decomposes each answer
into atomic claims and evidence items:

- statements by the team → `team_claim` (still claims, invariant 4);
- things the judge watched work → `live_verified` / `judge_verified`, attributed to the judge's
  observation;
- each new item links to the question (and therefore the unknowns and dimensions) it
  addresses.

## 8. Affected-dimension-only reassessment

After the interview:

1. Code finds the dimensions reachable from the new evidence through the evidence graph
   (question → unknowns/claims → dimensions).
2. Only those dimensions are re-judged (stage 13). All others are carried over unchanged from
   the pre-interview version (invariant 11).
3. Code re-aggregates and creates a new immutable `post_interview` assessment version
   (invariant 10).
4. Code computes per-dimension deltas. Each `ScoreChange` lists the evidence IDs responsible
   (invariant 12). The model may then write a prose explanation of each computed delta.

## 9. Model/provider abstraction

- `packages/llm` exposes a provider-neutral interface: a structured-output call with a schema,
  timeout, retry budget and cancellation. Concrete providers are adapters behind it.
- Stage code depends on the interface, not on vendor SDKs.
- Provider credentials are read from server-side configuration only. They are never logged and
  never placed in prompts.
- Deterministic packages (`scoring`, `uncertainty`, `questions` ranking) **cannot** import
  `llm` or `prompts`. The layering test enforces this (ARCHITECTURE.md §6).

## 10. Failure semantics

A model or provider failure (timeout, rate limit, refusal, malformed output, validation
failure, outage) must **never** produce a fabricated score (invariant 22):

- no default, cached-from-another-project, averaged or "best guess" score is substituted;
- the analysis run ends `failed` with a `failure_category` (`provider_error`,
  `schema_validation_failed`, `domain_validation_failed`, `source_unavailable`, `timeout`,
  `internal_error`), already enforced by `analysis_runs` constraints;
- the judge sees that the assessment is unavailable and why, and can still judge manually;
- "insufficient evidence" is a **valid assessment outcome**, not a failure. It means the
  pipeline worked and honestly could not assess.

## 11. Event Context extraction port (implemented in M1)

`EventContextExtractor` (`@judge-copilot/context`) is the boundary for stage 1:

```ts
interface EventContextExtractor {
  readonly name: string;
  extract(input: { eventName: string; sources: ExtractorSource[] }): Promise<unknown>;
}
```

- The result is typed `unknown` on purpose. The build operation parses it with
  `EventContextExtraction` (Zod), which also **rejects any `id`** the extractor supplies and any
  attempt to resolve conflicts on a human's behalf (invariant 20). `documentFromExtraction` then
  domain-validates it: every cited source belongs to the version, no non-`unclear` fact lacks a
  source, rubric structure is sound, and conflicts are resolved by authority in code.
- Each build is an `analysis_runs` row (`run_type = event_context_build`). An extractor
  exception is recorded as `provider_error`, a shape failure as `schema_validation_failed`, and a
  semantic failure as `domain_validation_failed`. All of them leave the previous draft unchanged
  (invariant 22).
- No database transaction is held across an extractor call. The build fingerprints its inputs
  (source set and draft state) before calling the extractor and re-checks them under a row lock
  before writing. A result computed from stale input is discarded (`CONTEXT_BUILD_STALE`, run
  `cancelled`), never written over newer human work. A rebuild that would replace reviewed changes
  requires explicit confirmation (`replaceHumanEdits`); see ARCHITECTURE.md §9.
- Extractors only _propose_ facts and conflicting positions. Precedence, IDs, provenance
  bookkeeping, validation and locking are deterministic.
- **M1 ships no semantic extractor.** By default (`EVENT_CONTEXT_EXTRACTOR=none`) the build route
  returns `503 EXTRACTOR_NOT_CONFIGURED` and drafts are authored by hand. The **replay extractor**
  (`EVENT_CONTEXT_EXTRACTOR=replay`, refused when `NODE_ENV=production`) returns recorded
  extractions only when the sources exactly match a recording's (authority + SHA-256). It powers
  tests and local demos and performs no analysis of text.
- A future model-backed extractor implements the same port behind `packages/llm`, with a
  versioned prompt in `packages/prompts` that keeps instructions separate from untrusted source
  text.
