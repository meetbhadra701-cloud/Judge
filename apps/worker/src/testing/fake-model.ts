/*
 * Test-only "model" for the offline pipeline tests (excluded from the build). Every answer is HAND-AUTHORED by a function in this file or by
 * the test; none is produced by a model. It reads the request exactly as a provider would receive it (the rendered `system` and `user`
 * blocks), so a test exercises the real renderer, the real digest and the real closed sets.
 *
 * `FakeModel` is a function suitable for `new ScriptedProvider([model.step], { repeatLast: true })`; tests override single stages with
 * `model.on(stage, handler)` to inject malformed, hostile or failing behavior.
 */
import { computeRequestDigest, type LlmResult, type StructuredRequest } from '@judge-copilot/llm';
import type { AssessmentStage } from '@judge-copilot/schemas';
import { CLAIM_QUOTES, EVIDENCE_QUOTE, EVIDENCE_TEXT } from './assessment-world.js';

import { parseRecords, type ParsedRecord } from '../assessment/demonstration-model.js';

export { parseRecords, type ParsedRecord };

export interface Context {
  readonly request: StructuredRequest;
  readonly records: readonly ParsedRecord[];
  readonly byHandle: ReadonlyMap<string, ParsedRecord>;
  readonly digest: string;
}

export type Handler = (context: Context) => unknown;

const USAGE = { inputTokens: 1_000, outputTokens: 200 };
export const ok = (json: unknown): LlmResult => ({
  ok: true,
  json,
  usage: USAGE,
  providerRequestId: null,
  servedModel: 'fake',
});

export interface RecordedCall {
  readonly stage: AssessmentStage;
  readonly digest: string;
  readonly dimensionId: string | null;
  readonly request: StructuredRequest;
}

const dimensionOf = (rubric: ParsedRecord | undefined): string => {
  const value = rubric?.meta['dimensionId'];
  return typeof value === 'string' ? value : '';
};

/** A deterministic, well-behaved model whose behavior tests override stage by stage. */
export class FakeModel {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<AssessmentStage, Handler>();
  /** Set to make `step` return a raw LlmResult for a stage (failures). */
  private readonly raw = new Map<
    AssessmentStage,
    (context: Context, call: number) => LlmResult | null
  >();
  private readonly stageCounts = new Map<AssessmentStage, number>();

  on(stage: AssessmentStage, handler: Handler): this {
    this.handlers.set(stage, handler);
    return this;
  }

  /** Overrides a stage's whole result (a failure, or a hand-built success). Return null to fall through to the handler. */
  failing(
    stage: AssessmentStage,
    result: (context: Context, call: number) => LlmResult | null,
  ): this {
    this.raw.set(stage, result);
    return this;
  }

  callsOf(stage: AssessmentStage): RecordedCall[] {
    return this.calls.filter((call) => call.stage === stage);
  }

  readonly step = (request: StructuredRequest): LlmResult => {
    const records = parseRecords(request);
    const context: Context = {
      request,
      records,
      byHandle: new Map(records.map((record) => [record.handle, record])),
      digest: computeRequestDigest(request),
    };
    const rubric = records.find((record) => record.handle === 'RUBRIC');
    this.calls.push({
      stage: request.stage,
      digest: context.digest,
      dimensionId:
        typeof rubric?.meta['dimensionId'] === 'string' ? rubric.meta['dimensionId'] : null,
      request,
    });
    const count = (this.stageCounts.get(request.stage) ?? 0) + 1;
    this.stageCounts.set(request.stage, count);
    const override = this.raw.get(request.stage)?.(context, count);
    if (override) return override;
    const handler = this.handlers.get(request.stage) ?? DEFAULTS[request.stage];
    return ok(handler(context));
  };
}

// -- Default behavior: a competent, honest model over the synthetic HydroTrack world ------------------------------------------------

const passages = (context: Context, route: 'statement' | 'interpret') =>
  context.records.filter((record) =>
    route === 'statement' ? !('class' in record.meta) : 'class' in record.meta,
  );

const candidatesOf = (context: Context) =>
  context.records.filter((record) => typeof record.meta['authorship'] === 'string');

export const DEFAULTS: Record<AssessmentStage, Handler> = {
  claim_extraction: (context) => ({
    claims: passages(context, 'statement').flatMap((passage, index) =>
      CLAIM_QUOTES.filter((quote) => passage.body?.includes(quote) === true).map((quote, i) => ({
        ref: `c${String(index)}_${String(i)}`,
        text: quote,
        passage: passage.handle,
        quote,
      })),
    ),
  }),
  evidence_interpretation: (context) => ({
    evidence: passages(context, 'interpret').flatMap((passage, index) =>
      passage.body?.includes(EVIDENCE_QUOTE) === true
        ? [
            {
              ref: `e${String(index)}`,
              text: EVIDENCE_TEXT,
              passage: passage.handle,
              quote: EVIDENCE_QUOTE,
            },
          ]
        : [],
    ),
  }),
  fidelity_review: (context) => ({
    verdicts: context.records.map((record) => ({ item: record.handle, verdict: 'faithful' })),
  }),
  relation_matching: (context) => {
    const claimRecords = context.records.filter(
      (r) => r.meta['kind'] === 'claim' && r.handle.startsWith('C-'),
    );
    const facts = context.records.filter((r) => r.meta['kind'] === 'evidence');
    const code = facts.find(
      (r) => typeof r.meta['text'] === 'string' && r.meta['text'].includes('7200'),
    );
    return {
      relations:
        code === undefined
          ? []
          : claimRecords
              .filter(
                (c) =>
                  typeof c.meta['text'] === 'string' && c.meta['text'].includes('every two hours'),
              )
              .map((c) => ({ claim: c.handle, evidence: code.handle, type: 'supports' })),
    };
  },
  relation_verification: (context) => ({
    verdicts: context.records.map((record) => ({ pair: record.handle, verdict: 'supports' })),
  }),
  contradiction_detection: () => ({ contradictions: [] }),
  unknown_identification: () => ({ unknowns: [] }),
  dimension_assessment: (context) => {
    const rubric = context.records.find((record) => record.handle === 'RUBRIC');
    const dimensionId = dimensionOf(rubric);
    const scale = (rubric?.meta['scale'] ?? { min: 0, max: 10 }) as { min: number; max: number };
    const candidates = candidatesOf(context);
    const project = candidates.filter((record) => record.meta['authorship'] !== 'event_reference');
    const first = project.slice(0, 2);
    return {
      dimensionId,
      outcome: { kind: 'scored', score: scale.min + 0.7 * (scale.max - scale.min) },
      citations: first.map((record) => ({
        evidence: record.handle,
        directness: 'direct',
        specificity: 'exact',
        note: 'Cited as shown.',
      })),
      rationale: 'The cited records support the judgment.',
      limitations: [],
    };
  },
  critic: (context) => {
    const rubric = context.records.find((record) => record.handle === 'RUBRIC');
    return { unit: dimensionOf(rubric), findings: [] };
  },
};

/** The unit a dimension or critic request is about. */
export function unitOf(context: Context): {
  dimensionId: string;
  scale: { min: number; max: number };
} {
  const rubric = context.records.find((record) => record.handle === 'RUBRIC');
  return {
    dimensionId: dimensionOf(rubric),
    scale: (rubric?.meta['scale'] ?? { min: 0, max: 10 }) as { min: number; max: number },
  };
}

export function candidateHandles(context: Context, authorship?: string): string[] {
  return candidatesOf(context)
    .filter((record) => authorship === undefined || record.meta['authorship'] === authorship)
    .map((record) => record.handle);
}

export const insufficient = (dimensionId: string) => ({
  dimensionId,
  outcome: { kind: 'insufficient_evidence' },
  citations: [],
  rationale: 'Nothing shown supports a judgment.',
  limitations: [],
});

export const blocking = (handles: string[], code = 'citation_not_relevant') => ({
  code,
  severity: 'blocking',
  evidence: handles,
  note: 'Not relevant.',
});
