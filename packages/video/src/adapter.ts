import {
  extractHtmlDocument,
  failure,
  failureResult,
  jsonArtifact,
  parseVideoUrl,
  type CaptureInput,
  type CaptureResult,
  type HttpFetcher,
  type JsonObject,
  type JsonValue,
  type ProjectSourceAdapter,
} from '@judge-copilot/capture';
import type { CapturePartialReason } from '@judge-copilot/schemas';
import { z } from 'zod';

/*
 * Video/demo metadata only. Media streams are never downloaded, frames never analysed, speech
 * never transcribed and no model is called. For YouTube, Vimeo and Loom the adapter asks the
 * provider's fixed, trusted oEmbed endpoint about the canonical URL (the submitted URL itself is
 * not fetched). Any other URL is read as a web page for its public metadata only, and media
 * content types are never read. Fields the provider does not supply (for example a duration)
 * stay null.
 */

export const VIDEO_ADAPTER_VERSION = 'video-capture/v1';

export const VIDEO_CAPTURE_LIMITS = {
  maxOembedBytes: 64 * 1024,
  maxPageBytes: 512 * 1024,
  maxDescriptionChars: 5_000,
  requestTimeoutMs: 15_000,
} as const;

/** The only oEmbed endpoints contacted, keyed by provider. */
export const OEMBED_ENDPOINTS = {
  youtube: 'https://www.youtube.com/oembed',
  vimeo: 'https://vimeo.com/api/oembed.json',
  loom: 'https://www.loom.com/v1/oembed',
} as const;

const OembedResponse = z.object({
  title: z.string().max(1_000).nullish(),
  author_name: z.string().max(500).nullish(),
  author_url: z.string().max(2_048).nullish(),
  provider_name: z.string().max(200).nullish(),
  thumbnail_url: z.string().max(2_048).nullish(),
  duration: z.number().int().min(0).max(1_000_000).nullish(),
  description: z.string().nullish(),
  upload_date: z.string().max(100).nullish(),
});

export interface VideoAdapterOptions {
  readonly http: HttpFetcher;
}

function httpUrlOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function createVideoAdapter(options: VideoAdapterOptions): ProjectSourceAdapter {
  async function capture(input: CaptureInput): Promise<CaptureResult> {
    const ref = parseVideoUrl(input.url);
    if (typeof ref === 'string') {
      return failureResult(
        failure(
          ref === 'unsupported_path' || ref === 'unsupported_host'
            ? 'unsupported_source'
            : 'invalid_url',
          {
            adapter: 'video',
            reason: ref,
          },
        ),
      );
    }

    if (ref.provider === 'generic') {
      const result = await options.http.get(ref.canonicalUrl, {
        allowHttp: true,
        maxBodyBytes: VIDEO_CAPTURE_LIMITS.maxPageBytes,
        oversize: 'truncate',
        contentTypes: ['text/html', 'application/xhtml+xml'],
        // A direct media URL is recorded by type only: the stream is never read.
        disallowedContentType: 'omit_body',
        timeoutMs: VIDEO_CAPTURE_LIMITS.requestTimeoutMs,
        signal: input.signal,
      });
      if (!result.ok) {
        return failureResult(
          failure(result.failure.category, { ...result.failure.metadata, adapter: 'video' }),
        );
      }
      const { response } = result;
      const document =
        response.body === null ? null : extractHtmlDocument(response.body, response.finalUrl);
      const og = document?.openGraph ?? {};
      const metadata: JsonObject = {
        provider: 'generic',
        videoId: null,
        canonicalUrl: ref.canonicalUrl,
        finalUrl: response.finalUrl,
        httpStatus: response.status,
        contentType: response.contentType,
        title: og['og:title'] ?? document?.title ?? null,
        description:
          (og['og:description'] ?? document?.description ?? null)?.slice(
            0,
            VIDEO_CAPTURE_LIMITS.maxDescriptionChars,
          ) ?? null,
        authorName: null,
        thumbnailUrl: httpUrlOrNull(og['og:image']),
        videoUrl: httpUrlOrNull(og['og:video'] ?? og['og:video:url']),
        durationSeconds: null,
        mediaDownloaded: false,
      };
      const reasons: CapturePartialReason[] = ['generic_metadata_only'];
      if (response.truncated) reasons.push('body_truncated');
      if (response.bodyOmitted) reasons.push('body_not_captured');
      if (document?.degraded) reasons.push('html_structure_limit');
      return {
        status: 'partial',
        revision: null,
        metadata: {
          adapterVersion: VIDEO_ADAPTER_VERSION,
          provider: 'generic',
          httpStatus: response.status,
        },
        artifacts: [jsonArtifact('metadata.json', 'video_metadata', metadata)],
        partialReasons: reasons.sort(),
      };
    }

    const endpoint = `${OEMBED_ENDPOINTS[ref.provider]}?url=${encodeURIComponent(ref.canonicalUrl)}&format=json`;
    const result = await options.http.get(endpoint, {
      maxBodyBytes: VIDEO_CAPTURE_LIMITS.maxOembedBytes,
      oversize: 'fail',
      contentTypes: ['application/json', 'text/javascript'],
      disallowedContentType: 'fail',
      timeoutMs: VIDEO_CAPTURE_LIMITS.requestTimeoutMs,
      signal: input.signal,
    });
    if (!result.ok) {
      return failureResult(
        failure(result.failure.category, { ...result.failure.metadata, adapter: 'video' }),
      );
    }
    const { response } = result;
    const meta = { adapter: 'video', httpStatus: response.status };
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      return failureResult(failure('not_found', meta));
    }
    if (response.status === 429) return failureResult(failure('rate_limited', meta));
    if (response.status !== 200) return failureResult(failure('http_api_error', meta));
    let parsed: z.infer<typeof OembedResponse>;
    try {
      parsed = OembedResponse.parse(JSON.parse(response.body ?? ''));
    } catch {
      return failureResult(
        failure('parse_failure', { adapter: 'video', reason: 'invalid_oembed' }),
      );
    }
    const metadata: Record<string, JsonValue> = {
      provider: ref.provider,
      videoId: ref.videoId,
      canonicalUrl: ref.canonicalUrl,
      title: parsed.title ?? null,
      description: parsed.description?.slice(0, VIDEO_CAPTURE_LIMITS.maxDescriptionChars) ?? null,
      authorName: parsed.author_name ?? null,
      authorUrl: httpUrlOrNull(parsed.author_url),
      providerName: parsed.provider_name ?? null,
      thumbnailUrl: httpUrlOrNull(parsed.thumbnail_url),
      // Only when the provider states it; never estimated.
      durationSeconds: parsed.duration ?? null,
      uploadDate: parsed.upload_date ?? null,
      mediaDownloaded: false,
    };
    return {
      status: 'captured',
      revision: null,
      metadata: {
        adapterVersion: VIDEO_ADAPTER_VERSION,
        provider: ref.provider,
        videoId: ref.videoId,
      },
      artifacts: [jsonArtifact('metadata.json', 'video_metadata', metadata)],
      partialReasons: [],
    };
  }

  return { sourceType: 'video', version: VIDEO_ADAPTER_VERSION, capture };
}
