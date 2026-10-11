import type { AssessmentRunFailureCategory } from '@judge-copilot/schemas';

/*
 * How a run ends other than by persisting an assessment (design §9.3). Every ending is explicit: a pipeline function never returns a
 * value that could be mistaken for a score when it stopped. Control flow uses ONE exception type so that a stage cannot "continue
 * past" a failure by swallowing it: only the orchestrator's top level catches it and decides the terminal write.
 */

const CODE_FORMAT = /^[a-z][a-z0-9_]*$/;

/**
 * Failure codes and stage names are stored in `assessment_run_outcomes`, whose CHECK requires lowercase snake_case. A code that
 * violates it would make the terminal write fail and leave the run `running` until its lease expires, so every code is normalized
 * here, at the single place a stop is created.
 */
export function safeCode(code: string): string {
  if (CODE_FORMAT.test(code)) return code;
  const flat = code
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, 'x_')
    .replace(/_+$/, '')
    .slice(0, 80);
  return flat.length > 0 ? flat : 'unspecified';
}

export type Stop =
  /** The run failed: no assessment exists. The category and code are recorded in the run and its outcome row. */
  | {
      readonly kind: 'fail';
      readonly category: AssessmentRunFailureCategory;
      readonly code: string;
      readonly stage: string;
    }
  /** The run was cancelled (shutdown, or its pinned context was superseded): no assessment exists. */
  | { readonly kind: 'cancel'; readonly code: string; readonly stage: string }
  /** This worker no longer owns the run (lease lost, or another actor ended it): it must not write anything about it. */
  | { readonly kind: 'lost'; readonly stage: string };

export class RunStopped extends Error {
  constructor(readonly stop: Stop) {
    super(
      stop.kind === 'lost'
        ? 'run stopped: lease lost'
        : `run stopped: ${stop.kind} ${stop.code} (${stop.stage})`,
    );
    this.name = 'RunStopped';
  }
}

export function failRun(
  category: AssessmentRunFailureCategory,
  code: string,
  stage: string,
): never {
  throw new RunStopped({ kind: 'fail', category, code: safeCode(code), stage: safeCode(stage) });
}

export function cancelRun(code: string, stage: string): never {
  throw new RunStopped({ kind: 'cancel', code: safeCode(code), stage: safeCode(stage) });
}

export function lostRun(stage: string): never {
  throw new RunStopped({ kind: 'lost', stage });
}
