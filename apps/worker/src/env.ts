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
  /**
   * The pre-interview assessment pipeline (M5 P5). `none` (default): the assessment loop is off and nothing contacts any model.
   * `replay`: the offline demonstration provider over a hand-authored fixture file (development and test only). A live provider
   * does not exist yet (P6); it will be a further value here and needs a separate owner authorization.
   */
  ASSESSMENT_PROVIDER: z.enum(['none', 'replay']).default('none'),
  ASSESSMENT_REPLAY_FIXTURE: z.string().min(1).optional(),
  ASSESSMENT_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  ASSESSMENT_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  ASSESSMENT_LEASE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
  /** A pending run nobody claimed within this time is cancelled (approved default: 15 minutes). */
  ASSESSMENT_PENDING_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(900_000),
  ASSESSMENT_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
}).superRefine((env, ctx) => {
  if (env.ASSESSMENT_PROVIDER === 'replay') {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['ASSESSMENT_PROVIDER'],
        message: 'The replay provider is for development and tests only',
      });
    }
    if (!env.ASSESSMENT_REPLAY_FIXTURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['ASSESSMENT_REPLAY_FIXTURE'],
        message: 'Required when ASSESSMENT_PROVIDER=replay',
      });
    }
  }
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
