import { parse, type HTMLElement } from 'node-html-parser';
import { normalizeText } from './hash.js';

/*
 * Deterministic, non-executing HTML inspection. The parser builds a tree only: scripts are never
 * run, script/style/noscript content is discarded, event-handler attributes are ignored and no
 * subresource is fetched. Extracted text stays untrusted data.
 */

export const HTML_EXTRACTION_LIMITS = {
  headings: 50,
  headingChars: 300,
  links: 200,
  openGraphEntries: 20,
  attributeChars: 2_000,
} as const;

export interface HtmlLink {
  readonly href: string;
  readonly text: string;
}

export interface HtmlDocument {
  readonly title: string | null;
  readonly description: string | null;
  readonly lang: string | null;
  readonly canonicalUrl: string | null;
  readonly openGraph: Readonly<Record<string, string>>;
  readonly headings: readonly string[];
  readonly links: readonly HtmlLink[];
  readonly linkCount: number;
  readonly scriptCount: number;
  readonly text: string;
}

/**
 * `parseNoneClosedTags` keeps parsing linear on HTML with unclosed elements (the library's
 * default backtracking is quadratic, which hostile or truncated pages could exploit).
 */
export function parseHtml(html: string): HTMLElement {
  return parse(html, {
    comment: false,
    lowerCaseTagName: true,
    parseNoneClosedTags: true,
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  });
}

/** Collapses runs of whitespace inside lines and blank-line runs; NFC, `\n` line endings. */
export function normalizeWhitespace(text: string): string {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.replace(/[\t \u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = normalizeWhitespace(value);
  return text === '' ? null : text.slice(0, max);
}

/** Resolves an href against the page URL; only http(s) URLs without credentials are kept. */
export function absoluteHttpUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim(), baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href.length <= 2_048 ? url.href : null;
  } catch {
    return null;
  }
}

/** Visible text of an element: scripts, styles, templates and SVG removed. */
export function visibleText(element: HTMLElement): string {
  const clone = parseHtml(element.toString());
  for (const node of clone.querySelectorAll('script, style, noscript, template, svg')) {
    node.remove();
  }
  return normalizeWhitespace(clone.structuredText);
}

const SKIPPED_CONTENT_TAGS = ['script', 'style', 'noscript', 'template', 'svg'];

/**
 * Linear, parser-free visible-text fallback for markup the tree parser cannot handle (for example
 * pathologically deep nesting that would exhaust the stack). Tags are skipped; script, style,
 * noscript, template and SVG content is dropped; entities are left as written.
 */
export function fallbackVisibleText(html: string): string {
  const lower = html.toLowerCase();
  let output = '';
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      output += html.slice(index);
      break;
    }
    output += html.slice(index, open);
    const close = html.indexOf('>', open + 1);
    if (close === -1) break;
    const tag = /^<\s*([a-z0-9]+)/.exec(lower.slice(open, Math.min(close + 1, open + 40)))?.[1];
    index = close + 1;
    if (tag && SKIPPED_CONTENT_TAGS.includes(tag)) {
      const end = lower.indexOf(`</${tag}`, index);
      if (end === -1) break;
      index = end;
      continue;
    }
    output += ' ';
    if (tag && /^(p|div|br|li|h[1-6]|tr|section|article|header|footer|main|nav)$/.test(tag))
      output += '\n';
  }
  return normalizeWhitespace(output);
}

export function extractHtmlDocument(html: string, baseUrl: string): HtmlDocument {
  try {
    return extractParsed(html, baseUrl);
  } catch {
    // Parser limits (e.g. stack exhaustion on hostile nesting) degrade to plain text only.
    return {
      title: null,
      description: null,
      lang: null,
      canonicalUrl: null,
      openGraph: {},
      headings: [],
      links: [],
      linkCount: 0,
      scriptCount: 0,
      text: fallbackVisibleText(html),
    };
  }
}

function extractParsed(html: string, baseUrl: string): HtmlDocument {
  const root = parseHtml(html);
  const max = HTML_EXTRACTION_LIMITS.attributeChars;
  const meta = (selector: string) =>
    clip(root.querySelector(selector)?.getAttribute('content'), max);

  const openGraph: Record<string, string> = {};
  for (const node of root.querySelectorAll('meta[property]')) {
    const property = (node.getAttribute('property') ?? '').toLowerCase();
    const content = clip(node.getAttribute('content'), max);
    if (/^og:[a-z_:]{1,40}$/.test(property) && content && !(property in openGraph)) {
      if (Object.keys(openGraph).length >= HTML_EXTRACTION_LIMITS.openGraphEntries) break;
      openGraph[property] = content;
    }
  }

  const anchors = root.querySelectorAll('a[href]');
  const links: HtmlLink[] = [];
  for (const anchor of anchors) {
    if (links.length >= HTML_EXTRACTION_LIMITS.links) break;
    const href = absoluteHttpUrl(anchor.getAttribute('href'), baseUrl);
    if (href) links.push({ href, text: clip(anchor.text, 200) ?? '' });
  }

  const body = root.querySelector('body') ?? root;
  return {
    title: clip(root.querySelector('title')?.text, 500),
    description: meta('meta[name="description"]'),
    lang: clip(root.querySelector('html')?.getAttribute('lang'), 35),
    canonicalUrl: absoluteHttpUrl(
      root.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      baseUrl,
    ),
    openGraph,
    headings: root
      .querySelectorAll('h1, h2')
      .map((heading) => clip(heading.text, HTML_EXTRACTION_LIMITS.headingChars))
      .filter((heading): heading is string => heading !== null)
      .slice(0, HTML_EXTRACTION_LIMITS.headings),
    links,
    linkCount: anchors.length,
    scriptCount: root.querySelectorAll('script').length,
    text: visibleText(body),
  };
}
