import { lockedContentHash } from '@judge-copilot/context';
import { EventContextLockedSnapshot, type ScoringIssue } from '@judge-copilot/schemas';

/*
 * Validation of the locked Event Context snapshot the rubric comes from.
 *
 * This is STRUCTURAL validation: the snapshot must be schema-valid, currently `locked`, carry sane
 * version metadata, belong to the expected event, have sources that belong to its own version, and
 * still hash to its recorded content hash.
 *
 * It does NOT prove the snapshot is authentic. A self-consistent snapshot forged in process (a
 * different rubric with a matching recomputed hash) passes every one of these checks, because the
 * hash is recomputable by anyone who can write the document. Authenticity is the job of the trusted
 * adapter that reads the snapshot from the database (M5): the engine trusts whoever builds the
 * context. See SECURITY.md §15.
 *
 * The returned snapshot is a schema-parsed COPY; callers must use it, never the object they passed.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type LockedValidation =
  | { readonly ok: true; readonly locked: EventContextLockedSnapshot }
  | { readonly ok: false; readonly issues: readonly ScoringIssue[] };

export function validateLockedSnapshot(
  raw: unknown,
  expectedEventId: string | null,
): LockedValidation {
  const parsed = EventContextLockedSnapshot.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((entry) => ({
        code: 'LOCKED_CONTEXT_INVALID' as const,
        path: ['locked', ...entry.path.map(String)].join('.'),
        message: entry.message,
      })),
    };
  }
  const locked = parsed.data;
  const issues: ScoringIssue[] = [];
  const invalid = (path: string, message: string) => {
    issues.push({ code: 'LOCKED_CONTEXT_INVALID', path: `locked.${path}`, message });
  };

  if (locked.status !== 'locked') {
    invalid('status', 'The Event Context version must be currently locked');
  }
  if (locked.version < 1) invalid('version', 'The Event Context version number must be at least 1');
  if (!SHA256_HEX.test(locked.lockedContentHash)) {
    invalid('lockedContentHash', 'The recorded content hash must be 64 lowercase hex characters');
  }
  locked.sources.forEach((source, index) => {
    if (source.contextVersionId !== locked.versionId) {
      invalid(`sources.${String(index)}.contextVersionId`, 'A source belongs to another version');
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  if (expectedEventId !== null && locked.eventId !== expectedEventId) {
    return {
      ok: false,
      issues: [
        {
          code: 'LOCKED_CONTEXT_MISMATCH',
          path: 'locked.eventId',
          message: 'The locked Event Context belongs to another event',
        },
      ],
    };
  }
  const recomputed = lockedContentHash({ document: locked.document, sources: locked.sources });
  if (recomputed !== locked.lockedContentHash) {
    return {
      ok: false,
      issues: [
        {
          code: 'LOCKED_CONTEXT_MISMATCH',
          path: 'locked',
          message: 'The locked Event Context content does not match its recorded content hash',
        },
      ],
    };
  }
  return { ok: true, locked };
}
