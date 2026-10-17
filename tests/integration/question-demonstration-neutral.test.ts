import { describe, expect, it } from 'vitest';
import { ScriptedProvider, type StructuredRequest } from '../../packages/llm/src/index.js';
import { world } from '../../packages/questions/src/testing/world.js';
import { requirement } from '../../packages/questions/src/testing/fixture.js';
import {
  questionDemonstrationStep,
  DEMONSTRATION_TEMPLATES_VERSION,
} from '../../apps/api/src/questions/demonstration.js';
import {
  generate,
  generationKeyOf,
  prepare,
  inputHashOf,
} from '../../apps/api/src/questions/generation.js';

/*
 * M6-R4: the scripted demonstrator never quotes an official criterion or track name. These tests run the REAL offline demonstrator through the real pipeline
 * (analyze -> closed set -> phrase -> validate -> rank -> select) on synthetic verified contexts and measure what the judge gets.
 */

const MODEL = 'claude-sonnet-5-5';
type W = ReturnType<typeof world>;

const withTrack = (name: string): W =>
  world({
    tracks: {
      declared: [{ key: 't', name }],
      unassessedTrackRubrics: [{ trackKey: 't', trackName: name, rubricName: `${name} criteria` }],
    },
    requirements: [requirement('r-t', { trackKey: 't', text: 'Must satisfy the track.' })],
  });
const withCriteria = (names: string[]): W => {
  const base = world();
  return world({
    dimensions: base.input.dimensions.map((d, i) => ({ ...d, name: names[i] ?? d.name })),
  });
};
const mixed = (track: string, criteria: string[]): W => {
  const base = withTrack(track);
  return world({
    tracks: base.input.tracks,
    requirements: base.input.requirements,
    dimensions: base.input.dimensions.map((d, i) => ({ ...d, name: criteria[i] ?? d.name })),
  });
};

interface Measured {
  readonly generated: {
    text: string;
    reason: string;
    opportunities: string[];
    references: string[];
    dimensions: string[];
  }[];
  readonly opportunities: number;
  readonly candidates: number;
  readonly rejected: number;
  readonly selected: number;
  readonly shortfall: string | null;
  readonly questions: {
    text: string;
    reason: string;
    opportunityKeys: string[];
    dimensions: { id: string; name: string }[];
    references: { type: string; id: string; label: string }[];
  }[];
  readonly rejections: { code: string; count: number }[];
  readonly trails: Map<string, { type: string; id: string }[]>;
  readonly dimensionIds: Map<string, string[]>;
}

async function measure(w: W): Promise<Measured> {
  const prepared = prepare(w.input, {
    provider: { id: 'scripted', mode: 'scripted' },
    model: MODEL,
    secrets: [],
    demonstration: DEMONSTRATION_TEMPLATES_VERSION,
  });
  const request = prepared.request as StructuredRequest;
  const step = questionDemonstrationStep(request);
  const generated = step.ok ? (step.json as { candidates: Measured['generated'] }).candidates : [];
  const out = await generate(
    w.input,
    prepared,
    {
      provider: new ScriptedProvider([questionDemonstrationStep], { repeatLast: true }),
      model: MODEL,
      secrets: [],
      providerMode: 'scripted',
      providerId: 'scripted',
    },
    null,
    new AbortController().signal,
  );
  const p = out.persist as unknown as Omit<
    Measured,
    'generated' | 'opportunities' | 'candidates' | 'rejected' | 'selected' | 'shortfall'
  > & {
    counts: Record<string, number>;
    shortfall: { code: string } | null;
    opportunities: { key: string; trail: { type: string; id: string }[]; dimensionIds: string[] }[];
  };
  return {
    generated,
    opportunities: p.opportunities.length,
    candidates: p.counts['candidates'] ?? 0,
    rejected: p.counts['rejected'] ?? 0,
    selected: p.questions.length,
    shortfall: p.shortfall?.code ?? null,
    questions: p.questions,
    rejections: p.rejections,
    trails: new Map(p.opportunities.map((o) => [o.key, o.trail])),
    dimensionIds: new Map(p.opportunities.map((o) => [o.key, o.dimensionIds])),
  };
}

const officialNames = (w: W): string[] => [
  ...w.input.dimensions.map((d) => d.name),
  ...w.input.tracks.declared.map((t) => t.name),
  ...w.input.tracks.unassessedTrackRubrics.flatMap((r) => [r.trackName, r.rubricName]),
];

const NAMES = [
  'Fraud Prevention',
  'Payment Fraud',
  'Exam Cheating',
  'Fake News',
  'Fraud Cases',
  'Plagiarism Detection',
  'Fraud & Cheating Detection',
];
const SCENARIOS: [string, () => W][] = [
  ['ordinary names (control)', () => world()],
  ['ordinary track “Community Health”', () => withTrack('Community Health')],
  ...NAMES.flatMap((n): [string, () => W][] => [
    [`track “${n}”`, () => withTrack(n)],
    [`one criterion “${n}”`, () => withCriteria([n])],
  ]),
  [
    'all four criteria misconduct-named',
    () => withCriteria(['Payment Fraud', 'Exam Cheating', 'Fake News', 'Fraud Cases']),
  ],
  [
    'all four criteria topic-named',
    () =>
      withCriteria([
        'Fraud Prevention',
        'Plagiarism Detection',
        'Fake News Detection',
        'Fraud & Cheating Detection',
      ]),
  ],
  [
    'mixed: track “Payment Fraud” + criteria “Fake News”, “Exam Cheating”',
    () => mixed('Payment Fraud', ['Fake News', 'Exam Cheating']),
  ],
  [
    'mixed: ordinary track + misconduct criteria',
    () => mixed('Community Health', ['Fraud Cases', 'Payment Fraud', 'Exam Cheating', 'Fake News']),
  ],
];

describe('the offline demonstrator on verified contexts with sensitive and ordinary official names', () => {
  it.each(SCENARIOS)(
    '%s: nothing is refused, the same number of questions as the control, no official name in any wording, sources intact',
    async (_name, build) => {
      const w = build();
      const control = await measure(world());
      const m = await measure(w);
      // 1. no official name is quoted in ANY candidate (not only the selected ones), in the question or the reason
      const names = officialNames(w).map((n) => n.toLowerCase());
      for (const c of m.generated) {
        for (const n of names) {
          expect(c.text.toLowerCase(), c.text).not.toContain(n);
          expect(c.reason.toLowerCase(), c.reason).not.toContain(n);
        }
      }
      // 2. neutral wording does not make the validator refuse or merge anything: every generated candidate is valid and distinct
      expect(m.rejected).toBe(0);
      const bearing = m.generated.filter((c) => /open uncertainty/.test(c.text));
      expect(new Set(bearing.map((c) => c.text)).size).toBe(bearing.length);
      // 3. the five-question workflow is intact and never padded
      expect(m.selected).toBe(Math.min(5, m.candidates));
      expect(m.selected).toBeGreaterThanOrEqual(Math.min(control.selected, m.candidates));
      expect(m.selected).toBeLessThanOrEqual(m.candidates - m.rejected);
      // 4. every selected question keeps its source identities
      for (const q of m.questions) {
        expect(q.opportunityKeys.length).toBeGreaterThan(0);
        expect(q.text).not.toMatch(/undefined|\[object|\{\{/);
        expect(q.reason.length).toBeGreaterThan(20);
      }
      // 5. the criterion a question is about is identified by metadata, never by the wording: its real name is listed beside the question
      const criterionNames = new Set(w.input.dimensions.map((d) => d.name));
      for (const q of m.questions) {
        for (const d of q.dimensions) expect(criterionNames.has(d.name)).toBe(true);
        const cited = new Set(q.opportunityKeys.flatMap((k) => m.dimensionIds.get(k) ?? []));
        if (cited.size > 0) expect(q.dimensions.length).toBeGreaterThan(0);
      }
    },
  );

  it('a question that addresses an uncertainty bound to a track is linked to that track, whatever else it cites; the track name is only metadata', async () => {
    for (const name of ['Payment Fraud', 'Community Health']) {
      const w = withTrack(name);
      const m = await measure(w);
      const bound = m.questions.filter((q) =>
        q.opportunityKeys.some((k) => (m.trails.get(k) ?? []).some((t) => t.type === 'track')),
      );
      expect(bound.length).toBeGreaterThan(0);
      for (const q of bound) {
        expect(q.references.filter((r) => r.type === 'track').map((r) => [r.id, r.label])).toEqual([
          ['t', name],
        ]);
        expect(q.text).toMatch(/event track cited with the \w+ open uncertainty/);
        expect(q.text.toLowerCase()).not.toContain(name.toLowerCase());
      }
    }
  });

  it('the wording is varied by question type, not one generic sentence', async () => {
    const m = await measure(world());
    const openings = new Set(m.questions.map((q) => q.text.split(' ').slice(0, 6).join(' ')));
    expect(openings.size).toBeGreaterThanOrEqual(3);
    expect(new Set(m.questions.map((q) => q.text)).size).toBe(m.questions.length);
  });

  it('two uncertainties of the same kind on different criteria stay two candidates with different wording and their own criterion', async () => {
    const m = await measure(world());
    const claim = m.generated.filter((c) => /statements in your materials/.test(c.text));
    expect(claim.length).toBeGreaterThanOrEqual(2);
    expect(new Set(claim.map((c) => c.text)).size).toBe(claim.length);
    expect(new Set(claim.map((c) => c.dimensions.join(','))).size).toBe(claim.length);
  });

  it('the ordinal in the wording is the code-assigned position of the uncertainty it cites', () => {
    const w = world();
    const prepared = prepare(w.input, {
      provider: { id: 'scripted', mode: 'scripted' },
      model: MODEL,
      secrets: [],
      demonstration: DEMONSTRATION_TEMPLATES_VERSION,
    });
    const step = questionDemonstrationStep(prepared.request as StructuredRequest);
    const words = [
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
      'seventh',
      'eighth',
      'ninth',
      'tenth',
    ];
    for (const c of step.ok
      ? (step.json as { candidates: { text: string; opportunities: string[] }[] }).candidates
      : []) {
      const n = Number(/^O-0*(\d+)$/.exec(c.opportunities[0] ?? '')?.[1]);
      const m = /the (\w+) open uncertainty/.exec(c.text);
      if (m) expect(m[1]).toBe(words[n - 1]);
    }
  });
});

describe('generation identity', () => {
  it('a scripted generation under new templates is a NEW identity; replay and live identities are unchanged', () => {
    const w = world();
    const parts = {
      input: w.input,
      inputHash: inputHashOf(w.input),
      provider: { id: 'scripted', mode: 'scripted' },
      model: MODEL,
    };
    const old = generationKeyOf(parts);
    const next = generationKeyOf({ ...parts, demonstration: DEMONSTRATION_TEMPLATES_VERSION });
    expect(next).not.toBe(old);
    expect(generationKeyOf({ ...parts, demonstration: undefined })).toBe(old);
    expect(generationKeyOf({ ...parts, provider: { id: 'replay', mode: 'replay' } })).toBe(
      generationKeyOf({
        ...parts,
        provider: { id: 'replay', mode: 'replay' },
        demonstration: undefined,
      }),
    );
    expect(generationKeyOf({ ...parts, demonstration: 'question-demonstration/v3' })).not.toBe(
      next,
    );
  });
});
