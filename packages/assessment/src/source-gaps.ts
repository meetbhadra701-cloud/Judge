import type { RoutedSourceType } from './routing.js';
import { SOURCE_TYPE_VALUES } from './routing.js';

/*
 * Code-authored `missing` unknowns (design §4.3, §9.3 row 14). Missing evidence is not negative evidence (invariant 4): a source that
 * failed, was rejected, is pending, was only partly captured or was never provided is a GAP the judge must see, and nothing about the
 * project is inferred from it. A model never writes a `missing` unknown (it is poor at proving a negative), and the text is built from
 * a closed vocabulary here, so no source text or model text can enter it.
 */

export const SOURCE_STATUS_VALUES = [
  'captured',
  'partial',
  'failed',
  'rejected',
  'pending',
  'absent',
] as const;
export type SourceGapStatus = (typeof SOURCE_STATUS_VALUES)[number];

export interface SourceStatus {
  readonly sourceType: RoutedSourceType;
  readonly status: SourceGapStatus;
}

export interface CodeUnknown {
  readonly unknownType: 'missing';
  readonly text: string;
  readonly claims: readonly [];
  readonly evidence: readonly [];
  /** Stable machine key, kept in the extraction record. */
  readonly gapKey: string;
}

const LABEL: Record<RoutedSourceType, string> = {
  devpost: 'Devpost submission',
  github: 'GitHub repository',
  deployment: 'deployment',
  video: 'video',
};

const PHRASE: Record<Exclude<SourceGapStatus, 'captured'>, string> = {
  partial: 'was only partly captured, so some of its content was not available',
  failed: 'could not be captured, so none of its content was available',
  rejected: 'was rejected at capture, so none of its content was available',
  pending: 'has not been captured yet, so none of its content was available',
  absent: 'was not provided for this project',
};

export function sourceGapUnknowns(statuses: readonly SourceStatus[]): CodeUnknown[] {
  const rank = (type: RoutedSourceType) => SOURCE_TYPE_VALUES.indexOf(type);
  return [...statuses]
    .filter(
      (entry): entry is SourceStatus & { status: Exclude<SourceGapStatus, 'captured'> } =>
        entry.status !== 'captured',
    )
    .sort((a, b) => rank(a.sourceType) - rank(b.sourceType))
    .map((entry) => ({
      unknownType: 'missing' as const,
      text: `The ${LABEL[entry.sourceType]} ${PHRASE[entry.status]}. Nothing is inferred about the project from this gap.`,
      claims: [] as const,
      evidence: [] as const,
      gapKey: `${entry.sourceType}:${entry.status}`,
    }));
}
