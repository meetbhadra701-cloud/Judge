/*
 * Test-only: request/run helpers shared by the M5 P4 persistence tests. Excluded from the package build and exports.
 */
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { JudgeDatabase } from '../client.js';
import {
  AssessmentRunStore,
  type PinnedInputs,
  type RequestAssessmentInput,
  type RequestAssessmentResult,
} from '../assessment-run-store.js';
import { defaultLimits, type AssessmentWorld } from './assessment-world.js';

let keyCounter = 0;
export const freshKey = (): string =>
  `key-${String(Date.now())}-${String((keyCounter += 1))}-abcdefgh`;

/** The pure key function used by the tests: a digest of the pins, the target and the salt. */
export const keyOfPins = (pins: PinnedInputs, salt: string): string =>
  sha256Hex(canonicalJson({ pins, salt }));

export function requestInput(
  world: AssessmentWorld,
  overrides: Partial<RequestAssessmentInput> = {},
): RequestAssessmentInput {
  return {
    projectId: world.project.id,
    actorId: world.actor.id,
    idempotencyKey: freshKey(),
    mode: 'assess',
    requestHash: sha256Hex('{"mode":"assess"}'),
    target: { kind: 'overall' },
    pipelineConfig: { pipeline: 'test/v1' },
    pipelineConfigHash: sha256Hex('pipeline-config'),
    limits: defaultLimits(),
    priceTableId: 'prices/v1',
    assessmentKey: keyOfPins,
    ...overrides,
  };
}

export const newRunStore = (db: JudgeDatabase, now?: () => Date) =>
  new AssessmentRunStore({ db, ...(now === undefined ? {} : { now }) });

export function createdRunId(result: RequestAssessmentResult): string {
  if (result.kind !== 'run_created') throw new Error(`expected run_created, got ${result.kind}`);
  return result.runId;
}
