import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventContextExtraction } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import {
  collectSourceIds,
  createReplayExtractor,
  ExtractorUnavailableError,
  normalizeSourceText,
  sourceContentHash,
  type ReplayRecordingInput,
} from './index.js';

const FIXTURES = resolve(import.meta.dirname, '../../../tests/fixtures/event-context');
const recordings = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as ReplayRecordingInput);

function requestFor(recording: ReplayRecordingInput, reverse = false) {
  const sources = recording.sources.map((source, i) => {
    const normalizedText = normalizeSourceText(source.normalizedText);
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      sourceType: source.sourceType,
      authority: source.authority,
      title: source.title,
      url: source.url ?? null,
      normalizedText,
      contentHash: sourceContentHash(normalizedText),
    };
  });
  return { eventName: recording.event.name, sources: reverse ? sources.reverse() : sources };
}

describe('replay extractor', () => {
  const extractor = createReplayExtractor(recordings);

  it('loads all five synthetic fixtures', () => {
    expect(recordings.map((recording) => recording.name).sort()).toEqual([
      'fixture-a-clear-official-rubric',
      'fixture-b-ambiguous-policy',
      'fixture-c-conflicting-authority',
      'fixture-d-malformed-rubric',
      'fixture-e-multiple-tracks',
    ]);
  });

  it.each(recordings.map((recording) => [recording.name, recording] as const))(
    'replays %s as a schema-valid extraction with real source IDs, in any source order',
    async (_name, recording) => {
      const request = requestFor(recording, true);
      const output = await extractor.extract(request);
      const parsed = EventContextExtraction.parse(output);
      const ids = new Set(request.sources.map((source) => source.id));
      const referenced = [...collectSourceIds(parsed)];
      expect(referenced.length).toBeGreaterThan(0);
      expect(referenced.every((id) => ids.has(id))).toBe(true);
    },
  );

  it('refuses sources that do not exactly match a recording (no semantic guessing)', async () => {
    const [recording] = recordings;
    if (!recording) throw new Error('fixtures missing');
    const request = requestFor(recording);
    const [first, ...rest] = request.sources;
    if (!first) throw new Error('fixture');
    const changed = normalizeSourceText(`${first.normalizedText} Edited.`);
    await expect(
      extractor.extract({
        ...request,
        sources: [
          { ...first, normalizedText: changed, contentHash: sourceContentHash(changed) },
          ...rest,
        ],
      }),
    ).rejects.toBeInstanceOf(ExtractorUnavailableError);
    await expect(extractor.extract({ ...request, sources: rest })).rejects.toBeInstanceOf(
      ExtractorUnavailableError,
    );
  });
});
