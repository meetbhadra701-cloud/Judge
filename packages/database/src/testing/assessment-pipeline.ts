/*
 * Test-only: drives a REAL run through the persistence layer without any model: request -> claim -> extractions -> bind -> trusted read
 * -> M4 scoring context -> P3 candidate sets and gates -> M4 report, then hands back what `AssessmentStore.persist` needs. Excluded from
 * the package build and exports.
 */
import {
  applyPostGates,
  buildAssessorJudgments,
  buildCandidateSets,
  gateJudgment,
  preGate,
  preGated,
  trackReferenceAudits,
  type FinalUnit,
  type UnitCandidates,
} from '@judge-copilot/assessment';
import { deterministicIdAllocator } from '@judge-copilot/evidence';
import { createTrustedScoringContext, scoreProject } from '@judge-copilot/scoring';
import type { ScoreReport } from '@judge-copilot/schemas';
import type { JudgeDatabase } from '../client.js';
import {
  AssessmentInputReader,
  type AuthorizedAssessmentInputs,
} from '../assessment-input-reader.js';
import { AssessmentRunStore } from '../assessment-run-store.js';
import type { JudgmentInput, PersistAssessmentInput } from '../assessment-store.js';
import { EvidenceGraphStore } from '../evidence-graph-store.js';
import { GraphExtractionStore } from '../extraction-store.js';
import { DatabaseRunBudget } from '../run-budget-store.js';
import { requestInput } from './assessment-fixtures.js';
import { contextExtraction, sourceExtraction, type AssessmentWorld } from './assessment-world.js';
import { sha256 } from './graph-world.js';

let counter = 0;

export interface PreparedRun {
  readonly runId: string;
  readonly leaseToken: string;
  readonly store: AssessmentRunStore;
  readonly extractions: GraphExtractionStore;
  readonly budget: DatabaseRunBudget;
}

export async function startRun(
  db: JudgeDatabase,
  world: AssessmentWorld,
  overrides: Parameters<typeof requestInput>[1] = {},
): Promise<PreparedRun> {
  const store = new AssessmentRunStore({ db });
  const result = await store.requestAssessment(requestInput(world, overrides));
  if (result.kind !== 'run_created') throw new Error(`request failed: ${result.kind}`);
  const leaseToken = await store.claimRun(result.runId, 600_000);
  if (!leaseToken) throw new Error('claim failed');
  counter += 1;
  return {
    runId: result.runId,
    leaseToken,
    store,
    extractions: new GraphExtractionStore(
      db,
      new EvidenceGraphStore({ db, ids: deterministicIdAllocator(`pipeline-${String(counter)}`) }),
    ),
    budget: new DatabaseRunBudget({
      db,
      runId: result.runId,
      measure: (_model, usage) => ({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costNanoUsd: usage.inputTokens + usage.outputTokens,
      }),
    }),
  };
}

/** Writes the source and context extractions for the run (or reuses equal ones) and binds them. */
export async function extractAndBind(
  w: AssessmentWorld,
  run: PreparedRun,
  keys: { source?: string; context?: string } = {},
) {
  const source = await run.extractions.createExtraction({
    ...sourceExtraction(w, keys.source === undefined ? {} : { key: keys.source }),
    runId: run.runId,
  });
  const context = await run.extractions.createExtraction({
    ...contextExtraction(w, keys.context === undefined ? {} : { key: keys.context }).input,
    runId: run.runId,
  });
  await run.store.bindExtraction(run.runId, run.leaseToken, 'source', source.extraction.id);
  await run.store.bindExtraction(
    run.runId,
    run.leaseToken,
    'context_evidence',
    context.extraction.id,
  );
  return { source, context };
}

export interface ScoredRun {
  readonly authorized: AuthorizedAssessmentInputs;
  readonly units: UnitCandidates[];
  readonly finals: FinalUnit[];
  readonly report: ScoreReport;
  readonly persist: PersistAssessmentInput;
}

/** Reads the run's inputs through the trusted reader, scores them with M4 and prepares the persist input. */
export async function scoreRun(
  db: JudgeDatabase,
  w: AssessmentWorld,
  run: PreparedRun,
  options: { assessmentKey?: string; scoredUnits?: number; citeReference?: boolean } = {},
): Promise<ScoredRun> {
  const authorized = await new AssessmentInputReader(db).read(run.runId);
  const data = authorized.data;
  const context = createTrustedScoringContext({
    projectId: data.projectId,
    eventId: data.eventId,
    graph: data.graph,
    known: data.known,
    locked: data.locked,
    target:
      data.target.kind === 'overall'
        ? { kind: 'overall' }
        : { kind: 'track', trackKey: data.target.trackKey ?? '' },
    declaredTrackKeys: [...data.declaredTrackKeys],
  });
  if (!context.ok) throw new Error(`context rejected: ${JSON.stringify(context.issues)}`);
  const units = buildCandidateSets({
    graph: data.graph,
    known: data.known,
    rubric: context.context.rubric,
    declaredTrackKeys: [...data.declaredTrackKeys],
    eventReferences: data.eventReferences,
  });
  const scale = context.context.rubric.scale;
  const finals: FinalUnit[] = [];
  const assessorSeqs = new Map<string, number>();
  let scored = 0;
  for (const unit of units) {
    const gate = preGate(unit);
    if (gate !== null) {
      finals.push(preGated(unit, gate));
      continue;
    }
    const first = unit.items.find((item) => item.projectDerived)?.handle ?? '';
    const reference = unit.items.find((item) => item.reference !== null)?.handle;
    const wantScore = scored < (options.scoredUnits ?? 1);
    const output = wantScore
      ? {
          dimensionId: unit.dimensionId,
          outcome: { kind: 'scored' as const, score: 7 },
          citations: [
            {
              evidence: first,
              directness: 'direct' as const,
              specificity: 'exact' as const,
              note: 'cited',
            },
            ...(options.citeReference === true && reference !== undefined
              ? [
                  {
                    evidence: reference,
                    directness: 'indirect' as const,
                    specificity: 'generic' as const,
                    note: 'official context',
                  },
                ]
              : []),
          ],
          rationale: 'Supported by the cited record.',
          limitations: [],
        }
      : {
          dimensionId: unit.dimensionId,
          outcome: { kind: 'insufficient_evidence' as const },
          citations: [],
          rationale: 'Nothing shown supports a judgment.',
          limitations: [],
        };
    const gated = gateJudgment(output, unit, scale, {
      evidence: unit.items.map((item) => item.handle),
      unit: unit.dimensionId,
    });
    if (!gated.ok) throw new Error(`gate rejected: ${JSON.stringify(gated.issues)}`);
    finals.push(applyPostGates(gated.judgment, unit));
    if (wantScore) scored += 1;
    // one settled assessor call per judged unit, in the ledger of the run
    const reserved = await run.budget.reserve({
      stage: 'dimension_assessment',
      model: 'claude-haiku-5-5',
      requestDigest: sha256(`assess:${unit.dimensionId}:${run.runId}`),
      bounds: { inputTokens: 100, outputTokens: 50, costNanoUsd: 1_000 },
    });
    if (!reserved.ok) throw new Error('budget denied');
    await run.budget.settle(reserved.callId, {
      kind: 'measured',
      usage: { inputTokens: 80, outputTokens: 20 },
      outcomeCode: 'ok',
      responseHash: sha256(`answer:${unit.dimensionId}`),
      responseJson: { dimensionId: unit.dimensionId },
    });
    assessorSeqs.set(unit.dimensionId, reserved.callId);
  }
  const input = buildAssessorJudgments(finals, context.context.rubric);
  if (!input.ok) throw new Error(`assessor input: ${JSON.stringify(input.issues)}`);
  const result = scoreProject(context.context, input.input);
  if (!result.ok) throw new Error(`score: ${JSON.stringify(result.issues)}`);
  const audits = trackReferenceAudits(units, finals);
  const judgments: JudgmentInput[] = finals.map((final) => {
    const isScored = final.disposition === 'scored';
    const seq = assessorSeqs.get(final.dimensionId);
    const audit = audits.find((a) => a.dimensionId === final.dimensionId);
    return {
      dimensionId: final.dimensionId,
      outcomeKind: isScored ? 'scored' : 'insufficient_evidence',
      score:
        isScored && final.judgment?.outcome.kind === 'scored' ? final.judgment.outcome.score : null,
      disposition: final.disposition,
      rationale: final.judgment?.rationale ?? null,
      limitations: final.judgment?.limitations ?? [],
      assessorAttempts: seq === undefined ? 0 : 1,
      criticAttempts: 0,
      assessorCallSeqs: seq === undefined ? [] : [seq],
      criticCallSeqs: [],
      criticReviewRequired: audit !== undefined,
      criticReviewed: false,
      citations: isScored
        ? (final.judgment?.citations ?? []).map((c) => ({
            evidenceId: c.evidenceId,
            directness: c.directness,
            specificity: c.specificity,
            note: c.note,
          }))
        : [],
    };
  });
  return {
    authorized,
    units,
    finals,
    report: result.report,
    persist: {
      runId: run.runId,
      leaseToken: run.leaseToken,
      actorId: w.actor.id,
      assessmentKey: options.assessmentKey ?? sha256(`assessment:${run.runId}`),
      report: result.report,
      limitations: [],
      judgments,
      providerMode: 'scripted',
      fallbackAnchorsVersion: null,
      expected: {
        sourceMembersHash: data.source.extraction.membersHash,
        contextMembersHash: data.context.extraction.membersHash,
        lockedContentHash: data.locked.lockedContentHash,
      },
    },
  };
}
