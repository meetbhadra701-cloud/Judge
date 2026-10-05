import type { ClaimRecord } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { buildEvidenceGraph, type EvidenceGraphRecords } from './graph.js';
import { validateGraphIntegrity } from './integrity.js';
import type { GraphIssueCode } from './issues.js';
import {
  ID,
  README_TEXT,
  claimRecord,
  contradictionRecord,
  evidenceRecord,
  knownWorld,
  relationRecord,
  spanOf,
  unknownRecord,
} from './testing/builders.js';

const C1 = 'd1000000-0000-4000-8000-000000000001';
const C2 = 'd1000000-0000-4000-8000-000000000002';
const C3 = 'd1000000-0000-4000-8000-000000000003';
const E1 = 'e1000000-0000-4000-8000-000000000001';
const E2 = 'e1000000-0000-4000-8000-000000000002';
const R1 = 'f1000000-0000-4000-8000-000000000001';
const U1 = 'f2000000-0000-4000-8000-000000000001';
const X1 = 'f3000000-0000-4000-8000-000000000001';

function graph(records: Partial<EvidenceGraphRecords>) {
  return buildEvidenceGraph({
    claims: [],
    evidence: [],
    relations: [],
    unknowns: [],
    contradictions: [],
    ...records,
  });
}

function codes(records: Partial<EvidenceGraphRecords>, known = knownWorld()): GraphIssueCode[] {
  return validateGraphIntegrity(graph(records), known).map((issue) => issue.code);
}

describe('validateGraphIntegrity', () => {
  it('accepts a valid graph', () => {
    expect(
      codes({
        claims: [claimRecord(C1), claimRecord(C2, { seq: 2, supersedesId: C1 })],
        evidence: [
          evidenceRecord(E1),
          evidenceRecord(E2, {
            seq: 2,
            kind: 'fact',
            origin: 'deployment',
            verificationLevel: 'unverified',
            provenance: { snapshotId: ID.deploymentSnapshot },
          }),
        ],
        relations: [relationRecord(R1, C2, E1)],
        unknowns: [unknownRecord(U1, { claimIds: [C2], evidenceIds: [E2] })],
        contradictions: [
          contradictionRecord(X1, { type: 'claim', id: C2 }, { type: 'evidence', id: E2 }),
        ],
      }),
    ).toEqual([]);
  });

  it('finds dangling references everywhere', () => {
    const issues = validateGraphIntegrity(
      graph({
        claims: [claimRecord(C1, { supersedesId: ID.nothing })],
        relations: [relationRecord(R1, ID.nothing, ID.nothing)],
        unknowns: [unknownRecord(U1, { claimIds: [ID.nothing], evidenceIds: [ID.nothing] })],
        contradictions: [
          contradictionRecord(
            X1,
            { type: 'claim', id: ID.nothing },
            { type: 'evidence', id: ID.nothing },
          ),
        ],
      }),
      knownWorld(),
    );
    expect(
      issues.filter((issue) => issue.code === 'DANGLING_REFERENCE').map((issue) => issue.path),
    ).toEqual([
      `claim:${C1}`,
      `contradiction:${X1}`,
      `contradiction:${X1}`,
      `relation:${R1}`,
      `relation:${R1}`,
      `unknown:${U1}`,
      `unknown:${U1}`,
    ]);
  });

  it('finds cross-project edges in every kind of record', () => {
    const result = codes({
      claims: [claimRecord(C1), claimRecord(C2, { projectId: ID.otherProject, supersedesId: C1 })],
      evidence: [evidenceRecord(E1), evidenceRecord(E2, { projectId: ID.otherProject })],
      relations: [relationRecord(R1, C1, E2)],
      unknowns: [unknownRecord(U1, { claimIds: [C2] })],
      contradictions: [
        contradictionRecord(X1, { type: 'claim', id: C1 }, { type: 'evidence', id: E2 }),
      ],
    });
    expect(
      result.filter((code) => code === 'CROSS_PROJECT_REFERENCE').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('detects supersession problems: self, cycle, branching, dropped verification', () => {
    expect(codes({ claims: [claimRecord(C1, { supersedesId: C1 })] })).toContain(
      'SUPERSESSION_CYCLE',
    );
    const cycle = codes({
      claims: [
        claimRecord(C1, { supersedesId: C2 }),
        claimRecord(C2, { seq: 2, supersedesId: C1 }),
      ],
    });
    expect(cycle).toContain('SUPERSESSION_CYCLE');
    expect(
      codes({
        claims: [
          claimRecord(C1),
          claimRecord(C2, { seq: 2, supersedesId: C1 }),
          claimRecord(C3, { seq: 3, supersedesId: C1 }),
        ],
      }),
    ).toContain('CLAIM_ALREADY_SUPERSEDED');
    expect(
      codes({
        claims: [
          claimRecord(C1, { verificationLevel: 'live_verified' }),
          claimRecord(C2, { seq: 2, supersedesId: C1, verificationLevel: 'team_claim' }),
        ],
      }),
    ).toContain('INVALID_VERIFICATION_TRANSITION');
  });

  it('flags unjustified claim levels but accepts justified ones', () => {
    expect(codes({ claims: [claimRecord(C1, { verificationLevel: 'machine_verified' })] })).toEqual(
      ['UNJUSTIFIED_VERIFICATION'],
    );
    const span = spanOf(README_TEXT, 'GET /health');
    expect(
      codes({
        claims: [claimRecord(C1, { verificationLevel: 'machine_verified' })],
        evidence: [
          evidenceRecord(E1, {
            kind: 'fact',
            origin: 'github',
            verificationLevel: 'machine_verified',
            provenance: {
              snapshotId: ID.githubSnapshot,
              artifactId: ID.readme,
              span: { ...span, unit: 'code_points' },
              excerpt: 'GET /health',
            },
          }),
        ],
        relations: [relationRecord(R1, C1, E1)],
      }),
    ).toEqual([]);
  });

  it('flags repo_corroborated evidence anchored in prose or metadata, but accepts source code', () => {
    const corroborated = (artifactId: string) =>
      evidenceRecord(E1, {
        kind: 'fact',
        origin: 'github',
        verificationLevel: 'repo_corroborated',
        provenance: { snapshotId: ID.githubSnapshot, artifactId },
      });
    expect(codes({ evidence: [corroborated(ID.readme)] })).toEqual(['ARTIFACT_NOT_CORROBORATING']);
    expect(codes({ evidence: [corroborated(ID.treeArtifact)] })).toEqual([
      'ARTIFACT_NOT_CORROBORATING',
    ]);
    expect(codes({ evidence: [corroborated(ID.sourceFile)] })).toEqual([]);
  });

  it('flags relation rule violations: kind, duplicates and conflicts', () => {
    const absence = evidenceRecord(E1, {
      kind: 'absence',
      origin: 'github',
      verificationLevel: 'unverified',
      provenance: { snapshotId: ID.githubSnapshot },
    });
    expect(
      codes({
        claims: [claimRecord(C1)],
        evidence: [absence],
        relations: [relationRecord(R1, C1, E1)],
      }),
    ).toEqual(['RELATION_KIND_NOT_ALLOWED']);
    const duplicate = codes({
      claims: [claimRecord(C1)],
      evidence: [evidenceRecord(E1)],
      relations: [
        relationRecord(R1, C1, E1),
        relationRecord('f1000000-0000-4000-8000-000000000002', C1, E1, { seq: 2 }),
        relationRecord('f1000000-0000-4000-8000-000000000003', C1, E1, {
          seq: 3,
          type: 'contradicts',
        }),
      ],
    });
    expect(duplicate).toEqual(['DUPLICATE_RELATION', 'CONFLICTING_RELATION']);
  });

  it('flags contradiction rule violations: same side, canonical order, duplicates, absence sides', () => {
    const base = {
      claims: [claimRecord(C1), claimRecord(C2, { seq: 2 })],
      evidence: [evidenceRecord(E1)],
    };
    expect(
      codes({
        ...base,
        contradictions: [
          contradictionRecord(X1, { type: 'claim', id: C1 }, { type: 'claim', id: C1 }),
        ],
      }),
    ).toContain('CONTRADICTION_SAME_SIDE');
    // evidence before claim is not canonical
    expect(
      codes({
        ...base,
        contradictions: [
          contradictionRecord(X1, { type: 'evidence', id: E1 }, { type: 'claim', id: C1 }),
        ],
      }),
    ).toContain('DUPLICATE_CONTRADICTION');
    expect(
      codes({
        ...base,
        contradictions: [
          contradictionRecord(X1, { type: 'claim', id: C1 }, { type: 'claim', id: C2 }),
          contradictionRecord(
            'f3000000-0000-4000-8000-000000000002',
            { type: 'claim', id: C1 },
            { type: 'claim', id: C2 },
            { seq: 2 },
          ),
        ],
      }),
    ).toEqual(['DUPLICATE_CONTRADICTION']);
    const absence = evidenceRecord(E2, {
      kind: 'absence',
      origin: 'github',
      verificationLevel: 'unverified',
      provenance: { snapshotId: ID.githubSnapshot },
    });
    expect(
      codes({
        ...base,
        evidence: [absence],
        contradictions: [
          contradictionRecord(X1, { type: 'claim', id: C1 }, { type: 'evidence', id: E2 }),
        ],
      }),
    ).toEqual(['CONTRADICTION_KIND_NOT_ALLOWED']);
  });

  it('flags unknowns that reference the same item twice', () => {
    expect(
      codes({ claims: [claimRecord(C1)], unknowns: [unknownRecord(U1, { claimIds: [C1, C1] })] }),
    ).toEqual(['DUPLICATE_REFERENCE']);
  });

  it('checks stored provenance against the source facts: wrong snapshot, wrong artifact, bounds', () => {
    const result = codes({
      evidence: [
        evidenceRecord(E1, {
          origin: 'github',
          kind: 'fact',
          verificationLevel: 'unverified',
          provenance: { snapshotId: ID.githubFailed },
        }),
        evidenceRecord(E2, {
          seq: 2,
          origin: 'github',
          kind: 'fact',
          verificationLevel: 'unverified',
          provenance: {
            snapshotId: ID.githubPartial,
            artifactId: ID.readme,
          },
        }),
        evidenceRecord('e1000000-0000-4000-8000-000000000003', {
          seq: 3,
          origin: 'github',
          kind: 'fact',
          verificationLevel: 'unverified',
          provenance: {
            snapshotId: ID.githubSnapshot,
            artifactId: ID.readme,
            span: { start: 0, end: 500, unit: 'code_points' },
            excerpt: 'x',
          },
        }),
      ],
    });
    expect([...result].sort()).toEqual([
      'ARTIFACT_SNAPSHOT_MISMATCH',
      'SNAPSHOT_NOT_CONTENT_BEARING',
      'SPAN_OUT_OF_BOUNDS',
    ]);
  });

  it('is deterministic and does not mutate its input', () => {
    const records = { claims: [claimRecord(C1, { verificationLevel: 'machine_verified' })] };
    expect(validateGraphIntegrity(graph(records))).toEqual(validateGraphIntegrity(graph(records)));
  });

  it('cannot be satisfied by a ClaimRecord alone: type-level sanity', () => {
    const claim: ClaimRecord = claimRecord(C1);
    expect(Object.keys(claim).sort()).toEqual(
      [
        'createdAt',
        'createdByActorId',
        'id',
        'projectId',
        'seq',
        'supersedesId',
        'text',
        'verificationLevel',
      ].sort(),
    );
  });
});
