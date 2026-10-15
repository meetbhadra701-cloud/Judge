/*
 * One contender in an INDEPENDENT-PROCESS race test (tests/integration/identity-processes.test.ts). Development/test only.
 *
 *   tsx identity-contender.ts '<json>'   where json = { databaseUrl, syncDir, id, parties, op: {...} }
 *
 * It connects to PostgreSQL by itself (its own connection, its own process), holds at the write point and again after the write (before commit)
 * until every party's marker file exists -- or a timeout passes, for a contender the database has blocked behind another's uncommitted row --
 * then prints one JSON line with the outcome. Nothing here is imported by the application.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from '@judge-copilot/database';
import { SourceIngestionError } from '../projects/errors.js';
import { ProjectService } from '../projects/service.js';

interface Spec {
  databaseUrl: string;
  syncDir: string;
  id: string;
  parties: number;
  holdMs: number;
  actorId: string;
  op:
    | {
        kind: 'submit';
        eventId: string;
        githubUrl: string;
        devpostUrl: string;
        name?: string;
        key: string;
      }
    | { kind: 'addSource'; projectId: string; sourceType: 'github' | 'devpost'; url: string }
    | { kind: 'createProject'; eventId: string; name: string };
}

const spec = JSON.parse(process.argv[2] ?? '{}') as Spec;

async function rendezvous(phase: string, timeoutMs: number): Promise<void> {
  writeFileSync(join(spec.syncDir, `${phase}-${spec.id}`), '1');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let arrived = 0;
    for (let party = 0; party < spec.parties; party += 1) {
      if (existsSync(join(spec.syncDir, `${phase}-${String(party)}`))) arrived += 1;
    }
    if (arrived >= spec.parties || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function main(): Promise<void> {
  const connection = createDatabase(spec.databaseUrl, { maxConnections: 2 });
  const service = new ProjectService({
    db: connection.db,
    beforeSubmissionWrite: () => rendezvous('before', 15_000),
    beforeLegacyWrite: () => rendezvous('before', 15_000),
    afterSubmissionWrite: () => rendezvous('after', spec.holdMs),
    afterLegacyWrite: () => rendezvous('after', spec.holdMs),
  });
  let outcome: Record<string, unknown>;
  try {
    const { op } = spec;
    if (op.kind === 'submit') {
      const response = await service.submitProject(
        op.eventId,
        {
          githubUrl: op.githubUrl,
          devpostUrl: op.devpostUrl,
          ...(op.name ? { name: op.name } : {}),
        },
        spec.actorId,
        op.key,
      );
      outcome = { ok: true, projectId: response.project.id, result: response.result };
    } else if (op.kind === 'addSource') {
      const source = await service.addSource(
        op.projectId,
        { sourceType: op.sourceType, url: op.url },
        spec.actorId,
      );
      outcome = { ok: true, sourceId: source.id };
    } else {
      const project = await service.createProject(op.eventId, { name: op.name }, spec.actorId);
      outcome = { ok: true, projectId: project.id };
    }
  } catch (error) {
    outcome =
      error instanceof SourceIngestionError
        ? { ok: false, code: error.code }
        : {
            ok: false,
            code: 'UNEXPECTED',
            message: error instanceof Error ? error.message : String(error),
          };
  }
  await connection.close();
  process.stdout.write(`${JSON.stringify({ id: spec.id, pid: process.pid, ...outcome })}\n`);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ id: spec.id, ok: false, code: 'CRASH', message: String(error) })}\n`,
  );
  process.exitCode = 1;
});
