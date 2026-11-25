import { Model } from 'mongoose';
import type * as t from '~/types';
import openidRefreshFlightSchema from '~/schema/openidRefreshFlight';

/**
 * Short-lived cross-worker coordination for inline OIDC refreshes. These
 * documents are keyed by hashed token/session context and expire via TTL.
 */
export function createOpenIDRefreshFlightModel(
  mongoose: typeof import('mongoose'),
): Model<t.IOpenIDRefreshFlight> {
  return (
    mongoose.models.OpenIDRefreshFlight ||
    mongoose.model<t.IOpenIDRefreshFlight>('OpenIDRefreshFlight', openidRefreshFlightSchema)
  );
}
