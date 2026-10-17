import { createHash, randomUUID } from 'crypto';

export const DEFAULT_CHECKPOINT_TTL_SECONDS: number = 24 * 60 * 60;

const CHECKPOINT_NAMESPACE_PREFIX = 'lcg:v2:';
function checkpointOwnerHash(userId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([tenantId || null, userId]))
    .digest('hex');
}

/** Stable prefix derived only from the authenticated owner identity. */
export function checkpointOwnerNamespacePrefix(userId: string, tenantId?: string): string {
  return `${CHECKPOINT_NAMESPACE_PREFIX}${checkpointOwnerHash(userId, tenantId)}:`;
}

/** Create an opaque, globally unique saver namespace bound to one exact owner. */
export function createCheckpointNamespace(userId: string, tenantId?: string): string {
  return `${checkpointOwnerNamespacePrefix(userId, tenantId)}${randomUUID()}`;
}
