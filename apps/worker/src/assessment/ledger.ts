import type {
  CallBinding,
  CallMetadata,
  DatabaseRunBudget,
  LedgerEntryLike,
} from '@judge-copilot/database';
import type {
  BudgetSnapshot,
  LedgerEntry,
  ReserveOutcome,
  ReserveRequest,
  RunBudget,
  Settlement,
} from '@judge-copilot/llm';

/*
 * The run's ledger as the model port sees it (`RunBudget`), implemented over the database-backed spending guard (P4), plus the
 * bookkeeping the orchestrator needs and the port deliberately does not carry:
 *
 *   register   the non-secret metadata and the CLOSED SET of the request about to be sent, keyed by its digest. The database stores them
 *              in the ledger row at reservation, bound to (stage, digest, dimension, prompt identity) by a hash.
 *   attempts   the ledger call ids reserved while one `generate` ran, in order (every transient retry is its own attempt).
 *   bindingOf  the closed set READ BACK from the ledger row (recomputed against its binding hash), which the orchestrator validates
 *              the model's answer against: not the in-memory set it rendered. A caller cannot validate against another call's handles.
 *
 * Every reserve and settle is delegated unchanged; nothing is held open between them and no transaction survives a call.
 */

export interface AttemptRecord {
  readonly callId: number;
  /** Set when the attempt was settled by this ledger. */
  settlement: Settlement['kind'] | null;
  outcomeCode: string | null;
}

export class RecordingBudget implements RunBudget {
  private recorded: AttemptRecord[] = [];

  constructor(private readonly inner: DatabaseRunBudget) {}

  register(requestDigest: string, metadata: CallMetadata): void {
    this.inner.register(requestDigest, metadata);
  }

  /** Starts a new window of attempts and returns the previous one. */
  drainAttempts(): readonly AttemptRecord[] {
    const taken = this.recorded;
    this.recorded = [];
    return taken;
  }

  async reserve(request: ReserveRequest): Promise<ReserveOutcome> {
    const outcome = await this.inner.reserve(request);
    if (outcome.ok) {
      this.recorded.push({ callId: outcome.callId, settlement: null, outcomeCode: null });
    }
    return outcome;
  }

  async settle(callId: number, settlement: Settlement): Promise<void> {
    await this.inner.settle(callId, settlement);
    const record = this.recorded.find((entry) => entry.callId === callId);
    if (record) {
      record.settlement = settlement.kind;
      record.outcomeCode = settlement.outcomeCode;
    }
  }

  snapshot(): Promise<BudgetSnapshot> {
    return this.inner.snapshot();
  }

  entries(): Promise<readonly LedgerEntry[]> {
    return this.inner.entries();
  }

  ledgerRows(): Promise<readonly LedgerEntryLike[]> {
    return this.inner.entries();
  }

  reapInFlight(): Promise<number> {
    return this.inner.reapInFlight();
  }

  bindingOf(callId: number): Promise<CallBinding | null> {
    return this.inner.bindingOf(callId);
  }
}
