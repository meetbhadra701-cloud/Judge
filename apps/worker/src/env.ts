import { BaseEnv, parseEnv } from '@judge-copilot/shared';
import { z } from 'zod';

export const WorkerEnv = BaseEnv.extend({
  /** Optional: without it the worker idles with no job handlers. */
  DATABASE_URL: z.string().min(1).optional(),
  /** Optional read-only GitHub token (public repositories need none). Never logged or stored. */
  GITHUB_TOKEN: z.string().min(1).optional(),
  CAPTURE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  CAPTURE_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  CAPTURE_LEASE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
  /**
   * `live` (default): the real network through the SSRF-safe client.
   * `fixture`: development-only synthetic network loaded from CAPTURE_FIXTURE_DIR; never in
   * production. The SSRF policy still runs in front of it.
   */
  CAPTURE_NETWORK: z.enum(['live', 'fixture']).default('live'),
  CAPTURE_FIXTURE_DIR: z.string().min(1).optional(),
}).superRefine((env, ctx) => {
  if (env.CAPTURE_NETWORK === 'fixture') {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['CAPTURE_NETWORK'],
        message: 'The fixture network is for development and tests only',
      });
    }
    if (!env.CAPTURE_FIXTURE_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['CAPTURE_FIXTURE_DIR'],
        message: 'Required when CAPTURE_NETWORK=fixture',
      });
    }
  }
});
export type WorkerEnv = z.infer<typeof WorkerEnv>;

export function loadWorkerEnv(source?: Readonly<Record<string, string | undefined>>): WorkerEnv {
  return parseEnv(WorkerEnv, source);
}
