import { CHANNEL_IDENTITY_PRIVATE_FIELDS } from '~/models/channelIdentity';
import { ALLOCATION_PREFIX } from '~/utils/managed';

/** Reserved allocator identities release uniqueness without retaining a ticket or external actor. */
export function identityRedactionFields(id: string): {
  ticketHash: string;
  'identity.externalUserId': string;
} {
  const placeholder = `${ALLOCATION_PREFIX}${id.toLowerCase()}`;
  return { ticketHash: placeholder, 'identity.externalUserId': placeholder };
}

/** The same immutable payload-erasure proof serves cleanup and bounded admission recovery. */
export function retiredIdentityFilter(id: string): Record<string, unknown> {
  const placeholders = identityRedactionFields(id);
  return {
    '_managed.phase': 'retired',
    state: 'revoked',
    ticketExpiresAtMs: 0,
    expiresAtMs: 0,
    ...placeholders,
    ...Object.fromEntries(
      CHANNEL_IDENTITY_PRIVATE_FIELDS.filter(
        (field) => !Object.prototype.hasOwnProperty.call(placeholders, field),
      ).map((field) => [field, { $exists: false }]),
    ),
  };
}
