import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  EXPECTED_INFORMATION_VALUES,
  QUESTION_LIMITS,
  QUESTION_MODE_VALUES,
  QUESTION_OUTPUT_SCHEMA_ID,
  QUESTION_OUTPUT_SCHEMA_VERSION,
  QUESTION_SET_SIZE,
  QuestionCandidatesOutput,
  type QuestionStage,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import { PromptInputError, PromptSecretError, type PromptIssue } from './errors.js';
import {
  blockBegin,
  blockEnd,
  deriveBoundary,
  deriveItemMarkers,
  markerClause,
  type FramedItem,
  type HashFn,
} from './frame.js';
import { checkSecrets, deepFreeze, itemText, walkStrings } from './render.js';
import { FRAMING_VERSION, PREAMBLE } from './system.js';

/*
 * The prompt of the ONE model-backed stage M6 adds: PHRASING candidate interview questions for uncertainties that deterministic code already found.
 * It is a separate frozen identity (`question-candidates` / `v1`), pinned by its own golden hash, and it follows the same structural trust boundary
 * as the assessment prompts: trusted instructions only in the system message; every character that came from a project (a claim, an unknown, a
 * criterion name, an observation that quotes a team statement) only inside deterministically marked records; records named by code-assigned
 * handles, never by persisted ids. The model proposes no rank, score or weight: the output schema has no field for one.
 */

export const QUESTION_PROMPT_VERSION = 'v1' as const;
export const QUESTION_PROMPT_ID = QUESTION_OUTPUT_SCHEMA_ID;

const QUESTION_TASK = [
  'TASK: candidate interview questions.',
  'A human judge will interview the team for a few minutes. The data block lists UNCERTAINTIES (handles O-...) that a deterministic analysis found in an existing assessment, the rubric dimensions they bear on (D-...), and the records they rest on: claims (C-...), recorded unknowns (X-...), evidence (E-...), recorded contradictions (K-...), event or track requirements (R-...), declared tracks (T-...) and coverage signals (V-...).',
  `Write candidate questions a judge could ask to clarify those uncertainties, at most ${String(QUESTION_LIMITS.perOpportunityMax)} per uncertainty and at most ${String(QUESTION_LIMITS.candidatesMax)} in all. You only PHRASE questions. You never rank, score, select or weight anything, and you never decide how many questions are asked.`,
  `Each candidate has: "mode" (one of ${QUESTION_MODE_VALUES.join(', ')}); "text" (exactly ONE question, at most ${String(QUESTION_LIMITS.questionMaxChars)} characters, speakable aloud); "reason" (one or two neutral sentences, at most ${String(QUESTION_LIMITS.reasonMaxChars)} characters, saying why the answer matters to the event's rubric); "expectedInformation" (the kinds of answer that would settle it, from ${EXPECTED_INFORMATION_VALUES.join(', ')}); "opportunities" (the O- handles it addresses); "dimensions" (D- handles, each of which must belong to a cited uncertainty); "references" (C-, X-, E-, K-, R-, T- or V- handles it draws on, each of which must belong to a cited uncertainty); "distinguishes" (weak, moderate or strong: how well an answer would tell the competing interpretations apart); "effort" (brief, moderate or extended: how long answering would take).`,
  'Modes: "demonstrate" asks the team to show it working; "show_me" asks them to open or point to a specific artifact; "verify" asks how a figure or statement can be checked; "clarify" asks for the meaning of something ambiguous; "ask" is a plain question. Prefer an observable request (demonstrate, show_me, verify) when the uncertainty is whether something exists or works.',
  'Rules. (1) A claim is only what the team states: never write a question that treats it as fact. When you refer to a statement, attribute it ("Your README states that ...") and ask about the statement. (2) Never accuse, suspect or imply misconduct; a recorded contradiction is something to ASK about neutrally. (3) Missing or uncaptured material is unknown, not weak: never imply that the team failed to provide it. Thin documentation or presentation is not an uncertainty. (4) One question per candidate: no lists, no second question, no multi-part requests. (5) Use only handles shown; never invent one, never write a persisted identifier, a URL, markup or code. (6) Do not repeat a question in different words. (7) If no good question can be written for an uncertainty without presupposing a claim, write none for it; an empty list is a valid answer.',
  `The judge decides which, if any, of your questions to ask and may ask others; your list is not shortlisted to ${String(QUESTION_SET_SIZE)} by you.`,
].join('\n');

const SYSTEM_BASE = `${PREAMBLE}\n\n${QUESTION_TASK}`;

function outputSchemaHash(): string {
  return sha256Hex(
    canonicalJson(
      z.toJSONSchema(QuestionCandidatesOutput, { io: 'input', unrepresentable: 'any' }),
    ),
  );
}

export interface QuestionPromptIdentity {
  readonly stage: QuestionStage;
  readonly id: typeof QUESTION_PROMPT_ID;
  readonly version: typeof QUESTION_PROMPT_VERSION;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly outputSchemaHash: string;
  readonly systemBase: string;
  readonly templateHash: string;
}

function buildIdentity(): QuestionPromptIdentity {
  const hash = outputSchemaHash();
  const templateHash = sha256Hex(
    canonicalJson({
      v: 'prompt-template/v1',
      id: QUESTION_PROMPT_ID,
      version: QUESTION_PROMPT_VERSION,
      stage: 'question_generation',
      schemaId: QUESTION_OUTPUT_SCHEMA_ID,
      schemaVersion: QUESTION_OUTPUT_SCHEMA_VERSION,
      outputSchemaHash: hash,
      framing: FRAMING_VERSION,
      blocks: ['data'],
      systemBase: SYSTEM_BASE,
    }),
  );
  return {
    stage: 'question_generation',
    id: QUESTION_PROMPT_ID,
    version: QUESTION_PROMPT_VERSION,
    schemaId: QUESTION_OUTPUT_SCHEMA_ID,
    schemaVersion: QUESTION_OUTPUT_SCHEMA_VERSION,
    outputSchemaHash: hash,
    systemBase: SYSTEM_BASE,
    templateHash,
  };
}

export const QUESTION_PROMPT: QuestionPromptIdentity = deepFreeze(buildIdentity());

// -- input -----------------------------------------------------------------------------------------------------------------------

const Text = (max: number) => z.string().max(max);

export const QUESTION_PROMPT_INPUT_LIMITS = {
  opportunities: 60,
  dimensions: 40,
  references: 200,
  text: 400,
  observation: 1_500,
} as const;

/** The strict allow-list input of the renderer: plain data derived from a closed set, with no persisted id. */
export const QuestionPromptInput = z.strictObject({
  rubricName: Text(QUESTION_PROMPT_INPUT_LIMITS.text),
  weightBasis: z.enum(['official', 'equal_for_ranking_only']),
  dimensions: z
    .array(
      z.strictObject({
        handle: z.string().regex(/^D-[0-9]{3,4}$/),
        name: Text(QUESTION_PROMPT_INPUT_LIMITS.text),
        weightShareMilli: z.number().int().min(0).max(1000),
      }),
    )
    .max(QUESTION_PROMPT_INPUT_LIMITS.dimensions),
  opportunities: z
    .array(
      z.strictObject({
        handle: z.string().regex(/^O-[0-9]{3,4}$/),
        kind: z.string().max(60),
        severity: z.enum(['critical', 'high', 'moderate', 'low']),
        observation: Text(QUESTION_PROMPT_INPUT_LIMITS.observation),
        dimensions: z.array(z.string().regex(/^D-[0-9]{3,4}$/)).max(40),
        references: z.array(z.string().regex(/^[A-Z]-[0-9]{3,4}$/)).max(40),
        clarifiedBy: z.array(z.string().max(40)).max(8),
      }),
    )
    .min(1)
    .max(QUESTION_PROMPT_INPUT_LIMITS.opportunities),
  references: z
    .array(
      z.strictObject({
        handle: z.string().regex(/^[A-Z]-[0-9]{3,4}$/),
        type: z.string().max(30),
        label: Text(QUESTION_PROMPT_INPUT_LIMITS.text),
        verificationLevel: z.string().max(40).nullable(),
      }),
    )
    .max(QUESTION_PROMPT_INPUT_LIMITS.references),
});
export type QuestionPromptInput = z.infer<typeof QuestionPromptInput>;

// -- render ----------------------------------------------------------------------------------------------------------------------

export interface RenderedQuestionPrompt {
  readonly stage: QuestionStage;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly promptTemplateHash: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly outputSchemaHash: string;
  readonly system: string;
  readonly user: readonly string[];
  readonly boundary: string;
}

export interface QuestionRenderOptions {
  readonly secrets?: readonly string[];
  readonly hash?: HashFn;
}

export function renderQuestionPrompt(
  input: unknown,
  options: QuestionRenderOptions = {},
): RenderedQuestionPrompt {
  const parsed = QuestionPromptInput.safeParse(input);
  if (!parsed.success) {
    const issues: PromptIssue[] = parsed.error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    }));
    throw new PromptInputError(issues);
  }
  const value = parsed.data;
  const secrets = checkSecrets(options.secrets);
  const scan = (text: string, path: string) => {
    for (const secret of secrets) if (text.includes(secret)) throw new PromptSecretError(path);
  };
  walkStrings(value, 'input', scan);

  const items: FramedItem[] = [
    {
      handle: 'RUBRIC',
      meta: {
        name: value.rubricName,
        weightBasis: value.weightBasis,
        notice:
          'dimension weight shares order the uncertainties for the judge; you cannot change them',
      },
    },
    ...value.dimensions.map((d): FramedItem => ({
      handle: d.handle,
      meta: { name: d.name, rubricShareMilli: d.weightShareMilli },
    })),
    ...value.opportunities.map((o): FramedItem => ({
      handle: o.handle,
      meta: {
        kind: o.kind,
        severity: o.severity,
        dimensions: o.dimensions,
        references: o.references,
        clarifiedBy: o.clarifiedBy,
      },
      body: o.observation,
    })),
    ...value.references.map((r): FramedItem => ({
      handle: r.handle,
      meta: { type: r.type, verificationLevel: r.verificationLevel },
      body: r.label,
    })),
  ];

  const dataText = canonicalJson(items);
  const seed = canonicalJson({
    systemBase: QUESTION_PROMPT.systemBase,
    promptId: QUESTION_PROMPT.id,
    promptVersion: QUESTION_PROMPT.version,
  });
  const boundary = deriveBoundary(seed, dataText, options.hash);
  const rendered = items.map((item) => {
    const content = `${canonicalJson(item.meta)}\u0000${item.body ?? ''}`;
    return itemText(
      deriveItemMarkers(boundary, item.handle, content, dataText, options.hash),
      item,
    );
  });
  const user = [[blockBegin('data', boundary), ...rendered, blockEnd('data', boundary)].join('\n')];
  const system = `${QUESTION_PROMPT.systemBase}\n\n${markerClause(boundary, ['data'])}`;

  scan(system, 'system');
  user.forEach((block, index) => {
    scan(block, `user[${String(index)}]`);
  });

  return deepFreeze({
    stage: QUESTION_PROMPT.stage,
    promptId: QUESTION_PROMPT.id,
    promptVersion: QUESTION_PROMPT.version,
    promptTemplateHash: QUESTION_PROMPT.templateHash,
    schemaId: QUESTION_PROMPT.schemaId,
    schemaVersion: QUESTION_PROMPT.schemaVersion,
    outputSchemaHash: QUESTION_PROMPT.outputSchemaHash,
    system,
    user,
    boundary,
  });
}

/** Exactly the request fields this renderer determines (see `requestFields` for the assessment prompts). */
export function questionRequestFields(rendered: RenderedQuestionPrompt) {
  return {
    stage: rendered.stage,
    promptId: rendered.promptId,
    promptVersion: rendered.promptVersion,
    promptTemplateHash: rendered.promptTemplateHash,
    schemaId: rendered.schemaId,
    schemaVersion: rendered.schemaVersion,
    system: rendered.system,
    user: rendered.user,
  } as const;
}
