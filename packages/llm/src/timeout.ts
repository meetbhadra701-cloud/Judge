import type { Clock } from './clock.js';
import { failureFromError } from './failure.js';
import type { LlmProvider, LlmResult, StructuredRequest } from './types.js';

/*
 * Per-attempt timeout and cancellation. The wrapper does not trust the inner provider to honor its signal:
 * it races the call against the timer and against the caller's signal, so a hung provider still returns on
 * time. A late answer from the abandoned call is ignored (its usage is therefore NOT measured, and the spending
 * guard keeps the attempt counted at its full reservation: `sent_unknown`).
 */
export function withTimeout(inner: LlmProvider, clock: Clock): LlmProvider {
  return {
    id: inner.id,
    mode: inner.mode,
    generate(request: StructuredRequest, signal: AbortSignal): Promise<LlmResult> {
      if (signal.aborted) {
        return Promise.resolve({ ok: false, category: 'cancelled', sendState: 'not_sent' });
      }
      const controller = new AbortController();
      return new Promise<LlmResult>((resolve) => {
        let finished = false;
        const finish = (result: LlmResult) => {
          if (finished) return;
          finished = true;
          cancelTimer();
          signal.removeEventListener('abort', onParentAbort);
          resolve(result);
        };
        const cancelTimer = clock.after(request.generation.timeoutMs, () => {
          controller.abort();
          finish({ ok: false, category: 'timeout', sendState: 'sent_unknown' });
        });
        const onParentAbort = () => {
          controller.abort();
          finish({ ok: false, category: 'cancelled', sendState: 'sent_unknown' });
        };
        signal.addEventListener('abort', onParentAbort, { once: true });
        inner.generate(request, controller.signal).then(finish, (error: unknown) => {
          // A throwing provider is a transport failure of unknown cost, never a crash of the pipeline.
          finish({ ...failureFromError(error), sendState: 'sent_unknown' });
        });
      });
    },
  };
}
