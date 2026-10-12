import type { AssessmentRunStore } from '@judge-copilot/database';
import { ManualClock } from '@judge-copilot/llm';
import { createLogger } from '@judge-copilot/shared';
import { describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_STOP_WAIT_MS, RunSession } from './session.js';
import { nullSink } from '../testing/probes.js';
import { RunStopped } from './stop.js';

const logger = createLogger({ service: 'test', destination: nullSink() });

function setup(
  heartbeat: () => Promise<boolean>,
  options: { leaseMs?: number; wallClockMs?: number } = {},
) {
  const clock = new ManualClock(1_000_000);
  const shutdown = new AbortController();
  const calls: number[] = [];
  const runs = {
    heartbeat: vi.fn(async () => {
      calls.push(clock.now());
      return heartbeat();
    }),
  } as unknown as AssessmentRunStore;
  const session = new RunSession({
    runId: 'run',
    leaseToken: 'token',
    runs,
    clock,
    leaseMs: options.leaseMs ?? 3_000,
    shutdown: shutdown.signal,
    wallClockMs: options.wallClockMs ?? 3_600_000,
    logger,
  });
  return { clock, shutdown, session, calls, runs };
}

const stopOf = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RunStopped) return error.stop;
    throw error;
  }
  return null;
};

describe('RunSession', () => {
  it('renews the lease on a timer (a third of the lease by default) until stopped', async () => {
    const { clock, session, calls } = setup(() => Promise.resolve(true));
    session.start();
    await clock.advance(3_500);
    expect(calls).toEqual([1_001_000, 1_002_000, 1_003_000]);
    expect(session.heartbeats).toBe(3);
    expect(
      stopOf(() => {
        session.checkpoint('stage');
      }),
    ).toBeNull();
    await session.stop();
    await clock.advance(10_000);
    expect(calls).toHaveLength(3); // no heartbeat after stop
  });

  it('stop() does not wait forever for a heartbeat query that never settles (R5 F-10)', async () => {
    const { clock, session } = setup(() => new Promise<boolean>(() => undefined));
    session.start();
    await clock.advance(1_100); // the first heartbeat is now in flight and never answers
    vi.useFakeTimers();
    try {
      let stopped = false;
      const pending = session.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_STOP_WAIT_MS - 1);
      expect(stopped).toBe(false); // still inside the bounded wait
      await vi.advanceTimersByTimeAsync(2);
      await pending;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale token (or a run someone else ended) aborts the signal and stops the worker writing', async () => {
    const { clock, session } = setup(() => Promise.resolve(false));
    session.start();
    await clock.advance(1_100);
    expect(session.signal.aborted).toBe(true);
    expect(session.reason).toBe('lease_lost');
    expect(
      stopOf(() => {
        session.checkpoint('extract');
      }),
    ).toEqual({ kind: 'lost', stage: 'extract' });
    await session.stop();
  });

  it('tolerates a database outage shorter than the lease, and loses the lease once the lease would have expired', async () => {
    let healthy = true;
    const { clock, session } = setup(
      () => (healthy ? Promise.resolve(true) : Promise.reject(new Error('down'))),
      { leaseMs: 3_000 },
    );
    session.start();
    await clock.advance(1_100); // one good beat
    healthy = false;
    await clock.advance(1_000);
    await clock.advance(1_000);
    expect(session.reason).toBeNull(); // 2 s since the last good beat: the lease (3 s) still holds
    expect(session.heartbeatFailures).toBeGreaterThanOrEqual(2);
    await clock.advance(2_000);
    expect(session.reason).toBe('lease_lost');
    await session.stop();
  });

  it('shutdown cancels (code worker_shutdown); a signal that is already aborted does so at once', async () => {
    const { shutdown, session } = setup(() => Promise.resolve(true));
    session.start();
    shutdown.abort();
    expect(session.reason).toBe('shutdown');
    expect(
      stopOf(() => {
        session.checkpoint('assess');
      }),
    ).toEqual({
      kind: 'cancel',
      code: 'worker_shutdown',
      stage: 'assess',
    });
    await session.stop();

    const late = setup(() => Promise.resolve(true));
    late.shutdown.abort();
    late.session.start();
    expect(late.session.reason).toBe('shutdown');
    await late.session.stop();
  });

  it('the wall-clock limit ends the run with category timeout', async () => {
    const { clock, session } = setup(() => Promise.resolve(true), {
      wallClockMs: 5_000,
      leaseMs: 60_000,
    });
    session.start();
    await clock.advance(5_100);
    expect(
      stopOf(() => {
        session.checkpoint('persist');
      }),
    ).toEqual({
      kind: 'fail',
      category: 'timeout',
      code: 'run_wall_clock_exceeded',
      stage: 'persist',
    });
    await session.stop();
  });

  it('a lost lease overrides every other reason: a worker may only write about a run it owns', async () => {
    const { shutdown, session } = setup(() => Promise.resolve(true));
    session.start();
    shutdown.abort();
    session.markLost();
    expect(session.reason).toBe('lease_lost');
    expect(
      stopOf(() => {
        session.checkpoint('x');
      })?.kind,
    ).toBe('lost');
    await session.stop();
  });
});
