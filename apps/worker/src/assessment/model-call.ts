import {
  BudgetDeniedBackstopError,
  CallNotReservedError,
  InvalidCallMetadataError,
  RunNotRunningError,
  type CallBinding,
} from '@judge-copilot/database';
import {
  computeRequestDigest,
  jsonSchemaFor,
  type LlmFailure,
  type LlmProvider,
  type StructuredRequest,
} from '@judge-copilot/llm';
import {
  FallbackAnchorsNotApprovedError,
  PromptInputError,
  PromptSecretError,
  renderPrompt,
  requestFields,
} from '@judge-copilot/prompts';
import {
  ASSESSMENT_STAGE_OUTPUT_SCHEMAS,
  type AssessmentStage,
  type StageOutputIssue,
} from '@judge-copilot/schemas';
import type { AssessmentPipelineConfig } from './config.js';
import type { RecordingBudget } from './ledger.js';
import type { RunSession } from './session.js';
import { failRun, RunStopped } from './stop.js';

/*
 * One model-backed stage call, end to end (design §6, §9.4). The ONLY place the orchestrator talks to a provider:
 *
 *   render        a pure function of the stage input; the closed set it returns describes exactly the prompt that is sent
 *   register      the closed set + non-secret metadata are bound to the request digest in the ledger BEFORE the call
 *   generate      through the guarded provider (retry( budget( timeout( provider )))): every attempt, including each transient retry
 *                 and the repair re-ask below, is its own reservation. NO transaction is open while it runs.
 *   bind          the answer is validated against the closed set READ BACK from the ledger row of the successful attempt
 *   validate      Zod (shape) then the P3 domain gate; invalid output gets exactly ONE repair re-ask, then the call reports `invalid`
 *
 * The prompts of P2 have no channel for repair feedback, so the re-ask re-sends the IDENTICAL request (same digest). That keeps every
 * digest, ledger binding and replay key stable and sends no model-produced text into any later prompt (a Zod issue path or a critic
 * note is never an instruction channel). A live model may answer differently; a replayed one cannot, by design.
 *
 * A failure that ends the whole run (outage, timeout, exhausted guard, lost lease) is thrown as `RunStopped`; failures the caller
 * decides about (a refusal, a truncation, an answer that stayed invalid) are returned.
 */

/** The closed set of one call, exactly the five handle lists and the unit of `RenderedPrompt.closedSet`. */
export interface BoundClosedSet {
  readonly passages: readonly string[];
  readonly claims: readonly string[];
  readonly evidence: readonly string[];
  readonly pairs: readonly string[];
  readonly items: readonly string[];
  readonly unit: string | null;
}

export type Validated<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /** The answer is valid but mostly rejected item by item: worth the one repair re-ask (design §9.3 row 2). */
      readonly weak?: boolean;
      /** Larger is better; used to choose between the first answer and the re-ask when both were weak. */
      readonly quality?: number;
    }
  | {
      readonly ok: false;
      readonly phase: 'shape' | 'domain';
      readonly issues?: readonly StageOutputIssue[];
    };

export interface StageCall<T> {
  readonly stage: AssessmentStage;
  readonly role: 'extraction' | 'assessment' | 'critic';
  /** The prompt input (validated by the renderer against its allow-list schema). */
  readonly input: unknown;
  /** The one dimension an assessor or critic call is about. */
  readonly dimensionId?: string;
  readonly validate: (json: unknown, closedSet: BoundClosedSet) => Validated<T>;
}

export type CallResult<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly reasked: boolean }
  | { readonly kind: 'invalid'; readonly phase: 'shape' | 'domain' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'truncated' };

export interface ModelCallerDeps {
  readonly session: RunSession;
  readonly ledger: RecordingBudget;
  /** The GUARDED provider of this run. */
  readonly provider: LlmProvider;
  readonly config: AssessmentPipelineConfig;
  /** Server-side secret values: any occurrence in a prompt aborts the render (defense in depth; nothing here is a secret). */
  readonly secrets?: readonly string[];
}

const schemaCache = new Map<AssessmentStage, Record<string, unknown>>();
function schemaFor(stage: AssessmentStage): Record<string, unknown> {
  let schema = schemaCache.get(stage);
  if (!schema) {
    schema = jsonSchemaFor(ASSESSMENT_STAGE_OUTPUT_SCHEMAS[stage]);
    schemaCache.set(stage, schema);
  }
  return schema;
}

const STRING_LIST_KEYS = ['passages', 'claims', 'evidence', 'pairs', 'items'] as const;

/** Reads the stored closed set back into its typed form; anything malformed is an internal error, never a fallback. */
export function asClosedSet(stored: Record<string, unknown>): BoundClosedSet {
  const lists: Record<string, readonly string[]> = {};
  for (const key of STRING_LIST_KEYS) {
    const value = stored[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return failRun('internal_error', 'closed_set_malformed', 'model_call');
    }
    lists[key] = value as string[];
  }
  const unit = stored['unit'];
  if (unit !== null && typeof unit !== 'string') {
    return failRun('internal_error', 'closed_set_malformed', 'model_call');
  }
  return {
    passages: lists['passages'] ?? [],
    claims: lists['claims'] ?? [],
    evidence: lists['evidence'] ?? [],
    pairs: lists['pairs'] ?? [],
    items: lists['items'] ?? [],
    unit,
  };
}

function runFailureOf(
  failure: LlmFailure,
): { category: 'provider_error' | 'timeout' | 'budget_exceeded'; code: string } | null {
  switch (failure.category) {
    case 'timeout':
      return { category: 'timeout', code: 'provider_timeout' };
    case 'rate_limited':
    case 'provider_unavailable':
      return { category: 'provider_error', code: failure.category };
    case 'auth':
    case 'bad_request':
    case 'replay_miss':
      return { category: 'provider_error', code: failure.category };
    case 'budget_exceeded':
      return failure.denial === 'wall_clock'
        ? { category: 'timeout', code: 'run_wall_clock_exceeded' }
        : { category: 'budget_exceeded', code: `budget_${failure.denial ?? 'denied'}` };
    case 'refused':
    case 'truncated':
    case 'cancelled':
      return null;
  }
}

export class ModelCaller {
  constructor(private readonly deps: ModelCallerDeps) {}

  async call<T>(spec: StageCall<T>): Promise<CallResult<T>> {
    const { session, ledger, provider } = this.deps;
    session.checkpoint(spec.stage);
    const request = this.buildRequest(spec);
    const digest = computeRequestDigest(request);
    ledger.register(digest, {
      provider: provider.id,
      providerMode: provider.mode,
      ...(spec.dimensionId === undefined ? {} : { dimensionId: spec.dimensionId }),
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      promptTemplateHash: request.promptTemplateHash,
      schemaId: request.schemaId,
      schemaVersion: request.schemaVersion,
      generationSettings: {
        ...(request.generation.effort === undefined ? {} : { effort: request.generation.effort }),
        maxOutputTokens: request.generation.maxOutputTokens,
        timeoutMs: request.generation.timeoutMs,
      },
      closedSet: this.rendered(spec).closedSet as unknown as Record<string, unknown>,
    });

    let first: Validated<T> | null = null;
    for (let ask = 0; ask < 2; ask += 1) {
      session.checkpoint(spec.stage);
      const bound = await this.generateOnce(spec, request, digest);
      if (bound.kind !== 'answer') return bound;
      const validated = spec.validate(bound.json, bound.closedSet);
      if (validated.ok && validated.weak !== true) {
        return { kind: 'ok', value: validated.value, reasked: ask > 0 };
      }
      if (ask === 0) {
        first = validated;
        continue;
      }
      // the single re-ask is spent: keep the better usable answer, otherwise report that the answer stayed invalid
      if (validated.ok) {
        const keepFirst =
          first !== null && first.ok && (first.quality ?? 0) > (validated.quality ?? 0);
        return {
          kind: 'ok',
          value: keepFirst && first !== null && first.ok ? first.value : validated.value,
          reasked: true,
        };
      }
      if (first !== null && first.ok) return { kind: 'ok', value: first.value, reasked: true };
      return { kind: 'invalid', phase: validated.phase };
    }
    // unreachable: the loop always returns on its second pass
    return failRun('internal_error', 'model_call_loop', spec.stage);
  }

  private renderedCache = new Map<object, ReturnType<typeof renderPrompt>>();

  private rendered<T>(spec: StageCall<T>): ReturnType<typeof renderPrompt> {
    const cached = this.renderedCache.get(spec);
    if (cached) return cached;
    try {
      const rendered = renderPrompt(spec.stage, spec.input, {
        ...(this.deps.secrets === undefined ? {} : { secrets: this.deps.secrets }),
      });
      this.renderedCache.set(spec, rendered);
      return rendered;
    } catch (error) {
      if (error instanceof FallbackAnchorsNotApprovedError) {
        return failRun('domain_validation_failed', 'fallback_anchors_not_approved', spec.stage);
      }
      if (error instanceof PromptSecretError) {
        return failRun('internal_error', 'prompt_contains_secret', spec.stage);
      }
      if (error instanceof PromptInputError) {
        return failRun('internal_error', 'prompt_input_invalid', spec.stage);
      }
      throw error;
    }
  }

  private buildRequest<T>(spec: StageCall<T>): StructuredRequest {
    const { config, provider } = this.deps;
    const rendered = this.rendered(spec);
    const effort = config.generation.effort;
    return {
      ...requestFields(rendered),
      provider: provider.id,
      model: config.models[spec.role],
      jsonSchema: schemaFor(spec.stage),
      generation: {
        ...(effort === undefined ? {} : { effort }),
        maxOutputTokens: config.generation.maxOutputTokens[spec.role],
        timeoutMs: config.generation.timeoutMs,
      },
    };
  }

  /** One `generate` (with its internal transient retries), bound to its ledger row. */
  private async generateOnce<T>(
    spec: StageCall<T>,
    request: StructuredRequest,
    digest: string,
  ): Promise<
    | { kind: 'answer'; json: unknown; closedSet: BoundClosedSet }
    | { kind: 'refused' }
    | { kind: 'truncated' }
  > {
    const { session, ledger, provider } = this.deps;
    ledger.drainAttempts();
    let result;
    try {
      result = await provider.generate(request, session.signal);
    } catch (error) {
      if (error instanceof RunNotRunningError || error instanceof CallNotReservedError) {
        // the run ended under this worker (recovered, cancelled or finished by someone else): it must not write anything about it
        session.markLost();
        throw new RunStopped({ kind: 'lost', stage: spec.stage });
      }
      if (error instanceof BudgetDeniedBackstopError) {
        return failRun('budget_exceeded', 'ledger_backstop_denied', spec.stage);
      }
      if (error instanceof InvalidCallMetadataError) {
        return failRun('internal_error', 'call_metadata_invalid', spec.stage);
      }
      throw error;
    }
    const attempts = ledger.drainAttempts();
    if (!result.ok) {
      if (result.category === 'cancelled') {
        if (session.reason === null) {
          return failRun('internal_error', 'unexpected_cancellation', spec.stage);
        }
        throw new RunStopped(session.stopFor(spec.stage));
      }
      if (result.category === 'refused') return { kind: 'refused' };
      if (result.category === 'truncated') return { kind: 'truncated' };
      const run = runFailureOf(result);
      if (run === null) return failRun('internal_error', 'unclassified_failure', spec.stage);
      return failRun(run.category, run.code, spec.stage);
    }
    // the successful attempt is the last settled `ok` one of this window
    const success = [...attempts]
      .reverse()
      .find((attempt) => attempt.settlement === 'measured' && attempt.outcomeCode === 'ok');
    if (!success) return failRun('internal_error', 'successful_call_not_in_ledger', spec.stage);
    const binding: CallBinding | null = await ledger.bindingOf(success.callId);
    if (!binding || binding.requestDigest !== digest || binding.stage !== spec.stage) {
      return failRun('internal_error', 'closed_set_unbound', spec.stage);
    }
    if ((binding.dimensionId ?? null) !== (spec.dimensionId ?? null)) {
      return failRun('internal_error', 'closed_set_wrong_dimension', spec.stage);
    }
    const closedSet = asClosedSet(binding.closedSet);
    // the stored set must be the one this prompt actually offered; a mismatch means the binding is not about this request
    const offered = this.rendered(spec).closedSet;
    if (
      JSON.stringify([...closedSet.evidence]) !== JSON.stringify([...offered.evidence]) ||
      JSON.stringify([...closedSet.passages]) !== JSON.stringify([...offered.passages]) ||
      closedSet.unit !== offered.unit
    ) {
      return failRun('internal_error', 'closed_set_differs_from_prompt', spec.stage);
    }
    return { kind: 'answer', json: result.json, closedSet };
  }
}
