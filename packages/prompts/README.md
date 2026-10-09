# @judge-copilot/prompts — frozen prompts and the pure renderer (M5, phase P2)

**Layer:** 3 (adapter, no I/O) · depends on `@judge-copilot/context`, `@judge-copilot/schemas`, `zod` only. It never imports `llm`
(siblings); the contract with `llm` is tested in `tests/integration/prompts-llm-compat.test.ts`.

## What it provides

- `PROMPTS` / `promptFor(stage)`: one frozen prompt per model-backed stage (id such as `claim-extraction`, version `v1`, schema id =
  prompt id, `templateHash`, `outputSchemaHash`). `golden/template-hashes.json` pins them; changing a word without bumping
  `PROMPT_VERSION` fails a test.
- `renderPrompt(stage, input, options?)`: pure and deterministic. Returns `system` (trusted text plus the marker clause for this
  request), `user` blocks, the `boundary`, the `closedSet` of handles and a `standardBasis`. `requestFields(rendered)` gives
  exactly the fields a `StructuredRequest` needs; nothing may be appended afterwards, because the request digest commits to those
  bytes.
- `officialUnitFromLockedSnapshot(snapshot, {lockedContentHash, eventId}, criterionKey)`: the official criterion description and
  anchors from the same locked, pinned Event Context snapshot that builds the scoring rubric. A criterion with no anchors becomes
  `official_no_anchors`; nothing is substituted.

## Security properties (structural, not semantic)

- Trusted instructions exist only in `system`; every project-controlled character lives inside a marked record of a user block.
- The block boundary `DATA-<32 hex>` and each record code are SHA-256 functions of the exact data they frame and are re-derived
  until they occur nowhere in that data. The same input always yields the same bytes.
- Free text is JSON-escaped on one `meta:` line; only source passages (which the model must quote verbatim) carry a raw `text:` body.
- Input schemas are strict allow-lists: unknown fields (an API key, a UUID, an `origin`) are rejected, handles match closed
  patterns, labels are limited to `unverified` / `team_claim`.
- `options.secrets` aborts a render if a configured secret appears in any input field or in the finished prompt.
- Fallback anchors are refused (`FALLBACK_ANCHORS_APPROVED` is `false`).

This does **not** make a model immune to what the data _says_. Output validation, the critic stage and the human judge remain the
defenses against semantic manipulation. See `docs/milestones/M5-design.md` §11 and `docs/milestones/M5-P2-note.md`.
