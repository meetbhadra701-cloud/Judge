import { z } from 'zod';

/**
 * The JSON Schema sent to a provider for a stage's output schema. It is generated from the SAME Zod schema that
 * validates the answer, from the input side so refinements and normalizing transforms are not represented. The
 * provider-side schema is a request to produce the right shape, never a substitute for validation: the Zod
 * schema and the domain gates remain authoritative.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}
