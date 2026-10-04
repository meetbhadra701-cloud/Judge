import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, serializeError } from './logger.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: createLogger({ service: 'test-service', destination }), lines };
}

describe('createLogger', () => {
  it('emits structured JSON tagged with the service name', () => {
    const { logger, lines } = captureLogger();
    logger.info({ eventId: 'e1' }, 'hello');
    expect(lines[0]).toMatchObject({ service: 'test-service', msg: 'hello', eventId: 'e1' });
  });

  it('redacts secret-bearing keys at the top level and one level deep', () => {
    const { logger, lines } = captureLogger();
    logger.info({ token: 't0p', config: { apiKey: 'sk-live', DATABASE_URL: 'postgres://x' } });
    expect(lines[0]).toMatchObject({
      token: '[REDACTED]',
      config: { apiKey: '[REDACTED]', DATABASE_URL: '[REDACTED]' },
    });
  });

  it('logs errors through the allow-listed serializer, dropping SDK request payloads', () => {
    const { logger, lines } = captureLogger();
    const sdkError = Object.assign(new Error('upstream failed'), {
      code: 'ECONNRESET',
      request: { headers: { 'x-api-key': 'sk-secret' } },
    });
    logger.error({ err: sdkError }, 'call failed');

    const logged = lines[0]?.['err'] as Record<string, unknown>;
    expect(logged).toMatchObject({ type: 'Error', message: 'upstream failed', code: 'ECONNRESET' });
    expect(JSON.stringify(lines[0])).not.toContain('sk-secret');
  });
});

describe('serializeError', () => {
  it('handles non-Error throwables and nested causes', () => {
    expect(serializeError('boom')).toEqual({ type: 'string', message: 'Non-Error value thrown' });
    const serialized = serializeError(new Error('outer', { cause: new TypeError('inner') }));
    expect(serialized['cause']).toMatchObject({ type: 'TypeError', message: 'inner' });
  });
});
