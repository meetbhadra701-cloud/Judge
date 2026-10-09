import type { AssessmentRunFailureCategory } from '@judge-copilot/schemas';
import { classifyDisposition, type DispositionClass, type FinalUnit } from './judgment.js';

/*
 * The aggregate technical-failure rule (design §9.3, owner correction C6). Three kinds of "not assessed" stay apart:
 *   valid insufficiency   a successful, honest outcome (assessor-reported, a deterministic pre-gate, a code downgrade)
 *   substantive rejection the pipeline worked and judged the support inadequate (critic)
 *   technical failure     the machinery misbehaved (invalid assessor output, critic unavailable, provider refusal)
 * Only technical failure, in aggregate, fails a run. This is a PRODUCT HEURISTIC, not a correctness guarantee.
 */

export interface RunEvaluation {
  readonly units: number;
  readonly counts: Readonly<Record<DispositionClass, number>>;
  /** T = max(2, ceil(0.25 * U)). */
  readonly threshold: number;
  readonly technical: number;
  /** Rule 1: technical >= T. */
  readonly overThreshold: boolean;
  /** Rule 2: every unit ended technical (U >= 1). Without it, U = 1 could never fail (T = 2 > 1). */
  readonly allTechnical: boolean;
  readonly failRun: boolean;
  /** Set only when the run fails. */
  readonly failureCategory: Extract<
    AssessmentRunFailureCategory,
    'schema_validation_failed' | 'domain_validation_failed'
  > | null;
  /** More than half of the units ended insufficient for SUBSTANTIVE reasons: the result is thin. */
  readonly mostlyUnassessable: boolean;
  /** Informational: units that ended without a score for any non-technical reason. */
  readonly insufficientTotal: number;
}

export const technicalThreshold = (units: number): number => Math.max(2, Math.ceil(0.25 * units));

export function evaluateRun(units: readonly FinalUnit[]): RunEvaluation {
  if (units.length === 0) throw new Error('internal: a run needs at least one scoring unit');
  const counts: Record<DispositionClass, number> = {
    scored: 0,
    valid_insufficiency: 0,
    substantive: 0,
    technical: 0,
  };
  let schema = 0;
  let other = 0;
  for (const unit of units) {
    const kind = classifyDisposition(unit.disposition);
    counts[kind] += 1;
    if (kind === 'technical') {
      if (unit.cause === 'schema') schema += 1;
      else other += 1;
    }
  }
  const total = units.length;
  const threshold = technicalThreshold(total);
  const overThreshold = counts.technical >= threshold;
  const allTechnical = counts.technical === total;
  const failRun = overThreshold || allTechnical;
  return {
    units: total,
    counts,
    threshold,
    technical: counts.technical,
    overThreshold,
    allTechnical,
    failRun,
    // "schema when most of those failures were schema failures, otherwise domain"
    failureCategory: failRun
      ? schema > other
        ? 'schema_validation_failed'
        : 'domain_validation_failed'
      : null,
    mostlyUnassessable: counts.substantive * 2 > total,
    insufficientTotal: counts.valid_insufficiency + counts.substantive,
  };
}
