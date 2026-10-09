import { describe, expect, it } from 'vitest';
import { containsAccusation } from './neutral.js';

describe('neutral-language screen (invariant 25)', () => {
  it.each([
    'The team cheated on the benchmark.',
    'This looks like fraud.',
    'Clearly plagiarized from another repository.',
    'plagiarism detected',
    'They used fake data.',
    'The README lies about the architecture.',
    'He is lying about the demo.',
    'A dishonest description of the feature.',
    'They should be disqualified.',
    'The demo is deceptive and deceives the judges.',
    'It is a scam.',
    'The numbers were fabricated.',
    'They stole the code.',
    'misrepresents the work',
    'CHEATING',
    'ｆａｋｅ results', // full-width letters fold under NFKC
  ])('flags %j', (text) => {
    expect(containsAccusation(text)).toBe(true);
  });

  it.each([
    'The README describes offline mode, but the handler calls a remote API.',
    'The Devpost page and the deployment response differ on the version number.',
    'The claim cannot be checked from the captured material.',
    'The team believes the design relies on the cache.',
    'A client library is imported.',
    'Whether the reminder interval is configurable is not shown.',
  ])('does not flag neutral wording %j', (text) => {
    expect(containsAccusation(text)).toBe(false);
  });

  it('DOCUMENTED LIMIT: a paraphrase evades this heuristic backstop (the prompt and schema are the primary control)', () => {
    expect(containsAccusation('The work is not the team’s own.')).toBe(false);
    expect(containsAccusation('This was copied wholesale from elsewhere.')).toBe(false);
  });

  it('DOCUMENTED LIMIT: legitimate topic words can false-positive, which only rejects one item', () => {
    expect(containsAccusation('The project is a fraud detection dashboard.')).toBe(true);
  });
});
