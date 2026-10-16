import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { ASSESSMENT_STAGE_VALUES, type CoverageRecord } from '@judge-copilot/schemas';
import type { BuiltCoverageRecord } from '../coverage-record.js';
import { buildCoverageRecord } from '../coverage-record.js';
import type {
  TrustedArtifactMeta,
  TrustedCoverageEvidence,
  TrustedPin,
} from '../coverage-provenance.js';
import { extractionConfigHash, ladder, type EffectivePlan } from '../extraction-plan.js';
import { buildPipelineConfig, type AssessmentPipelineConfig } from '../pipeline-config.js';
import { runNotices } from '../run-notices.js';
import {
  buildPassages,
  type SelectionPolicyId,
  type SourceArtifact,
  type WindowingBudgets,
} from '../windowing.js';

/*
 * TEST SUPPORT (coverage provenance, P6B-beta3-R2): everything a trusted loader would hand the verifier, built from a list of artifacts, together
 * with the record the pipeline would have written for it. No I/O, no randomness (ids and hashes derive from names).
 */

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');
export const uuidOf = (seed: string): string => {
  const h = hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface WorldFile {
  readonly sourceType: 'github' | 'devpost' | 'deployment' | 'video';
  readonly key: string;
  readonly text: string;
  readonly kind?: string;
  readonly mediaType?: string;
}
export interface WorldOptions {
  readonly selection?: SelectionPolicyId;
  readonly partial?: readonly ('github' | 'devpost' | 'deployment' | 'video')[];
  readonly suppliedDevpost?: boolean;
  /** Ladder step (0 = full budgets). */
  readonly step?: number;
  /** A run with no source extraction (refused at the gate): the plan cannot be pinned. */
  readonly noExtraction?: boolean;
  readonly baseBudgets?: Partial<WindowingBudgets>;
}

export interface World {
  readonly config: AssessmentPipelineConfig;
  readonly plan: EffectivePlan;
  readonly evidence: TrustedCoverageEvidence;
  readonly texts: readonly (TrustedArtifactMeta & { readonly text: string })[];
  readonly artifacts: readonly SourceArtifact[];
  readonly built: BuiltCoverageRecord;
  readonly record: CoverageRecord;
}

const FAKE_PROMPTS = ASSESSMENT_STAGE_VALUES.map((stage) => ({
  stage,
  id: `${stage}-prompt`,
  version: 'v1',
  templateHash: hex(stage),
}));

export function makeWorld(files: readonly WorldFile[], options: WorldOptions = {}): World {
  const base = buildPipelineConfig({
    prompts: FAKE_PROMPTS,
    provider: { id: 'replay', mode: 'replay' },
    models: { extraction: 'm-extract', assessment: 'm-assess', critic: 'm-critic' },
    ...(options.baseBudgets === undefined ? {} : { windowing: options.baseBudgets }),
  });
  const config: AssessmentPipelineConfig =
    options.selection === undefined
      ? base
      : { ...base, policies: { ...base.policies, selection: options.selection } };
  const plan = ladder(config.windowing)[options.step ?? 0] as EffectivePlan;
  const types = [...new Set(files.map((f) => f.sourceType))].sort();
  const pins: TrustedPin[] = types.map((sourceType) => ({
    snapshotId: uuidOf(`snapshot:${sourceType}`),
    pinnedContentHash: hex(`snapshot-content:${sourceType}`),
    projectId: PROJECT_ID,
    sourceType,
    status: options.partial?.includes(sourceType) === true ? 'partial' : 'captured',
    contentHash: hex(`snapshot-content:${sourceType}`),
    provenance:
      sourceType === 'devpost' && options.suppliedDevpost === true
        ? 'organizer_supplied'
        : 'fetched',
    partialReasons: options.partial?.includes(sourceType) === true ? ['file_count_limit'] : [],
  }));
  const pinByType = new Map(pins.map((pin) => [pin.sourceType, pin] as const));
  const texts = files.map((file) => {
    const pin = pinByType.get(file.sourceType) as TrustedPin;
    return {
      snapshotId: pin.snapshotId,
      artifactId: uuidOf(`artifact:${file.sourceType}:${file.key}`),
      key: file.key,
      kind: file.kind ?? 'file',
      mediaType: file.mediaType ?? 'text/plain',
      contentHash: hex(file.text),
      codePoints: Array.from(file.text).length,
      text: file.text,
    };
  });
  const artifacts: SourceArtifact[] = texts.map((t) => {
    const pin = pins.find((p) => p.snapshotId === t.snapshotId) as TrustedPin;
    return {
      snapshotId: t.snapshotId,
      artifactId: t.artifactId,
      sourceType: pin.sourceType,
      snapshotStatus: pin.status,
      key: t.key,
      kind: t.kind,
      mediaType: t.mediaType,
      text: t.text,
    };
  });
  const windowing = buildPassages(artifacts, plan.budgets, config.policies.selection);
  const built = buildCoverageRecord({
    windowing,
    budgets: plan.budgets,
    snapshots: pins.map((pin) => ({
      snapshotId: pin.snapshotId,
      sourceType: pin.sourceType,
      status: pin.status as 'captured' | 'partial',
      contentHash: pin.contentHash,
      provenance: pin.provenance,
      partialReasons: pin.partialReasons,
    })),
    notices: runNotices(windowing, pins),
  });
  const evidence: TrustedCoverageEvidence = {
    runId: uuidOf('run'),
    projectId: PROJECT_ID,
    config,
    pins,
    artifacts: texts.map(({ text: _text, ...meta }) => meta),
    boundSourceConfigHash:
      options.noExtraction === true ? null : extractionConfigHash(config, plan),
  };
  return { config, plan, evidence, texts, artifacts, built, record: built.record };
}

export const canonicalOf = (record: unknown): { canonical: string; sha256: string } => {
  const canonical = canonicalJson(record);
  return { canonical, sha256: sha256Hex(canonical) };
};
