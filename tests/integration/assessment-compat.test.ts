/*
 * M5 P3 compatibility contracts between packages that must not import each other:
 *   - assessment (Layer 2) <-> scoring (M4): the channel an evidence record is shown under equals the channel the engine counts;
 *     the label-only integrity classification the scoped reader applies equals the engine's.
 *   - assessment <-> prompts (Layer 3): the views and candidate items P3 produces are accepted by the strict P2 input schemas,
 *     and the closed sets P2 returns equal the sets the P3 gates validate against.
 */
import { buildEvidenceGraph } from '../../packages/evidence/src/index.js';
import { SCORING_ENGINE_VERSION, type EvidenceChannel } from '../../packages/schemas/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  buildPassages,
  buildStatementItems,
  CRITIC_FLAG_CODES,
  deterministicFlags,
  indexPassages,
  interpretViews,
  pairsForVerification,
  pendingReviews,
  resolveFidelity,
  statementViews,
  validateClaimExtraction,
  validateContradictions,
  validateCritic,
  validateDimensionAssessment,
  validateEvidenceInterpretation,
  validateRelationMatching,
  withoutCandidates,
  type RelationWorld,
  type UnitCandidates,
} from '../../packages/assessment/src/index.js';
import { build } from '../../packages/assessment/src/testing/scoring.js';
import { extract, type Extracted } from '../../packages/assessment/src/testing/pipeline.js';
import {
  artifact,
  hydroTrackArtifacts,
  lockedSnapshot as assessmentLocked,
  VERSION_ID,
} from '../../packages/assessment/src/testing/world.js';
import {
  CRITIC_FLAG_VALUES,
  officialUnitFromLockedSnapshot,
  renderPrompt,
} from '../../packages/prompts/src/index.js';
import { createTrustedScoringContext, scoreProject } from '../../packages/scoring/src/index.js';

// -- A project with evidence in every source channel ----------------------------------------------------------------------

const VIDEO_TEXT = '{\n  "title": "HydroTrack demo video: tracking water in thirty seconds"\n}\n';

function multiChannel(): Extracted {
  const artifacts = [
    ...hydroTrackArtifacts(),
    artifact({
      sourceType: 'video',
      key: 'metadata.json',
      kind: 'video_metadata',
      mediaType: 'application/json',
      text: VIDEO_TEXT,
    }),
    artifact({
      sourceType: 'github',
      key: 'repository.json',
      kind: 'repository_metadata',
      mediaType: 'application/json',
      text: '{\n  "description": "A tiny water tracker for students"\n}\n',
    }),
  ];
  const { passages } = buildPassages(artifacts);
  const index = indexPassages(passages);
  const pass = (key: string) => passages.find((p) => p.artifactKey === key)?.handle ?? '';
  const claimQuotes: [string, string][] = [
    [pass('submission.txt'), 'It works offline and never sends your data to a server.'],
    [pass('files/README.md'), 'HydroTrack is a small command line tool for tracking water intake.'],
    [pass('page.txt'), 'Sign in to see your history.'],
    [pass('metadata.json'), '"title": "HydroTrack demo video: tracking water in thirty seconds"'],
  ];
  const claims = validateClaimExtraction(
    {
      claims: claimQuotes.map(([passage, quote], i) => ({
        ref: `c${String(i)}`,
        text: quote,
        passage,
        quote,
      })),
    },
    index,
    // the closed set the REAL renderer returns for this request: the contract between the two packages
    renderPrompt('claim_extraction', { passages: statementViews(passages) }).closedSet,
  );
  const factQuotes: [string, string][] = [
    [pass('files/src/intake.ts'), 'db.insert({ amount, at: Date.now() });'],
    [pass('repository.json'), '"description": "A tiny water tracker for students"'],
    [pass('response.json'), '"status": 200'],
  ];
  const evidence = validateEvidenceInterpretation(
    {
      evidence: factQuotes.map(([passage, quote], i) => ({
        ref: `e${String(i)}`,
        text: quote,
        passage,
        quote,
      })),
    },
    index,
    renderPrompt('evidence_interpretation', { passages: interpretViews(passages) }).closedSet,
  );
  if (!claims.ok || !evidence.ok) throw new Error('fixture');
  const resolved = resolveFidelity(claims.accepted, evidence.accepted, []);
  const statements = buildStatementItems(resolved.claims, resolved.evidence).items;
  const relationWorld: RelationWorld = { claims: new Map(), evidence: new Map() };
  return {
    artifacts,
    passages,
    claims: resolved.claims,
    evidence: resolved.evidence,
    statements,
    relationWorld,
    commentaryWorld: { claims: new Set(), evidence: new Set(), statementOf: new Map() },
  };
}

describe('assessment <-> scoring', () => {
  const locked = assessmentLocked({ noRubric: true }); // fallback rubric: dimensions that declare evidence needs
  const built = build({ extracted: multiChannel(), locked });
  const dimension = (id: string) => {
    const unit = built.units.find((u) => u.dimensionId === id);
    if (!unit) throw new Error(`no unit ${id}`);
    return unit;
  };

  /** Scores one dimension citing ONE record and returns how many declared need groups the ENGINE says were satisfied. */
  function satisfiedGroups(dimensionId: string, evidenceId: string): number {
    const unit = dimension(dimensionId);
    const ids = built.units.map((u) => u.dimensionId);
    const judgments = ids.map((id) => ({
      dimensionId: id,
      outcome:
        id === dimensionId
          ? { kind: 'scored' as const, score: 5 }
          : { kind: 'insufficient_evidence' as const },
      citations:
        id === dimensionId
          ? [{ evidenceId, directness: 'direct' as const, specificity: 'exact' as const }]
          : [],
    }));
    const result = scoreProject(built.context, {
      engineVersion: SCORING_ENGINE_VERSION,
      judgments,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const report = result.report.dimensions.find((d) => d.id === unit.dimensionId);
    return report?.needs.kind === 'declared' ? report.needs.satisfiedGroups : -1;
  }

  it('the channel P3 shows equals the channel the engine counts, for every record and every channel (cross-check)', () => {
    const unit = dimension('technical_execution.implementation_depth'); // needs [source_code]
    const runtime = dimension('completion_functionality.runtime_live_demonstration'); // needs [deployment|video|judge_observation]
    let checked = 0;
    const seen = new Set<EvidenceChannel>();
    for (const item of unit.items) {
      seen.add(item.channel);
      const codeGroups = satisfiedGroups(
        'technical_execution.implementation_depth',
        item.evidenceId,
      );
      expect(codeGroups, `${item.channel} for source_code need`).toBe(
        item.channel === 'source_code' ? 1 : 0,
      );
      const runtimeGroups = satisfiedGroups(
        'completion_functionality.runtime_live_demonstration',
        item.evidenceId,
      );
      expect(runtimeGroups, `${item.channel} for runtime need`).toBe(
        item.channel === 'deployment' || item.channel === 'video' ? 1 : 0,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(7);
    expect([...seen].sort()).toEqual([
      'deployment',
      'repository',
      'source_code',
      'submission',
      'video',
    ]);
    expect(runtime.items.length).toBe(unit.items.length);
  });
});

describe('the scoped reader and the engine classify integrity findings alike', () => {
  const built = build();

  it('a label-only finding (an unjustified claim level) is tolerated by both; a dangling relation fails both', async () => {
    const { recordsFromPlan, scopeGraph, membersOf, membersHash, buildPlanContext } =
      await import('../../packages/assessment/src/index.js');
    const { planWorld, PROJECT_ID, EVENT_ID } =
      await import('../../packages/assessment/src/testing/world.js');
    const world = planWorld(built.extracted.artifacts, {
      contextVersion: { id: VERSION_ID, version: 1, status: 'locked' },
    });
    const known = buildPlanContext(world);
    const records = recordsFromPlan(built.planned, { projectId: PROJECT_ID, eventId: EVENT_ID });
    const members = membersOf(built.planned);

    const labelOnly = {
      ...records,
      claims: records.claims.map((c, i) =>
        i === 0 ? { ...c, verificationLevel: 'repo_corroborated' as const } : c,
      ),
    };
    const scopeOf = (m: typeof members) => ({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      known,
      expectedMembersHash: membersHash(m),
      members: m,
    });
    const scoped = scopeGraph(labelOnly, scopeOf(members));
    const engine = createTrustedScoringContext({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      graph: buildEvidenceGraph(labelOnly),
      known,
      locked: built.locked,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(scoped.ok).toBe(true);
    expect(engine.ok).toBe(true);

    const dangling = {
      ...records,
      relations: [
        {
          ...(records.relations[0] ??
            (() => {
              throw new Error('fixture');
            })()),
          evidenceId: 'dddddddd-0000-4000-8000-000000000001',
        },
      ],
    };
    const scopedBad = scopeGraph(
      dangling,
      scopeOf({ ...members, relationIds: dangling.relations.map((r) => r.id) }),
    );
    const engineBad = createTrustedScoringContext({
      projectId: PROJECT_ID,
      eventId: EVENT_ID,
      graph: buildEvidenceGraph(dangling),
      known,
      locked: built.locked,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(scopedBad.ok).toBe(false);
    expect(engineBad.ok).toBe(false);
  });
});

describe('assessment <-> prompts', () => {
  const ex = extract();

  it('passage views satisfy the strict P2 input schemas, and the closed sets are the passages shown', () => {
    const statements = renderPrompt('claim_extraction', { passages: statementViews(ex.passages) });
    expect(statements.closedSet.passages).toEqual(
      ex.passages.filter((p) => p.route === 'statement').map((p) => p.handle),
    );
    const interpretations = renderPrompt('evidence_interpretation', {
      passages: interpretViews(ex.passages),
    });
    expect(interpretations.closedSet.passages).toEqual(
      ex.passages.filter((p) => p.route === 'interpret').map((p) => p.handle),
    );
  });

  it('fidelity items, relation pairs and the relation world satisfy their prompt schemas', () => {
    const pending = pendingReviews(
      ex.claims.map((c) => ({ ...c, grounding: 'pending_review' as const })),
      ex.evidence,
    );
    const fidelity = renderPrompt('fidelity_review', {
      items: pending.map((p) => ({ handle: p.handle, assertion: p.assertion, quote: p.quote })),
    });
    expect(fidelity.closedSet.items).toEqual(pending.map((p) => p.handle));
    const pairs = pairsForVerification(
      [{ claim: 'C-001', evidence: 'E-001', type: 'supports', basis: 'independent_observation' }],
      ex.relationWorld,
    );
    const verification = renderPrompt('relation_verification', {
      pairs: pairs.map((p) => ({
        handle: p.handle,
        claim: p.claim,
        evidence: p.evidence,
        evidenceQuote: p.evidenceQuote,
      })),
    });
    expect(verification.closedSet.pairs).toEqual(['X-001']);
    const matching = renderPrompt('relation_matching', {
      claims: [...ex.relationWorld.claims.values()].map((c) => ({
        handle: c.handle,
        text: c.text,
      })),
      evidence: [...ex.relationWorld.evidence.values()].map((e) => ({
        handle: e.handle,
        text: e.text,
        quote: e.excerpt,
      })),
    });
    expect(matching.closedSet.claims).toEqual([...ex.relationWorld.claims.keys()]);
    expect(matching.closedSet.evidence).toEqual([...ex.relationWorld.evidence.keys()]);
  });

  it("candidate items and the official rubric unit satisfy the dimension-assessment prompt; its closed set is the unit's set", () => {
    const locked = assessmentLocked();
    const built = build({ locked });
    const unit = built.units[0] as UnitCandidates;
    const { unit: view } = officialUnitFromLockedSnapshot(
      locked,
      {
        versionId: locked.versionId,
        lockedContentHash: locked.lockedContentHash,
        eventId: locked.eventId,
      },
      'problem_fit',
    );
    const rendered = renderPrompt('dimension_assessment', {
      unit: view,
      candidates: unit.items.map((i) => ({
        handle: i.handle,
        channel: i.channel,
        label: i.label,
        authorship: i.authorship,
        text: i.text,
        excerpt: i.excerpt,
      })),
    });
    expect(rendered.closedSet.evidence).toEqual(unit.items.map((i) => i.handle));
    expect(rendered.closedSet.unit).toBe(unit.dimensionId);
  });

  it('the deterministic critic flags are exactly the flags the critic prompt accepts', () => {
    expect([...CRITIC_FLAG_CODES]).toEqual([...CRITIC_FLAG_VALUES]);
    expect(typeof deterministicFlags).toBe('function');
  });
});

describe("the gates take the renderer's closedSet directly (F1, P3 review)", () => {
  // A Devpost text long enough for several statement passages: batch A and batch B are real windows of one extraction.
  const lines = Array.from(
    { length: 160 },
    (_, i) => `Statement number ${String(i)} says the project does something specific and unique.`,
  );
  const artifacts = [
    artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text: `${lines.join('\n')}\n`,
    }),
    ...hydroTrackArtifacts().slice(1),
  ];
  const { passages } = buildPassages(artifacts);
  const index = indexPassages(passages);
  const statements = passages.filter((p) => p.route === 'statement');

  it('claim extraction: a real passage of another batch is rejected using the closedSet the renderer returned', () => {
    const [a, b] = statements;
    if (!a || !b) throw new Error('fixture');
    const batchB = renderPrompt('claim_extraction', { passages: statementViews([b]) });
    expect(batchB.closedSet.passages).toEqual([b.handle]);
    const quote = a.text.split('\n')[0] ?? '';
    const result = validateClaimExtraction(
      { claims: [{ ref: 'c1', text: quote, passage: a.handle, quote }] },
      index,
      batchB.closedSet,
    );
    expect(result.ok && result.rejected.map((r) => r.code)).toEqual(['passage_not_shown']);
  });

  it("relation matching, verification, contradictions, unknowns, fidelity, assessor and critic accept the renderer's sets", () => {
    const ex = extract();
    const matching = renderPrompt('relation_matching', {
      claims: [...ex.relationWorld.claims.values()].map((c) => ({
        handle: c.handle,
        text: c.text,
      })),
      evidence: [...ex.relationWorld.evidence.values()].map((e) => ({
        handle: e.handle,
        text: e.text,
        quote: e.excerpt,
      })),
    });
    const relation = validateRelationMatching(
      { relations: [{ claim: 'C-001', evidence: 'E-001', type: 'supports' }] },
      ex.relationWorld,
      matching.closedSet,
    );
    expect(relation.ok && relation.accepted).toHaveLength(1);
    const narrow = renderPrompt('relation_matching', {
      claims: [{ handle: 'C-002', text: 'x claim' }],
      evidence: [{ handle: 'E-001', text: 'x fact', quote: null }],
    });
    const hostile = validateRelationMatching(
      { relations: [{ claim: 'C-001', evidence: 'E-001', type: 'supports' }] },
      ex.relationWorld,
      narrow.closedSet,
    );
    expect(hostile.ok && hostile.rejected.map((r) => r.code)).toEqual(['claim_not_shown']);

    const contradictions = renderPrompt('contradiction_detection', {
      claims: [{ handle: 'C-002', text: 'works offline' }],
      evidence: [{ handle: 'E-001', text: 'x fact', quote: null }],
    });
    const contradiction = validateContradictions(
      {
        contradictions: [
          {
            sideA: { type: 'claim', handle: 'C-001' },
            sideB: { type: 'evidence', handle: 'E-001' },
            description: 'The README and the handler differ on offline mode.',
          },
        ],
      },
      ex.commentaryWorld,
      contradictions.closedSet,
    );
    expect(contradiction.ok && contradiction.rejected.map((r) => r.code)).toEqual([
      'side_not_shown',
    ]);

    const built = build();
    const unit = built.units[0];
    if (!unit) throw new Error('fixture');
    const locked = assessmentLocked();
    const { unit: view } = officialUnitFromLockedSnapshot(
      locked,
      {
        versionId: locked.versionId,
        lockedContentHash: locked.lockedContentHash,
        eventId: locked.eventId,
      },
      'problem_fit',
    );
    const reduced = withoutCandidates(unit, [unit.items[1]?.handle ?? '']);
    const assess = renderPrompt('dimension_assessment', {
      unit: view,
      candidates: reduced.items.map((i) => ({
        handle: i.handle,
        channel: i.channel,
        label: i.label,
        authorship: i.authorship,
        text: i.text,
        excerpt: i.excerpt,
      })),
    });
    const removed = unit.items[1]?.handle ?? '';
    const judgment = validateDimensionAssessment(
      {
        dimensionId: unit.dimensionId,
        outcome: { kind: 'scored', score: 5 },
        citations: [
          { evidence: removed, directness: 'direct', specificity: 'exact', note: 'cited' },
        ],
        rationale: 'Cites a record this prompt did not show.',
        limitations: [],
      },
      unit, // the ORIGINAL unit: only the renderer's closed set stands between the model and the removed record
      { min: 0, max: 10 },
      assess.closedSet,
    );
    expect('issues' in judgment && judgment.issues.map((i) => i.code)).toEqual([
      'citation_not_shown',
    ]);

    const critic = renderPrompt('critic', {
      unit: view,
      judgment: {
        outcome: { kind: 'scored', score: 5 },
        rationale: 'x rationale',
        citations: [{ evidence: 'E-001', directness: 'direct', specificity: 'exact', note: 'n' }],
      },
      cited: [
        {
          handle: 'E-001',
          channel: 'submission',
          label: 'team_claim',
          authorship: 'team_statement',
          text: 'x',
          excerpt: null,
        },
      ],
      others: [],
      contradictions: [],
      flags: [],
    });
    const verdict = validateCritic(
      {
        unit: unit.dimensionId,
        findings: [
          {
            code: 'unsupported_judgment',
            severity: 'blocking',
            evidence: ['E-002'],
            note: 'Not supported.',
          },
        ],
      },
      critic.closedSet,
    );
    expect('issues' in verdict && verdict.issues.map((i) => i.code)).toEqual([
      'unknown_evidence_handle',
    ]);
  });
});
