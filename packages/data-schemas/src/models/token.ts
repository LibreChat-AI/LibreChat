import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import tokenSchema from '~/schema/token';

export function createTokenModel(mongoose: typeof import('mongoose')): Model<t.IToken> {
  applyTenantIsolation(tokenSchema);
  return mongoose.models.Token || mongoose.model<t.IToken>('Token', tokenSchema);
}

/**
 * Auth-flow tokens (`password_reset`, `email_verification`, invites) on their own
 * `authtokens` collection. Shares `tokenSchema` with {@link createTokenModel}, so
 * documents are identical in shape and inherit the schema's `expiresAt` TTL index.
 * `applyTenantIsolation` is idempotent, so this call re-registers no hook.
 */
export function createAuthTokenModel(mongoose: typeof import('mongoose')): Model<t.IToken> {
  applyTenantIsolation(tokenSchema);
  return (
    mongoose.models.AuthToken || mongoose.model<t.IToken>('AuthToken', tokenSchema, 'authtokens')
  );
}
