import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReplayRecording, type ReplayRecordingInput } from '@judge-copilot/context';

/** Loads recorded extractions (JSON files) for the development-only replay extractor. */
export async function loadReplayRecordings(directory: string): Promise<ReplayRecordingInput[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (file) =>
      ReplayRecording.parse(JSON.parse(await readFile(join(directory, file), 'utf8'))),
    ),
  );
}
