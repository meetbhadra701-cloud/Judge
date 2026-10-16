import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  blankModel,
  modelFromInput,
  type SourceOption,
} from '../../../../../../lib/context-editor';
import { ContextEditor } from './context-editor';

vi.mock('./actions', () => ({ saveStructuredContextAction: () => Promise.resolve() }));

const SOURCES: SourceOption[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Official rules',
    authority: 'official_event_rules',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Organizer notes',
    authority: 'organizer_guidance',
  },
];

const render = (initial = blankModel(), sources = SOURCES) =>
  renderToStaticMarkup(
    <ContextEditor
      eventId="e1"
      versionId="v1"
      eventName="Demo Hackathon"
      sources={sources}
      initial={initial}
      sourceTexts={[{ id: SOURCES[0]?.id ?? '', title: 'Official rules', text: 'Rule text.' }]}
    />,
  );

describe('P6D structured Event Context editor (rendered)', () => {
  it('offers a form for every part of the context and names no identifier, key or JSON', () => {
    const html = render();
    for (const label of [
      'Event and sources',
      'Dates and how judging works',
      'Official judging criteria',
      'Event rules',
      'Participation and submission requirements',
      'Prior-work policy',
      'Tracks and sponsor challenges',
      'Organizer guidance (not official rules)',
      'Add the overall judging rubric',
      'Add a track rubric',
      'Add a rule',
      'Add a requirement',
      'Add a track',
      'Save draft',
    ]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain('Demo Hackathon');
    expect(html).not.toMatch(/JSON/);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/); // no UUID is shown (ids only exist in the hidden document field)
    // a track rubric cannot be added until a track exists
    expect(html).toMatch(
      /Add a track rubric<\/button>\s*<small>\s*\(define a track in section 6 first\)/,
    );
  });

  it('distinguishes official statements, interpretations and unverified notes, and never offers "official" for organizer guidance', () => {
    const initial = {
      ...blankModel(),
      rules: [
        {
          statement: 'Original work only.',
          basis: 'official' as const,
          sourceIds: [SOURCES[0]?.id ?? ''],
        },
      ],
      guidance: [{ statement: 'Be kind.', basis: 'interpreted' as const, sourceIds: [] }],
    };
    const html = render(initial);
    expect(html).toContain('Official — stated in an official source I cite');
    expect(html).toContain('Organizer’s interpretation — my reading of the sources');
    expect(html).toContain('Unverified note — not confirmed by any source');
    const guidance = html.slice(html.indexOf('data-testid="guidance-0"'));
    expect(
      guidance.slice(0, guidance.indexOf('Remove guidance')).includes('Official — stated'),
    ).toBe(false);
  });

  it('with no sources it says to add them first instead of offering an empty picker', () => {
    const html = render(blankModel(), []);
    expect(html).toContain('none yet — add the event’s official texts on the version page first.');
  });

  it('shows a stored draft in plain fields, with the weights as percents and unweighted criteria empty', () => {
    const model = modelFromInput({
      ...blankInput(),
      rubrics: [
        {
          scope: 'overall',
          trackKey: null,
          name: 'Official judging criteria',
          scaleMin: 1,
          scaleMax: 5,
          sourceIds: [],
          criteria: [
            {
              key: 'innovation',
              name: 'Innovation',
              description: '',
              weight: 0.4,
              sourceIds: [],
              anchors: [],
            },
            {
              key: 'execution',
              name: 'Execution',
              description: '',
              weight: 0.6,
              sourceIds: [],
              anchors: [],
            },
          ],
        },
      ],
    } as never);
    const html = render(model);
    expect(html).toContain('value="Official judging criteria"');
    expect(html).toContain('value="40"');
    expect(html).toContain('value="60"');
    expect(html).toContain('Weights entered: 100 % of 100 %.');
  });
});

function blankInput() {
  const unclear = { statement: 'Not stated.', certainty: 'unclear', sourceIds: [], value: null };
  return {
    dates: {
      startsAt: unclear,
      endsAt: unclear,
      judgingStartsAt: unclear,
      submissionDeadline: unclear,
    },
    judgingFormat: { statement: 'Not stated.', certainty: 'unclear', sourceIds: [] },
    rules: [],
    submissionRequirements: [],
    priorWorkPolicy: {
      statement: 'Not stated.',
      certainty: 'unclear',
      sourceIds: [],
      stance: 'unclear',
    },
    organizerGuidance: [],
    tracks: [],
    rubrics: [],
    conflicts: [],
  };
}
