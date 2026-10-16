import { analyzeUncertainty, type UncertaintyInput } from '@judge-copilot/uncertainty';
import type { CandidateQuestionOutput } from '@judge-copilot/schemas';
import { buildClosedSet, type ClosedSet } from '../closed-set.js';
import { claim, completeCoverage, dimension, evidence, quietInput, unknown } from './fixture.js';

/*
 * A synthetic hackathon used by the questions tests: a weighted rubric, a project whose technical claims are only README statements, a partly
 * inspected repository and an unverifiable impact statement. Nothing here is a real event or a real team.
 */

export function world(over: Partial<UncertaintyInput> = {}) {
  const base = quietInput();
  const input: UncertaintyInput = {
    ...base,
    dimensions: [
      dimension('official.technical_depth', {
        criterionWeight: 0.4,
        citedEvidenceIds: ['ev-readme'],
      }),
      dimension('official.impact', { criterionWeight: 0.3, citedEvidenceIds: ['ev-impact'] }),
      dimension('official.originality', { criterionWeight: 0.2, citedEvidenceIds: ['ev-orig'] }),
      dimension('official.presentation', { criterionWeight: 0.1, citedEvidenceIds: ['ev-pres'] }),
    ],
    evidence: [
      evidence('ev-readme', {
        kind: 'claim',
        verificationLevel: 'team_claim',
        text: 'README claims a streaming pipeline.',
      }),
      evidence('ev-impact', {
        kind: 'claim',
        origin: 'devpost',
        verificationLevel: 'team_claim',
        text: 'Devpost says 500 clinics adopted it.',
      }),
      evidence('ev-orig', { text: 'The repository contains a novel scheduler module.' }),
      evidence('ev-pres', { text: 'A short README.' }),
    ],
    claims: [
      claim('c-pipeline', {
        text: 'A streaming pipeline handles ten thousand events per second.',
        supportingEvidenceIds: ['ev-readme'],
      }),
      claim('c-adoption', {
        text: 'Five hundred clinics adopted the tool.',
        supportingEvidenceIds: ['ev-impact'],
      }),
    ],
    unknowns: [
      unknown('u-license', {
        unknownType: 'missing',
        text: 'The licence of a bundled dataset is not stated.',
        evidenceIds: ['ev-orig'],
      }),
    ],
    coverage: {
      ...completeCoverage,
      verdict: 'partial',
      implementation: {
        files: 50,
        filesShown: 15,
        filesUnseen: 35,
        inspectedShare: 0.3,
        componentsTotal: 5,
        componentsWithShownFile: 2,
      },
      omittedComponents: ['pipeline'],
    },
    ...over,
  };
  const report = analyzeUncertainty(input);
  const closed = buildClosedSet(report, input);
  return { input, report, closed };
}

/** The handle of the first opportunity of `kind`. */
export function handleOfKind(closed: ClosedSet, kind: string): string {
  const found = closed.opportunities.find((o) => o.opportunity.kind === kind);
  if (!found) throw new Error(`no opportunity of kind ${kind}`);
  return found.handle;
}

export function candidate(
  over: Partial<CandidateQuestionOutput> & { opportunities: string[] },
): CandidateQuestionOutput {
  return {
    mode: 'demonstrate',
    text: 'Could you run the pipeline on a sample batch while we watch the throughput?',
    reason: 'The throughput figure is a team statement that nothing examined has confirmed.',
    expectedInformation: ['live_demonstration'],
    dimensions: [],
    references: [],
    distinguishes: 'strong',
    effort: 'moderate',
    ...over,
  };
}

const TOPICS = [
  'the retry queue under a failed batch',
  'the caching layer after a cold start',
  'the consent flow for a new patient record',
  'the offline mode with the network unplugged',
  'the data export for a returning customer',
  'the rate limiter under a burst of requests',
  'the translation of a menu into another language',
  'the access rules for an administrator account',
  'the scheduling of two overlapping appointments',
  'the audit log after a deleted record',
  'the migration of an older database snapshot',
  'the alert sent when a sensor stops reporting',
];

/** One distinct, neutral, well-formed candidate for every opportunity of the closed set (up to twelve), in the closed set's order. */
export function oneCandidatePerOpportunity(
  closed: ClosedSet,
  over: Partial<CandidateQuestionOutput> = {},
): CandidateQuestionOutput[] {
  return closed.opportunities.slice(0, TOPICS.length).map((entry, index) =>
    candidate({
      opportunities: [entry.handle],
      text: `Could you walk us through ${TOPICS[index] ?? 'the main flow'} using the project itself?`,
      reason: 'It would show whether the behaviour exists beyond what the materials describe.',
      ...over,
    }),
  );
}
