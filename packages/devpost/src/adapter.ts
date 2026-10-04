import {
  absoluteHttpUrl,
  failure,
  failureResult,
  fallbackVisibleText,
  jsonArtifact,
  normalizeWhitespace,
  parseDevpostProjectUrl,
  parseGithubRepositoryUrl,
  parseHtml,
  parseVideoUrl,
  textArtifact,
  visibleText,
  type CaptureInput,
  type CaptureResult,
  type HttpFetcher,
  type JsonObject,
  type ProjectSourceAdapter,
} from '@judge-copilot/capture';
import type { CapturePartialReason } from '@judge-copilot/schemas';

/*
 * Public Devpost project pages, read once through the SSRF-safe client with no cookies, login or
 * JavaScript. Fields are parsed deterministically from the server-rendered HTML. A section that
 * is not on the page stays null: nothing is inferred, summarized or invented. Material gaps make
 * the snapshot `partial` with an explicit reason. The text is untrusted data, never instructions.
 */

export const DEVPOST_ADAPTER_VERSION = 'devpost-capture/v1';

export const DEVPOST_CAPTURE_LIMITS = {
  maxHtmlBytes: 2 * 1024 * 1024,
  maxSectionChars: 20_000,
  maxTextChars: 200_000,
  maxListItems: 100,
  requestTimeoutMs: 20_000,
} as const;

/** Canonical submission fields, in display order. */
export const DEVPOST_SECTION_FIELDS = [
  'inspiration',
  'whatItDoes',
  'howWeBuiltIt',
  'challenges',
  'accomplishments',
  'whatWeLearned',
  'whatsNext',
] as const;
export type DevpostSectionField = (typeof DEVPOST_SECTION_FIELDS)[number];

const SECTION_LABELS: Record<DevpostSectionField, string> = {
  inspiration: 'Inspiration',
  whatItDoes: 'What it does',
  howWeBuiltIt: 'How we built it',
  challenges: 'Challenges we ran into',
  accomplishments: "Accomplishments that we're proud of",
  whatWeLearned: 'What we learned',
  whatsNext: "What's next",
};

/** Maps a Devpost section heading to a canonical field, or null for any other heading. */
export function sectionFieldFor(heading: string): DevpostSectionField | null {
  const text = heading.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (text.startsWith('inspiration')) return 'inspiration';
  if (text.startsWith('what it does')) return 'whatItDoes';
  if (/^how (we|i) built it/.test(text)) return 'howWeBuiltIt';
  if (text.startsWith('challenges')) return 'challenges';
  if (text.startsWith('accomplishments')) return 'accomplishments';
  if (/^what (we|i) learned/.test(text)) return 'whatWeLearned';
  if (text.startsWith("what's next")) return 'whatsNext';
  return null;
}

export interface DevpostSubmission {
  readonly title: string | null;
  readonly tagline: string | null;
  readonly sections: Readonly<Record<DevpostSectionField, string | null>>;
  readonly otherSections: readonly { readonly heading: string; readonly text: string }[];
  /** Text of the details area when it has no recognizable section headings. */
  readonly description: string | null;
  readonly builtWith: readonly string[];
  readonly submittedTo: readonly {
    readonly hackathon: string;
    readonly url: string | null;
    readonly labels: readonly string[];
  }[];
  readonly githubLinks: readonly string[];
  readonly videoLinks: readonly string[];
  readonly demoLinks: readonly string[];
}

function uniqueSorted(values: Iterable<string>, max: number): string[] {
  return [...new Set(values)].sort().slice(0, max);
}

/** Deterministic parse of a Devpost project page. Exported for direct testing. */
export function parseDevpostPage(html: string, pageUrl: string): DevpostSubmission {
  const limits = DEVPOST_CAPTURE_LIMITS;
  const root = parseHtml(html);
  const text = (value: string | undefined | null, max = 500) => {
    const normalized = value ? normalizeWhitespace(value) : '';
    return normalized === '' ? null : normalized.slice(0, max);
  };

  const title = text(root.querySelector('#app-title')?.text, 300);
  const tagline = text(
    (root.querySelector('#software-header .large') ?? root.querySelector('#app-tagline'))?.text,
    500,
  );

  const sections = Object.fromEntries(
    DEVPOST_SECTION_FIELDS.map((field) => [field, null]),
  ) as Record<DevpostSectionField, string | null>;
  const otherSections: { heading: string; text: string }[] = [];
  let description: string | null = null;
  const details = root.querySelector('#app-details-left');
  if (details) {
    // Walk the details area: each h2 opens a section that runs until the next h2.
    const nodes = details.querySelectorAll('h2, p, ul, ol, pre, blockquote, h3, h4');
    let current: { heading: string; parts: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const body = normalizeWhitespace(current.parts.join('\n\n')).slice(0, limits.maxSectionChars);
      const field = sectionFieldFor(current.heading);
      if (field && body !== '' && sections[field] === null) sections[field] = body;
      else if (!field && body !== '' && otherSections.length < 20) {
        otherSections.push({ heading: current.heading.slice(0, 200), text: body });
      }
      current = null;
    };
    for (const node of nodes) {
      if (node.closest('#built-with')) continue;
      if (node.tagName === 'H2') {
        flush();
        current = { heading: normalizeWhitespace(node.text), parts: [] };
      } else if (current && !node.parentNode?.closest('ul, ol, pre, blockquote')) {
        current.parts.push(visibleText(node));
      }
    }
    flush();
    const hasSections =
      DEVPOST_SECTION_FIELDS.some((field) => sections[field] !== null) || otherSections.length > 0;
    if (!hasSections) {
      const clone = parseHtml(details.toString());
      clone.querySelector('#built-with')?.remove();
      description = text(visibleText(clone), limits.maxSectionChars);
    }
  }

  const builtWith = uniqueSorted(
    root
      .querySelectorAll('#built-with .cp-tag')
      .map((tag) => text(tag.text, 100))
      .filter((tag): tag is string => tag !== null),
    limits.maxListItems,
  );

  const submittedTo = root
    .querySelectorAll('#submissions .software-list-content')
    .slice(0, 20)
    .map((block) => {
      const anchor = block.querySelector('a');
      return {
        hackathon: text(anchor?.text, 200) ?? '',
        url: absoluteHttpUrl(anchor?.getAttribute('href'), pageUrl),
        labels: block
          .querySelectorAll('li')
          .map((item) => text(item.text, 200))
          .filter((label): label is string => label !== null)
          .slice(0, 20),
      };
    })
    .filter((entry) => entry.hackathon !== '');

  const hrefs = [
    ...root
      .querySelectorAll('.app-links a[href], #app-details-left a[href]')
      .map((a) => a.getAttribute('href')),
    ...root
      .querySelectorAll('#gallery iframe[src], iframe[src]')
      .map((frame) => frame.getAttribute('src')),
  ]
    .map((href) => absoluteHttpUrl(href, pageUrl))
    .filter((href): href is string => href !== null);
  const githubLinks: string[] = [];
  const videoLinks: string[] = [];
  const demoLinks: string[] = [];
  for (const href of hrefs) {
    const github = parseGithubRepositoryUrl(href);
    if (typeof github !== 'string') {
      githubLinks.push(github.canonicalUrl);
      continue;
    }
    if (new URL(href).hostname.endsWith('github.com')) continue;
    const video = parseVideoUrl(href);
    if (typeof video !== 'string' && video.provider !== 'generic') {
      videoLinks.push(video.canonicalUrl);
      continue;
    }
    if (
      root
        .querySelectorAll('.app-links a[href]')
        .some((a) => absoluteHttpUrl(a.getAttribute('href'), pageUrl) === href)
    ) {
      demoLinks.push(href);
    }
  }

  return {
    title,
    tagline,
    sections,
    otherSections,
    description,
    builtWith,
    submittedTo,
    githubLinks: uniqueSorted(githubLinks, limits.maxListItems),
    videoLinks: uniqueSorted(videoLinks, limits.maxListItems),
    demoLinks: uniqueSorted(demoLinks, limits.maxListItems),
  };
}

/** The normalized plain-text rendering of a submission: only fields that were present. */
export function submissionText(submission: DevpostSubmission): string {
  const parts: string[] = [];
  if (submission.title) parts.push(`# ${submission.title}`);
  if (submission.tagline) parts.push(submission.tagline);
  for (const field of DEVPOST_SECTION_FIELDS) {
    const body = submission.sections[field];
    if (body) parts.push(`## ${SECTION_LABELS[field]}\n\n${body}`);
  }
  for (const section of submission.otherSections)
    parts.push(`## ${section.heading}\n\n${section.text}`);
  if (submission.description) parts.push(`## Description\n\n${submission.description}`);
  if (submission.builtWith.length > 0)
    parts.push(`## Built with\n\n${submission.builtWith.join(', ')}`);
  return parts.join('\n\n').slice(0, DEVPOST_CAPTURE_LIMITS.maxTextChars);
}

const EMPTY_SUBMISSION: DevpostSubmission = {
  title: null,
  tagline: null,
  sections: Object.fromEntries(DEVPOST_SECTION_FIELDS.map((field) => [field, null])) as Record<
    DevpostSectionField,
    null
  >,
  otherSections: [],
  description: null,
  builtWith: [],
  submittedTo: [],
  githubLinks: [],
  videoLinks: [],
  demoLinks: [],
};

export interface DevpostAdapterOptions {
  readonly http: HttpFetcher;
}

export function createDevpostAdapter(options: DevpostAdapterOptions): ProjectSourceAdapter {
  async function capture(input: CaptureInput): Promise<CaptureResult> {
    const ref = parseDevpostProjectUrl(input.url);
    if (typeof ref === 'string') {
      return failureResult(
        failure(
          ref === 'unsupported_host' || ref === 'unsupported_path'
            ? 'unsupported_source'
            : 'invalid_url',
          {
            adapter: 'devpost',
            reason: ref,
          },
        ),
      );
    }
    try {
      const result = await options.http.get(ref.canonicalUrl, {
        maxBodyBytes: DEVPOST_CAPTURE_LIMITS.maxHtmlBytes,
        oversize: 'truncate',
        contentTypes: ['text/html', 'application/xhtml+xml'],
        disallowedContentType: 'fail',
        timeoutMs: DEVPOST_CAPTURE_LIMITS.requestTimeoutMs,
        signal: input.signal,
      });
      if (!result.ok) {
        return failureResult(
          failure(result.failure.category, { ...result.failure.metadata, adapter: 'devpost' }),
        );
      }
      const { response } = result;
      const meta = { adapter: 'devpost', host: 'devpost.com', httpStatus: response.status };
      if (response.status === 404 || response.status === 410)
        return failureResult(failure('not_found', meta));
      if (response.status === 429) return failureResult(failure('rate_limited', meta));
      if (response.status !== 200 || response.body === null) {
        return failureResult(failure('http_api_error', meta));
      }
      const partial = new Set<CapturePartialReason>();
      let submission: DevpostSubmission;
      try {
        submission = parseDevpostPage(response.body, response.finalUrl);
      } catch {
        // Unparseable structure: keep the visible text only and say the sections are missing.
        submission = {
          ...EMPTY_SUBMISSION,
          description:
            fallbackVisibleText(response.body).slice(0, DEVPOST_CAPTURE_LIMITS.maxSectionChars) ||
            null,
        };
        partial.add('sections_missing');
      }
      if (response.truncated) partial.add('body_truncated');
      const hasBody =
        DEVPOST_SECTION_FIELDS.some((field) => submission.sections[field] !== null) ||
        submission.otherSections.length > 0 ||
        submission.description !== null;
      if (submission.title === null || !hasBody) partial.add('sections_missing');
      const missing = DEVPOST_SECTION_FIELDS.filter((field) => submission.sections[field] === null);
      const structured: JsonObject = {
        url: ref.canonicalUrl,
        finalUrl: response.finalUrl,
        title: submission.title,
        tagline: submission.tagline,
        sections: { ...submission.sections },
        missingSections: missing,
        otherSections: submission.otherSections.map((section) => ({ ...section })),
        description: submission.description,
        builtWith: [...submission.builtWith],
        submittedTo: submission.submittedTo.map((entry) => ({
          ...entry,
          labels: [...entry.labels],
        })),
        githubLinks: [...submission.githubLinks],
        videoLinks: [...submission.videoLinks],
        demoLinks: [...submission.demoLinks],
        note: 'Links are recorded as data only; they are not fetched or added as sources automatically.',
      };
      const reasons = [...partial].sort();
      return {
        status: reasons.length > 0 ? 'partial' : 'captured',
        revision: null,
        metadata: {
          adapterVersion: DEVPOST_ADAPTER_VERSION,
          slug: ref.slug,
          httpStatus: response.status,
          title: submission.title,
          presentSections: DEVPOST_SECTION_FIELDS.filter(
            (field) => submission.sections[field] !== null,
          ),
        },
        artifacts: [
          jsonArtifact('submission.json', 'submission', structured),
          textArtifact(
            'submission.txt',
            'submission_text',
            'text/plain',
            submissionText(submission),
          ),
        ],
        partialReasons: reasons,
      };
    } catch {
      return failureResult(failure('parse_failure', { adapter: 'devpost' }));
    }
  }

  return { sourceType: 'devpost', version: DEVPOST_ADAPTER_VERSION, capture };
}
