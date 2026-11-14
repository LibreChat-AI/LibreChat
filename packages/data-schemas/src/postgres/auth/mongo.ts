import type mongoose from 'mongoose';
import type { AuthenticationCollection, AuthenticationSnapshotSource } from './import';
import { AUTHENTICATION_COLUMNS, AUTHENTICATION_KINDS } from './import';
import flightSchema from '~/schema/openidRefreshFlight';
import bridgeSchema from '~/schema/refreshTokenBridge';
import sessionSchema from '~/schema/session';
import passkeySchema from '~/schema/passkey';
import tokenSchema from '~/schema/token';

const fields: Record<AuthenticationCollection, Record<string, string>> = {
  sessions: {
    id: '_id',
    user_id: 'user',
    tenant_id: 'tenantId',
    refresh_token_hash: 'refreshTokenHash',
    expiration: 'expiration',
  },
  passkeys: {
    id: '_id',
    user_id: 'user',
    tenant_id: 'tenantId',
    credential_id: 'credentialId',
    public_key: 'publicKey',
    counter: 'counter',
    transports: 'transports',
    device_type: 'deviceType',
    backed_up: 'backedUp',
    name: 'name',
    last_used_at: 'lastUsedAt',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  },
  tokens: {
    id: '_id',
    user_id: 'userId',
    tenant_id: 'tenantId',
    email: 'email',
    type: 'type',
    scope: 'scope',
    identifier: 'identifier',
    token: 'token',
    metadata: 'metadata',
    created_at: 'createdAt',
    expires_at: 'expiresAt',
  },
  bridges: {
    id: '_id',
    old_refresh_token_hash: 'oldRefreshTokenHash',
    user_id: 'userId',
    tenant_id: 'tenantId',
    openid_issuer: 'openidIssuer',
    encrypted_new_refresh_token: 'encryptedNewRefreshToken',
    version: 'version',
    created_at: 'createdAt',
    expires_at: 'expiresAt',
  },
  flights: {
    id: '_id',
    key: 'key',
    owner_id: 'ownerId',
    status: 'status',
    encrypted_result: 'encryptedResult',
    error_message: 'errorMessage',
    delivery_id: 'deliveryId',
    delivery_expires_at: 'deliveryExpiresAt',
    revocation_requested_at: 'revocationRequestedAt',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    lock_expires_at: 'lockExpiresAt',
    expires_at: 'expiresAt',
  },
};

/** Collection metadata is built on a disconnected instance; the live connection gets no models. */
export function createMongoAuthenticationSource(
  database: typeof mongoose,
): AuthenticationSnapshotSource {
  const metadata = new database.Mongoose();
  const names: Record<AuthenticationCollection, string> = {
    sessions: '',
    passkeys: '',
    tokens: '',
    bridges: '',
    flights: '',
  };
  for (const [kind, name, schema] of [
    ['sessions', 'Session', sessionSchema],
    ['passkeys', 'Passkey', passkeySchema],
    ['tokens', 'Token', tokenSchema],
    ['bridges', 'RefreshTokenBridge', bridgeSchema],
    ['flights', 'OpenIDRefreshFlight', flightSchema],
  ] as const) {
    const cloned = schema.clone();
    cloned.set('autoCreate', false);
    cloned.set('autoIndex', false);
    cloned.set('autoSearchIndex', false);
    // eslint-disable-next-line no-restricted-syntax -- Disconnected collection metadata, no database operation.
    names[kind] = metadata.model(name, cloned).collection.name;
  }
  return async function* () {
    for (const kind of AUTHENTICATION_KINDS) {
      const cursor = database.connection
        .collection(names[kind])
        .find({})
        .sort({ _id: 1 })
        .batchSize(250);
      try {
        for await (const row of cursor) {
          const values: Record<string, unknown> = {};
          for (const column of AUTHENTICATION_COLUMNS[kind]) {
            let value: unknown = row[fields[kind][column]] ?? null;
            if (column === 'id' || column === 'user_id') {
              value = value == null ? null : String(value);
            }
            if (column === 'public_key' && value !== null) {
              if (value instanceof Uint8Array) value = Buffer.from(value);
              else if (
                typeof value === 'object' &&
                'buffer' in value &&
                value.buffer instanceof Uint8Array
              )
                value = Buffer.from(value.buffer);
              else throw new Error('Invalid imported passkey bytes');
            }
            if (column === 'metadata' && value instanceof Map) value = Object.fromEntries(value);
            values[column] = value;
          }
          yield { kind, values };
        }
      } finally {
        await cursor.close();
      }
    }
  };
}
