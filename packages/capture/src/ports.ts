import type {
  CaptureFailureCategory,
  CaptureFailureMetadata,
  CapturePartialReason,
  ProjectSourceType,
  SnapshotArtifactKind,
} from '@judge-copilot/schemas';

/*
 * Ports between deterministic capture orchestration and I/O adapters (ARCHITECTURE.md §6:
 * adapters implement ports defined in lower layers). Adapters never touch the database, never
 * score and never interpret judging criteria: they return bounded, structured data.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A sanitized failure: a category plus allow-listed metadata, never a raw error or body. */
export interface CaptureFailure {
  readonly category: CaptureFailureCategory;
  readonly metadata: CaptureFailureMetadata;
}

export interface HttpRequestOptions {
  /** Plain `http:` is refused unless the caller explicitly allows it (deployment/video pages). */
  readonly allowHttp?: boolean;
  /**
   * Extra request headers. Every caller header except `accept` is dropped when a redirect leaves
   * the original origin, so credentials are never forwarded.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** At most 5 (the client's hard ceiling). */
  readonly maxRedirects?: number;
  readonly maxBodyBytes: number;
  /** `fail`: a larger body is `response_too_large`. `truncate`: keep the first `maxBodyBytes`. */
  readonly oversize: 'fail' | 'truncate';
  /** Allowed media types (lowercase essence, e.g. `text/html`). */
  readonly contentTypes: readonly string[];
  /** `fail`: other types are `unsupported_content_type`. `omit_body`: the body is never read. */
  readonly disallowedContentType: 'fail' | 'omit_body';
  /** Total time for the request including redirects and body. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponseData {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  /** Lowercase media type essence, or null when absent. */
  readonly contentType: string | null;
  /** Allow-listed, lowercased response headers only (never cookies). */
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded text, or null when the body was not read. */
  readonly body: string | null;
  readonly bodyBytes: number;
  readonly truncated: boolean;
  readonly bodyOmitted: boolean;
  readonly redirects: readonly { readonly status: number; readonly url: string }[];
  readonly elapsedMs: number;
}

export type HttpFetchResult =
  | { readonly ok: true; readonly response: HttpResponseData }
  | { readonly ok: false; readonly failure: CaptureFailure };

/** GET-only, policy-enforcing HTTP port implemented by `@judge-copilot/safe-http`. */
export interface HttpFetcher {
  get(url: string, options: HttpRequestOptions): Promise<HttpFetchResult>;
}

export interface CapturedArtifact {
  /** Unique within the snapshot, e.g. `repository.json` or `files/src/index.ts`. */
  readonly key: string;
  readonly kind: SnapshotArtifactKind;
  readonly mediaType: string;
  readonly textContent: string;
  readonly byteLength: number;
  /** SHA-256 (hex) of the UTF-8 bytes of `textContent`. */
  readonly contentHash: string;
  readonly metadata: JsonObject;
}

export interface CaptureInput {
  readonly sourceType: ProjectSourceType;
  /** The normalized declared URL (see `normalizeDeclaredSourceUrl`). Untrusted. */
  readonly url: string;
  readonly signal: AbortSignal;
}

export type CaptureResult =
  | {
      readonly status: 'captured' | 'partial';
      /** Exact commit SHA for GitHub; null for other source types. */
      readonly revision: string | null;
      /** Normalized snapshot metadata (data only, never a score). */
      readonly metadata: JsonObject;
      readonly artifacts: readonly CapturedArtifact[];
      readonly partialReasons: readonly CapturePartialReason[];
    }
  | { readonly status: 'failed' | 'rejected'; readonly failure: CaptureFailure };

export interface ProjectSourceAdapter {
  readonly sourceType: ProjectSourceType;
  /** Versioned capture behaviour, e.g. `github-capture/v1`. */
  readonly version: string;
  capture(input: CaptureInput): Promise<CaptureResult>;
}
