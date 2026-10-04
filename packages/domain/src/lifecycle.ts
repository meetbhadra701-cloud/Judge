import type {
  AnalysisRunState,
  EventContextStatus,
  SourceSnapshotStatus,
} from '@judge-copilot/schemas';

/*
 * Lifecycle classifications. These are definitional facts about the vocabularies in
 * @judge-copilot/schemas that other layers rely on; the database enforces the same rules
 * in CHECK constraints built from these constants. Transition rules (who may move a record
 * from one state to another, and when) belong to the milestone that introduces the workflow.
 */

/**
 * Event Context statuses whose content is frozen. A frozen version has `locked_at` set and is
 * never edited; a change requires a new version (invariants 17, 18).
 */
export const FROZEN_EVENT_CONTEXT_STATUSES = [
  'locked',
  'superseded',
] as const satisfies readonly EventContextStatus[];

export function isFrozenEventContextStatus(status: EventContextStatus): boolean {
  return (FROZEN_EVENT_CONTEXT_STATUSES as readonly EventContextStatus[]).includes(status);
}

/**
 * The only Event Context status an official assessment may be run against (invariant 18).
 * `superseded` versions remain valid references for assessments already made against them,
 * but new official assessments use the current locked version.
 */
export const OFFICIAL_EVENT_CONTEXT_STATUS = 'locked' satisfies EventContextStatus;

export const TERMINAL_ANALYSIS_RUN_STATES = [
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly AnalysisRunState[];

export function isTerminalAnalysisRunState(state: AnalysisRunState): boolean {
  return (TERMINAL_ANALYSIS_RUN_STATES as readonly AnalysisRunState[]).includes(state);
}

export const TERMINAL_SOURCE_SNAPSHOT_STATUSES = [
  'captured',
  'partial',
  'failed',
  'rejected',
] as const satisfies readonly SourceSnapshotStatus[];

export function isTerminalSourceSnapshotStatus(status: SourceSnapshotStatus): boolean {
  return (TERMINAL_SOURCE_SNAPSHOT_STATUSES as readonly SourceSnapshotStatus[]).includes(status);
}
