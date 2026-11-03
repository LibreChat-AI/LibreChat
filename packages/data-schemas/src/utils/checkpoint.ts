import { createHash } from 'node:crypto';

/** Stable checkpoint scope derived only from the authenticated owner identity. */
export function checkpointOwnerNamespacePrefix(userId: string, tenantId?: string): string {
  const owner = createHash('sha256')
    .update(JSON.stringify([tenantId || null, userId]))
    .digest('hex');
  return `lcg:v2:${owner}:`;
}

/** Match captured settings without duplicating a potentially large JSON string in commands. */
export function checkpointConfigKey(configJSON: string): string {
  return createHash('sha256').update(configJSON).digest('hex');
}
