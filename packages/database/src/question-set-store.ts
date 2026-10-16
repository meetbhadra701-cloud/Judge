import {
  QUESTION_ADVISORY_NOTICE,
  QUESTION_DEMONSTRATION_NOTICE,
  type CandidateRejection,
  type ExpectedInformation,
  type QuestionMode,
  type QuestionPolicyVersion,
  type QuestionReferenceView,
  type QuestionSetSummary,
  type QuestionSetView,
  type QuestionShortfall,
  type SelectedQuestionView,
  type UncertaintyKind,
  type UncertaintyOpportunityView,
  type UncertaintySeverity,
} from '@judge-copilot/schemas';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { AssessmentReadStore } from './assessment-read.js';
import type { JudgeDatabase } from './client.js';
import {
  preInterviewAssessments,
  projectVoids,
  questionGenerationClaims,
  questionSetOpportunities,
  questionSetQuestions,
  questionSets,
} from './schema/index.js';

/*
 * Persistence and reading of immutable question sets (M6).
 *
 *   one transaction     the set, its opportunities and its questions are written together; migration 0023's deferred check refuses a set that is not
 *                       complete at commit. No model call and no extractor call ever happens inside this transaction: the caller finishes all of it first.
 *   idempotent          `generation_key` is unique. A request whose key already exists returns the stored set (`existing`); two concurrent requests
 *                       for the same key create exactly one set (the second waits on the unique index, then finds it).
 *   immutable           triggers refuse UPDATE, DELETE and TRUNCATE. A new assessment, capture or context version creates a different key, never an edit.
 *   verified or withheld  a read re-verifies the assessment the set belongs to and compares its report hash with the one the set recorded. When either
 *                       fails the questions and opportunities are NOT returned (`assessmentVerified: false`), the same fail-closed rule as the assessment.
 *   project-scoped      every read is keyed by the project in the request.
 */

export interface PersistedOpportunity {
  readonly ordinal: number;
  readonly key: string;
  readonly kind: UncertaintyKind;
  readonly severity: UncertaintySeverity;
  readonly dimensionIds: readonly string[];
  readonly relevanceMilli: number;
  readonly observation: string;
  readonly clarifiedBy: readonly string[];
  readonly trail: readonly { type: string; id: string; role: string }[];
  readonly referenceViews: readonly QuestionReferenceView[];
}

export interface PersistedQuestion {
  readonly rank: number;
  readonly candidateKey: string;
  readonly mode: QuestionMode;
  readonly text: string;
  readonly reason: string;
  readonly expectedInformation: readonly ExpectedInformation[];
  readonly dimensions: readonly { id: string; name: string; weightShareMilli: number }[];
  readonly opportunityKeys: readonly string[];
  readonly references: readonly QuestionReferenceView[];
  readonly rankingValueBp: number;
  readonly marginalBp: number;
  readonly noveltyMilli: number;
  readonly factors: Readonly<Record<string, number>>;
}

export interface PersistQuestionSetInput {
  readonly projectId: string;
  readonly assessmentId: string;
  readonly actorId: string | null;
  readonly contextVersionId: string;
  readonly extractionId: string;
  readonly reportOutputHash: string;
  readonly policyVersion: string;
  readonly uncertaintyEngineVersion: string;
  readonly weightBasis: 'official' | 'equal_for_ranking_only';
  readonly generationKey: string;
  readonly inputHash: string;
  readonly provider: {
    readonly mode: 'live' | 'replay' | 'scripted';
    readonly id: string;
    readonly model: string;
  };
  readonly prompt: {
    readonly id: string;
    readonly version: string;
    readonly templateHash: string;
    readonly outputSchemaHash: string;
  };
  readonly requestDigest: string | null;
  readonly candidateOutputHash: string | null;
  readonly counts: {
    readonly opportunities: number;
    readonly candidates: number;
    readonly rejected: number;
    readonly selected: number;
  };
  readonly shortfall: { readonly code: QuestionShortfall; readonly explanation: string } | null;
  /** question-engine/v2: valid candidates left out as repeats / as below the minimum value. */
  readonly excluded: { readonly redundant: number; readonly belowMinimum: number };
  readonly rejections: readonly { readonly code: CandidateRejection; readonly count: number }[];
  readonly opportunities: readonly PersistedOpportunity[];
  readonly questions: readonly PersistedQuestion[];
}

export type PersistQuestionSetResult =
  | { readonly kind: 'created'; readonly setId: string }
  | { readonly kind: 'existing'; readonly setId: string };

type Tx = Parameters<Parameters<JudgeDatabase['transaction']>[0]>[0];

export type GenerationClaimOutcome =
  | { readonly kind: 'acquired'; readonly token: string; readonly attempt: number }
  /** Another holder has a running claim whose lease has not expired. */
  | { readonly kind: 'running'; readonly leaseLeftMs: number }
  /** The last attempt failed and its cool-down has not passed. */
  | { readonly kind: 'failed'; readonly category: string; readonly retryAfterMs: number }
  /** There is no claim any more (the set was published, or the claim was released): look for the set. */
  | { readonly kind: 'vacant' };

/** The caller no longer holds the claim of its generation identity (it expired and was taken over, or the set was already published). */
export class QuestionClaimLostError extends Error {
  constructor() {
    super('the generation claim is no longer held by this caller');
    this.name = 'QuestionClaimLostError';
  }
}

/** The project was voided: a voided project receives no new question set. */
export class QuestionProjectVoidedError extends Error {
  constructor() {
    super('the project was voided');
    this.name = 'QuestionProjectVoidedError';
  }
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

/** The database refused the insert because the project was voided (the guard of migration 0023): found anywhere in the error's chain. */
export function isVoidedProjectRefusal(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === 'string' &&
      message.includes('a voided project cannot receive a question set')
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class QuestionSetStore {
  private readonly reads: AssessmentReadStore;

  constructor(private readonly db: JudgeDatabase) {
    this.reads = new AssessmentReadStore(db);
  }

  async persist(input: PersistQuestionSetInput): Promise<PersistQuestionSetResult> {
    return this.db.transaction((tx) => this.insertSet(tx, input));
  }

  /**
   * Publishes the result of a CLAIMED generation (M6-R1): in ONE short transaction it checks that the caller still holds the claim (the fencing token), that the
   * project is still eligible, writes the set and deletes the claim. A holder whose claim was taken over, or whose project was voided meanwhile, publishes nothing
   * and nothing half-written remains. The database guards (migration 0023) remain the last line: a refusal they raise is translated, not leaked.
   */
  async publish(
    input: PersistQuestionSetInput,
    claim: { readonly token: string },
  ): Promise<PersistQuestionSetResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const held = await tx.execute(sql`
          SELECT 1 AS held FROM ${questionGenerationClaims}
           WHERE ${questionGenerationClaims.generationKey} = ${input.generationKey}
             AND ${questionGenerationClaims.claimToken} = ${claim.token}::uuid
             AND ${questionGenerationClaims.state} = 'running'
             FOR UPDATE`);
        if (rowsOf(held).length === 0) throw new QuestionClaimLostError();
        const [voided] = await tx
          .select({ id: projectVoids.projectId })
          .from(projectVoids)
          .where(eq(projectVoids.projectId, input.projectId));
        if (voided) throw new QuestionProjectVoidedError();
        const result = await this.insertSet(tx, input);
        await tx
          .delete(questionGenerationClaims)
          .where(eq(questionGenerationClaims.generationKey, input.generationKey));
        return result;
      });
    } catch (error) {
      if (isVoidedProjectRefusal(error)) throw new QuestionProjectVoidedError();
      throw error;
    }
  }

  // -- generation claims (M6-R1) -----------------------------------------------------------------------------------------------

  /**
   * Atomically claims a generation identity, in ONE statement on the database clock, so two processes can never both hold it. It succeeds when there is no
   * claim, when the running claim's lease has expired (a crashed or hung holder: takeover), or when a failed claim's cool-down has passed (a controlled retry).
   * Otherwise it reports what stands in the way.
   */
  async claimGeneration(input: {
    readonly generationKey: string;
    readonly projectId: string;
    readonly assessmentId: string;
    readonly holder: string;
    readonly leaseMs: number;
    readonly failureCooldownMs: number;
    readonly token: string;
  }): Promise<GenerationClaimOutcome> {
    const claims = questionGenerationClaims;
    const won = await this.db.execute(sql`
      INSERT INTO ${claims} (generation_key, project_id, assessment_id, claim_token, holder, state, attempt, lease_expires_at)
      VALUES (${input.generationKey}, ${input.projectId}::uuid, ${input.assessmentId}::uuid, ${input.token}::uuid, ${input.holder}, 'running', 1,
              now() + (${input.leaseMs}::double precision / 1000.0) * interval '1 second')
      ON CONFLICT (generation_key) DO UPDATE
         SET claim_token = EXCLUDED.claim_token, holder = EXCLUDED.holder, state = 'running', attempt = ${claims}.attempt + 1,
             lease_expires_at = EXCLUDED.lease_expires_at, failure_category = NULL, failed_at = NULL, updated_at = now()
       WHERE (${claims}.state = 'running' AND ${claims}.lease_expires_at < now())
          OR (${claims}.state = 'failed' AND ${claims}.failed_at + (${input.failureCooldownMs}::double precision / 1000.0) * interval '1 second' <= now())
      RETURNING attempt`);
    const attempt = rowsOf(won)[0]?.['attempt'];
    if (attempt !== undefined)
      return { kind: 'acquired', token: input.token, attempt: Number(attempt) };

    const standing = await this.db.execute(sql`
      SELECT state, failure_category,
             GREATEST(0, ceil(extract(epoch FROM (lease_expires_at - now())) * 1000))::bigint AS lease_left_ms,
             GREATEST(0, ceil(extract(epoch FROM (failed_at + (${input.failureCooldownMs}::double precision / 1000.0) * interval '1 second' - now())) * 1000))::bigint AS retry_after_ms
        FROM ${claims} WHERE generation_key = ${input.generationKey}`);
    const row = rowsOf(standing)[0];
    if (!row) return { kind: 'vacant' };
    if (row['state'] === 'failed') {
      return {
        kind: 'failed',
        category: typeof row['failure_category'] === 'string' ? row['failure_category'] : 'failed',
        retryAfterMs: Number(row['retry_after_ms'] ?? 0),
      };
    }
    return { kind: 'running', leaseLeftMs: Number(row['lease_left_ms'] ?? 0) };
  }

  /** Extends the lease of a claim this caller still holds. False when it was superseded (the holder must stop and publish nothing). */
  async renewGeneration(generationKey: string, token: string, leaseMs: number): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE ${questionGenerationClaims}
         SET lease_expires_at = now() + (${leaseMs}::double precision / 1000.0) * interval '1 second', updated_at = now()
       WHERE generation_key = ${generationKey} AND claim_token = ${token}::uuid AND state = 'running'
      RETURNING 1 AS renewed`);
    return rowsOf(result).length > 0;
  }

  /** Gives back a claim this caller holds without having generated anything (another request published first). */
  async releaseGeneration(generationKey: string, token: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM ${questionGenerationClaims}
       WHERE generation_key = ${generationKey} AND claim_token = ${token}::uuid`);
  }

  /** Marks a claim this caller still holds as failed (starts the retry cool-down). A superseded caller changes nothing. */
  async failGeneration(generationKey: string, token: string, category: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE ${questionGenerationClaims}
         SET state = 'failed', failed_at = now(), failure_category = ${category.slice(0, 100)}, updated_at = now()
       WHERE generation_key = ${generationKey} AND claim_token = ${token}::uuid AND state = 'running'
      RETURNING 1 AS failed`);
    return rowsOf(result).length > 0;
  }

  /** Whether the project has been voided (an established project lifecycle fact: a voided project starts no new work). */
  async projectVoided(projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: projectVoids.projectId })
      .from(projectVoids)
      .where(eq(projectVoids.projectId, projectId));
    return row !== undefined;
  }

  /** The claim row of an identity (diagnostics and tests). */
  async generationClaim(generationKey: string) {
    const [row] = await this.db
      .select()
      .from(questionGenerationClaims)
      .where(eq(questionGenerationClaims.generationKey, generationKey));
    return row ?? null;
  }

  private async insertSet(
    tx: Tx,
    input: PersistQuestionSetInput,
  ): Promise<PersistQuestionSetResult> {
    {
      const [inserted] = await tx
        .insert(questionSets)
        .values({
          projectId: input.projectId,
          assessmentId: input.assessmentId,
          contextVersionId: input.contextVersionId,
          extractionId: input.extractionId,
          reportOutputHash: input.reportOutputHash,
          policyVersion: input.policyVersion,
          uncertaintyEngineVersion: input.uncertaintyEngineVersion,
          weightBasis: input.weightBasis,
          generationKey: input.generationKey,
          inputHash: input.inputHash,
          providerMode: input.provider.mode,
          providerId: input.provider.id,
          demonstration: input.provider.mode !== 'live',
          model: input.provider.model,
          promptId: input.prompt.id,
          promptVersion: input.prompt.version,
          promptTemplateHash: input.prompt.templateHash,
          outputSchemaHash: input.prompt.outputSchemaHash,
          requestDigest: input.requestDigest,
          candidateOutputHash: input.candidateOutputHash,
          opportunityCount: input.counts.opportunities,
          candidateCount: input.counts.candidates,
          rejectedCount: input.counts.rejected,
          selectedCount: input.counts.selected,
          shortfallCode: input.shortfall?.code ?? null,
          shortfallExplanation: input.shortfall?.explanation ?? null,
          excludedRedundant:
            input.policyVersion === 'question-engine/v1' ? null : input.excluded.redundant,
          excludedBelowMinimum:
            input.policyVersion === 'question-engine/v1' ? null : input.excluded.belowMinimum,
          rejections: input.rejections.map(({ code, count }) => ({ code, count })),
          createdByActorId: input.actorId,
        })
        .onConflictDoNothing({ target: questionSets.generationKey })
        .returning({ id: questionSets.id });
      if (!inserted) {
        const [existing] = await tx
          .select({ id: questionSets.id, projectId: questionSets.projectId })
          .from(questionSets)
          .where(eq(questionSets.generationKey, input.generationKey));
        if (!existing || existing.projectId !== input.projectId) {
          throw new Error('question set generation key conflict');
        }
        return { kind: 'existing', setId: existing.id } as const;
      }
      if (input.opportunities.length > 0) {
        await tx.insert(questionSetOpportunities).values(
          input.opportunities.map((o) => ({
            setId: inserted.id,
            ordinal: o.ordinal,
            opportunityKey: o.key,
            kind: o.kind,
            severity: o.severity,
            dimensionIds: [...o.dimensionIds],
            relevanceMilli: o.relevanceMilli,
            observation: o.observation,
            clarifiedBy: [...o.clarifiedBy],
            trail: o.trail.map((t) => ({ ...t })),
            referenceViews: o.referenceViews.map((r) => ({ ...r })),
          })),
        );
      }
      if (input.questions.length > 0) {
        await tx.insert(questionSetQuestions).values(
          input.questions.map((q) => ({
            setId: inserted.id,
            rank: q.rank,
            candidateKey: q.candidateKey,
            mode: q.mode,
            text: q.text,
            reason: q.reason,
            expectedInformation: [...q.expectedInformation],
            dimensions: q.dimensions.map((d) => ({ ...d })),
            opportunityKeys: [...q.opportunityKeys],
            referenceViews: q.references.map((r) => ({ ...r })),
            rankingValueBp: q.rankingValueBp,
            marginalBp: q.marginalBp,
            noveltyMilli: q.noveltyMilli,
            factors: { ...q.factors },
          })),
        );
      }
      return { kind: 'created', setId: inserted.id } as const;
    }
  }

  async findSetIdByKey(projectId: string, generationKey: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: questionSets.id })
      .from(questionSets)
      .where(
        and(eq(questionSets.generationKey, generationKey), eq(questionSets.projectId, projectId)),
      );
    return row?.id ?? null;
  }

  /** The sets of one assessment of the project, newest first. */
  async listForAssessment(projectId: string, assessmentId: string): Promise<QuestionSetSummary[]> {
    const rows = await this.db
      .select()
      .from(questionSets)
      .where(
        and(eq(questionSets.projectId, projectId), eq(questionSets.assessmentId, assessmentId)),
      )
      .orderBy(desc(questionSets.createdAt), desc(questionSets.id));
    return rows.map((row) => ({
      id: row.id,
      assessmentId: row.assessmentId,
      createdAt: row.createdAt.toISOString(),
      demonstration: row.demonstration,
      selected: row.selectedCount,
    }));
  }

  /** Whether the assessment exists in the project (so a list for an unknown or foreign assessment is a 404, not an empty list). */
  async assessmentExists(projectId: string, assessmentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: preInterviewAssessments.id })
      .from(preInterviewAssessments)
      .where(
        and(
          eq(preInterviewAssessments.id, assessmentId),
          eq(preInterviewAssessments.projectId, projectId),
        ),
      );
    return row !== undefined;
  }

  /** The stored set as a judge may read it, or null when it does not exist in this project. */
  async getView(projectId: string, setId: string): Promise<QuestionSetView | null> {
    const [row] = await this.db
      .select()
      .from(questionSets)
      .where(and(eq(questionSets.id, setId), eq(questionSets.projectId, projectId)));
    if (!row) return null;
    const detail = await this.reads.getDetail(projectId, row.assessmentId);
    const assessmentVerified =
      detail?.verified === true &&
      detail.report !== null &&
      detail.report.outputHash === row.reportOutputHash;
    const base = {
      id: row.id,
      projectId: row.projectId,
      assessmentId: row.assessmentId,
      assessmentVersionNumber: detail?.versionNumber ?? 0,
      contextVersionId: row.contextVersionId,
      createdAt: row.createdAt.toISOString(),
      policyVersion: row.policyVersion as QuestionPolicyVersion,
      inputHash: row.inputHash,
      generation: {
        providerMode: row.providerMode,
        providerId: row.providerId,
        demonstration: row.demonstration,
        promptId: row.promptId,
        promptVersion: row.promptVersion,
        promptTemplateHash: row.promptTemplateHash,
        models: row.demonstration ? null : { questions: row.model },
      },
      notices: {
        advisory: row.demonstration ? QUESTION_DEMONSTRATION_NOTICE : QUESTION_ADVISORY_NOTICE,
        ranking: 'deterministic_ordering_not_a_probability' as const,
        scores: 'questions_never_change_scores' as const,
      },
    };
    const counts = {
      opportunities: row.opportunityCount,
      candidates: row.candidateCount,
      rejected: row.rejectedCount,
      selected: row.selectedCount,
    };
    if (!assessmentVerified) {
      // FAIL CLOSED: nothing derived from the stored rows is returned
      return {
        ...base,
        assessmentVerified: false,
        questions: [],
        shortfall: null,
        opportunities: [],
        counts,
        rejections: [],
      };
    }
    const opportunityRows = await this.db
      .select()
      .from(questionSetOpportunities)
      .where(eq(questionSetOpportunities.setId, row.id))
      .orderBy(asc(questionSetOpportunities.ordinal));
    const questionRows = await this.db
      .select()
      .from(questionSetQuestions)
      .where(eq(questionSetQuestions.setId, row.id))
      .orderBy(asc(questionSetQuestions.rank));
    const idByKey = new Map(
      opportunityRows.map((o) => [o.opportunityKey, o.opportunityKey] as const),
    );

    const opportunities: UncertaintyOpportunityView[] = opportunityRows.map((o) => ({
      id: o.opportunityKey,
      ordinal: o.ordinal,
      kind: o.kind,
      severity: o.severity,
      dimensionIds: o.dimensionIds,
      observation: o.observation,
      references: o.referenceViews as unknown as QuestionReferenceView[],
    }));
    const questions: SelectedQuestionView[] = questionRows.map((q) => ({
      id: q.id,
      rank: q.rank,
      mode: q.mode,
      text: q.text,
      reason: q.reason,
      expectedInformation: q.expectedInformation as ExpectedInformation[],
      dimensions: q.dimensions.map((d) => ({
        id: d.id,
        name: d.name,
        weightShare: row.weightBasis === 'official' ? d.weightShareMilli / 1000 : null,
      })),
      opportunityIds: q.opportunityKeys.filter((key) => idByKey.has(key)),
      references: q.referenceViews as unknown as QuestionReferenceView[],
      rankingValueBp: q.rankingValueBp,
    }));
    return {
      ...base,
      assessmentVerified: true,
      questions,
      shortfall:
        row.shortfallCode === null || row.shortfallExplanation === null
          ? null
          : {
              code: row.shortfallCode,
              explanation: row.shortfallExplanation,
              candidateCount: row.candidateCount,
              excluded:
                row.excludedRedundant === null || row.excludedBelowMinimum === null
                  ? null
                  : { redundant: row.excludedRedundant, belowMinimum: row.excludedBelowMinimum },
              policyNote:
                row.policyVersion === 'question-engine/v1' &&
                row.shortfallCode === 'redundant_candidates'
                  ? 'Recorded under selection policy v1, which could not tell a repeated question from one whose value was below the minimum worth asking. The wording above is as it was stored; it may describe the second case as the first.'
                  : null,
            },
      opportunities,
      counts,
      rejections: row.rejections.map(({ code, count }) => ({
        code: code as CandidateRejection,
        count,
      })),
    };
  }
}
