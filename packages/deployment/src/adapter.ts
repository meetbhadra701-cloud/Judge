import {
  extractHtmlDocument,
  failure,
  failureResult,
  jsonArtifact,
  normalizeHttpUrl,
  normalizeWhitespace,
  textArtifact,
  truncateUtf8,
  type CaptureInput,
  type CaptureResult,
  type HttpFetcher,
  type JsonObject,
  type ProjectSourceAdapter,
} from '@judge-copilot/capture';
import type { CapturePartialReason } from '@judge-copilot/schemas';

/*
 * Deployment observation: one SSRF-safe GET (redirects re-validated by the client), recording
 * what came back. Any HTTP response obtained safely is a successful observation, including 404
 * and 500: the status is data, never a verdict. Transport, DNS, TLS and timeout problems are
 * `failed`; policy refusals are `rejected`. No JavaScript runs, no form is touched, no
 * subresource is fetched, no credentials or cookies are sent, and no screenshot is taken.
 */

export const DEPLOYMENT_ADAPTER_VERSION = 'deployment-capture/v1';

export const DEPLOYMENT_CAPTURE_LIMITS = {
  maxBodyBytes: 1024 * 1024,
  maxTextBytes: 256 * 1024,
  requestTimeoutMs: 15_000,
} as const;

/** Body media types read and stored as text. Anything else is recorded without its body. */
export const DEPLOYMENT_TEXT_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export interface DeploymentAdapterOptions {
  readonly http: HttpFetcher;
  /** Override of `DEPLOYMENT_CAPTURE_LIMITS.requestTimeoutMs` (tests, slow environments). */
  readonly timeoutMs?: number;
}

export function createDeploymentAdapter(options: DeploymentAdapterOptions): ProjectSourceAdapter {
  async function capture(input: CaptureInput): Promise<CaptureResult> {
    const checked = normalizeHttpUrl(input.url, { allowHttp: true });
    if (!checked.ok) {
      return failureResult(
        failure('invalid_url', { adapter: 'deployment', reason: checked.reason }),
      );
    }
    const result = await options.http.get(checked.url, {
      allowHttp: true,
      maxBodyBytes: DEPLOYMENT_CAPTURE_LIMITS.maxBodyBytes,
      oversize: 'truncate',
      contentTypes: DEPLOYMENT_TEXT_CONTENT_TYPES,
      disallowedContentType: 'omit_body',
      timeoutMs: options.timeoutMs ?? DEPLOYMENT_CAPTURE_LIMITS.requestTimeoutMs,
      signal: input.signal,
    });
    if (!result.ok) {
      return failureResult(
        failure(result.failure.category, { ...result.failure.metadata, adapter: 'deployment' }),
      );
    }
    const { response } = result;
    const partial = new Set<CapturePartialReason>();
    if (response.truncated) partial.add('body_truncated');
    if (response.bodyOmitted) partial.add('body_not_captured');

    const responseJson: JsonObject = {
      requestedUrl: checked.url,
      finalUrl: response.finalUrl,
      httpStatus: response.status,
      contentType: response.contentType,
      headers: { ...response.headers },
      redirects: response.redirects.map((redirect) => ({ ...redirect })),
      bodyBytesRead: response.bodyBytes,
      bodyTruncated: response.truncated,
      bodyOmitted: response.bodyOmitted,
      note: 'An HTTP status is an observation, not a score. No JavaScript was executed.',
    };
    const artifacts = [jsonArtifact('response.json', 'http_response', responseJson)];
    let title: string | null = null;
    if (response.body !== null) {
      if (response.contentType === 'text/plain') {
        const text = truncateUtf8(
          normalizeWhitespace(response.body),
          DEPLOYMENT_CAPTURE_LIMITS.maxTextBytes,
        );
        if (text.truncated) partial.add('body_truncated');
        artifacts.push(textArtifact('page.txt', 'page_text', 'text/plain', text.text));
      } else {
        const document = extractHtmlDocument(response.body, response.finalUrl);
        title = document.title;
        const text = truncateUtf8(document.text, DEPLOYMENT_CAPTURE_LIMITS.maxTextBytes);
        if (text.truncated) partial.add('body_truncated');
        artifacts.push(
          jsonArtifact('page.json', 'page_metadata', {
            title: document.title,
            description: document.description,
            lang: document.lang,
            canonicalUrl: document.canonicalUrl,
            openGraph: { ...document.openGraph },
            headings: [...document.headings],
            linkCount: document.linkCount,
            scriptCount: document.scriptCount,
            links: document.links.map((link) => ({ ...link })),
          }),
          textArtifact('page.txt', 'page_text', 'text/plain', text.text),
        );
      }
    }
    const reasons = [...partial].sort();
    return {
      status: reasons.length > 0 ? 'partial' : 'captured',
      revision: null,
      metadata: {
        adapterVersion: DEPLOYMENT_ADAPTER_VERSION,
        httpStatus: response.status,
        finalUrl: response.finalUrl,
        contentType: response.contentType,
        redirectCount: response.redirects.length,
        title,
      },
      artifacts,
      partialReasons: reasons,
    };
  }

  return { sourceType: 'deployment', version: DEPLOYMENT_ADAPTER_VERSION, capture };
}
