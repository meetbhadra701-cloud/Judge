import { describe, expect, it } from 'vitest';
import {
  jsonArtifact,
  sha256Hex,
  snapshotContentHash,
  textArtifact,
  truncateUtf8,
  validateCaptureResult,
  type SnapshotContentHashInput,
} from './index.js';

const readme = textArtifact('files/README.md', 'file', 'text/markdown', '# Atlas\n', {
  gitBlobSha: 'a'.repeat(40),
});
const repository = jsonArtifact('repository.json', 'repository_metadata', { b: 2, a: 1 });

function input(overrides: Partial<SnapshotContentHashInput> = {}): SnapshotContentHashInput {
  return {
    sourceType: 'github',
    sourceUrl: 'https://github.com/team/atlas',
    revision: '1'.repeat(40),
    metadata: { defaultBranch: 'main' },
    partialReasons: [],
    artifacts: [readme, repository],
    ...overrides,
  };
}

describe('artifact and snapshot hashing', () => {
  it('hashes each artifact independently over its exact UTF-8 text', () => {
    expect(readme.contentHash).toBe(sha256Hex('# Atlas\n'));
    expect(readme.byteLength).toBe(8);
    expect(textArtifact('x', 'file', 'text/plain', 'é').byteLength).toBe(2);
    // JSON artifacts are canonical: key order in the input never changes the bytes.
    expect(repository.textContent).toBe(
      jsonArtifact('r', 'repository_metadata', { a: 1, b: 2 }).textContent,
    );
  });

  it('is deterministic and independent of artifact order', () => {
    expect(snapshotContentHash(input())).toBe(snapshotContentHash(input()));
    expect(snapshotContentHash(input({ artifacts: [repository, readme] }))).toBe(
      snapshotContentHash(input()),
    );
  });

  it('changes with content, revision, URL, metadata and partial reasons', () => {
    const base = snapshotContentHash(input());
    const changed = textArtifact('files/README.md', 'file', 'text/markdown', '# Atlas!\n');
    expect(snapshotContentHash(input({ artifacts: [changed, repository] }))).not.toBe(base);
    expect(snapshotContentHash(input({ revision: '2'.repeat(40) }))).not.toBe(base);
    expect(snapshotContentHash(input({ sourceUrl: 'https://github.com/team/other' }))).not.toBe(
      base,
    );
    expect(snapshotContentHash(input({ metadata: { defaultBranch: 'dev' } }))).not.toBe(base);
    expect(snapshotContentHash(input({ partialReasons: ['commit_limit'] }))).not.toBe(base);
  });

  it('has no inputs for timestamps or database IDs', () => {
    // The hash input type has no such fields; extra properties are ignored entirely.
    const withNoise = {
      ...input(),
      id: 'x',
      capturedAt: new Date(),
      snapshotId: 'y',
    } as SnapshotContentHashInput;
    expect(snapshotContentHash(withNoise)).toBe(snapshotContentHash(input()));
  });

  it('truncates UTF-8 on code point boundaries', () => {
    expect(truncateUtf8('aé', 2)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('abc', 5)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('capture result validation', () => {
  const ok = {
    status: 'captured',
    revision: null,
    metadata: {},
    artifacts: [],
    partialReasons: [],
  };

  it('accepts consistent results', () => {
    expect(validateCaptureResult('deployment', ok)).toEqual(ok);
    expect(
      validateCaptureResult('deployment', {
        status: 'rejected',
        failure: { category: 'ssrf_rejected', metadata: { host: 'x.test' } },
      }).status,
    ).toBe('rejected');
  });

  it('refuses inconsistent or unsafe results', () => {
    const bad = [
      ['github', ok],
      ['deployment', { ...ok, status: 'partial' }],
      ['deployment', { ...ok, partialReasons: ['body_truncated'] }],
      ['deployment', { ...ok, artifacts: [readme, readme] }],
      ['deployment', { ...ok, artifacts: [{ ...readme, contentHash: '0'.repeat(64) }] }],
      ['deployment', { ...ok, artifacts: [{ ...readme, textContent: 'changed' }] }],
      ['deployment', { status: 'failed', failure: { category: 'ssrf_rejected', metadata: {} } }],
      [
        'deployment',
        { status: 'failed', failure: { category: 'timeout', metadata: { body: '<html>' } } },
      ],
      [
        'deployment',
        { status: 'failed', failure: { category: 'timeout', metadata: { reason: 'Bearer abc' } } },
      ],
    ] as const;
    for (const [sourceType, result] of bad) {
      expect(() => validateCaptureResult(sourceType, result), JSON.stringify(result)).toThrow(
        /Invalid capture result/,
      );
    }
  });
});
