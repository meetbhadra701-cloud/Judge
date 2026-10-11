/*
 * Test-only: request/run helpers shared by the M5 P4 persistence tests. Excluded from the package build and exports.
 */
import type { JudgeDatabase } from '../client.js';
import {
  AssessmentRunStore,
  type RequestAssessmentInput,
  type RequestAssessmentResult,
} from '../assessment-run-store.js';
import { defaultLimits, type AssessmentWorld } from './assessment-world.js';

let keyCounter = 0;
export const freshKey = (): string =>
  `key-${String(Date.now())}-${String((keyCounter += 1))}-abcdefgh`;

export function requestInput(
  world: AssessmentWorld,
  overrides: Partial<RequestAssessmentInput> = {},
): RequestAssessmentInput {
  return {
    projectId: world.project.id,
    actorId: world.actor.id,
    idempotencyKey: freshKey(),
    mode: 'assess',
    target: { kind: 'overall' },
    pipelineConfig: { pipeline: 'test/v1' },
    limits: defaultLimits(),
    priceTableId: 'prices/v1',
    ...overrides,
  };
}

export const newRunStore = (db: JudgeDatabase, now?: () => Date) =>
  new AssessmentRunStore({ db, ...(now === undefined ? {} : { now }) });

export function createdRunId(result: RequestAssessmentResult): string {
  if (result.kind !== 'run_created') throw new Error(`expected run_created, got ${result.kind}`);
  return result.runId;
}
