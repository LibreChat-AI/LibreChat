import { createHash } from 'node:crypto';
import type { ManagedTarget } from '~/types/managed';

/** Lifetime discovery survives revocation; the generation key additionally fences publication. */
export function channelRegistryKey(
  authority: { target: ManagedTarget<'channel' | 'channelIdentity'>; revision: string },
  generation = true,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'channel-authority',
        authority.target.kind,
        authority.target.id.toLowerCase(),
        authority.target.incarnation,
        authority.target.tenantId || null,
        generation ? authority.revision : null,
      ]),
    )
    .digest('hex');
}
