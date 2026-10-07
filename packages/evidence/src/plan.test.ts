import { describe, expect, it } from 'vitest';
import { deterministicIdAllocator } from './ids.js';
import type { GraphIssueCode } from './issues.js';
import { planEvidenceGraphBatch, type PlanContext, type PlanResult } from './plan.js';
import {
  isVerificationLevelAvailableToProducers,
  M3_PRODUCER_VERIFICATION_LEVELS,
} from './verification.js';
import { VERIFICATION_LEVEL_VALUES } from '@judge-copilot/schemas';
import {
  CODE_TEXT,
  README_TEXT,
  SCOPE,
  batch,
  ID,
  ids,
  knownWorld,
  spanOf,
} from './testing/builders.js';

function plan(raw: unknown, context: PlanContext = knownWorld(), namespace = 'plan') {
  return planEvidenceGraphBatch(batch(raw), SCOPE, context, ids(namespace));
}

function codes(result: PlanResult): GraphIssueCode[] {
  if (result.ok) throw new Error('expected the plan to be rejected');
  return result.issues.map((issue) => issue.code);
}

function issuesAt(result: PlanResult, path: string): GraphIssueCode[] {
  if (result.ok) throw new Error('expected the plan to be rejected');
  return result.issues.filter((issue) => issue.path === path).map((issue) => issue.code);
}

const teamClaim = {
  ref: 'c1',
  text: 'The project has a working API.',
  verificationLevel: 'team_claim',
};
const devpostStatement = {
  ref: 'e1',
  kind: 'claim',
  origin: 'devpost',
  verificationLevel: 'team_claim',
  text: 'Devpost says: we built a REST API.',
  provenance: { snapshotId: ID.devpostSnapshot },
};
const deploymentFact = {
  ref: 'e2',
  kind: 'fact',
  origin: 'deployment',
  verificationLevel: 'unverified',
  text: 'GET /health answered 200.',
  provenance: { snapshotId: ID.deploymentSnapshot },
};

describe('planEvidenceGraphBatch — happy path', () => {
  it('assigns trusted IDs to refs, keeps batch order and resolves every reference', () => {
    const result = plan({
      claims: [
        teamClaim,
        { ref: 'c2', text: 'The API is documented.', verificationLevel: 'unverified' },
      ],
      evidence: [devpostStatement, deploymentFact],
      relations: [
        { claim: { ref: 'c1' }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { ref: 'e2' }, type: 'supports' },
      ],
      unknowns: [
        {
          unknownType: 'missing',
          text: 'State across restarts is not shown.',
          claims: [{ ref: 'c1' }],
          evidence: [{ ref: 'e2' }],
        },
      ],
      contradictions: [
        {
          sideA: { type: 'evidence', ref: 'e2' },
          sideB: { type: 'claim', ref: 'c2' },
          description: 'The documented API and the deployment response differ.',
        },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const { graph } = result;
    expect(graph.claims.map((claim) => claim.ref)).toEqual(['c1', 'c2']);
    expect(graph.evidence.map((item) => item.ref)).toEqual(['e1', 'e2']);
    const [c1, c2] = graph.claims;
    const [e1, e2] = graph.evidence;
    expect(graph.relations.map((r) => [r.claimId, r.evidenceId])).toEqual([
      [c1?.id, e1?.id],
      [c1?.id, e2?.id],
    ]);
    expect(graph.unknowns[0]).toMatchObject({ claimIds: [c1?.id], evidenceIds: [e2?.id] });
    // Canonical order: "claim:" sorts before "evidence:", whatever order the producer wrote.
    expect(graph.contradictions[0]?.sideA).toEqual({ type: 'claim', id: c2?.id });
    expect(graph.contradictions[0]?.sideB).toEqual({ type: 'evidence', id: e2?.id });
  });

  it('is deterministic: the same batch and allocator namespace give identical plans', () => {
    const raw = { claims: [teamClaim], evidence: [devpostStatement] };
    expect(plan(raw, knownWorld(), 'same')).toEqual(plan(raw, knownWorld(), 'same'));
    expect(plan(raw, knownWorld(), 'same')).not.toEqual(plan(raw, knownWorld(), 'other'));
  });

  it('allocates IDs only through the trusted allocator', () => {
    const allocated: string[] = [];
    const spy = {
      next: (scope: string) => {
        const id = deterministicIdAllocator('spy').next(scope + allocated.length.toString());
        allocated.push(id);
        return id;
      },
    };
    const result = planEvidenceGraphBatch(
      batch({ claims: [teamClaim], evidence: [devpostStatement] }),
      SCOPE,
      knownWorld(),
      spy,
    );
    if (!result.ok) throw new Error('rejected');
    expect(result.graph.claims[0]?.id).toBe(allocated[0]);
    expect(result.graph.evidence[0]?.id).toBe(allocated[1]);
  });
});

describe('ID integrity: a well-formed UUID is not enough (invariant 20)', () => {
  it('rejects a syntactically valid claim and evidence ID that do not exist', () => {
    const result = plan({
      claims: [teamClaim],
      evidence: [devpostStatement],
      relations: [
        { claim: { id: ID.nothing }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { id: ID.nothing }, type: 'supports' },
      ],
    });
    expect(issuesAt(result, 'relations[0].claim')).toEqual(['CLAIM_NOT_FOUND']);
    expect(issuesAt(result, 'relations[1].evidence')).toEqual(['EVIDENCE_NOT_FOUND']);
  });

  it('does not accept the ID the allocator is about to assign (guessing creates nothing)', () => {
    const guess = ids('plan').next('claim');
    const result = plan({
      claims: [teamClaim],
      evidence: [devpostStatement],
      relations: [{ claim: { id: guess }, evidence: { ref: 'e1' }, type: 'supports' }],
    });
    expect(issuesAt(result, 'relations[0].claim')).toEqual(['CLAIM_NOT_FOUND']);
  });

  it('classifies the wrong entity type', () => {
    const result = plan({
      claims: [teamClaim],
      evidence: [devpostStatement],
      relations: [
        // an evidence ID where a claim is required, and a claim ID where evidence is required
        { claim: { id: ID.existingEvidence }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { id: ID.existingClaim }, type: 'supports' },
      ],
      contradictions: [
        {
          sideA: { type: 'claim', id: ID.existingEvidence },
          sideB: { type: 'claim', ref: 'c1' },
          description: 'x',
        },
      ],
    });
    expect(issuesAt(result, 'relations[0].claim')).toEqual(['WRONG_ENTITY_TYPE']);
    expect(issuesAt(result, 'relations[1].evidence')).toEqual(['WRONG_ENTITY_TYPE']);
    expect(issuesAt(result, 'contradictions[0].sideA')).toEqual(['WRONG_ENTITY_TYPE']);
  });

  it('classifies snapshot, artifact and context-version IDs used in the wrong position', () => {
    const result = plan({
      evidence: [
        {
          ...deploymentFact,
          ref: 'a',
          provenance: { snapshotId: ID.readme },
        },
        {
          ...deploymentFact,
          ref: 'b',
          provenance: { snapshotId: ID.deploymentSnapshot, artifactId: ID.deploymentSnapshot },
        },
        {
          ref: 'c',
          kind: 'fact',
          origin: 'event_context',
          verificationLevel: 'unverified',
          text: 'Official rule.',
          provenance: { contextVersionId: ID.githubSnapshot },
        },
      ],
    });
    expect(issuesAt(result, 'evidence[0].provenance.snapshotId')).toEqual(['WRONG_ENTITY_TYPE']);
    expect(issuesAt(result, 'evidence[1].provenance.artifactId')).toEqual(['WRONG_ENTITY_TYPE']);
    expect(issuesAt(result, 'evidence[2].provenance.contextVersionId')).toEqual([
      'WRONG_ENTITY_TYPE',
    ]);
  });

  it('rejects references into another project', () => {
    const result = plan({
      claims: [{ ...teamClaim, supersedes: { id: ID.otherProjectClaim } }],
      evidence: [devpostStatement],
      relations: [
        { claim: { id: ID.otherProjectClaim }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { id: ID.otherProjectEvidence }, type: 'supports' },
      ],
      unknowns: [
        {
          unknownType: 'missing',
          text: 'x',
          claims: [{ id: ID.otherProjectClaim }],
          evidence: [{ id: ID.otherProjectEvidence }],
        },
      ],
      contradictions: [
        {
          sideA: { type: 'claim', ref: 'c1' },
          sideB: { type: 'evidence', id: ID.otherProjectEvidence },
          description: 'x',
        },
      ],
    });
    expect(issuesAt(result, 'claims[0].supersedes')).toEqual(['CROSS_PROJECT_REFERENCE']);
    expect(issuesAt(result, 'relations[0].claim')).toEqual(['CROSS_PROJECT_REFERENCE']);
    expect(issuesAt(result, 'relations[1].evidence')).toEqual(['CROSS_PROJECT_REFERENCE']);
    expect(issuesAt(result, 'unknowns[0].claims[0]')).toEqual(['CROSS_PROJECT_REFERENCE']);
    expect(issuesAt(result, 'unknowns[0].evidence[0]')).toEqual(['CROSS_PROJECT_REFERENCE']);
    expect(issuesAt(result, 'contradictions[0].sideB')).toEqual(['CROSS_PROJECT_REFERENCE']);
  });

  it('rejects unknown refs, duplicate refs and Unknowns that reference nonexistent IDs', () => {
    const result = plan({
      claims: [teamClaim, teamClaim],
      relations: [{ claim: { ref: 'nope' }, evidence: { ref: 'nope' }, type: 'supports' }],
      unknowns: [
        {
          unknownType: 'ambiguous',
          text: 'x',
          claims: [{ id: ID.nothing }, { ref: 'c1' }, { ref: 'c1' }],
          evidence: [{ id: ID.nothing }],
        },
      ],
    });
    expect(issuesAt(result, 'claims[1].ref')).toEqual(['DUPLICATE_LOCAL_REF']);
    expect(issuesAt(result, 'relations[0].claim')).toEqual(['LOCAL_REF_NOT_FOUND']);
    expect(issuesAt(result, 'unknowns[0].claims[0]')).toEqual(['CLAIM_NOT_FOUND']);
    expect(issuesAt(result, 'unknowns[0].claims[2]')).toEqual(['DUPLICATE_REFERENCE']);
    expect(issuesAt(result, 'unknowns[0].evidence[0]')).toEqual(['EVIDENCE_NOT_FOUND']);
  });

  it('reports issues deterministically (sorted by path, then code) and all at once', () => {
    const raw = {
      claims: [teamClaim],
      relations: [
        { claim: { id: ID.nothing }, evidence: { id: ID.nothing }, type: 'supports' },
        { claim: { id: ID.otherProjectClaim }, evidence: { ref: 'gone' }, type: 'contradicts' },
      ],
    };
    const first = plan(raw);
    const second = plan(raw);
    expect(first).toEqual(second);
    if (first.ok) throw new Error('expected rejection');
    const paths = first.issues.map((issue) => issue.path);
    expect(paths).toEqual([...paths].sort());
    expect(first.issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe('claim supersession', () => {
  it('supersedes an existing claim of the same project', () => {
    const result = plan({
      claims: [
        {
          ...teamClaim,
          text: 'The project has a working REST API.',
          supersedes: { id: ID.existingClaim },
        },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.graph.claims[0]?.supersedesId).toBe(ID.existingClaim);
  });

  it('builds a chain inside one batch, oldest first', () => {
    const result = plan({
      claims: [
        { ref: 'v1', text: 'v1', verificationLevel: 'unverified' },
        { ref: 'v2', text: 'v2', verificationLevel: 'team_claim', supersedes: { ref: 'v1' } },
        { ref: 'v3', text: 'v3', verificationLevel: 'team_claim', supersedes: { ref: 'v2' } },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [v1, v2, v3] = result.graph.claims;
    expect([v1?.supersedesId, v2?.supersedesId, v3?.supersedesId]).toEqual([null, v1?.id, v2?.id]);
  });

  it('rejects self, forward and cyclic supersession', () => {
    expect(
      issuesAt(
        plan({ claims: [{ ...teamClaim, supersedes: { ref: 'c1' } }] }),
        'claims[0].supersedes',
      ),
    ).toEqual(['FORWARD_SUPERSESSION']);
    const result = plan({
      claims: [
        { ref: 'a', text: 'a', verificationLevel: 'unverified', supersedes: { ref: 'b' } },
        { ref: 'b', text: 'b', verificationLevel: 'unverified', supersedes: { ref: 'a' } },
      ],
    });
    expect(issuesAt(result, 'claims[0].supersedes')).toEqual(['FORWARD_SUPERSESSION']);
    // b -> a is backward and fine; the cycle is impossible because a -> b was refused.
    expect(issuesAt(result, 'claims[1].supersedes')).toEqual([]);
  });

  it('rejects superseding a claim that already has a successor, and branching', () => {
    expect(
      codes(plan({ claims: [{ ...teamClaim, supersedes: { id: ID.supersededClaim } }] })),
    ).toEqual(['CLAIM_ALREADY_SUPERSEDED']);
    const branching = plan({
      claims: [
        {
          ref: 'a',
          text: 'a',
          verificationLevel: 'unverified',
          supersedes: { id: ID.existingClaim },
        },
        {
          ref: 'b',
          text: 'b',
          verificationLevel: 'unverified',
          supersedes: { id: ID.existingClaim },
        },
      ],
    });
    expect(issuesAt(branching, 'claims[1].supersedes')).toEqual(['CLAIM_ALREADY_SUPERSEDED']);
  });

  it('rejects a nonexistent predecessor', () => {
    expect(codes(plan({ claims: [{ ...teamClaim, supersedes: { id: ID.nothing } }] }))).toEqual([
      'CLAIM_NOT_FOUND',
    ]);
  });

  it('applies the verification transition rule to the predecessor', () => {
    // verifiedClaim is machine_verified: a corrected version may not silently drop to team_claim.
    expect(
      codes(plan({ claims: [{ ...teamClaim, supersedes: { id: ID.verifiedClaim } }] })),
    ).toEqual(['INVALID_VERIFICATION_TRANSITION']);
    // ... but may become unverified-through-contradiction.
    const result = plan({
      claims: [
        {
          ref: 'c',
          text: 'x',
          verificationLevel: 'contradicted',
          supersedes: { id: ID.verifiedClaim },
        },
      ],
      evidence: [deploymentFact],
      contradictions: [
        {
          sideA: { type: 'claim', ref: 'c' },
          sideB: { type: 'evidence', ref: 'e2' },
          description: 'Differs.',
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe('evidence provenance', () => {
  const evidenceFor = (origin: string, provenance: object, overrides: object = {}) =>
    plan({
      evidence: [
        {
          ref: 'e',
          kind: 'fact',
          origin,
          verificationLevel: 'unverified',
          text: 'Observed.',
          provenance,
          ...overrides,
        },
      ],
    });

  it('accepts every source-derived origin with a snapshot of the matching type', () => {
    for (const [origin, snapshotId] of [
      ['devpost', ID.devpostSnapshot],
      ['github', ID.githubSnapshot],
      ['github', ID.githubPartial],
      ['deployment', ID.deploymentSnapshot],
      ['video', ID.videoSnapshot],
    ] as const) {
      expect(evidenceFor(origin, { snapshotId }).ok, `${origin} ${snapshotId}`).toBe(true);
    }
  });

  it('accepts event_context evidence from a locked or a historically locked version', () => {
    expect(evidenceFor('event_context', { contextVersionId: ID.lockedVersion }).ok).toBe(true);
    expect(evidenceFor('event_context', { contextVersionId: ID.supersededVersion }).ok).toBe(true);
  });

  it('rejects event_context evidence from a draft version or another event', () => {
    expect(codes(evidenceFor('event_context', { contextVersionId: ID.draftVersion }))).toEqual([
      'CONTEXT_VERSION_NOT_FROZEN',
    ]);
    expect(codes(evidenceFor('event_context', { contextVersionId: ID.otherEventVersion }))).toEqual(
      ['CROSS_PROJECT_REFERENCE'],
    );
    expect(codes(evidenceFor('event_context', { contextVersionId: ID.nothing }))).toEqual([
      'CONTEXT_VERSION_NOT_FOUND',
    ]);
  });

  it('requires structural provenance for every supported origin; no free-text "from README"', () => {
    expect(codes(evidenceFor('github', {}))).toEqual(['MISSING_PROVENANCE']);
    expect(codes(evidenceFor('event_context', {}))).toEqual(['MISSING_PROVENANCE']);
    expect(
      codes(
        evidenceFor('devpost', {
          snapshotId: ID.devpostSnapshot,
          contextVersionId: ID.lockedVersion,
        }),
      ),
    ).toEqual(['UNEXPECTED_PROVENANCE']);
    expect(
      codes(
        evidenceFor('event_context', {
          contextVersionId: ID.lockedVersion,
          snapshotId: ID.githubSnapshot,
        }),
      ),
    ).toContain('UNEXPECTED_PROVENANCE');
  });

  it('keeps team_answer and judge_observation as vocabulary only (M7 owns their records)', () => {
    expect(
      codes(evidenceFor('team_answer', {}, { kind: 'claim', verificationLevel: 'team_claim' })),
    ).toContain('ORIGIN_NOT_SUPPORTED');
    expect(
      codes(evidenceFor('judge_observation', {}, { verificationLevel: 'judge_verified' })),
    ).toContain('ORIGIN_NOT_SUPPORTED');
  });

  it('rejects a snapshot of another project, of the wrong source type, or without content', () => {
    expect(codes(evidenceFor('github', { snapshotId: ID.otherProjectSnapshot }))).toEqual([
      'CROSS_PROJECT_REFERENCE',
    ]);
    expect(codes(evidenceFor('github', { snapshotId: ID.nothing }))).toEqual([
      'SNAPSHOT_NOT_FOUND',
    ]);
    expect(codes(evidenceFor('github', { snapshotId: ID.devpostSnapshot }))).toEqual([
      'SOURCE_TYPE_MISMATCH',
    ]);
    expect(codes(evidenceFor('devpost', { snapshotId: ID.githubSnapshot }))).toEqual([
      'SOURCE_TYPE_MISMATCH',
    ]);
    for (const snapshotId of [ID.githubFailed, ID.githubRejected, ID.githubPending]) {
      expect(codes(evidenceFor('github', { snapshotId })), snapshotId).toEqual([
        'SNAPSHOT_NOT_CONTENT_BEARING',
      ]);
    }
  });

  it('rejects an artifact of a different snapshot or of another project', () => {
    expect(
      codes(evidenceFor('github', { snapshotId: ID.githubPartial, artifactId: ID.readme })),
    ).toEqual(['ARTIFACT_SNAPSHOT_MISMATCH']);
    expect(
      codes(
        evidenceFor('github', {
          snapshotId: ID.githubSnapshot,
          artifactId: ID.otherSnapshotArtifact,
        }),
      ),
    ).toEqual(['CROSS_PROJECT_REFERENCE']);
    expect(
      codes(evidenceFor('github', { snapshotId: ID.githubSnapshot, artifactId: ID.nothing })),
    ).toEqual(['ARTIFACT_NOT_FOUND']);
    expect(codes(evidenceFor('github', { artifactId: ID.readme }))).toContain('MISSING_PROVENANCE');
  });

  describe('spans (Unicode code points, half-open)', () => {
    const readme = { snapshotId: ID.githubSnapshot, artifactId: ID.readme };

    it('derives the verbatim excerpt from the artifact, never from the producer', () => {
      const span = spanOf(README_TEXT, 'GET /health');
      const result = evidenceFor('github', { ...readme, span });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.graph.evidence[0]?.provenance).toMatchObject({
        span: { ...span, unit: 'code_points' },
        excerpt: 'GET /health',
      });
    });

    it('counts code points, not UTF-16 units or bytes', () => {
      // "# Atlas 🚀": the rocket is one code point, two UTF-16 units, four bytes.
      const span = spanOf(README_TEXT, '🚀');
      expect(span.end - span.start).toBe(1);
      const result = evidenceFor('github', { ...readme, span });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.graph.evidence[0]?.provenance.excerpt).toBe('🚀');
    });

    it('accepts a matching producer excerpt and rejects a mismatching one', () => {
      const span = spanOf(README_TEXT, 'GET /health');
      expect(evidenceFor('github', { ...readme, span, excerpt: 'GET /health' }).ok).toBe(true);
      expect(codes(evidenceFor('github', { ...readme, span, excerpt: 'GET /healthz' }))).toEqual([
        'EXCERPT_MISMATCH',
      ]);
      expect(codes(evidenceFor('github', { ...readme, span, excerpt: ' GET /health' }))).toEqual([
        'EXCERPT_MISMATCH',
      ]);
    });

    it('rejects out-of-range, empty, reversed and oversized spans, and spans without an artifact', () => {
      const length = Array.from(README_TEXT).length;
      expect(
        codes(evidenceFor('github', { ...readme, span: { start: 0, end: length + 1 } })),
      ).toEqual(['SPAN_OUT_OF_BOUNDS']);
      expect(
        codes(evidenceFor('github', { ...readme, span: { start: length, end: length + 5 } })),
      ).toEqual(['SPAN_OUT_OF_BOUNDS']);
      expect(codes(evidenceFor('github', { ...readme, span: { start: 5, end: 5 } }))).toEqual([
        'SPAN_INVALID',
      ]);
      expect(codes(evidenceFor('github', { ...readme, span: { start: 6, end: 2 } }))).toEqual([
        'SPAN_INVALID',
      ]);
      expect(codes(evidenceFor('github', { ...readme, span: { start: 0, end: 2_001 } }))).toEqual([
        'SPAN_INVALID',
      ]);
      expect(
        codes(evidenceFor('github', { snapshotId: ID.githubSnapshot, span: { start: 0, end: 3 } })),
      ).toContain('MISSING_PROVENANCE');
      expect(codes(evidenceFor('github', { ...readme, excerpt: 'x' }))).toEqual([
        'UNEXPECTED_PROVENANCE',
      ]);
    });

    it('accepts the final code point of the artifact', () => {
      const length = Array.from(README_TEXT).length;
      expect(
        evidenceFor('github', { ...readme, span: { start: length - 1, end: length } }).ok,
      ).toBe(true);
    });
  });

  it('requires anchors for repo_corroborated, and a source-code artifact at that', () => {
    const corroborated = (provenance: object) =>
      evidenceFor('github', provenance, { verificationLevel: 'repo_corroborated' });
    const span = spanOf(CODE_TEXT, 'cacheTile');
    expect(corroborated({ snapshotId: ID.githubSnapshot, artifactId: ID.sourceFile }).ok).toBe(
      true,
    );
    expect(
      corroborated({ snapshotId: ID.githubSnapshot, artifactId: ID.sourceFile, span }).ok,
    ).toBe(true);
    expect(codes(corroborated({ snapshotId: ID.githubSnapshot }))).toEqual(['MISSING_ANCHOR']);
  });

  it('keeps the anchor rules of machine_verified defined, while producers cannot reach the level', () => {
    const span = spanOf(README_TEXT, 'GET /health');
    const machine = (provenance: object) =>
      evidenceFor('github', provenance, { verificationLevel: 'machine_verified' });
    // Even a fully anchored machine_verified fact is refused: the span proves provenance only.
    expect(codes(machine({ snapshotId: ID.githubSnapshot, artifactId: ID.readme, span }))).toEqual([
      'VERIFICATION_NOT_AVAILABLE',
    ]);
    expect(codes(machine({ snapshotId: ID.githubSnapshot, artifactId: ID.readme }))).toEqual([
      'MISSING_ANCHOR',
      'VERIFICATION_NOT_AVAILABLE',
    ]);
  });

  it('keeps a captured team statement a team claim: capturing text does not verify it', () => {
    const span = spanOf(README_TEXT, 'GET /health');
    const result = plan({
      evidence: [
        {
          ref: 'e',
          kind: 'claim',
          origin: 'devpost',
          verificationLevel: 'machine_verified',
          text: 'Devpost says the API exists.',
          provenance: { snapshotId: ID.devpostSnapshot, artifactId: ID.readme, span },
        },
      ],
    });
    expect(codes(result)).toContain('INVALID_VERIFICATION');
    for (const level of ['repo_corroborated', 'judge_verified', 'live_verified', 'contradicted']) {
      expect(
        codes(
          plan({
            evidence: [
              {
                ref: 'e',
                kind: 'claim',
                origin: 'devpost',
                verificationLevel: level,
                text: 't',
                provenance: { snapshotId: ID.devpostSnapshot },
              },
            ],
          }),
        ),
        level,
      ).toContain('INVALID_VERIFICATION');
    }
  });
});

describe('claim verification needs graph material', () => {
  const codeFact = {
    ref: 'g',
    kind: 'fact',
    origin: 'github',
    verificationLevel: 'repo_corroborated',
    text: 'src/cache.ts defines cacheTile.',
    provenance: {
      snapshotId: ID.githubSnapshot,
      artifactId: ID.sourceFile,
      span: spanOf(CODE_TEXT, 'cacheTile'),
    },
  };

  it('accepts repo_corroborated when a repo_corroborated source-code fact supports the claim', () => {
    const result = plan({
      claims: [{ ref: 'c', text: 'It has a tile cache.', verificationLevel: 'repo_corroborated' }],
      evidence: [codeFact],
      relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'supports' }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects repo_corroborated without support, with only team statements, or with only contradicting evidence', () => {
    expect(
      codes(plan({ claims: [{ ref: 'c', text: 'x', verificationLevel: 'repo_corroborated' }] })),
    ).toEqual(['UNJUSTIFIED_VERIFICATION']);
    expect(
      codes(
        plan({
          claims: [{ ref: 'c', text: 'x', verificationLevel: 'repo_corroborated' }],
          evidence: [devpostStatement],
          relations: [{ claim: { ref: 'c' }, evidence: { ref: 'e1' }, type: 'supports' }],
        }),
      ),
    ).toEqual(['UNJUSTIFIED_VERIFICATION']);
    expect(
      codes(
        plan({
          claims: [{ ref: 'c', text: 'x', verificationLevel: 'repo_corroborated' }],
          evidence: [codeFact],
          relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'contradicts' }],
        }),
      ),
    ).toEqual(['UNJUSTIFIED_VERIFICATION']);
  });

  it('never upgrades a claim because a relation exists: the declared level stands', () => {
    const result = plan({
      claims: [{ ref: 'c', text: 'It has a tile cache.', verificationLevel: 'team_claim' }],
      evidence: [codeFact],
      relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'supports' }],
    });
    if (!result.ok) throw new Error('rejected');
    expect(result.graph.claims[0]?.verificationLevel).toBe('team_claim');
  });

  it('accepts contradicted only with a Contradiction record naming the claim', () => {
    expect(
      codes(plan({ claims: [{ ref: 'c', text: 'x', verificationLevel: 'contradicted' }] })),
    ).toEqual(['UNJUSTIFIED_VERIFICATION']);
    expect(
      plan({
        claims: [{ ref: 'c', text: 'x', verificationLevel: 'contradicted' }],
        evidence: [deploymentFact],
        contradictions: [
          {
            sideA: { type: 'claim', ref: 'c' },
            sideB: { type: 'evidence', ref: 'e2' },
            description: 'Differs.',
          },
        ],
      }).ok,
    ).toBe(true);
  });
});

describe('M3 producer trust boundary: machine_verified and judge/live levels are unreachable', () => {
  const evidenceAt = (
    level: string,
    origin: string,
    provenance: object,
    kind = 'fact',
    ref = 'e',
  ) => ({ ref, kind, origin, verificationLevel: level, text: 'Observed.', provenance });
  const readmeSpan = {
    snapshotId: ID.githubSnapshot,
    artifactId: ID.readme,
    span: spanOf(README_TEXT, 'GET /health'),
  };
  const codeSpan = {
    snapshotId: ID.githubSnapshot,
    artifactId: ID.sourceFile,
    span: spanOf(CODE_TEXT, 'cacheTile'),
  };

  it('1. refuses a GitHub README fact at machine_verified', () => {
    expect(
      codes(plan({ evidence: [evidenceAt('machine_verified', 'github', readmeSpan)] })),
    ).toEqual(['VERIFICATION_NOT_AVAILABLE']);
  });

  it('2. refuses a GitHub source-code fact at machine_verified, however well anchored', () => {
    expect(codes(plan({ evidence: [evidenceAt('machine_verified', 'github', codeSpan)] }))).toEqual(
      ['VERIFICATION_NOT_AVAILABLE'],
    );
  });

  it('3. refuses deployment evidence at machine_verified', () => {
    const deployment = {
      snapshotId: ID.deploymentSnapshot,
      artifactId: ID.deploymentBody,
      span: spanOf('{"status":"ok"}', '"status":"ok"'),
    };
    expect(
      codes(plan({ evidence: [evidenceAt('machine_verified', 'deployment', deployment)] })),
    ).toEqual(['VERIFICATION_NOT_AVAILABLE']);
  });

  it('4. refuses a machine_verified claim even when apparently qualifying evidence supports it', () => {
    // The old rule accepted: machine_verified GitHub fact + supports + machine_verified claim.
    const result = plan({
      claims: [{ ref: 'c', text: 'The cache works.', verificationLevel: 'machine_verified' }],
      evidence: [evidenceAt('repo_corroborated', 'github', codeSpan, 'fact', 'g')],
      relations: [{ claim: { ref: 'c' }, evidence: { ref: 'g' }, type: 'supports' }],
    });
    expect(issuesAt(result, 'claims[0].verificationLevel')).toEqual(['VERIFICATION_NOT_AVAILABLE']);
    expect(result.ok).toBe(false);
  });

  it('5-6. refuses judge_verified and live_verified claims', () => {
    for (const level of ['judge_verified', 'live_verified']) {
      const result = plan({ claims: [{ ref: 'c', text: 'x', verificationLevel: level }] });
      expect(issuesAt(result, 'claims[0].verificationLevel'), level).toEqual([
        'VERIFICATION_NOT_AVAILABLE',
      ]);
    }
  });

  it('7. refuses a GitHub README (prose) fact at repo_corroborated', () => {
    expect(
      codes(plan({ evidence: [evidenceAt('repo_corroborated', 'github', readmeSpan)] })),
    ).toEqual(['ARTIFACT_NOT_CORROBORATING']);
  });

  it('7b. refuses repo_corroborated from documentation, example code in docs/, and metadata artifacts', () => {
    const docs = { snapshotId: ID.githubSnapshot, artifactId: ID.docsFile };
    const tree = { snapshotId: ID.githubSnapshot, artifactId: ID.treeArtifact };
    for (const provenance of [docs, tree]) {
      expect(
        codes(plan({ evidence: [evidenceAt('repo_corroborated', 'github', provenance)] })),
      ).toEqual(['ARTIFACT_NOT_CORROBORATING']);
    }
  });

  it('8. accepts GitHub README / team-authored prose as a team claim', () => {
    expect(plan({ evidence: [evidenceAt('team_claim', 'github', readmeSpan, 'claim')] }).ok).toBe(
      true,
    );
    expect(plan({ evidence: [evidenceAt('unverified', 'github', readmeSpan)] }).ok).toBe(true);
  });

  it('9. accepts a GitHub source-code fact at repo_corroborated with valid provenance', () => {
    const result = plan({ evidence: [evidenceAt('repo_corroborated', 'github', codeSpan)] });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.graph.evidence[0]?.provenance.excerpt).toBe('cacheTile');
  });

  it('10. keeps Devpost and video team text capped at team_claim', () => {
    const devpost = { snapshotId: ID.devpostSnapshot };
    const video = { snapshotId: ID.videoSnapshot };
    for (const [origin, provenance] of [
      ['devpost', devpost],
      ['video', video],
    ] as const) {
      expect(plan({ evidence: [evidenceAt('team_claim', origin, provenance, 'claim')] }).ok).toBe(
        true,
      );
      for (const level of [
        'repo_corroborated',
        'machine_verified',
        'judge_verified',
        'live_verified',
      ]) {
        const result = plan({ evidence: [evidenceAt(level, origin, provenance, 'claim')] });
        expect(result.ok, `${origin} ${level}`).toBe(false);
      }
    }
  });

  it('11. keeps contradicted reachable, but only with its Contradiction', () => {
    expect(
      codes(plan({ claims: [{ ref: 'c', text: 'x', verificationLevel: 'contradicted' }] })),
    ).toEqual(['UNJUSTIFIED_VERIFICATION']);
    expect(
      plan({
        claims: [{ ref: 'c', text: 'x', verificationLevel: 'contradicted' }],
        evidence: [evidenceAt('unverified', 'deployment', { snapshotId: ID.deploymentSnapshot })],
        contradictions: [
          {
            sideA: { type: 'claim', ref: 'c' },
            sideB: { type: 'evidence', ref: 'e' },
            description: 'Differs.',
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it('keeps every level in the vocabulary and the transition matrix for later milestones', () => {
    // Only the producer path is closed; the pure integrity rules still understand every level.
    expect(isVerificationLevelAvailableToProducers('machine_verified')).toBe(false);
    expect([...M3_PRODUCER_VERIFICATION_LEVELS]).toEqual([
      'unverified',
      'team_claim',
      'repo_corroborated',
      'contradicted',
    ]);
    expect(VERIFICATION_LEVEL_VALUES).toContain('machine_verified');
    expect(VERIFICATION_LEVEL_VALUES).toContain('judge_verified');
    expect(VERIFICATION_LEVEL_VALUES).toContain('live_verified');
  });
});

describe('relations', () => {
  it('records supports and contradicts between real, same-project entities', () => {
    const result = plan({
      claims: [teamClaim],
      relations: [
        { claim: { ref: 'c1' }, evidence: { id: ID.existingEvidence }, type: 'supports' },
        {
          claim: { id: ID.existingClaim },
          evidence: { id: ID.existingEvidence },
          type: 'contradicts',
        },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.graph.relations.map((r) => r.type)).toEqual(['supports', 'contradicts']);
  });

  it('rejects duplicate and conflicting relations, within the batch and against stored ones', () => {
    const duplicate = plan({
      claims: [teamClaim],
      evidence: [devpostStatement],
      relations: [
        { claim: { ref: 'c1' }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { ref: 'e1' }, type: 'contradicts' },
      ],
    });
    expect(issuesAt(duplicate, 'relations[1]')).toEqual(['DUPLICATE_RELATION']);
    expect(issuesAt(duplicate, 'relations[2]')).toEqual(['CONFLICTING_RELATION']);

    const stored = knownWorld({
      relationPairs: new Map([[`${ID.existingClaim}:${ID.existingEvidence}`, 'supports']]),
    });
    expect(
      codes(
        plan(
          {
            relations: [
              {
                claim: { id: ID.existingClaim },
                evidence: { id: ID.existingEvidence },
                type: 'supports',
              },
            ],
          },
          stored,
        ),
      ),
    ).toEqual(['DUPLICATE_RELATION']);
    expect(
      codes(
        plan(
          {
            relations: [
              {
                claim: { id: ID.existingClaim },
                evidence: { id: ID.existingEvidence },
                type: 'contradicts',
              },
            ],
          },
          stored,
        ),
      ),
    ).toEqual(['CONFLICTING_RELATION']);
  });

  it('refuses absence and unknown evidence as support or contradiction (missing is not negative)', () => {
    for (const type of ['supports', 'contradicts']) {
      expect(
        codes(
          plan({
            relations: [
              { claim: { id: ID.existingClaim }, evidence: { id: ID.absenceEvidence }, type },
            ],
          }),
        ),
        type,
      ).toEqual(['RELATION_KIND_NOT_ALLOWED']);
    }
    expect(
      codes(
        plan({
          claims: [teamClaim],
          evidence: [
            {
              ref: 'u',
              kind: 'unknown',
              origin: 'github',
              verificationLevel: 'unverified',
              text: 'Could not tell.',
              provenance: { snapshotId: ID.githubSnapshot },
            },
          ],
          relations: [{ claim: { ref: 'c1' }, evidence: { ref: 'u' }, type: 'contradicts' }],
        }),
      ),
    ).toEqual(['RELATION_KIND_NOT_ALLOWED']);
  });
});

describe('absence, unknown and contradiction stay distinct', () => {
  it('lets an Unknown cite absence evidence, but never treats it as a contradiction or support', () => {
    const result = plan({
      claims: [teamClaim],
      evidence: [
        {
          ref: 'a',
          kind: 'absence',
          origin: 'github',
          verificationLevel: 'unverified',
          text: 'No LICENSE file found in the tree.',
          provenance: { snapshotId: ID.githubSnapshot },
        },
      ],
      unknowns: [
        {
          unknownType: 'missing',
          text: 'Licensing is not established.',
          claims: [{ ref: 'c1' }],
          evidence: [{ ref: 'a' }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(
      codes(
        plan({
          claims: [teamClaim],
          evidence: [
            {
              ref: 'a',
              kind: 'absence',
              origin: 'github',
              verificationLevel: 'unverified',
              text: 'No LICENSE file.',
              provenance: { snapshotId: ID.githubSnapshot },
            },
          ],
          contradictions: [
            {
              sideA: { type: 'claim', ref: 'c1' },
              sideB: { type: 'evidence', ref: 'a' },
              description: 'x',
            },
          ],
        }),
      ),
    ).toEqual(['CONTRADICTION_KIND_NOT_ALLOWED']);
  });

  it('accepts every Unknown type', () => {
    const types = [
      'missing',
      'ambiguous',
      'contradictory',
      'unverifiable',
      'subjective',
      'eligibility',
    ];
    const result = plan({
      unknowns: types.map((unknownType) => ({ unknownType, text: `An ${unknownType} gap.` })),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.graph.unknowns.map((u) => u.unknownType)).toEqual(types);
  });
});

describe('contradictions', () => {
  it('needs two distinct, real sides in the same project', () => {
    expect(
      codes(
        plan({
          claims: [teamClaim],
          contradictions: [
            {
              sideA: { type: 'claim', ref: 'c1' },
              sideB: { type: 'claim', ref: 'c1' },
              description: 'x',
            },
          ],
        }),
      ),
    ).toEqual(['CONTRADICTION_SAME_SIDE']);
    expect(
      codes(
        plan({
          claims: [teamClaim],
          contradictions: [
            {
              sideA: { type: 'claim', ref: 'c1' },
              sideB: { type: 'evidence', id: ID.nothing },
              description: 'x',
            },
          ],
        }),
      ),
    ).toEqual(['EVIDENCE_NOT_FOUND']);
  });

  it('treats (A, B) and (B, A) as one pair, in the batch and against stored pairs', () => {
    const pair = (a: string, b: string) => ({
      sideA: { type: 'claim', id: a },
      sideB: { type: 'claim', id: b },
      description: 'x',
    });
    const result = plan({
      claims: [teamClaim, { ref: 'c2', text: 'y', verificationLevel: 'unverified' }],
      contradictions: [
        {
          sideA: { type: 'claim', ref: 'c1' },
          sideB: { type: 'claim', ref: 'c2' },
          description: 'x',
        },
        {
          sideA: { type: 'claim', ref: 'c2' },
          sideB: { type: 'claim', ref: 'c1' },
          description: 'x',
        },
      ],
    });
    expect(issuesAt(result, 'contradictions[1]')).toEqual(['DUPLICATE_CONTRADICTION']);
    const stored = knownWorld({
      contradictionPairs: new Set([`claim:${ID.existingClaim}|claim:${ID.supersededClaim}`]),
    });
    expect(
      codes(plan({ contradictions: [pair(ID.supersededClaim, ID.existingClaim)] }, stored)),
    ).toEqual(['DUPLICATE_CONTRADICTION']);
    expect(
      codes(plan({ contradictions: [pair(ID.existingClaim, ID.supersededClaim)] }, stored)),
    ).toEqual(['DUPLICATE_CONTRADICTION']);
  });

  it('is data for a judge: no scoring, accusation or deduction exists on a planned contradiction', () => {
    const result = plan({
      claims: [teamClaim],
      evidence: [deploymentFact],
      contradictions: [
        {
          sideA: { type: 'claim', ref: 'c1' },
          sideB: { type: 'evidence', ref: 'e2' },
          description: 'The README and the deployment differ.',
        },
      ],
    });
    if (!result.ok) throw new Error('rejected');
    expect(Object.keys(result.graph.contradictions[0] ?? {}).sort()).toEqual([
      'description',
      'id',
      'projectId',
      'sideA',
      'sideB',
    ]);
  });
});

describe('per-project limits', () => {
  it('rejects a batch that would exceed a per-project cap', () => {
    const full = knownWorld({
      totals: { claims: 2_000, evidence: 0, relations: 0, unknowns: 0, contradictions: 0 },
    });
    expect(codes(plan({ claims: [teamClaim] }, full))).toEqual(['PROJECT_LIMIT_EXCEEDED']);
  });
});
