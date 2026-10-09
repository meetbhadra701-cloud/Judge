import { lockedContentHash } from '@judge-copilot/context';
import { EventContextLockedSnapshot } from '@judge-copilot/schemas';
import { PromptInputError } from './errors.js';
import type { UnitView } from './inputs.js';

/*
 * The standard a scoring unit is judged against, taken from THE SAME locked Event Context snapshot that builds the scoring
 * rubric (design §5.1). A caller must say which snapshot it expects (its content hash, pinned at the start of the run), so
 * a prompt can never be built from a different version than the one that was pinned and scored.
 *
 * What this does and does not establish: it checks the snapshot is schema-valid, currently `locked`, hashes to its recorded
 * content hash and to the pinned expectation. It cannot prove the snapshot is AUTHENTIC; a self-consistent forged snapshot
 * would pass. Authenticity is the database-backed trusted reader's job (P4), exactly as for the scoring context.
 *
 * Official criteria keep their OWN descriptions and anchors. A criterion with no published anchors becomes
 * `official_no_anchors` (the prompt says so); the fallback anchors are never substituted, and in P2 they cannot be used at
 * all.
 */

export interface OfficialUnitBinding {
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  readonly rubricName: string;
}

export interface OfficialUnit {
  readonly unit: UnitView;
  readonly binding: OfficialUnitBinding;
}

export function officialUnitFromLockedSnapshot(
  snapshot: unknown,
  expected: { readonly lockedContentHash: string; readonly eventId: string },
  criterionKey: string,
): OfficialUnit {
  const parsed = EventContextLockedSnapshot.safeParse(snapshot);
  if (!parsed.success) throw new PromptInputError([{ path: 'snapshot', code: 'invalid_snapshot' }]);
  const locked = parsed.data;
  const fail = (code: string): never => {
    throw new PromptInputError([{ path: 'snapshot', code }]);
  };
  if (locked.status !== 'locked') fail('not_locked');
  if (locked.eventId !== expected.eventId) fail('event_mismatch');
  if (
    lockedContentHash({ document: locked.document, sources: locked.sources }) !==
    locked.lockedContentHash
  ) {
    fail('content_hash_mismatch');
  }
  if (locked.lockedContentHash !== expected.lockedContentHash) fail('not_the_pinned_version');

  // Overall target only (design D9): track rubrics are never used or blended here.
  const overall = locked.document.rubrics.filter((rubric) => rubric.scope === 'overall');
  if (overall.length === 0) fail('no_official_overall_rubric');
  if (overall.length > 1) fail('ambiguous_official_overall_rubric');
  const rubric = overall[0];
  const criterion = rubric?.criteria.find((entry) => entry.key === criterionKey);
  if (!rubric || !criterion) return fail('criterion_not_found');

  const anchors = [...criterion.anchors].sort((a, b) => a.score - b.score);
  const base = {
    dimensionId: `official.${criterion.key}`,
    name: criterion.name,
    scale: { min: rubric.scaleMin, max: rubric.scaleMax },
    notices: [] as UnitView['notices'],
  };
  const unit: UnitView =
    anchors.length > 0
      ? {
          ...base,
          standard: { basis: 'official', criterionDescription: criterion.description, anchors },
        }
      : {
          ...base,
          standard: { basis: 'official_no_anchors', criterionDescription: criterion.description },
        };
  return {
    unit,
    binding: {
      contextVersionId: locked.versionId,
      lockedContentHash: locked.lockedContentHash,
      rubricName: rubric.name,
    },
  };
}
