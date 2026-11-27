import type { Document, Types } from 'mongoose';

export type SkillSyncProvider = 'github';
/**
 * `partial` means the source published at least one skill while dropping some
 * of what it was asked to mirror — an unusable `SKILL.md`, or a file whose path
 * cannot be represented as a skill file path. A single bad skill must not hide
 * the ones that synced fine, and a run that quietly reported `succeeded` would
 * hide whatever it dropped.
 */
export type SkillSyncRunStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped';

/** One upstream skill a run could not publish, with the reason it was dropped. */
export interface ISkillSyncSkippedSkill {
  /** Repository path of the skill root that was skipped. */
  path: string;
  /** Frontmatter name, when the failure happened late enough for one to exist. */
  name?: string;
  errorCode: string;
  errorMessage: string;
}

/**
 * One upstream file a run published a skill without. Unlike a skipped skill,
 * the skill itself is live — it is just missing this file, which is invisible
 * from the mirrored copy alone and so has to be recorded here.
 */
export interface ISkillSyncSkippedFile {
  /** Repository path of the file that was dropped. */
  path: string;
  /** Repository path of the skill root it belongs to. */
  skillPath: string;
  errorCode: string;
  errorMessage: string;
}

export interface ISkillSyncCredential {
  provider: SkillSyncProvider;
  credentialKey: string;
  encryptedToken: string;
  tokenHash: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillSyncCredentialDocument extends ISkillSyncCredential, Document {}

export interface ISkillSyncStatus {
  provider: SkillSyncProvider;
  sourceId: string;
  tenantId?: string;
  status: SkillSyncRunStatus;
  credentialKey?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  paths?: string[];
  startedAt?: Date;
  finishedAt?: Date;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  syncedSkillCount: number;
  syncedFileCount: number;
  deletedSkillCount: number;
  deletedFileCount: number;
  skippedSkillCount: number;
  /** Capped sample of the skipped skills; `skippedSkillCount` is the full total. */
  skippedSkills?: ISkillSyncSkippedSkill[];
  skippedFileCount: number;
  /** Capped sample of the skipped files; `skippedFileCount` is the full total. */
  skippedFiles?: ISkillSyncSkippedFile[];
  lockOwner?: string;
  lockExpiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillSyncStatusDocument extends ISkillSyncStatus, Document {}
