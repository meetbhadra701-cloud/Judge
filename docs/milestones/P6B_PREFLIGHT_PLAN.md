# P6B — Engineering preflight and next-phase plan

Date: 2026-10-13. Status: **planning only. No code, schema, prompt, dependency or configuration was changed by this document.**
No provider was enabled, no model was called, nothing was merged, deployed or pushed to the accepted branch.

Everything below was read from the source tree and the milestone documents at the accepted SHA. Where a statement is a
proposal rather than a fact about the code, it says so. Where this document asks for an owner decision, it does not assume one.

## 1. Accepted P6A baseline

| Item                       | Value                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted commit            | `43673782132ede84a04ab4ab0f365887937d19ee` (P6A-R2 report commit; code commit `afbf7be`)                                                                                              |
| Branch                     | `claude/m5-pre-interview-assessment`                                                                                                                                                  |
| Remote check (this task)   | `git ls-remote origin refs/heads/claude/m5-pre-interview-assessment` returned exactly the SHA above. `main` is still `9459c98` (M4 merge).                                            |
| Working tree for this plan | Session branch `claude/peaceful-hawking-iiglri`, reset to the accepted SHA before this document was added. The accepted commit and its branch are untouched (no force-push).          |
| Independent review         | R6C: no unresolved P0/P1/P2 within the P6A gate; 2,803 PGlite tests, 3,533 PostgreSQL 16 ICU tests, 157/157 persisted assessments verified, 20/20 mutants killed, attacks A–E blocked |
| Gates not re-run here      | This task changes documentation only. The test numbers above are R6C's, not a new measurement.                                                                                        |

What the baseline is and is not:

- It is an **offline** assessment pipeline: capture snapshots → claims/evidence → dimension assessment → critic → deterministic M4 scoring → verified read
  model → API → one web page, driven by a replay provider whose fixture is hand-written.
- It is **not** a live-model system. No Anthropic adapter, SDK dependency, API-key handling or live provider mode exists in the repository
  (`ASSESSMENT_PROVIDER` accepts only `none` and `replay`; `assertProviderAllowed('live')` returns without checks only because nothing can construct a live provider).
- `docs/milestones/P6A_R2_REMEDIATION_REPORT.md` §7 and R6C record the remaining trust limits (free text and raw scores are not hash-covered; hashes sit with the data).
  A pass of R6C does not authorize production deployment or live-model execution, and this plan keeps that boundary.

## 2. R6C deferred findings ledger

This continues the numbering of the R1 ledger (`P6A_R1_REMEDIATION_REPORT.md` §3, D1–D11). Those entries stay open as written; D7/D8 are cross-referenced below.
All four R6C findings are P3 and none changes a score, a verification outcome or a stored hash. They are **not** to be turned into a redesign.

| Id  | R6C finding                                                                                                                                                                                                                                                                                                                                                                                                   | Risk if left                                                                                                                                                                   | Scope of the fix                                                                                                                                                                                                                      | Gate                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| D12 | **UI precision notice is wrong.** The page note says scores are "shown at the report's precision (four decimals, rounded once)", but `formatScore10` in `apps/web/lib/assessment-view.ts` is `value.toFixed(1)`: the page shows `7.3 / 10`, and a second, binary rounding is applied (7.05 → `7.0`, 8.45 → `8.4`). The API does return four decimals. The one-decimal display predates R2 (commit `c5d5bb3`). | A copy claim the page does not honour, and a displayed digit that can differ from the half-up decimal rule the engine uses. Advisory page; no effect on stored or API numbers. | Smallest fix: make the note truthful (state one decimal on this page and that the API carries four) **and** replace `toFixed(1)` with a decimal-string half-up formatter, or show four decimals. Pick one in the implementation plan. | α (first slice)                                                    |
| D13 | **`no_usable_citation` shows a contradictory `scored` tag.** The dimension reads "Insufficient evidence … no number is given" next to a `scored` disposition tag (API `disposition: scored`, attribution `insufficient_by_code`).                                                                                                                                                                             | Confusing label on a shape the worker pipeline cannot currently produce (the extractor emits only `fact` and `claim`), so latent.                                              | UI/view-model only: do not render the raw disposition tag for a dimension whose report state is insufficient; render the attribution label alone. No API shape change.                                                                | α                                                                  |
| D14 | **The raw score of a `no_usable_citation` dimension is not authenticated.** The verifier only requires a finite number; editing 7.33333 to 0, 2, 10 or −5 still verifies. No score is exposed (the API shows `null`), and the hash-covered report diagnostic states the judged value. In-bucket edits of any raw score are likewise invisible (documented equivalence).                                       | No user-visible effect today. It becomes relevant if anything ever reads row scores, or when a writer other than the pipeline exists.                                          | Do **not** patch the verifier. Close it with D7's row digest (below), which should cover raw score, disposition, rationale and notes. Until then keep it documented in the limitations list.                                          | β (with D7), before a live provider or any multi-writer deployment |
| D15 | **A permanent pure-verifier regression test is missing** for a `no_usable_citation` row whose disposition is not `scored`. R6C mutant Z9 (drop that check) survived the author's suite and was killed only by a scratch test, because the DB CHECK `disposition_matches_outcome` masks the state in every DB-backed test.                                                                                     | A future refactor could delete the verifier's own disposition check without any test failing, leaving the DB CHECK as the only defence.                                        | Add the scratch test's intent to `packages/assessment/src/verify-judgments.test.ts` (see below). No production code change.                                                                                                           | α1 (first commit of the first slice)                               |

**D15 — regression intent to preserve (from the R6C scratch test).** The permanent test must call `verifyJudgmentsAgainstReport` directly, with no database, so
the CHECK constraint cannot mask the case:

1. Report dimension `{ state: 'insufficient_evidence', reason: 'no_usable_citation', citedEvidenceIds: [E1] }`.
2. Row `{ outcomeKind: 'scored', score: 7.33333, disposition: 'assessor_reported_insufficient', citationEvidenceIds: [E1] }` must return
   `{ ok: false, mismatch: 'disposition' }`.
3. Companions the existing file already has (null score, NaN, insufficient outcome, citation mismatch) stay; add the same shape for every non-`scored` disposition in
   `UNIT_DISPOSITION_VALUES`, so the check cannot be narrowed to one value.
4. Mutation proof recorded in the slice report: remove the branch's disposition check → at least this test fails; restore.

The scratch file itself (`verify-nuc-disposition.r6c.test.ts` in the reviewer's session scratchpad) is not committed; the plan carries its intent, not its file.

**Related open entries that this plan schedules** (full text in the R1 report): D1 (F-2), D2 (F-3), D3 (F-4), D4 (F-8), D7 (free-text/row digest), D8 (hashes with the data),
D9 (withheld-assessment UX dead end), D10 (no permanent real-browser test). D5 (F-11) and D6 (F-12) stay deferred under an explicit condition: **one worker host** until they are fixed.

## 3. Product-flow implementation matrix

Classification vocabulary, as requested: **Complete and tested** · **Implemented but not integrated into the UI** · **Partially implemented** · **Not implemented** · **Blocked by a design or safety decision**.
Each row was classified from source files, the migrations list and the routes, not from milestone names.

### Step A — Hackathon context

| Capability                                                                                                                                                                     | Classification                                           | Evidence in the tree                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an event, a draft Event Context version, add pasted/URL/document text as authority-ranked sources, lock, supersede                                                      | Complete and tested                                      | `apps/api/src/event-context/routes.ts` (POST events, context-versions, sources, lock), M1 report, web pages under `apps/web/app/events/`                                                                                  |
| Structured fields: dates, judging format, rules, submission requirements, prior-work policy, organizer guidance, tracks, rubrics with criteria, weights and anchors, conflicts | Complete and tested (API, schema, DB)                    | `EventContextDocumentInput` in `packages/schemas/src/event-context.ts`; weights validated, unweighted rubrics stay unweighted, `unclear` is never guessed (M1, M4)                                                        |
| Entering those fields through the UI                                                                                                                                           | Partially implemented                                    | The editor is a **raw JSON textarea** (`events/[eventId]/versions/[versionId]/edit/edit-form.tsx`). It works and is validated, but there are no per-criterion form fields                                                 |
| Turning pasted official text into a structured draft                                                                                                                           | Partially implemented / **blocked by a safety decision** | The port and a deterministic **replay** extractor exist; `apps/api/src/main.ts` wires only the replay extractor (dev recordings). There is no model-backed Event Context extractor, and none was designed in M5           |
| Prizes                                                                                                                                                                         | Not implemented as a structure                           | No `prize` field. Prize text can live in a track description or a free-text rule                                                                                                                                          |
| Allowed / prohibited technologies, restrictions                                                                                                                                | Partially implemented                                    | Representable only as `rules` / `submissionRequirements` statements. They reach the assessor as reference evidence when they are explicit and applicable; nothing enforces them (and invariant 6 forbids keyword scoring) |
| Special sponsor criteria                                                                                                                                                       | **Blocked by a design decision (M5 D9)**                 | A track-scoped rubric can be stored and locked, but the assessment target is `overall` only; official track rubrics are listed as `official_track_rubrics_not_assessed` and not scored (`M5-design.md` §5.1, D9)          |
| "Evaluate against the actual applicable event context"                                                                                                                         | Partially implemented                                    | An official overall rubric is used whole or not at all; explicit rules, requirements and declared tracks become reference evidence. A context with **no** such items cannot be assessed at all (F-3, below)               |

### Step B — Project submission

| Capability                                                                                               | Classification                                 | Evidence                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a project in an event, declare sources by type + URL, request captures, view snapshots            | Complete and tested                            | `apps/api/src/projects/routes.ts`; pages `events/[eventId]/page.tsx` and `projects/[projectId]/page.tsx`                                                                                                      |
| **Two fields (GitHub URL, Devpost URL) and one "analyze" action**                                        | **Not implemented**                            | Today it is: create project (name, team, tracks) → add one source at a time (type + URL) → request capture per source (or all) → open the assessment page → run. Every piece exists; the composition does not |
| Capture: GitHub read-only REST at a pinned commit SHA, Devpost page parse, deployment and video metadata | Complete and tested **on fixtures only**       | Worker capture loop with the SSRF-safe client; fixture network. The M2 report states the optional live adapter smoke test was never run, so behaviour against real github.com / devpost.com is unmeasured     |
| Request an assessment (idempotent, project-scoped, advisory)                                             | Complete and tested, **offline provider only** | `POST /projects/:id/assessments` returns `503 ASSESSMENT_PROVIDER_NOT_CONFIGURED` unless `ASSESSMENT_PROVIDER=replay` and a valid synthetic fixture load                                                      |
| Real user identity                                                                                       | **Blocked by a deployment decision**           | Auth is delivered (JWT/JWKS verifier, roles), but the web app forwards one server-side token (`JUDGE_API_TOKEN`) and has no login UI; dev auth is loopback-only                                               |

### Step C — Preliminary report

| Capability                                                                                                  | Classification                                    | Evidence                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction → evidence graph → dimension judgments → critic → M4 scoring → immutable `pre_interview` version | Complete and tested **offline** (replay/scripted) | M5 P1–P6A reports; design §4; `apps/worker/src/assessment/`. **Never run with a real model**                                                                                                                                                                                                                |
| Rubric-aligned scores where justified, insufficient evidence stated as a state                              | Complete and tested                               | M4 engine; read model re-verifies hash, schema, output hash and every judgment row against the report on each read                                                                                                                                                                                          |
| Evidence-backed explanations                                                                                | Complete and tested                               | Citations with excerpt and evidence links per dimension. Rationale/notes are stored text that no hash covers (D7), and the page says so                                                                                                                                                                     |
| Strengths and weaknesses                                                                                    | Partially implemented                             | Each dimension has one `rationale` (≤1,200 chars) and closed-vocabulary limitation codes. There is **no strengths/weaknesses structure**; adding one to the assessor output would change frozen prompts (prompt v3). A deterministic presentation over existing scores is possible without any model change |
| Uncertainties and missing information                                                                       | Partially implemented                             | Limitations, `not assessed` criteria, insufficient states, and code-authored `missing` unknowns (stored in the evidence graph, viewable on the evidence page). The assessment page does **not** list the project's unknowns, and nothing ranks them (that is M6)                                            |
| Clear assessment limitations                                                                                | Complete and tested                               | "What this does not establish", advisory banner, replay banner, `relevance not verified` per dimension                                                                                                                                                                                                      |
| Track / sponsor rubric results                                                                              | Blocked by D9                                     | See Step A                                                                                                                                                                                                                                                                                                  |

### Step D — Five intelligent questions (V1 milestone M6)

| Capability                                         | Classification      | Evidence                                                                                                                                                                 |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Uncertainty analysis, candidate questions, ranking | **Not implemented** | `packages/uncertainty` and `packages/questions` contain only a README and are intentionally not workspace packages. The only existing artefact is `QUESTION_MODE_VALUES` |
| Five questions, each with its own answer box       | **Not implemented** | No route, table, page or schema                                                                                                                                          |

### Step E — Answers, reassessment and final report (V1 milestones M7, M8, M9)

| Capability                                                  | Classification                        | Evidence                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answer capture and storage                                  | **Not implemented**                   | No answer table. `team_answer` and `judge_observation` exist as evidence-origin and scoring-channel vocabulary, but "cannot be created until M7" (V1 contract, M3 refinements)                    |
| Answer decomposition into claims/evidence (model task)      | Not implemented                       | Listed as a semantic LLM task in `ARCHITECTURE.md` §3                                                                                                                                             |
| Reassessment of affected dimensions only                    | Not implemented                       | `mode: 'reassess'` exists, but it re-runs the **whole** pre-interview pipeline for new material and produces another `pre_interview` version. It is not answer-driven and not dimension-selective |
| `post_interview` version, `ScoreChange` deltas with "why"   | Not implemented (vocabulary only)     | `ASSESSMENT_KIND_VALUES` includes `post_interview`; no delta structure or code exists                                                                                                             |
| Remaining unverified claims and limitations in a final view | Partially implemented (pre-interview) | Claims and verification levels are stored; no final-report view                                                                                                                                   |
| Human final judgment (authoritative)                        | Not implemented (V1 M9)               | The advisory banner states the principle; there is no final-score table, route or UI                                                                                                              |

**Reading of the matrix.** Steps A–C exist as parts but do not yet form a journey a person can complete: the submit flow is
missing, the preliminary report lacks two presentation elements, and a real model has never run. Steps D–E are the V1 milestones **M6–M9** and have no code.

**Scope tension to settle before anyone writes code.** The requested Step E ("once five responses are submitted, reassess and show what changed") spans V1 milestones
M7 (answer capture), M8 (reassessment and deltas) and M9. `docs/V1_CONTRACT.md` forbids starting milestone N+1 before N is accepted and forbids borrowing later
functionality. Hence the plan below completes M5 first (P6B → P7 → M5 acceptance) and only then proceeds M6 → M7 → M8 → M9. This ordering is a consequence of the contract the owner set, not a technical need; changing it is an owner decision (DG-9).

## 4. Existing reusable modules

| Area                | What exists and is reusable                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vocabularies        | `packages/schemas`: `*_VALUES` + Zod enums including `QUESTION_MODE_VALUES`, `ASSESSMENT_KIND_VALUES`, `EVIDENCE_ORIGIN_VALUES` (`team_answer`, `judge_observation`), `VERIFICATION_LEVEL_VALUES`; assessment output/limit schemas; API schemas (`assessment-api.ts`)                                                                                  |
| Event Context       | `packages/context` (document model, authority precedence, conflict resolution, fingerprints, replay extractor), API service with lock/supersede/build, `EventContextExtractor` port                                                                                                                                                                    |
| Ingestion           | `packages/{safe-http,capture,github,devpost,deployment,video}`; worker capture loop + queue; `analysis_runs`; immutable `source_snapshots` + artifacts                                                                                                                                                                                                 |
| Evidence graph      | `packages/evidence`, M3 store (`createGraph`, `createGraphInTransaction`), read-only graph API; tables `claims`, `evidence_items`, `evidence_relations`, `unknowns`, `contradictions`                                                                                                                                                                  |
| Scoring             | `packages/scoring`: deterministic engine, trust re-derivation, canonical rounding (`roundReported`), report hash; channels `team_answer` and `judge_observation` already exist in the trust model                                                                                                                                                      |
| Assessment core     | `packages/assessment` (windowing, quote locator, G1–G7 gates, pre-gates, critic policy, failure matrix, report/judgment verifier, shared pipeline config builder), `packages/prompts` (frozen P2 prompt versions), `packages/llm` (provider port, digest, budget reserve/settle, retry, timeout, replay and scripted providers, failure normalization) |
| Assessment storage  | Migrations 0010–0014; tables `assessment_requests`, `assessment_run_inputs`, `assessment_run_input_snapshots`, `assessment_run_budget`, `assessment_run_calls`, `assessment_run_outcomes`, `assessment_run_extractions`, `graph_extractions`(+items), `pre_interview_assessments`, `assessment_dimension_judgments`, `assessment_judgment_citations`   |
| Runtime             | Worker loop with `SKIP LOCKED` claim, lease/heartbeat, recovery, pending expiry; `AssessmentReadStore` (fail-closed, report-derived numbers); preflight call/cost estimate; idempotent request store                                                                                                                                                   |
| API and UI          | Assessment routes (4 handlers, 405s elsewhere), runtime gate, evidence-graph read routes; `apps/web` pages for events, versions, projects, snapshots, evidence, assessment (`page.tsx` fetch + `view.tsx` presentation with component tests)                                                                                                           |
| Test infrastructure | PGlite + PostgreSQL 16 ICU dual-target suites, `apps/worker/src/testing/assessment-world.ts`, replay fixtures, `corrupt.ts` (test-only), milestone-scope and dependency-rule tests                                                                                                                                                                     |

Not reusable yet (do not assume): `packages/questions`, `packages/uncertainty`, `packages/browser` (README only); any live provider; any answer or delta storage.

## 5. Exact live-model blockers

The finding numbers are the R5 identifiers used in `M5-P6A-decisions.md` and the R1 ledger (not the unit-test labels F-1…F-8 in `M5-design.md` §6).
**Offline replay passing does not resolve any of these.** Replay returns recorded answers; it cannot show how a real model behaves under the paths below.

### F-2 — model-declared insufficiency is never reviewed (D1)

**Definition (verified against `M5-P6A-decisions.md` and `pipeline.f2-characterization.test.ts`).** The critic reviews only judgments whose disposition is `scored`.
A dimension the assessor itself declares `insufficient_evidence` (`assessor_reported_insufficient`) is never challenged and M4 excludes it, renormalizing the rest.
With weights 0.4/0.3/0.3, nine-nine-"insufficient" reports `scored_partial` 9.0, while nine-nine-two reports `scored` 6.9. A mistaken or injected "insufficient" can only **raise** the number, by at most 40 % of the weight.

**Decision still open.** Options A (mandatory critic review; needs critic prompt v2 and the F-4 feedback channel; config-hash bump), B (code-authored limitation, no prompt change), C (leave).
The decisions file recommends **B now, A together with prompt v3**.

**Required before any real-model assessment:** B shipped; A either shipped or its absence accepted by the owner in writing as a residual risk for a named pilot.

**Acceptance criteria (testable):**

1. 9/9/model-declared-insufficient yields `scored_partial` 9.0 **and** limitation `partial_score_excludes_model_declared_insufficient` with `subjects` = the dimension ids; the number is byte-identical to today (M4 goldens unchanged).
2. The same shape where the dimension was pre-gated by **code** yields no such limitation; a fully scored run yields none.
3. `git diff` against the accepted SHA shows no change under `packages/scoring`; golden report hashes unchanged.
4. The page renders the attribution sentence for case 1 and not for case 2, inside the overall-number block (component test).
5. Limitation `subjects` contain code-assigned handles only; a hostile rationale cannot appear in them (fuzz test).
6. (If A is approved) a contested insufficiency triggers exactly one assessor re-run within the existing cap; an uncontested one triggers none; a critic that fails technically never converts an insufficiency into a score; the preflight counts the extra calls and refuses a run that would exceed `maxCalls` before any call.

### F-3 — an Event Context with no reference evidence can never be assessed (D2)

**Definition.** `buildEventReferenceItems` yields items only from declared-track definitions and **explicit** rules/submission requirements. A locked context with a valid rubric but none of those yields zero items; the pipeline needs at least one record, so the run fails late with `domain_validation_failed` / `no_context_reference_evidence` after inputs were pinned. Nothing is fabricated, which must stay.

**Why it matters for the journey.** An organizer who enters only a rubric (Step A) gets an assessment failure at Step C.

**Decision still open.** Option 1 (authenticated empty `context_evidence` extraction, verified by recomputation; expected to need no change to existing triggers, to be confirmed by a spike), Option 2 (request-time `422`, no schema change), Option 3 (status quo, not recommended). The decisions file recommends Option 1 and names Option 2 as a safe interim.

**Required before real events are onboarded:** Option 2 at minimum (early, honest refusal); Option 1 before a rubric-only event must be assessable.

**Acceptance criteria (testable):**

1. Option 2: `POST` against such a context answers `422 ASSESSMENT_EVENT_CONTEXT_HAS_NO_REFERENCE_EVIDENCE` before any run, request, budget or ledger row exists; the response names the cause in organizer terms; replacing the context later makes the same route succeed with a new key.
2. Option 1: a rubric-only locked context assesses successfully; the stored context extraction has 0 members, no graph rows, and `recorded_limitations` carrying the exclusion summary; limitation `event_context_has_no_reference_evidence` is shown.
3. An `unclear`-only rule set produces the same empty extraction (ambiguity is never promoted to evidence).
4. Forgery: an empty extraction for a context that **does** have explicit rules, or pinned to another context version/hash, is rejected by the trusted reader (`reference_set_mismatch`).
5. Fallback `track_prize_alignment` units are `insufficient_evidence` with `no_official_requirement_available` and never scored.
6. The source-extraction path still refuses an empty batch; the deferred triggers still reject incomplete or mis-hashed non-empty membership on PGlite and PostgreSQL 16.
7. HTTP end to end (POST → worker → GET) on offline replay for such an event.
8. Any needed migration is a new additive one; `pnpm db:check` and `db:generate` stay clean.

### F-4 — a re-ask or re-run sends an identical request (D3)

**Definition.** Repair re-asks (`model-call.ts`) and critic-triggered assessor re-runs re-send a byte-identical request. Under replay the second answer equals the first, so "invalid, then valid" cannot be expressed offline; under a live model it is only a resample and reserved budget can be spent for nothing (R5 control: 9 calls for 5 distinct requests).

**Required before any paid live run:** the "prompt v3" revision (closed machine feedback channel), designed once together with F-2 Option A and any critic prompt v2, with an owner-approved cost estimate. No live call is needed to build or test it.

**Acceptance criteria (testable):**

1. A re-ask request differs in its digest from the original and carries only a code-authored block `feedback: [{ code, handle }]` drawn from a closed list of validator rejection codes; a fuzz test with hostile model and source prose shows none of it can reach that block.
2. A replay fixture can express "invalid first answer, corrected second answer" and the pipeline succeeds on it.
3. The preflight and ledger count distinct requests; the R5 control scenario no longer spends on identical resamples.
4. Frozen v1/v2 prompt templates, their hashes and goldens are byte-identical; v3 has new versions and a new pipeline config hash; runs created under the old hash remain verifiable.
5. Mutation proof: dropping the feedback block makes the digest equal again and a test fails.

### F-8 — a failed newer capture is invisible while an older one is pinned (D4)

**Definition (verified in `assessment-run-store.ts` ~L508–L529 and `apps/worker/src/assessment/sources.ts`).** A run pins the latest **content-bearing** (`captured` or `partial`) snapshot of each declared source. For a pinned source the reported capture status is the pinned snapshot's, so if a newer attempt then failed or was rejected, neither the assessment nor the page says so; only sources with no usable snapshot report `failed`/`rejected`/`pending`. The judge is not told that the newest attempt failed.

**Decision still open.** The P6A report says it needs a source-status policy ("Unknown vs limitation"). This plan **proposes** (not decided): a deterministic, code-authored limitation recorded with the assessment (`newer_capture_unusable`, subject = source handle) for what is known at request time, **plus** a read-time freshness notice computed by the read model for attempts made after the assessment exists. Reason for limitation over Unknown: an Unknown is an evidence-graph entity tied to an immutable extraction and cannot be added after the fact.

**Required before any real submission is judged.**

**Acceptance criteria (testable):**

1. Source captured (#1), then capture #2 `failed`: the assessment still pins #1, the score is unchanged, and the limitation names the source and the failed newer attempt; no number is lowered (missing is not negative).
2. A newer `captured` snapshot after the assessment produces the existing "newer material exists" path, not a failure notice.
3. A source whose only attempt failed keeps today's behaviour (`failed` status, code-authored missing unknown).
4. The read-time notice appears on the page and API for a failed attempt made after the assessment, is derived from current rows by code, is never hash-covered text, and cannot be forged by assessment rows.
5. Cross-project isolation: another project's capture failure never appears.
6. Mutation proofs: drop the limitation; drop the read-time check.

### Further gates that apply before a live provider (from the R1 ledger)

| Gate                            | Why                                                                                                         | Acceptance criterion                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D7 (+ D14) row digest           | Rationale, notes, limitation codes, disposition and (via D14) raw scores are unauthenticated                | One additive migration adds a digest over the judgment rows, bound into the hash chain or verified at read time; tampering any covered field is withheld with a stable code; legacy rows (no digest) read as `legacy_unverified_text` and are labelled, never silently trusted; PGlite + PG16 |
| Provider adapter                | None exists                                                                                                 | Adapter contract-tested against an injected fake `fetch`/recorded HTTP fixtures only; error-mapping table; no key in repo, logs or prompts; SDK dependency added only with explicit owner authorization                                                                                       |
| Live gate                       | `assertProviderAllowed('live')` currently allows `live` unconditionally                                     | Live mode requires explicit configuration **and** an explicit approval flag; default stays off in every environment; refused-by-default test; no code path reaches a network model from a request handler                                                                                     |
| Price table                     | `prices/v1` is "NOT verified against the provider and not a quote"                                          | `prices/v2` dated and verified by the owner; the preflight shows the estimate before a run; per-run cost cap enforced by the existing budget guard                                                                                                                                            |
| Human confirmation of paid runs | A button must not silently spend money                                                                      | Each paid run requires an explicit confirmation showing the preflight estimate; tested                                                                                                                                                                                                        |
| Live behaviour is unmeasured    | Injection resistance, schema-conformance rate, quote fidelity and cost are known only for scripted fixtures | A written first-measurement protocol (tiny synthetic project, hard cap, human review of every output) before any real submission                                                                                                                                                              |
| D5/D6, single worker            | F-11 lease check and F-12 clock cut-off                                                                     | The live pilot runs one worker host, recorded as a condition; fixed before a second host                                                                                                                                                                                                      |

## 6. Proposed P6B scope

### Recommendation in one paragraph

Do **not** make P6B one large milestone. Split it by dependency on owner decisions and on live-provider authorization, keeping every part inside the existing M5 envelope:

- **P6B-α (recommended first slice): close the R6C P3s and make Steps B–C a journey a person can complete offline.** It needs no live provider and no open design decision except one scope confirmation and one presentation rule.
- **P6B-β: pre-live safety gates** (F-3, F-2 B, F-8, D7/D14). Needs owner decisions DG-1…DG-3 and a migration approval.
- **P6B-γ: live-provider enablement path, ending before any live call** (prompt v3 incl. F-4 and F-2 A, adapter with fake-fetch contract tests, price table, live gate). Needs DG-4 and explicit authorization. A first live measurement is a separate, later authorization.

Then P7 (hostile self-review, injection suite, golden assessment, `M5-report.md`), independent review, M5 acceptance; then M6 → M9.

### P6B-α — scope

| Id  | Item                                                                                                                                                                                                                                                                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| α1  | R6C P3 closure: D15 permanent verifier test; D13 UI tag; D12 truthful note and decimal-string rounding (or four-decimal display)                                                                                                                                                                                                                                                                                  | View-model and test changes only. No API shape, scoring, hash or migration change.                                                                                                                                                                                                                                                                                          |
| α2  | **Submit page (Step B):** pick an event that has a locked Event Context; two URL fields (GitHub, Devpost); one "Start analysis" action that, through the **existing** API routes, creates the project, declares the two sources, and requests their captures; then shows capture status. Display name derived deterministically from the URLs (repo path / Devpost slug), labelled as derived. Optional override. | No new API route (the four-handler assessment guard and the route-scope tests stay valid). Validation uses the existing URL policy; a wrong host for a field is refused with a plain message. Does **not** auto-start the assessment: running it stays an explicit second action, which is also where a paid-run confirmation will later attach.                            |
| α3  | **Preliminary report additions (Step C):** (a) a consolidated "Unknowns and missing information" section from the stored limitations, the not-assessed criteria, the insufficient dimensions and the project's unknowns (read via the existing evidence-graph route); (b) a "relative strengths and weaknesses" block, deterministic, from the verified report.                                                   | (b) must not invent a threshold: show the highest- and lowest-scoring **assessed** dimensions relative to this project's other dimensions, each with its cited evidence and its confidence, labelled as relative, never as "good"/"bad". **This is a presentation of existing data, not M6 uncertainty analysis:** no ranking by impact, no information gain, no questions. |
| α4  | Withheld-assessment guidance (D9): for an unverifiable assessment, tell the organizer what to do without leaking content (stable failure code → guidance sentence).                                                                                                                                                                                                                                               | Small; the failure code is already in the API.                                                                                                                                                                                                                                                                                                                              |
| α5  | Demonstration runbook: start API + worker + web together with a matching replay fixture; a check that the fixture covers exactly the models the API freezes into a run (P6A prerequisites 5–6).                                                                                                                                                                                                                   | Documentation plus, at most, a script. No new product behaviour.                                                                                                                                                                                                                                                                                                            |
| α6  | One permanent real-browser smoke of the journey (D10) — **optional**, needs approval to add Playwright as a dev dependency. Recommended because α is the first slice that spans several pages.                                                                                                                                                                                                                    | If declined, component tests plus the recorded manual run are the evidence, and D10 stays open.                                                                                                                                                                                                                                                                             |

**Explicit non-scope of α:** any model call or provider change; F-2/F-3/F-4/F-8 fixes; migrations; changes to `packages/scoring`, frozen prompts or the report hash; track rubrics; questions, answers, reassessment; accounts or login; a structured Event Context form editor (the JSON editor stays); model-backed Event Context extraction.

### Work that can proceed without live models

All of α; all of β (offline replay and scripted tests suffice); the adapter's **code and fake-fetch contract tests**, prompt v3 and its replay fixtures, and the live gate (γ) — none of these calls a model. The M6 deterministic parts (uncertainty analysis, information-gain ranking, question validation) can also be built and tested offline later.

### Work that needs live-provider authorization

Adding the SDK dependency (authorization requested in γ); any credential; verifying `prices/v2` against the provider; the first-measurement run and every real assessment; model-phrased questions in M6 (replay for tests, live for use); model-backed answer decomposition in M8; any model-backed Event Context extractor. **None is authorized by this document.**

## 7. Dependencies and implementation order

```
R6C accepted (done)
   │
   ├─► P6B-α  (no owner decision except DG-0, DG-5)  ──► independent review R7A
   │      α1 → α2 → α3 → α4 → α5 → (α6)
   │
   ├─► P6B-β  (needs DG-1, DG-2, DG-3, DG-7 migration approval) ──► independent review R7B
   │      F-3 (Option 2, then Option 1 after the schema spike) → F-2 B → F-8 → D7/D14 digest
   │
   └─► P6B-γ  (needs DG-4 + explicit authorization; ends BEFORE any live call) ──► independent review R7C
          prompt v3 (F-4, F-2 A, critic v2) → adapter + fake-fetch contract tests → price table v2 → live gate + paid-run confirmation
   │
   ▼
P7: hostile self-review, injection suite, golden assessment, M5-report.md ──► independent review ──► M5 accepted
   │
   ▼
(live first-measurement: separate, explicit authorization and its own report)
   │
   ▼
M6 uncertainty + five questions ─► M7 answers/interview ─► M8 reassessment + deltas ─► M9 human final judgment
```

Ordering rules:

1. α1 first: it is a pure test/view change, makes the permanent suite catch Z9, and gives the slice a clean start.
2. α can run in parallel with β's **decisions** (not its code), because α touches web view-models and the project/assessment pages while β touches the run store, reader and migration.
3. β before γ: the live path must not be built on top of an unresolved F-3/F-2/F-8 or an unauthenticated judgment row.
4. γ before P7: P7's hostile review and golden assessment need the final prompt versions and config hash.
5. The M6–M9 sequence is the V1 contract's order. Each needs its own design note and owner approval; the decisions DG-8…DG-9 below should be settled in M6's design, not now.

## 8. Required tests and independent-review criteria

### Common to every slice (project rules)

`pnpm check` (format, lint, typecheck, `db:check`, tests, build) with exact results reported; `pnpm db:generate` reports no pending changes unless a migration is approved; full suite on PGlite **and** PostgreSQL 16 ICU; `git diff --check`; no secrets; no external network in tests; layer-2 packages never import `llm` or `prompts`; no edit to an existing migration; no change to `packages/scoring` or its goldens unless the slice says so; milestone-scope tests updated narrowly and explained.

### P6B-α

| Area       | Required tests                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D15        | Pure verifier test above; mutation proof (Z9-equivalent) recorded                                                                                                                                                                                                                                                                                                                                                                                          |
| D13        | Component test: a `no_usable_citation` dimension renders no `scored` tag and keeps the attribution label; no number appears                                                                                                                                                                                                                                                                                                                                |
| D12        | Table test of the formatter against an independent decimal oracle (7.05, 8.45, 2.675, 9.99995, 0.00005, negatives if the scale allows); the note text asserts only what the page does; browser/DOM check of the rendered digits                                                                                                                                                                                                                            |
| α2         | Action tests with a fake API: wrong host per field refused; duplicate submission with the same URLs does not create two projects without a visible choice; only events with a locked context selectable; derived name rules (length, characters) pinned; no URL fetched by the web tier; hostile URL strings (userinfo, `javascript:`, huge, unicode) rejected by the existing policy; SSRF paths remain the capture layer's job and are not reimplemented |
| α3         | Component tests with the three verified shapes (scored, partial, insufficient); relative strengths/weaknesses are stable for ties and never shown for fewer than two assessed dimensions; text from the project is rendered as inert text only; an unverified assessment shows none of it                                                                                                                                                                  |
| α4         | Every failure code maps to a guidance sentence; the mapping is exhaustive (type-checked)                                                                                                                                                                                                                                                                                                                                                                   |
| Regression | R6A/R6B/R6C attack suites re-run unchanged; the 157-assessment persist sweep still all-verified; queue, ledger and auth suites untouched                                                                                                                                                                                                                                                                                                                   |
| Mutations  | One mutant per behaviour above, each killed, with runner invocations that actually match the target files (R6C found a bracketed-path filter silently matching nothing; the plan requires each mutation run to print the count of test files executed)                                                                                                                                                                                                     |
| Browser    | One recorded real-browser run of event → submit → capture status → assessment (replay) with screenshots; permanent Playwright smoke if α6 is approved                                                                                                                                                                                                                                                                                                      |

**R7A independent-review criteria.** No unresolved P0/P1/P2 within the α gate; the D12–D15 fixes verified by an independent oracle and an independent mutation set; the submit flow cannot create state outside existing routes' guarantees (auth, project scoping, idempotency); no new way for project-derived text to reach HTML; no model call; no change to scoring, hashes, migrations or prompts; α's report states exactly what was run and what was not.

### P6B-β (outline; the implementation plan will expand it)

The acceptance criteria in §5 for F-3, F-2 B, F-8 and D7/D14, plus: legacy-data read matrix (assessments created before the change still read correctly and are labelled where unauthenticated), and a migration test on PGlite and PG16 that proves the new constraint without editing an old migration.

### P6B-γ (outline)

§5 criteria for F-4, F-2 A and the further gates; adapter error-mapping table test; proof by source scan that no request handler or web code can reach the adapter; proof that `live` is refused unless explicitly approved; golden prompt hashes for v3 with v1/v2 unchanged.

## 9. Remaining risks and non-goals

### Owner decisions required (none is assumed)

| Id    | Decision                                                                                                                               | Needed before                          | Recommendation                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| DG-0  | Confirm the α submit/report work is inside M5 P6 (UI composition of existing M2/M5 routes), not a new milestone                        | α2                                     | Yes; it adds no route, table or model task                                                     |
| DG-1  | F-3: Option 2 now and Option 1 after a schema spike, or Option 1 directly                                                              | β                                      | Option 2 first (as the decisions file allows), then Option 1                                   |
| DG-2  | F-2: B now; A with prompt v3                                                                                                           | β                                      | As in the decisions file                                                                       |
| DG-3  | F-8: limitation + read-time freshness notice (proposed here) vs Unknown                                                                | β                                      | Limitation + notice                                                                            |
| DG-4  | Prompt v3 bundle; live-provider path; SDK dependency; verified price table; budget and first-measurement authorization                 | γ                                      | Approve building (no calls) first; authorize any call separately                               |
| DG-5  | Step C strengths/weaknesses as relative highest/lowest assessed dimensions, no thresholds                                              | α3                                     | Approve                                                                                        |
| DG-6  | Step A: is model-backed Event Context extraction in V1? If not, organizers author via the (improved) editor                            | before promising Step A to users       | Out of M5; decide in a later design note                                                       |
| DG-7  | Migration approval for the D7/D14 row digest                                                                                           | β                                      | Approve with legacy labelling                                                                  |
| DG-8  | Step D–E actor: V1 says the **judge** types the team's answers (M7). Team self-service answering needs team identity and is outside V1 | M6 design                              | Judge-transcribed, with an explicit "judge verified" mark per answer                           |
| DG-9  | Sequencing of M6–M9 relative to the requested single "final report" experience                                                         | M6 design                              | Keep the contract order; the five-question flow ships as M6 + M7 + M8 together at the UI level |
| DG-10 | Track/sponsor rubric assessment (reversing M5 D9)                                                                                      | before "sponsor criteria" are promised | Post-M5 milestone with its own review; until then the page keeps saying they are not assessed  |
| DG-11 | Real user login and hosting model (the web tier forwards one token today)                                                              | any non-local deployment               | Separate deployment milestone; not part of P6B                                                 |

### Risks

1. **Real models are unmeasured.** Injection resistance, schema-conformance rate, quote fidelity, cost and latency are known only for scripted fixtures. The M4 confidence index is explicitly uncalibrated.
2. **Real sources are unmeasured.** Capture was never smoke-tested against live github.com/devpost.com. Devpost parsing is HTML-structure dependent and may break or raise terms-of-use questions; GitHub rate limits apply without a token.
3. **F-3 makes the most obvious Step A input fail** (rubric only). Until DG-1 lands, onboarding a real event risks a confusing late failure.
4. **Authenticity limits.** Free text and raw scores are not hash-covered and hashes live with the data (D7/D8); acceptable for a single-owner pilot, not for a hosted multi-tenant service.
5. **Price table unverified**; the default per-run cost guard is $3 (hard maximum $10, `ASSESSMENT_RUN_LIMIT_DEFAULTS` / `_MAXIMA`) and must be re-checked against verified prices before any spend.
6. **UI breadth.** The web tier has component tests but no permanent browser test (D10); α6 mitigates.
7. **Single worker host** is a hidden precondition until F-11/F-12 are fixed.
8. **Answers are claims.** In Step E an answer is `team_claim` unless the judge verifies it; the final report must therefore be able to say "answered but unverified" and may legitimately move confidence more than score. Product expectations should be set accordingly.
9. **Scope pressure.** The five-step journey invites pulling M6–M8 forward; the contract forbids it, and α3(b) is deliberately a presentation, not uncertainty analysis.

### Non-goals of P6B

No live or paid model call, credential, or enabled live provider; no SDK dependency without DG-4; no M6–M9 functionality (questions, answers, deltas, final score); no change to the deterministic scoring engine, its goldens or the report hash; no track/sponsor rubric scoring; no model-backed Event Context extraction; no accounts, login UI or hosting work; no cross-project ranking or leaderboard; no execution of repository code; no video or deployment analysis beyond what M2 captures; no edit of any existing migration or accepted report.

## Verdict

**READY_FOR_P6B_IMPLEMENTATION_PLAN**

Basis: the recommended first slice, P6B-α, depends on no unresolved design gate except the scope confirmation DG-0 and the presentation rule DG-5, both small and answerable in the implementation plan; every live-model gate (F-2, F-3, F-4, F-8, D7/D14, adapter, prices) is defined above with testable acceptance criteria and is scheduled in β/γ rather than assumed solved. If the owner instead wants a real-model assessment before β and γ, the correct status is `BLOCKED_PENDING_DESIGN_DECISIONS`: DG-1…DG-4 and DG-7 must be decided first.
