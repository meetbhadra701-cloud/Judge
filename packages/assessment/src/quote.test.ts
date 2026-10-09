import { sliceCodePoints } from '@judge-copilot/evidence';
import { describe, expect, it } from 'vitest';
import { locateQuote, type LocateResult } from './quote.js';
import { artifact, seeded } from './testing/world.js';
import { codePointCount, toCodePoints } from './text.js';
import { buildPassages, type Passage, type SourceArtifact } from './windowing.js';

/*
 * F3 (carriage returns and quotes). The policy these tests pin down:
 *   - captured text is never altered, and no offset is ever computed on a normalized copy;
 *   - a quote can never contain a carriage return or another forbidden control (the Quote schema), so a quote cannot cross a CRLF /
 *     CR line ending: it is REJECTED (`quote_crosses_line_ending`), never "fixed" by normalizing;
 *   - single-line quotes in CRLF / CR text ARE located, with exact original code-point spans.
 */

function passageOf(art: SourceArtifact): Passage {
  const result = buildPassages([art]);
  const passage = result.passages[0];
  if (!passage) throw new Error('no passage');
  return passage;
}
const passageOfText = (text: string, key = 'submission.txt') =>
  passageOf(artifact({ sourceType: 'devpost', key, kind: 'submission_text', text }));

function located(result: LocateResult) {
  if (!result.ok) throw new Error(`expected a location, got ${result.code}`);
  return result.located;
}

describe('locateQuote: exact, unique, original-text offsets', () => {
  it('locates a unique quote and derives the span and excerpt from the original', () => {
    const text =
      'Our app helps students track daily water intake.\nIt sends reminders every two hours.\n';
    const passage = passageOfText(text);
    const quote = 'It sends reminders every two hours.';
    const hit = located(locateQuote(passage, quote));
    expect(hit.start).toBe(49);
    expect(hit.end).toBe(49 + codePointCount(quote));
    expect(sliceCodePoints(text, hit.start, hit.end)).toBe(quote);
    expect(hit.excerpt).toBe(quote);
    expect(hit.passageHandle).toBe(passage.handle);
    expect(hit.snapshotId).toBe(passage.snapshotId);
    expect(hit.artifactId).toBe(passage.artifactId);
  });

  it('adds the passage offset: a quote in a later passage maps to the original text', () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `Statement number ${String(i)} says something unique.`,
    );
    const text = `${lines.join('\n')}\n`;
    const art = artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text,
    });
    const { passages } = buildPassages([art]);
    expect(passages.length).toBeGreaterThan(3);
    const last = passages[passages.length - 1];
    if (!last) throw new Error('no passage');
    const quote = 'Statement number 199 says something unique.';
    const hit = located(locateQuote(last, quote));
    expect(last.start).toBeGreaterThan(0);
    expect(sliceCodePoints(text, hit.start, hit.end)).toBe(quote);
  });

  it('rejects zero matches and never normalizes the stored text or the quote', () => {
    const passage = passageOfText('The café serves tea every morning.\n'); // NFD é
    expect(locateQuote(passage, 'The café serves tea every morning.')).toEqual({
      ok: false,
      code: 'quote_not_found',
    }); // NFC quote
    expect(located(locateQuote(passage, 'The café serves tea'))).toBeTruthy();
    expect(locateQuote(passage, 'the café serves tea')).toEqual({
      ok: false,
      code: 'quote_not_found',
    }); // case differs
    expect(locateQuote(passage, 'The  café serves tea')).toEqual({
      ok: false,
      code: 'quote_not_found',
    }); // whitespace differs
  });

  it('rejects an ambiguous quote, counting overlapping occurrences', () => {
    const passage = passageOfText('abababababab and some more text here\n');
    expect(locateQuote(passage, 'abababab')).toEqual({ ok: false, code: 'quote_ambiguous' }); // overlaps itself
    const twice = passageOfText('We store data. We store data. Different end.\n');
    expect(locateQuote(twice, 'We store data.')).toEqual({ ok: false, code: 'quote_ambiguous' });
    expect(located(locateQuote(twice, 'We store data. Different end.'))).toBeTruthy();
  });

  it('rejects invalid quotes: too short, too long, blank, control characters, malformed Unicode', () => {
    const passage = passageOfText('Some perfectly fine passage text for the tests.\n');
    expect(locateQuote(passage, 'short')).toEqual({ ok: false, code: 'quote_invalid' });
    expect(locateQuote(passage, 'x'.repeat(2_001))).toEqual({ ok: false, code: 'quote_invalid' });
    expect(locateQuote(passage, ' '.repeat(10))).toEqual({ ok: false, code: 'quote_blank' });
    expect(locateQuote(passage, 'text for\u001Bthe tests')).toEqual({
      ok: false,
      code: 'quote_invalid',
    });
    expect(locateQuote(passage, 'text for \uD800 tests')).toEqual({
      ok: false,
      code: 'quote_invalid',
    });
    expect(locateQuote(passage, 'fine passage\u0000text')).toEqual({
      ok: false,
      code: 'quote_invalid',
    });
  });

  it('counts astral code points, not UTF-16 units, in the span', () => {
    const text = 'Prefix 💧💧💧 then the water tracker reminds you 🚰 hourly.\n';
    const passage = passageOfText(text);
    const quote = 'the water tracker reminds you 🚰 hourly.';
    const hit = located(locateQuote(passage, quote));
    expect(hit.start).toBe(toCodePoints('Prefix 💧💧💧 then ').length);
    expect(hit.end - hit.start).toBe(toCodePoints(quote).length);
    expect(hit.end - hit.start).not.toBe(quote.length);
    expect(sliceCodePoints(text, hit.start, hit.end)).toBe(quote);
  });

  it('rejects a quote that would begin or end inside a combining sequence', () => {
    const passage = passageOfText('Say café and naïve out loud, please.\n');
    // ends right before the combining acute accent: would cut the character in half
    expect(locateQuote(passage, 'Say cafe and naï')).toEqual({
      ok: false,
      code: 'quote_not_found',
    });
    const cut = passageOfText('Say café and more words follow here.\n');
    // the quote is valid and unique, but ends right before the combining accent: a span must not cut a character in half
    expect(locateQuote(cut, 'Say cafe')).toEqual({ ok: false, code: 'quote_splits_character' });
  });
});

describe('F3: carriage returns and the quote policy', () => {
  const CRLF =
    'First line of the readme.\r\nSecond line of the readme.\r\nThird line is the last.\r\n';
  const CR = 'Old mac line one here.\rOld mac line two here.\rOld mac line three.\r';
  const LF = 'First line of the readme.\nSecond line of the readme.\nThird line is the last.\n';

  it('locates a single-line quote inside CRLF text, with exact original code-point offsets', () => {
    const passage = passageOfText(CRLF);
    const quote = 'Second line of the readme.';
    const hit = located(locateQuote(passage, quote));
    expect(hit.start).toBe(27); // "First line of the readme.\r\n" is 27 code points
    expect(sliceCodePoints(CRLF, hit.start, hit.end)).toBe(quote);
    expect(hit.excerpt).toBe(quote);
  });

  it('locates a single-line quote inside lone-CR text', () => {
    const passage = passageOfText(CR);
    const quote = 'Old mac line two here.';
    const hit = located(locateQuote(passage, quote));
    expect(sliceCodePoints(CR, hit.start, hit.end)).toBe(quote);
  });

  it('locates a multi-line quote in LF text (a newline is quotable)', () => {
    const passage = passageOfText(LF);
    const quote = 'Second line of the readme.\nThird line is the last.';
    const hit = located(locateQuote(passage, quote));
    expect(sliceCodePoints(LF, hit.start, hit.end)).toBe(quote);
  });

  it('REJECTS a multi-line quote over CRLF text instead of normalizing line endings', () => {
    const passage = passageOfText(CRLF);
    const quote = 'Second line of the readme.\nThird line is the last.';
    expect(locateQuote(passage, quote)).toEqual({ ok: false, code: 'quote_crosses_line_ending' });
    // the diagnostic never produced a position, and the captured text is untouched
    expect(passage.text).toBe(CRLF);
  });

  it('REJECTS a multi-line quote over lone-CR text', () => {
    const passage = passageOfText(CR);
    expect(locateQuote(passage, 'Old mac line one here.\nOld mac line two here.')).toEqual({
      ok: false,
      code: 'quote_crosses_line_ending',
    });
  });

  it('REJECTS a quote that contains a carriage return (a forbidden character), however it is written', () => {
    const passage = passageOfText(CRLF);
    expect(locateQuote(passage, 'Second line of the readme.\r\nThird line is the last.')).toEqual({
      ok: false,
      code: 'quote_invalid',
    });
    expect(locateQuote(passage, 'Second line of the readme.\r')).toEqual({
      ok: false,
      code: 'quote_invalid',
    });
  });

  it('reports not_found (not crosses_line_ending) when the text is simply different', () => {
    const passage = passageOfText(CRLF);
    expect(locateQuote(passage, 'This sentence is not in the text at all.')).toEqual({
      ok: false,
      code: 'quote_not_found',
    });
  });

  it('never matches across a passage boundary', () => {
    const text = `${'x'.repeat(1_199)}\n${'y'.repeat(30)}\n`;
    const art = artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text,
    });
    const { passages } = buildPassages([art]);
    expect(passages).toHaveLength(2);
    const [first, second] = passages;
    if (!first || !second) throw new Error('passages');
    const across = `${'x'.repeat(10)}\n${'y'.repeat(10)}`;
    expect(locateQuote(first, across).ok).toBe(false);
    expect(locateQuote(second, across).ok).toBe(false);
  });

  it('does not match through a barrier character that was excluded from the passages', () => {
    const text = 'Visible words before the escape\u001Bvisible words after the escape\n';
    const art = artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text,
    });
    const { passages } = buildPassages([art]);
    expect(passages).toHaveLength(2);
    const crossing = 'before the escape\u001Bvisible';
    for (const passage of passages) expect(locateQuote(passage, crossing).ok).toBe(false);
    const [, after] = passages;
    if (!after) throw new Error('passage');
    const hit = located(locateQuote(after, 'visible words after the escape'));
    expect(sliceCodePoints(text, hit.start, hit.end)).toBe('visible words after the escape');
  });

  it('keeps offsets exact after a barrier, a CRLF, astral text and a repeated substring (mixed document)', () => {
    const text = [
      'intro 💧 line\r\n',
      'ESC\u001Bgone\r\n',
      'the unique target sentence lives here\r\n',
      'repeat me please\r\nrepeat me please\r\n',
    ].join('');
    const art = artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text,
    });
    const { passages } = buildPassages([art]);
    const hits: string[] = [];
    for (const quote of [
      'the unique target sentence lives here',
      'intro 💧 line',
      'repeat me please',
    ]) {
      const results = passages.map((p) => locateQuote(p, quote));
      const ok = results.filter((r) => r.ok);
      if (quote === 'repeat me please') {
        // two occurrences in the same passage: ambiguous everywhere
        expect(results.every((r) => !r.ok)).toBe(true);
        continue;
      }
      expect(ok).toHaveLength(1);
      const hit = located(ok[0] ?? { ok: false, code: 'quote_not_found' });
      expect(sliceCodePoints(text, hit.start, hit.end)).toBe(quote);
      hits.push(quote);
    }
    expect(hits).toHaveLength(2);
  });
});

describe('locateQuote against an independent reference (seeded property)', () => {
  /** A deliberately naive reference: scan code-point arrays, count overlapping matches. */
  function reference(passageText: string, quote: string): { count: number; first: number } {
    const text = toCodePoints(passageText);
    const needle = toCodePoints(quote);
    let count = 0;
    let first = -1;
    for (let i = 0; i + needle.length <= text.length; i += 1) {
      let same = true;
      for (let j = 0; j < needle.length; j += 1) {
        if (text[i + j] !== needle[j]) {
          same = false;
          break;
        }
      }
      if (same) {
        count += 1;
        if (first < 0) first = i;
      }
    }
    return { count, first };
  }

  it('agrees with the reference on uniqueness and offset for random texts and substrings', () => {
    const alphabets = [
      ['a', 'b', 'c', ' ', '\n', '💧', 'é', 'xyz', '.'],
      ['a', 'b', 'c', ' ', '\n', '\r\n', '💧', 'é', 'xyz', '.'],
    ];
    let checked = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const alphabet = alphabets[seed % 2] ?? [];
      const next = seeded(seed * 7919);
      let text = '';
      const pieces = 60 + Math.floor(next() * 300);
      for (let i = 0; i < pieces; i += 1)
        text += alphabet[Math.floor(next() * alphabet.length)] ?? '';
      const art = artifact({
        sourceType: 'devpost',
        key: 'submission.txt',
        kind: 'submission_text',
        text,
      });
      const { passages } = buildPassages([art]);
      for (const passage of passages) {
        const points = toCodePoints(passage.text);
        if (points.length < 12) continue;
        const start = Math.floor(next() * (points.length - 10));
        const length = 8 + Math.floor(next() * Math.min(20, points.length - start - 8 + 1));
        const quote = points.slice(start, start + length).join('');
        if (quote.includes('\r') || quote.trim().length === 0) continue;
        const result = locateQuote(passage, quote);
        const expected = reference(passage.text, quote);
        if (!result.ok && result.code === 'quote_splits_character') continue;
        checked += 1;
        if (expected.count === 1) {
          const hit = located(result);
          expect(hit.start).toBe(passage.start + expected.first);
          expect(sliceCodePoints(text, hit.start, hit.end)).toBe(quote);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe('quote_ambiguous');
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
