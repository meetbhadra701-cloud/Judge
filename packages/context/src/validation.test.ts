import { describe, expect, it } from 'vitest';
import { documentFromExtraction, RUBRIC_WEIGHT_SUM_TOLERANCE, validateForLock } from './index.js';
import { sampleExtraction, sampleSources } from './testing/sample.js';

function withWeights(weights: (number | null)[]) {
  const extraction = sampleExtraction();
  const [rubric] = extraction.rubrics;
  if (!rubric) throw new Error('fixture');
  const template = rubric.criteria[0];
  if (!template) throw new Error('fixture');
  rubric.criteria = weights.map((weight, i) => ({
    ...template,
    key: `criterion_${String(i)}`,
    weight,
  }));
  return documentFromExtraction(extraction, { sources: sampleSources() });
}

describe('validateForLock — rubric weights', () => {
  it('accepts weights that sum to 1 within the documented tolerance', () => {
    expect(validateForLock(withWeights([0.4, 0.3, 0.3]), sampleSources())).toEqual([]);
    expect(validateForLock(withWeights([0.1, 0.2, 0.7]), sampleSources())).toEqual([]);
    expect(
      validateForLock(withWeights([0.5, 0.5 + RUBRIC_WEIGHT_SUM_TOLERANCE / 2]), sampleSources()),
    ).toEqual([]);
  });

  it('rejects weights that do not sum to 1 and never normalizes them', () => {
    const document = withWeights([0.5, 0.3, 0.3]);
    const issues = validateForLock(document, sampleSources());
    expect(issues.map((issue) => issue.code)).toEqual(['INVALID_RUBRIC_WEIGHTS']);
    expect(document.rubrics[0]?.criteria.map((criterion) => criterion.weight)).toEqual([
      0.5, 0.3, 0.3,
    ]);
    expect(
      validateForLock(withWeights([0.5, 0.5 + RUBRIC_WEIGHT_SUM_TOLERANCE * 2]), sampleSources()),
    ).toHaveLength(1);
  });

  it('accepts a fully unweighted official rubric and does not invent weights', () => {
    const document = withWeights([null, null, null]);
    expect(validateForLock(document, sampleSources())).toEqual([]);
    expect(document.rubrics[0]?.criteria.every((criterion) => criterion.weight === null)).toBe(
      true,
    );
  });

  it('rejects partially weighted rubrics and out-of-range weights', () => {
    expect(validateForLock(withWeights([0.5, null]), sampleSources())[0]?.code).toBe(
      'INVALID_RUBRIC_WEIGHTS',
    );
    expect(() => withWeights([1.5, -0.5])).toThrow(/weight/);
  });

  it('requires content before locking', () => {
    expect(validateForLock(null, sampleSources())[0]?.code).toBe('CONTEXT_CONTENT_MISSING');
  });
});
