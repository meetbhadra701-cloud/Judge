import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The M2 web UI forwards ONE server-side bearer credential (JUDGE_API_TOKEN) to the API on behalf
 * of every visitor and has no login of its own. Until a real per-user authentication/session
 * boundary exists, it must only be reachable from the machine it runs on. Next.js binds to every
 * interface (0.0.0.0) unless told otherwise, so the scripts must say so explicitly.
 */
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../apps/web/package.json'), 'utf8'),
) as { scripts: Record<string, string> };

const LOOPBACK_FLAG = /(?:^|\s)(?:--hostname|-H)(?:\s+|=)127\.0\.0\.1(?:\s|$)/;
const EXPOSING = /0\.0\.0\.0|(?:--hostname|-H)(?:\s+|=)(?:::|\[::\]|localhost\.localdomain)/;

describe('web UI network exposure', () => {
  it('binds development and production starts explicitly to 127.0.0.1', () => {
    expect(manifest.scripts['dev']).toMatch(/^next dev\b/);
    expect(manifest.scripts['start']).toMatch(/^next start\b/);
    expect(manifest.scripts['dev']).toMatch(LOOPBACK_FLAG);
    expect(manifest.scripts['start']).toMatch(LOOPBACK_FLAG);
  });

  it('has no script that starts Next.js without the loopback binding', () => {
    const servers = Object.entries(manifest.scripts).filter(([, command]) =>
      /\bnext\s+(dev|start)\b/.test(command),
    );
    expect(servers.map(([name]) => name).sort()).toEqual(['dev', 'start']);
    for (const [, command] of servers) {
      expect(command).toMatch(LOOPBACK_FLAG);
      expect(command).not.toMatch(EXPOSING);
    }
  });

  it('documents that remote exposure is unsupported', () => {
    for (const file of ['README.md', 'docs/SECURITY.md']) {
      const text = readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8');
      expect(text, file).toMatch(/loopback/i);
      expect(text, file).toMatch(/unsupported/i);
    }
  });
});
