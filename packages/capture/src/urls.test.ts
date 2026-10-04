import { describe, expect, it } from 'vitest';
import { normalizeDeclaredSourceUrl, parseVideoUrl, safeHost } from './index.js';

describe('declared source URL rules', () => {
  it.each([
    ['https://github.com/Team/Project', 'https://github.com/team/project'],
    ['https://github.com/team/project/', 'https://github.com/team/project'],
    ['https://github.com/team/project.git', 'https://github.com/team/project'],
    ['http://www.github.com/team/project?tab=readme#top', 'https://github.com/team/project'],
  ])('normalizes GitHub repository root %s', (raw, expected) => {
    expect(normalizeDeclaredSourceUrl('github', raw)).toEqual({ ok: true, url: expected });
  });

  it.each([
    ['https://github.com/team/project/tree/main', 'unsupported_path'],
    ['https://github.com/team', 'unsupported_path'],
    ['https://github.com/features/actions', 'unsupported_path'],
    ['https://gitlab.com/team/project', 'unsupported_host'],
    ['https://github.com.evil.test/team/project', 'unsupported_host'],
    ['https://github.com:8443/team/project', 'unsupported_host'],
    ['https://user:pass@github.com/team/project', 'credentials_in_url'],
    ['ftp://github.com/team/project', 'scheme_not_allowed'],
    ['not a url', 'invalid_url'],
  ])('rejects GitHub URL %s', (raw, reason) => {
    expect(normalizeDeclaredSourceUrl('github', raw)).toEqual({ ok: false, reason });
  });

  it('accepts only canonical Devpost project pages', () => {
    expect(
      normalizeDeclaredSourceUrl('devpost', 'http://www.devpost.com/software/Atlas-AI/'),
    ).toEqual({ ok: true, url: 'https://devpost.com/software/atlas-ai' });
    expect(normalizeDeclaredSourceUrl('devpost', 'https://devpost.com/hackathons')).toEqual({
      ok: false,
      reason: 'unsupported_path',
    });
    expect(normalizeDeclaredSourceUrl('devpost', 'https://devpost.example/software/x')).toEqual({
      ok: false,
      reason: 'unsupported_host',
    });
  });

  it('detects video providers deterministically', () => {
    const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    for (const raw of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(parseVideoUrl(raw)).toEqual({
        provider: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        canonicalUrl: canonical,
      });
    }
    expect(parseVideoUrl('https://player.vimeo.com/video/123456')).toMatchObject({
      provider: 'vimeo',
      canonicalUrl: 'https://vimeo.com/123456',
    });
    expect(
      parseVideoUrl('https://www.loom.com/share/0123456789abcdef0123456789abcdef'),
    ).toMatchObject({
      provider: 'loom',
    });
    expect(parseVideoUrl('https://demo.example/video#t=3')).toEqual({
      provider: 'generic',
      canonicalUrl: 'https://demo.example/video',
    });
    expect(parseVideoUrl('https://www.youtube.com/watch?v=short')).toBe('unsupported_path');
  });

  it.each([
    'file:///etc/passwd',
    'data:text/html,hi',
    'javascript:alert(1)',
    'gopher://x.test/',
    'blob:https://x.test/1',
  ])('rejects unsupported scheme %s for deployments', (raw) => {
    expect(normalizeDeclaredSourceUrl('deployment', raw)).toMatchObject({ ok: false });
  });

  it('keeps deployment path and query, drops the fragment, refuses credentials and long URLs', () => {
    expect(normalizeDeclaredSourceUrl('deployment', 'http://App.Example/demo?x=1#frag')).toEqual({
      ok: true,
      url: 'http://app.example/demo?x=1',
    });
    expect(normalizeDeclaredSourceUrl('deployment', 'https://a:b@app.example/')).toEqual({
      ok: false,
      reason: 'credentials_in_url',
    });
    expect(
      normalizeDeclaredSourceUrl('deployment', `https://app.example/${'a'.repeat(3000)}`),
    ).toEqual({ ok: false, reason: 'too_long' });
  });

  it('exposes only the host for logging', () => {
    expect(safeHost('https://user:secret@app.example/path?token=abc')).toBe('app.example');
    expect(safeHost('nonsense')).toBeUndefined();
  });
});
