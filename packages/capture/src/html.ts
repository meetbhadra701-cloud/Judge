import { NodeType, parse, type HTMLElement, type TextNode } from 'node-html-parser';
import { normalizeText } from './hash.js';

/*
 * Deterministic, non-executing, structurally bounded HTML inspection.
 *
 * The tree parser builds a tree only: scripts are never run, script/style/noscript content is
 * discarded, event-handler attributes are ignored and no subresource is fetched. Extracted text
 * stays untrusted data.
 *
 * Work is bounded by construction. The parser itself is linear. Everything after it is ONE
 * iterative depth-first traversal (`walkHtml`) that visits each node at most once, never calls a
 * whole-tree selector, never re-serializes or re-parses a subtree, and throws `HtmlBudgetError`
 * once `HTML_EXTRACTION_LIMITS.maxNodes` nodes have been visited. Per node the work is O(1) plus
 * the node's own text/attributes: every collector (title, headings, links, ...) has a character
 * cap and only the outermost nested element of a kind is collected, so hostile nesting cannot
 * multiply the work. Callers degrade deterministically when the budget is exhausted (see
 * `fallbackVisibleText`, itself linear).
 */

export const HTML_EXTRACTION_LIMITS = {
  headings: 50,
  headingChars: 300,
  links: 200,
  openGraphEntries: 20,
  attributeChars: 2_000,
  /** Maximum nodes (elements + text) one traversal may visit before it gives up. */
  maxNodes: 400_000,
  /** Raw characters a single element-text collector keeps before normalization. */
  collectorChars: 8_192,
} as const;

/** The tree parser's element type, re-exported so adapters need no direct parser dependency. */
export type { HTMLElement as HtmlElement };

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
  /**
   * True when the node budget (or the parser) gave up: metadata then holds only what was seen
   * before that point and `text` comes from the parser-free fallback.
   */
  readonly degraded: boolean;
}

export interface HtmlExtractionOptions {
  /** Override of `HTML_EXTRACTION_LIMITS.maxNodes` (tests). */
  readonly maxNodes?: number;
}

/** Thrown by `walkHtml` when a document has more nodes than the traversal budget allows. */
export class HtmlBudgetError extends Error {
  constructor(readonly maxNodes: number) {
    super(`HTML exceeds the ${String(maxNodes)} node budget`);
    this.name = 'HtmlBudgetError';
  }
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

// ---------------------------------------------------------------------------------------------
// Bounded traversal

export interface HtmlVisitor {
  /** Called before an element's children. The returned bit mask is passed back to `leave`. */
  enter?(element: HTMLElement, tag: string): number;
  /** Called after an element's children, with the mask `enter` returned (0 when absent). */
  leave?(element: HTMLElement, tag: string, mask: number): void;
  text?(node: TextNode): void;
}

interface Frame {
  readonly element: HTMLElement | null;
  readonly tag: string;
  readonly mask: number;
  next: number;
}

/**
 * Iterative depth-first traversal in document order. Each node is visited exactly once; there is
 * no recursion, so nesting depth cannot exhaust the stack.
 */
export function walkHtml(
  root: HTMLElement,
  visitor: HtmlVisitor,
  maxNodes: number = HTML_EXTRACTION_LIMITS.maxNodes,
): number {
  let visited = 0;
  const frames: Frame[] = [{ element: null, tag: '', mask: 0, next: 0 }];
  for (;;) {
    const frame = frames[frames.length - 1];
    if (!frame) return visited;
    const children = (frame.element ?? root).childNodes;
    const node = children[frame.next];
    if (node === undefined) {
      frames.pop();
      if (frame.element) visitor.leave?.(frame.element, frame.tag, frame.mask);
      continue;
    }
    frame.next += 1;
    visited += 1;
    if (visited > maxNodes) throw new HtmlBudgetError(maxNodes);
    if (node.nodeType === NodeType.TEXT_NODE) {
      visitor.text?.(node as TextNode);
    } else if (node.nodeType === NodeType.ELEMENT_NODE) {
      const element = node as HTMLElement;
      const tag = element.rawTagName;
      frames.push({ element, tag, mask: visitor.enter?.(element, tag) ?? 0, next: 0 });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text helpers

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

/** Tags whose content is never visible text. */
export const SKIPPED_CONTENT_TAGS: readonly string[] = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
];
const SKIPPED = new Set(SKIPPED_CONTENT_TAGS);

/** Elements that start a new text block (the same set the tree parser uses for structured text). */
const BLOCK_ELEMENTS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'details',
  'dialog',
  'dd',
  'div',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'table',
  'td',
  'tr',
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'ul',
]);

export function isSkippedContentTag(tag: string): boolean {
  return SKIPPED.has(tag);
}

/** Whitespace-trimmed text that keeps a single leading/trailing space when there was one. */
function trimKeepingEdgeSpace(text: string): string {
  const core = text.trim();
  if (core === '') return '';
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const lead = start > 0 && /[^\S\r\n]/.test(text.charAt(start - 1)) ? ' ' : '';
  const tail = end < text.length && /[^\S\r\n]/.test(text.charAt(end)) ? ' ' : '';
  return `${lead}${core}${tail}`;
}

interface Block {
  parts: string[];
  prependWhitespace: boolean;
}

/**
 * Accumulates structured visible text (block elements become line breaks) from a stream of
 * enter/leave/text events, with a hard character cap so memory stays bounded.
 */
export class StructuredText {
  private blocks: Block[];
  private current: Block;
  private chars = 0;

  constructor(private readonly maxChars: number = Number.POSITIVE_INFINITY) {
    this.current = { parts: [], prependWhitespace: false };
    this.blocks = [this.current];
  }

  get full(): boolean {
    return this.chars >= this.maxChars;
  }

  private newBlock(): void {
    if (this.current.parts.length > 0) {
      this.current = { parts: [], prependWhitespace: false };
      this.blocks.push(this.current);
    }
  }

  enterElement(tag: string): void {
    if (BLOCK_ELEMENTS.has(tag)) this.newBlock();
  }

  leaveElement(tag: string): void {
    if (BLOCK_ELEMENTS.has(tag)) this.newBlock();
  }

  addText(rawText: string, decoded: string): void {
    if (this.full) return;
    if (/^(\s|&nbsp;)*$/.test(rawText)) {
      this.current.prependWhitespace = true;
      return;
    }
    let text = trimKeepingEdgeSpace(decoded);
    if (this.current.prependWhitespace) {
      text = ` ${text}`;
      this.current.prependWhitespace = false;
    }
    this.chars += text.length;
    this.current.parts.push(text);
  }

  toString(): string {
    const joined = this.blocks
      .map((block) => block.parts.join('').replace(/\s{2,}/g, ' '))
      .join('\n')
      .replace(/\s+$/, '');
    return normalizeWhitespace(joined);
  }
}

/** Collects the text of one element, keeping at most `HTML_EXTRACTION_LIMITS.collectorChars`. */
export class TextCollector {
  private value = '';

  add(text: string): void {
    if (this.value.length >= HTML_EXTRACTION_LIMITS.collectorChars) return;
    this.value += text;
  }

  toString(): string {
    return this.value;
  }
}

/** Visible text of one element's subtree via a bounded traversal (never re-parses). */
export function visibleText(
  element: HTMLElement,
  maxNodes: number = HTML_EXTRACTION_LIMITS.maxNodes,
): string {
  const blocks = new StructuredText();
  let skipDepth = 0;
  walkHtml(
    element,
    {
      enter(_node, tag) {
        if (SKIPPED.has(tag)) {
          skipDepth += 1;
          return 1;
        }
        if (skipDepth === 0) blocks.enterElement(tag);
        return 0;
      },
      leave(_node, tag, mask) {
        if (mask === 1) skipDepth -= 1;
        else if (skipDepth === 0) blocks.leaveElement(tag);
      },
      text(node) {
        if (skipDepth === 0) blocks.addText(node.rawText, node.text);
      },
    },
    maxNodes,
  );
  return blocks.toString();
}

/**
 * Linear, parser-free visible-text fallback for markup the tree traversal gave up on (for
 * example pathological node counts). Tags are skipped; script, style, noscript, template and SVG
 * content is dropped; entities are left as written.
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
    if (tag && SKIPPED.has(tag)) {
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

// ---------------------------------------------------------------------------------------------
// Document extraction (deployment pages, generic video pages)

const TITLE = 1;
const HEADING = 2;
const ANCHOR = 4;
const SKIP_TEXT = 8;
const BODY = 16;

function emptyDocument(text: string, degraded: boolean): HtmlDocument {
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
    text,
    degraded,
  };
}

export function extractHtmlDocument(
  html: string,
  baseUrl: string,
  options: HtmlExtractionOptions = {},
): HtmlDocument {
  let root: HTMLElement;
  try {
    root = parseHtml(html);
  } catch {
    // Parser limits (for example stack exhaustion) degrade to plain text only.
    return emptyDocument(fallbackVisibleText(html), true);
  }

  const limits = HTML_EXTRACTION_LIMITS;
  const attributeChars = limits.attributeChars;
  // Mutable traversal state lives in one object: the visitor closures update it.
  const state = {
    everything: new StructuredText(),
    body: null as StructuredText | null,
    bodyActive: false,
    skipDepth: 0,
    title: null as string | null,
    titleSeen: false,
    titleCollector: null as TextCollector | null,
    description: null as string | null,
    descriptionSeen: false,
    lang: null as string | null,
    langSeen: false,
    canonicalUrl: null as string | null,
    canonicalSeen: false,
    openGraphFull: false,
    headingCollector: null as TextCollector | null,
    linkCount: 0,
    anchorCollector: null as TextCollector | null,
    anchorHref: '',
    scriptCount: 0,
  };
  const openGraph: Record<string, string> = {};
  const headings: string[] = [];
  const links: HtmlLink[] = [];

  const visitor: HtmlVisitor = {
    enter(element, tag) {
      let mask = 0;
      if (SKIPPED.has(tag)) {
        state.skipDepth += 1;
        mask |= SKIP_TEXT;
      } else if (state.skipDepth === 0) {
        state.everything.enterElement(tag);
        if (state.bodyActive) state.body?.enterElement(tag);
      }
      if (tag === 'br') {
        state.titleCollector?.add('\n');
        state.headingCollector?.add('\n');
        state.anchorCollector?.add('\n');
      }
      switch (tag) {
        case 'body':
          if (state.body === null) {
            state.body = new StructuredText();
            state.bodyActive = true;
            mask |= BODY;
          }
          break;
        case 'html':
          if (!state.langSeen) {
            state.langSeen = true;
            state.lang = clip(element.getAttribute('lang'), 35);
          }
          break;
        case 'title':
          if (!state.titleSeen) {
            state.titleSeen = true;
            state.titleCollector = new TextCollector();
            mask |= TITLE;
          }
          break;
        case 'meta': {
          const name = element.getAttribute('name');
          if (name === 'description' && !state.descriptionSeen) {
            state.descriptionSeen = true;
            state.description = clip(element.getAttribute('content'), attributeChars);
          }
          const rawProperty = element.getAttribute('property');
          if (rawProperty !== undefined && !state.openGraphFull) {
            const property = rawProperty.toLowerCase();
            if (/^og:[a-z_:]{1,40}$/.test(property) && !(property in openGraph)) {
              const content = clip(element.getAttribute('content'), attributeChars);
              if (content) {
                if (Object.keys(openGraph).length >= limits.openGraphEntries) {
                  state.openGraphFull = true;
                } else {
                  openGraph[property] = content;
                }
              }
            }
          }
          break;
        }
        case 'link':
          if (!state.canonicalSeen && element.getAttribute('rel') === 'canonical') {
            state.canonicalSeen = true;
            state.canonicalUrl = absoluteHttpUrl(element.getAttribute('href'), baseUrl);
          }
          break;
        case 'script':
          state.scriptCount += 1;
          break;
        case 'a':
          if (element.hasAttribute('href')) {
            state.linkCount += 1;
            if (links.length < limits.links && state.anchorCollector === null) {
              const href = absoluteHttpUrl(element.getAttribute('href'), baseUrl);
              if (href) {
                state.anchorHref = href;
                state.anchorCollector = new TextCollector();
                mask |= ANCHOR;
              }
            }
          }
          break;
        case 'h1':
        case 'h2':
          if (headings.length < limits.headings && state.headingCollector === null) {
            state.headingCollector = new TextCollector();
            mask |= HEADING;
          }
          break;
        default:
          break;
      }
      return mask;
    },
    leave(_element, tag, mask) {
      if (mask & SKIP_TEXT) state.skipDepth -= 1;
      else if (state.skipDepth === 0) {
        state.everything.leaveElement(tag);
        if (state.bodyActive) state.body?.leaveElement(tag);
      }
      if (mask & BODY) state.bodyActive = false;
      if (mask & TITLE) {
        state.title = clip(state.titleCollector?.toString(), 500);
        state.titleCollector = null;
      }
      if (mask & HEADING) {
        const heading = clip(state.headingCollector?.toString(), limits.headingChars);
        if (heading !== null) headings.push(heading);
        state.headingCollector = null;
      }
      if (mask & ANCHOR) {
        links.push({
          href: state.anchorHref,
          text: clip(state.anchorCollector?.toString(), 200) ?? '',
        });
        state.anchorCollector = null;
      }
    },
    text(node) {
      const raw = node.rawText;
      const decoded = node.text;
      if (state.skipDepth === 0) {
        state.everything.addText(raw, decoded);
        if (state.bodyActive) state.body?.addText(raw, decoded);
      }
      state.titleCollector?.add(decoded);
      state.headingCollector?.add(decoded);
      state.anchorCollector?.add(decoded);
    },
  };

  let degraded = false;
  try {
    walkHtml(root, visitor, options.maxNodes ?? limits.maxNodes);
  } catch {
    // Budget exhausted (or an unexpected parser object): keep what was seen, finish any element
    // still being collected, and take the text from the parser-free fallback.
    degraded = true;
    if (state.titleCollector) state.title = clip(state.titleCollector.toString(), 500);
    if (state.headingCollector) {
      const heading = clip(state.headingCollector.toString(), limits.headingChars);
      if (heading !== null && headings.length < limits.headings) headings.push(heading);
    }
    if (state.anchorCollector && links.length < limits.links) {
      links.push({
        href: state.anchorHref,
        text: clip(state.anchorCollector.toString(), 200) ?? '',
      });
    }
  }

  return {
    title: state.title,
    description: state.description,
    lang: state.lang,
    canonicalUrl: state.canonicalUrl,
    openGraph,
    headings,
    links,
    linkCount: state.linkCount,
    scriptCount: state.scriptCount,
    text: degraded ? fallbackVisibleText(html) : (state.body ?? state.everything).toString(),
    degraded,
  };
}
