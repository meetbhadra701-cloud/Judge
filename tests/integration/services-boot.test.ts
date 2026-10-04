/*
 * Boots the real API and worker entrypoints as child processes, with the no-network guard
 * preloaded, and verifies they start and shut down cleanly on SIGTERM. No database or
 * external service is available or needed.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

interface LogLine {
  msg?: string;
  service?: string;
  level?: number;
  [key: string]: unknown;
}

interface BootResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logs: LogLine[];
  stderr: string;
}

/** Starts an entrypoint, waits until a log line satisfies `isReady`, sends SIGTERM, and collects the outcome. */
function bootAndStop(
  entrypoint: string,
  isReady: (line: LogLine) => boolean,
  env: Record<string, string> = {},
) {
  return new Promise<BootResult>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--conditions=@judge-copilot/source',
        '--import',
        'tsx',
        '--import',
        './tests/support/no-network.mjs',
        entrypoint,
      ],
      {
        cwd: ROOT,
        // A minimal environment: no DATABASE_URL, no credentials of any kind.
        env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', LOG_LEVEL: 'info', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const logs: LogLine[] = [];
    let stderr = '';
    let buffered = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${entrypoint} did not become ready. stderr:\n${stderr}`));
    }, 20_000);

    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        const parsed = JSON.parse(line) as LogLine;
        logs.push(parsed);
        if (isReady(parsed)) child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, signal, logs, stderr });
    });
  });
}

describe('service processes', () => {
  it('api boots without a database, serves, and exits 0 on SIGTERM', async () => {
    const result = await bootAndStop(
      'apps/api/src/main.ts',
      (line) => line.msg?.startsWith('Server listening at http://127.0.0.1:') === true,
      { API_HOST: '127.0.0.1', API_PORT: '0' },
    );
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.logs.every((line) => line.service === 'judge-copilot-api')).toBe(true);
    expect(result.logs.map((line) => line.msg)).toEqual(
      expect.arrayContaining(['shutdown signal received', 'api stopped']),
    );
  });

  it('worker boots without external services and exits 0 on SIGTERM', async () => {
    const result = await bootAndStop(
      'apps/worker/src/main.ts',
      (line) => line.msg === 'worker started',
    );
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.logs.map((line) => line.msg)).toEqual([
      'worker started',
      'shutdown signal received',
      'worker stopped',
    ]);
    expect(result.logs[0]).toMatchObject({ service: 'judge-copilot-worker', jobHandlers: 0 });
  });
});
