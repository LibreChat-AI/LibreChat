import { Schema } from 'mongoose';
import type { IRefreshTokenBridge } from '~/types';

const refreshTokenBridgeSchema: Schema<IRefreshTokenBridge> = new Schema<IRefreshTokenBridge>({
  oldRefreshTokenHash: {
    type: String,
    required: true,
  },
  encryptedNewRefreshToken: {
    type: String,
    required: true,
  },
  userId: {
    type: String,
    required: true,
    index: true,
  },
  tenantId: {
    type: String,
    index: true,
  },
  openidIssuer: {
    type: String,
  },
  version: {
    type: String,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
});

refreshTokenBridgeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenBridgeSchema.index(
  { oldRefreshTokenHash: 1, userId: 1, tenantId: 1 },
  { unique: true },
);

export default refreshTokenBridgeSchema;
