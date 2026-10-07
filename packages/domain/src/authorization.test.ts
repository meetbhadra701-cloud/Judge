import { CAPTURE_FAILURE_CATEGORY_VALUES } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_REJECTION_CATEGORIES,
  hasPermission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  snapshotStatusForFailure,
  TRANSIENT_CAPTURE_FAILURE_CATEGORIES,
} from './index.js';

describe('authorization policy', () => {
  it('lets organizers do everything and judges only read and request captures', () => {
    expect(PERMISSIONS.every((permission) => hasPermission(['organizer'], permission))).toBe(true);
    expect(hasPermission(['judge'], 'event_context.read')).toBe(true);
    expect(hasPermission(['judge'], 'project.read')).toBe(true);
    expect(hasPermission(['judge'], 'source.capture')).toBe(true);
    expect(hasPermission(['judge'], 'evidence.read')).toBe(true);
    expect(hasPermission(['organizer'], 'evidence.read')).toBe(true);
    expect(hasPermission([], 'evidence.read')).toBe(false);
    // There is no evidence write permission: M3 has no producer and the graph is trusted-code only.
    expect(PERMISSIONS.filter((permission) => permission.startsWith('evidence'))).toEqual([
      'evidence.read',
    ]);
    expect(hasPermission(['judge'], 'event_context.write')).toBe(false);
    expect(hasPermission(['judge'], 'project.write')).toBe(false);
    expect(hasPermission([], 'project.read')).toBe(false);
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['judge', 'organizer']);
  });
});

describe('capture failure classification', () => {
  it('maps policy refusals to rejected and everything else to failed', () => {
    for (const category of CAPTURE_FAILURE_CATEGORY_VALUES) {
      expect(snapshotStatusForFailure(category)).toBe(
        (CAPTURE_REJECTION_CATEGORIES as readonly string[]).includes(category)
          ? 'rejected'
          : 'failed',
      );
    }
    expect(snapshotStatusForFailure('ssrf_rejected')).toBe('rejected');
    expect(snapshotStatusForFailure('timeout')).toBe('failed');
  });

  it('never treats a policy rejection as transient', () => {
    for (const category of TRANSIENT_CAPTURE_FAILURE_CATEGORIES) {
      expect(snapshotStatusForFailure(category)).toBe('failed');
    }
  });
});
