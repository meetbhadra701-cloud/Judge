import { describe, expect, it } from 'vitest';
import { classifyRepositoryArtifact, type RepositoryArtifactClass } from './artifacts.js';

const file = (key: string, mediaType = 'text/plain') => ({ key, kind: 'file', mediaType });

describe('classifyRepositoryArtifact (conservative, fail closed)', () => {
  const cases: [string, ReturnType<typeof file>, RepositoryArtifactClass][] = [
    // Prose: README, markdown and friends, anything under docs/.
    ['README.md', file('files/README.md', 'text/markdown'), 'team_prose'],
    ['readme without extension', file('files/README'), 'team_prose'],
    ['lower-case readme.txt', file('files/readme.txt'), 'team_prose'],
    ['nested README', file('files/packages/a/README.rst'), 'team_prose'],
    ['.md', file('files/notes/design.md', 'text/markdown'), 'team_prose'],
    ['.mdx', file('files/site/page.mdx', 'text/markdown'), 'team_prose'],
    ['.rst', file('files/doc.rst'), 'team_prose'],
    ['.txt', file('files/notes.txt'), 'team_prose'],
    ['.adoc', file('files/guide.adoc'), 'team_prose'],
    ['html page', file('files/index.html', 'text/html'), 'team_prose'],
    ['docs/ markdown', file('files/docs/architecture.md', 'text/markdown'), 'team_prose'],
    ['example code under docs/ is still prose', file('files/docs/example.ts'), 'team_prose'],
    [
      'example code under a nested doc dir',
      file('files/packages/x/docs/api/server.ts'),
      'team_prose',
    ],
    ['CHANGELOG', file('files/CHANGELOG'), 'team_prose'],
    ['CONTRIBUTING.md', file('files/CONTRIBUTING.md', 'text/markdown'), 'team_prose'],
    ['upper-case extension', file('files/GUIDE.MD', 'text/markdown'), 'team_prose'],
    // Source code.
    ['typescript', file('files/src/cache.ts'), 'source_code'],
    ['tsx', file('files/src/App.tsx'), 'source_code'],
    ['javascript', file('files/src/index.js'), 'source_code'],
    ['python', file('files/app/main.py'), 'source_code'],
    ['go', file('files/cmd/server.go'), 'source_code'],
    ['rust', file('files/src/lib.rs'), 'source_code'],
    ['key without the files/ prefix', file('src/cache.ts'), 'source_code'],
    ['upper-case source extension', file('files/src/Main.JAVA'), 'source_code'],
    // Not safely classifiable: fail closed.
    ['package.json (config)', file('files/package.json', 'application/json'), 'unclassified'],
    ['yaml config', file('files/.github/ci.yml', 'application/yaml'), 'unclassified'],
    ['lock file', file('files/pnpm-lock.yaml', 'application/yaml'), 'unclassified'],
    ['Dockerfile', file('files/Dockerfile'), 'unclassified'],
    ['no extension', file('files/Makefile'), 'unclassified'],
    ['unknown extension', file('files/data.bin'), 'unclassified'],
    ['dot file', file('files/.env.example'), 'unclassified'],
  ];

  for (const [name, artifact, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(classifyRepositoryArtifact(artifact)).toBe(expected);
    });
  }

  it('never treats M2 metadata artifacts as source: commit messages and descriptions are team text', () => {
    const metadata: [string, string][] = [
      ['repository.json', 'repository_metadata'],
      ['commits.json', 'commit_history'],
      ['tree.json', 'tree'],
      ['omissions.json', 'omissions'],
      ['submission.json', 'submission'],
      ['submission.txt', 'submission_text'],
      ['page.txt', 'page_text'],
      ['response.json', 'http_response'],
      ['metadata.json', 'video_metadata'],
      ['page-metadata.json', 'page_metadata'],
    ];
    for (const [key, kind] of metadata) {
      expect(classifyRepositoryArtifact({ key, kind, mediaType: 'application/json' }), key).toBe(
        'unclassified',
      );
    }
    // Even a key that looks like code is unclassified when it is not a repository file artifact.
    expect(
      classifyRepositoryArtifact({ key: 'files/src/a.ts', kind: 'tree', mediaType: 'text/plain' }),
    ).toBe('unclassified');
  });

  it('does not trust the media type alone: M2 gives text/plain to almost everything', () => {
    expect(classifyRepositoryArtifact(file('files/data.bin', 'text/plain'))).toBe('unclassified');
    expect(classifyRepositoryArtifact(file('files/src/a.ts', 'text/markdown'))).toBe('team_prose');
  });
});
