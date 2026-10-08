import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { StructuredRequest } from './types.js';

/*
 * The request digest (docs/milestones/M5-design.md §12.1, correction C5): the SHA-256 of the exact effective
 * serialized request. It is DERIVED here from the request object, so no caller can supply a digest that does
 * not match what is sent. Everything the model sees (system, every user block, the schema as sent) and every
 * setting that can change the output is inside it; a change to any of them changes the digest even when every
 * handle is unchanged. `timeoutMs` is excluded on purpose: it changes aborting, never content. Object key order
 * never matters (canonical JSON); the order and boundaries of the `user` blocks do.
 */

export const REQUEST_DIGEST_VERSION = 'request-digest/v2' as const;

export function computeRequestDigest(request: StructuredRequest): string {
  return sha256Hex(
    canonicalJson({
      v: REQUEST_DIGEST_VERSION,
      stage: request.stage,
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      promptTemplateHash: request.promptTemplateHash,
      schemaId: request.schemaId,
      schemaVersion: request.schemaVersion,
      provider: request.provider,
      model: request.model,
      system: request.system,
      user: [...request.user],
      jsonSchema: request.jsonSchema,
      generation: {
        effort: request.generation.effort ?? null,
        maxOutputTokens: request.generation.maxOutputTokens,
      },
    }),
  );
}
