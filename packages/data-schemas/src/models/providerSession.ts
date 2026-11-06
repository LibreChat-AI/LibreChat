import { Model } from 'mongoose';
import type * as t from '~/types';
import providerSessionSchema from '~/schema/providerSession';

/** One record per OpenID back-channel-logout-scoped provider session, keyed by `(issuer, clientId, sid)`. */
export function createProviderSessionModel(
  mongoose: typeof import('mongoose'),
): Model<t.IProviderSession> {
  return (
    mongoose.models.ProviderSession ||
    mongoose.model<t.IProviderSession>('ProviderSession', providerSessionSchema)
  );
}
