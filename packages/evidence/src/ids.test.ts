import { Uuid } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { deterministicIdAllocator, randomIdAllocator } from './ids.js';

describe('ID allocators', () => {
  it('deterministic allocator yields valid, reproducible, distinct UUIDs', () => {
    const a = deterministicIdAllocator('ns');
    const b = deterministicIdAllocator('ns');
    const first = [a.next('claim'), a.next('claim'), a.next('evidence')];
    expect(first).toEqual([b.next('claim'), b.next('claim'), b.next('evidence')]);
    expect(new Set(first).size).toBe(3);
    for (const id of first) {
      expect(Uuid.safeParse(id).success).toBe(true);
      expect(id).toBe(id.toLowerCase());
      expect(id[14]).toBe('5');
    }
  });

  it('differs across namespaces and scopes', () => {
    expect(deterministicIdAllocator('a').next('claim')).not.toBe(
      deterministicIdAllocator('b').next('claim'),
    );
    expect(deterministicIdAllocator('a').next('claim')).not.toBe(
      deterministicIdAllocator('a').next('evidence'),
    );
  });

  it('random allocator yields valid unique UUIDs', () => {
    const allocator = randomIdAllocator();
    const ids = Array.from({ length: 50 }, () => allocator.next('claim'));
    expect(new Set(ids).size).toBe(50);
    expect(ids.every((id) => Uuid.safeParse(id).success)).toBe(true);
  });
});
