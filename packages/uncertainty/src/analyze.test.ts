import { describe, expect, it } from 'vitest';
import { analyzeUncertainty, THRESHOLDS } from './analyze.js';
import {
  claim,
  completeCoverage,
  contradiction,
  dimension,
  evidence,
  quietInput,
  requirement,
  unknown,
} from './testing/fixture.js';
import { UncertaintyInputError, type UncertaintyInput } from './types.js';

const kinds = (input: UncertaintyInput) =>
  analyzeUncertainty(input).opportunities.map((o) => o.kind);

describe('analyzeUncertainty: what it does not invent', () => {
  it('finds nothing in a fully evidenced, fully covered assessment', () => {
    const report = analyzeUncertainty(quietInput());
    expect(report.opportunities).toEqual([]);
    expect(report.weightBasis).toBe('official');
  });

  it('never reads a low score as an uncertainty (a weak project with strong evidence is not "uncertain")', () => {
    const input = quietInput();
    const weak = input.dimensions.map((d) => ({ ...d, evidenceStrength: 0.9, confidence: 0.9 }));
    expect(kinds({ ...input, dimensions: weak })).toEqual([]);
  });

  it('is byte-identical for identical input and independent of the order of the input lists', () => {
    const base = quietInput({
      claims: [claim('c1', { supportingEvidenceIds: ['ev-impact'] }), claim('c2')],
      unknowns: [unknown('u1', { evidenceIds: ['ev-originality'] })],
    });
    const a = analyzeUncertainty(base);
    const b = analyzeUncertainty(structuredClone(base));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const reordered = {
      ...base,
      claims: [...base.claims].reverse(),
      unknowns: [...base.unknowns].reverse(),
      dimensions: [...base.dimensions].reverse(),
    };
    expect(
      analyzeUncertainty(reordered)
        .opportunities.map((o) => o.id)
        .sort(),
    ).toEqual(a.opportunities.map((o) => o.id).sort());
  });

  it('rejects an inconsistent input instead of guessing', () => {
    const input = quietInput({ claims: [claim('c1', { supportingEvidenceIds: ['ev-missing'] })] });
    expect(() => analyzeUncertainty(input)).toThrow(UncertaintyInputError);
    expect(() => analyzeUncertainty(quietInput({ dimensions: [] }))).toThrow(UncertaintyInputError);
    expect(() =>
      analyzeUncertainty(
        quietInput({ requirements: [requirement('r1', { trackKey: 'undeclared' })] }),
      ),
    ).toThrow(/undeclared track/);
  });
});

describe('analyzeUncertainty: one rule at a time', () => {
  it('a dimension without a number is "not assessed", critical when it carries a dominant share, and says it is missing evidence', () => {
    const input = quietInput();
    const report = analyzeUncertainty({
      ...input,
      dimensions: input.dimensions.map((d) =>
        d.id === 'official.impact'
          ? {
              ...d,
              state: 'insufficient_evidence',
              insufficiencyReason: 'no_usable_citation',
              attribution: 'insufficient_by_code',
              citedEvidenceIds: [],
            }
          : d,
      ),
    });
    const [only] = report.opportunities;
    expect(report.opportunities).toHaveLength(1);
    expect(only?.kind).toBe('dimension_not_assessed');
    expect(only?.severity).toBe('critical'); // 25% share is the dominant threshold
    expect(only?.observation).toMatch(/missing evidence, not a low score/);
    expect(only?.relevanceMilli).toBe(250);
  });

  it('a dimension citing only team statements rests on claims; one that also cites repository evidence does not', () => {
    const input = quietInput();
    const restingOnClaims = analyzeUncertainty({
      ...input,
      evidence: [
        ...input.evidence.filter((e) => e.id !== 'ev-impact'),
        evidence('ev-impact', {
          kind: 'claim',
          origin: 'devpost',
          verificationLevel: 'team_claim',
        }),
      ],
    });
    expect(restingOnClaims.opportunities.map((o) => o.kind)).toEqual(['dimension_rests_on_claims']);
    expect(restingOnClaims.opportunities[0]?.dimensionIds).toEqual(['official.impact']);

    const mixed = analyzeUncertainty({
      ...input,
      dimensions: input.dimensions.map((d) =>
        d.id === 'official.impact'
          ? { ...d, citedEvidenceIds: ['ev-impact', 'ev-originality'] }
          : d,
      ),
      evidence: [
        ...input.evidence.filter((e) => e.id !== 'ev-impact'),
        evidence('ev-impact', {
          kind: 'claim',
          origin: 'devpost',
          verificationLevel: 'team_claim',
        }),
      ],
    });
    expect(mixed.opportunities).toEqual([]);
  });

  it('an uncorroborated claim that bears on a dimension is an opportunity; a corroborated or unlinked one is counted as suppressed', () => {
    const input = quietInput({
      claims: [
        claim('c-linked', { supportingEvidenceIds: ['ev-impact'] }),
        claim('c-corroborated', {
          verificationLevel: 'repo_corroborated',
          supportingEvidenceIds: ['ev-impact'],
        }),
        claim('c-unlinked'),
      ],
    });
    const report = analyzeUncertainty(input);
    expect(report.opportunities.map((o) => o.kind)).toEqual(['claim_unverified']);
    expect(report.opportunities[0]?.observation).toMatch(/claim by the team/);
    expect(report.suppressed).toEqual({ unlinkedClaims: 1, corroboratedClaims: 1 });
  });

  it('a recorded contradiction links the dimensions that cite either side and never accuses', () => {
    const input = quietInput({
      claims: [claim('c1', { supportingEvidenceIds: ['ev-technical_depth'] })],
      contradictions: [
        contradiction('k1', [
          { type: 'claim', id: 'c1' },
          { type: 'evidence', id: 'ev-originality' },
        ]),
      ],
    });
    const report = analyzeUncertainty(input);
    const k = report.opportunities.find((o) => o.kind === 'contradiction_recorded');
    expect(k?.dimensionIds).toEqual(['official.originality', 'official.technical_depth']);
    expect(k?.observation).toMatch(/not a conclusion/);
    expect(JSON.stringify(report)).not.toMatch(/\b(lied|fraud|cheat|fake|plagiar)/i);
  });

  it('unknowns map their type to a severity, and a subjective unknown with no dimension stays low', () => {
    const report = analyzeUncertainty(
      quietInput({
        unknowns: [
          unknown('u-elig', { unknownType: 'eligibility' }),
          unknown('u-subj', { unknownType: 'subjective' }),
        ],
      }),
    );
    const byId = new Map(
      report.opportunities.map((o) => [o.trail.find((t) => t.type === 'unknown')?.id, o]),
    );
    expect(byId.get('u-elig')?.severity).toBe('moderate');
    expect(byId.get('u-subj')?.severity).toBe('low');
  });

  it('a missing source is critical for GitHub and high for Devpost, and suppresses the implementation-coverage rule', () => {
    const report = analyzeUncertainty(
      quietInput({
        coverage: {
          ...completeCoverage,
          verdict: 'insufficient',
          missingSources: ['github', 'devpost'],
          implementation: null,
        },
      }),
    );
    expect(report.opportunities.map((o) => [o.kind, o.severity])).toEqual([
      ['source_missing', 'critical'],
      ['source_missing', 'high'],
    ]);
    expect(report.opportunities.every((o) => o.dimensionIds.length === 4)).toBe(true);
    expect(report.opportunities[0]?.observation).toMatch(/missing evidence, not a finding/);
  });

  it('unseen implementation files are a coverage opportunity, high below the inspected-share threshold', () => {
    const partial = (inspectedShare: number) =>
      analyzeUncertainty(
        quietInput({
          coverage: {
            ...completeCoverage,
            verdict: 'partial',
            implementation: {
              files: 100,
              filesShown: Math.round(inspectedShare * 100),
              filesUnseen: 100 - Math.round(inspectedShare * 100),
              inspectedShare,
              componentsTotal: 5,
              componentsWithShownFile: 2,
            },
            omittedComponents: ['payments', 'worker'],
          },
        }),
      ).opportunities[0];
    expect(partial(0.3)?.severity).toBe('high');
    expect(partial(0.8)?.severity).toBe('moderate');
    expect(partial(0.3)?.observation).toMatch(/unknown, not weak/);
    expect(THRESHOLDS.implementationHighConcern).toBe(0.5);
  });

  it('coverage that was never recorded is unknown, never "complete"', () => {
    const report = analyzeUncertainty(
      quietInput({
        coverage: {
          ...completeCoverage,
          status: 'not_recorded',
          verified: false,
          verdict: null,
          implementation: null,
        },
      }),
    );
    expect(report.opportunities.map((o) => o.kind)).toEqual(['coverage_partial']);
    expect(report.opportunities[0]?.observation).toMatch(/unknown \(not “complete”\)/);
  });

  it('track requirements and track rubrics become opportunities attributed to their track; event-wide rules are one low-severity opportunity', () => {
    const report = analyzeUncertainty(
      quietInput({
        tracks: {
          declared: [{ key: 'sponsor-a', name: 'Sponsor A Prize' }],
          unassessedTrackRubrics: [
            {
              trackKey: 'sponsor-a',
              trackName: 'Sponsor A Prize',
              rubricName: 'Sponsor A criteria',
            },
          ],
        },
        requirements: [
          requirement('r-track', { trackKey: 'sponsor-a', text: 'Must use the Sponsor A API.' }),
          requirement('r-all-1', { text: 'Teams have at most five members.' }),
          requirement('r-all-2', { text: 'Projects are new work.' }),
        ],
      }),
    );
    const byKind = Object.fromEntries(report.opportunities.map((o) => [o.kind, o]));
    expect(report.opportunities).toHaveLength(3);
    expect(byKind['requirement_unaddressed']).toBeDefined();
    expect(byKind['track_rubric_not_assessed']?.severity).toBe('high');
    expect(
      report.opportunities
        .filter((o) => o.kind === 'requirement_unaddressed')
        .map((o) => o.severity),
    ).toEqual(expect.arrayContaining(['high', 'low']));
    expect(
      report.opportunities
        .flatMap((o) => o.trail)
        .filter((t) => t.type === 'track')
        .map((t) => t.id),
    ).toContain('sponsor-a');
  });

  it('a dimension that cites only event requirements has examined nothing about the project, and is not mistaken for team claims', () => {
    const input = quietInput();
    const report = analyzeUncertainty({
      ...input,
      evidence: [
        ...input.evidence.filter((e) => e.id !== 'ev-impact'),
        evidence('ev-impact', { origin: 'event_context', verificationLevel: 'unverified' }),
      ],
    });
    expect(report.opportunities.map((o) => o.kind)).toEqual(['thin_evidence']);
    expect(report.opportunities[0]?.observation).toMatch(/only what the event requires/);
  });

  it('thin evidence is flagged from the assessment’s own indices and is reported in either direction', () => {
    const input = quietInput();
    const report = analyzeUncertainty({
      ...input,
      dimensions: input.dimensions.map((d) =>
        d.id === 'official.technical_depth' ? { ...d, evidenceStrength: 0.2, confidence: 0.2 } : d,
      ),
    });
    expect(report.opportunities.map((o) => o.kind)).toEqual(['thin_evidence']);
    expect(report.opportunities[0]?.severity).toBe('high');
    expect(report.opportunities[0]?.observation).toMatch(/either direction/);
  });
});

describe('analyzeUncertainty: weights only order, they never become scores', () => {
  it('an unweighted rubric uses an equal share for ordering only and says so', () => {
    const input = quietInput({ rubric: { name: 'x', weightBasis: 'unweighted_official' } });
    const report = analyzeUncertainty({
      ...input,
      dimensions: input.dimensions.map((d) => ({ ...d, criterionWeight: null })),
    });
    expect(report.weightBasis).toBe('equal_for_ranking_only');
    expect(report.dimensions.every((d) => d.weightShareMilli === 250)).toBe(true);
  });

  it('opportunities are ordered by severity, then rubric share, then kind, then id', () => {
    const input = quietInput({
      dimensions: [
        dimension('official.big', { criterionWeight: 0.7, citedEvidenceIds: ['e1'] }),
        dimension('official.small', { criterionWeight: 0.05, citedEvidenceIds: ['e2'] }),
        dimension('official.mid', { criterionWeight: 0.25, citedEvidenceIds: ['e3'] }),
      ],
      evidence: [evidence('e1'), evidence('e2'), evidence('e3')],
      claims: [
        claim('c-small', { supportingEvidenceIds: ['e2'] }),
        claim('c-big', { supportingEvidenceIds: ['e1'] }),
      ],
    });
    const report = analyzeUncertainty(input);
    expect(report.opportunities.map((o) => o.trail[0]?.id)).toEqual(['c-big', 'c-small']);
    expect(report.opportunities.map((o) => o.ordinal)).toEqual([1, 2]);
    expect(report.opportunities.map((o) => o.severity)).toEqual(['high', 'moderate']);
  });
});

describe('analyzeUncertainty: the judging-quality cases', () => {
  const readmeClaimsWithIncompleteCode = (): UncertaintyInput => {
    const base = quietInput();
    return {
      ...base,
      dimensions: base.dimensions.map((d) =>
        d.id === 'official.technical_depth'
          ? { ...d, citedEvidenceIds: ['ev-readme'] }
          : d.id === 'official.impact'
            ? { ...d, citedEvidenceIds: ['ev-repo-tests'] }
            : d,
      ),
      evidence: [
        ...base.evidence,
        evidence('ev-readme', {
          kind: 'claim',
          origin: 'github',
          verificationLevel: 'team_claim',
          text: 'README: a real-time pipeline with fraud detection, caching, and auto-scaling.',
        }),
        evidence('ev-repo-tests', { text: 'The repository has a test directory.' }),
      ],
      claims: [
        claim('c-pipeline', {
          text: 'A real-time pipeline with caching and auto-scaling.',
          supportingEvidenceIds: ['ev-readme'],
        }),
      ],
      coverage: {
        ...completeCoverage,
        verdict: 'partial',
        implementation: {
          files: 60,
          filesShown: 12,
          filesUnseen: 48,
          inspectedShare: 0.2,
          componentsTotal: 6,
          componentsWithShownFile: 1,
        },
        omittedComponents: ['pipeline', 'autoscaler'],
      },
    };
  };

  it('polished README claims with incomplete implementation coverage are unverified claims and a coverage gap, never verified', () => {
    const report = analyzeUncertainty(readmeClaimsWithIncompleteCode());
    const kindsFound = report.opportunities.map((o) => o.kind);
    expect(kindsFound).toContain('claim_unverified');
    expect(kindsFound).toContain('coverage_partial');
    expect(kindsFound).toContain('dimension_rests_on_claims');
    const rests = report.opportunities.find((o) => o.kind === 'dimension_rests_on_claims');
    expect(rests?.dimensionIds).toEqual(['official.technical_depth']);
    expect(rests?.clarifiedBy).toContain('live_demonstration');
    const coverage = report.opportunities.find((o) => o.kind === 'coverage_partial');
    expect(coverage?.severity).toBe('high');
    expect(coverage?.clarifiedBy).toEqual(['code_walkthrough', 'live_demonstration']);
  });

  it('a strong implementation with limited documentation produces no opportunity about documentation or presentation', () => {
    const base = quietInput();
    const report = analyzeUncertainty({
      ...base,
      dimensions: base.dimensions.map((d) =>
        d.id === 'official.presentation'
          ? { ...d, evidenceStrength: 0.5, confidence: 0.5, citedEvidenceIds: ['ev-presentation'] }
          : d,
      ),
      evidence: base.evidence.map((e) =>
        e.id === 'ev-presentation' ? { ...e, text: 'A terse README with a single paragraph.' } : e,
      ),
    });
    expect(report.opportunities).toEqual([]);
  });

  it('opportunities carry only stored ids that exist in the input', () => {
    const input = readmeClaimsWithIncompleteCode();
    const report = analyzeUncertainty(input);
    const known = new Set<string>([
      ...input.dimensions.map((d) => d.id),
      ...input.evidence.map((e) => e.id),
      ...input.claims.map((c) => c.id),
      'implementation_coverage',
    ]);
    for (const o of report.opportunities) {
      for (const entry of o.trail) expect(known.has(entry.id)).toBe(true);
      expect(o.id).toMatch(/^opp-[0-9a-f]{16}$/);
    }
  });
});
