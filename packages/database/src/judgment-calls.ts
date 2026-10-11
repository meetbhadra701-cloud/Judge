import type { JudgmentInput } from './assessment-store.js';

/*
 * R4 F7: which ledger calls a judgment may cite, and what they must prove. Pure: the persistence transaction reads the run's ledger once
 * and passes the rows here; migration 0013 enforces the same essentials in the database (stage, run, dimension, valid last response),
 * so a direct SQL insert cannot skip them.
 *
 * A call is cited for ONE dimension. The binding is the ledger row's own `dimension_id`, set from the request that was sent and covered
 * by the hash that binds its closed set (`call-binding/v1`), so citing call 7 for another dimension, or a critic call as an assessor
 * call, is refused. The critic orchestrator is not implemented in P4: this only makes the interface ready to reject wrong bindings.
 *
 * "Valid" is deliberately narrow and mechanical: the call settled with a measured usage, a stored response, the success outcome code and
 * no reservation overrun. An `unknown` or `released` attempt, or one that settled with an error code, never proves that a review or an
 * assessment happened. Whether a response is semantically adequate is the pipeline's decision (P3 gates), recorded in the disposition.
 */

export interface LedgerCallView {
  readonly seq: number;
  readonly stage: string;
  readonly dimensionId: string | null;
  readonly state: string;
  readonly responseRecord: string;
  readonly outcomeCode: string | null;
  readonly boundViolation: boolean;
  readonly providerMode: string | null;
}

export const SUCCESS_OUTCOME_CODE = 'ok';

export const isValidResponse = (call: LedgerCallView): boolean =>
  call.state === 'settled' &&
  call.responseRecord === 'stored' &&
  call.outcomeCode === SUCCESS_OUTCOME_CODE &&
  !call.boundViolation;

/** Dispositions that rest on a valid assessor response (a model judgment existed, whatever became of it afterwards). */
const NEEDS_VALID_ASSESSOR: ReadonlySet<string> = new Set([
  'scored',
  'assessor_reported_insufficient',
  'event_reference_only',
  'no_project_derived_citation',
  'no_applicable_context_cited',
  'no_declared_need_satisfied',
  'marked_insufficient_by_critic',
  'critic_unavailable',
]);
/** Dispositions decided by code before any model call. */
const PRE_GATED: ReadonlySet<string> = new Set([
  'no_candidate_evidence',
  'no_satisfiable_need',
  'no_official_requirement_available',
  'official_requirement_omitted_by_limit',
]);

export type CallIssueCode =
  | 'call_not_found'
  | 'call_wrong_stage'
  | 'call_wrong_dimension'
  | 'call_not_finished'
  | 'call_cited_twice'
  | 'pre_gated_with_calls'
  | 'assessor_response_missing'
  | 'assessor_attempt_missing'
  | 'critic_review_unproven'
  | 'critic_rejection_without_review'
  | 'critic_unavailable_shape'
  | 'provider_mode_mismatch';

export interface CallIssue {
  readonly code: CallIssueCode;
  readonly dimensionId: string;
  readonly seq?: number;
}

export function checkJudgmentCalls(
  judgments: readonly JudgmentInput[],
  calls: readonly LedgerCallView[],
  providerMode: string,
): CallIssue[] {
  const issues: CallIssue[] = [];
  const bySeq = new Map(calls.map((call) => [call.seq, call]));
  const cited = new Set<number>();
  for (const call of calls) {
    if (call.providerMode !== null && call.providerMode !== providerMode) {
      issues.push({
        code: 'provider_mode_mismatch',
        dimensionId: call.dimensionId ?? '',
        seq: call.seq,
      });
    }
  }
  for (const judgment of judgments) {
    const id = judgment.dimensionId;
    const add = (code: CallIssueCode, seq?: number) =>
      issues.push(seq === undefined ? { code, dimensionId: id } : { code, dimensionId: id, seq });
    const resolve = (seqs: readonly number[], stage: 'dimension_assessment' | 'critic') => {
      const resolved: LedgerCallView[] = [];
      for (const seq of seqs) {
        const call = bySeq.get(seq);
        if (!call) {
          add('call_not_found', seq);
          continue;
        }
        if (call.stage !== stage) add('call_wrong_stage', seq);
        if (call.dimensionId !== id) add('call_wrong_dimension', seq);
        if (call.state === 'reserved') add('call_not_finished', seq);
        if (cited.has(seq)) add('call_cited_twice', seq);
        cited.add(seq);
        resolved.push(call);
      }
      return resolved;
    };
    const assessor = resolve(judgment.assessorCallSeqs, 'dimension_assessment');
    const critic = resolve(judgment.criticCallSeqs, 'critic');
    const last = <T extends LedgerCallView>(list: readonly T[]): T | undefined =>
      list.reduce<T | undefined>(
        (best, call) => (best && best.seq > call.seq ? best : call),
        undefined,
      );
    const lastAssessor = last(assessor);
    const lastCritic = last(critic);

    if (PRE_GATED.has(judgment.disposition)) {
      if (assessor.length > 0 || critic.length > 0) add('pre_gated_with_calls');
    } else if (NEEDS_VALID_ASSESSOR.has(judgment.disposition)) {
      if (!lastAssessor || !isValidResponse(lastAssessor)) add('assessor_response_missing');
    } else if (assessor.length === 0) {
      // assessor_output_invalid / provider_refused: the machinery was tried, and the attempts are on record
      add('assessor_attempt_missing');
    }
    if (judgment.criticReviewed && (!lastCritic || !isValidResponse(lastCritic))) {
      add('critic_review_unproven');
    }
    if (judgment.disposition === 'marked_insufficient_by_critic' && !judgment.criticReviewed) {
      add('critic_rejection_without_review');
    }
    if (
      judgment.disposition === 'critic_unavailable' &&
      (judgment.criticReviewed || critic.length === 0)
    ) {
      add('critic_unavailable_shape');
    }
  }
  return issues;
}
