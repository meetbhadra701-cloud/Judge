# R10A — Independent Adversarial Review of M7 Interview Mode

**Reviewer:** independent engineering, security, database and product review (Judge Copilot) · **Date:** 2026-10-18
**Repository:** `meetbhadra701-cloud/Judge` · **Accepted M6 baseline:** `8b1c047b911ba5ddd981c2330273e664476cf7bf` · **Target (M7):** `336a52e1a30d0a757bd2099c8db26f25fb7babe7`, branch `claude/m7-interview-mode`
**Method:** clean clones; no application source modified (mutations applied only in a disposable clone and restored — verified, §8); no live models; nothing merged, deployed or pushed. All artifacts are untracked files outside the implementation branch (`R10A_INDEPENDENT_REVIEW.md`, `R10A_evidence/`).

---

## 1. Decision

**M7 is ACCEPTED. M8 design may begin** under a separately reviewed trust-boundary contract (conditions in §9).

No P0, P1 or P2 defect was found in M7's scope. Every property the acceptance standard names was exercised independently, against real PostgreSQL 16 and PGlite, with positive controls for every negative test:

- authenticated recording with credential-derived attribution;
- immutable, append-only records with race-safe corrections;
- no cross-project or cross-assessment linkage — including a project with **two verified pre-interview assessments and separate question sets**, which the author's own tests did not build end to end;
- correct answer↔question and observation↔answer linkage;
- race-safe idempotency, atomic audit, and void behaviour;
- a usable judge workflow in real Chromium;
- no score change, no evidence-graph write, no model call, no verification-level escalation.

Ten P3 observations are tracked in §6 and are **not** new implementation tasks.

## 2. Gates on the unmodified target

| Gate | Author baseline | Independent result |
|---|---|---|
| `pnpm check` (format, lint, typecheck, `db:check`, tests, build) | — | **exit 0** (log: `R10A_evidence/gate-logs/r10-check.txt`) |
| Full PGlite suite | 4,549 | **4,549 passed** (68 skipped, 2 todo) |
| Full PostgreSQL 16.15 ICU suite (cluster `16/icu`) | 5,694 | **5,694 passed** (1 skipped, 4 todo), exit 0 |
| Chromium suite (`pnpm test:browser`) | 52 | **52 passed**, exit 0 |
| `git diff --check 8b1c047…336a52e` | clean | **clean** |
| Old migrations unmodified | — | diff adds only `0025_m7_interview_records.sql`, `meta/0025_snapshot.json`, and an appended `_journal.json` entry |
| Focused author M7 tests (unmutated control) | — | 134 passed (PGlite + PG16) |

The full PostgreSQL/PGlite/Chromium suites were run once on pristine source and were not repeated after the mutation work.

## 3. What was independently verified

Reviewer tests are in `R10A_evidence/reviewer-tests/`. **135 reviewer tests pass across 9 files** (each on PGlite and PG16 where applicable) when run serially, plus **9 browser steps**. Log: `gate-logs/r10-reviewer-suite-final.txt`.

> **Harness note.** Reviewer files each drop and recreate the same disposable PostgreSQL database, so they must run serially (`--no-file-parallelism`, or set `TEST_DATABASE_URL`, which the repo config treats as serial). A parallel run produced 7 spurious failures from files clobbering each other's database; the serial run is clean. This is a property of my harness, not of M7.

### 3.1 Milestone boundaries (area 1)
- M5/M6 data is untouched by recording: a row-level digest of 42 pre-existing tables is identical before/after recording (T2, T6), and the assessment and question-set read models are byte-identical.
- No `evidence_items` row with origin `team_answer` or `judge_observation`, and none at `judge_verified`/`live_verified`, ever exists after recording all four outcomes.
- The interview code (store, service, routes, schema) imports nothing from the graph, scoring, LLM, prompts or worker layers.
- The graph still refuses interview origins and unreachable verification levels: a forged copy of a real `evidence_items` row is **accepted unchanged (positive control)**, and refused when only `origin` is `team_answer`/`judge_observation` or only the level is `judge_verified`/`live_verified` (SQLSTATE 23514, with named constraints).

### 3.2 Database provenance (area 2)
Project with **two verified assessments, each with its own question set** (built through the real pipelines). 34 provenance tests on both engines:
- Via the API: another project, another assessment of the same project, another assessment's set, a different set's question, an answer to a different question, an answer from another assessment, forged ids, a different actor → refused (404/422) with **zero side effects**.
- Via direct SQL: each crossing is refused by the composite FK or CHECK, each with a committing positive control.
- Privileged tampering (a superuser disabling a trigger) can rewrite a record. That is documented, outside the application path, and distinguished from the service behaviour.

### 3.3 Immutability and corrections (area 3)
- UPDATE, DELETE and TRUNCATE are refused on both tables. A direct insert with a forged `created_at` of 2001 is re-stamped by the database clock; a client-supplied timestamp is a 400.
- **TRUNCATE attribution (verified rather than assumed).** Plain `TRUNCATE team_answers` is refused by PostgreSQL's own FK rule (0A000); the append-only trigger (23001) refuses `judge_observations`, every `CASCADE` form and the multi-table form.
- Corrections append; the original row is **byte-identical** afterwards; a second correction of the same record is `409 INTERVIEW_ALREADY_CORRECTED`, and a direct SQL fork hits the unique key; the chain is linear with exactly one `isCurrent`; both recording identities are recoverable from the chain and from the audit events.

**Special probe — observation corrections.** An observation correction is FK-bound only to the same project and assessment, so it can change the linked question and answer, or detach to standalone. Demonstrated: a chain `Q0 + linked answer → Q1 → standalone` is accepted (201 ×3), the history stays intact, and afterwards **no *current* observation remains for Q0 or Q1**. *Assessment:* this does **not** violate the documented contract. `V1_CONTRACT.md:97` requires only that a correction names what it supersedes and the original stays, and the M7 report's FK table states the observation correction key openly as `(project, assessment)`. It is a documentation wording issue (the headline says "same question", true for answers only) and an M8 hand-off condition — see P3-1 and §9. Answers cannot be retargeted (422 `INTERVIEW_TARGET_MISMATCH`).

**Cross-recorder corrections.** Judge B and an organizer can correct judge A's observation; the new row carries the corrector's identity and role, and the audit event's actor is the corrector. The original keeps its recorder. This is auditable but means "the head of a chain" may not be authored by the person who recorded the original (P3-5).

### 3.4 Real PostgreSQL 16 concurrency, HTTP level (area 4)
One 40-connection pool, requests racing through Fastify; exact record and audit counts:

| # | Scenario | Result |
|---|---|---|
| A | 20 identical answers | **1 record, 1 audit event**; one `201` + nineteen `200` returning the same id |
| B | same key, different text (20 racing, 10 texts) | **1 record, 1 audit**; 18× `409 IDEMPOTENCY_KEY_REUSED`; 0 text leaks in errors |
| C | same key, different question / other assessment's set / observation | **1 answer + 1 observation**; 12× `409`; audit = records; no 5xx |
| D | 20 identical observations | **1 record, 1 audit**; `201`×1 + `200`×19 |
| E | 12 conflicting corrections (answers and observations, 4 credentials) | exactly **1 winner each** (`201`), 11× `409 INTERVIEW_ALREADY_CORRECTED`, successor count 1, one `isCurrent` per chain, 2 corrected-audit events |
| F | response lost after commit, retried (answer, observation, correction) | `201` then `200`, identical body, no new record or audit |
| G | void racing submissions | all outcomes `201` or `409 PROJECT_VOIDED`; records = audit = number of `201`s; **no record stamped after the void**; no 5xx. A second variant with staggered submissions exercised the mixed outcome in one of four rounds (2 created / 38 refused) |
| H | retry of an earlier success after a void | replay `200`; new keys `409 PROJECT_VOIDED` (answer, observation, correction); different-content key reuse `409`; counts unchanged; reads still `200` |

Error bodies never contained typed text; audit metadata contains identifiers, action, role and outcome only.

### 3.5 Authentication, authorization and actor provenance (area 5)
- Matrix (GET / answer / observation): no token and garbage token → `401`; no roles → `403`; judge, organizer and dual-role → `200/201/201`. Refusals write nothing.
- Actor and role are derived only from the credential: `judge-a/judge`, `judge-b/judge`, `organizer-1/organizer`, `both-1/judge` (a dual-role credential is recorded as `judge`).
- Idempotency keys are scoped per actor: judge B reusing judge A's key with A's text gets `409`, not A's record.
- 25 forged body fields × 2 endpoints (actor ids, roles, timestamps, record ids, project/assessment/question ids, scores, verification levels, origins, evidence/source/snapshot ids, provider/model/instructions, request hash, a raw JSON `__proto__`/`constructor.prototype`) → all `400`, nothing written. **Forging a real, existing actor's id on both endpoints** (10 attempts) → all `400`, nothing written. Actor/role headers (`x-actor-id`, `x-forwarded-user`, `x-role`…) are ignored.
- Idempotency-Key: missing, empty, malformed, brace-wrapped, oversized, an array of two → `400`, nothing written; any-case UUID works; surrounding whitespace is stripped by HTTP (RFC 9110) and is valid.

### 3.6 Usable workflow in Chromium (area 6)
Independent journey against the production web build, the real API and a two-assessment project (screenshots: `R10A_evidence/screenshots/`):
- **J1** report → suggested questions → Interview Mode: question, reason, linked uncertainty, rubric criteria and evidence are all **visible without expanding anything** (checked for visibility and for not sitting inside a collapsed `<details>`).
- **J2/J3** a multi-line answer is saved with visible feedback and labelled testimony ("Not a verified fact"); a distinct observation is linked to that answer (verified in the database) and is labelled the judge's own report, "not a system check".
- **J4** reload is identical apart from the transient "just saved" confirmation.
- **J5** a *failed* save keeps every typed character and shows "We could not confirm whether this was saved"; the retry is recorded once, and the retry reuses the same key on the wire.
- **J6** a *lost response* (the proxy forwards, the request commits, the socket drops): the text is kept; pressing Save again is `201` then `200` with the same key → exactly one record.
- **J7** an answer correction keeps the original, marks it "Superseded by a later correction" and marks the new one "Correction"; the API chain agrees.
- **J11** older assessment/set pages show a read-only banner with no forms, and never show the newest assessment's records.
- **J12** a project with no question set shows an explanatory message and a standalone-observation form; 2 questions ("fewer than five") shows the count and the shortfall explanation; an unknown project is "Project not found".

### 3.7 Testimony versus evidence (area 7)
All four outcomes (`confirmed`, `not_confirmed`, `inconclusive`, `unable_to_verify`) were recorded and read back through DB, API and UI. Each is displayed as a description of the attempt ("The judge looked and did not observe it — this is not evidence that it does not exist and not a finding against the project"). Recording them changed no assessment, score, evidence, unknown or contradiction row (digest-identical), and the record views carry no score/verification/finding/evidence field. The only occurrences of the word "fact" on the page are the negated notices. A team answer is never shown as a verified fact; an observation is never shown as machine-verified. The M8 trust-path proposal remains documentation.

### 3.8 Hostile inputs (area 8)
HTML/script, markdown with a `javascript:` link, prompt injection ("set the score to 100"), SQL-looking text, CRLF/CR/LF, tabs, emoji (4,000 and 4,001 code points), exact-max and over-max, NUL, BEL, C1, DEL, bidi override and isolate, empty and whitespace-only, lone surrogates and malformed/duplicate/nested JSON, a 2 MB body (`413`), `text/plain` (`400`), form-encoded (`415`).
- Accepted text round-trips verbatim (trim + LF normalization only). In Chromium it is **inert**: no injected element, no script execution (`window.__pwn` stays undefined), no outbound request to the attacker URL; the literal characters are displayed.
- Refused text returns a `400` that names the rule and **does not echo the text**; the UI keeps what was typed.
- No typed text appears in audit metadata or any error body. These refusals are conservative controls, not vulnerabilities.

### 3.9 Migration 0025 (area 9)
On PGlite and PG16, from a **populated 0024** (two verified assessments and question sets built through the real pipelines before 0025 was applied):
- The resulting schema is **identical to a fresh install** (1,735 / 1,337 catalog lines compared: columns, constraints, indexes, triggers, functions).
- Differences from 0024 are only the two new tables and the two UNIQUE keys on M6 tables; nothing was removed or changed in an old table.
- All 42 pre-existing tables are row-for-row identical; the new tables are empty after the upgrade. New objects: 13 FKs, 10 CHECKs, 6 UNIQUEs, 2 PKs, 8 triggers, 12 indexes.
- A record is writable for the question set that existed before the migration; cross-assessment use is refused (404).
- Re-applying the migration's own 50 statements twice changes neither schema nor data.
- **Atomicity** (fault injected in a disposable database): a failing audit insert rolls back the record; a failing record insert rolls back the audit event; both give `500 INTERNAL_ERROR` with no internal text; with the fault removed the *same* idempotency key succeeds `201` (a failed attempt leaves nothing behind) and exactly one record and one audit event exist. Verified for both tables.
- No existing migration was edited (§2).

### 3.10 An assessment that stops verifying
With the report mirror tampered (triggers disabled, administrator action), both POSTs return `409 ASSESSMENT_NOT_VERIFIED`, the GET returns `assessmentVerified:false` with no records and none of the stored text, and nothing is written.

## 4. Mutation testing (area 10)

21 mutants: each is one targeted edit in the disposable clone a disposable clone, followed by the author's focused M7 tests (134 tests) and then my reviewer tests (131 tests on the database/API side, and 23 author UI unit tests plus my 9 Chromium steps on the UI side), then restored. A mutant counts as **killed only if a test fails because of the mutation**; every suite was green on unmutated source immediately beforehand (controls: author 134/134, reviewer 131/131, UI unit 23/23, browser 9/9).

| ID | Mutation (one edit in a disposable clone, restored afterwards) | Author tests | Reviewer tests | Classification |
|---|---|---|---|---|
| M1a | remove composite FK team_answers_question_in_set_fk (question must belong to the set) | killed | killed | Killed by both suites |
| M1b | remove composite FK team_answers_assessment_same_project_fk | **survived** | **survived** | Equivalent mutant |
| M1c | remove composite FK judge_observations_team_answer_same_question_fk (linked answer must be of the same question) | killed | killed | Killed by both suites |
| M1d | remove composite FK team_answers_set_same_assessment_fk (set must belong to the assessment) | killed | killed | Killed by both suites |
| M1e | remove composite FK judge_observations_assessment_same_project_fk | killed | killed | Killed by both suites |
| M1f | remove composite FK team_answers_supersedes_same_question_fk (answer correction must be of the same question) | killed | killed | Killed by both suites |
| M1g | remove composite FK judge_observations_supersedes_same_assessment_fk (observation correction stays in the assessment) | killed | killed | Killed by both suites |
| M2a | remove append-only trigger on team_answers | killed | killed | Killed by both suites |
| M2b | remove append-only trigger on judge_observations | killed | killed | Killed by both suites |
| M2c | remove no-truncate trigger on team_answers | **survived** | killed | Behaviourally equivalent; author coverage gap (structural only) |
| M3a | remove the void guard on team_answers | killed | killed | Killed by both suites |
| M3b | remove the void guard on judge_observations | killed | killed | Killed by both suites |
| M4a | disable correction uniqueness on team_answers | killed | killed | Killed by both suites |
| M4b | disable correction uniqueness on judge_observations | killed | killed | Killed by both suites |
| M5 | allow a forged actor: the answer request accepts actorId and the service records it | killed | killed | Killed by both (reviewer test strengthened) |
| M6a | skip the assessment-verification check on answers | killed | killed | Killed by both suites |
| M7 | disable the idempotency conflict check (same key, different content replays) | killed | killed | Killed by both suites |
| M8 | put the typed answer into the audit metadata | killed | killed | Killed by both suites |
| M9 | mark testimony as verified evidence in the UI | **survived** | killed | Actual coverage gap in the AUTHOR suite (P3); killed by reviewer |
| M10 | hide the linked uncertainty from the UI | killed | killed | Killed by both suites |
| M11 | lose the typed values after a failed save | killed | killed | Killed by both suites |

**Totals:** 20 of 21 killed by at least one suite. Reviewer tests killed 20/21 (all but the equivalent M1b); author tests killed 18/21 (all but M1b, M2c and M9).

**Classification of every survivor (no survivor is a demonstrated product defect):**

- **M1b** — *Equivalent mutant.* Transitively implied: `team_answers_set_same_assessment_fk` pins (set, project, assessment) to a question-set row, and M6 migration 0022 `question_sets_assessment_same_project_fk` already ties that assessment to the project. All 34 T1 crossing attacks still pass with this FK removed (reviewer column). Defence in depth, not a gap.
- **M2c** — *Behaviourally equivalent; author coverage gap (structural only).* Every TRUNCATE that reaches `team_answers` must also include or cascade to `judge_observations` (it references it), whose own no-truncate trigger is intact; plain `TRUNCATE team_answers` is stopped by PostgreSQL's FK rule (0A000). Only my structural trigger inventory (T7) detects the missing trigger. No demonstrated defect.
- **M9** — *Actual coverage gap in the AUTHOR suite (P3); killed by reviewer.* The per-question testimony label can be changed to "Verified evidence recorded by the judge" and every author UI unit test still passes, because the page-level notice and form hint still say "not a verified fact". My Chromium journey asserts the section label and that the answer block never reads as verified/corroborated. Not a product defect: the shipped label is correct.
- **M5** — *Reviewer coverage gap, found and fixed during this review.* My first forged-actor test used a random UUID, which the mutant rejected via an FK failure, so the assertion held by accident (author suite killed it). Strengthened to forge a REAL existing actor id on both endpoints (10 attempts, all 400, nothing written); re-run: killed by both. Not a product defect.

Coverage of the eleven required mutation classes: composite FK removed (7 variants), append-only protection removed (3), void guard removed (2), correction uniqueness disabled (2), forged actor allowed (1), verification check skipped (1), idempotency conflict check disabled (1), typed answer into audit metadata (1), testimony marked verified (1), linked uncertainty hidden (1), form values lost after a failed save (1).

Limits of the mutation work: M6a and M8 were applied to the *answer* path only (the observation path has the parallel code but was not mutated separately); the mutation set is targeted, not exhaustive.

## 5. Shared web credential — deployment readiness

The web tier forwards **one server-side credential (`JUDGE_API_TOKEN`) for every visitor** and has no per-user login. The API itself is correct: it attributes every record to the authenticated credential, so anyone with their own credential calling the API is attributed correctly. Through the web UI, **"who recorded it" is the identity of that one credential**, not of the person at the keyboard. This is documented (`docs/SECURITY.md` §10, the M7 report §"One web credential", `README.md`: the web app binds `127.0.0.1` and exposing it further is unsupported).

- M7 is acceptable for a **single trusted operator on a local machine**, which is what the contract's deployment posture supports.
- It is **not** acceptable as the basis for multi-judge attribution or any trust decision. Per-user authentication/session is a hard prerequisite before records may be treated as attributable to individuals, and before any `judge_verified`/`live_verified` level could exist.
- The Interview page does not itself tell the judge that "by judge-a (judge)" is the deployment credential (P3-4).

I did not reject M7 for lacking per-user web login, as instructed.

## 6. P3 observations (accepted limitations; not new implementation tasks)

| ID | Observation | Evidence | Disposition |
|---|---|---|---|
| P3-1 | Observation corrections may change the question/answer link (or detach to standalone). The M7 report's FK table says `(project, assessment)` openly, but its headline and ARCHITECTURE §M7 say corrections are "of the same question", true only for answers. The superseded record leaves its question and **no current observation remains** on the original question. History is complete. | T2 probe, both engines | Documentation wording; **M8 must define chain identity** (root vs head) and read whole chains |
| P3-2 | The UI offers corrections for **answers only**. The observation form accepts `supersedesObservationId`, but no control renders it, so a wrongly entered observation can be corrected only via the API (or contradicted by a new one, leaving two current). | J8 (0 controls) | Usability gap; contract requires the data model and API, not an observation-correction UI |
| P3-3 | The UI makes older assessments/question sets read-only ("new interview records are added to the newest assessment"), but the API accepts records for any verified assessment/set of the project. Records land on the correct assessment and are shown on that assessment's page. | J11: API `201`; old page shows the record | Intentional UI policy (`READ_ONLY_REASONS`), not enforced by the API; M8 must select by explicit assessment, never "latest" |
| P3-4 | The page shows "Saved … by judge-a (judge)" without saying that this is the deployment's shared credential. | J13: no credential wording on the page | Documented in SECURITY §10; see §5 |
| P3-5 | `recorded_as_role` is derived from the credential at write time and is not independently verified; a dual-role credential is recorded as `judge`; an organizer or another judge may correct someone else's record (identities and audit actor are recorded). | T4, T2 | **Must not be treated as a verified judge identity by M8** |
| P3-6 | Idempotency keys are unique per (actor, table), not across tables: one key can create one answer and one observation. | T3-C | Benign; each endpoint's own contract holds |
| P3-7 | The forbidden-text set (read from `packages/schemas/src/interview.ts`) covers controls, C1 and bidi overrides/isolates, but not e.g. LRM/RLM, zero-width space or U+2028/2029. I did **not** exercise these; React renders text inertly. | Source reading only | Note for any non-React consumer (e.g. an M8 prompt builder) |
| P3-8 | Author-suite gaps: M2c (structural trigger inventory only) and M9 (per-question testimony label unasserted). Both are killed by the reviewer tests. | §4 | Optional test additions |
| P3-9 | Plain `TRUNCATE team_answers` is stopped by PostgreSQL's FK rule, not the append-only trigger (the trigger covers all other forms). | T2b | Documentation nuance |
| P3-10 | Several *current* observations can exist for one question (they are not chained unless corrected). | T2, T6 | M8 must aggregate, not assume one |

## 7. Limitations of this review
- In the HTTP-level concurrency tests, "response lost" (F) discards a completed response and retries; the real dropped-socket case is exercised only in Chromium (J6) through the forwarding proxy.
- The void-race interleaving where submissions beat the void occurred in one of four staggered rounds (the author's store-level test also covers both orders); counts were exact in all.
- Mutation coverage is targeted (§4 limits). The web build was exercised on PGlite, not PostgreSQL.
- No live models were called and none were authorised. The 2-question set came from the offline scripted demonstration.
- The reviewer tests are not type-checked against the repo's strict config (they live outside the repo); they were run, not linted.

## 8. Restoration of pristine source
After the last mutant the clone was verified: `HEAD = 336a52e1a30d0a757bd2099c8db26f25fb7babe7`, `git diff` over tracked files is **empty**, only the reviewer's untracked `tests/r10/` and `vitest.r10browser.config.ts` exist, the web build was re-run on pristine source, and the final reviewer suite (135) and browser journey (9) pass on it. The separate gate clone (full gates) was never mutated.

## 9. M8 hand-off conditions (documentation, not tasks)
M8 may begin design under its own reviewed trust-boundary contract. That contract must:
1. Define the identity of an observation chain (root vs head) and consume whole chains, because corrections can retarget (P3-1) and several observations per question can be current (P3-10).
2. Treat `recorded_as_role`/`recorded_by` as **unverified assertions** until per-user authentication exists (P3-4, P3-5); do not derive `judge_verified` from them.
3. Select records by explicit assessment id and question set, never "latest" (P3-3).
4. Treat answer and observation text as hostile data in any prompt (P3-7) and keep model use behind the existing offline/live gate — **live models remain not authorised.**
5. Keep the evidence-graph refusal of `team_answer`/`judge_observation` and the unreachable verification levels until that contract is approved.

## 10. Evidence index (all under `R10A_evidence/`)
`gate-logs/` full gate logs (check, PG16, Chromium, diff-check, final reviewer suite) · `reviewer-tests/` all reviewer tests and harness (`env.ts`, `t1`–`t8`) · `scripts/` the gate script, mutation drivers, browser config · `mutations/` `results.json`, run logs and `mutant-run-artifacts/` · `screenshots/` 12 clean-run screenshots · `browser-report.json` rendered-output checks · `inventory-new-objects-*.txt` the new-object catalogs.

---

```
R10A: PASS
INTERVIEW_CAPTURE: PASS
IMMUTABILITY_AND_IDEMPOTENCY: PASS
AUTHORIZATION_AND_PROVENANCE: PASS
M7_ACCEPTANCE: ACCEPTED
M8_READINESS: READY
LIVE_MODEL_READINESS: NOT AUTHORIZED
```

**Recommendation:** close M7 and begin M8 *design* under a separately reviewed trust-boundary contract (§9). Do not enable live models, per-user trust, or any verification level on the strength of M7 records.
