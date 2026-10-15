import type { WindowingResult } from '@judge-copilot/assessment';
import type { DimensionLimitationCode } from '@judge-copilot/schemas';

/*
 * Run-wide notices for the dimension assessor (P6B-beta3, R9-B1). Until now a dimension was told that the source was sampled only when its own
 * candidate list was cut at the call-size bound; the (much larger) loss at the windowing step reached the judge as a report limitation but never
 * the assessor, which therefore read a partial repository as if it were the whole of it. The notices are closed codes, derived from structured
 * records only (never from any text), and attached to EVERY unit: a rubric dimension cannot be tied to a part of the repository by code, so the
 * conservative statement is made for all of them.
 *
 * A notice says "some of what exists was not shown to you"; it never says anything about what the unseen part contains.
 */
export function runNotices(
  windowing: WindowingResult,
  pins: readonly { readonly status: string }[],
): DimensionLimitationCode[] {
  const notices: DimensionLimitationCode[] = [];
  if (windowing.buckets.some((bucket) => bucket.sampled)) notices.push('sampled_source');
  if (pins.some((pin) => pin.status === 'partial')) notices.push('partial_capture');
  return notices;
}
