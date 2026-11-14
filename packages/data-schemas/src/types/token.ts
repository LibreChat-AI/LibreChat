import { Document, Types } from 'mongoose';

export interface IToken extends Document {
  __v?: number;
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
  userId: string | { toString(): string };
  email?: string;
  type?: string;
  scope?: string;
  identifier?: string;
  token: string;
  expiresIn: number;
  metadata?: Record<string, unknown> | Map<string, unknown>;
}

export interface TokenQuery {
  userId?: string | { toString(): string };
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

/** Storage-neutral token returned by database methods. */
export interface TokenRecord {
  _id: string;
  userId: string;
  email?: string;
  type?: string;
  scope?: string;
  identifier?: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
  tenantId?: string;
}

export interface TokenFindOptions {
  sort?: Partial<
    Record<
      | '_id'
      | 'userId'
      | 'email'
      | 'type'
      | 'scope'
      | 'identifier'
      | 'token'
      | 'createdAt'
      | 'expiresAt'
      | 'tenantId',
      1 | -1
    >
  >;
  projection?: Partial<Record<keyof TokenRecord, 0 | 1>>;
}
