# M5 phase P2 — versioned prompts and the pure renderer (note)

Scope delivered (design [M5-design.md](./M5-design.md) §11, §13 row P2): `packages/prompts` only, plus guard and documentation updates.
**No** validators (P3), migration or table (P4), worker (P5), provider adapter, route, job or UI (P6/P7). No Anthropic SDK, no API key, no network, no
model call. The fallback anchors are still an unapproved draft: `FALLBACK_ANCHORS_APPROVED` is `false` and a `fallback` standard is refused.

## What exists

| Piece                           | Where                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Nine frozen prompts (`v1`)      | `src/templates.ts`, `src/system.ts`; pinned by `golden/template-hashes.json` |
| Pure renderer                   | `src/render.ts` (`renderPrompt`, `requestFields`)                            |
| Untrusted-data framing          | `src/frame.ts` (`deriveBoundary`, `deriveItemMarkers`)                       |
| Strict allow-list input schemas | `src/inputs.ts` (`STAGE_INPUT_SCHEMAS`, `PROMPT_INPUT_LIMITS`)               |
| Official rubric view            | `src/rubric-view.ts` (`officialUnitFromLockedSnapshot`)                      |
| Golden rendered prompts         | `golden/rendered/<stage>.txt` (byte-for-byte)                                |
| llm compatibility               | `tests/integration/prompts-llm-compat.test.ts`                               |

Public interface (`@judge-copilot/prompts`): `PROMPTS`, `PROMPT_REGISTRY`, `promptFor`, `PROMPT_VERSION`, `FRAMING_VERSION`, `renderPrompt`, `requestFields`,
`officialUnitFromLockedSnapshot`, `STAGE_INPUT_SCHEMAS`, `PROMPT_INPUT_LIMITS`, `UnitView`, `Candidate`, `CRITIC_FLAG_VALUES`, `deriveBoundary`,
`deriveItemMarkers`, `FALLBACK_ANCHORS_APPROVED`, and the error classes `PromptInputError`, `PromptSecretError`, `FallbackAnchorsNotApprovedError`,
`PromptFramingError`. Errors carry paths and codes only, never input values.

## Decisions worth reviewing

- **Structural, not semantic, defense.** The boundary `DATA-<32 hex>` is SHA-256(seed ‖ counter ‖ all data text) and each record code is a hash of the boundary,
  handle and content, both re-derived until they occur nowhere in the data. Project text therefore cannot close its block or impersonate a record. A model can
  still be persuaded by what the data _says_; validation (P3), the critic and the human judge are the defenses for that. No test claims otherwise.
- **Only passages are raw.** Every other free-text value is JSON-escaped on a single `meta:` line. Source passages carry a raw `text:` body because the model must
  quote them verbatim (the quote is later checked by code as an exact, once-occurring substring).
- **Handles are the only identifiers.** Input schemas contain no UUID, `origin`, verification level or score-of-a-record field; unknown fields are rejected.
  Prompt labels are limited to `unverified` / `team_claim` (Option B).
- **The reference standard comes from the pinned locked snapshot.** `officialUnitFromLockedSnapshot` checks schema, `locked` status, event, recomputed content hash and the
  pinned hash, uses the single overall rubric, sorts anchors by score, and yields `official_no_anchors` (never a substitute) when a criterion has none. It cannot prove the
  snapshot is _authentic_; that is the trusted database reader's job in P4.
- **Digest compatibility.** `requestFields` returns exactly the request fields this package determines; the llm `computeRequestDigest` commits to every byte of them. The
  `outputSchemaHash` is the hash of the same JSON Schema `jsonSchemaFor` sends.

## Verification (local; Node 22, pnpm 10.28.0; no PostgreSQL 16 run, P2 touches no database code)

- `pnpm check`: exit 0. 101 test files passed + 1 skipped; **1,768 passed / 16 skipped**.
- New tests: 131 in `packages/prompts` (templates 8, golden/determinism 21, framing 35, inputs 43, rubric view 8, source scan 16), 58 in
  `prompts-llm-compat`, 3 new guard tests in `milestone-scope`. `packages/llm`: 176 tests, unchanged by P2.
- `pnpm db:generate`: "No schema changes, nothing to migrate". No migration exists for M5 yet.
- 30 mutation proofs, each applied to the source, shown to fail at least one named test, then restored: boundary independent of data; boundary collision check removed; item-marker
  collision check removed; item code ignoring content; free text not JSON-escaped; passage body trimmed; project text leaking into the system message; final-prompt secret scan
  removed; input secret scan removed; fallback anchors enabled; standard block omitted; anchor descriptions dropped; anchors unsorted; content-hash check skipped; pinned-version check
  skipped; non-strict inputs; widened label vocabulary; duplicate handles allowed; template hash ignoring system text / output schema / version; nondeterministic seed; closed set built from
  text matches; malformed Unicode allowed in passages; digest ignoring the system text / later user blocks / template hash; `requestFields` dropping the system text / later user blocks; output
  schema hash from the wrong side. All 30 were killed.

## Risks and notes for P3

1. A passage may contain a carriage return (allowed in `PassageText`) but a `Quote` may not; a model cannot quote across a `\r`. P3's quote check must locate the quote in the passage
   text with `\r` handled the same way (or the extractor stage must normalize line endings before building passages).
2. `outputSchemaHash` depends on the installed Zod version's JSON Schema output; a Zod upgrade changes template hashes (and the golden file) even with no wording change. That is deliberate,
   but a Zod bump needs a prompt-version decision.
3. Handles are code-assigned per call (`P-0001`, `C-001`, `E-001`, `X-001`); P3/P5 must keep the handle-to-record maps, and the closed set returned by `renderPrompt` is the set P3 validates against.
4. The prompt wording (`src/system.ts`) has never met a real model. It is a v1 to be calibrated during the owner-authorized live phase, and any change is a new prompt version.
5. Fallback anchors remain disabled; enabling them needs the owner's approval of the exact text and a deliberate change of `FALLBACK_ANCHORS_APPROVED`, which a test pins to `false`.

## Corrections after the independent P2 review (commit following `80973eb`)

See [M5-P3-note.md](./M5-P3-note.md#p2-corrections-review-of-80973eb): F1 (exact locked context version), F2 (marker instructions agree with emitted markers; `framing/v2`, prompt `v2`, goldens
regenerated, the v1 table kept in `golden/history/`) and F3 (carriage-return / quote policy). The numbers in this note describe the state at `80973eb`.
