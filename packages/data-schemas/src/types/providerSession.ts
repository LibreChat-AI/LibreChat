import type { ProviderSessionRef } from 'librechat-data-provider';
import type { Document } from 'mongoose';

export interface IProviderSession extends Document, ProviderSessionRef {
  subject?: string;
  createdAt: Date;
  revokedAt?: Date;
  expiresAt: Date;
}

export type ProviderSessionErrorCode = 'ENDED' | 'MISSING' | 'CONFLICT' | 'SUBJECT_MISMATCH';

export interface ProviderSessionOperationData extends ProviderSessionRef {
  /** Verified provider user. Omitted for a session-only (sid-only) logout notification. */
  subject?: string;
  expiresAt: Date;
  /** Clock reference for the operation. Defaults to the current time. */
  now?: Date;
}

export type ProviderSessionEstablishResult =
  | { ok: true }
  | { ok: false; code: 'ENDED' | 'CONFLICT' };

export type ProviderSessionAuthorizeResult =
  | { ok: true }
  | { ok: false; code: 'ENDED' | 'MISSING' | 'CONFLICT' };

export type ProviderSessionRevokeResult = { ok: true } | { ok: false; code: 'SUBJECT_MISMATCH' };
