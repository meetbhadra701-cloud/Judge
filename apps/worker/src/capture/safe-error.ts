/*
 * Capture finalization talks to PostgreSQL with captured source text as bound parameters, and the
 * query builder's error messages embed those parameters ("Failed query: insert ... params: ...").
 * An error from that path must therefore never be logged, serialized or stored as it is. Only a
 * five-character SQLSTATE (for example `23514`) may leave this module; it carries no data.
 */

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The PostgreSQL SQLSTATE found on an error or its causes, or `unknown`. Never a message. */
export function safeErrorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return 'unknown';
}
