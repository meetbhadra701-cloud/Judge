import { blockBegin, blockEnd, type BlockKind } from '../frame.js';

/**
 * A test-side parser that recognizes ONLY the real markers of a request (the boundary and the matching item code). It is
 * how the structural tests prove that forged markers inside project text cannot change the structure of a rendered prompt.
 */

export interface ParsedItem {
  readonly handle: string;
  readonly code: string;
  readonly meta: unknown;
  readonly body: string | null;
}

export interface ParsedBlock {
  readonly kind: BlockKind;
  readonly items: readonly ParsedItem[];
}

const KINDS: readonly BlockKind[] = ['standard', 'data'];

export function parseBlocks(user: readonly string[], boundary: string): ParsedBlock[] {
  return user.map((block) => {
    const lines = block.split('\n');
    const kind = KINDS.find((candidate) => lines[0] === blockBegin(candidate, boundary));
    if (!kind) throw new Error('block does not start with a real BEGIN marker');
    if (lines[lines.length - 1] !== blockEnd(kind, boundary)) {
      throw new Error('block does not end with its real END marker');
    }
    const items: ParsedItem[] = [];
    let index = 1;
    const last = lines.length - 1;
    while (index < last) {
      const begin = /^<<<ITEM (\S+) ([0-9a-f]{16})>>>$/.exec(lines[index] ?? '');
      if (!begin) throw new Error(`expected a real ITEM marker at line ${String(index)}`);
      const [, handle = '', code = ''] = begin;
      const endLine = `<<<END ITEM ${handle} ${code}>>>`;
      let close = index + 1;
      while (close < last && lines[close] !== endLine) close += 1;
      if (lines[close] !== endLine)
        throw new Error(`item ${handle} is not closed by its real END marker`);
      const metaLine = lines[index + 1] ?? '';
      if (!metaLine.startsWith('meta: ')) throw new Error('item has no meta line');
      const meta: unknown = JSON.parse(metaLine.slice('meta: '.length));
      const hasBody = lines[index + 2] === 'text:';
      const body = hasBody ? lines.slice(index + 3, close).join('\n') : null;
      items.push({ handle, code, meta, body });
      index = close + 1;
    }
    return { kind, items };
  });
}
