import { SOURCE_INGESTION_LIMITS, type ProjectSourceType } from '@judge-copilot/schemas';

/*
 * Declared-URL rules. These are syntactic only: they decide whether a URL has the right shape
 * for its source type and produce one canonical form, so duplicate declarations can be detected.
 * Whether a host may actually be contacted (DNS, address ranges, redirects) is decided at capture
 * time by the SSRF policy in `@judge-copilot/safe-http`, which turns a refusal into a `rejected`
 * snapshot.
 */

export type UrlRejectionReason =
  | 'invalid_url'
  | 'too_long'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'unsupported_host'
  | 'unsupported_path';

export type UrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: UrlRejectionReason };

function parse(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/** A plain web URL: http(s) only, no credentials, no fragment, bounded length. */
export function normalizeHttpUrl(raw: string, options: { allowHttp: boolean }): UrlCheck {
  if (raw.length > SOURCE_INGESTION_LIMITS.urlMaxChars) return { ok: false, reason: 'too_long' };
  const url = parse(raw);
  if (!url) return { ok: false, reason: 'invalid_url' };
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: 'scheme_not_allowed' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }
  if (url.hostname === '') return { ok: false, reason: 'invalid_url' };
  url.hash = '';
  const href = url.href;
  if (href.length > SOURCE_INGESTION_LIMITS.urlMaxChars) return { ok: false, reason: 'too_long' };
  return { ok: true, url: href };
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((segment) => segment !== '');
}

// ---------------------------------------------------------------------------------------------
// GitHub

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GITHUB_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const GITHUB_REPO = /^[a-z0-9._-]{1,100}$/i;
/** First path segments of github.com that are product pages, not repository owners. */
const GITHUB_RESERVED_OWNERS = new Set([
  'about',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'search',
  'security',
  'settings',
  'site',
  'sponsors',
  'topics',
  'trending',
  'users',
]);

export interface GithubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
  /** `https://github.com/{owner}/{repo}` (lowercase). */
  readonly canonicalUrl: string;
}

/**
 * Accepts only a repository root, `https://github.com/{owner}/{repo}`, tolerating a trailing
 * slash, a `.git` suffix, a query or a fragment. Deeper paths (`/tree/...`, `/blob/...`) are not
 * repository roots and are refused.
 */
export function parseGithubRepositoryUrl(raw: string): GithubRepositoryRef | UrlRejectionReason {
  const checked = normalizeHttpUrl(raw, { allowHttp: true });
  if (!checked.ok) return checked.reason;
  const url = new URL(checked.url);
  if (!GITHUB_HOSTS.has(url.hostname) || url.port !== '') return 'unsupported_host';
  const segments = pathSegments(url);
  if (segments.length !== 2) return 'unsupported_path';
  const owner = segments[0] ?? '';
  const repo = (segments[1] ?? '').replace(/\.git$/i, '');
  if (
    !GITHUB_OWNER.test(owner) ||
    GITHUB_RESERVED_OWNERS.has(owner.toLowerCase()) ||
    !GITHUB_REPO.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return 'unsupported_path';
  }
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    canonicalUrl: `https://github.com/${normalizedOwner}/${normalizedRepo}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Devpost

const DEVPOST_HOSTS = new Set(['devpost.com', 'www.devpost.com']);
const DEVPOST_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export interface DevpostProjectRef {
  readonly slug: string;
  /** `https://devpost.com/software/{slug}`. */
  readonly canonicalUrl: string;
}

/** Accepts only a public project page, `https://devpost.com/software/{slug}`. */
export function parseDevpostProjectUrl(raw: string): DevpostProjectRef | UrlRejectionReason {
  const checked = normalizeHttpUrl(raw, { allowHttp: true });
  if (!checked.ok) return checked.reason;
  const url = new URL(checked.url);
  if (!DEVPOST_HOSTS.has(url.hostname) || url.port !== '') return 'unsupported_host';
  const segments = pathSegments(url);
  const slug = segments[1] ?? '';
  if (segments.length !== 2 || segments[0] !== 'software' || slug.length > 200) {
    return 'unsupported_path';
  }
  if (!DEVPOST_SLUG.test(slug)) return 'unsupported_path';
  const normalized = slug.toLowerCase();
  return { slug: normalized, canonicalUrl: `https://devpost.com/software/${normalized}` };
}

// ---------------------------------------------------------------------------------------------
// Video

export type VideoProvider = 'youtube' | 'vimeo' | 'loom';

export type VideoRef =
  | {
      readonly provider: VideoProvider;
      readonly videoId: string;
      readonly canonicalUrl: string;
    }
  | { readonly provider: 'generic'; readonly canonicalUrl: string };

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const VIMEO_ID = /^[0-9]{1,15}$/;
const LOOM_HOSTS = new Set(['loom.com', 'www.loom.com']);
const LOOM_ID = /^[0-9a-f]{32}$/;

function youtube(videoId: string): VideoRef | null {
  return YOUTUBE_ID.test(videoId)
    ? {
        provider: 'youtube',
        videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      }
    : null;
}

/**
 * Detects YouTube, Vimeo and Loom deterministically from the URL alone. Anything else is a
 * `generic` web page whose public metadata may be read, but whose media is never downloaded.
 */
export function parseVideoUrl(raw: string): VideoRef | UrlRejectionReason {
  const checked = normalizeHttpUrl(raw, { allowHttp: true });
  if (!checked.ok) return checked.reason;
  const url = new URL(checked.url);
  const host = url.hostname;
  const segments = pathSegments(url);
  if (url.port === '') {
    if (YOUTUBE_HOSTS.has(host)) {
      const fromQuery = segments[0] === 'watch' ? url.searchParams.get('v') : null;
      const fromPath =
        segments.length === 2 && ['shorts', 'embed', 'live'].includes(segments[0] ?? '')
          ? (segments[1] ?? '')
          : null;
      const ref = youtube(fromQuery ?? fromPath ?? '');
      if (ref) return ref;
      return 'unsupported_path';
    }
    if (host === 'youtu.be') {
      const ref = segments.length === 1 ? youtube(segments[0] ?? '') : null;
      return ref ?? 'unsupported_path';
    }
    if (VIMEO_HOSTS.has(host)) {
      const id = host === 'player.vimeo.com' && segments[0] === 'video' ? segments[1] : segments[0];
      const expected = host === 'player.vimeo.com' ? 2 : 1;
      if (segments.length === expected && VIMEO_ID.test(id ?? '')) {
        return {
          provider: 'vimeo',
          videoId: id ?? '',
          canonicalUrl: `https://vimeo.com/${id ?? ''}`,
        };
      }
      return 'unsupported_path';
    }
    if (LOOM_HOSTS.has(host)) {
      const id = segments[1] ?? '';
      if (
        segments.length === 2 &&
        ['share', 'embed'].includes(segments[0] ?? '') &&
        LOOM_ID.test(id)
      ) {
        return { provider: 'loom', videoId: id, canonicalUrl: `https://www.loom.com/share/${id}` };
      }
      return 'unsupported_path';
    }
  }
  return { provider: 'generic', canonicalUrl: checked.url };
}

// ---------------------------------------------------------------------------------------------

/** Validates a declared URL for its source type and returns its canonical form. */
export function normalizeDeclaredSourceUrl(sourceType: ProjectSourceType, raw: string): UrlCheck {
  switch (sourceType) {
    case 'github': {
      const ref = parseGithubRepositoryUrl(raw);
      return typeof ref === 'string'
        ? { ok: false, reason: ref }
        : { ok: true, url: ref.canonicalUrl };
    }
    case 'devpost': {
      const ref = parseDevpostProjectUrl(raw);
      return typeof ref === 'string'
        ? { ok: false, reason: ref }
        : { ok: true, url: ref.canonicalUrl };
    }
    case 'video': {
      const ref = parseVideoUrl(raw);
      return typeof ref === 'string'
        ? { ok: false, reason: ref }
        : { ok: true, url: ref.canonicalUrl };
    }
    case 'deployment':
      return normalizeHttpUrl(raw, { allowHttp: true });
  }
}

/** The host of a URL for safe logging and failure metadata (never path, query or credentials). */
export function safeHost(raw: string): string | undefined {
  const url = parse(raw);
  if (!url || url.hostname === '') return undefined;
  const host = url.hostname.toLowerCase();
  return /^[a-z0-9.:[\]-]{1,253}$/.test(host) ? host : undefined;
}
