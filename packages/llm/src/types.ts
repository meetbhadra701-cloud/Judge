import type {
  AssessmentStage,
  BudgetDenialReason,
  LlmFailureCategory,
  ProviderMode,
  SendState,
} from '@judge-copilot/schemas';

/*
 * The provider-neutral contract (docs/milestones/M5-design.md §12.1). Nothing here names a vendor: an
 * adapter (the Anthropic one arrives in P6) implements `LlmProvider`, stage code depends only on this file.
 *
 * A request is the EXACT effective request: every string that reaches the model is in `system` or `user`,
 * the schema is the one sent, and `generation` holds every setting that can change the output. The request
 * digest (digest.ts) is derived from this object by `llm`, never supplied by a caller.
 */

export interface GenerationSettings {
  readonly effort?: 'low' | 'medium' | 'high';
  /** A hard ceiling the provider enforces; for hidden-reasoning models it includes reasoning tokens. */
  readonly maxOutputTokens: number;
  /** Execution detail: a per-attempt timeout. It does not change the output, so it is not in the digest. */
  readonly timeoutMs: number;
}

export interface StructuredRequest {
  readonly stage: AssessmentStage;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly promptTemplateHash: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly provider: string;
  readonly model: string;
  /** Instructions only, exactly as sent. */
  readonly system: string;
  /** EVERY user-role content block, in order, exactly as sent (untrusted project data lives here, delimited). */
  readonly user: readonly string[];
  /** The JSON schema exactly as sent to the provider. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly generation: GenerationSettings;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface LlmSuccess {
  readonly ok: true;
  /** Parsed JSON, still UNTRUSTED: the caller runs Zod and domain validation. */
  readonly json: unknown;
  readonly usage: Usage;
  readonly providerRequestId: string | null;
  readonly servedModel: string;
}

export interface LlmFailure {
  readonly ok: false;
  readonly category: LlmFailureCategory;
  /** Whether the attempt could have cost money. Drives budget settlement. */
  readonly sendState: SendState;
  readonly retryAfterMs?: number;
  /** Provider-reported usage when the provider billed something despite the failure (for example truncation). */
  readonly usage?: Usage;
  /** Set only when `category` is `budget_exceeded`. */
  readonly denial?: BudgetDenialReason;
}

export type LlmResult = LlmSuccess | LlmFailure;

export interface LlmProvider {
  readonly id: string;
  readonly mode: ProviderMode;
  /** Must honor `signal`; a provider that ignores it is still bounded by the timeout wrapper. */
  generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult>;
}
