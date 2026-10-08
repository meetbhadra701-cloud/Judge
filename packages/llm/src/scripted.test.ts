import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from './scripted.js';
import { fail, ok, request, signal } from './testing/builders.js';

describe('ScriptedProvider', () => {
  it('answers in order, records every request, and tracks what is left', async () => {
    const provider = new ScriptedProvider([ok({ n: 1 }), fail('refused', 'not_sent')]);
    expect(provider.mode).toBe('scripted');
    expect(await provider.generate(request(), signal())).toMatchObject({
      ok: true,
      json: { n: 1 },
    });
    expect(provider.remaining).toBe(1);
    expect(await provider.generate(request({ stage: 'critic' }), signal())).toMatchObject({
      category: 'refused',
    });
    expect(provider.requests.map((r) => r.stage)).toEqual(['claim_extraction', 'critic']);
  });

  it('supports function steps, enqueueing and repeatLast', async () => {
    const provider = new ScriptedProvider([(r) => ok({ stage: r.stage })], { repeatLast: true });
    expect(await provider.generate(request({ stage: 'critic' }), signal())).toMatchObject({
      json: { stage: 'critic' },
    });
    expect(await provider.generate(request({ stage: 'fidelity_review' }), signal())).toMatchObject({
      json: { stage: 'fidelity_review' },
    });
    const queued = new ScriptedProvider();
    queued.enqueue(ok({ later: true }));
    expect(await queued.generate(request(), signal())).toMatchObject({ json: { later: true } });
  });

  it('rejects when the script is exhausted so a test bug cannot pass silently', async () => {
    await expect(new ScriptedProvider().generate(request(), signal())).rejects.toThrow(
      /no step left/,
    );
  });

  it('models a hung provider that answers cancelled only when aborted', async () => {
    const provider = new ScriptedProvider(['hang']);
    const controller = new AbortController();
    const pending = provider.generate(request(), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ category: 'cancelled', sendState: 'sent_unknown' });
  });

  it('models a throwing SDK', async () => {
    await expect(
      new ScriptedProvider([{ throws: new Error('boom') }]).generate(request(), signal()),
    ).rejects.toThrow('boom');
  });
});
