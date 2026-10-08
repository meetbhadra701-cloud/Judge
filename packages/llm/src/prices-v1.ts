import { PriceTable } from '@judge-copilot/schemas';

/*
 * `prices/v1`. Source: reference material available to the design session, cached 2026-10-06. NOT verified
 * against the provider and not a quote: it is the input of a LOCAL guard, replaced by a new dated version
 * (`prices/v2`) when the owner verifies or updates it. Haiku-tier figures apply to prompts of at most 100K
 * tokens, which the per-attempt input bound keeps true.
 *
 * $0.10 per million tokens = 100 nano-USD per token.
 */
export const PRICES_V1: PriceTable = PriceTable.parse({
  id: 'prices/v1',
  effectiveDate: '2026-10-06',
  currency: 'USD',
  unit: 'nano_usd_per_token',
  source:
    'Design-session reference material cached 2026-10-06; unverified against the provider; first-party list prices; no caching, batch or tier discounts.',
  models: {
    'claude-haiku-5-5': { inputNanoUsdPerToken: 100, outputNanoUsdPerToken: 500 },
    'claude-sonnet-5-5': { inputNanoUsdPerToken: 2_000, outputNanoUsdPerToken: 10_000 },
  },
});
