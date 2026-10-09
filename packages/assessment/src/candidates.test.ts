import { describe, expect, it } from 'vitest';
import {
  preGate,
  withoutCandidates,
  CANDIDATES_PER_UNIT,
  EVENT_REFERENCES_PER_UNIT,
  type UnitCandidates,
} from './candidates.js';
import { build } from './testing/scoring.js';
import { lockedSnapshot } from './testing/world.js';

describe('candidate sets (design §5.3)', () => {
  const built = build();

  it('gives each unit a closed set with per-unit handles E-001... in a fixed order', () => {
    expect(built.units.map((u) => u.dimensionId)).toEqual([
      'official.problem_fit',
      'official.usability',
    ]);
    for (const unit of built.units) {
      expect(unit.items.map((i) => i.handle)).toEqual(
        unit.items.map((_, i) => `E-${String(i + 1).padStart(3, '0')}`),
      );
      expect([...unit.byHandle.keys()]).toEqual(unit.items.map((i) => i.handle));
    }
  });

  it('shows only usable kinds, with Option B labels and derived authorship and channel', () => {
    const [unit] = built.units;
    expect(unit?.items.length).toBe(built.planned.evidence.length);
    for (const item of unit?.items ?? []) {
      expect(['team_claim', 'unverified']).toContain(item.label);
      expect(['team_statement', 'interpreted_fact']).toContain(item.authorship);
      expect(item.projectDerived).toBe(true);
    }
    const statement = unit?.items.find((i) => i.authorship === 'team_statement');
    expect(statement?.channel).toBe('submission');
    expect(statement?.label).toBe('team_claim');
    const fact = unit?.items.find((i) => i.authorship === 'interpreted_fact');
    expect(fact?.channel).toBe('source_code');
    expect(fact?.label).toBe('unverified');
  });

  it('never exposes a persisted id as a handle, and keeps the id only in code', () => {
    for (const unit of built.units) {
      for (const item of unit.items) {
        expect(item.handle).toMatch(/^E-\d{3}$/);
        expect(item.handle).not.toContain(item.evidenceId);
      }
    }
  });

  it('is deterministic: the same inputs give identical sets', () => {
    const again = build();
    expect(again.units.map((u) => u.items.map((i) => [i.handle, i.text, i.channel]))).toEqual(
      built.units.map((u) => u.items.map((i) => [i.handle, i.text, i.channel])),
    );
  });

  it('adds Event-Context reference items after the project evidence, as event_reference, unverified', () => {
    const locked = lockedSnapshot({
      trackKeys: ['health'],
      rules: [{ statement: 'Projects must be original work.', certainty: 'explicit' }],
    });
    const withRefs = build({ locked, declaredTrackKeys: ['health'] });
    const [unit] = withRefs.units;
    const refs = unit?.items.filter((i) => !i.projectDerived) ?? [];
    expect(refs.length).toBe(2); // the declared track + the explicit rule
    expect(
      refs.every(
        (r) =>
          r.authorship === 'event_reference' &&
          r.label === 'unverified' &&
          r.channel === 'event_context',
      ),
    ).toBe(true);
    const lastProject = unit?.items.map((i) => i.projectDerived).lastIndexOf(true) ?? -1;
    const firstRef = unit?.items.findIndex((i) => !i.projectDerived) ?? -1;
    expect(firstRef).toBeGreaterThan(lastProject);
  });

  it('excludes interpreted and unclear rules, undeclared tracks and over-long statements (listed, not used)', () => {
    const locked = lockedSnapshot({
      trackKeys: ['health', 'robotics'],
      rules: [
        { statement: 'Explicit rule one.', certainty: 'explicit' },
        { statement: 'An interpreted rule.', certainty: 'interpreted' },
        { statement: 'An unclear rule.', certainty: 'unclear' },
      ],
      requirements: [
        {
          statement: 'Track requirement for robotics.',
          certainty: 'explicit',
          trackKey: 'robotics',
        },
        { statement: 'Overall requirement.', certainty: 'explicit', trackKey: null },
      ],
    });
    const withRefs = build({ locked, declaredTrackKeys: ['health'] });
    const texts =
      withRefs.units[0]?.items.filter((i) => !i.projectDerived).map((i) => i.text) ?? [];
    expect(texts.sort()).toEqual(
      [
        'Explicit rule one.',
        'Overall requirement.',
        'Track health: Projects in the health track must address health.',
      ].sort(),
    );
  });

  it('caps a unit at the limit and keeps at most eight reference slots', () => {
    expect(CANDIDATES_PER_UNIT).toBe(60);
    expect(EVENT_REFERENCES_PER_UNIT).toBe(8);
  });
});

describe('re-run candidate sets', () => {
  const built = build();
  const [unit] = built.units;
  if (!unit) throw new Error('fixture');

  it('removes the named handles, keeps the others under their original handles, and leaves the graph untouched', () => {
    const removed = unit.items[0]?.handle ?? '';
    const next = withoutCandidates(unit, [removed]);
    expect(next.items.map((i) => i.handle)).toEqual(unit.items.slice(1).map((i) => i.handle));
    expect(next.byHandle.has(removed)).toBe(false);
    expect(next.items[0]?.handle).toBe(unit.items[1]?.handle);
    expect(built.graph.ordered.evidence).toHaveLength(unit.items.length);
    // the original set is not mutated
    expect(unit.byHandle.has(removed)).toBe(true);
  });

  it('a removed item can no longer be cited, and a unit left with nothing is pre-gated', () => {
    const everything = withoutCandidates(
      unit,
      unit.items.map((i) => i.handle),
    );
    expect(everything.items).toEqual([]);
    expect(preGate(everything)).toBe('no_candidate_evidence');
  });
});

describe('deterministic pre-gates', () => {
  const unit = (
    overrides: Partial<UnitCandidates> & { items?: UnitCandidates['items'] } = {},
  ): UnitCandidates => {
    const items = overrides.items ?? [];
    return {
      dimensionId: 'official.problem_fit',
      criterionKey: 'problem_fit',
      name: 'Problem fit',
      needGroups: null,
      items,
      byHandle: new Map(items.map((i) => [i.handle, i])),
      ...overrides,
    };
  };
  const item = (
    handle: string,
    channel: UnitCandidates['items'][number]['channel'],
    projectDerived = true,
  ) => ({
    handle,
    evidenceId: `00000000-0000-4000-8000-${handle.slice(2).padStart(12, '0')}`,
    channel,
    label: 'unverified' as const,
    authorship: projectDerived ? ('interpreted_fact' as const) : ('event_reference' as const),
    text: 'text',
    excerpt: null,
    projectDerived,
  });

  it('an empty candidate set is insufficient without a model call', () => {
    expect(preGate(unit())).toBe('no_candidate_evidence');
  });

  it('Event-Context reference items alone are not project evidence: still no candidate evidence', () => {
    expect(preGate(unit({ items: [item('E-001', 'event_context', false)] }))).toBe(
      'no_candidate_evidence',
    );
  });

  it('a unit with project evidence and no declared needs is assessable (official criteria declare none)', () => {
    expect(preGate(unit({ items: [item('E-001', 'submission')] }))).toBeNull();
  });

  it('a fallback unit with no satisfiable need group is insufficient', () => {
    const needsCode = unit({
      dimensionId: 'technical_execution.implementation_depth',
      needGroups: [['source_code']],
      items: [item('E-001', 'submission')],
    });
    expect(preGate(needsCode)).toBe('no_satisfiable_need');
    const satisfiable = unit({
      dimensionId: 'technical_execution.implementation_depth',
      needGroups: [['source_code']],
      items: [item('E-001', 'source_code')],
    });
    expect(preGate(satisfiable)).toBeNull();
  });

  it('a Track-alignment unit without an official requirement for a declared track is insufficient, even with team statements', () => {
    const track = unit({
      dimensionId: 'track_prize_alignment.track_fit',
      needGroups: [['submission']],
      items: [item('E-001', 'submission')],
    });
    expect(preGate(track)).toBe('no_official_requirement_available');
    const withRule = unit({
      dimensionId: 'track_prize_alignment.track_fit',
      needGroups: [['submission', 'event_context']],
      items: [item('E-001', 'submission'), item('E-002', 'event_context', false)],
    });
    expect(preGate(withRule)).toBeNull();
  });
});
