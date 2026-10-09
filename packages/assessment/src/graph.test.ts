import {
  isEvidenceVerificationAllowed,
  buildEvidenceGraph,
  validateGraphIntegrity,
} from '@judge-copilot/evidence';
import { EvidenceGraphBatchInput } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { EMITTABLE_LEVELS } from './label-policy.js';
import type { ExtractionRecords } from './graph.js';
import {
  assembleContextBatch,
  assembleExtractionBatch,
  buildPlanContext,
  dryRunPlan,
  membersHash,
  membersOf,
  recordsFromPlan,
  scopeGraph,
  verifyClosure,
} from './graph.js';
import { buildStatementItems } from './statements.js';
import { sourceGapUnknowns } from './source-gaps.js';
import { buildEventReferenceItems } from './event-evidence.js';
import { validateRelationMatching } from './stage.js';
import { extract, DEVPOST_REMINDER } from './testing/pipeline.js';
import {
  EVENT_ID,
  hydroTrackArtifacts,
  lockedSnapshot,
  planWorld,
  PROJECT_ID,
  seeded,
  uid,
  VERSION_ID,
} from './testing/world.js';

const ex = extract();
const world = planWorld(ex.artifacts);

function recordsOf(extracted = ex): ExtractionRecords {
  return {
    claims: extracted.claims,
    statementItems: extracted.statements,
    evidence: extracted.evidence,
    relations: [],
    contradictions: [],
    unknowns: [],
  };
}
function planned(extracted = ex, extra: Partial<ExtractionRecords> = {}) {
  const assembled = assembleExtractionBatch({ ...recordsOf(extracted), ...extra });
  const result = dryRunPlan(assembled.batch, planWorld(extracted.artifacts));
  if (!result.ok) throw new Error(`plan rejected: ${JSON.stringify(result.issues)}`);
  return { assembled, graph: result.graph };
}

describe('citable team statements (design §4.2)', () => {
  it('builds ONE verbatim statement item per distinct (artifact, span) and relates claims to it', () => {
    expect(ex.statements.map((s) => [s.handle, s.claimHandles, s.text])).toEqual([
      ['E-003', ['C-001'], DEVPOST_REMINDER],
      ['E-004', ['C-002'], 'It works offline and never sends your data to a server.'],
    ]);
  });

  it('two claims quoting the same words share one statement item', () => {
    const [claim] = ex.claims;
    if (!claim) throw new Error('fixture');
    const twin = { ...claim, handle: 'C-009', text: 'The app reminds users every two hours.' };
    const result = buildStatementItems([claim, twin], []);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.claimHandles).toEqual(['C-001', 'C-009']);
  });

  it('builds the statement item from the verbatim quote, never from a (reviewed) paraphrase', () => {
    const [claim] = ex.claims;
    if (!claim) throw new Error('fixture');
    const paraphrased = {
      ...claim,
      text: 'Reminders arrive every two hours.',
      grounding: 'paraphrase_reviewed_faithful' as const,
    };
    const [item] = buildStatementItems([paraphrased], []).items;
    expect(item?.text).toBe(DEVPOST_REMINDER);
    expect(item?.text).not.toBe(paraphrased.text);
    expect(item?.located.excerpt).toBe(DEVPOST_REMINDER);
  });

  it('keeps the paraphrase in the claim and the verbatim words in the evidence', () => {
    const [claim] = ex.claims;
    if (!claim) throw new Error('fixture');
    const paraphrased = {
      ...claim,
      text: 'Reminders arrive every two hours.',
      grounding: 'paraphrase_reviewed_faithful' as const,
    };
    const { assembled, graph } = planned({ ...ex, claims: [paraphrased, ...ex.claims.slice(1)] });
    expect(graph.claims[0]?.text).toBe('Reminders arrive every two hours.');
    const statement = graph.evidence.find((e) => e.kind === 'claim');
    expect(statement?.text).toBe(DEVPOST_REMINDER);
    expect(statement?.provenance.excerpt).toBe(DEVPOST_REMINDER);
    expect(assembled.relationBasis.filter((r) => r.basis === 'source_statement')).toHaveLength(2);
  });

  it('refuses to plan a claim that has no statement item (a claim must always be citable)', () => {
    expect(() =>
      assembleExtractionBatch({ ...recordsOf(), statementItems: ex.statements.slice(1) }),
    ).toThrow(/without a statement item/);
  });

  it('plans claim + statement evidence + supports relation for each admitted claim, with derived provenance', () => {
    const { graph, assembled } = planned();
    expect(graph.claims).toHaveLength(2);
    const statements = graph.evidence.filter((e) => e.kind === 'claim');
    expect(statements).toHaveLength(2);
    for (const item of statements) {
      expect(item.origin).toBe('devpost');
      expect(item.verificationLevel).toBe('team_claim');
      expect(item.provenance.snapshotId).not.toBeNull();
      expect(item.provenance.span).not.toBeNull();
      expect(item.text).toBe(item.provenance.excerpt);
    }
    const supports = graph.relations.filter((r) => r.type === 'supports');
    expect(supports).toHaveLength(2);
    for (const relation of supports) {
      const target = graph.evidence.find((e) => e.id === relation.evidenceId);
      expect(target?.kind).toBe('claim');
    }
    expect(assembled.relationBasis.every((r) => r.basis === 'source_statement')).toBe(true);
  });

  it('works for a Devpost-only project: claims and statement evidence, nothing else', () => {
    // only the Devpost artifact exists: no code, no deployment, so no interpreted evidence at all
    const devpostOnly = extract(hydroTrackArtifacts().slice(0, 1));
    expect(devpostOnly.evidence).toEqual([]);
    const { graph } = planned(devpostOnly);
    expect(graph.evidence.every((e) => e.kind === 'claim' && e.origin === 'devpost')).toBe(true);
    expect(graph.claims.length).toBeGreaterThan(0);
    expect(graph.relations.every((r) => r.type === 'supports')).toBe(true);
  });

  it('a team assertion that is NOT in the source never becomes a claim or evidence', () => {
    // G1 rejects the quote; nothing about it reaches the batch (see extraction.test.ts for the gate). Here the batch is built only
    // from admitted records, so the assertion's words cannot appear anywhere in the planned graph.
    const { graph } = planned();
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain('team of ten');
  });
});

describe('graph batch assembly and the M3 dry run', () => {
  it('uses batch-local refs only (no existing ids, no supersession), so the member set is closed by construction', () => {
    const { assembled } = planned();
    const text = JSON.stringify(assembled.batch);
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('supersedes');
    const parsed = EvidenceGraphBatchInput.parse(assembled.batch);
    expect(parsed.claims.every((c) => /^c-\d+$/.test(c.ref))).toBe(true);
  });

  it('emits only labels from the policy, and every (origin, kind, level) is allowed by M3 (seeded property)', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = seeded(seed);
      const claims = ex.claims.filter(() => next() > 0.2);
      const evidence = ex.evidence.filter(() => next() > 0.3);
      const extracted = {
        ...ex,
        claims,
        evidence,
        statements: buildStatementItems(claims, evidence).items,
      };
      if (claims.length + evidence.length === 0) continue;
      const { graph } = planned(extracted);
      for (const item of graph.evidence) {
        expect(EMITTABLE_LEVELS).toContain(item.verificationLevel);
        expect(isEvidenceVerificationAllowed(item.origin, item.kind, item.verificationLevel)).toBe(
          true,
        );
      }
      for (const claim of graph.claims) expect(claim.verificationLevel).toBe('team_claim');
    }
  });

  it('never assigns repo_corroborated, machine_verified, judge_verified, live_verified or contradicted', () => {
    const { graph } = planned();
    const levels = new Set([
      ...graph.claims.map((c) => c.verificationLevel),
      ...graph.evidence.map((e) => e.verificationLevel),
    ]);
    for (const forbidden of [
      'repo_corroborated',
      'machine_verified',
      'judge_verified',
      'live_verified',
      'contradicted',
    ]) {
      expect(levels.has(forbidden as never)).toBe(false);
    }
  });

  it('interpreted code facts are unverified, even if a reviewer said faithful (a label never depends on review)', () => {
    const { graph } = planned();
    const facts = graph.evidence.filter((e) => e.kind === 'fact');
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.verificationLevel === 'unverified' && f.origin === 'github')).toBe(
      true,
    );
  });

  it('the planner (not this package) rejects tampered provenance: a shifted span fails the excerpt check', () => {
    const { assembled } = planned();
    const evidence = assembled.batch.evidence ?? [];
    const first = evidence[0];
    if (!first?.provenance?.span) throw new Error('fixture');
    const shifted = {
      ...assembled.batch,
      evidence: [
        {
          ...first,
          provenance: {
            ...first.provenance,
            span: { start: first.provenance.span.start + 3, end: first.provenance.span.end + 3 },
          },
        },
        ...evidence.slice(1),
      ],
    };
    const result = dryRunPlan(shifted, world);
    expect(result.ok).toBe(false);
  });

  it('fabricated provenance (a snapshot of another project, a missing artifact) is refused by the dry run', () => {
    const { assembled } = planned();
    const evidence = assembled.batch.evidence ?? [];
    const first = evidence[0];
    if (!first?.provenance) throw new Error('fixture');
    for (const provenance of [
      { ...first.provenance, snapshotId: 'aaaaaaaa-0000-4000-8000-00000000dead' },
      { ...first.provenance, artifactId: 'bbbbbbbb-0000-4000-8000-00000000dead' },
    ]) {
      const result = dryRunPlan(
        { ...assembled.batch, evidence: [{ ...first, provenance }, ...evidence.slice(1)] },
        world,
      );
      expect(result.ok, JSON.stringify(provenance)).toBe(false);
    }
  });

  it('dry-runs the Event-Context reference set separately, with version-level provenance only', () => {
    const locked = lockedSnapshot({
      trackKeys: ['health'],
      rules: [{ statement: 'Projects must be original work.', certainty: 'explicit' }],
    });
    const reference = buildEventReferenceItems(locked, ['health']);
    const batch = assembleContextBatch(reference.items, locked.versionId);
    const result = dryRunPlan(
      batch,
      planWorld([], { contextVersion: { id: VERSION_ID, version: 1, status: 'locked' } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.graph.evidence.every(
          (e) =>
            e.origin === 'event_context' &&
            e.verificationLevel === 'unverified' &&
            e.kind === 'fact',
        ),
      ).toBe(true);
      expect(
        result.graph.evidence.every(
          (e) => e.provenance.contextVersionId === VERSION_ID && e.provenance.span === null,
        ),
      ).toBe(true);
    }
  });

  it('plans code-authored missing unknowns with no references', () => {
    const unknowns = sourceGapUnknowns([
      { sourceType: 'github', status: 'failed' },
      { sourceType: 'video', status: 'absent' },
      { sourceType: 'devpost', status: 'captured' },
    ]);
    expect(unknowns.map((u) => u.gapKey)).toEqual(['github:failed', 'video:absent']);
    const { graph } = planned(ex, { unknowns });
    expect(
      graph.unknowns.map((u) => [u.unknownType, u.claimIds.length, u.evidenceIds.length]),
    ).toEqual([
      ['missing', 0, 0],
      ['missing', 0, 0],
    ]);
    expect(unknowns.every((u) => !/[0-9a-f]{8}-/.test(u.text))).toBe(true);
  });
});

describe('membership, closure and the scoped graph (design §8.7)', () => {
  const { graph } = planned(ex, {
    relations: (() => {
      const result = validateRelationMatching(
        { relations: [{ claim: 'C-001', evidence: 'E-001', type: 'supports' }] },
        ex.relationWorld,
      );
      return result.ok ? [...result.accepted] : [];
    })(),
  });
  const scope = { projectId: PROJECT_ID, eventId: EVENT_ID };

  it('lists every planned id exactly once, sorted, and hashes them canonically', () => {
    const members = membersOf(graph);
    expect(members.claimIds).toEqual([...members.claimIds].sort());
    expect(members.claimIds).toHaveLength(graph.claims.length);
    expect(membersHash(members)).toBe(
      membersHash({ ...members, claimIds: [...members.claimIds].reverse() }),
    );
    expect(membersHash(members)).not.toBe(
      membersHash({ ...members, claimIds: members.claimIds.slice(1) }),
    );
  });

  it('a planned graph is closed under relation endpoints, contradiction sides and unknown references', () => {
    expect(verifyClosure(graph)).toEqual([]);
    const broken = {
      ...graph,
      relations: [
        ...graph.relations,
        {
          id: uid(99),
          projectId: PROJECT_ID,
          claimId: uid(98),
          evidenceId: graph.evidence[0]?.id ?? '',
          type: 'supports' as const,
        },
      ],
    };
    expect(verifyClosure(broken).map((i) => i.code)).toEqual(['relation_claim_outside_members']);
    const withSupersession = {
      ...graph,
      claims: graph.claims.map((c, i) => (i === 0 ? { ...c, supersedesId: uid(7) } : c)),
    };
    expect(verifyClosure(withSupersession).map((i) => i.code)).toContain('member_has_supersession');
  });

  it('detects an escape through each kind of reference: contradiction sides and unknown references', () => {
    const rich = planned(ex, {
      contradictions: [
        {
          sideA: { type: 'claim', handle: 'C-002' },
          sideB: { type: 'evidence', handle: 'E-001' },
          description: 'The README says offline, but the handler writes to a database.',
        },
      ],
      unknowns: [
        {
          unknownType: 'unverifiable',
          text: 'Whether reminders fire on time cannot be checked.',
          claims: ['C-001'],
          evidence: ['E-001'],
        },
      ],
    }).graph;
    expect(verifyClosure(rich)).toEqual([]);
    const stray = uid(321);
    const sideBroken = {
      ...rich,
      contradictions: rich.contradictions.map((c) => ({
        ...c,
        sideB: { type: 'evidence' as const, id: stray },
      })),
    };
    expect(verifyClosure(sideBroken).map((i) => i.code)).toEqual([
      'contradiction_side_outside_members',
    ]);
    const claimBroken = {
      ...rich,
      unknowns: rich.unknowns.map((u) => ({ ...u, claimIds: [...u.claimIds, stray] })),
    };
    expect(verifyClosure(claimBroken).map((i) => i.code)).toEqual([
      'unknown_claim_outside_members',
    ]);
    const evidenceBroken = {
      ...rich,
      unknowns: rich.unknowns.map((u) => ({ ...u, evidenceIds: [...u.evidenceIds, stray] })),
    };
    expect(verifyClosure(evidenceBroken).map((i) => i.code)).toEqual([
      'unknown_evidence_outside_members',
    ]);
    const evidenceEndpoint = {
      ...rich,
      relations: rich.relations.map((r, i) => (i === 0 ? { ...r, evidenceId: stray } : r)),
    };
    expect(verifyClosure(evidenceEndpoint).map((i) => i.code)).toEqual([
      'relation_evidence_outside_members',
    ]);
  });

  it('scopes to the members: foreign records, even ones that reference a member, cannot enter (metamorphic)', () => {
    const own = recordsFromPlan(graph, scope);
    const other = planned(extract(), {}).graph; // a second, unrelated extraction of the same project (different ids)
    const otherRecords = recordsFromPlan(other, scope);
    // a foreign relation that REFERENCES a member claim and a member evidence item
    const foreignRelation = {
      ...(otherRecords.relations[0] ??
        (() => {
          throw new Error('fixture');
        })()),
      id: uid(500),
      claimId: own.claims[0]?.id ?? '',
      evidenceId: own.evidence[0]?.id ?? '',
      seq: 9_000,
    };
    const all = {
      claims: [...own.claims, ...otherRecords.claims.map((c) => ({ ...c, seq: c.seq + 1_000 }))],
      evidence: [
        ...own.evidence,
        ...otherRecords.evidence.map((e) => ({ ...e, seq: e.seq + 1_000 })),
      ],
      relations: [
        ...own.relations,
        ...otherRecords.relations.map((r) => ({ ...r, seq: r.seq + 1_000 })),
        foreignRelation,
      ],
      unknowns: [...own.unknowns, ...otherRecords.unknowns],
      contradictions: [...own.contradictions, ...otherRecords.contradictions],
    };
    const members = membersOf(graph);
    const known = buildPlanContext(world);
    const scoped = scopeGraph(all, members, { known, expectedMembersHash: membersHash(members) });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      expect(scoped.records.claims.map((c) => c.id).sort()).toEqual([...members.claimIds]);
      expect(scoped.records.relations.map((r) => r.id)).not.toContain(foreignRelation.id);
      const alone = scopeGraph(own, members, { known });
      expect(alone.ok && alone.membersHash).toBe(scoped.membersHash);
      expect(JSON.stringify(scoped.records)).toBe(JSON.stringify(alone.ok ? alone.records : null));
    }
  });

  it('fails closed on a missing member, a duplicated member id, a hash mismatch and an out-of-scope endpoint', () => {
    const own = recordsFromPlan(graph, scope);
    const members = membersOf(graph);
    const withoutClaim = { ...own, claims: own.claims.slice(1) };
    expect(scopeGraph(withoutClaim, members).ok).toBe(false);
    const dup = { ...members, claimIds: [...members.claimIds, members.claimIds[0] ?? ''] };
    const dupResult = scopeGraph(own, dup);
    expect(!dupResult.ok && dupResult.issues.map((i) => i.code)).toContain('member_ids_not_unique');
    const wrongHash = scopeGraph(own, members, { expectedMembersHash: 'f'.repeat(64) });
    expect(!wrongHash.ok && wrongHash.issues.map((i) => i.code)).toContain('members_hash_mismatch');
    // a member relation whose evidence endpoint is NOT a member: the member list omits that evidence item
    const endpoint = graph.relations[0]?.evidenceId ?? '';
    const trimmed = {
      ...members,
      evidenceIds: members.evidenceIds.filter((id) => id !== endpoint),
    };
    const open = scopeGraph(own, trimmed);
    expect(!open.ok && open.issues.map((i) => i.code)).toContain(
      'relation_evidence_outside_members',
    );
  });

  it('the scoped records pass M3 integrity (label-only findings are not fatal)', () => {
    const own = recordsFromPlan(graph, scope);
    const known = buildPlanContext(world);
    const findings = validateGraphIntegrity(buildEvidenceGraph(own), known);
    expect(
      findings.filter(
        (f) =>
          ![
            'UNJUSTIFIED_VERIFICATION',
            'ARTIFACT_NOT_CORROBORATING',
            'INVALID_VERIFICATION_TRANSITION',
          ].includes(f.code),
      ),
    ).toEqual([]);
  });
});
