import type { CriticFindingCode, CriticOutput, CriticSeverity } from '@judge-copilot/schemas';
import { issue, type DomainIssue } from './issues.js';
import { containsAccusation } from './neutral.js';

/*
 * Gate G7 and the critic decision table (design §9.1-§9.2). The critic returns FINDINGS ONLY: its schema has no score, no
 * replacement judgment and no verdict number, so it cannot rewrite anything. This module decides, deterministically, what happens
 * next; the critic's prose never reaches a later prompt (a re-run is told codes and handles only), so it is not a new injection
 * channel.
 */

/** A finding exactly as the strict critic schema defines it. */
export type CriticFinding = CriticOutput['findings'][number];

export type CriticGateResult =
  | { readonly ok: true; readonly findings: readonly CriticFinding[] }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/** G7. `shown` is the set of handles the critic was shown for this unit (cited records plus the other candidates). */
export function gateCritic(
  output: CriticOutput,
  unit: string,
  shown: ReadonlySet<string>,
): CriticGateResult {
  const issues: DomainIssue[] = [];
  if (output.unit !== unit) issues.push(issue('G7', 'wrong_unit', 'unit'));
  output.findings.forEach((finding, index) => {
    finding.evidence.forEach((handle, i) => {
      if (!shown.has(handle)) {
        issues.push(
          issue(
            'G7',
            'unknown_evidence_handle',
            `findings[${String(index)}].evidence[${String(i)}]`,
            handle,
          ),
        );
      }
    });
    if (new Set(finding.evidence).size !== finding.evidence.length) {
      issues.push(issue('G7', 'duplicate_evidence_handle', `findings[${String(index)}].evidence`));
    }
    if (containsAccusation(finding.note)) {
      issues.push(issue('G7', 'accusatory_language', `findings[${String(index)}].note`));
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, findings: output.findings };
}

// -- Decision table -------------------------------------------------------------------------------------------------------

export type RubricKind = 'official' | 'fallback';

/** Total assessor re-runs allowed per run (design §9.2). */
export const RERUN_CAPS: Readonly<Record<RubricKind, number>> = Object.freeze({
  official: 2,
  fallback: 8,
});

export interface CriticDecisionInput {
  /** The critic's gated findings, or null when its output was invalid after its single retry. */
  readonly findings: readonly CriticFinding[] | null;
  /** Handles of the evidence the judgment cites (an injection finding matters when it names one of them). */
  readonly citedHandles: ReadonlySet<string>;
  /** Whether this unit's assessor was already re-run once. */
  readonly alreadyRerun: boolean;
  /** Assessor re-runs already used by the whole run. */
  readonly runRerunsUsed: number;
  readonly rubric: RubricKind;
}

export interface RerunFeedback {
  readonly code: CriticFindingCode;
  readonly severity: CriticSeverity;
  readonly evidence: readonly string[];
}

export type CriticDecision =
  | { readonly action: 'accept'; readonly minor: readonly CriticFinding[] }
  | {
      readonly action: 'rerun';
      /** Codes and handles ONLY: never a critic note. */
      readonly feedback: readonly RerunFeedback[];
      /** Candidate handles to remove before the re-run (cited evidence with an injection finding). Still in the graph. */
      readonly removeFromCandidates: readonly string[];
    }
  | {
      readonly action: 'mark_insufficient';
      readonly disposition: 'marked_insufficient_by_critic';
      readonly reason: 'blocking_persisted' | 'rerun_cap_reached';
    }
  | { readonly action: 'technical_failure'; readonly disposition: 'critic_unavailable' };

const isInjectionOnCited = (finding: CriticFinding, cited: ReadonlySet<string>): boolean =>
  finding.code === 'injection_suspected' && finding.evidence.some((handle) => cited.has(handle));

export function decideAfterCritic(input: CriticDecisionInput): CriticDecision {
  if (input.findings === null) {
    // An unreviewed judgment is never accepted.
    return { action: 'technical_failure', disposition: 'critic_unavailable' };
  }
  const blocking = input.findings.filter((finding) => finding.severity === 'blocking');
  const injections = input.findings.filter((finding) =>
    isInjectionOnCited(finding, input.citedHandles),
  );
  if (blocking.length === 0 && injections.length === 0) {
    return { action: 'accept', minor: input.findings };
  }
  if (input.alreadyRerun) {
    return {
      action: 'mark_insufficient',
      disposition: 'marked_insufficient_by_critic',
      reason: 'blocking_persisted',
    };
  }
  if (input.runRerunsUsed >= RERUN_CAPS[input.rubric]) {
    return {
      action: 'mark_insufficient',
      disposition: 'marked_insufficient_by_critic',
      reason: 'rerun_cap_reached',
    };
  }
  const triggering = [...new Set([...blocking, ...injections])];
  const removed = new Set<string>();
  for (const finding of injections)
    for (const handle of finding.evidence) if (input.citedHandles.has(handle)) removed.add(handle);
  return {
    action: 'rerun',
    feedback: triggering.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      evidence: [...finding.evidence],
    })),
    removeFromCandidates: [...removed].sort(),
  };
}
