import { createHash } from 'node:crypto';

/** RFC 9562 v8 UUIDs with a fixed `b` variant nibble form the host-reserved namespace. */
const RESERVED_SUBAGENT_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-b[0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic so the same initial tool-call retry converges across API replicas. */
export function createSubagentThreadId(scopeId: string, idempotencyKey: string): string {
  const hash = sha256(
    `librechat:subagent-thread:v1\u0000${scopeId.trim()}\u0000${idempotencyKey.trim()}`,
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-b${hash.slice(
    17,
    20,
  )}-${hash.slice(20, 32)}`;
}

export function isReservedSubagentThreadId(conversationId: string): boolean {
  return RESERVED_SUBAGENT_THREAD_ID.test(conversationId);
}

/** Opaque database key; raw SDK idempotency material never needs to be persisted. */
export function createSubagentAttemptKey(scopeId: string, idempotencyKey: string): string {
  return sha256(
    `librechat:subagent-attempt:v1\u0000${scopeId.trim()}\u0000${idempotencyKey.trim()}`,
  );
}
