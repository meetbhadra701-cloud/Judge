import { describe, expect, it } from 'vitest';
import {
  buildCandidateSets,
  preGate,
  requiredReferenceKinds,
  TRACK_ELIGIBILITY_DIMENSION,
  type UnitCandidates,
} from './candidates.js';
import type { EventReferenceMeta } from './event-evidence.js';
import { applyPostGates, type FinalUnit } from './judgment.js';
import { validateDimensionAssessment } from './testing/calls.js';
import { build, type Built } from './testing/scoring.js';
import { lockedSnapshot } from './testing/world.js';

/*
 * F2 (P3 review): a Track / Prize Alignment judgment must cite BOTH relevant project-derived evidence AND applicable official context.
 * Applicability is decided from code-authored metadata and the DECLARED tracks, never from a model's say-so. The eligibility /
 * required-technology unit is about a REQUIREMENT: a track's theme description cannot substitute for one.
 */

const SCALE = { min: 0, max: 10 };
const CENTRALITY = 'track_prize_alignment.centrality';

const FULL = lockedSnapshot({
  noRubric: true,
  trackKeys: ['health', 'robotics'],
  rules: [
    {
      statement: 'Every project must be original work created during the event.',
      certainty: 'explicit',
    },
    { statement: 'Judging may favour working demos.', certainty: 'interpreted' },
  ],
  requirements: [
    {
      statement: 'Health projects must describe where their health data comes from.',
      certainty: 'explicit',
      trackKey: 'health',
    },
    {
      statement: 'Robotics projects must include a hardware list.',
      certainty: 'explicit',
      trackKey: 'robotics',
    },
  ],
});

const unitOf = (built: Built, id: string): UnitCandidates => {
  const unit = built.units.find((u) => u.dimensionId === id);
  if (!unit) throw new Error(`no unit ${id}`);
  return unit;
};
const handleWhere = (
  unit: UnitCandidates,
  test: (item: UnitCandidates['items'][number]) => boolean,
): string => {
  const found = unit.items.find(test);
  if (!found) throw new Error('no such candidate');
  return found.handle;
};
const projectCode = (u: UnitCandidates) =>
  handleWhere(u, (i) => i.projectDerived && i.channel === 'source_code');
const projectStatement = (u: UnitCandidates) =>
  handleWhere(u, (i) => i.projectDerived && i.authorship === 'team_statement');
const refWith = (u: UnitCandidates, applicability: string) =>
  handleWhere(u, (i) => i.reference?.applicability === applicability);

function finalOf(unit: UnitCandidates, cited: { handle: string; weak?: boolean }[]): FinalUnit {
  const json = {
    dimensionId: unit.dimensionId,
    outcome: { kind: 'scored', score: 7 },
    citations: cited.map(({ handle, weak }) => {
      const item = unit.byHandle.get(handle);
      const reference = item?.reference !== null && item?.reference !== undefined;
      return {
        evidence: handle,
        directness: reference || weak ? 'indirect' : 'direct',
        specificity: reference || weak ? 'generic' : 'exact',
        note: 'cited',
      };
    }),
    rationale: 'Supported by the cited records.',
    limitations: [],
  };
  const result = validateDimensionAssessment(json, unit, SCALE);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result)}`);
  return applyPostGates(result.judgment, unit);
}

describe('Track-alignment judgments need applicable official context (F2)', () => {
  const built = build({ locked: FULL, declaredTrackKeys: ['health'] });
  const centrality = unitOf(built, CENTRALITY);
  const eligibility = unitOf(built, TRACK_ELIGIBILITY_DIMENSION);

  it('classifies each reference item by code: declared track definition, track-specific requirement, overall rule', () => {
    const kinds = centrality.items
      .filter((i) => i.reference)
      .map((i) => [i.reference?.applicability, i.reference?.trackKey]);
    expect(kinds).toEqual([
      ['declared_track_definition', 'health'],
      ['track_specific_requirement', 'health'],
      ['overall_rule', null],
    ]);
    // explicit rules only: the interpreted rule and the undeclared track's items are not shown at all
    const texts = centrality.items.filter((i) => !i.projectDerived).map((i) => i.text);
    expect(texts.join('\n')).not.toMatch(/favour|Robotics|hardware/);
  });

  it('1. an applicable reference exists but is NOT cited: insufficient', () => {
    const final = finalOf(centrality, [
      { handle: projectCode(centrality) },
      { handle: projectStatement(centrality) },
    ]);
    expect(final.disposition).toBe('no_applicable_context_cited');
    expect(final.judgment?.outcome).toEqual({ kind: 'scored', score: 7 }); // the score is untouched; code only downgrades
  });

  it('2. only an event reference is cited: insufficient', () => {
    const final = finalOf(centrality, [
      { handle: refWith(centrality, 'declared_track_definition') },
    ]);
    expect(final.disposition).toBe('event_reference_only');
  });

  it('3. project evidence plus the applicable official reference is potentially assessable', () => {
    const final = finalOf(centrality, [
      { handle: projectCode(centrality) },
      { handle: refWith(centrality, 'declared_track_definition') },
    ]);
    expect(final.disposition).toBe('scored');
    const requirement = finalOf(centrality, [
      { handle: projectCode(centrality) },
      { handle: refWith(centrality, 'track_specific_requirement') },
    ]);
    expect(requirement.disposition).toBe('scored');
  });

  it("4. an UNRELATED track's reference is never applicable: it is not even shown, whatever its metadata says", () => {
    // the locked context has a robotics requirement, but robotics is not declared
    expect(centrality.items.some((i) => /hardware/.test(i.text))).toBe(false);
    // hostile metadata: a reference record claiming to concern an undeclared track, and one claiming an overall rule WITH a track
    const planned = built.planned.evidence.filter((e) => e.origin === 'event_context');
    const first = planned[0];
    const second = planned[1];
    if (!first || !second) throw new Error('fixture');
    const hostile = new Map<string, EventReferenceMeta>([
      [
        first.id,
        {
          builder: 'event-reference/v1',
          kind: 'submission_requirement',
          applicability: 'track_specific_requirement',
          trackKey: 'robotics',
        },
      ],
      [
        second.id,
        {
          builder: 'event-reference/v1',
          kind: 'rule',
          applicability: 'overall_rule',
          trackKey: 'robotics',
        },
      ],
    ]);
    const units = buildCandidateSets({
      graph: built.graph,
      known: knownOf(built),
      rubric: built.context.rubric,
      declaredTrackKeys: ['health'],
      eventReferences: hostile,
    });
    const unit = units.find((u) => u.dimensionId === CENTRALITY);
    expect(unit?.items.filter((i) => !i.projectDerived)).toEqual([]);
    expect(unit ? preGate(unit) : null).toBe('no_official_requirement_available');
  });

  it('4b. an event_context record with NO code-authored metadata is not shown and never counts', () => {
    const units = buildCandidateSets({
      graph: built.graph,
      known: knownOf(built),
      rubric: built.context.rubric,
      declaredTrackKeys: ['health'],
      eventReferences: new Map(),
    });
    const unit = units.find((u) => u.dimensionId === CENTRALITY);
    expect(unit?.items.some((i) => !i.projectDerived)).toBe(false);
    expect(unit ? preGate(unit) : null).toBe('no_official_requirement_available');
  });

  it('5. a general event rule that genuinely applies is accepted as context, and satisfies the eligibility unit as an explicit requirement', () => {
    const withContext = finalOf(centrality, [
      { handle: projectCode(centrality) },
      { handle: refWith(centrality, 'declared_track_definition') },
      { handle: refWith(centrality, 'overall_rule') },
    ]);
    expect(withContext.disposition).toBe('scored');
    const eligible = finalOf(eligibility, [
      { handle: projectStatement(eligibility) },
      { handle: refWith(eligibility, 'overall_rule') },
    ]);
    expect(eligible.disposition).toBe('scored');
    // ...but an overall rule alone does not say anything about THIS track: for the other Track units it is context, not applicability
    const ruleOnly = finalOf(centrality, [
      { handle: projectCode(centrality) },
      { handle: refWith(centrality, 'overall_rule') },
    ]);
    expect(ruleOnly.disposition).toBe('no_applicable_context_cited');
  });

  it('keeps the same rule for every Track unit and only those', () => {
    const track = built.units.filter((u) => u.dimensionId.startsWith('track_prize_alignment.'));
    expect(track.map((u) => u.dimensionId)).toEqual([
      'track_prize_alignment.official_eligibility_required_technology',
      'track_prize_alignment.actual_implementation_evidence',
      'track_prize_alignment.centrality',
      'track_prize_alignment.creativity_track_fit',
      'track_prize_alignment.demonstrated_use',
    ]);
    for (const unit of track) expect(requiredReferenceKinds(unit.dimensionId)).not.toBeNull();
    for (const unit of built.units.filter(
      (u) => !u.dimensionId.startsWith('track_prize_alignment.'),
    )) {
      expect(requiredReferenceKinds(unit.dimensionId)).toBeNull();
    }
  });

  it('all event citations remain indirect / generic (G6), so strength stays at the lowest level', () => {
    const ref = refWith(centrality, 'declared_track_definition');
    const bad = validateDimensionAssessment(
      {
        dimensionId: centrality.dimensionId,
        outcome: { kind: 'scored', score: 7 },
        citations: [
          { evidence: ref, directness: 'direct', specificity: 'exact', note: 'the track rule' },
        ],
        rationale: 'x',
        limitations: [],
      },
      centrality,
      SCALE,
    );
    expect('issues' in bad && bad.issues.map((i) => i.code)).toEqual([
      'event_reference_classification',
    ]);
  });
});

describe('a required eligibility rule that is ABSENT is not invented (F2.6)', () => {
  // the declared track has a theme description and NO explicit requirement, and there is no explicit overall rule
  const themeOnly = lockedSnapshot({
    noRubric: true,
    trackKeys: ['health'],
    rules: [{ statement: 'Maybe teams may reuse code.', certainty: 'unclear' }],
  });
  const built = build({ locked: themeOnly, declaredTrackKeys: ['health'] });
  const eligibility = unitOf(built, TRACK_ELIGIBILITY_DIMENSION);
  const centrality = unitOf(built, CENTRALITY);

  it('the eligibility unit is insufficient before any model call', () => {
    expect(
      eligibility.items.filter((i) => i.reference).map((i) => i.reference?.applicability),
    ).toEqual(['declared_track_definition']);
    expect(preGate(eligibility)).toBe('no_official_requirement_available');
  });

  it('even if a judgment cites the theme description as the "requirement", the post-gate refuses it', () => {
    const final = finalOf(eligibility, [
      { handle: projectStatement(eligibility) },
      { handle: refWith(eligibility, 'declared_track_definition') },
    ]);
    expect(final.disposition).toBe('no_applicable_context_cited');
  });

  it("the other Track units that only need the track's own context remain assessable", () => {
    expect(preGate(centrality)).toBeNull();
    const final = finalOf(centrality, [
      { handle: projectCode(centrality) },
      { handle: refWith(centrality, 'declared_track_definition') },
    ]);
    expect(final.disposition).toBe('scored');
  });
});

describe('no declared track: the existing not-applicable behavior is unchanged (F2.7)', () => {
  it('has no Track units and shows no track-specific reference, even when the locked context defines tracks and requirements', () => {
    const built = build({ locked: FULL, declaredTrackKeys: [] });
    expect(built.units.some((u) => u.dimensionId.startsWith('track_prize_alignment.'))).toBe(false);
    expect(built.units).toHaveLength(31);
    // the declared-track-only references are absent; the explicit overall rule may still be shown as context
    const texts =
      built.units[0]?.items
        .filter((i) => !i.projectDerived)
        .map((i) => i.reference?.applicability) ?? [];
    expect(texts).toEqual(['overall_rule']);
  });
});

function knownOf(built: Built) {
  // the same authoritative facts the build used: rebuild them from the graph's own provenance through the helper world
  return built.known;
}
