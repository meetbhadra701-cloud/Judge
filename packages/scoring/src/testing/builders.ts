/*
 * Test-only builders: deterministic evidence graphs, locked Event Context snapshots and judgments.
 * Everything is explicit fixture data labeled as such; nothing here is a model output and nothing
 * pretends to be real judging. Excluded from the package build and from the public exports.
 */
import { buildEvidenceGraph, canonicalSides, type KnownEntities } from '@judge-copilot/evidence';
import { lockedContentHash } from '@judge-copilot/context';
import type {
  ClaimRecord,
  ContradictionRecord,
  DimensionJudgment,
  EventContextDocument,
  EventContextLockedSnapshot,
  EvidenceDirectness,
  EvidenceKind,
  EvidenceOrigin,
  EvidenceRecord,
  EvidenceSpecificity,
  RelationRecord,
  RubricDefinition,
  SnapshotProvenanceFacts,
  UnknownRecord,
  VerificationLevel,
} from '@judge-copilot/schemas';
import {
  createTrustedScoringContext,
  type CreateTrustedScoringContextInput,
  type ScoringGraphInput,
  type TrustedScoringContext,
} from '../context.js';
import { FALLBACK_RUBRIC_DEFINITION, FALLBACK_TRACK_CRITERION_KEY } from '../rubric/fallback.js';
import type { ScoringTarget } from '../rubric/select.js';

/** A valid, deterministic UUID (version 4 layout) for fixture number `n`. */
export function uid(n: number, prefix = '00000000'): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const PROJECT_ID = uid(1, 'a0000001');
export const OTHER_PROJECT_ID = uid(1, 'a0000002');
export const EVENT_ID = uid(1, 'e0000001');
export const OTHER_EVENT_ID = uid(1, 'e0000002');
export const VERSION_ID = uid(1, 'c0000001');

const NOW = '2031-04-12T00:00:00.000Z';

export interface EvidenceSpec {
  id: string;
  kind?: EvidenceKind;
  origin: EvidenceOrigin;
  label?: VerificationLevel;
  snapshotId?: string | null;
  artifactId?: string | null;
  span?: [number, number] | null;
  contextVersionId?: string | null;
  projectId?: string;
  eventId?: string;
}

/** A small mutable fixture graph; `build()` freezes it into the engine's inputs. */
export class FixtureGraph {
  private seq = 0;
  private readonly claims: ClaimRecord[] = [];
  private readonly evidence: EvidenceRecord[] = [];
  private readonly relations: RelationRecord[] = [];
  private readonly unknowns: UnknownRecord[] = [];
  private readonly contradictions: ContradictionRecord[] = [];
  private readonly snapshots = new Map<string, SnapshotProvenanceFacts>();
  private readonly artifacts = new Map<
    string,
    KnownEntities['artifacts'] extends ReadonlyMap<string, infer V> ? V : never
  >();
  private readonly versions = new Map<
    string,
    {
      id: string;
      eventId: string;
      version: number;
      status: 'draft' | 'in_review' | 'locked' | 'superseded';
    }
  >();

  constructor(
    readonly projectId = PROJECT_ID,
    readonly eventId = EVENT_ID,
  ) {}

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  snapshot(
    id: string,
    sourceType: SnapshotProvenanceFacts['sourceType'],
    status: SnapshotProvenanceFacts['status'] = 'captured',
    projectId = this.projectId,
  ): this {
    this.snapshots.set(id, {
      id,
      projectId,
      sourceType,
      captureNumber: 1,
      status,
      revision: sourceType === 'github' ? 'a'.repeat(40) : null,
      contentHash: id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      capturedAt: NOW,
    });
    return this;
  }

  artifact(
    id: string,
    snapshotId: string,
    key: string,
    options: {
      kind?: 'file' | 'http_response' | 'submission_text' | 'repository_metadata';
      mediaType?: string;
    } = {},
  ): this {
    this.artifacts.set(id, {
      id,
      snapshotId,
      key,
      kind: options.kind ?? 'file',
      mediaType: options.mediaType ?? 'text/plain',
      byteLength: 10_000,
      codePointLength: 10_000,
      contentHash: id.replaceAll('-', '').padEnd(64, '1').slice(0, 64),
    });
    return this;
  }

  contextVersion(id: string, status: 'locked' | 'superseded' = 'locked'): this {
    this.versions.set(id, { id, eventId: this.eventId, version: 1, status });
    return this;
  }

  addEvidence(spec: EvidenceSpec): this {
    const span = spec.span ?? null;
    this.evidence.push({
      id: spec.id,
      projectId: spec.projectId ?? this.projectId,
      eventId: spec.eventId ?? this.eventId,
      seq: this.nextSeq(),
      kind: spec.kind ?? 'fact',
      origin: spec.origin,
      verificationLevel: spec.label ?? 'unverified',
      text: `fixture evidence ${spec.id}`,
      provenance: {
        snapshotId: spec.snapshotId ?? null,
        artifactId: spec.artifactId ?? null,
        span: span ? { start: span[0], end: span[1], unit: 'code_points' } : null,
        excerpt: span ? 'x'.repeat(span[1] - span[0]) : null,
        contextVersionId: spec.contextVersionId ?? null,
      },
      createdByActorId: null,
      createdAt: NOW,
    });
    return this;
  }

  addClaim(spec: { id: string; label?: VerificationLevel; supersedesId?: string | null }): this {
    this.claims.push({
      id: spec.id,
      projectId: this.projectId,
      seq: this.nextSeq(),
      text: `fixture claim ${spec.id}`,
      verificationLevel: spec.label ?? 'team_claim',
      supersedesId: spec.supersedesId ?? null,
      createdByActorId: null,
      createdAt: NOW,
    });
    return this;
  }

  relate(claimId: string, evidenceId: string, type: 'supports' | 'contradicts' = 'supports'): this {
    this.relations.push({
      id: uid(this.relations.length + 1, 'b0000001'),
      projectId: this.projectId,
      seq: this.nextSeq(),
      claimId,
      evidenceId,
      type,
      createdByActorId: null,
      createdAt: NOW,
    });
    return this;
  }

  contradict(
    id: string,
    a: { type: 'claim' | 'evidence'; id: string },
    b: { type: 'claim' | 'evidence'; id: string },
  ): this {
    const [sideA, sideB] = canonicalSides(a, b);
    this.contradictions.push({
      id,
      projectId: this.projectId,
      seq: this.nextSeq(),
      sideA,
      sideB,
      description: 'fixture contradiction',
      createdByActorId: null,
      createdAt: NOW,
    });
    return this;
  }

  unknown(id: string, claimIds: string[] = [], evidenceIds: string[] = []): this {
    this.unknowns.push({
      id,
      projectId: this.projectId,
      seq: this.nextSeq(),
      unknownType: 'unverifiable',
      text: 'fixture unknown',
      claimIds,
      evidenceIds,
      createdByActorId: null,
      createdAt: NOW,
    });
    return this;
  }

  build(): ScoringGraphInput {
    return {
      projectId: this.projectId,
      eventId: this.eventId,
      graph: buildEvidenceGraph({
        claims: this.claims,
        evidence: this.evidence,
        relations: this.relations,
        unknowns: this.unknowns,
        contradictions: this.contradictions,
      }),
      known: {
        claims: new Map(),
        evidence: new Map(),
        snapshots: new Map(this.snapshots),
        artifacts: new Map(this.artifacts),
        contextVersions: new Map(this.versions),
      },
    };
  }
}

// -- The standard fixture world ----------------------------------------------------------------

export const IDS = {
  github: uid(10, 'f0000001'),
  devpost: uid(11, 'f0000001'),
  deployment: uid(12, 'f0000001'),
  video: uid(13, 'f0000001'),
  code: uid(20, 'f0000002'),
  code2: uid(21, 'f0000002'),
  readme: uid(22, 'f0000002'),
  meta: uid(23, 'f0000002'),
  response: uid(24, 'f0000002'),
  context: uid(30, 'f0000003'),
} as const;

/** A project world: one snapshot per source, source code + README + metadata artifacts, a context version. */
export function baseWorld(): FixtureGraph {
  return new FixtureGraph()
    .snapshot(IDS.github, 'github')
    .snapshot(IDS.devpost, 'devpost')
    .snapshot(IDS.deployment, 'deployment')
    .snapshot(IDS.video, 'video')
    .artifact(IDS.code, IDS.github, 'files/src/app.ts')
    .artifact(IDS.code2, IDS.github, 'files/src/cache.ts')
    .artifact(IDS.readme, IDS.github, 'files/README.md', { mediaType: 'text/markdown' })
    .artifact(IDS.meta, IDS.github, 'repository.json', {
      kind: 'repository_metadata',
      mediaType: 'application/json',
    })
    .artifact(IDS.response, IDS.deployment, 'response.json', {
      kind: 'http_response',
      mediaType: 'application/json',
    })
    .contextVersion(IDS.context);
}

/** Honest producer-path evidence: a GitHub source-code fact labeled repo_corroborated. */
export function codeEvidence(
  graph: FixtureGraph,
  id: string,
  options: { artifactId?: string; span?: [number, number] | null; label?: VerificationLevel } = {},
): string {
  graph.addEvidence({
    id,
    origin: 'github',
    kind: 'fact',
    label: options.label ?? 'repo_corroborated',
    snapshotId: IDS.github,
    artifactId: options.artifactId ?? IDS.code,
    span: options.span === undefined ? [0, 10] : options.span,
  });
  return id;
}

export function devpostEvidence(
  graph: FixtureGraph,
  id: string,
  options: { label?: VerificationLevel; kind?: EvidenceKind } = {},
): string {
  graph.addEvidence({
    id,
    origin: 'devpost',
    kind: options.kind ?? 'claim',
    label: options.label ?? 'team_claim',
    snapshotId: IDS.devpost,
  });
  return id;
}

export function deploymentEvidence(
  graph: FixtureGraph,
  id: string,
  label: VerificationLevel = 'unverified',
): string {
  graph.addEvidence({
    id,
    origin: 'deployment',
    kind: 'fact',
    label,
    snapshotId: IDS.deployment,
    artifactId: IDS.response,
    span: label === 'machine_verified' ? [0, 2] : null,
  });
  return id;
}

// -- Locked Event Context ----------------------------------------------------------------------

export interface CriterionFixture {
  key: string;
  name?: string;
  weight: number | null;
}

export function rubricDefinition(options: {
  scope?: 'overall' | 'track';
  trackKey?: string | null;
  name?: string;
  scaleMin?: number;
  scaleMax?: number;
  criteria: CriterionFixture[];
}): RubricDefinition {
  return {
    scope: options.scope ?? 'overall',
    trackKey: options.trackKey ?? null,
    name: options.name ?? 'Official rubric',
    scaleMin: options.scaleMin ?? 0,
    scaleMax: options.scaleMax ?? 10,
    sourceIds: [],
    origin: 'human',
    humanModified: false,
    criteria: options.criteria.map((criterion) => ({
      key: criterion.key,
      name: criterion.name ?? criterion.key,
      description: `Published description of ${criterion.key}.`,
      weight: criterion.weight,
      anchors: [],
      sourceIds: [],
      origin: 'human' as const,
      humanModified: false,
    })),
  };
}

function unclearFact(n: number) {
  return {
    id: uid(n, 'd0000001'),
    statement: 'Not stated.',
    certainty: 'unclear' as const,
    sourceIds: [],
    origin: 'human' as const,
    humanModified: false,
  };
}

export function lockedSnapshot(
  options: {
    rubrics?: RubricDefinition[];
    trackKeys?: string[];
    eventId?: string;
    tamper?: boolean;
  } = {},
): EventContextLockedSnapshot {
  const date = (n: number) => ({ ...unclearFact(n), value: null });
  const document: EventContextDocument = {
    dates: {
      startsAt: date(1),
      endsAt: date(2),
      judgingStartsAt: date(3),
      submissionDeadline: date(4),
    },
    judgingFormat: unclearFact(5),
    rules: [],
    submissionRequirements: [],
    priorWorkPolicy: { ...unclearFact(6), stance: 'unclear' },
    organizerGuidance: [],
    conflicts: [],
    tracks: (options.trackKeys ?? []).map((key) => ({
      key,
      name: key,
      description: null,
      sourceIds: [],
      origin: 'human' as const,
      humanModified: false,
    })),
    rubrics: options.rubrics ?? [],
  };
  const hash = lockedContentHash({ document, sources: [] });
  return {
    eventId: options.eventId ?? EVENT_ID,
    versionId: VERSION_ID,
    version: 1,
    status: 'locked',
    lockedAt: NOW,
    lockedContentHash: options.tamper ? 'f'.repeat(64) : hash,
    supersedesId: null,
    changeReason: null,
    summary: null,
    sources: [],
    document,
  };
}

// -- Context + judgments -----------------------------------------------------------------------

export function makeContext(
  graph: ScoringGraphInput,
  locked: EventContextLockedSnapshot,
  options: { target?: ScoringTarget; declaredTrackKeys?: string[] } = {},
): TrustedScoringContext {
  const input: CreateTrustedScoringContextInput = {
    ...graph,
    locked,
    target: options.target ?? { kind: 'overall' },
    declaredTrackKeys: options.declaredTrackKeys ?? [],
  };
  const result = createTrustedScoringContext(input);
  if (!result.ok) throw new Error(`fixture context rejected: ${JSON.stringify(result.issues)}`);
  return result.context;
}

export function cite(
  evidenceId: string,
  directness: EvidenceDirectness = 'direct',
  specificity: EvidenceSpecificity = 'exact',
) {
  return { evidenceId, directness, specificity };
}

export function scored(
  dimensionId: string,
  score: number,
  ...citations: ReturnType<typeof cite>[]
): DimensionJudgment {
  return { dimensionId, outcome: { kind: 'scored', score }, citations };
}

export function insufficient(
  dimensionId: string,
  ...citations: ReturnType<typeof cite>[]
): DimensionJudgment {
  return { dimensionId, outcome: { kind: 'insufficient_evidence' }, citations };
}

export function payload(...judgments: DimensionJudgment[]) {
  return { engineVersion: 'scoring-engine/v1', judgments };
}

/** A tiny deterministic PRNG (mulberry32) for property tests. Never `Math.random`. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every dimension ID of the fallback rubric (the Track criterion only when tracks are declared). */
export function fallbackDimensionIds(withTrack: boolean): string[] {
  return FALLBACK_RUBRIC_DEFINITION.filter(
    (criterion) => withTrack || criterion.key !== FALLBACK_TRACK_CRITERION_KEY,
  ).flatMap((criterion) =>
    criterion.dimensions.map((dimension) => `${criterion.key}.${dimension.key}`),
  );
}

/**
 * A complete fallback payload: the given judgments, and an `insufficient_evidence` judgment for
 * every other applicable dimension (a judgment is required for each).
 */
export function fallbackPayload(
  judgments: DimensionJudgment[],
  options: { withTrack?: boolean } = {},
) {
  const given = new Set(judgments.map((judgment) => judgment.dimensionId));
  const rest = fallbackDimensionIds(options.withTrack ?? false)
    .filter((id) => !given.has(id))
    .map((id) => insufficient(id));
  return payload(...judgments, ...rest);
}

/** Judgments scoring every dimension of one fallback criterion the same, citing one item each. */
export function criterionScored(
  criterionKey: string,
  score: number,
  ...citations: ReturnType<typeof cite>[]
): DimensionJudgment[] {
  const criterion = FALLBACK_RUBRIC_DEFINITION.find((entry) => entry.key === criterionKey);
  if (!criterion) throw new Error(`unknown criterion ${criterionKey}`);
  return criterion.dimensions.map((dimension) =>
    scored(`${criterionKey}.${dimension.key}`, score, ...citations),
  );
}
