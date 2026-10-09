import { describe, expect, it } from 'vitest';
import { sourceGapUnknowns } from './source-gaps.js';

describe('code-authored missing unknowns', () => {
  it('writes one unknown per non-captured source, in a fixed order, from a closed vocabulary', () => {
    const unknowns = sourceGapUnknowns([
      { sourceType: 'video', status: 'absent' },
      { sourceType: 'github', status: 'failed' },
      { sourceType: 'deployment', status: 'partial' },
      { sourceType: 'devpost', status: 'captured' },
    ]);
    expect(unknowns.map((u) => u.gapKey)).toEqual([
      'github:failed',
      'deployment:partial',
      'video:absent',
    ]);
    expect(unknowns.map((u) => [u.unknownType, u.claims.length, u.evidence.length])).toEqual([
      ['missing', 0, 0],
      ['missing', 0, 0],
      ['missing', 0, 0],
    ]);
  });

  it('states a gap without inferring anything about the project', () => {
    for (const unknown of sourceGapUnknowns([{ sourceType: 'github', status: 'rejected' }])) {
      expect(unknown.text).toContain('Nothing is inferred about the project from this gap.');
      expect(unknown.text).not.toMatch(/weak|poor|low|bad|no tests|lack/i);
    }
  });

  it('is empty when every source was captured', () => {
    expect(sourceGapUnknowns([{ sourceType: 'github', status: 'captured' }])).toEqual([]);
  });
});
