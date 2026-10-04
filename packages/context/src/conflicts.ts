import type {
  ConflictPosition,
  ConflictResolution,
  EventSourceAuthority,
  HumanConflictResolution,
} from '@judge-copilot/schemas';
import { authorityRank } from './authority.js';

export type ConflictResolutionResult =
  { ok: true; resolution: ConflictResolution } | { ok: false; message: string };

/**
 * Resolves a conflict between source positions deterministically by authority.
 *
 * - A single highest-authority position prevails (`resolved_by_authority`).
 * - Tied highest-authority positions stay `unresolved` unless a human picks among them.
 * - A human may never override a higher-authority position (invariant 1); to change an official
 *   reading, add a newer official source instead.
 *
 * Positions are never removed: losing positions remain part of the conflict record.
 */
export function resolveConflict(
  positions: readonly ConflictPosition[],
  authorityOf: (sourceId: string) => EventSourceAuthority,
  humanResolution?: HumanConflictResolution | null,
): ConflictResolutionResult {
  const sourceIds = positions.map((position) => position.sourceId);
  if (positions.length < 2) {
    return { ok: false, message: 'A conflict needs at least two positions' };
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    return { ok: false, message: 'Each conflict position must come from a different source' };
  }

  const topRank = Math.max(...sourceIds.map((id) => authorityRank(authorityOf(id))));
  const topSourceIds = sourceIds.filter((id) => authorityRank(authorityOf(id)) === topRank);

  if (humanResolution) {
    if (topSourceIds.length < 2) {
      return {
        ok: false,
        message:
          'Source authority already resolves this conflict; a human resolution is only allowed between tied highest-authority sources',
      };
    }
    const chosen = humanResolution.prevailingSourceIds;
    if (
      !chosen.every((id) => topSourceIds.includes(id)) ||
      new Set(chosen).size !== chosen.length
    ) {
      return {
        ok: false,
        message: 'A human resolution may only choose among the tied highest-authority positions',
      };
    }
    return {
      ok: true,
      resolution: {
        status: 'resolved_by_human',
        prevailingSourceIds: [...chosen],
        note: humanResolution.note,
      },
    };
  }

  const [prevailing] = topSourceIds;
  if (topSourceIds.length === 1 && prevailing !== undefined) {
    return {
      ok: true,
      resolution: {
        status: 'resolved_by_authority',
        prevailingSourceIds: [prevailing],
        note: null,
      },
    };
  }
  return { ok: true, resolution: { status: 'unresolved', prevailingSourceIds: [], note: null } };
}
