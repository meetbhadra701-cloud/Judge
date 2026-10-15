import { describe, expect, it } from 'vitest';
import {
  normalizeSuppliedText,
  SUPPLIED_TEXT_MAX_CODE_POINTS,
  suppliedDevpostResult,
} from './supplied.js';

describe('organizer-supplied submission text', () => {
  const prose =
    'HydroTrack reminds you to drink water every two hours and stores your intake offline.';

  it('normalizes line endings, Unicode form and trailing space, and keeps the words exactly', () => {
    const checked = normalizeSuppliedText(`\n\n${prose}   \r\nSecond line\t\r\n\r\n`);
    expect(checked).toEqual({ ok: true, text: `${prose}\nSecond line` });
    expect(normalizeSuppliedText('Café reminder service for teams')).toMatchObject({
      ok: true,
      text: 'Café reminder service for teams',
    });
  });

  it.each([
    ['', 'empty'],
    ['  \n\t ', 'empty'],
    ['too short', 'too_short'],
    ['x'.repeat(SUPPLIED_TEXT_MAX_CODE_POINTS + 1), 'too_long'],
    [`${prose}\u0000`, 'control_characters'],
    [`${prose}‮ reversed`, 'control_characters'],
    [`${prose}\u0007`, 'control_characters'],
    [`${prose}${String.fromCodePoint(0x2028)} separator`, 'control_characters'],
    [`${String.fromCodePoint(0xfeff)}${prose}`, 'control_characters'],
  ])('refuses %j (%s)', (text, problem) => {
    expect(normalizeSuppliedText(text)).toEqual({ ok: false, problem });
  });

  it('accepts the maximum length', () => {
    expect(normalizeSuppliedText('word '.repeat(12_000).trim()).ok).toBe(true);
  });

  it('produces a valid captured devpost result that says what it is and carries no revision', () => {
    const result = suppliedDevpostResult(prose, 'https://devpost.com/software/hydrotrack');
    expect(result).toMatchObject({
      status: 'captured',
      revision: null,
      partialReasons: [],
      metadata: { provenance: 'organizer_supplied', adapterVersion: 'organizer-supplied/v1' },
    });
    if (!('artifacts' in result)) throw new Error('unreachable');
    expect(result.artifacts.map((a) => [a.key, a.kind])).toEqual([
      ['submission.json', 'submission'],
      ['submission.txt', 'submission_text'],
    ]);
    const note = JSON.parse(result.artifacts[0]?.textContent ?? '{}') as {
      statement: string;
      provenance: string;
    };
    expect(note.provenance).toBe('organizer_supplied');
    expect(note.statement).toContain('not fetched from Devpost');
    expect(result.artifacts[1]?.textContent).toBe(prose);
  });

  it('is deterministic: equal text gives equal hashes', () => {
    const a = suppliedDevpostResult(prose, 'https://devpost.com/software/x');
    const b = suppliedDevpostResult(`${prose}  \r\n`, 'https://devpost.com/software/x');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
