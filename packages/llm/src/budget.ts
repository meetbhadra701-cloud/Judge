import { canonicalJson } from '@judge-copilot/context';
import type {
  AssessmentRunLimits,
  BudgetDenialReason,
  CallState,
  PriceTable,
  UsageBasis,
} from '@judge-copilot/schemas';
import type { Clock } from './clock.js';
import { costNanoUsd, inputTokensOf, priceFor, type ReservationBounds } from './pricing.js';
import type { Usage } from './types.js';

/*
 * The LOCAL SPENDING GUARD of one assessment run (docs/milestones/M5-design.md §12.4).
 *
 * It is software in this application that refuses to START a provider attempt when the computed total would
 * cross a configured limit. It is NOT a provider billing limit and cannot guarantee the provider's invoice:
 * price changes, tier boundaries, ambiguous failures and token-accounting differences are outside its reach.
 *
 * The protocol is reserve → call → settle, and every attempt (including each transient retry) is its own cycle:
 *
 *   reserve  atomically checks `settled + unknown + reserved + this attempt's worst case` against every limit and,
 *            only if all hold, records the reservation. Nothing is held while the model is called.
 *   settle   replaces the reservation with the provider's MEASURED usage (`measured`), frees it when the request
 *            provably never reached the provider (`released`), or keeps the FULL reservation counted when the
 *            outcome is ambiguous (`unknown`: a timeout after sending, an aborted stream, a crashed worker).
 *
 * The in-memory implementation serializes reserve/settle with a mutex, modelling the `SELECT ... FOR UPDATE`
 * row lock of the database-backed ledger (P4) behind the same port.
 */

/**
 * RESPONSE AUDITING CONTRACT. A settled success may carry the model's parsed JSON (`Settlement.responseJson`). A ledger
 * implementation MUST retain it, bounded and immutable, so an audit or a replay-fixture author can see exactly what the
 * model returned. The in-memory ledger does so now (this file). The database-backed ledger (P4) must persist the same
 * value in `assessment_run_calls.response_json` under the SAME bound and report it through `entries()`; the contract tests
 * in budget.test.ts are parameterized over a ledger factory so that implementation inherits them.
 *
 * What is retained: only the model's JSON ANSWER, as canonical (key-sorted) JSON text re-parsed into a deeply frozen copy,
 * never the caller's object. What is NEVER retained: the system text, the user blocks, the schema, headers or credentials
 * (the ledger never receives them), and failure results (they have no answer). An answer larger than
 * MAX_RECORDED_RESPONSE_BYTES, or one that cannot be serialized to JSON, is NOT stored; the entry says so
 * (`responseRecord`) and still carries the hash of the answer when the caller supplied one.
 */
export const MAX_RECORDED_RESPONSE_BYTES = 262_144;

export type ResponseRecordState = 'stored' | 'too_large' | 'unserializable' | 'none';

export interface ReserveRequest {
  readonly stage: string;
  readonly model: string;
  readonly requestDigest: string;
  readonly bounds: ReservationBounds;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly callId: number }
  | { readonly ok: false; readonly denial: BudgetDenialReason };

export type Settlement =
  | {
      readonly kind: 'measured';
      readonly usage: Usage;
      readonly outcomeCode: string;
      readonly responseHash: string | null;
      /** The parsed model JSON, kept for audit and replay-fixture authoring. */
      readonly responseJson?: unknown;
    }
  | { readonly kind: 'released'; readonly outcomeCode: string }
  | { readonly kind: 'unknown'; readonly outcomeCode: string };

export interface LedgerEntry {
  readonly callId: number;
  readonly stage: string;
  readonly model: string;
  readonly requestDigest: string;
  /** 1-based count of attempts with the same digest in this run. */
  readonly attempt: number;
  readonly state: CallState;
  readonly reservation: ReservationBounds;
  readonly usageBasis: UsageBasis | null;
  /** Counted usage once settled (measured, or the full reservation for `unknown`). */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costNanoUsd: number | null;
  readonly outcomeCode: string | null;
  readonly responseHash: string | null;
  /** The model's answer as a deeply frozen canonical copy; null unless `responseRecord` is `stored`. */
  readonly responseJson: unknown;
  readonly responseRecord: ResponseRecordState;
  /** UTF-8 size of the canonical answer, when it could be serialized. */
  readonly responseBytes: number | null;
  /** True when measured usage exceeded the reservation: the byte-based bound was wrong for this attempt. */
  readonly boundViolation: boolean;
}

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
}

export interface BudgetSnapshot {
  readonly limits: AssessmentRunLimits;
  readonly settled: Readonly<Totals>;
  readonly unknown: Readonly<Totals>;
  readonly reserved: Readonly<Totals>;
  /**
   * Attempts released because they provably never reached the provider. Their token and cost reservations are freed,
   * but they STILL COUNT as attempts: the call limit is a limit on attempts started, and a refunded slot would let a
   * rate-limit storm evade it.
   */
  readonly releasedCalls: number;
  /** Every attempt that was started: settled + unknown + in flight + released. This is what `maxCalls` limits. */
  readonly attemptsStarted: number;
  readonly boundViolations: number;
}

export interface RunBudget {
  reserve(request: ReserveRequest): Promise<ReserveOutcome>;
  settle(callId: number, settlement: Settlement): Promise<void>;
  snapshot(): Promise<BudgetSnapshot>;
  entries(): Promise<readonly LedgerEntry[]>;
  /** Turns every still-`reserved` attempt into `unknown` (a crashed worker's lease expiring). Returns how many. */
  reapInFlight(): Promise<number>;
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface InMemoryRunBudgetOptions {
  readonly limits: AssessmentRunLimits;
  readonly prices: PriceTable;
  readonly clock: Clock;
  /** Run start for the wall-clock limit; defaults to the clock's current time. */
  readonly startedAtMs?: number;
  /**
   * Test seam: awaited between the limit check and the hold inside `reserve`, to force the interleaving a database
   * would see without a row lock. The mutex makes it harmless in production code.
   */
  readonly betweenCheckAndHold?: () => Promise<void>;
}

const zero = (): Totals => ({ calls: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0 });

function addTo(total: Totals, calls: number, input: number, output: number, cost: number): void {
  total.calls += calls;
  total.inputTokens += input;
  total.outputTokens += output;
  total.costNanoUsd += cost;
}

type MutableEntry = { -readonly [K in keyof LedgerEntry]: LedgerEntry[K] };

export class InMemoryRunBudget implements RunBudget {
  private readonly mutex = new AsyncMutex();
  private readonly settled = zero();
  private readonly unknown = zero();
  private readonly reserved = zero();
  private readonly rows: MutableEntry[] = [];
  private releasedCalls = 0;
  private boundViolations = 0;
  private readonly startedAtMs: number;

  constructor(private readonly options: InMemoryRunBudgetOptions) {
    this.startedAtMs = options.startedAtMs ?? options.clock.now();
  }

  reserve(request: ReserveRequest): Promise<ReserveOutcome> {
    return this.mutex.run(async () => {
      const denial = this.denialFor(request.bounds);
      await this.options.betweenCheckAndHold?.();
      if (denial) return { ok: false, denial } as const;
      const callId = this.rows.length + 1;
      const attempt =
        this.rows.filter((row) => row.requestDigest === request.requestDigest).length + 1;
      this.rows.push({
        callId,
        stage: request.stage,
        model: request.model,
        requestDigest: request.requestDigest,
        attempt,
        state: 'reserved',
        reservation: request.bounds,
        usageBasis: null,
        inputTokens: null,
        outputTokens: null,
        costNanoUsd: null,
        outcomeCode: null,
        responseHash: null,
        responseJson: null,
        responseRecord: 'none',
        responseBytes: null,
        boundViolation: false,
      });
      addTo(
        this.reserved,
        1,
        request.bounds.inputTokens,
        request.bounds.outputTokens,
        request.bounds.costNanoUsd,
      );
      return { ok: true, callId } as const;
    });
  }

  settle(callId: number, settlement: Settlement): Promise<void> {
    return this.mutex.run(() => {
      const row = this.rows[callId - 1];
      if (row?.state !== 'reserved') {
        return Promise.reject(new Error('settlement of a call that is not reserved'));
      }
      const { reservation } = row;
      addTo(
        this.reserved,
        -1,
        -reservation.inputTokens,
        -reservation.outputTokens,
        -reservation.costNanoUsd,
      );
      row.outcomeCode = settlement.outcomeCode;
      if (settlement.kind === 'released') {
        row.state = 'released';
        this.releasedCalls += 1;
      } else if (settlement.kind === 'unknown') {
        this.markUnknown(row);
      } else {
        const price = priceFor(this.options.prices, row.model);
        const input = inputTokensOf(settlement.usage);
        const output = settlement.usage.outputTokens;
        // A model that cannot be priced cannot be measured: count the reservation instead of guessing zero.
        if (!price) {
          this.markUnknown(row);
          return Promise.resolve();
        }
        const cost = costNanoUsd(price, input, output);
        row.state = 'settled';
        row.usageBasis = 'measured';
        row.inputTokens = input;
        row.outputTokens = output;
        row.costNanoUsd = cost;
        row.responseHash = settlement.responseHash;
        this.recordResponse(row, settlement.responseJson);
        row.boundViolation = input > reservation.inputTokens || output > reservation.outputTokens;
        if (row.boundViolation) this.boundViolations += 1;
        addTo(this.settled, 1, input, output, cost);
      }
      return Promise.resolve();
    });
  }

  snapshot(): Promise<BudgetSnapshot> {
    return this.mutex.run(() =>
      Promise.resolve({
        limits: this.options.limits,
        settled: { ...this.settled },
        unknown: { ...this.unknown },
        reserved: { ...this.reserved },
        releasedCalls: this.releasedCalls,
        attemptsStarted:
          this.settled.calls + this.unknown.calls + this.reserved.calls + this.releasedCalls,
        boundViolations: this.boundViolations,
      }),
    );
  }

  entries(): Promise<readonly LedgerEntry[]> {
    return this.mutex.run(() => Promise.resolve(this.rows.map((row) => ({ ...row }))));
  }

  reapInFlight(): Promise<number> {
    return this.mutex.run(() => {
      let count = 0;
      for (const row of this.rows) {
        if (row.state !== 'reserved') continue;
        addTo(
          this.reserved,
          -1,
          -row.reservation.inputTokens,
          -row.reservation.outputTokens,
          -row.reservation.costNanoUsd,
        );
        row.outcomeCode = 'lease_expired';
        this.markUnknown(row);
        count += 1;
      }
      return Promise.resolve(count);
    });
  }

  private recordResponse(row: MutableEntry, answer: unknown): void {
    if (answer === undefined) return;
    let canonical: string;
    try {
      canonical = canonicalJson(answer);
    } catch {
      row.responseRecord = 'unserializable';
      return;
    }
    // `JSON.stringify` yields undefined for values with no JSON form (a bare function or symbol).
    if (typeof canonical !== 'string') {
      row.responseRecord = 'unserializable';
      return;
    }
    row.responseBytes = new TextEncoder().encode(canonical).length;
    if (row.responseBytes > MAX_RECORDED_RESPONSE_BYTES) {
      row.responseRecord = 'too_large';
      return;
    }
    row.responseJson = deepFreeze(JSON.parse(canonical) as unknown);
    row.responseRecord = 'stored';
  }

  private markUnknown(row: MutableEntry): void {
    row.state = 'unknown';
    row.usageBasis = 'unknown_reserved';
    row.inputTokens = row.reservation.inputTokens;
    row.outputTokens = row.reservation.outputTokens;
    row.costNanoUsd = row.reservation.costNanoUsd;
    addTo(
      this.unknown,
      1,
      row.reservation.inputTokens,
      row.reservation.outputTokens,
      row.reservation.costNanoUsd,
    );
  }

  /** The first limit this attempt's worst case would cross, or null. Order is fixed so results are deterministic. */
  private denialFor(bounds: ReservationBounds): BudgetDenialReason | null {
    const { limits, clock } = this.options;
    if (clock.now() - this.startedAtMs >= limits.runWallClockMs) return 'wall_clock';
    if (bounds.inputTokens > limits.maxReservedInputTokensPerCall) return 'per_call_input';
    const total = (pick: (t: Totals) => number) =>
      pick(this.settled) + pick(this.unknown) + pick(this.reserved);
    // `maxCalls` limits ATTEMPTS STARTED. A released attempt gives back its token and cost reservation (it never reached
    // the provider) but never its attempt slot: refunding it would let repeated not-sent failures (for example HTTP 429)
    // exceed the limit without bound.
    if (total((t) => t.calls) + this.releasedCalls + 1 > limits.maxCalls) return 'calls';
    if (total((t) => t.inputTokens) + bounds.inputTokens > limits.maxInputTokens) {
      return 'input_tokens';
    }
    if (total((t) => t.outputTokens) + bounds.outputTokens > limits.maxOutputTokens) {
      return 'output_tokens';
    }
    if (total((t) => t.costNanoUsd) + bounds.costNanoUsd > limits.maxCostNanoUsd) return 'cost';
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
