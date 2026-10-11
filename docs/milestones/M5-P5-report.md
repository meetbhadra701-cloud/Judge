# M5 P5 — Worker orchestration of the pre-interview assessment (S0–S14)

Branch `claude/m5-pre-interview-assessment`, built on `027e75e` (R4 approved). Scope: `apps/worker` only (plus the
milestone-scope guard and `docs/ARCHITECTURE.md`). **Nothing under `packages/*` and no migration changed**; `pnpm db:generate`
reports "No schema changes", `pnpm db:check` passes. No API route, no UI, no Anthropic SDK, no real provider adapter, no live
call, no credential, no PR, `main` untouched.

## 1. Result

P5 is implemented, tested offline (ScriptedProvider / ReplayProvider only) and green on PGlite and PostgreSQL 16. Two items need
an owner decision before P6 (see §8 and §9): a P4 contract gap for contexts with no reference items, and the lack of a feedback
channel in the P2 prompts.

## 2. Stage status

| Stage                                                                                | Status                                                    | Where                                               |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------- |
| S0 claim run, check pins, config/provider/price checks                               | done                                                      | `pipeline.ts` (`loadFacts`, pin check), `config.ts` |
| S1 pinned snapshots, passages, deterministic budget preflight                        | done                                                      | `sources.ts`, `preflight.ts`                        |
| S2 claims, S3 evidence                                                               | done                                                      | `extract.ts`                                        |
| S3b fidelity review (paraphrases)                                                    | done; an unusable reviewer answer downgrades to verbatim  | `extract.ts`                                        |
| S4 relation matching, S4b independent verification                                   | done; only verifier-agreed relations kept                 | `extract.ts`                                        |
| S5 contradictions, S6 unknowns (+ code-authored source-gap unknowns)                 | done                                                      | `extract.ts`                                        |
| S7 atomic source + context extraction, or reuse of a matching committed extraction   | done                                                      | `write-extraction.ts`, `pipeline.ts`                |
| S8 trusted authorized read, S9 M4 context + candidate sets                           | done (via P4 `AssessmentInputReader`, `scoringContextOf`) | `assess.ts`                                         |
| S10 per-dimension assessor calls                                                     | done                                                      | `assess.ts`                                         |
| S11 separate critic calls                                                            | done (scored judgments only)                              | `assess.ts`                                         |
| S12 decision table, bounded reruns, technical-failure and valid-insufficiency policy | done                                                      | `assess.ts`                                         |
| S13 deterministic ScoreReport                                                        | done (`rescore`, M4 unchanged)                            | `assess.ts`                                         |
| S14 persist through P4 `AssessmentStore` (independent rescore)                       | done                                                      | `pipeline.ts`                                       |

## 3. Worker and lease architecture

- `runtime.ts` builds the offline runtime. `ASSESSMENT_PROVIDER` is `none` (default, loop not started) or `replay` (fixture
  required; refused in production by the env schema and by `assertProviderAllowed`).
- `loop.ts`: polls pending runs, bounded concurrency (`ASSESSMENT_CONCURRENCY` 1–2), cancels pending runs older than
  `ASSESSMENT_PENDING_MAX_AGE_MS` (**default 15 min**, min 1 min, max 24 h) with `pending_expired`, recovers expired leases,
  stops with a shutdown grace period and then aborts.
- `pipeline.ts` `runAssessment(deps, runId)` claims via `AssessmentRunStore.claimRun`, runs S0–S14 and always ends in exactly one
  of `succeeded | failed | cancelled | lost | not_claimed`. `terminate()` writes the terminal state with the lease token. A
  worker that lost its lease writes nothing.
- `session.ts` `RunSession`: one `AbortSignal` for lease loss, shutdown and wall-clock; heartbeat every lease/3 (also during
  model calls); tolerates an unreachable DB for at most one lease; a lost lease overrides every other stop reason;
  `checkpoint(stage)` before every stage and every model call.
- `model-call.ts` `ModelCaller`: render (pure) → request digest → `ledger.register` (closed set stored in the ledger row) →
  guarded generate `retry(budget(timeout(base)))` → read the binding back from the ledger → validate the answer against the
  closed set **read back from the ledger** (Zod, then the P3 domain gate) → at most one identical re-ask. Calls are strictly
  sequential. No transaction is ever held across a call (asserted by transaction-counting probes).
- Failure codes are normalized to `^[a-z][a-z0-9_]*$` (`stop.ts`), because the outcome table CHECK would otherwise refuse the
  terminal write and leave the run `running`.

## 4. End-to-end offline results

All tests run against `ScriptedProvider`/`ReplayProvider` through a hand-authored `FakeModel` that reads the rendered request
exactly as a provider would. No network.

| File                                                 | Tests          | Covers                                                                                                 |
| ---------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `pipeline.happy`                                     | 5              | complete official-rubric assessment, persisted report equals independent rescore                       |
| `pipeline.sources`                                   | 5              | Devpost-only and absent-source behavior, source-gap unknowns                                           |
| `pipeline.hostile`                                   | 6              | malicious prompt content in sources, unshown handles, secrets in prompts                               |
| `pipeline.critic`                                    | 10             | false-positive critics, blocking/minor findings, critic unavailable, critic never edits a score        |
| `pipeline.thresholds`                                | 9              | technical-failure rule T = max(2, ceil(0.25·U)) for U = 1, 2, 5, 36; valid insufficiency never counts  |
| `pipeline.budget`                                    | 9              | retry exhaustion, budget exhaustion (calls, tokens, cost), every attempt reserved, preflight rejection |
| `pipeline.context`                                   | 9              | context supersession, fallback rubric refused, provider/config mismatch                                |
| `pipeline.ownership`                                 | 10             | competing workers, lease loss, shutdown (incl. stale token)                                            |
| `pipeline.extraction`                                | 16             | fidelity, relations, commentary, structurally invalid answers fail the run, reuse after crash          |
| `pipeline.replay`                                    | 5              | ReplayProvider fixtures end to end                                                                     |
| `loop`                                               | 9              | pending expiry, recovery, concurrency, shutdown                                                        |
| `preflight`                                          | 17             | call plan, reduction ladder, pricing                                                                   |
| `session` / `model-call` / `runtime` / `source-scan` | 6 / 13 / 4 / 9 | lease timers, closed-set binding, wiring, static scans                                                 |
| **Total in `apps/worker/src/assessment`**            | **142**        |                                                                                                        |

`tests/integration/milestone-scope.test.ts` (27) was deliberately updated for P5: only the worker may import `llm`/`prompts`;
`assessment` only from `database` and the worker; API and web must not mention the assessment pipeline.

## 5. Verification counts

- `pnpm check` (format, lint, typecheck, db:check, test, build) on the P5 tree: **exit 0**; PGlite run: **158 test files passed, 3 skipped (161); 2585 tests passed, 39 skipped (2624)**.
- Full suite on **PostgreSQL 16.15** (`TEST_DATABASE_URL=…/judge_copilot_test`, files sequential): **161 files passed (161);
  3203 tests passed, 1 skipped (3204)**. (The `NODE_TLS_REJECT_UNAUTHORIZED` warning in that log comes from the existing
  `safe-http` TLS test.)
- `pnpm db:generate`: no schema changes. `pnpm db:check`: passes.
- `git diff 027e75e` touches no file under `packages/` and no migration; `git diff --check` clean.
- The final `pnpm check` after the report commit is recorded in the delivery message.

## 6. Budget, ledger and critic results

- Every provider attempt, including retries and critic calls, is reserved before the call and settled after it; `released` keeps
  its attempt slot, `unknown` is counted at worst case. Tests assert reservations equal attempts and that a denied reservation
  makes no provider call.
- The closed set from the prompt actually sent is stored in the ledger row and the answer is validated against the copy read
  back (mutants M02/M22).
- Preflight reproduces design §12.3.4 and fails with `plan_exceeds_limits` / `unpriced_model` before any spend; a reduction
  ladder (source budget 100/75/50/25 %, then caps) runs first and is disclosed as `preflight_reduction`.
- Critic: separate calls, only for scored judgments. It can reject (blocking finding → bounded rerun with injection-suspected
  evidence removed) but never changes a number (M06). Critic unavailable ⇒ the unit is not accepted unreviewed (M15). Minor
  findings are recorded as `critic_minor_findings`. Substantive rejections and valid insufficiency never count as technical
  failures.
- Technical-failure rule: fail the run when technical units ≥ max(2, ceil(0.25·U)) or all units are technical; an early stop
  avoids spending on the remaining units. A failed run never yields an assessment (`expectNoAssessment`).

## 7. Mutation proofs

24 deliberate single-defect mutants were applied one at a time to the sources and the focused tests run; each file was restored
afterwards. **24/24 killed.** M14 ("two repair re-asks") first survived because `ask < 2 → ask < 3` is an equivalent mutant (the
second pass always returns); it was replaced by a real mutant (a second re-ask actually allowed) which is killed.

| Id  | Defect                                                           | Killed by                       |
| --- | ---------------------------------------------------------------- | ------------------------------- |
| M01 | provider called without the spending guard                       | `pipeline.happy`                |
| M02 | validation against the in-memory closed set, not the ledger copy | `model-call`                    |
| M03 | DB transaction held across the whole run                         | `pipeline.happy`                |
| M04 | lease never heartbeat-renewed                                    | `session`, `pipeline.ownership` |
| M05 | valid insufficiency counted as technical                         | `pipeline.thresholds`           |
| M06 | critic edits the assessor score                                  | `pipeline.critic`               |
| M07 | pending expiry ignores age                                       | `loop`                          |
| M08 | terminal write without lease token                               | `pipeline.ownership`            |
| M09 | no extraction reuse                                              | `pipeline.ownership`            |
| M10 | extraction key ignores model                                     | `pipeline.ownership`            |
| M11 | fallback rubric not refused at S0                                | `pipeline.context`              |
| M12 | preflight ignores call limit                                     | `pipeline.budget`, `preflight`  |
| M13 | shutdown not listened to                                         | `pipeline.ownership`            |
| M14 | second repair re-ask allowed                                     | `model-call`                    |
| M15 | unreviewed judgment accepted when critic unavailable             | `pipeline.critic`               |
| M16 | technical-failure policy ignored                                 | `pipeline.thresholds`           |
| M17 | failure codes not normalized                                     | `pipeline.budget`               |
| M18 | model-interpreted facts labelled `repo_corroborated`             | `pipeline.happy`                |
| M19 | superseded context not detected                                  | `pipeline.context`              |
| M20 | lost lease does not stop the worker                              | `pipeline.ownership`            |
| M21 | provider mode not compared with stored config                    | `pipeline.context`              |
| M22 | secrets not passed to the renderer                               | `pipeline.hostile`              |
| M23 | paraphrases admitted without review                              | `pipeline.extraction`           |
| M24 | relation verification skipped                                    | `pipeline.extraction`           |

## 8. Deviations, decisions and findings

1. **P4 contract gap (needs owner decision).** `AssessmentInputReader` requires both a source and a context extraction, and M3
   refuses an empty batch. A locked context with no explicit rules/requirements and no declared tracks yields zero reference
   items and cannot be assessed. P5 fails such a run before any spend (`no_context_reference_evidence`); P4 was not changed.
2. **No feedback channel in the P2 prompts.** The single repair re-ask re-sends the identical request; critic reruns change only
   the candidate set. Delivering feedback needs prompt v3.
3. Fallback rubric anchors stay disabled: a context without exactly one official overall rubric fails at S0
   (`fallback_anchors_not_approved`). Track targets are unsupported (`track_target_not_supported`).
4. Critic is called only for scored judgments; assessor-reported insufficiency is not critiqued.
5. A reused extraction carries no extraction-time limitations; this is disclosed as `extraction_reused`.
6. Zero extracted records ⇒ `source_unavailable` / `no_extractable_records`.
7. Design §12.3.4 small-row table prints a re-run allowance of 8; the stated rule gives 16 (fallback) — the code follows the
   rule (plans 98 calls, headroom 52).
8. The pipeline-config builder (`buildPipelineConfig`) lives in the worker; P6 must share or relocate it.

## 9. Remaining prerequisites for P6

- Owner decision on item 1 (empty reference set) and whether a prompt v3 with a feedback channel is wanted.
- API routes with `Idempotency-Key` plumbing to create the pending run (config built by a shared builder, see item 8).
- Real provider adapter (Anthropic) behind the existing `LlmProvider` interface, with explicit authorization for live calls,
  credentials handling and price table approval; `ASSESSMENT_PROVIDER` currently allows only `none`/`replay`.
- UI for run status, limitations, deltas and the human final judgment.
- Operational settings review: lease, pending age (15 min), concurrency and shutdown grace defaults.
