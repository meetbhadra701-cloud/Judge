# packages/llm — provider-neutral structured-output interface (M5, phase P1)

**Layer:** 3 (adapter) · **Depends on:** `@judge-copilot/context` (canonical JSON, SHA-256), `@judge-copilot/schemas`, `zod`.

Implemented in P1 (design: [`docs/milestones/M5-design.md`](../../docs/milestones/M5-design.md) §12):

- `StructuredRequest` / `LlmResult` / `LlmProvider`: nothing here names a vendor. A request carries the exact system text,
  every user-role block, the JSON schema as sent and the generation settings.
- `computeRequestDigest`: SHA-256 of the exact effective serialized request (`request-digest/v2`). It is derived here, never
  supplied by a caller. `timeoutMs` is excluded; every other model-visible byte is included.
- `withTimeout`, `withRetry`, `withBudget`, `createGuardedProvider`: retry( budget( timeout( provider ) ) ). Every attempt,
  including each transient retry, is its own reserve → call → settle cycle.
- `InMemoryRunBudget` (port `RunBudget`): the **configured local spending guard**. It refuses to _start_ an attempt when the
  computed total (settled + unknown + reserved + the attempt's worst case) would cross a limit. It is **not** a provider billing
  limit and cannot guarantee an invoice. Ambiguous outcomes stay counted at their full reservation. `maxCalls` limits **attempts started**: a
  `released` (provably unsent) attempt frees its token and cost reservation but never its attempt slot. The ledger retains each model
  answer as a bounded (256 KiB canonical JSON), deeply frozen copy and never the prompt; the database-backed ledger (P4) implements the same port and
  the same contract (`ledger-contract.test.ts` is parameterized over a ledger factory).
- `PRICES_V1`: versioned, dated prices in integer nano-USD per token, unverified against the provider.
- `ReplayProvider` (keyed by the full request digest, synthetic fixtures only) and `ScriptedProvider` (tests). Both are
  refused unless the **actual runtime** `NODE_ENV` is exactly `development` or `test` (unset counts as `development`; anything else fails
  closed). A caller-supplied environment name can only tighten that check.
- Failure normalization (`failureFromHttpStatus`, `failureFromError`, `safeErrorSummary`, `toRunFailure`): adapters map SDK
  and transport errors to provider-neutral categories; no error message ever crosses this boundary.
- `parseModelJson` (strict, no repair) and `jsonSchemaFor` (JSON Schema derived from the stage's Zod schema).

Not here (later phases): the Anthropic adapter and SDK (P6, owner-authorized), prompts (P2, `packages/prompts`), the assessment
pipeline (P3–P5), any database ledger (P4). No API key is read, no network is contacted, no file is opened.

Deterministic packages (layer 2) may not depend on this package (`tests/integration/dependency-rules.test.ts`).
