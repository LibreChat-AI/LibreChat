import type { Document, Types } from 'mongoose';

/** Retained repair record for an explicit or compensating Skill deletion. */
export interface ISkillDeletion {
  skillId: Types.ObjectId;
  author: Types.ObjectId;
  tenantId?: string;
  startedAt: Date;
  lastAttemptAt?: Date;
  completedAt?: Date;
  nextCheckAt?: Date;
  claimOwner?: string;
  claimExpiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillDeletionDocument extends ISkillDeletion, Document {}

/** A storage key is recorded before uploading bytes, not after the upload succeeds. */
export interface ISkillUploadIntent {
  skillId: Types.ObjectId;
  fileId: string;
  source: string;
  storageKey: string;
  author: Types.ObjectId;
  tenantId?: string;
  writerId: string;
  state: 'uploading' | 'committing' | 'committed' | 'abandoned';
  cleanupHoldOwner?: string;
  cleanupRequestedAt?: Date;
  cleanedAt?: Date;
  nextCheckAt?: Date;
  lastCleanupAttemptAt?: Date;
  claimOwner?: string;
  claimExpiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillUploadIntentDocument extends ISkillUploadIntent, Document {}
