import { describe, expect, it } from 'vitest';
import { buildEventReferenceItems } from './event-evidence.js';
import { lockedSnapshot } from './testing/world.js';

describe('Event-Context reference evidence (design §4.7)', () => {
  const locked = lockedSnapshot({
    trackKeys: ['health', 'robotics'],
    rules: [
      { statement: 'Projects must be original work.', certainty: 'explicit' },
      { statement: 'Judging probably favours working demos.', certainty: 'interpreted' },
      { statement: 'It is unclear whether teams may exceed four people.', certainty: 'unclear' },
    ],
    requirements: [
      {
        statement: 'Health projects must describe their data sources.',
        certainty: 'explicit',
        trackKey: 'health',
      },
      {
        statement: 'Robotics projects must include a hardware list.',
        certainty: 'explicit',
        trackKey: 'robotics',
      },
      { statement: 'Every submission needs a demo link.', certainty: 'explicit', trackKey: null },
    ],
  });

  it('includes declared track definitions and explicit rules and requirements for the overall submission or a declared track', () => {
    const result = buildEventReferenceItems(locked, ['health']);
    expect(result.contextVersionId).toBe(locked.versionId);
    expect(result.items.map((i) => [i.kind, i.trackKey, i.text])).toEqual([
      [
        'track_definition',
        'health',
        'Track health: Projects in the health track must address health.',
      ],
      ['rule', null, 'Projects must be original work.'],
      ['submission_requirement', 'health', 'Health projects must describe their data sources.'],
      ['submission_requirement', null, 'Every submission needs a demo link.'],
    ]);
  });

  it('excludes interpreted and unclear statements and undeclared tracks, and counts them', () => {
    const result = buildEventReferenceItems(locked, ['health']);
    const codes = result.exclusions.map((e) => `${e.kind}:${e.code}`).sort();
    expect(codes).toEqual([
      'rule:not_explicit',
      'rule:not_explicit',
      'submission_requirement:not_applicable_track',
      'track_definition:not_applicable_track',
    ]);
  });

  it('yields nothing for a project with no declared track and no explicit rule', () => {
    const none = lockedSnapshot({ rules: [{ statement: 'Maybe.', certainty: 'unclear' }] });
    expect(buildEventReferenceItems(none, []).items).toEqual([]);
  });

  it('uses stable, unique refs', () => {
    const refs = buildEventReferenceItems(locked, ['health', 'robotics']).items.map((i) => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.every((r) => /^[a-z][a-z0-9_-]*$/.test(r))).toBe(true);
  });

  it('skips an over-long statement instead of truncating it', () => {
    const long = lockedSnapshot({
      rules: [{ statement: 'x '.repeat(1500).trim(), certainty: 'explicit' }],
    });
    const result = buildEventReferenceItems(long, []);
    expect(result.items).toEqual([]);
    expect(result.exclusions).toEqual([{ kind: 'rule', code: 'too_long' }]);
  });

  describe('M6 phase 0 (R8B P3-1): "explicit" is only trusted together with an official source', () => {
    const withSources = (
      sourceIds: string[],
      authority: 'official_event_rules' | 'organizer_guidance' | 'judge_context',
    ) => {
      const base = lockedSnapshot({
        rules: [{ statement: 'Projects must be original work.', certainty: 'explicit' }],
        requirements: [
          {
            statement: 'Every submission needs a demo link.',
            certainty: 'explicit',
            trackKey: null,
          },
        ],
      });
      const sourceId = base.sources[0]?.id ?? '';
      return {
        ...base,
        sources: base.sources.map((source) => ({ ...source, authority })),
        document: {
          ...base.document,
          rules: base.document.rules.map((rule) => ({
            ...rule,
            sourceIds: sourceIds.length ? [sourceId] : [],
          })),
          submissionRequirements: base.document.submissionRequirements.map((requirement) => ({
            ...requirement,
            sourceIds: sourceIds.length ? [sourceId] : [],
          })),
        },
      };
    };

    it('an official source makes an explicit rule and requirement reference evidence', () => {
      const result = buildEventReferenceItems(withSources(['x'], 'official_event_rules'), []);
      expect(result.items.map((i) => i.kind)).toEqual(['rule', 'submission_requirement']);
    });

    it('an explicit statement citing NO source is excluded, and counted as not official (never silently dropped)', () => {
      const result = buildEventReferenceItems(withSources([], 'official_event_rules'), []);
      expect(result.items).toEqual([]);
      expect(result.exclusions.map((e) => `${e.kind}:${e.code}`)).toEqual([
        'rule:not_official_source',
        'submission_requirement:not_official_source',
      ]);
    });

    it.each(['organizer_guidance', 'judge_context'] as const)(
      'an explicit statement citing only a lower-authority source (%s) is excluded',
      (authority) => {
        const result = buildEventReferenceItems(withSources(['x'], authority), []);
        expect(result.items).toEqual([]);
        expect(result.exclusions.every((e) => e.code === 'not_official_source')).toBe(true);
      },
    );

    it('a source id that is not among the frozen sources counts for nothing', () => {
      const base = withSources(['x'], 'official_event_rules');
      const result = buildEventReferenceItems({ ...base, sources: [] }, []);
      expect(result.items).toEqual([]);
    });
  });
});
