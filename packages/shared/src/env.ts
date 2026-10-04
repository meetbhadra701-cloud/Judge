import { z } from 'zod';

export const NodeEnv = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof NodeEnv>;

export const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
export type LogLevel = z.infer<typeof LogLevel>;

/** Variables every Judge Copilot process understands. Apps extend this with their own. */
export const BaseEnv = z.object({
  NODE_ENV: NodeEnv.default('development'),
  LOG_LEVEL: LogLevel.default('info'),
});

/**
 * Raised when configuration is invalid. Issues name the offending variable and the rule it
 * broke but never echo the supplied value, so secrets cannot leak through startup errors.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Validates environment variables against a Zod schema. Empty strings are treated as unset. */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Readonly<Record<string, string | undefined>> = process.env,
): z.output<TSchema> {
  const normalized = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = schema.safeParse(normalized);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
