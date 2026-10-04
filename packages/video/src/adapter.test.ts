import {
  createStaticHttpFetcher,
  validateCaptureResult,
  type StaticRoute,
} from '@judge-copilot/capture';
import { describe, expect, it } from 'vitest';
import { createVideoAdapter } from './index.js';

const YT = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
const YT_OEMBED = `https://www.youtube.com/oembed?url=${encodeURIComponent(YT)}&format=json`;
const VIMEO = 'https://vimeo.com/123456';
const VIMEO_OEMBED = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(VIMEO)}&format=json`;

async function capture(url: string, routes: Record<string, StaticRoute>) {
  const http = createStaticHttpFetcher(routes);
  const result = await createVideoAdapter({ http }).capture({
    sourceType: 'video',
    url,
    signal: new AbortController().signal,
  });
  return { result: validateCaptureResult('video', result), http };
}

function metadata(result: Awaited<ReturnType<typeof capture>>['result']) {
  if (result.status !== 'captured' && result.status !== 'partial') throw new Error(result.status);
  return JSON.parse(result.artifacts[0]?.textContent ?? '{}') as Record<string, unknown>;
}

describe('video adapter', () => {
  it('captures provider metadata from the trusted oEmbed endpoint only', async () => {
    const { result, http } = await capture(YT, {
      [YT_OEMBED]: {
        response: {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            title: 'Atlas demo',
            author_name: 'Synthetic Team',
            thumbnail_url: 'https://i.ytimg.com/x.jpg',
            provider_name: 'YouTube',
          }),
        },
      },
    });
    expect(result.status).toBe('captured');
    expect(http.requests.map((request) => request.url)).toEqual([YT_OEMBED]);
    expect(metadata(result)).toMatchObject({
      provider: 'youtube',
      videoId: 'AAAAAAAAAAA',
      title: 'Atlas demo',
      authorName: 'Synthetic Team',
      // YouTube oEmbed states no duration: it stays absent, never estimated.
      durationSeconds: null,
      mediaDownloaded: false,
    });
  });

  it('keeps a duration only when the provider states it', async () => {
    const { result } = await capture(VIMEO, {
      [VIMEO_OEMBED]: {
        response: {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ title: 'V', duration: 95 }),
        },
      },
    });
    expect(metadata(result)).toMatchObject({ provider: 'vimeo', durationSeconds: 95 });
  });

  it('never downloads a media stream', async () => {
    const mp4 = 'https://cdn.example.org/demo.mp4';
    const { result, http } = await capture(mp4, {
      [mp4]: { response: { status: 200, contentType: 'video/mp4', body: 'MEDIA-BYTES' } },
    });
    expect(http.requests[0]?.options.contentTypes).not.toContain('video/mp4');
    expect(result).toMatchObject({
      status: 'partial',
      partialReasons: ['body_not_captured', 'generic_metadata_only'],
    });
    expect(JSON.stringify(result)).not.toContain('MEDIA-BYTES');
    expect(metadata(result)).toMatchObject({
      contentType: 'video/mp4',
      mediaDownloaded: false,
      durationSeconds: null,
    });
  });

  it('marks generic page metadata as partial', async () => {
    const page = 'https://demo.example.org/watch';
    const { result } = await capture(page, {
      [page]: {
        response: {
          status: 200,
          contentType: 'text/html',
          body: '<meta property="og:title" content="Atlas walkthrough"><meta property="og:video" content="https://demo.example.org/v.mp4">',
        },
      },
    });
    expect(result).toMatchObject({ status: 'partial', partialReasons: ['generic_metadata_only'] });
    expect(metadata(result)).toMatchObject({
      title: 'Atlas walkthrough',
      videoUrl: 'https://demo.example.org/v.mp4',
    });
  });

  it('maps unavailable videos and malformed provider responses to sanitized failures', async () => {
    expect(
      (
        await capture(YT, {
          [YT_OEMBED]: { response: { status: 404, contentType: 'application/json', body: '{}' } },
        })
      ).result,
    ).toMatchObject({
      status: 'failed',
      failure: { category: 'not_found', metadata: { httpStatus: 404 } },
    });
    expect(
      (
        await capture(YT, {
          [YT_OEMBED]: {
            response: { status: 200, contentType: 'application/json', body: 'not json' },
          },
        })
      ).result,
    ).toMatchObject({
      status: 'failed',
      failure: { category: 'parse_failure' },
    });
    expect((await capture('https://www.youtube.com/watch?v=bad', {})).result).toMatchObject({
      status: 'rejected',
      failure: { category: 'unsupported_source' },
    });
  });
});
