import { assertProviderAllowed } from './modes.js';
import type { LlmProvider, LlmResult, StructuredRequest } from './types.js';

/*
 * A scripted provider for tests: answers are queued by the test and every request is recorded. It is how the
 * adversarial suites feed malformed, hostile or failing "model" output through the real pipeline code. It is
 * refused in production, and it never reads a file or the network.
 */

export type ScriptedStep =
  | LlmResult
  | ((request: StructuredRequest, signal: AbortSignal) => LlmResult | Promise<LlmResult>)
  /** Never answers until the signal aborts, then returns `cancelled`: models a hung provider. */
  | 'hang'
  /** Rejects with the given error: models an SDK exception. */
  | { readonly throws: unknown };

export class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly mode = 'scripted' as const;
  readonly requests: StructuredRequest[] = [];
  private readonly queue: ScriptedStep[];
  private readonly fallback: ScriptedStep | undefined;

  constructor(
    steps: readonly ScriptedStep[] = [],
    options: { nodeEnv?: string; repeatLast?: boolean } = {},
  ) {
    assertProviderAllowed('scripted', options.nodeEnv);
    this.queue = [...steps];
    this.fallback = options.repeatLast ? steps[steps.length - 1] : undefined;
  }

  enqueue(...steps: ScriptedStep[]): void {
    this.queue.push(...steps);
  }

  get remaining(): number {
    return this.queue.length;
  }

  generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult> {
    this.requests.push(request);
    const step = this.queue.shift() ?? this.fallback;
    if (step === undefined) {
      return Promise.reject(new Error('ScriptedProvider has no step left for this request'));
    }
    if (step === 'hang') {
      return new Promise<LlmResult>((resolve) => {
        const done = () => {
          resolve({ ok: false, category: 'cancelled', sendState: 'sent_unknown' });
        };
        if (signal.aborted) done();
        else signal.addEventListener('abort', done, { once: true });
      });
    }
    if (typeof step === 'function') return Promise.resolve(step(request, signal));
    if ('throws' in step)
      return Promise.reject(
        step.throws instanceof Error ? step.throws : new Error('scripted throw'),
      );
    return Promise.resolve(step);
  }
}
