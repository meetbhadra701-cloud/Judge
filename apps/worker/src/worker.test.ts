import { Writable } from 'node:stream';
import { createLogger } from '@judge-copilot/shared';
import { describe, expect, it } from 'vitest';
import { createWorker, SERVICE_NAME } from './worker.js';

describe('createWorker', () => {
  it('starts, reports no job handlers, and stops idempotently', async () => {
    const messages: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        messages.push((JSON.parse(chunk.toString()) as { msg: string }).msg);
        callback();
      },
    });
    const worker = createWorker({ logger: createLogger({ service: SERVICE_NAME, destination }) });

    expect(worker.running).toBe(false);
    worker.start();
    worker.start();
    expect(worker.running).toBe(true);

    await worker.stop();
    await worker.stop();
    expect(worker.running).toBe(false);
    expect(messages).toEqual(['worker started', 'worker stopped']);
  });
});
