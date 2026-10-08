import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { scoreProject } from './engine.js';
import {
  baseWorld,
  cite,
  codeEvidence,
  lockedSnapshot,
  makeContext,
  payload,
  rubricDefinition,
  scored,
  uid,
} from './testing/builders.js';

/*
 * Review finding F6 (informational) - documented, intentional behavior: records that cite the SAME
 * passage form one provenance group, and a group is only as strong as its MOST CONSERVATIVE member.
 * So adding a weaker citation that overlaps a stronger one can LOWER the dimension's evidence
 * strength and confidence. This is the approved design (M4-design.md §5, SCORING.md §13): repeating or
 * re-describing the same passage must never raise strength, and a disagreement about how strong that
 * one passage is is resolved conservatively and shown as a diagnostic. It is not a defect and the
 * formula is unchanged (scoring-engine/v1).
 */

const STRONG = uid(1, 'e9100001');
const WEAK_OVERLAP = uid(2, 'e9100001');
const WEAK_ELSEWHERE = uid(3, 'e9100001');

function run(...citations: ReturnType<typeof cite>[]): ScoreReport {
  const g = baseWorld();
  codeEvidence(g, STRONG, { span: [0, 100] }); // repo_corroborated: 0.60
  codeEvidence(g, WEAK_OVERLAP, { span: [50, 150], label: 'unverified' }); // 0.15, overlaps STRONG
  codeEvidence(g, WEAK_ELSEWHERE, { span: [500, 600], label: 'unverified' }); // 0.15, disjoint
  const rubric = rubricDefinition({ criteria: [{ key: 'a', weight: 1 }] });
  const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
  const result = scoreProject(ctx, payload(scored('official.a', 7, ...citations)));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
}

const dim = (report: ScoreReport) => {
  const found = report.dimensions[0];
  if (found?.state !== 'assessed') throw new Error('expected an assessed dimension');
  return found;
};

describe('a weaker overlapping citation lowers a dimension (intentional, conservative)', () => {
  it('the strong passage alone gives strength and confidence 0.6', () => {
    const d = dim(run(cite(STRONG)));
    expect(d.evidenceStrength).toBe(0.6);
    expect(d.confidence).toBe(0.6);
  });

  it('adding a weaker record of an OVERLAPPING passage lowers both to 0.15, and says so', () => {
    const report = run(cite(STRONG), cite(WEAK_OVERLAP));
    const d = dim(report);
    expect(d.evidenceStrength).toBe(0.15);
    expect(d.confidence).toBe(0.15);
    expect(d.provenanceGroupCount).toBe(1);
    const codes = report.diagnostics.map((entry) => entry.code);
    expect(codes).toContain('DUPLICATE_PROVENANCE_GROUPED');
    expect(codes).toContain('INCONSISTENT_CLASSIFICATION_RESOLVED');
    // The judged score is untouched: only the evidence quality indices move.
    expect(d.scoreOnScale).toBe(7);
    expect(report.overall).toMatchObject({ score10: 7 });
  });

  it('a weaker record of a DIFFERENT passage does not lower it (the strongest group wins)', () => {
    const d = dim(run(cite(STRONG), cite(WEAK_ELSEWHERE)));
    expect(d.evidenceStrength).toBe(0.6);
    expect(d.provenanceGroupCount).toBe(2);
  });

  it('the same effect arises from classifying the overlapping record as indirect and generic', () => {
    const d = dim(run(cite(STRONG), cite(WEAK_OVERLAP, 'indirect', 'generic')));
    expect(d.evidenceStrength).toBe(0.0135); // 0.15 x 0.3 x 0.3
  });

  it('is independent of the order of the citations', () => {
    const a = run(cite(STRONG), cite(WEAK_OVERLAP));
    const b = run(cite(WEAK_OVERLAP), cite(STRONG));
    expect(a.outputHash).toBe(b.outputHash);
  });
});
