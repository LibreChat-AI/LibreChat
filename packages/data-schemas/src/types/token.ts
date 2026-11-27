import { Document, Types } from 'mongoose';

export interface IToken extends Document {
  userId: Types.ObjectId;
  email?: string;
  type?: string;
  scope?: string;
  identifier?: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
  metadata?: Map<string, unknown>;
  tenantId?: string;
}

export interface TokenCreateData {
  userId: Types.ObjectId | string;
  email?: string;
  type?: string;
  scope?: string;
  identifier?: string;
  token: string;
  expiresIn: number;
  metadata?: Record<string, unknown> | Map<string, unknown>;
}

export interface TokenQuery {
  userId?: Types.ObjectId | string;
  token?: string;
  email?: string | null;
  type?: string | null;
  scope?: string;
  identifier?: string | RegExp | null;
  /** Internal optimistic-concurrency selector for OAuth token record generations. */
  metadataCredentialSetId?: string | null;
}

export interface TokenUpdateData {
  email?: string;
  type?: string;
  scope?: string;
  identifier?: string;
  token?: string;
  expiresAt?: Date;
  expiresIn?: number;
  metadata?: Record<string, unknown> | Map<string, unknown>;
}

export interface TokenDeleteResult {
  deletedCount?: number;
}
