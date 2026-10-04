import type { Logger } from '@judge-copilot/shared';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';

export type ApiApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

export interface RequestIssue {
  path: string;
  message: string;
}

/** A malformed request (bad UUID, invalid body). Issues describe rules, never echo values. */
export class RequestValidationError extends Error {
  readonly location: 'body' | 'params';
  readonly issues: readonly RequestIssue[];

  constructor(location: 'body' | 'params', issues: readonly RequestIssue[]) {
    super(`Invalid request ${location}`);
    this.name = 'RequestValidationError';
    this.location = location;
    this.issues = issues;
  }
}

export function parseRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  location: 'body' | 'params',
): z.output<TSchema> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new RequestValidationError(
      location,
      result.error.issues.slice(0, 50).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
