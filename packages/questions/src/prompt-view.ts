import type { ClosedSet } from './closed-set.js';

/*
 * The plain-data view of a closed set that a candidate-generation prompt renders (the strict `QuestionPromptInput` of `@judge-copilot/prompts`).
 * It lives here, in the deterministic layer, because only code decides what a model may see: handles and bounded labels, never a persisted id.
 */

export interface QuestionPromptView {
  readonly rubricName: string;
  readonly weightBasis: 'official' | 'equal_for_ranking_only';
  readonly dimensions: readonly {
    readonly handle: string;
    readonly name: string;
    readonly weightShareMilli: number;
  }[];
  readonly opportunities: readonly {
    readonly handle: string;
    readonly kind: string;
    readonly severity: 'critical' | 'high' | 'moderate' | 'low';
    readonly observation: string;
    readonly dimensions: readonly string[];
    readonly references: readonly string[];
    readonly clarifiedBy: readonly string[];
  }[];
  readonly references: readonly {
    readonly handle: string;
    readonly type: string;
    readonly label: string;
    readonly verificationLevel: string | null;
  }[];
}

export function promptViewOf(
  closed: ClosedSet,
  rubric: { readonly name: string; readonly weightBasis: 'official' | 'equal_for_ranking_only' },
): QuestionPromptView {
  const handleByDimensionId = new Map<string, string>(
    closed.dimensions.map((d) => [d.id, d.handle] as const),
  );
  const handleByReference = new Map<string, string>(
    closed.references.map((r) => [`${r.type}:${r.id}`, r.handle] as const),
  );
  return {
    rubricName: rubric.name,
    weightBasis: rubric.weightBasis,
    dimensions: closed.dimensions.map((d) => ({
      handle: d.handle,
      name: d.name,
      weightShareMilli: d.weightShareMilli,
    })),
    opportunities: closed.opportunities.map(({ handle, opportunity }) => ({
      handle,
      kind: opportunity.kind,
      severity: opportunity.severity,
      observation: opportunity.observation,
      dimensions: opportunity.dimensionIds.flatMap((id) => {
        const found = handleByDimensionId.get(id);
        return found ? [found] : [];
      }),
      references: [
        ...new Set(
          opportunity.trail.flatMap((entry) => {
            const found = handleByReference.get(`${entry.type}:${entry.id}`);
            return found ? [found] : [];
          }),
        ),
      ],
      clarifiedBy: [...opportunity.clarifiedBy],
    })),
    references: closed.references.map((r) => ({
      handle: r.handle,
      type: r.type,
      label: r.label,
      verificationLevel: r.verificationLevel,
    })),
  };
}
