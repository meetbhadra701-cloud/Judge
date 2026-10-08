/*
 * Time and timers are injected, so retry, timeout and wall-clock behavior is deterministic in tests and the
 * default implementation is the only place that touches the real clock.
 */

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with an AbortError-named error as soon as `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Runs `callback` after `ms`; the returned function cancels it. */
  after(ms: number, callback: () => void): () => void;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

interface Timer {
  readonly due: number;
  readonly order: number;
  readonly callback: () => void;
}

/**
 * A deterministic clock for tests and replay: time moves only when told to. `sleep` waits for `advance`.
 * `advance(ms)` fires timers in due order and lets promise continuations run between them.
 */
export class ManualClock implements Clock {
  private current: number;
  private counter = 0;
  private readonly timers = new Map<number, Timer>();
  /** Every `sleep` request, in order (for asserting backoff). */
  readonly sleeps: number[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const cancel = this.after(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      const onAbort = () => {
        cancel();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  after(ms: number, callback: () => void): () => void {
    this.counter += 1;
    const id = this.counter;
    this.timers.set(id, { due: this.current + ms, order: id, callback });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Number of timers that have not fired or been cancelled. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing every timer that falls due. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await settle();
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, a], [, b]) => a.due - b.due || a.order - b.order)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = Math.max(this.current, timer.due);
      timer.callback();
    }
    this.current = target;
    await settle();
  }
}

/** Lets already-resolved promise continuations run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}
