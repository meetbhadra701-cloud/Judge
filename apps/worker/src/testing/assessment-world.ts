/*
 * Test-only world for the M5 P5 pipeline tests (excluded from the build): a REAL locked Event Context (document, tracks, rubric rows, the
 * content hash computed by the rule the API uses), real captured snapshots with stored artifact text, a project, an actor, and the helpers
 * that request an assessment run exactly the way the run store does. Everything is synthetic; hostile variants exist on purpose and are
 * inert data.
 */
import { createHash } from 'node:crypto';
import { lockedContentHash } from '@judge-copilot/context';
import {
  actors,
  AssessmentInputReader,
  AssessmentRunStore,
  AssessmentStore,
  eventContextVersions,
  events,
  EvidenceGraphStore,
  GraphExtractionStore,
  projectSources,
  projects,
  projectTrackSelections,
  rubricAnchors,
  rubricCriteria,
  rubrics,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  tracks,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { deterministicIdAllocator } from '@judge-copilot/evidence';
import { systemClock, type Clock, type LlmProvider, type RetryPolicy } from '@judge-copilot/llm';
import {
  AssessmentRunLimits,
  type EventContextDocument,
  type ProjectSourceType,
} from '@judge-copilot/schemas';
import { eq, sql } from 'drizzle-orm';
import { buildPipelineConfig, type AssessmentPipelineConfig } from '../assessment/config.js';
import type { PipelineDeps } from '../assessment/pipeline.js';
import { memoryLogger } from './harness.js';

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

let counter = 0;
const next = (): number => (counter += 1);

const uuid = (n: number): string => `d0000001-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const fact = (
  n: number,
  statement = 'Not stated.',
  certainty: 'explicit' | 'interpreted' | 'unclear' = 'unclear',
) => ({
  id: uuid(n),
  statement,
  certainty,
  sourceIds: [],
  origin: 'human' as const,
  humanModified: false,
});

export const DEVPOST_TEXT = [
  'HydroTrack',
  'Track your water intake without thinking about it.',
  '',
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

/** What the default fake model quotes. Each is an exact substring of the stored text above. */
export const CLAIM_QUOTES = [
  'HydroTrack sends a reminder every two hours and stores each intake entry in SQLite.',
  'It works offline and never sends your data to a server.',
  'The reminder service runs every two hours.',
] as const;
export const EVIDENCE_QUOTE = 'export function remindEveryTwoHours() { return 7200; }';
export const EVIDENCE_TEXT =
  'The code defines a function that returns 7200, which is two hours in seconds.';

export interface CriterionOption {
  key: string;
  weight: number | null;
  anchors?: { score: number; description: string }[];
}

export interface WorldOptions {
  /** The number of official criteria (default 2: one with anchors, one without). Weights are null (unweighted) above 2. */
  criteria?: number;
  /** Replaces the default criteria entirely. */
  criterionList?: CriterionOption[];
  trackKeys?: string[];
  rules?: { statement: string; certainty: 'explicit' | 'interpreted' | 'unclear' }[];
  /** No official overall rubric: the fallback rubric would apply (and is disabled). */
  noRubric?: boolean;
  /** Sources to capture (default: devpost and github). */
  sources?: ('devpost' | 'github' | 'deployment')[];
  devpostText?: string;
  readmeText?: string;
  /** The project's name (a project is renamed only when it is voided, so a label is chosen at creation). */
  projectName?: string;
  codeText?: string;
  /** More repository files (key without the `files/` prefix) captured with the README and the default source file. */
  extraFiles?: { path: string; text: string }[];
  /** Captures the repository as `partial` instead of `captured`. */
  partialRepository?: boolean;
  /** Source types whose capture failed (no artifacts). */
  failed?: ('github' | 'deployment' | 'video')[];
  declare?: string[];
}

function criteriaOf(options: WorldOptions): CriterionOption[] {
  if (options.criterionList) return options.criterionList;
  const count = options.criteria ?? 2;
  if (count === 2) {
    return [
      {
        key: 'problem_fit',
        weight: 0.5,
        anchors: [
          { score: 0, description: 'No coherent problem.' },
          { score: 10, description: 'A precisely defined problem that is clearly solved.' },
        ],
      },
      { key: 'usability', weight: 0.5, anchors: [] },
    ];
  }
  return Array.from({ length: count }, (_, index) => ({
    key: `crit_${String(index + 1).padStart(2, '0')}`,
    weight: null,
    anchors:
      index === 0
        ? [
            { score: 0, description: 'Nothing is shown.' },
            { score: 10, description: 'Everything is shown.' },
          ]
        : [],
  }));
}

export function contextDocument(options: WorldOptions = {}): EventContextDocument {
  const date = (n: number) => ({ ...fact(n), value: null });
  const rules = options.rules ?? [
    { statement: 'Every project must be original work.', certainty: 'explicit' as const },
  ];
  return {
    dates: {
      startsAt: date(1),
      endsAt: date(2),
      judgingStartsAt: date(3),
      submissionDeadline: date(4),
    },
    judgingFormat: fact(5),
    rules: rules.map((rule, i) => fact(20 + i, rule.statement, rule.certainty)),
    submissionRequirements: [],
    priorWorkPolicy: { ...fact(6), stance: 'unclear' },
    organizerGuidance: [],
    conflicts: [],
    tracks: (options.trackKeys ?? []).map((key) => ({
      key,
      name: `Track ${key}`,
      description: `Projects in the ${key} track must address ${key}.`,
      sourceIds: [],
      origin: 'human' as const,
      humanModified: false,
    })),
    rubrics:
      options.noRubric === true
        ? []
        : [
            {
              scope: 'overall',
              trackKey: null,
              name: 'Official rubric',
              scaleMin: 0,
              scaleMax: 10,
              sourceIds: [],
              origin: 'human',
              humanModified: false,
              criteria: criteriaOf(options).map((criterion) => ({
                key: criterion.key,
                name: criterion.key.replaceAll('_', ' '),
                description: `Published description of ${criterion.key}.`,
                weight: criterion.weight,
                anchors: criterion.anchors ?? [],
                sourceIds: [],
                origin: 'human' as const,
                humanModified: false,
              })),
            },
          ],
  };
}

/** Creates and freezes the next version of an event's context, the way M1 does (supersede the old lock, then lock the new). */
export async function seedLockedContext(
  db: JudgeDatabase,
  eventId: string,
  options: WorldOptions = {},
) {
  const document = contextDocument(options);
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
  const hash = lockedContentHash({ document, sources: [] });
  if (previous?.status === 'locked') {
    await db.execute(
      sql`UPDATE event_context_versions SET status = 'superseded' WHERE id = ${previous.id}`,
    );
  }
  await db.execute(
    sql`UPDATE event_context_versions SET status = 'locked', locked_at = now(), locked_content_hash = ${hash} WHERE id = ${version.id}`,
  );
  return { versionId: version.id, version: version.version, document, hash };
}

interface ArtifactSeed {
  key: string;
  kind: 'file' | 'http_response' | 'submission_text' | 'page_text' | 'video_metadata';
  mediaType: string;
  text: string;
}

/** A declaration URL in the canonical form the database requires for GitHub and Devpost sources (test hosts for the other kinds). */
function declaredTestUrl(sourceType: string, unique: string): string {
  if (sourceType === 'github') return `https://github.com/test-org/repo-${unique}`;
  if (sourceType === 'devpost') return `https://devpost.com/software/test-${unique}`;
  return `https://example.test/${sourceType}/${unique}`;
}

export async function seedSnapshot(
  db: JudgeDatabase,
  project: { id: string },
  sourceType: ProjectSourceType,
  status: 'captured' | 'partial' | 'failed',
  artifacts: readonly ArtifactSeed[] = [],
) {
  const n = next();
  const url = declaredTestUrl(sourceType, String(n));
  const [source] = await db
    .insert(projectSources)
    .values({ projectId: project.id, sourceType, url, position: n })
    .returning();
  if (!source) throw new Error('source');
  const [snapshot] = await db
    .insert(sourceSnapshots)
    .values({
      projectId: project.id,
      projectSourceId: source.id,
      captureNumber: 1,
      sourceType,
      sourceUrl: url,
      status: 'pending',
    })
    .returning();
  if (!snapshot) throw new Error('snapshot');
  const stored: { id: string; key: string; text: string }[] = [];
  for (const artifact of artifacts) {
    const [row] = await db
      .insert(sourceSnapshotArtifacts)
      .values({
        snapshotId: snapshot.id,
        artifactKey: artifact.key,
        artifactKind: artifact.kind,
        mediaType: artifact.mediaType,
        textContent: artifact.text,
        byteLength: Buffer.byteLength(artifact.text),
        contentHash: sha256(artifact.text),
      })
      .returning();
    if (!row) throw new Error('artifact');
    stored.push({ id: row.id, key: artifact.key, text: artifact.text });
  }
  const revision = sourceType === 'github' ? 'a'.repeat(40) : null;
  if (status === 'captured') {
    await db.execute(sql`UPDATE source_snapshots SET status = 'captured', revision = ${revision},
      metadata = '{}'::jsonb, content_hash = ${sha256(snapshot.id)}, captured_at = now(), completed_at = now()
      WHERE id = ${snapshot.id}`);
  } else if (status === 'partial') {
    await db.execute(sql`UPDATE source_snapshots SET status = 'partial', revision = ${revision},
      partial_reasons = ARRAY['file_count_limit']::text[], metadata = '{}'::jsonb,
      content_hash = ${sha256(snapshot.id)}, captured_at = now(), completed_at = now()
      WHERE id = ${snapshot.id}`);
  } else {
    await db.execute(sql`UPDATE source_snapshots SET status = 'failed', failure_category = 'timeout',
      failure_metadata = '{}'::jsonb, completed_at = now() WHERE id = ${snapshot.id}`);
  }
  return { snapshot, source, artifacts: stored };
}

/**
 * A later capture attempt of an ALREADY declared source (capture number = previous + 1), ending in `status` with the given artifacts.
 * Test-only: it lets a scenario change a project's material after an assessment was made.
 */
export async function seedLaterCapture(
  db: JudgeDatabase,
  project: { id: string },
  source: { id: string; sourceType: ProjectSourceType; url: string },
  status: 'captured' | 'partial' | 'failed',
  artifacts: readonly ArtifactSeed[] = [],
) {
  const previous = (await db.select().from(sourceSnapshots)).filter(
    (row) => row.projectSourceId === source.id,
  );
  const captureNumber = Math.max(0, ...previous.map((row) => row.captureNumber)) + 1;
  const [snapshot] = await db
    .insert(sourceSnapshots)
    .values({
      projectId: project.id,
      projectSourceId: source.id,
      captureNumber,
      sourceType: source.sourceType,
      sourceUrl: source.url,
      status: 'pending',
    })
    .returning();
  if (!snapshot) throw new Error('snapshot');
  for (const artifact of artifacts) {
    await db.insert(sourceSnapshotArtifacts).values({
      snapshotId: snapshot.id,
      artifactKey: artifact.key,
      artifactKind: artifact.kind,
      mediaType: artifact.mediaType,
      textContent: artifact.text,
      byteLength: Buffer.byteLength(artifact.text),
      contentHash: sha256(artifact.text),
    });
  }
  if (status === 'failed') {
    await db.execute(sql`UPDATE source_snapshots SET status = 'failed', failure_category = 'timeout',
      failure_metadata = '{}'::jsonb, completed_at = now() WHERE id = ${snapshot.id}`);
  } else {
    const revision = source.sourceType === 'github' ? 'b'.repeat(40) : null;
    await db.execute(sql`UPDATE source_snapshots SET status = ${status}, revision = ${revision},
      metadata = '{}'::jsonb, content_hash = ${sha256(snapshot.id)}, captured_at = now(), completed_at = now()
      WHERE id = ${snapshot.id}`);
  }
  return snapshot;
}

export async function seedWorld(db: JudgeDatabase, options: WorldOptions = {}) {
  const n = next();
  const [event] = await db
    .insert(events)
    .values({
      name: `Pipeline World ${String(n)}`,
      slug: `pipeline-world-${String(n)}-${String(Date.now())}`,
    })
    .returning();
  if (!event) throw new Error('event');
  const [actor] = await db
    .insert(actors)
    .values({ issuer: 'https://issuer.test', subject: `judge-${String(n)}-${String(Date.now())}` })
    .returning();
  if (!actor) throw new Error('actor');
  const context = await seedLockedContext(db, event.id, options);
  const [project] = await db
    .insert(projects)
    .values({ eventId: event.id, name: options.projectName ?? `HydroTrack ${String(n)}` })
    .returning();
  if (!project) throw new Error('project');
  const wanted = options.sources ?? ['devpost', 'github'];
  const snapshots: Record<string, Awaited<ReturnType<typeof seedSnapshot>>> = {};
  if (wanted.includes('devpost')) {
    snapshots['devpost'] = await seedSnapshot(db, project, 'devpost', 'captured', [
      {
        key: 'submission.txt',
        kind: 'submission_text',
        mediaType: 'text/plain',
        text: options.devpostText ?? DEVPOST_TEXT,
      },
    ]);
  }
  if (wanted.includes('github')) {
    snapshots['github'] = await seedSnapshot(
      db,
      project,
      'github',
      options.partialRepository ? 'partial' : 'captured',
      [
        {
          key: 'files/README.md',
          kind: 'file',
          mediaType: 'text/markdown',
          text: options.readmeText ?? README_TEXT,
        },
        {
          key: 'files/src/remind.ts',
          kind: 'file',
          mediaType: 'text/plain',
          text: options.codeText ?? SOURCE_CODE_TEXT,
        },
        ...(options.extraFiles ?? []).map((file) => ({
          key: `files/${file.path}`,
          kind: 'file',
          mediaType: 'text/plain',
          text: file.text,
        })),
      ],
    );
  }
  if (wanted.includes('deployment')) {
    snapshots['deployment'] = await seedSnapshot(db, project, 'deployment', 'captured', [
      {
        key: 'page.txt',
        kind: 'page_text',
        mediaType: 'text/plain',
        text: 'HydroTrack - track your water.\nSign in to see your history.\n',
      },
    ]);
  }
  for (const failed of options.failed ?? []) {
    snapshots[`${failed}:failed`] = await seedSnapshot(db, project, failed, 'failed');
  }
  for (const key of options.declare ?? [])
    await declareTrack(db, project.id, event.id, context.versionId, key, actor.id);
  return { event, actor, context, project, snapshots };
}

export type World = Awaited<ReturnType<typeof seedWorld>>;

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
  await db.insert(projectTrackSelections).values({
    projectId,
    eventId,
    contextVersionId: versionId,
    trackId: track.id,
    trackKey,
    declaredByActorId: actorId,
  });
}

/** Locks a NEW context version for the event (superseding the old one), as a re-lock by the organizer would. */
export async function relockContext(db: JudgeDatabase, world: World, options: WorldOptions = {}) {
  return seedLockedContext(db, world.event.id, options);
}

// -- Pipeline construction ------------------------------------------------------------------------------------------------------

export const TEST_MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
} as const;

export function testConfig(
  provider: Pick<LlmProvider, 'id' | 'mode'>,
  overrides: Partial<Parameters<typeof buildPipelineConfig>[0]> = {},
): AssessmentPipelineConfig {
  return buildPipelineConfig({
    provider: { id: provider.id, mode: provider.mode },
    models: TEST_MODELS,
    ...overrides,
  });
}

export const FAST_RETRY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 2,
  maxRetryAfterMs: 60_000,
};

export interface Harness {
  readonly runs: AssessmentRunStore;
  readonly extractions: GraphExtractionStore;
  readonly store: AssessmentStore;
  readonly reader: AssessmentInputReader;
  deps(provider: LlmProvider, overrides?: Partial<PipelineDeps>): PipelineDeps;
}

export function harness(
  db: JudgeDatabase,
  options: { now?: () => Date; clock?: Clock; ids?: string } = {},
): Harness {
  const runs = new AssessmentRunStore({
    db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const graphs = new EvidenceGraphStore({
    db,
    ...(options.ids === undefined ? {} : { ids: deterministicIdAllocator(options.ids) }),
  });
  const extractions = new GraphExtractionStore(db, graphs);
  const store = new AssessmentStore(db, options.now === undefined ? {} : { now: options.now });
  const reader = new AssessmentInputReader(db);
  const { logger } = memoryLogger();
  return {
    runs,
    extractions,
    store,
    reader,
    deps: (provider, overrides = {}) => ({
      db,
      runs,
      extractions,
      store,
      reader,
      provider,
      clock: options.clock ?? systemClock,
      random: () => 0.5,
      logger,
      leaseMs: 60_000,
      retry: FAST_RETRY,
      shutdown: new AbortController().signal,
      ...overrides,
    }),
  };
}

let keyCounter = 0;

/** Requests a run exactly as the API will (through the run store), with a configuration that matches `provider`. */
export async function requestRun(
  h: Harness,
  world: World,
  provider: Pick<LlmProvider, 'id' | 'mode'>,
  options: {
    limits?: Partial<AssessmentRunLimits>;
    config?: AssessmentPipelineConfig;
    mode?: 'assess' | 'reassess';
    idempotencyKey?: string;
  } = {},
): Promise<string> {
  keyCounter += 1;
  const result = await h.runs.requestAssessment({
    projectId: world.project.id,
    actorId: world.actor.id,
    idempotencyKey:
      options.idempotencyKey ?? `key-${String(Date.now())}-${String(keyCounter)}-abcdefgh`,
    mode: options.mode ?? 'assess',
    target: { kind: 'overall' },
    pipelineConfig: options.config ?? testConfig(provider),
    limits: AssessmentRunLimits.parse(options.limits ?? {}),
    priceTableId: 'prices/v1',
  });
  if (result.kind !== 'run_created') throw new Error(`request failed: ${result.kind}`);
  return result.runId;
}
