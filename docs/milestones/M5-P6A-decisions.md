# M5 P6A — design decisions awaiting owner approval

Status: **proposals only. Nothing in this document is implemented.** P6A stops here for F-2, F-3 and the prompt-v3 proposal; each
needs an explicit owner decision before any code changes. The only code that exists for them is the characterization test
`apps/worker/src/assessment/pipeline.f2-characterization.test.ts`, which pins today's behavior (it changes nothing).

Scope guard for all three: no change to `packages/scoring`, its goldens or the report hash; no change to frozen P2 prompt versions;
no provider, SDK, network model call, credential or paid activity.

---

## F-2 — model-declared insufficiency is never reviewed by the critic

### What happens today (verified, `pipeline.f2-characterization.test.ts`)

The critic (design §4.6 / `AI_PIPELINE.md` §6) reviews only judgments whose disposition is `scored`
(`assess.ts`, S11: `afterGates.disposition !== 'scored'` → no critic). A dimension the **assessor itself** declares
`insufficient_evidence` (disposition `assessor_reported_insufficient`) has `criticReviewRequired = false` and is never challenged.
M4 then excludes it and renormalizes (criterion needs ≥ 0.5 assessed weight, overall needs ≥ 0.6).

| Project, weights 0.4 / 0.3 / 0.3 | assessor output                           | reported overall                                                                         |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| A                                | 9 / 9 / **insufficient** (model-declared) | `scored_partial` **9.0**, assessed weight share 0.7, `missingCriterionKeys: [hard_part]` |
| B                                | 9 / 9 / **2**                             | `scored` **6.9**                                                                         |

The same project is 9.0 or 6.9 depending on one unreviewed model sentence. It is not hidden (the state is `scored_partial` and the
missing criterion is listed), and it is not an M4 defect: M4 treats a missing dimension as "not assessed", as invariant 2 requires
(missing evidence is not negative evidence). The risk is the **direction**: an injected or mistaken "insufficient" can only raise a
project's number, never lower it, and nothing in the report says that the exclusion was the model's own claim rather than a
code-detected lack of evidence (code pre-gates produce a different disposition).

Bound: because the overall needs ≥ 0.6 assessed weight, one project can drop at most 40 % of the overall weight this way.

### Options

**Option A — mandatory critic review of model-declared insufficiency.**
For each `assessor_reported_insufficient` unit whose deterministic candidate set holds at least `k` project-derived items
(`k` = a code constant, proposed 2), run one critic call asking "is a substantial, relevant project-derived candidate being ignored?"
A contested insufficiency triggers the existing bounded assessor re-run.

- Needs **critic prompt v2** (the frozen v1 critic only judges a _score_; its schema has no insufficiency-review shape) — a prompt change.
- Is only useful together with F-4 / prompt v3: the re-run today re-sends an _identical_ request (same digest), so under the replay
  provider it returns the same answer and under a live model it is only a resample. The critic's objection needs a feedback channel to
  the assessor.
- Adds up to one call per insufficient unit to the preflight plan: the call-count estimate, `pipeline_config` and therefore the
  config hash change (new pipeline version; old runs stay valid under the old hash).
- Cost: ≤ (units) extra critic calls per run; time ≈ one critic call per insufficient unit.

**Option B — transparent coverage restriction (no model change, no prompt change).**
After scoring, code adds one code-authored limitation to the stored assessment when the overall is `scored_partial` (or any criterion
is `partial`) **and** at least one missing dimension has disposition `assessor_reported_insufficient`:

```
code: partial_score_excludes_model_declared_insufficient
count: number of such dimensions
subjects: their dimension ids   (code-assigned handles only, never model text)
```

The API already returns `limitations` and the report's `assessedWeightShare`; the UI would show, directly under the overall number:
"Partial: N % of the rubric weight was not assessed. The assessor itself declared M dimension(s) to lack evidence; this was not
independently reviewed." The number stays exactly what M4 computed. Pre-gate (code-detected) insufficiency is **not** flagged
this way, so the label means what it says.

- No prompt, M4, schema or API-shape change (limitations are an open string-code list today; the UI renders any code).
- Does not prevent the inflation, it makes it unmissable and attributable.

**Option C — leave as is.** Documented limitation only. Not recommended: the P6A UI already shows `scored_partial`, but without the
attribution a judge cannot tell a model's claim from a code finding.

### Recommendation

**B now, A together with prompt v3.** B is a small, deterministic, additive disclosure that is safe before any live use. A is the real
fix, but it is meaningless without the v3 feedback channel (F-4) and costs a prompt change plus a config-hash bump, so it should be
designed once, with v3, before any paid live run. If the owner wants a hard guard before then, the narrowest one is _operational_:
the UI/API keep showing `scored_partial` with the new limitation, and the human judge's final score stays authoritative (invariant
"human final score is authoritative").

### Regression tests the approved change would add

1. (B) 9 / 9 / model-declared-insufficient → `scored_partial` 9.0 **and** limitation `partial_score_excludes_model_declared_insufficient`
   with `subjects = [hard_part]`; the number is unchanged (0.7 share, 9.0).
2. (B) The same shape where the missing dimension is **pre-gated by code** (no candidates) → no such limitation.
3. (B) A fully scored run → no such limitation; a `scored_partial` caused only by pre-gated dimensions → no such limitation.
4. (B) Invariant: `git diff` touches nothing under `packages/scoring`; the 9.0 and 6.9 goldens above are unchanged.
5. (B, UI) The assessment page renders the attribution sentence for test 1 and not for test 2.
6. (A) A contested insufficiency triggers exactly one re-run (≤ 2 re-runs overall, existing cap), an uncontested one does not; a
   critic that fails technically never converts an insufficiency into a score (invariant: model failure never yields a score).
7. (A) The preflight plan counts the extra calls; a run that would exceed `maxCalls` is refused before any call.

---

## F-3 — an Event Context with no reference evidence can never be assessed

### What happens today (verified)

`buildEventReferenceItems` turns a locked context into reference evidence only from: declared-track definitions, **explicit** rules and
**explicit** submission requirements applicable to the project. A locked context whose rubric is fine but which has no declared track
for the project and no explicit rule or requirement yields **zero** items (unclear-only rules do not count; invariant: ambiguity stays
`unclear`). An extraction needs ≥ 1 record (M3 refuses an empty batch; the trusted reader requires a bound `context_evidence`
extraction), so `writeContextExtraction` fails the run with `domain_validation_failed` / `no_context_reference_evidence`.

Consequences: a legitimate event (official rubric only) can never be assessed; the failure appears late (inside the run, after
inputs were pinned) and with a misleading category. Nothing is fabricated — that part is correct and must stay.

### Options

**Option 1 — an authenticated empty reference-set extraction (recommended).**
Allow a `context_evidence` extraction with **zero members**, produced only when the deterministic builder yields zero items from the
locked document, and verifiable end to end.

- _Representation._ A `graph_extractions` row (`kind = context_evidence`) with all five counts 0, no `graph_extraction_items` rows and
  no M3 graph (nothing is written to claims/evidence tables: **no fake evidence**). `members_hash` = the existing hash of the empty
  member set (the SQL function and `membersHash` already define it for empty lists).
- _Hash / pinning._ Identity is unchanged: (project, locked context version **and its content hash**, declared tracks, builder
  version, config hash). The run pins this extraction like any other (`assessment_run_extractions`), so a later re-lock cannot change
  what the run saw.
- _Completeness._ Completeness cannot be "all members present" (there are none), so it is verified by **recomputation**: the trusted
  reader re-runs `buildEventReferenceItems(lockedSnapshot, declaredTrackKeys)` from the pinned locked version and requires
  `items.length === 0` **and** the stored `recorded_limitations` (the P6A F-5 column) to equal the builder's exclusion summary
  (`not_explicit`, `not_applicable_track`, ...). A forged empty row for a context that does have items fails that check; so does an
  empty row whose exclusions differ.
- _What the pipeline does._ Candidate sets contain no event-reference items. Units that need one (every unit of the fallback
  `track_prize_alignment` criterion) are already `insufficient_evidence` with `no_official_requirement_available`; no other criterion
  depends on reference items, so official-rubric assessment proceeds. A limitation `event_context_has_no_reference_evidence`
  (count = excluded items by reason) is stored and shown.
- _Schema implications._ Read from the migrations (to be confirmed by a spike on PGlite and PostgreSQL 16 before implementation):
  the deferred integrity triggers of migrations 0011/0013 check counts, ordinals, the kind shape and `members_hash` but impose **no
  minimum member count**, and the SQL `graph_extraction_members_hash` already hashes an empty member set. The "at least one record"
  rule lives in the **application**: M3's graph writer refuses an empty batch, and `writeContextExtraction` fails the run before
  anything is written. So Option 1 is expected to need **no change to existing triggers**; it needs:
  1. a store method `createEmptyContextExtraction` that does not call the M3 graph planner and takes the same project lock and identity
     derivation as `createExtraction`; it is the only path allowed to create a zero-member extraction and only for `context_evidence`;
  2. the exclusion summary stored in the `recorded_limitations` column added by P6A (F-5), so the stored row says _why_ it is empty;
  3. `AssessmentInputReader` accepting a zero-member context extraction (it already recomputes the reference set from the pinned locked
     version via `referenceSetMismatch`; for the empty case the expected set must also be empty);
  4. only if the spike finds a trigger that does reject the empty set: one new additive migration relaxing that branch, never an edit of
     an existing migration.
- _API implications._ None to the four routes. `POST` keeps returning the same results; the run now succeeds instead of failing late.
  The read model gains no new field (the limitation list carries it).

**Option 2 — refuse at request time.** `POST /assessments` preflights the locked context and answers a new `422
ASSESSMENT_EVENT_CONTEXT_HAS_NO_REFERENCE_EVIDENCE` before creating a run. No schema change, no fake evidence, and the late misleading
failure goes away — but an organizer with a perfectly good rubric cannot get any assessment, which is a product limitation, not a
safety property (reference evidence is supplementary context; the rubric does not depend on it).

**Option 3 — status quo.** Not recommended (late, misleading failure).

### Recommendation

Option 1. If the owner prefers the smaller step first, Option 2 is a safe interim (no schema change) that can be replaced by Option 1
later without a data migration, because it only adds a request-time check.

### Regression tests the approved change would add

1. A locked context with an official rubric and no declared track / explicit rule / requirement: the run **succeeds**; the stored
   context extraction has 0 members, 0 graph rows were written for it, and `recorded_limitations` carries the exclusion summary.
2. An `unclear`-only rule set produces the same empty extraction (ambiguity is not promoted to evidence).
3. Forgery: an empty context extraction for a context that **does** have explicit rules is rejected by the reader (`reference_set_mismatch`).
4. Forgery: an empty extraction pinned to a different context version / content hash is rejected.
5. Re-lock of the context: a run pinned to the old extraction is unaffected; a new run builds a new identity.
6. The fallback `track_prize_alignment` units are `insufficient_evidence` (`no_official_requirement_available`) and never scored.
7. A non-empty reference set still goes through the unchanged path (existing tests stay green); an empty batch to the **source**
   extraction path is still refused.
8. PGlite and PostgreSQL 16: the deferred triggers still reject an incomplete or mis-hashed **non-empty** membership, and accept the
   empty context extraction only through the dedicated store method.
9. `POST` then worker then `GET` over HTTP for such an event (offline replay).

---

## Prompt v3 — closed-channel feedback for re-asks (R5 F-4), proposal only

Not part of P6A, listed so F-2 Option A has its prerequisite visible.

**Problem.** Repair re-asks (`model-call.ts`) and critic-triggered assessor re-runs re-send the **identical** request. Under
`ReplayProvider` the second answer is the first, so "invalid, then valid" can never be expressed offline; under a live model it is a
resample, and reserved budget can be spent for nothing (R5 S2 control: 9 calls for 5 distinct requests).

**Proposal.** A v3 of the extraction, assessor and critic prompts with a _closed machine feedback channel_: the re-ask request
carries a code-authored block `feedback: [{ code, handle }]` drawn from a closed list of validator rejection codes (for example
`passage_not_shown`, `quote_not_verbatim`, `citation_not_in_candidates`, `critic_blocking:<finding_code>`), rendered inside the
trusted section, never any model or source prose. Because the feedback changes the rendered request, the digest differs, so replay
fixtures can express a failed first answer followed by a corrected one, and a live resample is at least informed.

**Needed to ship:** new frozen prompt versions and template hashes, new pipeline config identity (new config hash), updated
golden-hash tests, new replay fixtures, and an owner-approved cost estimate. The decisions in F-2 Option A and any critic prompt v2
should be taken **together** with this, in one prompt revision. No live call is needed to build or test it (scripted/replay only).
