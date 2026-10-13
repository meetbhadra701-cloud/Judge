import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * One-shot error messages that survive a redirect (R7-7). A server action that fails redirects to its page with the API's message in the
 * URL, and the page shows it. A plain `?error=<text>` would let ANYONE craft a link that displays arbitrary text inside the application's
 * own error banner (phishing, false instructions, false claims about the project). So the message travels SEALED: `?error=<signature>.<message>`,
 * where the signature is an HMAC under a key only this server process knows. A value that was not produced by this server verifies as
 * nothing and is never displayed.
 *
 * The key lives for the lifetime of the server process (the web tier is a single local process); an old link opened after a restart shows
 * no message, which is the safe direction. Set JUDGE_FLASH_KEY to make links survive restarts or to run several instances.
 */

const MAX_MESSAGE_CHARS = 400;
const KEY_SLOT = Symbol.for('judge-copilot.web.flash-key');

function key(): Buffer {
  const holder = globalThis as unknown as Record<symbol, Buffer | undefined>;
  const configured = process.env['JUDGE_FLASH_KEY'];
  if (configured !== undefined && configured !== '') return Buffer.from(configured, 'utf8');
  // one key per process even when the framework bundles actions and pages separately
  holder[KEY_SLOT] ??= randomBytes(32);
  return holder[KEY_SLOT];
}

function sign(encoded: string): string {
  return createHmac('sha256', key()).update(encoded).digest('base64url');
}

/** The value of the `error` query parameter for a message produced by this server. */
export function sealMessage(message: string): string {
  const encoded = Buffer.from(message.slice(0, MAX_MESSAGE_CHARS), 'utf8').toString('base64url');
  return `${sign(encoded)}.${encoded}`;
}

/** The message, only if THIS server sealed it; anything else (absent, forged, truncated, from another process) is null. */
export function openMessage(value: string | undefined): string | null {
  if (value === undefined) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const signature = value.slice(0, dot);
  const encoded = value.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(signature) || !/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  const expected = Buffer.from(sign(encoded));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const message = Buffer.from(encoded, 'base64url').toString('utf8');
  return message === '' ? null : message;
}

/** `path?error=<sealed message>`. */
export function withSealedError(path: string, message: string): string {
  return `${path}?error=${encodeURIComponent(sealMessage(message))}`;
}
