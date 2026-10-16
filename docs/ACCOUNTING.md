# Accounting of assessment runs: stage executions, provider calls, reserved budget and actual cost

P6D. This page defines four words that must never be confused, and says where each is recorded and shown. It exists because, before P6D, an offline
scripted demonstration wrote a fixed placeholder usage (1 000 input and 200 output tokens per stage) into the call ledger, the ledger priced it
(about **$0.017 for a nine-stage run**), and the API returned that figure as the run's cost. No model was called and no money was spent; the numbers
were still presented as `usage`. The web page hid them, the API and the ledger did not.

## The four terms

| Term                | What it is                                                                                                                                                                                                                                                                                                                    | Recorded in                                                                      | Shown as                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Stage execution** | One pass of a pipeline stage (source extraction, a dimension assessment, a critic review, …) through the local call ledger. For a live run each stage is carried out by calling a provider; for an offline demonstration (`replay`, `scripted`) it is carried out by local code. It is bookkeeping, never a model invocation. | one row of `assessment_run_calls` (the "ledger")                                 | `usage.stageExecutions` (all runs) and `usage.simulated.stageExecutions` (demonstrations)                         |
| **Provider call**   | An actual invocation of an external model. Only a `live` provider makes them. There is no live provider in this repository, so the number is **0 for every run that exists**.                                                                                                                                                 | the same ledger rows, those whose `provider_mode` is `live`                      | `usage.providerCalls`, `usage.attemptsStarted`, `usage.settledCalls`, `usage.unknownCalls`, `usage.releasedCalls` |
| **Reserved budget** | A LOCAL software limit held against a run while a stage executes, so that the run cannot exceed `maxCalls`, `maxInputTokens`, `maxOutputTokens`, `maxCostNanoUsd` or its wall clock. It is not money and not a provider quota (`guard.notice` says so). A reservation is settled to measured usage, or released.              | `reserved_*` columns of the ledger; `assessment_run_budget` for the limits       | `guard` (the limits)                                                                                              |
| **Actual cost**     | Money incurred with a provider.                                                                                                                                                                                                                                                                                               | `input_tokens`, `output_tokens`, `cost_nano_usd` of settled **live** ledger rows | `usage.inputTokens`, `usage.outputTokens`, `usage.costNanoUsd`                                                    |

## The invariant

> An offline demonstration is never represented as an actual paid model invocation or as actual incurred cost.

It is kept in three places, so no single mistake can break it:

1. **At the source.** The scripted demonstrator (`apps/worker/src/assessment/demonstration-model.ts`) is local code. It consumes nothing and therefore
   **reports zero tokens**. A run of it writes ledger rows with zero tokens and zero cost, and the terminal `assessment_run_outcomes` row (the
   "billing summary") copies those zeros.
2. **In the read model.** `AssessmentReadStore.usageOf` splits the ledger by each call's provider mode. Only `live` rows feed `inputTokens`,
   `outputTokens` and `costNanoUsd` and the provider-call counters. Every other row (`replay`, `scripted`, or a row from before the mode was
   recorded) is counted only as a stage execution, and whatever it reported is returned under `usage.simulated` as **diagnostics** with a
   `notionalCostNanoUsd` that is explicitly not spent. `usage.basis` is `simulated` for such a run.
3. **On the page.** A demonstration report says "0 provider calls, no tokens, no cost" and "N local demonstration stage(s)". A live run (not
   available today) shows its measured usage and cost.

## The outcome row ("billing summary") — M6 phase 0 (R8B P3-4)

`assessment_run_outcomes` holds four counters named `attempts_started`, `settled_calls`, `unknown_calls` and `released_calls`. They count **ledger entries**,
that is **local stage executions**: for a live provider each entry is one provider call, but for an offline demonstration each entry is a pass of local code
and no model was called, so a scripted run legitimately stores, for example, `settled_calls = 9` next to `input_tokens = 0`, `cost_nano_usd = 0` and
`provider_mode = 'scripted'`. The names are historical and immutable rows are not rewritten, so M6 adds two explicit columns (migration `0021`) and database
comments instead:

| Column             | Meaning                                                                           | Rule                                                                    |
| ------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `stage_executions` | local stage executions of the run (equals `attempts_started`)                     | CHECK `stage_executions IS NULL OR stage_executions = attempts_started` |
| `provider_calls`   | external provider invocations (a released reservation never reached the provider) | CHECK: 0 unless `provider_mode = 'live'`                                |

Both are `NULL` for a run recorded before M6 ("not recorded"). A report of spend must read `provider_calls` (or the API's `usage.providerCalls`), never
`settled_calls`, and must treat every non-`live` run as simulated whatever its counters say.

## Historical records

Nothing stored is rewritten or deleted. Runs made before P6D keep their ledger rows (including the priced placeholder of the scripted pilot). They are
**reinterpreted at read time**: because their provider mode is not `live`, the API now returns `basis: "simulated"`, `costNanoUsd: 0` and
`providerCalls: 0`, with the old placeholder visible as `simulated.reportedInputTokens` / `reportedOutputTokens` / `notionalCostNanoUsd`. The
per-run outcome row of such a run still holds the old totals; it is a stored record, and any billing summary built from it must also treat
non-live rows as simulated (there is no aggregate spend report in this repository today).

## Spending guards stay testable

The guards run over the same ledger for every provider, so tests exercise them with explicitly synthetic usage (the test `FakeModel` and the
`ScriptedProvider` steps in `apps/worker/src/testing/` report chosen token counts, and the ledger and budget tests assert the limits against them).
Those rows are the synthetic fixtures; they are not produced by the demonstrator and never reach a judge as spend.

## Where this is tested

- `tests/integration/demonstration-safety.test.ts`: a scripted run writes zero tokens and zero cost to the ledger and the outcome row, and
  the read model reports `simulated`, 0 provider calls and the stage-execution count.
- `tests/integration/demonstration-accounting.test.ts`: the same through the HTTP API, the reinterpretation of a pre-P6D priced run, and that
  synthetic fixtures still trip the spend guards.
- `tests/browser/p6d.browser.ts`: the report page of a scripted run shows no cost and no token count.
