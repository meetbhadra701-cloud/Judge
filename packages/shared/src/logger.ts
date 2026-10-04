import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import type { LogLevel } from './env.js';

/**
 * Structured logger used by every Judge Copilot process. It is pino-compatible so Fastify
 * can use the same instance, but callers should depend on this type, not on pino directly.
 */
export type Logger = PinoLogger;

/** Keys whose values must never reach log output (docs/SECURITY.md). */
const REDACTED_KEYS = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'databaseUrl',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
];

const REDACT_PATHS = [
  ...REDACTED_KEYS,
  ...REDACTED_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
];

/**
 * Serializes errors to an allow-listed shape. Third-party SDK errors often carry request
 * objects, headers or credentials as enumerable properties; those are never logged.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: 'Non-Error value thrown' };
  }
  const serialized: Record<string, unknown> = {
    type: error.name,
    message: error.message,
    stack: error.stack,
  };
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    serialized['code'] = code;
  }
  if (error.cause !== undefined) {
    serialized['cause'] = serializeError(error.cause);
  }
  return serialized;
}

export interface CreateLoggerOptions {
  /** Logical service name, e.g. `judge-copilot-api`. Attached to every log line. */
  service: string;
  level?: LogLevel;
  /** Defaults to stdout. Tests pass an in-memory stream. */
  destination?: DestinationStream;
}

export function createLogger({
  service,
  level = 'info',
  destination,
}: CreateLoggerOptions): Logger {
  const options = {
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { err: serializeError, error: serializeError },
  };
  return destination ? pino(options, destination) : pino(options);
}
