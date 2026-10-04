import type { EventSourceAuthority, EventSourceType } from '@judge-copilot/schemas';

export interface ExtractorSource {
  id: string;
  sourceType: EventSourceType;
  authority: EventSourceAuthority;
  title: string;
  url: string | null;
  /** Untrusted project-adjacent text. Implementations must treat it as data, never instructions. */
  normalizedText: string;
  contentHash: string;
}

export interface EventContextExtractionInput {
  eventName: string;
  sources: readonly ExtractorSource[];
}

/**
 * Port for semantic extraction of a structured Event Context from source text (future model
 * stage, docs/AI_PIPELINE.md stage 1). The result is deliberately `unknown`: callers must
 * schema-validate it (EventContextExtraction) and then domain-validate it
 * (documentFromExtraction) before anything is stored. Implementations never assign IDs,
 * resolve conflicts, or decide precedence — deterministic code does.
 */
export interface EventContextExtractor {
  /** Identifies the implementation in audit records, e.g. `replay`. */
  readonly name: string;
  extract(input: EventContextExtractionInput): Promise<unknown>;
}

/** The extractor could not produce output (provider outage, no recording, refusal, ...). */
export class ExtractorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractorUnavailableError';
  }
}
