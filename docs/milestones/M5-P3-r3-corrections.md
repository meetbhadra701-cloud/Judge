# M5 P3 — corrections required by the independent R3 review (before P4)

Reviewed head: `1ed6041`. Verdict: R3 PASS, with five mandatory corrections (A1–A5). No M0–M4 algorithm, scoring golden, trust constant, fallback weight or prompt version
changed. Only `packages/assessment` (and its tests) changed in this commit.

## A1 — duplicate loaded graph members

**Defect.** `selectMembersUnverified` compared `found.length` with `wanted.size`. Removing one unreferenced member and inserting a duplicate of another keeps the count equal, so
the _missing-member_ check was blind. The recomputed membership-hash comparison still rejected it, so no graph was wrongly accepted, but the check was independently defective.

**Fix.** The loaded records of each kind must have unique ids (`loaded_record_ids_not_unique`; nothing is ever deduplicated), and the selected ids must **equal** the committed ids as
sets (`member_missing` otherwise). The committed-hash check and the recomputed-hash check are both retained.

**Tests (`scope.test.ts`, 5).** The reviewer's counterexample (remove a relation, add a duplicate of another with different content; same record count) is rejected with both
`member_missing` and `loaded_record_ids_not_unique`; the same attack on claims; a plain duplicate with nothing missing; a substituted id.
**Mutation results.** Removing the uniqueness check → killed (3 tests). Reverting the set equality to the count comparison → killed (2). Removing both (the original defect) → killed.
Removing only the recomputed-hash comparison → the counterexample is **still rejected** (survivor by design: the new checks reject it on their own, which is what the review required).
"Silently deduplicate" survives only because the uniqueness issue still fires; the mutant does not change the verdict.

## A2 — pair-handle collisions and result identity

**Defect.** `pairsForVerification(…, firstNumber = 1)` let each batch restart at `X-001`; `combineVerifications` matched kept relations to pairs by **object identity**
(`candidate.relation === relation`) and never checked that handles were unique, so overlapping handles could retain unverified relations, and a JSON-round-tripped resolution
matched nothing.

**Fix (`relations.ts`).**

- `pairsForVerification(relations, world)` numbers the **whole** extraction once (no first-number parameter); verifier batches are slices of that array.
- Every `VerificationPair` carries an `identity` = SHA-256 of its canonical `[handle, claim, evidence, type, claim text, evidence text, quote]`.
- `assertPairSet` throws `PairSetError` (`duplicate_handle`, `identity_mismatch`) and is called by `pairsForVerification`, `resolveVerification` and `combineVerifications` before any verdict is read.
- Resolutions are JSON-safe and handle-based: `judged`, `keptPairs` and `dropped` entries are `{pair, identity}`. `combineVerifications` ignores (and reports `resolution_pair_mismatch` for)
  any entry whose handle is unknown or whose identity differs from the pair set's, and ignores a keep the same call did not judge (`kept_without_judgment`). A pair no call showed is
  dropped (`never_verified`); a drop from any call that showed the pair wins.

**Tests (`pair-verification.test.ts`, 12).** Overlapping `X-001` batches are refused; a tampered pair is refused; several batches combine; JSON round trips give identical results
(and return the pair set's own relation objects); no responses keep nothing; cross-batch reuse of a verdict under a recycled handle is rejected; forged identities, missing identities
and forged keeps are ignored; drop-wins; `pair_not_shown` still holds. **Mutations:** uniqueness off, identity check off, assert off in combine/resolve, identity ignored, keep without
judgment, drop-wins removed, never-shown kept → all killed.

## A3 — the reference cap starving the eligibility dimension

**Defect.** The per-unit cap (8) was filled definitions-first, so with nine declared tracks the track descriptions occupied every slot and the explicit eligibility requirement was
excluded, producing a false `no_official_requirement_available`.

**Fix (`candidates.ts`).** References of a kind the dimension **requires** (`requiredReferenceKinds`) are ordered first, then by kind (definition, track-specific requirement, overall rule).
`UnitCandidates.referenceSelection` records `applicable / included / omittedRequired / omittedOther`. If applicable required references exist but none is shown, the pre-gate reason is the new
`official_requirement_omitted_by_limit`, classified **technical** (we do not know the event states no requirement); an absent requirement remains `no_official_requirement_available`
(valid insufficiency). The cap is not raised, nothing is fabricated, M4 scoring is untouched. A `referenceCap` input exists only as a test/configuration seam.

**Tests (`track-alignment.test.ts`).** Seven- and nine-track cases (requirement and overall rule first; other Track dimensions still definition-first; counts recorded), an
absent requirement stays absent, and a cap of zero reports `official_requirement_omitted_by_limit`. **Mutations:** required-first ordering removed → killed; omission count removed →
killed; omission reported as absence → killed.

## A4 — structural applicability is not semantic relevance

The P3 Track gate is **structural**. "Do not harass event staff" is an explicit overall rule that is structurally applicable to every event but does not show compliance with a required
technology. The tests now pin this limitation (that judgment passes the structural gate). Nothing claims otherwise: `notices.semanticRelevance` stays `not_verified`.

`trackReferenceAudits(units, finals)` returns, for **every scored fallback Track judgment**, `{ dimensionId, semanticRelevance: 'not_verified', criticReviewRequired: true, references[] }`
with each cited reference's handle, **evidence id**, `applicability`, `trackKey`, `directness` and `specificity` (all code-authored). **P4 persists exactly this** with the citations
(`assessment_judgment_citations.reference_*` columns and the per-dimension `critic_review_required` / `semantic_relevance` columns). **P5 must not accept an assessment** that has a
scored Track judgment until a critic review of those citations has completed; this is recorded as a P5 prerequisite and enforced by P4's schema for the review state it persists.

## A5 — remaining reviewer observations (documented, no new framework)

1. **Frozen or superseded context versions.** `FROZEN_EVENT_CONTEXT_STATUSES` is `locked` and `superseded`, so `scopeGraph`'s provenance check accepts evidence citing a version that has
   since been superseded. That is correct for _historical_ provenance, and wrong as _authorization_ to assess. The P4 reader therefore (a) pins the exact version id and content hash
   at run start, (b) re-reads it in the same snapshot and requires it to be the event's **current locked** version when the assessment is persisted, and (c) cancels the run
   (`context_superseded`) otherwise.
2. **Caller-supplied known facts and forged-but-consistent provenance.** `scopeGraph` is pure and cannot tell genuine facts from a consistent forgery. P4's `AssessmentInputReader` is the
   only constructor of the verified inputs: it loads snapshots, artifacts (with text) and context versions itself from the database inside one `REPEATABLE READ` read-only transaction,
   and exposes no parameter through which a caller can pass facts, hashes, context status or reference metadata.
3. **Identity of the actual per-call closed sets.** The P3 gates trust the closed set the caller passes. P4 stores, with every ledger call, its **stage**, **request digest** and the
   **closed set** as returned by the renderer (`assessment_run_calls.closed_set`), written at reservation time, immutable afterwards. A P5 caller reads the set from the ledger row of
   the call whose response it validates; it cannot substitute another call's handles.
4. **Equivalent mutations and diagnostic differences** (carried from the first correction round, all provably redundant layers, none a gap):
   - F2 "Track unit needs no project-derived citation": covered by `event_reference_only`.
   - F3 "recomputed scoped hash not compared": covered by exact set equality + uniqueness (`member_missing`, `loaded_record_ids_not_unique`).
   - F3 "provenance shape check not run in `scopeGraph`": covered by `validateGraphIntegrity`; the finding is then reported as `integrity_*` rather than `provenance_*`.
   - A1 "recomputed hash not compared" and "deduplicate silently": the verdict is unchanged because the uniqueness and set-equality issues fire first.
