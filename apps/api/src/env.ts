import { BaseEnv, parseEnv } from '@judge-copilot/shared';
import { z } from 'zod';

export const ApiEnv = BaseEnv.extend({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
});
export type ApiEnv = z.infer<typeof ApiEnv>;

export function loadApiEnv(source?: Readonly<Record<string, string | undefined>>): ApiEnv {
  return parseEnv(ApiEnv, source);
}
