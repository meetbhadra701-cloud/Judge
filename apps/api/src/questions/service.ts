import { randomUUID } from 'node:crypto';
import {
  AssessmentReadStore,
  QuestionClaimLostError,
  QuestionInputReader,
  QuestionProjectVoidedError,
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
import { UncertaintyInputError, type UncertaintyInput } from '@judge-copilot/uncertainty';
import type { OfflineAssessmentRuntime } from '../assessments/runtime-gate.js';
import { DEMONSTRATION_TEMPLATES_VERSION, questionDemonstrationStep } from './demonstration.js';
import { QuestionApiError } from './errors.js';
import { generate, inputHashOf, prepare, type Prepared } from './generation.js';

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
  /** Coordination of concurrent generations of one identity (M6-R1). Every bound is finite; the defaults suit production, tests shorten them. */
  readonly generation?: Partial<GenerationCoordination>;
}

/**
 * How requests for one generation identity share the work (M6-R1, R9A P2-1). One request CLAIMS the identity in the database and calls the provider; every other
 * request, in this process or in another one using the same database, waits (bounded) for the published set. The claim is a lease on the database clock, renewed
 * by a heartbeat while its holder lives; a claim whose lease expired (the holder crashed or hung) can be taken over by one other request, and the old holder can
 * no longer publish (fencing token). A provider failure starts a cool-down during which every request gets the same failure without a new provider call.
 *
 * LIMIT: at-most-once is guaranteed for the PUBLICATION of a set, and a provider is not called twice while a live holder keeps its lease. It is NOT guaranteed for
 * the provider call itself across a crash: a holder that dies after the provider received the request but before it published leaves a request whose outcome and
 * cost are unknown; the takeover calls the provider again. Exactly-once billing is not possible without the provider's own idempotency support, and none is claimed.
 */
export interface GenerationCoordination {
  /** How long a claim lives without a heartbeat before another request may take it over. */
  readonly leaseMs: number;
  /** Heartbeat period while generating; 0 disables it (a test of a hung or crashed holder). */
  readonly heartbeatMs: number;
  /** How often a waiting request looks for the result. */
  readonly pollMs: number;
  /** The longest a request waits for another holder before answering `QUESTION_GENERATION_IN_PROGRESS`. */
  readonly waitMs: number;
  /** After a failed generation, no new provider call is made for this long; requests get the same failure. */
  readonly failureCooldownMs: number;
}

export const DEFAULT_GENERATION_COORDINATION: GenerationCoordination = {
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  pollMs: 200,
  waitMs: 20_000,
  failureCooldownMs: 5_000,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  private readonly coordination: GenerationCoordination;
  private readonly holder = `api-${randomUUID()}`;

  constructor(private readonly options: QuestionServiceOptions) {
    this.reader = new QuestionInputReader(options.db);
    this.store = new QuestionSetStore(options.db);
    this.offline = options.offline;
    this.secrets = options.secrets ?? [];
    this.coordination = { ...DEFAULT_GENERATION_COORDINATION, ...options.generation };
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
      // a voided project keeps its history readable but starts no new work: say so here as well as refusing the POST
      launch: (await this.store.projectVoided(projectId))
        ? {
            available: false,
            providerMode: null,
            notice:
              'This project was voided by an organizer, so no new questions can be generated for it. Its earlier question sets stay readable as history.',
          }
        : this.launchView(),
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
    // a voided project starts no new work: refused BEFORE any assessment read, claim or provider call (the historical reads stay available)
    await this.requireNotVoided(projectId);
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

    let prepared: Prepared;
    try {
      prepared = prepare(read.input, {
        provider: { id: base.id, mode },
        model,
        secrets: this.secrets,
        // the scripted templates are part of the identity: a new template version never reuses (or hides behind) an older stored set
        ...(mode === 'scripted' ? { demonstration: DEMONSTRATION_TEMPLATES_VERSION } : {}),
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

    // exactly one request at a time generates this identity; the others wait (bounded) for its set or get a typed answer
    const { pollMs, waitMs } = this.coordination;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const done = await this.store.findSetIdByKey(projectId, prepared.generationKey);
      if (done !== null) return this.respond(projectId, 'already_generated', done);
      const claim = await this.store.claimGeneration({
        generationKey: prepared.generationKey,
        projectId,
        assessmentId,
        holder: this.holder,
        leaseMs: this.coordination.leaseMs,
        failureCooldownMs: this.coordination.failureCooldownMs,
        token: randomUUID(),
      });
      if (claim.kind === 'acquired') {
        // the claim of a published set is deleted with the set's publication, so a claim can be won just AFTER another request published: look again, now that
        // we hold the claim (a set that exists at this point can no longer change), and give the claim back instead of calling the provider
        const raced = await this.store.findSetIdByKey(projectId, prepared.generationKey);
        if (raced !== null) {
          await this.store.releaseGeneration(prepared.generationKey, claim.token);
          return this.respond(projectId, 'already_generated', raced);
        }
        return this.generateAsHolder({
          claimToken: claim.token,
          projectId,
          assessmentId,
          actorId,
          input: read.input,
          prepared,
          base,
          mode,
          model,
        });
      }
      const published = await this.store.findSetIdByKey(projectId, prepared.generationKey);
      if (published !== null) return this.respond(projectId, 'already_generated', published);
      if (claim.kind === 'failed') {
        // the holder of this identity failed a moment ago: the same failure, and no new provider call until the cool-down passes
        const [recorded = '', category] = claim.category.split(':');
        const code = REPLAYABLE_FAILURES.has(recorded)
          ? (recorded as 'QUESTION_GENERATION_FAILED')
          : 'QUESTION_GENERATION_FAILED';
        throw new QuestionApiError(
          code,
          'The last attempt to generate these questions failed; no question set was stored. It can be retried shortly',
          {
            ...(category === undefined ? {} : { category }),
            retryAfterMs: claim.retryAfterMs,
          },
        );
      }
      if (claim.kind === 'running' && Date.now() >= deadline) {
        throw new QuestionApiError(
          'QUESTION_GENERATION_IN_PROGRESS',
          'These questions are being generated by another request; try again shortly',
          { retryAfterMs: Math.max(pollMs, Math.min(claim.leaseLeftMs, 5_000)) },
        );
      }
      if (claim.kind === 'vacant' && Date.now() >= deadline) {
        throw new QuestionApiError(
          'QUESTION_GENERATION_IN_PROGRESS',
          'These questions are being generated by another request; try again shortly',
          { retryAfterMs: pollMs },
        );
      }
      await sleep(pollMs);
    }
  }

  /** The holder's half: provider call under a heartbeat, recheck of eligibility, fenced publication; any failure is recorded and starts the cool-down. */
  private async generateAsHolder(args: {
    claimToken: string;
    projectId: string;
    assessmentId: string;
    actorId: string;
    input: UncertaintyInput;
    prepared: Prepared;
    base: LlmProvider;
    mode: 'replay' | 'scripted';
    model: string;
  }): Promise<CreateQuestionSetResponse> {
    const { claimToken, projectId, assessmentId, prepared } = args;
    const key = prepared.generationKey;
    const abort = new AbortController();
    let superseded = false as boolean;
    const heartbeat =
      this.coordination.heartbeatMs > 0
        ? setInterval(() => {
            this.store
              .renewGeneration(key, claimToken, this.coordination.leaseMs)
              .then((renewed) => {
                if (!renewed) {
                  superseded = true;
                  abort.abort();
                }
              })
              .catch(() => undefined);
          }, this.coordination.heartbeatMs)
        : null;
    try {
      const budget = new InMemoryRunBudget({
        limits: AssessmentRunLimits.parse({}),
        prices: PRICES_V1,
        clock: systemClock,
      });
      const guarded = createGuardedProvider({
        base: args.base,
        budget,
        prices: PRICES_V1,
        clock: systemClock,
        random: Math.random,
        ...(this.options.retry === undefined ? {} : { retry: this.options.retry }),
      });
      const outcome = await generate(
        args.input,
        prepared,
        {
          provider: guarded,
          model: args.model,
          secrets: this.secrets,
          providerMode: args.mode,
          providerId: args.base.id,
        },
        args.actorId,
        abort.signal,
      );
      // recheck eligibility NOW, after the provider call: the project may have been voided, and the assessment must still verify and still be the same input
      await this.requireNotVoided(projectId);
      const again = await this.reader.read(projectId, assessmentId);
      if (again.kind !== 'ready') {
        throw new QuestionApiError(
          'ASSESSMENT_NOT_VERIFIED',
          'This assessment no longer passes verification, so nothing was stored',
        );
      }
      if (inputHashOf(again.input) !== prepared.inputHash) {
        throw new QuestionApiError(
          'QUESTION_GENERATION_SUPERSEDED',
          'The assessment’s records changed while the questions were generated, so nothing was stored',
        );
      }
      const stored = await this.store.publish(outcome.persist, { token: claimToken });
      return await this.respond(
        projectId,
        stored.kind === 'created' ? 'created' : 'already_generated',
        stored.setId,
      );
    } catch (error) {
      if (error instanceof QuestionClaimLostError || superseded) {
        // another request took this identity over (our lease expired): it owns the result. Return its set if it is already there; publish nothing.
        const published = await this.store.findSetIdByKey(projectId, key);
        if (published !== null) {
          return await this.respond(projectId, 'already_generated', published);
        }
        throw new QuestionApiError(
          'QUESTION_GENERATION_SUPERSEDED',
          'Another request took over the generation of these questions; nothing was stored by this one. Try again shortly',
          { retryAfterMs: this.coordination.pollMs },
        );
      }
      const translated = error instanceof QuestionProjectVoidedError ? this.voidedError() : error;
      // record the failure on OUR claim (it starts the cool-down); a failure to record it must not hide the real one
      await this.store
        .failGeneration(key, claimToken, failureCategoryOf(translated))
        .catch(() => undefined);
      throw translated;
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat);
    }
  }

  private voidedError(): QuestionApiError {
    return new QuestionApiError(
      'PROJECT_VOIDED',
      'This project was voided by an organizer, so no new questions can be generated for it. Its earlier question sets stay readable as history',
    );
  }

  private async requireNotVoided(projectId: string): Promise<void> {
    if (await this.store.projectVoided(projectId)) throw this.voidedError();
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

/** What is recorded on a failed claim: the typed answer's code, and for a provider failure its category (`QUESTION_GENERATION_FAILED:refused`). */
function failureCategoryOf(error: unknown): string {
  if (error instanceof QuestionApiError) {
    const category = error.details['category'];
    return typeof category === 'string' ? `${error.code}:${category}` : error.code;
  }
  return 'INTERNAL_ERROR';
}

const REPLAYABLE_FAILURES: ReadonlySet<string> = new Set([
  'QUESTION_GENERATION_FAILED',
  'QUESTION_OUTPUT_INVALID',
  'QUESTION_INPUT_INCONSISTENT',
  'ASSESSMENT_NOT_VERIFIED',
  'QUESTION_GENERATION_SUPERSEDED',
]);
