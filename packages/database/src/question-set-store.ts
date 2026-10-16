import {
  QUESTION_ADVISORY_NOTICE,
  QUESTION_DEMONSTRATION_NOTICE,
  QUESTION_POLICY_VERSION,
  type CandidateRejection,
  type ExpectedInformation,
  type QuestionMode,
  type QuestionReferenceView,
  type QuestionSetSummary,
  type QuestionSetView,
  type QuestionShortfall,
  type SelectedQuestionView,
  type UncertaintyKind,
  type UncertaintyOpportunityView,
  type UncertaintySeverity,
} from '@judge-copilot/schemas';
import { and, asc, desc, eq } from 'drizzle-orm';
import { AssessmentReadStore } from './assessment-read.js';
import type { JudgeDatabase } from './client.js';
import {
  preInterviewAssessments,
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
  readonly rejections: readonly { readonly code: CandidateRejection; readonly count: number }[];
  readonly opportunities: readonly PersistedOpportunity[];
  readonly questions: readonly PersistedQuestion[];
}

export type PersistQuestionSetResult =
  | { readonly kind: 'created'; readonly setId: string }
  | { readonly kind: 'existing'; readonly setId: string };

export class QuestionSetStore {
  private readonly reads: AssessmentReadStore;

  constructor(private readonly db: JudgeDatabase) {
    this.reads = new AssessmentReadStore(db);
  }

  async persist(input: PersistQuestionSetInput): Promise<PersistQuestionSetResult> {
    return this.db.transaction(async (tx) => {
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
    });
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
      policyVersion: QUESTION_POLICY_VERSION,
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

