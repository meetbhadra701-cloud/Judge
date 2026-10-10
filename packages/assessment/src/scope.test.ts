import { describe, expect, it } from 'vitest';
import type { KnownEntities } from '@judge-copilot/evidence';
import type { EvidenceGraphRecords } from '@judge-copilot/evidence';
import * as everything from './index.js';
import { membersHash, scopeGraph, type VerifiedScopeInput } from './graph.js';
import { extract } from './testing/pipeline.js';
import { build, type Built } from './testing/scoring.js';
import { lockedSnapshot, OTHER_PROJECT_ID, uid, VERSION_ID } from './testing/world.js';

/*
 * F3 (P3 review): verified graph scoping fails closed. `scopeGraph` requires the project, the event, the COMPLETE authoritative
 * provenance facts, the committed membership hash and the committed member ids. It does not authenticate the database: P4 must load
 * those inputs from independent authorized reads. These tests build records that are INTERNALLY CONSISTENT (every member id listed,
 * every relation closed, the hash matching) and show that only the verified checks catch them.
 */

const locked = lockedSnapshot({
  trackKeys: ['health'],
  rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
});
const built: Built = build({ locked, declaredTrackKeys: ['health'] });
const input: VerifiedScopeInput = built.scopeInput;
const codes = (result: ReturnType<typeof scopeGraph>) =>
  result.ok ? [] : result.issues.map((i) => i.code);

type Known = KnownEntities;
interface MutableKnown {
  claims: Map<string, Known['claims'] extends ReadonlyMap<string, infer V> ? V : never>;
  evidence: Map<string, Known['evidence'] extends ReadonlyMap<string, infer V> ? V : never>;
  snapshots: Map<string, Known['snapshots'] extends ReadonlyMap<string, infer V> ? V : never>;
  artifacts: Map<string, Known['artifacts'] extends ReadonlyMap<string, infer V> ? V : never>;
  contextVersions: Map<
    string,
    Known['contextVersions'] extends ReadonlyMap<string, infer V> ? V : never
  >;
}

const cloneKnown = (): MutableKnown => ({
  claims: new Map(input.known.claims),
  evidence: new Map(input.known.evidence),
  snapshots: new Map(input.known.snapshots),
  artifacts: new Map(input.known.artifacts),
  contextVersions: new Map(input.known.contextVersions),
});

const sourceEvidence = built.records.evidence.find((e) => e.provenance.span !== null);
const contextEvidence = built.records.evidence.find((e) => e.origin === 'event_context');
if (!sourceEvidence || !contextEvidence)
  throw new Error('fixture needs source and context evidence');

/** Replaces one evidence record and keeps EVERYTHING else consistent: same ids, same closure, same committed hash. */
const withEvidence = (
  id: string,
  patch: (e: (typeof built.records.evidence)[number]) => (typeof built.records.evidence)[number],
): EvidenceGraphRecords => ({
  ...built.records,
  evidence: built.records.evidence.map((e) => (e.id === id ? patch(e) : e)),
});

describe('F3: the trust inputs cannot be omitted', () => {
  it('the correctly scoped, valid extraction passes', () => {
    const result = scopeGraph(built.records, input);
    expect(result.ok).toBe(true);
    expect(result.ok && result.membersHash).toBe(input.expectedMembersHash);
  });

  it('ORIGINAL VULNERABILITY vs CORRECTED: missing known facts cannot produce a verified scope', () => {
    for (const bad of [
      undefined,
      null,
      {},
      { snapshots: new Map() },
      { snapshots: [], artifacts: new Map(), contextVersions: new Map() },
    ]) {
      const result = scopeGraph(built.records, { ...input, known: bad as never });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(codes(result)).toContain('trust_input_missing');
    }
  });

  it('a missing or malformed expected membership hash cannot produce a verified scope', () => {
    for (const bad of [undefined, '', 'abc', 'F'.repeat(64), 123, null]) {
      const result = scopeGraph(built.records, { ...input, expectedMembersHash: bad as never });
      expect(result.ok, String(bad)).toBe(false);
      expect(codes(result)).toContain('trust_input_missing');
    }
  });

  it('a missing project or event id, or missing member arrays, cannot produce a verified scope', () => {
    expect(codes(scopeGraph(built.records, { ...input, projectId: undefined as never }))).toContain(
      'trust_input_missing',
    );
    expect(codes(scopeGraph(built.records, { ...input, eventId: 'not-a-uuid' }))).toContain(
      'trust_input_missing',
    );
    expect(codes(scopeGraph(built.records, { ...input, members: undefined as never }))).toContain(
      'trust_input_missing',
    );
    expect(
      codes(
        scopeGraph(built.records, {
          ...input,
          members: { ...input.members, relationIds: undefined as never },
        }),
      ),
    ).toContain('trust_input_missing');
    expect(codes(scopeGraph(built.records, undefined as never))).toContain('trust_input_missing');
  });

  it('there is no exported way to scope without verification: the filtering helper is internal', () => {
    expect(
      Object.keys(everything).filter((name) => /unverified|selectMembers/i.test(name)),
    ).toEqual([]);
    expect(scopeGraph.length).toBe(2); // exactly (records, input): no optional trust argument
  });
});

describe('F3: committed membership', () => {
  it('the committed ids must hash to the committed hash', () => {
    const tampered = {
      ...input,
      members: { ...input.members, claimIds: input.members.claimIds.slice(1) },
    };
    expect(codes(scopeGraph(built.records, tampered))).toContain('committed_members_hash_mismatch');
    expect(
      codes(scopeGraph(built.records, { ...input, expectedMembersHash: 'f'.repeat(64) })),
    ).toContain('committed_members_hash_mismatch');
  });

  it('a missing or duplicated member id fails', () => {
    const missing = { ...built.records, claims: built.records.claims.slice(1) };
    expect(codes(scopeGraph(missing, input))).toContain('member_missing');
    const dup = {
      ...input.members,
      claimIds: [...input.members.claimIds, input.members.claimIds[0] ?? ''],
    };
    const result = scopeGraph(built.records, {
      ...input,
      members: dup,
      expectedMembersHash: membersHash(dup),
    });
    expect(codes(result)).toContain('member_ids_not_unique');
  });
});

describe('F3: project and event identity', () => {
  it('a complete foreign project, internally consistent, is refused under our expected ids', () => {
    const foreignRecords: EvidenceGraphRecords = {
      claims: built.records.claims.map((c) => ({ ...c, projectId: OTHER_PROJECT_ID })),
      evidence: built.records.evidence.map((e) => ({ ...e, projectId: OTHER_PROJECT_ID })),
      relations: built.records.relations.map((r) => ({ ...r, projectId: OTHER_PROJECT_ID })),
      unknowns: built.records.unknowns.map((u) => ({ ...u, projectId: OTHER_PROJECT_ID })),
      contradictions: built.records.contradictions.map((c) => ({
        ...c,
        projectId: OTHER_PROJECT_ID,
      })),
    };
    const foreignKnown = cloneKnown();
    for (const [id, snapshot] of foreignKnown.snapshots)
      foreignKnown.snapshots.set(id, { ...snapshot, projectId: OTHER_PROJECT_ID });
    // the SAME records and facts pass when the run is for that project...
    expect(
      scopeGraph(foreignRecords, { ...input, projectId: OTHER_PROJECT_ID, known: foreignKnown }).ok,
    ).toBe(true);
    // ...and fail when the run is for ours
    const result = scopeGraph(foreignRecords, { ...input, known: foreignKnown });
    expect(codes(result)).toContain('member_wrong_project');
    expect(codes(result)).toContain('provenance_cross_project_reference');
  });

  it('records of another event are refused', () => {
    const otherEvent = 'e0000009-0000-4000-8000-000000000009';
    const records = {
      ...built.records,
      evidence: built.records.evidence.map((e) => ({ ...e, eventId: otherEvent })),
    };
    expect(codes(scopeGraph(records, input))).toContain('member_wrong_event');
    expect(codes(scopeGraph(built.records, { ...input, eventId: otherEvent }))).toContain(
      'member_wrong_event',
    );
  });
});

describe('F3: provenance is verified against the authoritative facts (records can be internally consistent and still fabricated)', () => {
  it('ORIGINAL VULNERABILITY: closure and hash alone accept fabricated provenance; verification rejects it', () => {
    const fabricated = withEvidence(sourceEvidence.id, (e) => ({
      ...e,
      provenance: {
        ...e.provenance,
        snapshotId: uid(666, 'f0000001'),
        artifactId: uid(667, 'f0000001'),
      },
    }));
    // every member id is present, every relation closed, the committed hash matches: nothing but provenance is wrong
    const result = scopeGraph(fabricated, input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['provenance_snapshot_not_found', 'provenance_artifact_not_found']),
    );
  });

  it('an invented excerpt, a span past the artifact and a span that no longer matches are rejected', () => {
    const span = sourceEvidence.provenance.span;
    if (!span) throw new Error('fixture');
    const invented = withEvidence(sourceEvidence.id, (e) => ({
      ...e,
      provenance: { ...e.provenance, excerpt: 'Words the team never wrote anywhere.' },
    }));
    expect(codes(scopeGraph(invented, input))).toContain('provenance_excerpt_mismatch');
    const beyond = withEvidence(sourceEvidence.id, (e) => ({
      ...e,
      provenance: {
        ...e.provenance,
        span: { start: 1_000_000, end: 1_000_050, unit: 'code_points' as const },
      },
    }));
    expect(codes(scopeGraph(beyond, input))).toContain('provenance_span_out_of_bounds');
    const shifted = withEvidence(sourceEvidence.id, (e) => ({
      ...e,
      provenance: {
        ...e.provenance,
        span: { start: span.start + 3, end: span.end + 3, unit: 'code_points' as const },
      },
    }));
    expect(codes(scopeGraph(shifted, input))).toContain('provenance_excerpt_mismatch');
  });

  it('an artifact that belongs to a different snapshot than the one cited is rejected', () => {
    const otherArtifact = [...input.known.artifacts.values()].find(
      (a) => a.id !== sourceEvidence.provenance.artifactId,
    );
    if (!otherArtifact) throw new Error('fixture');
    const mixed = withEvidence(sourceEvidence.id, (e) => ({
      ...e,
      provenance: { ...e.provenance, artifactId: otherArtifact.id },
    }));
    expect(codes(scopeGraph(mixed, input)).length).toBeGreaterThan(0);
  });

  it('a member that cites an UNAUTHORIZED snapshot is rejected: not authorized, foreign, or without content', () => {
    const snapshotId = sourceEvidence.provenance.snapshotId ?? '';
    // not among the authorized (pinned) facts
    const missing = cloneKnown();
    missing.snapshots.delete(snapshotId);
    expect(codes(scopeGraph(built.records, { ...input, known: missing }))).toContain(
      'provenance_snapshot_not_found',
    );
    // present, but a snapshot of another project
    const foreign = cloneKnown();
    const real = foreign.snapshots.get(snapshotId);
    if (!real) throw new Error('fixture');
    foreign.snapshots.set(snapshotId, { ...real, projectId: OTHER_PROJECT_ID });
    expect(codes(scopeGraph(built.records, { ...input, known: foreign }))).toContain(
      'provenance_cross_project_reference',
    );
    // present and ours, but it captured nothing
    const failed = cloneKnown();
    failed.snapshots.set(snapshotId, { ...real, status: 'failed' });
    expect(codes(scopeGraph(built.records, { ...input, known: failed }))).toContain(
      'provenance_snapshot_not_content_bearing',
    );
  });

  it('a context-version reference must be an authorized, frozen version of THIS event', () => {
    const versionId = contextEvidence.provenance.contextVersionId ?? '';
    expect(versionId).toBe(VERSION_ID);
    const missing = cloneKnown();
    missing.contextVersions.delete(versionId);
    expect(codes(scopeGraph(built.records, { ...input, known: missing }))).toContain(
      'provenance_context_version_not_found',
    );
    const real = input.known.contextVersions.get(versionId);
    if (!real) throw new Error('fixture');
    const otherEvent = cloneKnown();
    otherEvent.contextVersions.set(versionId, {
      ...real,
      eventId: 'e0000009-0000-4000-8000-000000000009',
    });
    expect(codes(scopeGraph(built.records, { ...input, known: otherEvent }))).toContain(
      'provenance_cross_project_reference',
    );
    const draft = cloneKnown();
    draft.contextVersions.set(versionId, { ...real, status: 'draft' });
    expect(codes(scopeGraph(built.records, { ...input, known: draft }))).toContain(
      'provenance_context_version_not_frozen',
    );
  });

  it('facts without readable artifact text cannot verify a cited span, so the scope is not verified', () => {
    const noText = cloneKnown();
    const artifactId = sourceEvidence.provenance.artifactId ?? '';
    const real = noText.artifacts.get(artifactId);
    if (!real) throw new Error('fixture');
    const withoutSlice = Object.fromEntries(
      Object.entries(real).filter(([key]) => key !== 'slice'),
    ) as typeof real;
    noText.artifacts.set(artifactId, withoutSlice);
    expect(codes(scopeGraph(built.records, { ...input, known: noText }))).toContain(
      'artifact_text_unavailable',
    );
  });
});

describe('F3: closure and foreign records', () => {
  it('dangling endpoints fail: a member relation whose evidence is missing, or is not a member', () => {
    const relation = built.records.relations[0];
    if (!relation) throw new Error('fixture');
    const absent = {
      ...built.records,
      evidence: built.records.evidence.filter((e) => e.id !== relation.evidenceId),
    };
    expect(codes(scopeGraph(absent, input))).toContain('member_missing');
    const members = {
      ...input.members,
      evidenceIds: input.members.evidenceIds.filter((id) => id !== relation.evidenceId),
    };
    const notMember = scopeGraph(built.records, {
      ...input,
      members,
      expectedMembersHash: membersHash(members),
    });
    expect(codes(notMember)).toContain('relation_evidence_outside_members');
  });

  it('a supersession edge inside the member set fails', () => {
    const claims = built.records.claims.map((c, i) =>
      i === 0 ? { ...c, supersedesId: uid(4242) } : c,
    );
    expect(codes(scopeGraph({ ...built.records, claims }, input))).toContain(
      'member_has_supersession',
    );
  });

  it('extra foreign records, even ones that reference members, are excluded and change nothing (metamorphic)', () => {
    const other = build({ extracted: extract() }); // a second extraction of the same project
    const renumber = (id: string) => `${id.slice(0, -4)}ee${id.slice(-2)}`;
    const noise: EvidenceGraphRecords = {
      claims: other.records.claims.map((c) => ({ ...c, id: renumber(c.id), seq: c.seq + 1_000 })),
      evidence: other.records.evidence.map((e) => ({
        ...e,
        id: renumber(e.id),
        seq: e.seq + 1_000,
      })),
      relations: [
        ...other.records.relations.map((r) => ({
          ...r,
          id: renumber(r.id),
          claimId: renumber(r.claimId),
          evidenceId: renumber(r.evidenceId),
          seq: r.seq + 1_000,
        })),
        {
          ...(other.records.relations[0] ??
            (() => {
              throw new Error('fixture');
            })()),
          id: uid(500),
          claimId: built.records.claims[0]?.id ?? '',
          evidenceId: built.records.evidence[0]?.id ?? '',
          seq: 9_000,
        },
      ],
      unknowns: [],
      contradictions: [],
    };
    const all: EvidenceGraphRecords = {
      claims: [...built.records.claims, ...noise.claims],
      evidence: [...built.records.evidence, ...noise.evidence],
      relations: [...built.records.relations, ...noise.relations],
      unknowns: built.records.unknowns,
      contradictions: built.records.contradictions,
    };
    const noisy = scopeGraph(all, input);
    const alone = scopeGraph(built.records, input);
    expect(noisy.ok && alone.ok).toBe(true);
    expect(noisy.ok && JSON.stringify(noisy.records)).toBe(
      alone.ok ? JSON.stringify(alone.records) : '',
    );
    expect(noisy.ok && noisy.records.relations.map((r) => r.id)).not.toContain(uid(500));
  });
});

describe("A1 (R3): duplicate loaded members cannot mask a missing member (the reviewer's counterexample)", () => {
  // a relation is referenced by no other record, so removing one leaves the rest of the graph closed
  const removed = built.records.relations.at(-1);
  const kept = built.records.relations.filter((r) => r.id !== removed?.id);
  const base = kept[0];

  it('fixture: an unreferenced member and another member to duplicate exist', () => {
    expect(removed).toBeDefined();
    expect(base).toBeDefined();
  });

  it('removing an unreferenced member and inserting a duplicate of another with different text is rejected on its own merits', () => {
    if (!removed || !base) throw new Error('fixture');
    const attacked: EvidenceGraphRecords = {
      ...built.records,
      relations: [
        ...kept,
        {
          ...base,
          type: base.type === 'supports' ? 'contradicts' : 'supports',
        },
      ],
    };
    // same number of records as the genuine set: a count comparison alone is blind to this
    expect(attacked.relations).toHaveLength(built.records.relations.length);
    const result = scopeGraph(attacked, input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['member_missing', 'loaded_record_ids_not_unique']),
    );
  });

  it('the same attack on claims (a duplicate with different text replacing a removed member) is refused', () => {
    const [first, second, ...rest] = built.records.claims;
    if (!first || !second) throw new Error('fixture');
    const attacked: EvidenceGraphRecords = {
      ...built.records,
      claims: [second, { ...second, text: 'A different text under the same id.' }, ...rest],
    };
    expect(attacked.claims).toHaveLength(built.records.claims.length);
    const result = scopeGraph(attacked, input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['member_missing', 'loaded_record_ids_not_unique']),
    );
  });

  it('a plain duplicate of a present member (nothing missing) is also refused, never silently deduplicated', () => {
    if (!base) throw new Error('fixture');
    const dup: EvidenceGraphRecords = {
      ...built.records,
      relations: [...built.records.relations, { ...base }],
    };
    const result = scopeGraph(dup, input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('loaded_record_ids_not_unique');
  });

  it('a substituted record (the id is absent, another id appears) fails as a missing member', () => {
    if (!removed) throw new Error('fixture');
    const substituted: EvidenceGraphRecords = {
      ...built.records,
      relations: built.records.relations.map((r) =>
        r.id === removed.id ? { ...r, id: uid(7777) } : r,
      ),
    };
    expect(codes(scopeGraph(substituted, input))).toContain('member_missing');
  });
});
