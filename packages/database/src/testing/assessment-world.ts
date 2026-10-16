/*
 * Test-only: a world for the M5 P4 persistence tests. Excluded from the package build and exports. A REAL locked Event Context
 * (document, tracks, rubric rows, content hash computed by the same rule the API uses), real captured snapshots with artifact text,
 * declared tracks, and a small but genuine extraction batch whose quotes are exact spans of the stored artifacts.
 */
import { randomUUID } from 'node:crypto';
import {
  assembleContextBatch,
  buildEventReferenceItems,
  referenceMetaOf,
  type EventReferenceItem,
} from '@judge-copilot/assessment';
import { lockedContentHash } from '@judge-copilot/context';
import {
  AssessmentRunLimits,
  type EventContextDocument,
  type EventContextLockedSnapshot,
} from '@judge-copilot/schemas';
import { eq, sql } from 'drizzle-orm';
import type { JudgeDatabase } from '../client.js';
import type { CreateExtractionInput } from '../extraction-store.js';
import {
  actors,
  eventContextVersions,
  eventSources,
  events,
  projectTrackSelections,
  rubricAnchors,
  rubricCriteria,
  rubrics,
  tracks,
} from '../schema/index.js';
import { LockedContextReader } from '../locked-context-reader.js';
import { seedProject, seedSnapshot, sha256, span } from './graph-world.js';

let counter = 0;
const next = () => (counter += 1);
export const uuid = (n: number, prefix = 'd0000001'): string =>
  `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** The official source every synthetic context cites for what it states as explicit (M6 phase 0: "explicit" is only trusted with an official source). */
export const OFFICIAL_RULES_SOURCE_ID = 'd0000002-0000-4000-8000-000000000001';
export const OFFICIAL_RULES_SOURCE_TEXT = 'SYNTHETIC official rules text for tests.';

const fact = (
  n: number,
  statement = 'Not stated.',
  certainty: 'explicit' | 'interpreted' | 'unclear' = 'unclear',
  sourceId: string | null = OFFICIAL_RULES_SOURCE_ID,
) => ({
  id: uuid(n),
  statement,
  certainty,
  sourceIds: certainty === 'unclear' || sourceId === null ? [] : [sourceId],
  origin: 'human' as const,
  humanModified: false,
});

export interface ContextOptions {
  /** Test knob: the two official criterion weights (default 0.5 / 0.5); used to build a foreign rubric. */
  rubricWeights?: [number, number];
  trackKeys?: string[];
  rules?: { statement: string; certainty: 'explicit' | 'interpreted' | 'unclear' }[];
  /** M6 phase 0: rules labelled explicit that cite NO source (what a context locked before the source rule can hold). */
  unsourcedRules?: boolean;
  requirements?: {
    statement: string;
    certainty: 'explicit' | 'interpreted' | 'unclear';
    trackKey: string | null;
  }[];
}

export function contextDocument(
  options: ContextOptions = {},
  sourceId: string = OFFICIAL_RULES_SOURCE_ID,
): EventContextDocument {
  const date = (n: number) => ({ ...fact(n), value: null });
  return {
    dates: {
      startsAt: date(1),
      endsAt: date(2),
      judgingStartsAt: date(3),
      submissionDeadline: date(4),
    },
    judgingFormat: fact(5),
    rules: (options.rules ?? []).map((rule, i) =>
      fact(20 + i, rule.statement, rule.certainty, options.unsourcedRules ? null : sourceId),
    ),
    submissionRequirements: (options.requirements ?? []).map((requirement, i) => ({
      ...fact(40 + i, requirement.statement, requirement.certainty, sourceId),
      trackKey: requirement.trackKey,
    })),
    priorWorkPolicy: { ...fact(6), stance: 'unclear' },
    organizerGuidance: [],
    conflicts: [],
    tracks: (options.trackKeys ?? []).map((key) => ({
      key,
      name: `Track ${key}`,
      description: `Projects in the ${key} track must address ${key}.`,
      sourceIds: [sourceId],
      origin: 'human' as const,
      humanModified: false,
    })),
    rubrics: [
      {
        scope: 'overall',
        trackKey: null,
        name: 'Official rubric',
        scaleMin: 0,
        scaleMax: 10,
        sourceIds: [sourceId],
        origin: 'human',
        humanModified: false,
        criteria: [
          {
            key: 'problem_fit',
            name: 'Problem fit',
            description: 'Published description of problem fit.',
            weight: options.rubricWeights?.[0] ?? 0.5,
            anchors: [
              { score: 0, description: 'No coherent problem.' },
              { score: 10, description: 'A precisely defined problem that is clearly solved.' },
            ],
            sourceIds: [sourceId],
            origin: 'human',
            humanModified: false,
          },
          {
            key: 'usability',
            name: 'Usability',
            description: 'Published description of usability.',
            weight: options.rubricWeights?.[1] ?? 0.5,
            anchors: [],
            sourceIds: [sourceId],
            origin: 'human',
            humanModified: false,
          },
        ],
      },
    ],
  };
}

/**
 * Creates the next version of an event with a document written exactly like the API does, then freezes it the way M1 does:
 * the previously locked version (if any) is superseded first, then the new one is locked with its content hash.
 */
export async function seedLockedContext(
  db: JudgeDatabase,
  eventId: string,
  options: ContextOptions = {},
) {
  const sourceId = randomUUID();
  const document = contextDocument(options, sourceId);
  const [previous] = await db
    .select({
      id: eventContextVersions.id,
      version: eventContextVersions.version,
      status: eventContextVersions.status,
    })
    .from(eventContextVersions)
    .where(eq(eventContextVersions.eventId, eventId))
    .orderBy(sql`version DESC`)
    .limit(1);
  const [version] = await db
    .insert(eventContextVersions)
    .values({
      eventId,
      version: (previous?.version ?? 0) + 1,
      status: 'draft',
      supersedesId: previous?.id ?? null,
    })
    .returning();
  if (!version) throw new Error('version');
  const sourceContentHash = sha256(OFFICIAL_RULES_SOURCE_TEXT);
  await db.insert(eventSources).values({
    id: sourceId,
    contextVersionId: version.id,
    sourceType: 'pasted_text',
    authority: 'official_event_rules',
    title: 'SYNTHETIC official rules',
    url: null,
    normalizedText: OFFICIAL_RULES_SOURCE_TEXT,
    contentHash: sourceContentHash,
    position: 0,
  });
  const trackIdByKey = new Map<string, string>();
  for (const [i, track] of document.tracks.entries()) {
    const [row] = await db
      .insert(tracks)
      .values({
        contextVersionId: version.id,
        key: track.key,
        name: track.name,
        description: track.description,
        displayOrder: i,
        sourceIds: track.sourceIds,
        origin: track.origin,
        humanModified: track.humanModified,
      })
      .returning({ id: tracks.id });
    if (row) trackIdByKey.set(track.key, row.id);
  }
  for (const [i, rubric] of document.rubrics.entries()) {
    const [rubricRow] = await db
      .insert(rubrics)
      .values({
        contextVersionId: version.id,
        trackId: rubric.trackKey === null ? null : (trackIdByKey.get(rubric.trackKey) ?? null),
        name: rubric.name,
        scope: rubric.scope,
        scaleMin: rubric.scaleMin,
        scaleMax: rubric.scaleMax,
        displayOrder: i,
        sourceIds: rubric.sourceIds,
        origin: rubric.origin,
        humanModified: rubric.humanModified,
      })
      .returning({ id: rubrics.id });
    if (!rubricRow) throw new Error('rubric');
    for (const [j, criterion] of rubric.criteria.entries()) {
      const [criterionRow] = await db
        .insert(rubricCriteria)
        .values({
          rubricId: rubricRow.id,
          key: criterion.key,
          name: criterion.name,
          description: criterion.description,
          weight: criterion.weight,
          displayOrder: j,
          sourceIds: criterion.sourceIds,
          origin: criterion.origin,
          humanModified: criterion.humanModified,
        })
        .returning({ id: rubricCriteria.id });
      if (criterion.anchors.length > 0 && criterionRow) {
        await db.insert(rubricAnchors).values(
          criterion.anchors.map((anchor) => ({
            criterionId: criterionRow.id,
            score: anchor.score,
            description: anchor.description,
          })),
        );
      }
    }
  }
  const { tracks: _tracks, rubrics: _rubrics, ...content } = document;
  await db
    .update(eventContextVersions)
    .set({ content })
    .where(eq(eventContextVersions.id, version.id));
  const hash = lockedContentHash({
    document,
    sources: [
      {
        id: sourceId,
        authority: 'official_event_rules',
        sourceType: 'pasted_text',
        title: 'SYNTHETIC official rules',
        url: null,
        contentHash: sourceContentHash,
      },
    ],
  });
  if (previous?.status === 'locked') {
    await db.execute(
      sql`UPDATE event_context_versions SET status = 'superseded' WHERE id = ${previous.id}`,
    );
  }
  await db.execute(
    sql`UPDATE event_context_versions SET status = 'locked', locked_at = now(), locked_content_hash = ${hash} WHERE id = ${version.id}`,
  );
  return {
    versionId: version.id,
    version: version.version,
    document,
    hash,
    trackIdByKey,
    sourceId,
  };
}

export const DEVPOST_TEXT = [
  'HydroTrack',
  'Track your water intake without thinking about it.',
  'What it does',
  'HydroTrack sends a reminder every two hours and stores each intake entry in SQLite.',
  'It works offline and never sends your data to a server.',
  '',
].join('\n');
export const README_TEXT = [
  '# HydroTrack',
  'The reminder service runs every two hours.',
  'Entries are persisted to a local SQLite database.',
  '',
].join('\n');
export const SOURCE_CODE_TEXT = 'export function remindEveryTwoHours() { return 7200; }\n';

export interface AssessmentWorldOptions extends ContextOptions {
  /** Track keys the project declares (must be among `trackKeys`). */
  declare?: string[];
}

export async function seedAssessmentWorld(db: JudgeDatabase, options: AssessmentWorldOptions = {}) {
  const n = next();
  const [event] = await db
    .insert(events)
    .values({
      name: `Assessment World ${String(n)}`,
      slug: `assessment-world-${String(n)}-${String(Date.now())}`,
    })
    .returning();
  if (!event) throw new Error('event');
  const [actor] = await db
    .insert(actors)
    .values({ issuer: 'https://issuer.test', subject: `judge-${String(n)}-${String(Date.now())}` })
    .returning();
  if (!actor) throw new Error('actor');
  const context = await seedLockedContext(db, event.id, options);
  const project = await seedProject(db, event.id, `HydroTrack ${String(n)}`);
  const devpost = await seedSnapshot(db, project, 'devpost', 'captured', [
    { key: 'submission.txt', kind: 'submission_text', mediaType: 'text/plain', text: DEVPOST_TEXT },
  ]);
  const github = await seedSnapshot(db, project, 'github', 'captured', [
    { key: 'files/README.md', kind: 'file', mediaType: 'text/markdown', text: README_TEXT },
    { key: 'files/src/remind.ts', kind: 'file', mediaType: 'text/plain', text: SOURCE_CODE_TEXT },
  ]);
  const declared: string[] = [];
  for (const key of options.declare ?? []) {
    await declareTrack(db, project.id, event.id, context.versionId, key, actor.id);
    declared.push(key);
  }
  return { event, actor, context, project, snapshots: { devpost, github }, declared };
}

export type AssessmentWorld = Awaited<ReturnType<typeof seedAssessmentWorld>>;

export async function declareTrack(
  db: JudgeDatabase,
  projectId: string,
  eventId: string,
  versionId: string,
  trackKey: string,
  actorId: string | null = null,
) {
  const [track] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(sql`${tracks.contextVersionId} = ${versionId} AND ${tracks.key} = ${trackKey}`);
  if (!track) throw new Error(`no track ${trackKey}`);
  const [row] = await db
    .insert(projectTrackSelections)
    .values({
      projectId,
      eventId,
      contextVersionId: versionId,
      trackId: track.id,
      trackKey,
      declaredByActorId: actorId,
    })
    .returning();
  if (!row) throw new Error('selection');
  return row;
}

export const defaultLimits = () => AssessmentRunLimits.parse({});

export function lockedSnapshotOf(
  world: AssessmentWorld,
  versionId = world.context.versionId,
): EventContextLockedSnapshot {
  return {
    eventId: world.event.id,
    versionId,
    version: world.context.version,
    status: 'locked',
    lockedAt: '2026-01-01T00:00:00.000Z',
    lockedContentHash: world.context.hash,
    supersedesId: null,
    changeReason: null,
    summary: null,
    sources: [
      {
        id: world.context.sourceId,
        contextVersionId: versionId,
        sourceType: 'pasted_text',
        authority: 'official_event_rules',
        authorityRank: 100,
        title: 'SYNTHETIC official rules',
        url: null,
        contentHash: sha256(OFFICIAL_RULES_SOURCE_TEXT),
        textLength: OFFICIAL_RULES_SOURCE_TEXT.length,
        capturedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        copiedFromId: null,
      },
    ],
    document: world.context.document,
  };
}

/** A genuine two-statement-plus-one-fact source extraction: every quote is an exact span of the stored artifact text. */
export function sourceExtraction(
  world: AssessmentWorld,
  overrides: { key?: string; withAbsence?: boolean } = {},
): CreateExtractionInput {
  const devpost = world.snapshots.devpost;
  const github = world.snapshots.github;
  const submission = devpost.artifacts[0];
  const readme = github.artifacts.find((a) => a.key === 'files/README.md');
  if (!submission || !readme) throw new Error('fixture');
  const q1 = 'stores each intake entry in SQLite.';
  const q2 = 'It works offline and never sends your data to a server.';
  const q3 = 'Entries are persisted to a local SQLite database.';
  const s1 = span(DEVPOST_TEXT, q1);
  const s2 = span(DEVPOST_TEXT, q2);
  const s3 = span(README_TEXT, q3);
  return {
    projectId: world.project.id,
    actorId: null,
    runId: null,
    kind: 'source',
    // the extraction key is DERIVED from its inputs; a different `key` here means a different extractor configuration
    configHash: sha256(`config:source:${overrides.key ?? String(next())}`),
    snapshotIds: [devpost.snapshot.id, github.snapshot.id],
    contextVersionId: null,
    batch: {
      claims: [
        {
          ref: 'c1',
          text: 'The app stores each intake entry in SQLite.',
          verificationLevel: 'team_claim',
        },
        { ref: 'c2', text: 'The app works offline.', verificationLevel: 'team_claim' },
      ],
      evidence: [
        {
          ref: 'e1',
          kind: 'claim',
          origin: 'devpost',
          verificationLevel: 'team_claim',
          text: q1,
          provenance: {
            snapshotId: devpost.snapshot.id,
            artifactId: submission.id,
            span: s1,
            excerpt: q1,
          },
        },
        {
          ref: 'e2',
          kind: 'claim',
          origin: 'devpost',
          verificationLevel: 'team_claim',
          text: q2,
          provenance: {
            snapshotId: devpost.snapshot.id,
            artifactId: submission.id,
            span: s2,
            excerpt: q2,
          },
        },
        {
          ref: 'e3',
          kind: 'fact',
          origin: 'github',
          verificationLevel: 'unverified',
          text: q3,
          provenance: {
            snapshotId: github.snapshot.id,
            artifactId: readme.id,
            span: s3,
            excerpt: q3,
          },
        },
        ...(overrides.withAbsence === true
          ? [
              {
                ref: 'e4',
                kind: 'absence' as const,
                origin: 'github' as const,
                verificationLevel: 'unverified' as const,
                text: 'No LICENSE file was found in the repository tree.',
                provenance: { snapshotId: github.snapshot.id },
              },
            ]
          : []),
      ],
      relations: [
        { claim: { ref: 'c1' }, evidence: { ref: 'e1' }, type: 'supports' },
        { claim: { ref: 'c2' }, evidence: { ref: 'e2' }, type: 'supports' },
        { claim: { ref: 'c1' }, evidence: { ref: 'e3' }, type: 'supports' },
      ],
      unknowns: [
        {
          unknownType: 'missing',
          text: 'No deployment was supplied.',
          claims: [{ ref: 'c2' }],
          evidence: [],
        },
      ],
      contradictions: [],
    },
    claimGrounding: { c1: 'exact_text', c2: 'exact_text' },
    evidence: {
      e1: { role: 'statement', grounding: 'exact_text' },
      e2: { role: 'statement', grounding: 'exact_text' },
      e3: { role: 'interpreted_fact', grounding: 'exact_text' },
      ...(overrides.withAbsence === true
        ? { e4: { role: 'statement' as const, grounding: 'exact_text' as const } }
        : {}),
    },
    relations: [
      { claimRef: 'c1', evidenceRef: 'e1', basis: 'source_statement' },
      { claimRef: 'c2', evidenceRef: 'e2', basis: 'source_statement' },
      { claimRef: 'c1', evidenceRef: 'e3', basis: 'independent_observation' },
    ],
  };
}

/** The Event-Context reference extraction of the world's locked document and declared tracks. */
export function contextExtraction(
  world: AssessmentWorld,
  overrides: { key?: string } = {},
): { input: CreateExtractionInput; items: readonly EventReferenceItem[] } {
  const items = buildEventReferenceItems(lockedSnapshotOf(world), world.declared).items;
  const evidence = Object.fromEntries(
    items.map((item) => [
      item.ref,
      { role: 'event_reference' as const, reference: referenceMetaOf(item) },
    ]),
  );
  return {
    items,
    input: {
      projectId: world.project.id,
      actorId: null,
      runId: null,
      kind: 'context_evidence',
      configHash: sha256(`config:context:${overrides.key ?? String(next())}`),
      snapshotIds: [],
      contextVersionId: world.context.versionId,
      declaredTrackKeys: [...world.declared].sort(),
      batch: assembleContextBatch(items, world.context.versionId),
      evidence,
    },
  };
}

/** Reads a version through the reader (proves a seeded context is exactly what the reader reconstructs). */
export async function readLocked(db: JudgeDatabase, eventId: string, versionId: string) {
  return new LockedContextReader().read(db, eventId, versionId);
}
