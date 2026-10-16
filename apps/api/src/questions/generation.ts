import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { PersistQuestionSetInput } from '@judge-copilot/database';
import {
  computeRequestDigest,
  jsonSchemaFor,
  type LlmProvider,
  type StructuredRequest,
} from '@judge-copilot/llm';
import {
  QUESTION_PROMPT,
  questionRequestFields,
  renderQuestionPrompt,
} from '@judge-copilot/prompts';
import {
  buildClosedSet,
  promptViewOf,
  rankCandidates,
  referenceViewsOf,
  selectQuestions,
  validateCandidates,
  type ClosedSet,
} from '@judge-copilot/questions';
import {
  QUESTION_POLICY_VERSION,
  QuestionCandidatesOutput,
  UNCERTAINTY_ENGINE_VERSION,
  type QuestionReferenceView,
} from '@judge-copilot/schemas';
import {
  analyzeUncertainty,
  type UncertaintyInput,
  type UncertaintyReport,
} from '@judge-copilot/uncertainty';
import { QuestionApiError } from './errors.js';

/*
 * The question-generation pipeline (M6), as a function of its inputs. Nothing here touches a database: the caller reads a VERIFIED assessment before and persists the
 * result after, so no transaction is ever open while a provider is called.
 *
 *   analyze     deterministic uncertainty opportunities from the frozen assessment context          (uncertainty)
 *   close       code-assigned handles for everything a model may refer to                            (questions)
 *   phrase      ONE provider call renders candidate wording for those uncertainties                  (prompts + llm)
 *   validate    strict schema, then the domain gate: closed-set handles, wording rules             (questions)
 *   rank        a deterministic information-gain ordering                                            (questions)
 *   select      the five most valuable additions, never padded                                       (questions)
 *
 * The model's output can lower a candidate's value and can fail validation; it cannot add a handle, a score, a weight or a rank.
 */

export const GENERATION_SETTINGS = { maxOutputTokens: 8_000, timeoutMs: 60_000 } as const;

export interface GenerationRuntime {
  /** The guarded provider: retry( budget( timeout( base ) ) ). */
  readonly provider: LlmProvider;
  readonly model: string;
  /** Server-side secret values that must never reach a prompt. */
  readonly secrets: readonly string[];
}

export interface Prepared {
  readonly report: UncertaintyReport;
  readonly closed: ClosedSet;
  readonly inputHash: string;
  readonly generationKey: string;
  readonly request: StructuredRequest | null;
}

/** Everything a generation depends on, hashed: a second request with the same identity returns the stored set instead of calling a provider. */
export function generationKeyOf(parts: {
  readonly input: UncertaintyInput;
  readonly inputHash: string;
  readonly provider: { readonly id: string; readonly mode: string };
  readonly model: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 'question-set-key/v1',
      assessmentId: parts.input.assessment.id,
      reportOutputHash: parts.input.assessment.reportOutputHash,
      contextVersionId: parts.input.assessment.contextVersionId,
      policy: QUESTION_POLICY_VERSION,
      engine: UNCERTAINTY_ENGINE_VERSION,
      prompt: {
        id: QUESTION_PROMPT.id,
        version: QUESTION_PROMPT.version,
        templateHash: QUESTION_PROMPT.templateHash,
        outputSchemaHash: QUESTION_PROMPT.outputSchemaHash,
      },
      provider: parts.provider,
      model: parts.model,
      inputHash: parts.inputHash,
    }),
  );
}

export function prepare(
  input: UncertaintyInput,
  runtime: {
    readonly provider: { readonly id: string; readonly mode: string };
    readonly model: string;
    readonly secrets: readonly string[];
  },
): Prepared {
  const report = analyzeUncertainty(input);
  const closed = buildClosedSet(report, input);
  const inputHash = sha256Hex(canonicalJson(input));
  const generationKey = generationKeyOf({
    input,
    inputHash,
    provider: runtime.provider,
    model: runtime.model,
  });
  if (report.opportunities.length === 0) {
    return { report, closed, inputHash, generationKey, request: null };
  }
  const rendered = renderQuestionPrompt(
    promptViewOf(closed, {
      name: input.rubric.name,
      weightBasis: report.weightBasis,
    }),
    { secrets: runtime.secrets },
  );
  const request: StructuredRequest = {
    ...questionRequestFields(rendered),
    provider: runtime.provider.id,
    model: runtime.model,
    jsonSchema: jsonSchemaFor(QuestionCandidatesOutput),
    generation: { ...GENERATION_SETTINGS },
  };
  return { report, closed, inputHash, generationKey, request };
}

export interface GenerationOutcome {
  readonly persist: PersistQuestionSetInput;
}

export async function generate(
  input: UncertaintyInput,
  prepared: Prepared,
  runtime: GenerationRuntime & {
    readonly providerMode: 'live' | 'replay' | 'scripted';
    readonly providerId: string;
  },
  actorId: string | null,
  signal: AbortSignal,
): Promise<GenerationOutcome> {
  const { report, closed } = prepared;
  let candidatesRaw: unknown = { candidates: [] };
  let requestDigest: string | null = null;
  let candidateOutputHash: string | null = null;
  if (prepared.request !== null) {
    requestDigest = computeRequestDigest(prepared.request);
    const result = await runtime.provider.generate(prepared.request, signal);
    if (!result.ok) {
      throw new QuestionApiError(
        'QUESTION_GENERATION_FAILED',
        'The question provider could not produce candidates; no question set was stored',
        { category: result.category },
      );
    }
    candidatesRaw = result.json;
    candidateOutputHash = sha256Hex(canonicalJson(result.json));
  }

  const validated = validateCandidates(candidatesRaw, closed);
  if (!validated.outputValid) {
    throw new QuestionApiError(
      'QUESTION_OUTPUT_INVALID',
      'The question provider answered in a shape that is not accepted; no question set was stored',
      { problem: validated.problem },
    );
  }
  const ranked = rankCandidates(validated.accepted, report.opportunities);
  const selection = selectQuestions(ranked, {
    opportunities: report.opportunities.length,
    rejections: validated.rejected,
  });

  const opportunityByKey = new Map(report.opportunities.map((o) => [o.id, o] as const));
  const viewsByOpportunity = new Map<string, QuestionReferenceView[]>(
    report.opportunities.map((o) => [o.id, referenceViewsOf(closed, o)]),
  );
  const dimensionById = new Map(report.dimensions.map((d) => [d.id, d] as const));
  const referenceByKey = new Map(closed.references.map((r) => [`${r.type}:${r.id}`, r] as const));

  const persist: PersistQuestionSetInput = {
    projectId: input.assessment.projectId,
    assessmentId: input.assessment.id,
    actorId,
    contextVersionId: input.assessment.contextVersionId,
    extractionId: input.assessment.extractionId,
    reportOutputHash: input.assessment.reportOutputHash,
    policyVersion: QUESTION_POLICY_VERSION,
    uncertaintyEngineVersion: UNCERTAINTY_ENGINE_VERSION,
    weightBasis: report.weightBasis,
    generationKey: prepared.generationKey,
    inputHash: prepared.inputHash,
    provider: { mode: runtime.providerMode, id: runtime.providerId, model: runtime.model },
    prompt: {
      id: QUESTION_PROMPT.id,
      version: QUESTION_PROMPT.version,
      templateHash: QUESTION_PROMPT.templateHash,
      outputSchemaHash: QUESTION_PROMPT.outputSchemaHash,
    },
    requestDigest,
    candidateOutputHash,
    counts: selection.counts,
    shortfall: selection.shortfall,
    rejections: selection.rejections,
    opportunities: report.opportunities.map((o) => ({
      ordinal: o.ordinal,
      key: o.id,
      kind: o.kind,
      severity: o.severity,
      dimensionIds: o.dimensionIds,
      relevanceMilli: o.relevanceMilli,
      observation: o.observation,
      clarifiedBy: o.clarifiedBy,
      trail: o.trail.map(({ type, id, role }) => ({ type, id, role })),
      referenceViews: viewsByOpportunity.get(o.id) ?? [],
    })),
    questions: selection.selected.map((q) => {
      const own = q.references.flatMap((reference) => {
        const found = referenceByKey.get(`${reference.type}:${reference.id}`);
        return found
          ? [
              {
                type: found.type,
                id: found.id,
                label: found.label,
                ...(found.verificationLevel === null
                  ? {}
                  : { verificationLevel: found.verificationLevel }),
              } satisfies QuestionReferenceView,
            ]
          : [];
      });
      // a question that names no record of its own is linked to the records of the uncertainties it addresses
      const inherited = q.opportunityIds
        .flatMap((id) => viewsByOpportunity.get(id) ?? [])
        .filter((view) => view.type !== 'dimension');
      const merged = own.length > 0 ? own : inherited;
      const unique = new Map(merged.map((view) => [`${view.type}:${view.id}`, view] as const));
      return {
        rank: q.rank,
        candidateKey: q.key,
        mode: q.mode,
        text: q.text,
        reason: q.reason,
        expectedInformation: q.expectedInformation,
        dimensions: q.dimensionIds.flatMap((id) => {
          const d = dimensionById.get(id);
          return d ? [{ id: d.id, name: d.name, weightShareMilli: d.weightShareMilli }] : [];
        }),
        opportunityKeys: q.opportunityIds.filter((id) => opportunityByKey.has(id)),
        references: [...unique.values()].slice(0, 12),
        rankingValueBp: q.valueBp,
        marginalBp: q.marginalBp,
        noveltyMilli: q.noveltyMilli,
        factors: { ...q.factors },
      };
    }),
  };
  return { persist };
}
