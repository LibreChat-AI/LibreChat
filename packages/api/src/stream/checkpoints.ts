import { randomUUID } from 'crypto';
import { checkpointOwnerNamespacePrefix } from '@librechat/data-schemas';

export { checkpointOwnerNamespacePrefix } from '@librechat/data-schemas';

export const DEFAULT_CHECKPOINT_TTL_SECONDS: number = 24 * 60 * 60;

/** Create an opaque, globally unique saver namespace bound to one exact owner. */
export function createCheckpointNamespace(userId: string, tenantId?: string): string {
  return `${checkpointOwnerNamespacePrefix(userId, tenantId)}${randomUUID()}`;
}
