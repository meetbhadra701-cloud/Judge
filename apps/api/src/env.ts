import { BaseEnv, parseEnv } from '@judge-copilot/shared';
import { z } from 'zod';

export const ApiEnv = BaseEnv.extend({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  /** Optional: without it the API still boots and serves /health; Event Context routes respond 503. */
  DATABASE_URL: z.string().min(1).optional(),
  /**
   * `none` (default): no extractor — drafts are authored by hand.
   * `replay`: development-only exact-match replay of recorded extractions; never semantic.
   */
  EVENT_CONTEXT_EXTRACTOR: z.enum(['none', 'replay']).default('none'),
  EVENT_CONTEXT_REPLAY_DIR: z.string().min(1).optional(),
}).superRefine((env, ctx) => {
  if (env.EVENT_CONTEXT_EXTRACTOR === 'replay') {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['EVENT_CONTEXT_EXTRACTOR'],
        message: 'The replay extractor is for development and tests only',
      });
    }
    if (!env.EVENT_CONTEXT_REPLAY_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['EVENT_CONTEXT_REPLAY_DIR'],
        message: 'Required when EVENT_CONTEXT_EXTRACTOR=replay',
      });
    }
  }
});
export type ApiEnv = z.infer<typeof ApiEnv>;

export function loadApiEnv(source?: Readonly<Record<string, string | undefined>>): ApiEnv {
  return parseEnv(ApiEnv, source);
}
