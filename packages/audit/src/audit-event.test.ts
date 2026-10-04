import { describe, expect, it } from 'vitest';
import { createAuditEvent } from './index.js';

const entityId = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';
const fixedId = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('createAuditEvent', () => {
  it('assigns id and timestamp, defaults metadata, and freezes the result', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const event = createAuditEvent(
      { actorId: null, entityType: 'event', entityId, action: 'event.created' },
      { now: () => createdAt, newId: () => fixedId },
    );

    expect(event).toEqual({
      id: fixedId,
      createdAt,
      actorId: null,
      entityType: 'event',
      entityId,
      action: 'event.created',
      metadata: {},
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it.each([
    ['a non-UUID entity id', { entityId: 'event-1' }],
    ['a non-snake_case entity type', { entityType: 'EventContext' }],
    ['a malformed action', { action: 'Event Created' }],
    ['non-JSON metadata', { metadata: { at: new Date() } }],
  ])('rejects %s', (_label, override) => {
    expect(() =>
      createAuditEvent({
        actorId: null,
        entityType: 'event',
        entityId,
        action: 'event.created',
        ...(override as object),
      }),
    ).toThrow();
  });
});
