import type {
  QuestionSetListResponse,
  QuestionSetView,
  QuestionShortfall,
} from '@judge-copilot/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { questionsPanelState, type QuestionsPanelState } from '../../../../lib/questions-view';
import { QuestionsSection } from './questions';

/*
 * M6: the Five Questions section, rendered from plain data (static markup of the real component, no network, no browser). It must show exactly what the
 * stored set holds, label an offline demonstration as such, say why a list is short, offer no answer field, and render project text as text.
 */

const HOSTILE = '<script>alert(1)</script> "><img src=x onerror=alert(1)>';

function question(rank: number, over: Partial<QuestionSetView['questions'][number]> = {}) {
  return {
    id: `q${String(rank)}`,
    rank,
    mode: 'demonstrate' as const,
    text: `Could you show example number ${String(rank)} working on the project itself?`,
    reason: `Reason ${String(rank)}: nothing examined confirms it yet.`,
    expectedInformation: ['live_demonstration' as const],
    dimensions: [{ id: 'official.impact', name: 'Impact', weightShare: 0.4 }],
    opportunityIds: [`opp-000000000000000${String(rank)}`],
    references: [
      {
        type: 'claim' as const,
        id: `c${String(rank)}`,
        label: `Claim ${String(rank)}`,
        verificationLevel: 'team_claim',
      },
    ],
    rankingValueBp: 2000 - rank * 100,
    ...over,
  };
}

function opportunity(rank: number) {
  return {
    id: `opp-000000000000000${String(rank)}`,
    ordinal: rank,
    kind: 'claim_unverified' as const,
    severity: 'high' as const,
    dimensionIds: ['official.impact'],
    observation: `Observation ${String(rank)}: the team's materials state something nothing confirms yet.`,
    references: [],
  };
}

function set(count: number, over: Partial<QuestionSetView> = {}): QuestionSetView {
  const ranks = Array.from({ length: count }, (_v, i) => i + 1);
  return {
    id: 's1',
    projectId: 'p1',
    assessmentId: 'a1',
    assessmentVersionNumber: 2,
    contextVersionId: 'v1',
    createdAt: '2026-10-16T00:00:00.000Z',
    policyVersion: 'question-engine/v2',
    inputHash: 'a'.repeat(64),
    generation: {
      providerMode: 'scripted',
      providerId: 'scripted',
      demonstration: true,
      promptId: 'question-candidates',
      promptVersion: 'v1',
      promptTemplateHash: 'b'.repeat(64),
      models: null,
    },
    assessmentVerified: true,
    questions: ranks.map((r) => question(r)),
    shortfall:
      count === 5
        ? null
        : {
            code: 'fewer_defensible_candidates',
            explanation:
              'Only a few defensible questions could be generated; the list is not padded.',
            candidateCount: count,
            excluded: null,
            policyNote: null,
          },
    opportunities: Array.from({ length: Math.max(count, 3) }, (_v, i) => opportunity(i + 1)),
    counts: { opportunities: Math.max(count, 3), candidates: count, rejected: 1, selected: count },
    rejections: [{ code: 'accusatory_wording', count: 1 }],
    notices: {
      advisory:
        'Offline demonstration, not AI-generated: these questions were produced by fixed rules.',
      ranking: 'deterministic_ordering_not_a_probability',
      scores: 'questions_never_change_scores',
    },
    ...over,
  };
}

const LAUNCH: QuestionSetListResponse['launch'] = {
  available: true,
  providerMode: 'scripted',
  notice: 'OFFLINE DEMONSTRATION: fixed templates.',
};
const list = (sets: QuestionSetListResponse['sets'] = []): QuestionSetListResponse => ({
  projectId: 'p1',
  assessmentId: 'a1',
  sets,
  assessmentVerified: true,
  launch: LAUNCH,
});

function render(state: QuestionsPanelState): string {
  return renderToStaticMarkup(
    <QuestionsSection
      projectId="p1"
      assessmentId="a1"
      state={state}
      generateAction={() => undefined}
    />,
  );
}

describe('the Five Questions section', () => {
  it('shows five questions in rank order, each with its wording, reason, uncertainty, criterion, links and what would settle it', () => {
    const html = render({ kind: 'set', set: set(5) });
    expect(html).toContain('Five Questions');
    expect(html).toContain('Five questions, most valuable first.');
    for (let rank = 1; rank <= 5; rank += 1) {
      expect(html).toContain(`data-testid="question-${String(rank)}"`);
      expect(html).toContain(
        `Could you show example number ${String(rank)} working on the project itself?`,
      );
      expect(html).toContain(`Reason ${String(rank)}`);
      expect(html).toContain(`Observation ${String(rank)}`);
      expect(html).toContain(`Claim ${String(rank)}`);
    }
    expect(html.indexOf('data-testid="question-1"')).toBeLessThan(
      html.indexOf('data-testid="question-2"'),
    );
    expect(html).toContain('Impact (40% of the rubric)');
    expect(html).toContain('recorded as team claim');
    expect(html).toContain('a live demonstration');
    expect(html).not.toContain('data-testid="questions-shortfall"');
  });

  it('labels an offline demonstration as one, and never as AI-generated', () => {
    const html = render({ kind: 'set', set: set(5) });
    expect(html).toContain('data-testid="questions-demonstration-banner"');
    expect(html).toContain('NOT AI-GENERATED');
    expect(html).not.toContain('data-testid="questions-ai-notice"');
    const live = render({
      kind: 'set',
      set: set(5, {
        generation: {
          ...set(5).generation,
          providerMode: 'live',
          demonstration: false,
          models: { questions: 'm' },
        },
        notices: { ...set(5).notices, advisory: 'Suggested questions for the human judge.' },
      }),
    });
    expect(live).not.toContain('data-testid="questions-demonstration-banner"');
    expect(live).toContain('data-testid="questions-ai-notice"');
  });

  it('says why a list is short, and offers the open uncertainties as the manual path', () => {
    for (const count of [3, 1]) {
      const html = render({ kind: 'set', set: set(count) });
      expect(html).toContain('data-testid="questions-shortfall"');
      expect(html).toContain('Why fewer than five.');
      expect(html).toContain('not padded');
      expect(html).toContain('Nothing was added to fill the list.');
      expect(html).toContain('data-testid="questions-uncertainties"');
      expect(html).toContain('(fewer than five)');
    }
  });

  it('shows an honest empty state when nothing was selected, without inventing a question', () => {
    const none = set(0, {
      opportunities: [],
      counts: { opportunities: 0, candidates: 0, rejected: 0, selected: 0 },
      rejections: [],
      shortfall: {
        code: 'no_uncertainty',
        explanation: 'The analysis found nothing that could materially change what you understand.',
        candidateCount: 0,
        excluded: null,
        policyNote: null,
      },
    });
    const html = render({ kind: 'set', set: none });
    expect(html).toContain('No questions were selected.');
    expect(html).toContain('data-testid="questions-no-uncertainty"');
    expect(html).not.toContain('data-testid="question-1"');
  });

  it('offers no answer field, no score and no probability: its only form control is the generate button', () => {
    const generated = render({ kind: 'set', set: set(5) });
    expect(generated).not.toMatch(/<(input|textarea|select|form)\b/);
    expect(generated).not.toMatch(/probability of|\bscore[sd]?\b.{0,20}\d/i);
    expect(generated).toContain('not a probability');
    const ungenerated = render({
      kind: 'not_generated',
      canGenerate: true,
      notice: LAUNCH.notice,
    });
    expect(ungenerated.match(/<form\b/g)).toHaveLength(1);
    expect(ungenerated.match(/<input\b/g)).toHaveLength(2);
    expect(ungenerated).toContain('name="projectId"');
    expect(ungenerated).toContain('name="assessmentId"');
    expect(ungenerated).not.toMatch(/name="(question|rank|count|provider|model)/);
  });

  it('explains when questions cannot be generated, and when they could not be loaded or are withheld', () => {
    expect(
      render({
        kind: 'not_generated',
        canGenerate: false,
        notice: 'No question provider is configured.',
      }),
    ).toContain('data-testid="questions-cannot-generate"');
    expect(
      render({ kind: 'unavailable', message: 'The suggested questions could not be loaded.' }),
    ).toContain('data-testid="questions-unavailable"');
    const withheld = render({ kind: 'withheld' });
    expect(withheld).toContain('data-testid="questions-withheld"');
    expect(withheld).toContain('no longer passes its integrity checks');
    expect(withheld).not.toContain('data-testid="question-1"');
  });

  it('shows nothing at all for an assessment that does not verify', () => {
    expect(render({ kind: 'hidden' })).toBe('');
    expect(
      questionsPanelState({ verified: false, list: list(), set: set(5), canGenerate: true }),
    ).toEqual({ kind: 'hidden' });
  });

  it('renders project-supplied text as text, never as markup', () => {
    const hostile = set(1, {
      questions: [
        question(1, {
          references: [
            { type: 'claim', id: 'c1', label: HOSTILE, verificationLevel: 'team_claim' },
          ],
        }),
      ],
      opportunities: [{ ...opportunity(1), observation: HOSTILE }],
    });
    const html = render({ kind: 'set', set: hostile });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the shortfall message is the stored, truthful one', () => {
  const withShortfall = (code: QuestionShortfall, explanation: string, extra = {}) =>
    set(2, {
      shortfall: {
        code,
        explanation,
        candidateCount: 6,
        excluded: { redundant: 0, belowMinimum: 4 },
        policyNote: null,
        ...extra,
      },
    });

  it('shows exactly the stored explanation and invents no cause of its own', () => {
    const html = render({
      kind: 'set',
      set: withShortfall(
        'below_minimum_value',
        '6 valid candidates were generated and 2 were selected. The other 4 were left out because the value of asking each was below the minimum worth asking.',
      ),
    });
    expect(html).toContain('data-code="below_minimum_value"');
    expect(html).toContain('below the minimum worth asking');
    expect(html).not.toMatch(/repeated|repeats/);
  });

  it('marks which uncertainties no question covers, as the manual path', () => {
    const html = render({ kind: 'set', set: set(2) });
    expect((html.match(/data-covered="yes"/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain('data-covered="no"');
    expect(html).toContain('No question above covers this: available for your own follow-up.');
    expect(html).toContain('Asked in question 1.');
  });

  it('says a v1 set was recorded under the older policy, without rewriting its wording', () => {
    const html = render({
      kind: 'set',
      set: withShortfall('redundant_candidates', 'The recorded v1 wording.', {
        excluded: null,
        policyNote:
          'Recorded under selection policy v1, which could not tell a repeated question from one below the minimum.',
      }),
    });
    expect(html).toContain('data-testid="questions-policy-note"');
    expect(html).toContain('The recorded v1 wording.');
    expect(html).toContain('Recorded under selection policy v1');
  });
});

describe('the section state', () => {
  it('chooses the state from the verified read model only', () => {
    expect(
      questionsPanelState({ verified: true, list: null, set: null, canGenerate: true }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(
      questionsPanelState({ verified: true, list: list(), set: null, canGenerate: true }),
    ).toMatchObject({ kind: 'not_generated', canGenerate: true });
    expect(
      questionsPanelState({ verified: true, list: list(), set: null, canGenerate: false }),
    ).toMatchObject({ kind: 'not_generated', canGenerate: false });
    expect(
      questionsPanelState({
        verified: true,
        list: { ...list(), launch: { available: false, providerMode: null, notice: 'none' } },
        set: null,
        canGenerate: true,
      }),
    ).toMatchObject({ kind: 'not_generated', canGenerate: false });
    expect(
      questionsPanelState({ verified: true, list: list(), set: set(5), canGenerate: true }),
    ).toMatchObject({ kind: 'set' });
    expect(
      questionsPanelState({
        verified: true,
        list: list(),
        set: set(5, { assessmentVerified: false }),
        canGenerate: true,
      }),
    ).toEqual({ kind: 'withheld' });
    expect(
      questionsPanelState({
        verified: true,
        list: list(),
        set: null,
        error: 'boom',
        canGenerate: true,
      }),
    ).toEqual({ kind: 'unavailable', message: 'boom' });
  });
});
