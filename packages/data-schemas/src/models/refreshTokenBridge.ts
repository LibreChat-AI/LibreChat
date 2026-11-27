import { Model } from 'mongoose';
import type * as t from '~/types';
import refreshTokenBridgeSchema from '~/schema/refreshTokenBridge';

/**
 * Refresh-token bridges are looked up from unauthenticated refresh requests
 * after user context is recovered from a signed cookie. Methods apply explicit
 * tenant checks, so automatic tenant isolation would be the wrong boundary here.
 */
export function createRefreshTokenBridgeModel(
  mongoose: typeof import('mongoose'),
): Model<t.IRefreshTokenBridge> {
  return (
    mongoose.models.RefreshTokenBridge ||
    mongoose.model<t.IRefreshTokenBridge>('RefreshTokenBridge', refreshTokenBridgeSchema)
  );
}
