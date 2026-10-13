import { afterEach, describe, expect, it } from 'vitest';
import { openMessage, sealMessage, withSealedError } from '../../apps/web/lib/flash.js';

/*
 * R7-7: an `?error=` query parameter is attacker-controllable text. Only a message that THIS server sealed may be shown as the
 * application's own error banner; everything else must verify as nothing.
 */

afterEach(() => {
  delete process.env['JUDGE_FLASH_KEY'];
});

describe('sealed redirect messages', () => {
  it('round-trips a message produced by this server, including hostile-looking and non-ASCII text, as plain text', () => {
    for (const message of [
      'Slug already taken.',
      '<script>alert(1)</script>',
      'Zażółć gęślą jaźń — “quotes” & ampersands',
      'line one\nline two',
    ]) {
      expect(openMessage(sealMessage(message))).toBe(message);
    }
  });

  it('shows nothing for text a visitor wrote into the URL', () => {
    for (const forged of [
      'Your session expired. Call 0800 123 to restore access.',
      'abc.def',
      '.',
      '',
      'no-dot-at-all',
      'AAAA.' + Buffer.from('forged').toString('base64url'),
      `${'A'.repeat(43)}.${Buffer.from('forged').toString('base64url')}`,
    ]) {
      expect(openMessage(forged)).toBeNull();
    }
    expect(openMessage(undefined)).toBeNull();
  });

  it('rejects a sealed message whose text was changed, whose signature was changed, or that was cut short', () => {
    const sealed = sealMessage('The capture could not be requested.');
    const [signature = '', encoded = ''] = sealed.split('.');
    const swapped = Buffer.from('Visit evil.example to fix this.').toString('base64url');
    expect(openMessage(`${signature}.${swapped}`)).toBeNull();
    expect(openMessage(`${signature.slice(0, -2)}xx.${encoded}`)).toBeNull();
    expect(openMessage(sealed.slice(0, -3))).toBeNull();
    expect(openMessage(`${sealed}A`)).toBeNull();
  });

  it('is bound to the server key: a value sealed under another key is not accepted', () => {
    process.env['JUDGE_FLASH_KEY'] = 'first-key';
    const sealed = sealMessage('Hello');
    expect(openMessage(sealed)).toBe('Hello');
    process.env['JUDGE_FLASH_KEY'] = 'second-key';
    expect(openMessage(sealed)).toBeNull();
  });

  it('caps the length and produces a URL-safe parameter', () => {
    const opened = openMessage(sealMessage('x'.repeat(5000)));
    expect(opened?.length).toBe(400);
    const url = withSealedError('/projects/p1/capture', 'Could not "retry" & <go>');
    expect(url).toMatch(/^\/projects\/p1\/capture\?error=[A-Za-z0-9_\-.%]+$/);
    const param = decodeURIComponent(url.split('error=')[1] ?? '');
    expect(openMessage(param)).toBe('Could not "retry" & <go>');
  });
});
