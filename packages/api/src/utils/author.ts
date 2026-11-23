import { createHash } from 'node:crypto';

/**
 * Deterministic 24-hex id for records owned by an external source rather than a user.
 * Seed is `provider:sourceId` or `provider:sourceId:tenantId`. The tenant segment is
 * omitted when absent so single-tenant ids stay stable. The result has the shape of an
 * ObjectId; data-schemas methods that store it accept the hex string and construct the
 * ObjectId themselves, so no Mongoose type enters this package's exported signatures.
 *
 * The components are joined with `:` and are not escaped, so this function throws when
 * `provider`, `sourceId`, or a provided `tenantId` contains `:`; otherwise two different
 * inputs could share a seed. The seed is kept identical to the ids the GitHub skill sync
 * already stores, so the encoding cannot change without re-keying existing records.
 */
export function makeSourceAuthorId(provider: string, sourceId: string, tenantId?: string): string {
  for (const [name, value] of [
    ['provider', provider],
    ['sourceId', sourceId],
    ['tenantId', tenantId],
  ] as const) {
    if (value?.includes(':')) {
      throw new Error(`makeSourceAuthorId components must not contain ":" (got ${name})`);
    }
  }
  const seed = tenantId ? `${provider}:${sourceId}:${tenantId}` : `${provider}:${sourceId}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 24);
}
