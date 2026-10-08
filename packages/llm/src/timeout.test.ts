import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { ScriptedProvider } from './scripted.js';
import { withTimeout } from './timeout.js';
import { ok, request, signal } from './testing/builders.js';

const withMs = (timeoutMs: number) =>
  request({ generation: { effort: 'low', maxOutputTokens: 100, timeoutMs } });

describe('withTimeout', () => {
  it('passes a prompt answer through and cancels its timer', async () => {
    const clock = new ManualClock();
    const result = await withTimeout(new ScriptedProvider([ok({ a: 1 })]), clock).generate(
      withMs(1_000),
      signal(),
    );
    expect(result).toMatchObject({ ok: true, json: { a: 1 } });
    expect(clock.pending).toBe(0);
  });

  it('times out a hung provider, aborts it, and reports the cost as possible (sent_unknown)', async () => {
    const clock = new ManualClock();
    let providerSignal: AbortSignal | undefined;
    const hung = new ScriptedProvider([
      (_r, s) => {
        providerSignal = s;
        return new Promise(() => undefined); // ignores its signal on purpose
      },
    ]);
    const pending = withTimeout(hung, clock).generate(withMs(5_000), signal());
    await clock.advance(4_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await clock.advance(0);
    expect(settled).toBe(false);
    await clock.advance(1);
    expect(await pending).toEqual({ ok: false, category: 'timeout', sendState: 'sent_unknown' });
    expect(providerSignal?.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('ignores a late answer from an abandoned call', async () => {
    const clock = new ManualClock();
    let release: (() => void) | undefined;
    const slow = new ScriptedProvider([
      () =>
        new Promise(
          (resolve) =>
            (release = () => {
              resolve(ok());
            }),
        ),
    ]);
    const pending = withTimeout(slow, clock).generate(withMs(100), signal());
    await clock.advance(100);
    expect(await pending).toMatchObject({ category: 'timeout' });
    release?.();
    await clock.advance(0); // nothing may throw or double-resolve
  });

  it('returns cancelled when the caller aborts mid-flight, even if the provider ignores the signal', async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const hung = new ScriptedProvider([() => new Promise(() => undefined)]);
    const pending = withTimeout(hung, clock).generate(withMs(60_000), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, category: 'cancelled', sendState: 'sent_unknown' });
    expect(clock.pending).toBe(0);
  });

  it('does not call the provider at all when already aborted', async () => {
    const provider = new ScriptedProvider([ok()]);
    const controller = new AbortController();
    controller.abort();
    const result = await withTimeout(provider, new ManualClock()).generate(
      withMs(1_000),
      controller.signal,
    );
    expect(result).toMatchObject({ category: 'cancelled', sendState: 'not_sent' });
    expect(provider.requests).toHaveLength(0);
  });

  it('turns a throwing provider into a failure of possible cost, never a crash', async () => {
    const provider = new ScriptedProvider([{ throws: new Error('sk-secret leaked in message') }]);
    const result = await withTimeout(provider, new ManualClock()).generate(withMs(1_000), signal());
    expect(result).toMatchObject({ ok: false, sendState: 'sent_unknown' });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });
});
