import type { EventSourceAuthority } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { resolveConflict } from './index.js';

const authorities: Record<string, EventSourceAuthority> = {
  rules: 'official_event_rules',
  rules2: 'official_event_rules',
  judge: 'judge_context',
  fallback: 'universal_fallback',
};
const authorityOf = (id: string) => authorities[id] ?? 'universal_fallback';

const official = { sourceId: 'rules', statement: 'Pre-existing code is allowed.' };
const judge = { sourceId: 'judge', statement: 'Projects should be entirely new.' };

describe('resolveConflict', () => {
  it('lets official authority prevail over lower contextual guidance', () => {
    const result = resolveConflict([judge, official], authorityOf);
    expect(result).toEqual({
      ok: true,
      resolution: { status: 'resolved_by_authority', prevailingSourceIds: ['rules'], note: null },
    });
  });

  it('keeps tied highest-authority positions unresolved instead of guessing', () => {
    const result = resolveConflict(
      [official, { sourceId: 'rules2', statement: 'New code only.' }, judge],
      authorityOf,
    );
    expect(result).toEqual({
      ok: true,
      resolution: { status: 'unresolved', prevailingSourceIds: [], note: null },
    });
  });

  it('allows a human to choose only among tied highest-authority positions', () => {
    const tied = [official, { sourceId: 'rules2', statement: 'New code only.' }];
    expect(
      resolveConflict(tied, authorityOf, {
        prevailingSourceIds: ['rules2'],
        note: 'Organizer confirmed.',
      }),
    ).toEqual({
      ok: true,
      resolution: {
        status: 'resolved_by_human',
        prevailingSourceIds: ['rules2'],
        note: 'Organizer confirmed.',
      },
    });
    expect(
      resolveConflict([...tied, judge], authorityOf, { prevailingSourceIds: ['judge'], note: 'x' })
        .ok,
    ).toBe(false);
  });

  it('rejects a human override of a higher-authority position', () => {
    const result = resolveConflict([official, judge], authorityOf, {
      prevailingSourceIds: ['judge'],
      note: 'I prefer new work.',
    });
    expect(result.ok).toBe(false);
  });

  it('requires at least two positions from distinct sources', () => {
    expect(resolveConflict([official], authorityOf).ok).toBe(false);
    expect(resolveConflict([official, { ...official, statement: 'dup' }], authorityOf).ok).toBe(
      false,
    );
  });
});
