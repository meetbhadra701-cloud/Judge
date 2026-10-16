import { AssessmentStore } from '../assessment-store.js';
import type { JudgeDatabase } from '../client.js';
import type { PersistQuestionSetInput } from '../question-set-store.js';
import { extractAndBind, oracleScore, scoreRun, startRun } from './assessment-pipeline.js';
import { seedAssessmentWorld } from './assessment-world.js';

/*
 * Test-only: a persisted, verified assessment and a well-formed question set input for it. Excluded from the package build and exports.
 */

export async function persistedAssessment(db: JudgeDatabase) {
  const world = await seedAssessmentWorld(db, {
    trackKeys: ['health'],
    declare: ['health'],
    rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
  });
  const run = await startRun(db, world);
  await extractAndBind(world, run, {});
  const scored = await scoreRun(db, world, run);
  const report = oracleScore(scored.authorized, scored.persist.judgments);
  const result = await new AssessmentStore(db).persist({ ...scored.persist, report });
  if (result.kind !== 'persisted') throw new Error(`not persisted: ${result.kind}`);
  return { world, assessmentId: result.assessmentId, report, scored };
}

const hex = (c: string) => c.repeat(64);

export function questionSetInput(
  base: {
    projectId: string;
    assessmentId: string;
    contextVersionId: string;
    extractionId: string;
    reportOutputHash: string;
  },
  over: Partial<PersistQuestionSetInput> = {},
): PersistQuestionSetInput {
  return {
    ...base,
    actorId: null,
    policyVersion: 'question-engine/v1',
    uncertaintyEngineVersion: 'uncertainty-engine/v1',
    weightBasis: 'official',
    generationKey: hex('1'),
    inputHash: hex('2'),
    provider: { mode: 'scripted', id: 'scripted', model: 'scripted-demonstration' },
    prompt: {
      id: 'question-candidates',
      version: 'v1',
      templateHash: hex('3'),
      outputSchemaHash: hex('4'),
    },
    requestDigest: hex('5'),
    candidateOutputHash: hex('6'),
    counts: { opportunities: 2, candidates: 2, rejected: 0, selected: 2 },
    shortfall: {
      code: 'fewer_defensible_candidates',
      explanation: 'Only 2 defensible questions could be generated; the list is not padded.',
    },
    rejections: [],
    opportunities: [
      {
        ordinal: 1,
        key: 'opp-0000000000000001',
        kind: 'claim_unverified',
        severity: 'high',
        dimensionIds: ['official.originality'],
        relevanceMilli: 500,
        observation: 'The team’s materials state a thing; nothing shown confirms it yet.',
        clarifiedBy: ['live_demonstration'],
        trail: [{ type: 'claim', id: '00000000-0000-4000-8000-000000000001', role: 'subject' }],
        referenceViews: [
          {
            type: 'claim',
            id: '00000000-0000-4000-8000-000000000001',
            label: 'A claim',
            verificationLevel: 'team_claim',
          },
        ],
      },
      {
        ordinal: 2,
        key: 'opp-0000000000000002',
        kind: 'coverage_partial',
        severity: 'moderate',
        dimensionIds: [],
        relevanceMilli: 0,
        observation: 'Part of the implementation was not shown to the assessment.',
        clarifiedBy: ['code_walkthrough'],
        trail: [{ type: 'coverage', id: 'implementation_coverage', role: 'subject' }],
        referenceViews: [],
      },
    ],
    questions: [
      {
        rank: 1,
        candidateKey: 'cand-0000000000000001',
        mode: 'demonstrate',
        text: 'Could you show the described behaviour working on the project itself?',
        reason: 'Nothing the assessment examined confirms it yet.',
        expectedInformation: ['live_demonstration'],
        dimensions: [{ id: 'official.originality', name: 'Originality', weightShareMilli: 500 }],
        opportunityKeys: ['opp-0000000000000001'],
        references: [
          {
            type: 'claim',
            id: '00000000-0000-4000-8000-000000000001',
            label: 'A claim',
            verificationLevel: 'team_claim',
          },
        ],
        rankingValueBp: 1800,
        marginalBp: 1800,
        noveltyMilli: 1000,
        factors: { relevanceMilli: 500 },
      },
      {
        rank: 2,
        candidateKey: 'cand-0000000000000002',
        mode: 'show_me',
        text: 'Could you open the part of the code that handles the main flow?',
        reason: 'Part of the implementation was not shown to the assessment.',
        expectedInformation: ['code_walkthrough'],
        dimensions: [],
        opportunityKeys: ['opp-0000000000000002'],
        references: [],
        rankingValueBp: 900,
        marginalBp: 900,
        noveltyMilli: 1000,
        factors: { relevanceMilli: 300 },
      },
    ],
    ...over,
  };
}
