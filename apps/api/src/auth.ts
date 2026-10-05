import { actors, type JudgeDatabase } from '@judge-copilot/database';
import {
  hasPermission,
  type AuthVerifier,
  type Permission,
  type VerifiedIdentity,
} from '@judge-copilot/domain';
import type { ActorRecord, ActorRole } from '@judge-copilot/schemas';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

/*
 * The API's authentication boundary (M2). Every route except GET /health requires a bearer
 * credential accepted by the configured AuthVerifier, and a role granting the route's permission.
 * Without a verifier the API fails closed (503 AUTH_NOT_CONFIGURED). Credentials are never logged,
 * echoed or stored: only the verified (issuer, subject) pair becomes an `actors` row.
 */

export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'AUTH_NOT_CONFIGURED';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const AUTH_STATUS: Record<AuthErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  AUTH_NOT_CONFIGURED: 503,
};

export interface AuthenticatedActor extends ActorRecord {
  readonly roles: ActorRole[];
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
  }
}

/** Maps verified identities to stable actor ids (inserting on first sight). */
export class ActorDirectory {
  private readonly cache = new Map<string, string>();

  constructor(private readonly db: JudgeDatabase) {}

  async resolve(identity: VerifiedIdentity): Promise<string> {
    const key = `${identity.issuer}\u0000${identity.subject}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    await this.db
      .insert(actors)
      .values({ issuer: identity.issuer, subject: identity.subject })
      .onConflictDoNothing({ target: [actors.issuer, actors.subject] });
    const [row] = await this.db
      .select({ id: actors.id })
      .from(actors)
      .where(and(eq(actors.issuer, identity.issuer), eq(actors.subject, identity.subject)));
    if (!row) throw new Error('actor could not be resolved');
    this.cache.set(key, row.id);
    return row.id;
  }
}

export interface ApiAuth {
  readonly verifier: AuthVerifier | null;
  readonly directory: ActorDirectory;
}

/** Extracts a bearer credential. Anything else is treated as absent. */
export function bearerCredential(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]{1,16384})$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export type Guard = (permission: Permission) => (request: FastifyRequest) => Promise<void>;

export function createGuard(auth: ApiAuth): Guard {
  return (permission) => async (request) => {
    if (!auth.verifier) {
      throw new AuthError('AUTH_NOT_CONFIGURED', 'Authentication is not configured');
    }
    const credential = bearerCredential(request.headers.authorization);
    if (!credential) throw new AuthError('UNAUTHENTICATED', 'Authentication required');
    const identity = await auth.verifier.verify(credential);
    if (!identity) throw new AuthError('UNAUTHENTICATED', 'Authentication required');
    if (!hasPermission(identity.roles, permission)) {
      throw new AuthError('FORBIDDEN', 'Your role does not allow this action');
    }
    request.actor = {
      id: await auth.directory.resolve(identity),
      issuer: identity.issuer,
      subject: identity.subject,
      roles: [...identity.roles],
    };
  };
}

/** The authenticated actor of a guarded route. */
export function actorOf(request: FastifyRequest): AuthenticatedActor {
  if (!request.actor) throw new AuthError('UNAUTHENTICATED', 'Authentication required');
  return request.actor;
}
