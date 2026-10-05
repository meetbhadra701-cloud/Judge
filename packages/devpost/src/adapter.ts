import {
  absoluteHttpUrl,
  failure,
  failureResult,
  fallbackVisibleText,
  HTML_EXTRACTION_LIMITS,
  HtmlBudgetError,
  isSkippedContentTag,
  jsonArtifact,
  normalizeWhitespace,
  parseDevpostProjectUrl,
  parseGithubRepositoryUrl,
  parseHtml,
  parseVideoUrl,
  StructuredText,
  textArtifact,
  TextCollector,
  walkHtml,
  type CaptureInput,
  type HtmlElement,
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

// Mask bits returned by the traversal's `enter` and handed back to `leave`.
const M_DETAILS = 1;
const M_BUILT_WITH = 2;
const M_APP_LINKS = 4;
const M_SUBMISSIONS = 8;
const M_HEADER = 16;
const M_SKIP = 32;
const M_LIST = 64;
const M_PART = 128;
const M_H2 = 256;
const M_TITLE = 512;
const M_TAGLINE_LARGE = 1024;
const M_TAGLINE_ID = 2048;
const M_TAG = 4096;
const M_BLOCK = 8192;
const M_BLOCK_ANCHOR = 16384;
const M_LABEL = 32768;

const PART_TAGS = new Set(['p', 'ul', 'ol', 'pre', 'blockquote', 'h3', 'h4']);
const LIST_TAGS = new Set(['ul', 'ol', 'pre', 'blockquote']);
/** Candidate links considered per page; further links are ignored (bounded work). */
const MAX_CANDIDATE_LINKS = 2_000;
const MAX_BUILT_WITH_CANDIDATES = 1_000;

function hasClass(element: HtmlElement, name: string): boolean {
  const value = element.getAttribute('class');
  return value !== undefined && value.split(/\s+/).includes(name);
}

/**
 * Deterministic parse of a Devpost project page. Exported for direct testing.
 *
 * ONE bounded traversal of the tree (`walkHtml`) tracks which region each node is in and feeds
 * small collectors; no whole-tree selector is ever run, and nothing is re-parsed. Throws
 * `HtmlBudgetError` when the page has more nodes than the traversal budget allows.
 */
export function parseDevpostPage(
  html: string,
  pageUrl: string,
  options: { readonly maxNodes?: number } = {},
): DevpostSubmission {
  const limits = DEVPOST_CAPTURE_LIMITS;
  const root = parseHtml(html);
  const text = (value: string | undefined | null, max = 500) => {
    const normalized = value ? normalizeWhitespace(value) : '';
    return normalized === '' ? null : normalized.slice(0, max);
  };

  const sections = Object.fromEntries(
    DEVPOST_SECTION_FIELDS.map((field) => [field, null]),
  ) as Record<DevpostSectionField, string | null>;
  const otherSections: { heading: string; text: string }[] = [];

  interface OpenSection {
    heading: string;
    parts: string[];
    chars: number;
  }
  interface OpenBlock {
    hackathon: string | null;
    url: string | null;
    anchorSeen: boolean;
    labels: string[];
  }
  const submittedTo: { hackathon: string; url: string | null; labels: string[] }[] = [];
  const builtWithTags = new Set<string>();
  const hrefs: string[] = [];
  const appLinkHrefs = new Set<string>();
  const iframeSources: string[] = [];

  const s = {
    skipDepth: 0,
    detailsSeen: false,
    detailsDepth: 0,
    builtWithDepth: 0,
    appLinksDepth: 0,
    submissionsDepth: 0,
    headerDepth: 0,
    listDepth: 0,
    titleSeen: false,
    titleCollector: null as TextCollector | null,
    title: null as string | null,
    largeSeen: false,
    largeCollector: null as TextCollector | null,
    large: null as string | null,
    taglineIdSeen: false,
    taglineIdCollector: null as TextCollector | null,
    taglineId: null as string | null,
    section: null as OpenSection | null,
    headingCollector: null as TextCollector | null,
    partRoot: null as HtmlElement | null,
    part: null as StructuredText | null,
    detailsText: new StructuredText(),
    tagCollector: null as TextCollector | null,
    block: null as OpenBlock | null,
    blockAnchorCollector: null as TextCollector | null,
    labelCollector: null as TextCollector | null,
  };

  const flushSection = () => {
    const section = s.section;
    if (!section) return;
    const body = normalizeWhitespace(section.parts.join('\n\n')).slice(0, limits.maxSectionChars);
    const field = sectionFieldFor(section.heading);
    if (field && body !== '' && sections[field] === null) sections[field] = body;
    else if (!field && body !== '' && otherSections.length < 20) {
      otherSections.push({ heading: section.heading.slice(0, 200), text: body });
    }
    s.section = null;
  };
  const endPart = () => {
    const section = s.section;
    if (section && s.part && section.chars < limits.maxSectionChars) {
      const partText = s.part.toString();
      section.parts.push(partText);
      section.chars += partText.length;
    }
    s.part = null;
    s.partRoot = null;
  };
  const inDetails = () => s.detailsDepth > 0 && s.builtWithDepth === 0;

  walkHtml(
    root,
    {
      enter(element, tag) {
        let mask = 0;
        if (isSkippedContentTag(tag)) {
          s.skipDepth += 1;
          mask |= M_SKIP;
        } else if (s.skipDepth === 0) {
          if (inDetails()) s.detailsText.enterElement(tag);
          s.part?.enterElement(tag);
        }
        if (tag === 'br') {
          s.titleCollector?.add('\n');
          s.headingCollector?.add('\n');
        }
        const id = element.rawAttrs ? element.getAttribute('id') : undefined;

        // Regions. A `.class` selector matches descendants only, so it is evaluated before this
        // element opens its own region.
        if (hasClass(element, 'large') && s.headerDepth > 0 && !s.largeSeen) {
          s.largeSeen = true;
          s.largeCollector = new TextCollector();
          mask |= M_TAGLINE_LARGE;
        }
        if (hasClass(element, 'cp-tag') && s.builtWithDepth > 0 && s.tagCollector === null) {
          s.tagCollector = new TextCollector();
          mask |= M_TAG;
        }
        if (
          hasClass(element, 'software-list-content') &&
          s.submissionsDepth > 0 &&
          s.block === null &&
          submittedTo.length < 20
        ) {
          s.block = { hackathon: null, url: null, anchorSeen: false, labels: [] };
          mask |= M_BLOCK;
        } else if (s.block) {
          if (tag === 'a' && !s.block.anchorSeen) {
            s.block.anchorSeen = true;
            s.block.url = absoluteHttpUrl(element.getAttribute('href'), pageUrl);
            s.blockAnchorCollector = new TextCollector();
            mask |= M_BLOCK_ANCHOR;
          } else if (tag === 'li' && s.labelCollector === null && s.block.labels.length < 20) {
            s.labelCollector = new TextCollector();
            mask |= M_LABEL;
          }
        }
        if (id === 'app-title' && !s.titleSeen) {
          s.titleSeen = true;
          s.titleCollector = new TextCollector();
          mask |= M_TITLE;
        }
        if (id === 'app-tagline' && !s.taglineIdSeen) {
          s.taglineIdSeen = true;
          s.taglineIdCollector = new TextCollector();
          mask |= M_TAGLINE_ID;
        }
        if (id === 'software-header') {
          s.headerDepth += 1;
          mask |= M_HEADER;
        }
        if (id === 'built-with') {
          s.builtWithDepth += 1;
          mask |= M_BUILT_WITH;
        }
        if (hasClass(element, 'app-links')) {
          s.appLinksDepth += 1;
          mask |= M_APP_LINKS;
        }
        if (id === 'submissions') {
          s.submissionsDepth += 1;
          mask |= M_SUBMISSIONS;
        }
        if (id === 'app-details-left' && !s.detailsSeen) {
          s.detailsSeen = true;
          s.detailsDepth += 1;
          mask |= M_DETAILS;
        }

        // Sections of the details area: each h2 opens a section that runs until the next h2.
        if (inDetails() && s.detailsDepth > 0 && (mask & M_DETAILS) === 0) {
          if (tag === 'h2' && s.headingCollector === null) {
            if (s.part) endPart();
            flushSection();
            s.section = { heading: '', parts: [], chars: 0 };
            s.headingCollector = new TextCollector();
            mask |= M_H2;
          } else if (
            PART_TAGS.has(tag) &&
            s.section &&
            !s.part &&
            s.headingCollector === null &&
            s.listDepth === 0
          ) {
            s.part = new StructuredText(limits.maxSectionChars);
            s.partRoot = element;
            mask |= M_PART;
            s.part.enterElement(tag);
          }
          if (LIST_TAGS.has(tag)) {
            s.listDepth += 1;
            mask |= M_LIST;
          }
        }

        if (tag === 'a' && element.hasAttribute('href')) {
          const inAppLinks = s.appLinksDepth > 0;
          if ((inAppLinks || s.detailsDepth > 0) && hrefs.length < MAX_CANDIDATE_LINKS) {
            const href = absoluteHttpUrl(element.getAttribute('href'), pageUrl);
            if (href) {
              hrefs.push(href);
              if (inAppLinks) appLinkHrefs.add(href);
            }
          }
        } else if (
          tag === 'iframe' &&
          element.hasAttribute('src') &&
          iframeSources.length < MAX_CANDIDATE_LINKS
        ) {
          const src = absoluteHttpUrl(element.getAttribute('src'), pageUrl);
          if (src) iframeSources.push(src);
        }
        return mask;
      },
      leave(element, tag, mask) {
        if (mask & M_SKIP) s.skipDepth -= 1;
        else if (s.skipDepth === 0) {
          s.part?.leaveElement(tag);
          if (inDetails()) s.detailsText.leaveElement(tag);
        }
        if (mask & M_PART && s.partRoot === element) endPart();
        if (mask & M_LIST) s.listDepth -= 1;
        if (mask & M_H2) {
          if (s.section)
            s.section.heading = normalizeWhitespace(s.headingCollector?.toString() ?? '');
          s.headingCollector = null;
        }
        if (mask & M_TITLE) {
          s.title = text(s.titleCollector?.toString(), 300);
          s.titleCollector = null;
        }
        if (mask & M_TAGLINE_LARGE) {
          s.large = text(s.largeCollector?.toString(), 500);
          s.largeCollector = null;
        }
        if (mask & M_TAGLINE_ID) {
          s.taglineId = text(s.taglineIdCollector?.toString(), 500);
          s.taglineIdCollector = null;
        }
        if (mask & M_TAG) {
          const tagText = text(s.tagCollector?.toString(), 100);
          if (tagText !== null && builtWithTags.size < MAX_BUILT_WITH_CANDIDATES) {
            builtWithTags.add(tagText);
          }
          s.tagCollector = null;
        }
        if (mask & M_BLOCK_ANCHOR && s.block) {
          s.block.hackathon = text(s.blockAnchorCollector?.toString(), 200);
          s.blockAnchorCollector = null;
        }
        if (mask & M_LABEL && s.block) {
          const label = text(s.labelCollector?.toString(), 200);
          if (label !== null) s.block.labels.push(label);
          s.labelCollector = null;
        }
        if (mask & M_BLOCK && s.block) {
          if ((s.block.hackathon ?? '') !== '') {
            submittedTo.push({
              hackathon: s.block.hackathon ?? '',
              url: s.block.url,
              labels: s.block.labels,
            });
          }
          // Blocks that lack a hackathon name are dropped, as before.
          s.block = null;
        }
        if (mask & M_HEADER) s.headerDepth -= 1;
        if (mask & M_BUILT_WITH) s.builtWithDepth -= 1;
        if (mask & M_APP_LINKS) s.appLinksDepth -= 1;
        if (mask & M_SUBMISSIONS) s.submissionsDepth -= 1;
        if (mask & M_DETAILS) s.detailsDepth -= 1;
      },
      text(node) {
        const raw = node.rawText;
        const decoded = node.text;
        if (s.skipDepth === 0) {
          if (inDetails()) s.detailsText.addText(raw, decoded);
          s.part?.addText(raw, decoded);
        }
        s.titleCollector?.add(decoded);
        s.largeCollector?.add(decoded);
        s.taglineIdCollector?.add(decoded);
        s.headingCollector?.add(decoded);
        s.tagCollector?.add(decoded);
        s.blockAnchorCollector?.add(decoded);
        s.labelCollector?.add(decoded);
      },
    },
    options.maxNodes ?? HTML_EXTRACTION_LIMITS.maxNodes,
  );
  if (s.part) endPart();
  flushSection();

  const hasSections =
    DEVPOST_SECTION_FIELDS.some((field) => sections[field] !== null) || otherSections.length > 0;
  const description =
    s.detailsSeen && !hasSections ? text(s.detailsText.toString(), limits.maxSectionChars) : null;

  const builtWith = uniqueSorted(builtWithTags, limits.maxListItems);

  const githubLinks: string[] = [];
  const videoLinks: string[] = [];
  const demoLinks: string[] = [];
  for (const href of [...hrefs, ...iframeSources]) {
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
    if (appLinkHrefs.has(href)) demoLinks.push(href);
  }

  return {
    title: s.title,
    tagline: s.large ?? s.taglineId,
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
      } catch (error) {
        // Over the traversal budget or unparseable structure: keep the visible text only and say
        // the sections are missing. The page is never re-traversed.
        if (error instanceof HtmlBudgetError) partial.add('html_structure_limit');
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
