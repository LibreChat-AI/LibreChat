import { createHash, randomUUID } from 'crypto';

export const DEFAULT_CHECKPOINT_TTL_SECONDS: number = 24 * 60 * 60;

const CHECKPOINT_NAMESPACE_PREFIX = 'lcg:v2:';
const SHA256_PATTERN = '[0-9a-f]{64}';
const UUID_V4_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CHECKPOINT_NAMESPACE_PATTERN = new RegExp(
  `^${CHECKPOINT_NAMESPACE_PREFIX}${SHA256_PATTERN}:${UUID_V4_PATTERN}$`,
);

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

export function isCleanupSafeCheckpointNamespace(value: unknown): value is string {
  return typeof value === 'string' && CHECKPOINT_NAMESPACE_PATTERN.test(value);
}

export function checkpointNamespaceBelongsToOwner(
  value: unknown,
  userId: string,
  tenantId?: string,
): value is string {
  return (
    isCleanupSafeCheckpointNamespace(value) &&
    value.startsWith(checkpointOwnerNamespacePrefix(userId, tenantId))
  );
}
