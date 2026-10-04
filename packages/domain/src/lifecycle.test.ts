import {
  ANALYSIS_RUN_STATE_VALUES,
  EVENT_CONTEXT_STATUS_VALUES,
  SOURCE_SNAPSHOT_STATUS_VALUES,
} from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  isFrozenEventContextStatus,
  isTerminalAnalysisRunState,
  isTerminalSourceSnapshotStatus,
} from './index.js';

describe('lifecycle classifications', () => {
  it('only locked and superseded Event Context versions are frozen', () => {
    expect(EVENT_CONTEXT_STATUS_VALUES.filter(isFrozenEventContextStatus)).toEqual([
      'locked',
      'superseded',
    ]);
  });

  it('running is the only non-terminal analysis run state', () => {
    expect(ANALYSIS_RUN_STATE_VALUES.filter((s) => !isTerminalAnalysisRunState(s))).toEqual([
      'running',
    ]);
  });

  it('pending is the only non-terminal source snapshot status', () => {
    expect(SOURCE_SNAPSHOT_STATUS_VALUES.filter((s) => !isTerminalSourceSnapshotStatus(s))).toEqual(
      ['pending'],
    );
  });
});
