import type { Document } from 'mongoose';

export interface IResourceLock extends Document {
  key: string;
  ownerId: string;
  expiresAt: Date;
}

export interface ResourceLockAcquireData {
  key: string;
  ownerId: string;
  ttlMs: number;
  /** Longest wait for the lock index to be ready; defaults to a short internal bound. */
  readyWaitMs?: number;
}

export interface ResourceLockReleaseData {
  key: string;
  ownerId: string;
}
