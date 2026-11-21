import type { ProviderSessionRef } from 'librechat-data-provider';
import type { Document } from 'mongoose';

export interface IRefreshTokenBridge extends Document {
  oldRefreshTokenHash: string;
  encryptedNewRefreshToken: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  version?: string;
  createdAt: Date;
  expiresAt: Date;
  /** Provider session the bridged refresh token is bound to. */
  providerSession?: ProviderSessionRef;
}

export interface RefreshTokenBridgeCreateData {
  oldRefreshTokenHash: string;
  encryptedNewRefreshToken: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  version?: string;
  expiresAt: Date;
  providerSession?: ProviderSessionRef;
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
