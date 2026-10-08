import { canonicalJson } from '@judge-copilot/context';
import type { PriceTable } from '@judge-copilot/schemas';
import type { StructuredRequest, Usage } from './types.js';

/*
 * Pricing is DATA (dated, versioned, owner-editable), never code constants scattered through the pipeline.
 * Every figure is an exact integer number of nano-USD per token, so cost arithmetic is exact (no floats).
 * A cost computed here is a COMPUTED figure for the local spending guard, never "billed": the provider's
 * invoice can differ (price changes, tier boundaries, ambiguous failures, token-accounting differences).
 */

/** Tokens the request reserves for provider-side framing that the visible text does not show. */
export const RESERVATION_OVERHEAD_TOKENS = 2_000;

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

export interface ModelPrice {
  readonly inputNanoUsdPerToken: number;
  readonly outputNanoUsdPerToken: number;
}

export function priceFor(table: PriceTable, model: string): ModelPrice | null {
  return Object.hasOwn(table.models, model) ? (table.models[model] ?? null) : null;
}

/** Cache read/write tokens are billed at the plain input rate here: conservative for reads, a floor for writes. */
export function inputTokensOf(usage: Usage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

export function costNanoUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return inputTokens * price.inputNanoUsdPerToken + outputTokens * price.outputNanoUsdPerToken;
}

export interface ReservationBounds {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

/**
 * The conservative worst case held while one attempt is in flight.
 *
 *  - input: the UTF-8 byte length of everything sent, plus a fixed overhead. This rests on an ASSUMPTION
 *    ("a token covers at least one input byte") that no provider guarantees; it is documented as such and is
 *    over-conservative for ordinary text. It only ever applies to the in-flight attempt: settled totals use the
 *    provider's measured usage.
 *  - output: `maxOutputTokens`, which the provider enforces as a hard ceiling.
 */
export function reservationBounds(
  request: StructuredRequest,
  table: PriceTable,
): ReservationBounds | null {
  const price = priceFor(table, request.model);
  if (!price) return null;
  const inputTokens =
    utf8Bytes(request.system) +
    request.user.reduce((total, block) => total + utf8Bytes(block), 0) +
    utf8Bytes(canonicalJson(request.jsonSchema)) +
    RESERVATION_OVERHEAD_TOKENS;
  const outputTokens = request.generation.maxOutputTokens;
  return { inputTokens, outputTokens, costNanoUsd: costNanoUsd(price, inputTokens, outputTokens) };
}
