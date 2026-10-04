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
  /**
   * `none` (default): no verifier; every protected route answers 503 AUTH_NOT_CONFIGURED.
   * `jwt`: provider-neutral bearer JWTs verified against the identity provider's JWKS.
   * `dev`: development-only synthetic actors (`dev-organizer`, `dev-judge`); never in production.
   */
  AUTH_MODE: z.enum(['none', 'jwt', 'dev']).default('none'),
  AUTH_JWT_ISSUER: z.string().min(1).optional(),
  AUTH_JWT_AUDIENCE: z.string().min(1).optional(),
  AUTH_JWKS_URL: z.url().optional(),
  AUTH_JWT_ROLES_CLAIM: z.string().min(1).max(200).default('roles'),
}).superRefine((env, ctx) => {
  if (env.AUTH_MODE === 'dev' && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message: 'Development authentication is refused in production',
    });
  }
  if (env.NODE_ENV === 'production' && env.DATABASE_URL && env.AUTH_MODE !== 'jwt') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message: 'Production with a database requires AUTH_MODE=jwt',
    });
  }
  if (env.AUTH_MODE === 'jwt') {
    for (const key of ['AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE', 'AUTH_JWKS_URL'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Required when AUTH_MODE=jwt' });
      }
    }
    if (
      env.AUTH_JWKS_URL &&
      env.NODE_ENV === 'production' &&
      !env.AUTH_JWKS_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_JWKS_URL'],
        message: 'Must use https in production',
      });
    }
  }
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
