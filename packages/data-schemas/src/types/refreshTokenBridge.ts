import type { Document, Types } from 'mongoose';

export interface IRefreshTokenBridge extends Document {
  oldRefreshTokenHash: string;
  encryptedNewRefreshToken: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSessionId?: Types.ObjectId;
  version?: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface RefreshTokenBridgeCreateData {
  oldRefreshTokenHash: string;
  encryptedNewRefreshToken: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSessionId?: Types.ObjectId;
  version?: string;
  expiresAt: Date;
}

export interface RefreshTokenBridgeQuery {
  oldRefreshTokenHash: string;
  userId: string;
  tenantId?: string;
}

export interface RefreshTokenBridgeDeleteData {
  oldRefreshTokenHashes?: string[];
  userId: string;
  tenantId?: string;
  version?: string;
}
