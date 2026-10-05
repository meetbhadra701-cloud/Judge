import type { ActorRole } from '@judge-copilot/schemas';

/*
 * Authorization policy (deterministic, ARCHITECTURE.md §3). Authentication is an adapter concern:
 * an `AuthVerifier` turns a bearer credential into a verified identity; this module decides what
 * that identity may do. Roles are global in M2; per-event role assignment is deferred.
 */

export const PERMISSIONS = [
  'event_context.read',
  'event_context.write',
  'project.read',
  'project.write',
  'source.capture',
  'evidence.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * organizer — manages Event Context, projects, source declarations and captures.
 * judge     — reads Event Context, projects and snapshots, and may request a fresh capture
 *             (which only ever adds a new snapshot). A judge never edits official Event Context.
 *
 * `evidence.read` (M3) lets both roles inspect a project's evidence graph. There is no evidence
 * write permission: M3 has no producer, and the graph is written only by trusted server code.
 */
export const ROLE_PERMISSIONS: Readonly<Record<ActorRole, readonly Permission[]>> = {
  organizer: [
    'event_context.read',
    'event_context.write',
    'project.read',
    'project.write',
    'source.capture',
    'evidence.read',
  ],
  judge: ['event_context.read', 'project.read', 'source.capture', 'evidence.read'],
};

export function hasPermission(roles: readonly ActorRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

/** A credential the verifier has cryptographically (or, in development, explicitly) accepted. */
export interface VerifiedIdentity {
  /** Who vouched for the identity, e.g. the JWT `iss`. */
  readonly issuer: string;
  /** Stable subject within the issuer, e.g. the JWT `sub`. Never a credential. */
  readonly subject: string;
  readonly roles: readonly ActorRole[];
}

/**
 * Port for authentication adapters (`@judge-copilot/auth`). `verify` returns null for any
 * missing, malformed, expired or untrusted credential and never throws credential material.
 */
export interface AuthVerifier {
  readonly name: string;
  verify(credential: string): Promise<VerifiedIdentity | null>;
}
