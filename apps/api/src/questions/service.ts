import {
  AssessmentReadStore,
  QuestionInputReader,
  QuestionSetStore,
  type JudgeDatabase,
} from '@judge-copilot/database';
import {
  createGuardedProvider,
  InMemoryRunBudget,
  PRICES_V1,
  ReplayProvider,
  ScriptedProvider,
  systemClock,
  type LlmProvider,
  type RetryPolicy,
} from '@judge-copilot/llm';
import {
  AssessmentRunLimits,
  type CreateQuestionSetResponse,
  type QuestionSetListResponse,
  type QuestionSetView,
} from '@judge-copilot/schemas';
import { UncertaintyInputError } from '@judge-copilot/uncertainty';
import type { OfflineAssessmentRuntime } from '../assessments/runtime-gate.js';
import { questionDemonstrationStep } from './demonstration.js';
import { QuestionApiError } from './errors.js';
import { generate, prepare } from './generation.js';

export interface QuestionServiceOptions {
  readonly db: JudgeDatabase;
  /** The approved offline runtime (the same gate as the assessments), or null: reading still works, generating answers 503. */
  readonly offline: OfflineAssessmentRuntime | null;
  /** The parsed replay fixture, when the replay provider is configured. */
  readonly replayFixture?: unknown;
  /** Server-side secret values that must never reach a prompt. */
  readonly secrets?: readonly string[];
  /** Test seam: a provider used instead of the configured one (still wrapped by the budget, timeout and retry guards). */
  readonly provider?: LlmProvider;
  readonly retry?: RetryPolicy;
}

export const QUESTION_DEMONSTRATION_LAUNCH_NOTICE =
  'OFFLINE DEMONSTRATION: the questions are produced by fixed templates (or replayed from a hand-written fixture) from the uncertainty analysis; no model is called, no project text leaves this system, and the questions are not AI-generated.';

/**
 * Generating and reading the suggested interview questions of a VERIFIED assessment (M6). Generation reads the assessment (re-verified), runs the
 * deterministic pipeline, calls the configured offline provider once under the standard guards, and stores one immutable set; reading never calls a model.
 * No transaction is open while the provider is called. Every lookup is scoped to the project in the URL.
 */
export class QuestionService {
  private readonly reader: QuestionInputReader;
  private readonly store: QuestionSetStore;
  private readonly offline: OfflineAssessmentRuntime | null;
  private readonly secrets: readonly string[];

  constructor(private readonly options: QuestionServiceOptions) {
    this.reader = new QuestionInputReader(options.db);
    this.store = new QuestionSetStore(options.db);
    this.offline = options.offline;
    this.secrets = options.secrets ?? [];
  }

  launchView(): QuestionSetListResponse['launch'] {
    return this.offline === null && this.options.provider === undefined
      ? {
          available: false,
          providerMode: null,
          notice: 'No question provider is configured, so no questions can be generated.',
        }
      : {
          available: true,
          providerMode: this.offline?.provider.mode ?? 'scripted',
          notice: QUESTION_DEMONSTRATION_LAUNCH_NOTICE,
        };
  }

  private baseProvider(): { provider: LlmProvider; mode: 'replay' | 'scripted'; model: string } {
    if (this.options.provider !== undefined) {
      return {
        provider: this.options.provider,
        mode: this.options.provider.mode === 'replay' ? 'replay' : 'scripted',
        model: this.offline?.models.assessment ?? 'claude-sonnet-5-5',
      };
    }
    if (this.offline === null) {
      throw new QuestionApiError(
        'QUESTION_PROVIDER_NOT_CONFIGURED',
        'No question provider is configured',
      );
    }
    const model = this.offline.models.assessment;
    if (this.offline.provider.mode === 'scripted') {
      return {
        provider: new ScriptedProvider([questionDemonstrationStep], { repeatLast: true }),
        mode: 'scripted',
        model,
      };
    }
    return {
      provider: new ReplayProvider({ fixtures: this.options.replayFixture }),
      mode: 'replay',
      model,
    };
  }

  private async requireProject(projectId: string): Promise<void> {
    // the assessment read model is the single place that decides whether a project exists
    if (!(await new AssessmentReadStore(this.options.db).projectExists(projectId))) {
      throw new QuestionApiError('PROJECT_NOT_FOUND', 'Project not found');
    }
  }

  async list(projectId: string, assessmentId: string): Promise<QuestionSetListResponse> {
    await this.requireProject(projectId);
    if (!(await this.store.assessmentExists(projectId, assessmentId))) {
      throw new QuestionApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    }
    const read = await this.reader.read(projectId, assessmentId);
    return {
      projectId,
      assessmentId,
      sets: await this.store.listForAssessment(projectId, assessmentId),
      assessmentVerified: read.kind === 'ready',
      launch: this.launchView(),
    };
  }

  async get(projectId: string, setId: string): Promise<QuestionSetView> {
    await this.requireProject(projectId);
    const view = await this.store.getView(projectId, setId);
    if (!view) throw new QuestionApiError('QUESTION_SET_NOT_FOUND', 'Question set not found');
    return view;
  }

  async create(
    projectId: string,
    assessmentId: string,
    actorId: string,
  ): Promise<CreateQuestionSetResponse> {
    await this.requireProject(projectId);
    const { provider: base, mode, model } = this.baseProvider();
    const read = await this.reader.read(projectId, assessmentId);
    if (read.kind === 'not_found') {
      throw new QuestionApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    }
    if (read.kind === 'unverified') {
      // a question set is a trusted statement about a verified assessment: none can be made from one that fails its checks
      throw new QuestionApiError(
        'ASSESSMENT_NOT_VERIFIED',
        'This assessment did not pass verification, so no questions can be generated from it',
      );
    }

    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare(read.input, {
        provider: { id: base.id, mode },
        model,
        secrets: this.secrets,
      });
    } catch (error) {
      if (error instanceof UncertaintyInputError) {
        throw new QuestionApiError(
          'QUESTION_INPUT_INCONSISTENT',
          'The assessment’s records are inconsistent, so no questions can be generated from it',
        );
      }
      throw error;
    }

    // idempotent: the same identity (assessment report, context, policy, prompt, provider) is never generated twice, and no provider is called for it
    const existing = await this.store.findSetIdByKey(projectId, prepared.generationKey);
    if (existing !== null) return this.respond(projectId, 'already_generated', existing);

    const budget = new InMemoryRunBudget({
      limits: AssessmentRunLimits.parse({}),
      prices: PRICES_V1,
      clock: systemClock,
    });
    const guarded = createGuardedProvider({
      base,
      budget,
      prices: PRICES_V1,
      clock: systemClock,
      random: Math.random,
      ...(this.options.retry === undefined ? {} : { retry: this.options.retry }),
    });
    const outcome = await generate(
      read.input,
      prepared,
      { provider: guarded, model, secrets: this.secrets, providerMode: mode, providerId: base.id },
      actorId,
      new AbortController().signal,
    );
    const stored = await this.store.persist(outcome.persist);
    return this.respond(
      projectId,
      stored.kind === 'created' ? 'created' : 'already_generated',
      stored.setId,
    );
  }

  private async respond(
    projectId: string,
    result: CreateQuestionSetResponse['result'],
    setId: string,
  ): Promise<CreateQuestionSetResponse> {
    const set = await this.store.getView(projectId, setId);
    if (!set) throw new QuestionApiError('QUESTION_SET_NOT_FOUND', 'Question set not found');
    return { result, set };
  }
}
