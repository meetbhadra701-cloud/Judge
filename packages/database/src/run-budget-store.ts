import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type {
  AssessmentRunLimits,
  AssessmentStage,
  BudgetDenialReason,
  CallState,
  ProviderMode,
  UsageBasis,
} from '@judge-copilot/schemas';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { JudgeDatabase } from './client.js';
import { analysisRuns, assessmentRunBudget, assessmentRunCalls } from './schema/index.js';

/*
 * The database-backed LOCAL SPENDING GUARD of one assessment run (M5 P4, design §12.4). It implements the same `RunBudget` contract as
 * `packages/llm`'s in-memory ledger (structurally: the contract tests in tests/integration run the llm suite against this class), and
 * it is a software guard in this application, NOT a provider billing limit.
 *
 *   reserve   one short transaction: `SELECT ... FOR UPDATE` on the run's budget row serializes every reserve/settle of the run, the
 *             counted totals are DERIVED from the ledger rows under that lock, the first crossed limit denies, otherwise the attempt
 *             is inserted `reserved` (the insert trigger re-checks the same limits as a backstop). Nothing is held while a model runs.
 *   settle    `reserved` -> `settled` (the provider's MEASURED usage), `released` (provably never sent: tokens and cost are freed but
 *             the attempt still counts) or `unknown` (ambiguous: the FULL reservation stays counted).
 *
 * Money is exact integer NANO-USD, the unit of the model port: nothing is converted or rounded. The model's JSON answer is retained as
 * bounded canonical text (jsonb would not preserve key order or numeric text). Prompts, system text, schemas, headers and credentials
 * are never passed to this class.
 */

export const MAX_RECORDED_RESPONSE_BYTES = 262_144;

export interface ReservationBoundsLike {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

export interface ReserveRequestLike {
  readonly stage: string;
  readonly model: string;
  readonly requestDigest: string;
  readonly bounds: ReservationBoundsLike;
}

export interface UsageLike {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type SettlementLike =
  | {
      readonly kind: 'measured';
      readonly usage: UsageLike;
      readonly outcomeCode: string;
      readonly responseHash: string | null;
      readonly responseJson?: unknown;
    }
  | { readonly kind: 'released'; readonly outcomeCode: string }
  | { readonly kind: 'unknown'; readonly outcomeCode: string };

export type ReserveOutcomeLike =
  | { readonly ok: true; readonly callId: number }
  | { readonly ok: false; readonly denial: BudgetDenialReason };

export interface LedgerEntryLike {
  readonly callId: number;
  readonly stage: string;
  readonly model: string;
  readonly requestDigest: string;
  readonly attempt: number;
  readonly state: CallState;
  readonly reservation: ReservationBoundsLike;
  readonly usageBasis: UsageBasis | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costNanoUsd: number | null;
  readonly outcomeCode: string | null;
  readonly responseHash: string | null;
  readonly responseJson: unknown;
  readonly responseRecord: 'stored' | 'too_large' | 'unserializable' | 'none';
  readonly responseBytes: number | null;
  readonly boundViolation: boolean;
}

interface TotalsLike {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

export interface BudgetSnapshotLike {
  readonly limits: AssessmentRunLimits;
  readonly settled: TotalsLike;
  readonly unknown: TotalsLike;
  readonly reserved: TotalsLike;
  readonly releasedCalls: number;
  readonly attemptsStarted: number;
  readonly boundViolations: number;
}

/** Turns a measured usage into the counted usage; null when the model cannot be priced (the reservation is then counted instead). */
export type MeasureUsage = (
  model: string,
  usage: UsageLike,
) => { inputTokens: number; outputTokens: number; costNanoUsd: number } | null;

/** Everything about a call that is NOT a secret and that P5 needs to validate its answer. Bound by the request digest. */
export interface CallMetadata {
  readonly provider?: string;
  readonly providerMode?: ProviderMode;
  readonly promptId?: string;
  readonly promptVersion?: string;
  readonly promptTemplateHash?: string;
  readonly schemaId?: string;
  readonly schemaVersion?: string;
  readonly generationSettings?: Record<string, unknown>;
  /** The closed set the renderer returned for this exact request (handles only). */
  readonly closedSet?: Record<string, unknown>;
}

export interface CallBinding {
  readonly callId: number;
  readonly stage: AssessmentStage;
  readonly requestDigest: string;
  readonly closedSet: Record<string, unknown>;
  readonly closedSetHash: string;
}

export interface DatabaseRunBudgetOptions {
  readonly db: JudgeDatabase;
  readonly runId: string;
  readonly measure: MeasureUsage;
  /** Wall clock in ms; defaults to Date.now. */
  readonly nowMs?: () => number;
  /** Test seam: awaited between the limit check and the insert, to force interleavings. The row lock makes it harmless. */
  readonly betweenCheckAndHold?: () => Promise<void>;
}

type Executor = JudgeDatabase;

/** The binding digest of a call's closed set: the stage, the exact request digest and the handles together. */
export function closedSetHash(stage: string, requestDigest: string, closedSet: unknown): string {
  return sha256Hex(canonicalJson({ stage, requestDigest, closedSet }));
}

export class BudgetDeniedBackstopError extends Error {
  constructor(readonly reason: string) {
    super(`assessment budget denied: ${reason}`);
    this.name = 'BudgetDeniedBackstopError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class DatabaseRunBudget {
  private readonly db: JudgeDatabase;
  private readonly runId: string;
  private readonly measure: MeasureUsage;
  private readonly nowMs: () => number;
  private readonly between: (() => Promise<void>) | undefined;
  private readonly metadata = new Map<string, CallMetadata>();

  constructor(options: DatabaseRunBudgetOptions) {
    this.db = options.db;
    this.runId = options.runId;
    this.measure = options.measure;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.between = options.betweenCheckAndHold;
  }

  /**
   * Registers the (non-secret) metadata and the closed set of the request with digest `requestDigest`. The next `reserve` with that
   * digest stores them in the ledger row, together with a hash that binds them to the stage and the digest. The caller cannot attach
   * the handles of another call: the stored hash covers (stage, digest, closed set), and `bindingOf` recomputes it.
   */
  register(requestDigest: string, metadata: CallMetadata): void {
    this.metadata.set(requestDigest, metadata);
  }

  async reserve(request: ReserveRequestLike): Promise<ReserveOutcomeLike> {
    return this.db.transaction(async (tx) => {
      const limits = await this.lockBudget(tx);
      const totals = await this.totals(tx);
      const denial = this.denialFor(limits, totals, request.bounds);
      await this.between?.();
      if (denial) return { ok: false, denial } as const;
      const meta = this.metadata.get(request.requestDigest);
      const closedSet = meta?.closedSet ?? null;
      try {
        const [row] = await tx
          .insert(assessmentRunCalls)
          .values({
            runId: this.runId,
            seq: 0, // assigned by the insert trigger
            stage: request.stage as AssessmentStage,
            attempt: 1, // assigned by the insert trigger
            model: request.model,
            provider: meta?.provider ?? null,
            providerMode: meta?.providerMode ?? null,
            requestDigest: request.requestDigest,
            promptId: meta?.promptId ?? null,
            promptVersion: meta?.promptVersion ?? null,
            promptTemplateHash: meta?.promptTemplateHash ?? null,
            schemaId: meta?.schemaId ?? null,
            schemaVersion: meta?.schemaVersion ?? null,
            generationSettings: meta?.generationSettings ?? null,
            closedSet,
            closedSetHash:
              closedSet === null
                ? null
                : closedSetHash(request.stage, request.requestDigest, closedSet),
            reservedInputTokens: request.bounds.inputTokens,
            reservedOutputTokens: request.bounds.outputTokens,
            reservedCostNanoUsd: request.bounds.costNanoUsd,
            state: 'reserved',
          })
          .returning({ seq: assessmentRunCalls.seq });
        if (!row) throw new Error('internal: the ledger insert returned no row');
        return { ok: true, callId: row.seq } as const;
      } catch (error) {
        const hint = backstopReason(error);
        if (hint !== null) throw new BudgetDeniedBackstopError(hint);
        throw error;
      }
    });
  }

  async settle(callId: number, settlement: SettlementLike): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockBudget(tx);
      const [row] = await tx
        .select()
        .from(assessmentRunCalls)
        .where(and(eq(assessmentRunCalls.runId, this.runId), eq(assessmentRunCalls.seq, callId)))
        .for('update');
      if (row?.state !== 'reserved') {
        throw new Error('settlement of a call that is not reserved');
      }
      const unknown = () =>
        tx
          .update(assessmentRunCalls)
          .set({
            state: 'unknown',
            usageBasis: 'unknown_reserved',
            inputTokens: row.reservedInputTokens,
            outputTokens: row.reservedOutputTokens,
            costNanoUsd: row.reservedCostNanoUsd,
            outcomeCode: settlement.outcomeCode,
          })
          .where(and(eq(assessmentRunCalls.runId, this.runId), eq(assessmentRunCalls.seq, callId)));
      if (settlement.kind === 'released') {
        await tx
          .update(assessmentRunCalls)
          .set({ state: 'released', outcomeCode: settlement.outcomeCode })
          .where(and(eq(assessmentRunCalls.runId, this.runId), eq(assessmentRunCalls.seq, callId)));
        return;
      }
      if (settlement.kind === 'unknown') {
        await unknown();
        return;
      }
      const counted = this.measure(row.model, settlement.usage);
      // A model that cannot be priced cannot be measured: count the reservation instead of guessing zero.
      if (!counted) {
        await unknown();
        return;
      }
      const response = recordResponse(settlement.responseJson);
      await tx
        .update(assessmentRunCalls)
        .set({
          state: 'settled',
          usageBasis: 'measured',
          inputTokens: counted.inputTokens,
          outputTokens: counted.outputTokens,
          costNanoUsd: counted.costNanoUsd,
          outcomeCode: settlement.outcomeCode,
          responseHash: settlement.responseHash,
          responseRecord: response.state,
          responseCanonical: response.canonical,
          responseBytes: response.bytes,
        })
        .where(and(eq(assessmentRunCalls.runId, this.runId), eq(assessmentRunCalls.seq, callId)));
    });
  }

  async snapshot(): Promise<BudgetSnapshotLike> {
    return this.db.transaction(async (tx) => {
      const limits = await this.lockBudget(tx);
      const rows = await tx
        .select({
          state: assessmentRunCalls.state,
          calls: sql<number>`count(*)`.mapWith(Number),
          input:
            sql<number>`coalesce(sum(coalesce(${assessmentRunCalls.inputTokens}, ${assessmentRunCalls.reservedInputTokens})), 0)`.mapWith(
              Number,
            ),
          output:
            sql<number>`coalesce(sum(coalesce(${assessmentRunCalls.outputTokens}, ${assessmentRunCalls.reservedOutputTokens})), 0)`.mapWith(
              Number,
            ),
          cost: sql<number>`coalesce(sum(coalesce(${assessmentRunCalls.costNanoUsd}, ${assessmentRunCalls.reservedCostNanoUsd})), 0)`.mapWith(
            Number,
          ),
          violations:
            sql<number>`count(*) filter (where ${assessmentRunCalls.boundViolation})`.mapWith(
              Number,
            ),
        })
        .from(assessmentRunCalls)
        .where(eq(assessmentRunCalls.runId, this.runId))
        .groupBy(assessmentRunCalls.state);
      const pick = (state: CallState): TotalsLike => {
        const row = rows.find((candidate) => candidate.state === state);
        return {
          calls: row?.calls ?? 0,
          inputTokens: row?.input ?? 0,
          outputTokens: row?.output ?? 0,
          costNanoUsd: row?.cost ?? 0,
        };
      };
      const settled = pick('settled');
      const unknown = pick('unknown');
      const reserved = pick('reserved');
      const releasedCalls = rows.find((row) => row.state === 'released')?.calls ?? 0;
      return {
        limits,
        settled,
        unknown,
        reserved,
        releasedCalls,
        attemptsStarted: settled.calls + unknown.calls + reserved.calls + releasedCalls,
        boundViolations: rows.reduce((sum, row) => sum + row.violations, 0),
      };
    });
  }

  async entries(): Promise<readonly LedgerEntryLike[]> {
    const rows = await this.db
      .select()
      .from(assessmentRunCalls)
      .where(eq(assessmentRunCalls.runId, this.runId))
      .orderBy(asc(assessmentRunCalls.seq));
    return rows.map((row) => ({
      callId: row.seq,
      stage: row.stage,
      model: row.model,
      requestDigest: row.requestDigest,
      attempt: row.attempt,
      state: row.state,
      reservation: {
        inputTokens: row.reservedInputTokens,
        outputTokens: row.reservedOutputTokens,
        costNanoUsd: row.reservedCostNanoUsd,
      },
      usageBasis: row.usageBasis,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costNanoUsd: row.costNanoUsd,
      outcomeCode: row.outcomeCode,
      responseHash: row.responseHash,
      responseJson:
        row.responseRecord === 'stored' && row.responseCanonical !== null
          ? deepFreeze(JSON.parse(row.responseCanonical) as unknown)
          : null,
      responseRecord: row.responseRecord,
      responseBytes: row.responseBytes,
      boundViolation: row.boundViolation,
    }));
  }

  /** Turns every still-`reserved` attempt into `unknown` (a crashed worker's lease expiring). Returns how many. */
  async reapInFlight(): Promise<number> {
    return this.db.transaction(async (tx) => {
      await this.lockBudget(tx);
      return reapReservedCalls(tx, this.runId, 'lease_expired');
    });
  }

  /**
   * The closed set and request digest of one recorded call, re-verified against the hash stored with it. P5 reads the set from here
   * (by call id), never from its own memory, so one call's handles cannot be substituted for another's.
   */
  async bindingOf(callId: number): Promise<CallBinding | null> {
    const [row] = await this.db
      .select()
      .from(assessmentRunCalls)
      .where(and(eq(assessmentRunCalls.runId, this.runId), eq(assessmentRunCalls.seq, callId)));
    if (!row?.closedSet || !row.closedSetHash) return null;
    if (closedSetHash(row.stage, row.requestDigest, row.closedSet) !== row.closedSetHash) {
      throw new Error('internal: a stored closed set does not match its binding hash');
    }
    return {
      callId,
      stage: row.stage,
      requestDigest: row.requestDigest,
      closedSet: row.closedSet,
      closedSetHash: row.closedSetHash,
    };
  }

  // -- internals -----------------------------------------------------------------------------------------------------------

  private async lockBudget(tx: Executor): Promise<AssessmentRunLimits & { startedAtMs: number }> {
    const [budget] = await tx
      .select()
      .from(assessmentRunBudget)
      .where(eq(assessmentRunBudget.runId, this.runId))
      .for('update');
    if (!budget) throw new Error('the run has no budget row');
    // the wall clock runs from the moment the run was CLAIMED, not from when it was queued
    const [run] = await tx
      .select({ startedAt: analysisRuns.startedAt })
      .from(analysisRuns)
      .where(eq(analysisRuns.id, this.runId));
    return {
      maxCalls: budget.maxCalls,
      maxInputTokens: budget.maxInputTokens,
      maxOutputTokens: budget.maxOutputTokens,
      maxCostNanoUsd: budget.maxCostNanoUsd,
      maxReservedInputTokensPerCall: budget.maxReservedInputTokensPerCall,
      runWallClockMs: budget.runWallClockMs,
      startedAtMs: (run?.startedAt ?? new Date()).getTime(),
    };
  }

  /** Counted totals (settled + unknown + reserved), plus every attempt started, derived from the ledger. */
  private async totals(tx: Executor) {
    const [row] = await tx
      .select({
        attempts: sql<number>`count(*)`.mapWith(Number),
        input:
          sql<number>`coalesce(sum(case ${assessmentRunCalls.state} when 'reserved' then ${assessmentRunCalls.reservedInputTokens} when 'released' then 0 else ${assessmentRunCalls.inputTokens} end), 0)`.mapWith(
            Number,
          ),
        output:
          sql<number>`coalesce(sum(case ${assessmentRunCalls.state} when 'reserved' then ${assessmentRunCalls.reservedOutputTokens} when 'released' then 0 else ${assessmentRunCalls.outputTokens} end), 0)`.mapWith(
            Number,
          ),
        cost: sql<number>`coalesce(sum(case ${assessmentRunCalls.state} when 'reserved' then ${assessmentRunCalls.reservedCostNanoUsd} when 'released' then 0 else ${assessmentRunCalls.costNanoUsd} end), 0)`.mapWith(
          Number,
        ),
      })
      .from(assessmentRunCalls)
      .where(eq(assessmentRunCalls.runId, this.runId));
    return {
      attempts: row?.attempts ?? 0,
      input: row?.input ?? 0,
      output: row?.output ?? 0,
      cost: row?.cost ?? 0,
    };
  }

  /** The first limit this attempt's worst case would cross, in the same fixed order as the in-memory ledger. */
  private denialFor(
    limits: AssessmentRunLimits & { startedAtMs: number },
    totals: { attempts: number; input: number; output: number; cost: number },
    bounds: ReservationBoundsLike,
  ): BudgetDenialReason | null {
    if (this.nowMs() - limits.startedAtMs >= limits.runWallClockMs) return 'wall_clock';
    if (bounds.inputTokens > limits.maxReservedInputTokensPerCall) return 'per_call_input';
    // `maxCalls` limits ATTEMPTS STARTED: a released attempt keeps its slot.
    if (totals.attempts + 1 > limits.maxCalls) return 'calls';
    if (totals.input + bounds.inputTokens > limits.maxInputTokens) return 'input_tokens';
    if (totals.output + bounds.outputTokens > limits.maxOutputTokens) return 'output_tokens';
    if (totals.cost + bounds.costNanoUsd > limits.maxCostNanoUsd) return 'cost';
    return null;
  }
}

/** Reaps every reserved row of a run (caller holds the budget lock or the run lock). Returns how many. */
export async function reapReservedCalls(
  tx: Executor,
  runId: string,
  outcomeCode: string,
): Promise<number> {
  const reaped = await tx
    .update(assessmentRunCalls)
    .set({
      state: 'unknown',
      usageBasis: 'unknown_reserved',
      inputTokens: sql`${assessmentRunCalls.reservedInputTokens}`,
      outputTokens: sql`${assessmentRunCalls.reservedOutputTokens}`,
      costNanoUsd: sql`${assessmentRunCalls.reservedCostNanoUsd}`,
      outcomeCode,
    })
    .where(and(eq(assessmentRunCalls.runId, runId), eq(assessmentRunCalls.state, 'reserved')))
    .returning({ seq: assessmentRunCalls.seq });
  return reaped.length;
}

function recordResponse(answer: unknown): {
  state: 'stored' | 'too_large' | 'unserializable' | 'none';
  canonical: string | null;
  bytes: number | null;
} {
  if (answer === undefined) return { state: 'none', canonical: null, bytes: null };
  let canonical: string;
  try {
    canonical = canonicalJson(answer);
  } catch {
    return { state: 'unserializable', canonical: null, bytes: null };
  }
  // `JSON.stringify` yields undefined for values with no JSON form (a bare function or symbol).
  if (typeof canonical !== 'string')
    return { state: 'unserializable', canonical: null, bytes: null };
  const bytes = new TextEncoder().encode(canonical).length;
  if (bytes > MAX_RECORDED_RESPONSE_BYTES) return { state: 'too_large', canonical: null, bytes };
  // NUL cannot be stored in PostgreSQL text: treat it as not serializable rather than failing the whole settlement.
  if (canonical.includes('\u0000'))
    return { state: 'unserializable', canonical: null, bytes: null };
  return { state: 'stored', canonical, bytes };
}

export function backstopReason(error: unknown): string | null {
  for (let current = error; current instanceof Error; current = current.cause) {
    const hint = (current as { hint?: unknown }).hint;
    if (
      typeof hint === 'string' &&
      /^[a-z_]+$/.test(hint) &&
      /budget denied/.test(current.message)
    ) {
      return hint;
    }
    if (/assessment budget denied: ([a-z_]+)/.test(current.message)) {
      return /assessment budget denied: ([a-z_]+)/.exec(current.message)?.[1] ?? null;
    }
  }
  return null;
}
