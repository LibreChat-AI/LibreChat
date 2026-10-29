import {
  DEFAULT_SKILL_DELETION_CLEANUP_CONCURRENCY,
  DEFAULT_SKILL_DELETION_BATCH_SIZE,
} from 'librechat-data-provider';
import type {
  DeleteSkillCleanupStep,
  DeleteSkillResult,
  SkillDeletionFileRecord,
  SkillDeletionRecord,
  SkillUploadIntentRecord,
} from '@librechat/data-schemas';
import { createConcurrencyLimiter } from '~/utils/promise';

export interface SkillDeletionDeps {
  beginSkillDeletion: (id: string) => Promise<SkillDeletionRecord | null>;
  getSkillDeletion: (id: string) => Promise<SkillDeletionRecord | null>;
  iterateSkillCleanupFiles: (
    id: string,
    batchSize: number,
  ) => AsyncIterable<SkillDeletionFileRecord[]>;
  iterateSkillCleanupIntents: (
    id: string,
    batchSize: number,
  ) => AsyncIterable<SkillUploadIntentRecord[]>;
  hasInFlightSkillUploads: (id: string) => Promise<boolean>;
  listExistingSkillFileIds: (id: string, fileIds: string[]) => Promise<string[]>;
  deleteBlob: (file: SkillDeletionFileRecord) => Promise<void>;
  deleteReservedBlob: (intent: SkillUploadIntentRecord) => Promise<void>;
  deleteSkillFileAfterBlob: (skillId: string, fileId: string) => Promise<boolean>;
  finalizeSkillDeletion: (id: string) => Promise<DeleteSkillResult>;
  completeSkillDeletion: (id: string) => Promise<boolean>;
  reopenSkillDeletion: (id: string) => Promise<void>;
  markSkillUploadIntentCleaned: (fileId: string) => Promise<void>;
}

export type SkillDeletionProgress = {
  found: boolean;
  deleted: boolean;
  skillAbsent: boolean;
  cleanupComplete: boolean;
  failedSteps: DeleteSkillCleanupStep[];
};

export class SkillDeletionClaimLostError extends Error {
  constructor() {
    super('Skill deletion claim was lost');
    this.name = 'SkillDeletionClaimLostError';
  }
}

/**
 * Every externally stored object has a persistent Mongo reference until its
 * provider and RAG cleanup succeeds. Failures remain retryable after restart.
 */
export async function runSkillDeletion(
  id: string,
  deps: SkillDeletionDeps,
  fileCleanupConcurrency: number = DEFAULT_SKILL_DELETION_CLEANUP_CONCURRENCY,
  assertClaim: () => Promise<void> = async () => undefined,
  loadedJournal?: SkillDeletionRecord,
  manifestBatchSize: number = DEFAULT_SKILL_DELETION_BATCH_SIZE,
): Promise<SkillDeletionProgress> {
  if (!Number.isInteger(manifestBatchSize) || manifestBatchSize < 1)
    throw new Error('Invalid cleanup batch size');
  await assertClaim();
  const journal =
    loadedJournal ?? (await deps.beginSkillDeletion(id)) ?? (await deps.getSkillDeletion(id));
  if (!journal) {
    return {
      found: false,
      deleted: false,
      skillAbsent: true,
      cleanupComplete: true,
      failedSteps: [],
    };
  }
  const failures = new Set<DeleteSkillCleanupStep>();
  let requiresFullCleanup = false;
  const noteLiveWork = async () => {
    if (requiresFullCleanup) return;
    if (journal.completedAt) {
      await assertClaim();
      await deps.reopenSkillDeletion(journal.skillId);
    }
    requiresFullCleanup = true;
  };
  // A writer may still finish uploading or committing after this scan. An
  // operator can inspect and recover an intent with `recover-skill-upload`
  // after draining writers; a timer must not infer that a slow upload is dead.
  if (await deps.hasInFlightSkillUploads(journal.skillId)) {
    await noteLiveWork();
    return {
      found: true,
      deleted: false,
      skillAbsent: journal.completedAt != null,
      cleanupComplete: false,
      failedSteps: ['upload_intents'],
    };
  }
  const limit = createConcurrencyLimiter(fileCleanupConcurrency);
  for await (const files of deps.iterateSkillCleanupFiles(id, manifestBatchSize)) {
    if (files.length === 0) continue;
    await noteLiveWork();
    const fileResults = await Promise.allSettled(
      files.map((file) =>
        limit(async () => {
          await assertClaim();
          try {
            await deps.deleteBlob(file);
          } catch {
            failures.add('skill_files');
            return;
          }
          await assertClaim();
          try {
            await deps.deleteSkillFileAfterBlob(id, file.file_id);
          } catch {
            failures.add('skill_files');
            return;
          }
          await assertClaim();
          try {
            // Persist this progress instead of retaining every cleaned file ID in memory.
            await deps.markSkillUploadIntentCleaned(file.file_id);
          } catch {
            failures.add('upload_intents');
          }
        }),
      ),
    );
    const rejectedFile = fileResults.find((result) => result.status === 'rejected');
    if (rejectedFile?.status === 'rejected') throw rejectedFile.reason;
  }

  for await (const intents of deps.iterateSkillCleanupIntents(journal.skillId, manifestBatchSize)) {
    const committedIds: string[] = [];
    for (const intent of intents) {
      if (intent.state === 'uploading' || intent.state === 'committing') {
        await noteLiveWork();
        return {
          found: true,
          deleted: false,
          skillAbsent: journal.completedAt != null,
          cleanupComplete: false,
          failedSteps: ['upload_intents'],
        };
      }
      if (intent.state === 'committed' && !intent.cleanedAt) committedIds.push(intent.fileId);
    }
    if (committedIds.length > 0) await noteLiveWork();
    const currentFileIds = new Set(await deps.listExistingSkillFileIds(id, committedIds));
    const intentResults = await Promise.allSettled(
      intents.map((intent) =>
        limit(async () => {
          if (intent.state === 'committed') {
            if (intent.cleanedAt) return;
            if (currentFileIds.has(intent.fileId)) {
              // Keep the intent with its current row for the next retry.
              return;
            }
            await assertClaim();
            try {
              await deps.deleteReservedBlob(intent);
            } catch {
              failures.add('upload_intents');
              return;
            }
            await assertClaim();
            try {
              await deps.markSkillUploadIntentCleaned(intent.fileId);
            } catch {
              failures.add('upload_intents');
            }
            return;
          }
          await assertClaim();
          try {
            await deps.deleteReservedBlob(intent);
            // Keep abandoned intents as tombstones: a zombie upload can finish
            // after this cleanup and must be discovered on the next sweep.
          } catch {
            failures.add('upload_intents');
          }
        }),
      ),
    );
    const rejectedIntent = intentResults.find((result) => result.status === 'rejected');
    if (rejectedIntent?.status === 'rejected') throw rejectedIntent.reason;
  }

  if (failures.size > 0) {
    return {
      found: true,
      deleted: false,
      skillAbsent: journal.completedAt != null,
      cleanupComplete: false,
      failedSteps: [...failures],
    };
  }
  if (journal.completedAt && !requiresFullCleanup) {
    return {
      found: true,
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedSteps: [],
    };
  }
  await assertClaim();
  const finalized = await deps.finalizeSkillDeletion(id);
  if (!finalized.cleanupComplete) {
    return {
      found: true,
      deleted: finalized.deleted,
      skillAbsent: finalized.skillAbsent,
      cleanupComplete: false,
      failedSteps: finalized.failedCleanupSteps,
    };
  }
  await assertClaim();
  if (!(await deps.completeSkillDeletion(journal.skillId))) {
    throw new SkillDeletionClaimLostError();
  }
  return {
    found: true,
    deleted: finalized.deleted,
    skillAbsent: finalized.skillAbsent,
    cleanupComplete: true,
    failedSteps: [],
  };
}
