import { readFile } from 'node:fs/promises';
import { assertProviderAllowed, ReplayFixtureFile } from '@judge-copilot/llm';

/*
 * The runtime gate of the assessment API (M5 P6A). A run may be REQUESTED only when an explicitly configured OFFLINE provider is
 * available and approved by the same runtime gate the worker uses (`assertProviderAllowed`: the replay provider is allowed only when the
 * actual runtime environment is `development` or `test`, and fails closed otherwise) and its hand-written synthetic fixture is present
 * and valid. There is no live provider in P6A: this module imports exactly two names from the model package and calls no model.
 */

export interface OfflineAssessmentRuntime {
  readonly provider:
    | { readonly id: 'replay'; readonly mode: 'replay' }
    | { readonly id: 'scripted'; readonly mode: 'scripted' };
  /** The models named in the frozen pipeline configuration; a replay fixture is recorded for exactly these. */
  readonly models: {
    readonly extraction: string;
    readonly assessment: string;
    readonly critic: string;
  };
}

export interface GateInput {
  readonly provider: 'none' | 'replay' | 'scripted';
  readonly fixturePath: string | undefined;
  readonly models: OfflineAssessmentRuntime['models'];
  /** Test seam; production reads the file system. */
  readonly readFixture?: (path: string) => Promise<string>;
}

export type GateResult =
  | { readonly runtime: OfflineAssessmentRuntime; readonly problem: null }
  | { readonly runtime: null; readonly problem: string | null };

/** `runtime: null` with `problem: null` means "not configured" (the default); a problem names why a configured provider is unusable. */
export async function openOfflineGate(input: GateInput): Promise<GateResult> {
  if (input.provider === 'none') return { runtime: null, problem: null };
  if (input.provider === 'scripted') {
    // P6C: the scripted demonstration provider answers for any captured project and needs no fixture; it is refused outside development and test
    try {
      assertProviderAllowed('scripted');
    } catch {
      return {
        runtime: null,
        problem: 'the scripted demonstration provider is refused outside development and test',
      };
    }
    return {
      runtime: { provider: { id: 'scripted', mode: 'scripted' }, models: input.models },
      problem: null,
    };
  }
  try {
    assertProviderAllowed('replay');
  } catch {
    return {
      runtime: null,
      problem: 'the replay provider is refused outside development and test',
    };
  }
  if (!input.fixturePath) return { runtime: null, problem: 'ASSESSMENT_REPLAY_FIXTURE is not set' };
  try {
    const text = await (input.readFixture ?? ((path) => readFile(path, 'utf8')))(input.fixturePath);
    ReplayFixtureFile.parse(JSON.parse(text));
  } catch {
    return {
      runtime: null,
      problem: 'the replay fixture is missing or not a valid synthetic fixture',
    };
  }
  return {
    runtime: { provider: { id: 'replay', mode: 'replay' }, models: input.models },
    problem: null,
  };
}
