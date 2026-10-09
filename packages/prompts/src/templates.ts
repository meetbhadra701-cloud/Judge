import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  ASSESSMENT_STAGE_OUTPUT_SCHEMAS,
  ASSESSMENT_STAGE_VALUES,
  type AssessmentStage,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import type { BlockKind } from './frame.js';
import { FRAMING_VERSION, PREAMBLE, TASKS } from './system.js';

/*
 * The nine FROZEN stage prompts. A prompt is identified by (id, version); its template hash covers everything that defines
 * it: id, version, stage, schema identifiers, the hash of the output JSON Schema it asks for, the full trusted system text,
 * the framing version and the block layout. The golden file `golden/template-hashes.json` pins every hash, so changing a
 * word of an instruction, the output schema or the layout without bumping the version fails a test. A new wording is a new
 * VERSION (`v2`), never an edit: old outputs stay attributable to the exact prompt that produced them.
 */

export const PROMPT_VERSION = 'v1' as const;

const IDS: Readonly<Record<AssessmentStage, string>> = {
  claim_extraction: 'claim-extraction',
  evidence_interpretation: 'evidence-interpretation',
  fidelity_review: 'fidelity-review',
  relation_matching: 'relation-matching',
  relation_verification: 'relation-verification',
  contradiction_detection: 'contradiction-detection',
  unknown_identification: 'unknown-identification',
  dimension_assessment: 'dimension-assessment',
  critic: 'critic',
};

const BLOCKS: Readonly<Record<AssessmentStage, readonly BlockKind[]>> = {
  claim_extraction: ['data'],
  evidence_interpretation: ['data'],
  fidelity_review: ['data'],
  relation_matching: ['data'],
  relation_verification: ['data'],
  contradiction_detection: ['data'],
  unknown_identification: ['data'],
  dimension_assessment: ['standard', 'data'],
  critic: ['standard', 'data'],
};

export interface StagePrompt {
  readonly stage: AssessmentStage;
  readonly id: string;
  readonly version: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  /** SHA-256 of the output JSON Schema this prompt asks for (the same schema `llm.jsonSchemaFor` sends). */
  readonly outputSchemaHash: string;
  readonly blocks: readonly BlockKind[];
  /** The complete trusted instruction text, WITHOUT the per-request marker clause. */
  readonly systemBase: string;
  readonly templateHash: string;
}

function outputSchemaHashOf(stage: AssessmentStage): string {
  const jsonSchema = z.toJSONSchema(ASSESSMENT_STAGE_OUTPUT_SCHEMAS[stage], {
    io: 'input',
    unrepresentable: 'any',
  });
  return sha256Hex(canonicalJson(jsonSchema));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function build(stage: AssessmentStage): StagePrompt {
  const id = IDS[stage];
  const blocks = BLOCKS[stage];
  const systemBase = `${PREAMBLE}\n\n${TASKS[stage]}`;
  const outputSchemaHash = outputSchemaHashOf(stage);
  const templateHash = sha256Hex(
    canonicalJson({
      v: 'prompt-template/v1',
      id,
      version: PROMPT_VERSION,
      stage,
      schemaId: id,
      schemaVersion: PROMPT_VERSION,
      outputSchemaHash,
      framing: FRAMING_VERSION,
      blocks,
      systemBase,
    }),
  );
  return {
    stage,
    id,
    version: PROMPT_VERSION,
    schemaId: id,
    schemaVersion: PROMPT_VERSION,
    outputSchemaHash,
    blocks: [...blocks],
    systemBase,
    templateHash,
  };
}

export const PROMPTS: Readonly<Record<AssessmentStage, StagePrompt>> = deepFreeze(
  Object.fromEntries(ASSESSMENT_STAGE_VALUES.map((stage) => [stage, build(stage)])) as Record<
    AssessmentStage,
    StagePrompt
  >,
);

export function promptFor(stage: AssessmentStage): StagePrompt {
  return PROMPTS[stage];
}

/** A flat, ordered list of every frozen prompt (for audit, the ledger and the golden file). */
export const PROMPT_REGISTRY: readonly {
  readonly stage: AssessmentStage;
  readonly id: string;
  readonly version: string;
  readonly templateHash: string;
  readonly outputSchemaHash: string;
}[] = Object.freeze(
  ASSESSMENT_STAGE_VALUES.map((stage) => {
    const { id, version, templateHash, outputSchemaHash } = PROMPTS[stage];
    return Object.freeze({ stage, id, version, templateHash, outputSchemaHash });
  }),
);
