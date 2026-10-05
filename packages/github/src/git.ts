import { createHash } from 'node:crypto';

/** The Git object id of a blob: SHA-1 over `blob <size>\0<bytes>`. Used to verify content. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.byteLength)}\u0000`)
    .update(bytes)
    .digest('hex');
}
