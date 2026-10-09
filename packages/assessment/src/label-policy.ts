import type { EvidenceKind, EvidenceOrigin, VerificationLevel } from '@judge-copilot/schemas';

/*
 * label-policy/b-no-promotion/v1 (design §4.4, owner decision D2 = Option B). The ONE place M5 chooses a verification label.
 *
 *   statement evidence (team-authored text)  -> team_claim
 *   interpreted fact (repository / HTTP)     -> unverified
 *   event-context reference evidence         -> unverified
 *   claim                                    -> team_claim
 *
 * `repo_corroborated`, `machine_verified`, `judge_verified`, `live_verified` and `contradicted` are NEVER assigned by M5. A model is
 * never offered a level; the model-output schemas are strict, so a smuggled level is rejected before it reaches this module.
 */

export const LABEL_POLICY_ID = 'label-policy/b-no-promotion/v1' as const;

/** Every level this policy can ever emit. */
export const EMITTABLE_LEVELS = [
  'unverified',
  'team_claim',
] as const satisfies readonly VerificationLevel[];

export type EvidenceRole = 'statement' | 'interpreted_fact' | 'event_reference';

export function levelForEvidence(role: EvidenceRole): (typeof EMITTABLE_LEVELS)[number] {
  switch (role) {
    case 'statement':
      return 'team_claim';
    case 'interpreted_fact':
    case 'event_reference':
      return 'unverified';
  }
}

export function levelForClaim(): 'team_claim' {
  return 'team_claim';
}

export function kindForEvidence(role: EvidenceRole): Extract<EvidenceKind, 'claim' | 'fact'> {
  return role === 'statement' ? 'claim' : 'fact';
}

export function originForEvidence(
  role: EvidenceRole,
  sourceType: 'devpost' | 'github' | 'deployment' | 'video' | null,
): EvidenceOrigin {
  if (role === 'event_reference') return 'event_context';
  if (sourceType === null)
    throw new Error('internal: a source-derived evidence item needs a source type');
  return sourceType;
}
