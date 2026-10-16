import { missingExpectedSources, type AssessmentDetail } from '@judge-copilot/schemas';
import type {
  ClaimFact,
  ContradictionFact,
  CoverageFact,
  DimensionFact,
  EvidenceFact,
  RequirementFact,
  UncertaintyInput,
  UnknownFact,
} from '@judge-copilot/uncertainty';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AssessmentReadStore, groupUnknowns } from './assessment-read.js';
import type { JudgeDatabase } from './client.js';
import {
  claims,
  contradictions,
  evidenceItems,
  evidenceRelations,
  graphExtractionItems,
  preInterviewAssessments,
  unknowns,
} from './schema/index.js';

/*
 * The input of the uncertainty analysis (M6), read from a VERIFIED pre-interview assessment and the immutable records it was scored from.
 *
 *   verified or nothing   the assessment goes through the same two-step verification as every read (`AssessmentReadStore.getDetail`). When it
 *                         does not verify, no content is read and none is returned: the result says only that it is unverified.
 *   project-scoped        every query is keyed by the project in the URL; an assessment of another project is indistinguishable from a missing one.
 *   pinned                the graph material is the membership of the assessment's OWN pinned extractions (source and event context), never "the
 *                         project's current graph": a later capture or context revision cannot change what an old assessment's questions are about.
 *   bounded               text is cut to a bounded excerpt; the engine never interprets it.
 */

const EXCERPT = 400;
const cut = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT ? flat : `${flat.slice(0, EXCERPT - 1).trimEnd()}…`;
};

export interface QuestionInputIdentity {
  readonly assessmentId: string;
  readonly projectId: string;
  readonly versionNumber: number;
  readonly eventId: string;
  readonly reportOutputHash: string;
  readonly contextVersionId: string;
  readonly contextContentHash: string;
  readonly extractionId: string;
  readonly contextExtractionId: string;
  readonly providerMode: AssessmentDetail['providerMode'];
}

export type QuestionInputResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unverified'; readonly failure: string | null }
  | {
      readonly kind: 'ready';
      readonly identity: QuestionInputIdentity;
      readonly input: UncertaintyInput;
    };

export class QuestionInputReader {
  private readonly reads: AssessmentReadStore;

  constructor(private readonly db: JudgeDatabase) {
    this.reads = new AssessmentReadStore(db);
  }

  async read(projectId: string, assessmentId: string): Promise<QuestionInputResult> {
    const detail = await this.reads.getDetail(projectId, assessmentId);
    if (!detail) return { kind: 'not_found' };
    if (!detail.verified || detail.report === null) {
      return { kind: 'unverified', failure: detail.verificationFailure };
    }
    const report = detail.report;

    const [row] = await this.db
      .select()
      .from(preInterviewAssessments)
      .where(
        and(
          eq(preInterviewAssessments.id, assessmentId),
          eq(preInterviewAssessments.projectId, projectId),
        ),
      );
    if (!row) return { kind: 'not_found' };

    // -- the pinned graph material
    const members = await this.db
      .select()
      .from(graphExtractionItems)
      .where(
        and(
          eq(graphExtractionItems.projectId, projectId),
          inArray(graphExtractionItems.extractionId, [row.extractionId, row.contextExtractionId]),
        ),
      )
      .orderBy(
        asc(graphExtractionItems.extractionId),
        asc(graphExtractionItems.recordType),
        asc(graphExtractionItems.ordinal),
      );
    const idsOf = (type: string): string[] =>
      members.filter((m) => m.recordType === type).map((m) => m.recordId);

    const citedIds = report.dimensions.flatMap((d) => d.citedEvidenceIds);
    const claimRows =
      idsOf('claim').length === 0
        ? []
        : await this.db
            .select()
            .from(claims)
            .where(and(eq(claims.projectId, projectId), inArray(claims.id, idsOf('claim'))));
    const relationRows =
      idsOf('relation').length === 0
        ? []
        : await this.db
            .select()
            .from(evidenceRelations)
            .where(
              and(
                eq(evidenceRelations.projectId, projectId),
                inArray(evidenceRelations.id, idsOf('relation')),
              ),
            );
    const unknownRows =
      idsOf('unknown').length === 0
        ? []
        : await this.db
            .select()
            .from(unknowns)
            .where(and(eq(unknowns.projectId, projectId), inArray(unknowns.id, idsOf('unknown'))));
    const contradictionRows =
      idsOf('contradiction').length === 0
        ? []
        : await this.db
            .select()
            .from(contradictions)
            .where(
              and(
                eq(contradictions.projectId, projectId),
                inArray(contradictions.id, idsOf('contradiction')),
              ),
            );

    // evidence: the members, plus anything a judgment cited or a record points at (so every reference resolves)
    const wantedEvidence = new Set<string>([
      ...idsOf('evidence'),
      ...citedIds,
      ...unknownRows.flatMap((u) => u.evidenceIds),
      ...relationRows.map((r) => r.evidenceId),
      ...contradictionRows.flatMap((c) =>
        [c.sideAEvidenceId, c.sideBEvidenceId].filter((id): id is string => id !== null),
      ),
    ]);
    const evidenceRows =
      wantedEvidence.size === 0
        ? []
        : await this.db
            .select()
            .from(evidenceItems)
            .where(
              and(
                eq(evidenceItems.projectId, projectId),
                inArray(evidenceItems.id, [...wantedEvidence]),
              ),
            );

    const claimIds = new Set(claimRows.map((c) => c.id));
    const evidenceIdSet = new Set(evidenceRows.map((e) => e.id));

    const evidenceFacts: EvidenceFact[] = evidenceRows
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        origin: e.origin,
        verificationLevel: e.verificationLevel,
        text: cut(e.text),
      }));

    const claimFacts: ClaimFact[] = claimRows
      .sort((a, b) => a.seq - b.seq)
      .map((c) => {
        const mine = relationRows.filter(
          (r) => r.claimId === c.id && evidenceIdSet.has(r.evidenceId),
        );
        return {
          id: c.id,
          text: cut(c.text),
          verificationLevel: c.verificationLevel,
          supportingEvidenceIds: mine
            .filter((r) => r.relationType === 'supports')
            .map((r) => r.evidenceId),
          contradictingEvidenceIds: mine
            .filter((r) => r.relationType === 'contradicts')
            .map((r) => r.evidenceId),
        };
      });

    const grouped = groupUnknowns(unknownRows.sort((a, b) => a.seq - b.seq));
    const unknownFacts: UnknownFact[] = grouped.map((u) => ({
      id: u.id,
      unknownType: u.unknownType,
      text: cut(u.text),
      claimIds: u.claimIds.filter((id) => claimIds.has(id)),
      evidenceIds: u.evidenceIds.filter((id) => evidenceIdSet.has(id)),
    }));

    const contradictionFacts: ContradictionFact[] = [];
    for (const c of contradictionRows.sort((a, b) => a.seq - b.seq)) {
      const sides: ContradictionFact['sides'][number][] = [];
      for (const [claimId, evidenceId] of [
        [c.sideAClaimId, c.sideAEvidenceId],
        [c.sideBClaimId, c.sideBEvidenceId],
      ] as const) {
        if (claimId !== null && claimIds.has(claimId)) sides.push({ type: 'claim', id: claimId });
        else if (evidenceId !== null && evidenceIdSet.has(evidenceId))
          sides.push({ type: 'evidence', id: evidenceId });
      }
      if (sides.length === 2) {
        contradictionFacts.push({ id: c.id, description: cut(c.description), sides });
      }
    }

    // -- dimensions
    const criterionWeight = new Map(report.criteria.map((c) => [c.key, c.weight] as const));
    const attributionOf = new Map(
      detail.judgments.map((j) => [j.dimensionId, j.dispositionAttribution] as const),
    );
    const dimensions: DimensionFact[] = report.dimensions.map((d) => ({
      id: d.id,
      criterionKey: d.criterionKey,
      name: d.name,
      criterionWeight: criterionWeight.get(d.criterionKey) ?? null,
      dimensionWeight: d.weight,
      state: d.state === 'assessed' ? 'assessed' : 'insufficient_evidence',
      insufficiencyReason: d.state === 'assessed' ? null : d.reason,
      attribution: attributionOf.get(d.id) ?? 'technical',
      confidence: d.confidence,
      evidenceStrength: d.state === 'assessed' ? d.evidenceStrength : null,
      citedEvidenceIds: d.citedEvidenceIds.filter((id) => evidenceIdSet.has(id)),
      contradictionIds: d.contradictionIds.filter((id) =>
        contradictionFacts.some((c) => c.id === id),
      ),
    }));

    // -- coverage
    const view = detail.coverage;
    const implementation = view.verified ? (view.measures?.implementation ?? null) : null;
    const components = view.verified ? (view.measures?.components ?? null) : null;
    const coverage: CoverageFact = {
      status: view.status,
      verified: view.verified,
      verdict: view.verdict,
      concerns: view.concerns,
      missingSources: view.verified ? missingExpectedSources(view.snapshots) : [],
      partialCapture: view.verified && view.snapshots.some((s) => s.status === 'partial'),
      implementation:
        implementation === null || components === null
          ? null
          : {
              files: implementation.files,
              filesShown: implementation.filesShown,
              filesUnseen: implementation.filesUnseen,
              inspectedShare: implementation.inspectedShare,
              componentsTotal: components.total,
              componentsWithShownFile: components.withShownFile,
            },
      omittedComponents: view.verified ? view.omittedComponents.map((c) => c.component) : [],
    };

    // -- tracks and requirements (only for tracks the project declared)
    const trackContext = detail.trackContext;
    const declared = trackContext?.declaredTracks ?? [];
    const declaredKeys = new Set(declared.map((t) => t.key));
    const requirements: RequirementFact[] = [];
    const contextMembers = members.filter(
      (m) =>
        m.extractionId === row.contextExtractionId &&
        m.recordType === 'evidence' &&
        m.referenceKind !== null &&
        m.referenceApplicability !== 'declared_track_definition',
    );
    const contextEvidence =
      contextMembers.length === 0
        ? []
        : await this.db
            .select()
            .from(evidenceItems)
            .where(
              and(
                eq(evidenceItems.projectId, projectId),
                inArray(
                  evidenceItems.id,
                  contextMembers.map((m) => m.recordId),
                ),
              ),
            );
    const contextById = new Map(contextEvidence.map((e) => [e.id, e] as const));
    for (const m of contextMembers) {
      const item = contextById.get(m.recordId);
      if (!item) continue;
      const trackKey =
        m.referenceApplicability === 'track_specific_requirement' ? m.referenceTrackKey : null;
      if (
        m.referenceApplicability === 'track_specific_requirement' &&
        (trackKey === null || !declaredKeys.has(trackKey))
      ) {
        continue;
      }
      requirements.push({
        id: item.id,
        kind: m.referenceKind === 'rule' ? 'overall_rule' : 'submission_requirement',
        trackKey,
        text: cut(item.text),
      });
    }

    const input: UncertaintyInput = {
      assessment: {
        id: row.id,
        projectId,
        versionNumber: row.versionNumber,
        reportOutputHash: report.outputHash,
        contextVersionId: row.contextVersionId,
        contextContentHash: row.lockedContentHash,
        extractionId: row.extractionId,
        providerMode: row.providerMode,
      },
      rubric: { name: report.rubric.name, weightBasis: report.rubric.weightBasis },
      dimensions,
      evidence: evidenceFacts,
      claims: claimFacts,
      unknowns: unknownFacts,
      contradictions: contradictionFacts,
      coverage,
      tracks: {
        declared: declared.map((t) => ({ key: t.key, name: t.name })),
        unassessedTrackRubrics: trackContext?.unassessedTrackRubrics ?? [],
      },
      requirements,
    };
    return {
      kind: 'ready',
      identity: {
        assessmentId: row.id,
        projectId,
        versionNumber: row.versionNumber,
        eventId: row.eventId,
        reportOutputHash: report.outputHash,
        contextVersionId: row.contextVersionId,
        contextContentHash: row.lockedContentHash,
        extractionId: row.extractionId,
        contextExtractionId: row.contextExtractionId,
        providerMode: row.providerMode,
      },
      input,
    };
  }
}
