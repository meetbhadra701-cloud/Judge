# M5 phase P3 — trust-boundary corrections (review of `476461e`)

Verdict on `476461e`: P3 FIX THEN RECHECK. The architecture (exact quote locator, source routing, Option B label policy, graph planning, additive M4 hash verification) was accepted;
three trust-boundary findings are fixed here. No P4 work, no provider SDK, no model call, no migration (`pnpm db:generate`: "No schema changes"), no change to `packages/scoring`,
`packages/prompts`, `packages/evidence`, `packages/database`, scoring goldens, fallback weights, trust constants or prompt versions.

## F1 — per-call closed-set enforcement

**Vulnerability.** The gates validated against `world` maps (every passage, claim, evidence item, pair or candidate of the whole extraction). A structurally valid, real record of a
_different_ batch passed, although the model was never shown it ("exists in the extraction" was treated as "authorized").

**Fix.**

- `closed-set.ts` (new): `ClosedSet` (structurally identical to `RenderedPrompt.closedSet`; no import of `prompts`, layering intact), `ClosedSetRequiredError`, `shownHandles`, `shownUnit`.
  A missing or malformed set **throws** (fail closed); an empty set is legitimate and rejects everything.
- Every gate takes the shown set as a **required** argument: `gateClaims`/`gateEvidence` (`passage_not_shown`), `gateRelations` (`claim_not_shown`, `evidence_not_shown`),
  `resolveVerification` (`pair_not_shown`), `gateContradictions`/`gateUnknowns` (`side_not_shown`, `claim_not_shown`, `evidence_not_shown`), `gateCritic`, `gateJudgment`
  (`citation_not_shown`), and all `stage.validate*` wrappers.
- Fidelity and verification are per batch: `FidelityCall {shown, verdicts}` + `gateFidelityCall` + `resolveFidelity(claims, evidence, calls)` (a verdict for a real pending item outside
  its own batch is `item_not_shown`); `resolveVerification` + `combineVerifications` (a pair no call showed is dropped, conservative drop-wins).
- `withoutCandidates` keeps original handles, so a re-run cannot be confused with a different call's local `E-001`.

**Tests** (`closed-set.test.ts`, 28; `extraction/relations/critic/judgment` tests updated; `tests/integration/assessment-compat.test.ts` uses the real `renderPrompt(...).closedSet`).
Each "ORIGINAL VULNERABILITY vs CORRECTED" case builds a hostile input from a real record of another batch, shows the old world-based acceptance, and the new rejection:
1 passage exists but unshown; 2 relation to real-but-unshown claim/evidence; 3 fidelity verdict for a real pending item of another batch; 4 verification verdict for an unshown pair;
5 contradiction/unknown refs from another batch; 6 assessor and critic closed sets; 7 a local reference (`E-001`, `P-0001`) reused from a different call is not authorized;
8 valid shown records still pass; plus: omitted, malformed, empty and non-string closed sets throw or reject (no bypass by omission, JavaScript callers and casts included).

## F2 — Track/Prize-Alignment must cite applicable official context

**Vulnerability.** The pre-gate only checked that Event-Context evidence _existed_; the post-gate accepted a score resting on project citations alone, and applicability was not
decided from the declared track.

**Fix.**

- `event-evidence.ts`: code-authored `EventReferenceMeta` (`kind`, `applicability`, `trackKey`) per reference item, with
  `applicability ∈ {declared_track_definition, track_specific_requirement, overall_rule}` (`referenceMetaByEvidenceId`). Interpreted/unclear rules stay excluded.
- `candidates.ts`: `CandidateInputs` requires `declaredTrackKeys` and `eventReferences`; `applicableReference` decides applicability from the declared track + metadata only (an item
  of an undeclared track, or without metadata, never applies; an overall rule applies only when its `trackKey` is null). `requiredReferenceKinds(dimension)`:
  eligibility/required-technology → `track_specific_requirement` or `overall_rule` only (a track theme cannot substitute); other Track dimensions → track definition or
  track-specific requirement. Pre-gate `no_official_requirement_available` now means "no _applicable_ reference of a required kind"; nothing is invented.
- `judgment.ts`: new disposition `no_applicable_context_cited` — a Track judgment must cite project-derived evidence **and** an applicable reference of a required kind. Event
  citations stay `indirect`/`generic` (G6 unchanged). M4 scoring input and rules unchanged.

**Tests** (`track-alignment.test.ts`, 13): 1 reference exists, not cited → insufficient; 2 only reference cited → insufficient; 3 project + applicable reference → assessable;
4 project + unrelated track's reference → insufficient (and 4b: reference without metadata); 5 genuinely applicable general event rule → accepted as context;
6 required eligibility rule absent → insufficient, not invented (a theme description does not satisfy it); 7 no declared track → existing not-applicable behavior unchanged;
M4 score reports unchanged.

## F3 — verified graph scoping fails closed

**Vulnerability.** `scopeGraph(all, members, {known?, expectedMembersHash?})` skipped M3 provenance validation when `known` was omitted, checked the hash only if given, and never
compared records to an expected project/event: internally consistent records with fabricated provenance were accepted.

**Fix.** `scopeGraph(all, input: VerifiedScopeInput)` — **exactly two parameters**, nothing optional:
`{projectId, eventId, known (snapshots/artifacts/contextVersions maps), expectedMembersHash, members}`.

1. Trust inputs are validated (`trust_input_missing`: non-UUID ids, absent/non-Map known facts, malformed hash, missing member arrays).
2. The committed member ids must hash to the committed hash (`committed_members_hash_mismatch`); selected records must be unique and present (`member_ids_not_unique`, `member_missing`)
   and must re-hash to it (`members_hash_mismatch`).
3. Every member belongs to the **expected** project/event (`member_wrong_project`, `member_wrong_event`) — never judged against the record's own claim.
4. Closure: relation/contradiction/unknown endpoints inside the members, no supersession edges.
5. Provenance: M3 `checkProvenanceShape` + `checkProvenanceReferences` against the expected scope and the authoritative facts (`provenance_*`: snapshot/artifact/context version not found,
   cross-project, not content-bearing, not frozen, excerpt/span mismatch, …); a cited span needs readable artifact text (`artifact_text_unavailable`); then M3
   `validateGraphIntegrity`, tolerating exactly the three label-only codes M4 tolerates.
6. The filtering helper is `selectMembersUnverified`, **module-private, not exported**.

The function does not authenticate the database: P4 must load `known`, the expected hash and member ids from independent authorized reads.

**Tests** (`scope.test.ts`, 18; compat test updated): missing known facts / missing or malformed hash / missing ids and members cannot yield a verified scope; wrong project, wrong event;
fabricated provenance with all ids, relations and the committed hash consistent (original vulnerability: accepted; now `provenance_snapshot_not_found`, `provenance_artifact_not_found`,
`provenance_excerpt_mismatch`, `provenance_span_out_of_bounds`); unauthorized snapshot (absent / foreign project / not content-bearing); context version not found / other event / not frozen;
missing artifact text; dangling endpoints; supersession; extra foreign records, including one referencing a member, are excluded and change nothing (metamorphic);
the correct scope passes; no exported symbol named `unverified`/`selectMembers`.

## Validation

- `pnpm check` (format:check, lint, typecheck, db:check, test, build): **exit 0** — **126 test files passed + 1 skipped; 2,155 tests passed, 16 skipped** (baseline at `476461e`: 123 + 1 skipped; 2,096 / 16).
  Assessment package: 21 files, 329 tests.
- `pnpm db:generate`: "No schema changes, nothing to migrate". No existing migration touched.
- `git diff --stat` on `packages/scoring`, `packages/prompts`, `packages/evidence`, `packages/database`: empty (scoring goldens untouched).
- No network, no model call, no SDK.

## Mutation proofs (`mutate-p3-fixes.py`, whole targeted suite run per mutant)

35 mutants: **32 killed, 3 survived — all three are provably equivalent (redundant defence layers), not gaps.**

| Fix | Mutant                                                                                                                                  | Result                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | claims / evidence may cite an unshown passage                                                                                           | killed (5 / 1 tests)                                                                                                                                                                                                     |
| F1  | fidelity verdict for an unshown item (single call; `resolveFidelity`)                                                                   | killed (1 / 1)                                                                                                                                                                                                           |
| F1  | relation to unshown claim / unshown evidence                                                                                            | killed (3 / 1)                                                                                                                                                                                                           |
| F1  | verdict for an unshown pair                                                                                                             | killed (1)                                                                                                                                                                                                               |
| F1  | contradiction side / unknown claim / unknown evidence not shown                                                                         | killed (2 / 1 / 1)                                                                                                                                                                                                       |
| F1  | judgment cites unshown candidate; critic cites unshown evidence                                                                         | killed (3 / 3)                                                                                                                                                                                                           |
| F1  | missing closed set falls back to world; malformed field treated as empty                                                                | killed (2 / 1)                                                                                                                                                                                                           |
| F2  | Track unit citing no applicable context scored                                                                                          | killed (3)                                                                                                                                                                                                               |
| F2  | applicability ignored in post-gate; declared-track filter ignored; track-bound overall rule applies; metadata-less reference counts     | killed (2 / 1 / 1 / 2)                                                                                                                                                                                                   |
| F2  | eligibility satisfied by a theme description; pre-gate does not require an applicable reference                                         | killed (2 / 4)                                                                                                                                                                                                           |
| F3  | committed hash not compared; project identity; event identity; provenance references; provenance vs record's own project; artifact text | killed (1 each; provenance references 5)                                                                                                                                                                                 |
| F3  | trust inputs not required; hash not required; ids not required                                                                          | killed (3 / 1 / 1)                                                                                                                                                                                                       |
| F3  | closure ignores relation endpoints; member filter removed                                                                               | killed (2 / 3)                                                                                                                                                                                                           |
| F2  | "Track unit needs no project-derived citation"                                                                                          | **survived — equivalent**: the earlier post-gate `event_reference_only` (all citations are references) already rejects every judgment without a project-derived citation, and a scored judgment must cite something (G6) |
| F3  | recomputed scoped hash not compared                                                                                                     | **survived — equivalent**: once the committed ids hash to the expected hash and every id was found exactly once (`member_missing`/`member_ids_not_unique` otherwise), the selected records necessarily re-hash to it     |
| F3  | provenance shape check not run in `scopeGraph`                                                                                          | **survived — equivalent**: `validateGraphIntegrity` runs the same shape check afterwards; the finding is then reported as `integrity_*` instead of `provenance_*`                                                        |

## Public interface changes (`@judge-copilot/assessment`)

- **Breaking, intentional:** `scopeGraph(all, members, options?)` → `scopeGraph(all, VerifiedScopeInput)`; new export `VerifiedScopeInput`.
- All gates and `stage.validate*` take a required shown/closed-set argument; `validateFidelityReview(json, shown, pending)`; `validateCritic(json, shown)`.
- New: `ClosedSet`, `ClosedSetRequiredError`, `gateFidelityCall`, `FidelityCall`, `FidelityCallResult`, `resolveFidelity` (new call shape), `resolveVerification` (returns `judged`),
  `combineVerifications`, `withoutCandidates`, `requiredReferenceKinds`, `TRACK_ELIGIBILITY_DIMENSION`, `referenceMetaByEvidenceId`, `referenceMetaOf`, `REFERENCE_APPLICABILITY_VALUES`,
  `EventReferenceApplicability`, `EventReferenceMeta`; `EventReferenceItem.applicability`; `CandidateItem.reference`; `CandidateInputs` requires `declaredTrackKeys` and `eventReferences`.
- New unit disposition `no_applicable_context_cited` (and new issue codes listed above).

## Remaining P4 prerequisites

- Persist the code-authored `EventReferenceMeta` with the extraction and reload it for candidate building.
- Persist the committed member ids and membership hash with the extraction record; at read time load `known` (snapshots, artifacts **with readable text**, context versions), the expected
  project/event ids and the committed ids/hash from independent authorized database reads, and call `scopeGraph` with them.
- Pass `renderPrompt(...).closedSet` of the request actually sent to every gate; record batches (`FidelityCall`, relation/verification calls) with the sets they were rendered with.
- Everything else in the original P3 list is unchanged (provider adapter, worker orchestration, persistence, UI), none of which is started.
