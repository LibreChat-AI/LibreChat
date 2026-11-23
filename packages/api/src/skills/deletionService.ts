import { randomUUID } from 'node:crypto';
import { DEFAULT_SKILL_DELETION_CLEANUP_CONCURRENCY } from 'librechat-data-provider';
import type {
  AppConfig,
  DeleteSkillResult,
  SkillDeletionRecord,
  SkillUploadIntentRecord,
} from '@librechat/data-schemas';
import type { SkillDeletionDeps, SkillDeletionProgress } from './deletion';
import type { ServerRequest, StrategyFunctions } from '~/types';
import { runSkillDeletion, SkillDeletionClaimLostError } from './deletion';
import { createConcurrencyLimiter } from '~/utils/promise';
import { getStorageMetadata } from '~/storage/metadata';
import { getSafeErrorMetadata } from '~/utils/errors';

type Persistence = Omit<
  SkillDeletionDeps,
  'deleteBlob' | 'deleteReservedBlob' | 'completeSkillDeletion'
> & {
  completeSkillDeletion: (id: string, owner: string) => Promise<boolean>;
  discoverUnjournaledDeletions: (limit: number) => Promise<number>;
  listSkillDeletionTombstones: (limit: number) => Promise<SkillDeletionRecord[]>;
  claimSkillDeletion: (id: string, owner: string, leaseMs: number) => Promise<boolean>;
  refreshSkillDeletionClaim: (id: string, owner: string, leaseMs: number) => Promise<boolean>;
  noteSkillDeletionAttempt: (id: string) => Promise<void>;
  releaseSkillDeletionClaim: (id: string, owner: string) => Promise<void>;
  scheduleSkillDeletionRecheck: (id: string, owner: string, delayMs: number) => Promise<boolean>;
  listAbandonedSkillUploadIntents: (limit: number) => Promise<SkillUploadIntentRecord[]>;
  claimAbandonedSkillUploadIntent: (
    fileId: string,
    owner: string,
    leaseMs: number,
  ) => Promise<boolean>;
  refreshAbandonedSkillUploadIntentClaim: (
    fileId: string,
    owner: string,
    leaseMs: number,
  ) => Promise<boolean>;
  noteAbandonedSkillUploadIntentAttempt: (fileId: string) => Promise<void>;
  releaseAbandonedSkillUploadIntentClaim: (fileId: string, owner: string) => Promise<void>;
  scheduleAbandonedSkillUploadIntentRecheck: (
    fileId: string,
    owner: string,
    delayMs: number,
  ) => Promise<boolean>;
  skillFileExistsForIntent: (skillId: string, fileId: string) => Promise<boolean>;
};

interface SkillDeletionServiceDeps {
  persistence: Persistence;
  loadConfig: () => Promise<AppConfig | undefined>;
  getStrategyFunctions: (source: string) => Partial<StrategyFunctions>;
  runAsSystem: <T>(callback: () => Promise<T>) => Promise<T>;
  logger: Pick<Console, 'error' | 'warn'>;
}

export interface SkillDeletionSweepOptions {
  sweepIntervalMs: number;
  claimLeaseMs: number;
  batchSize: number;
}

export interface SkillDeletionService {
  deleteSkillById: (skillId: string) => Promise<SkillDeletionProgress>;
  deleteSkillForLegacy: (
    skillId: string,
  ) => Promise<DeleteSkillResult & { blobCleanupManaged: boolean }>;
  startSkillDeletionSweep: (options?: Partial<SkillDeletionSweepOptions>) => {
    stop: () => void;
    runOnce: () => Promise<void>;
  };
}

type CleanupLimiter = ReturnType<typeof createConcurrencyLimiter>;

/** The legacy server supplies storage, database, and context dependencies; it owns no worker logic. */
export function createSkillDeletionService(deps: SkillDeletionServiceDeps): SkillDeletionService {
  async function deleteStoredBlob(
    file: {
      filepath: string;
      source: string;
      storageKey?: string | null;
      storageRegion?: string | null;
      author: string;
      tenantId?: string;
    },
    config: AppConfig | undefined,
  ) {
    const strategy = deps.getStrategyFunctions(file.source);
    if (!strategy.deleteFile) {
      throw new Error(`Skill storage backend ${file.source} has no deletion strategy`);
    }
    const ownerId = file.author;
    await strategy.deleteFile(
      {
        config,
        user: { id: ownerId, _id: ownerId, tenantId: file.tenantId },
      } as unknown as ServerRequest,
      {
        filepath: file.filepath,
        storageKey: file.storageKey,
        storageRegion: file.storageRegion,
        user: ownerId,
        tenantId: file.tenantId,
      },
    );
  }

  function pendingDeletion(found: boolean): SkillDeletionProgress {
    return {
      found,
      deleted: false,
      skillAbsent: !found,
      cleanupComplete: !found,
      failedSteps: [],
    };
  }

  function completedDeletion(): SkillDeletionProgress {
    return {
      found: true,
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedSteps: [],
    };
  }

  /** Each request or sweep item owns a distinct claim; same-owner reentry would bypass exclusion. */
  async function deleteWithClaim(
    skillId: string,
    claimLeaseMs: number,
    loadedConfig: AppConfig | undefined | null = null,
    limitBlob?: CleanupLimiter,
  ): Promise<SkillDeletionProgress> {
    const journal =
      (await deps.persistence.beginSkillDeletion(skillId)) ??
      (await deps.persistence.getSkillDeletion(skillId));
    if (!journal) return pendingDeletion(false);
    const config = loadedConfig === null ? await deps.loadConfig() : loadedConfig;
    if (config?.skillDeletion?.finalizationEnabled !== true) {
      return journal.completedAt ? completedDeletion() : pendingDeletion(true);
    }
    const owner = randomUUID();
    if (!(await deps.persistence.claimSkillDeletion(skillId, owner, claimLeaseMs))) {
      // A completed tombstone may be deliberately deferred until its next cold audit.
      // Re-read it: another worker could have reopened it after the first lookup.
      if ((await deps.persistence.getSkillDeletion(skillId))?.completedAt) {
        return completedDeletion();
      }
      return pendingDeletion(true);
    }
    let lost = false;
    const assertClaim = async () => {
      if (lost) throw new SkillDeletionClaimLostError();
      try {
        const retained = await deps.persistence.refreshSkillDeletionClaim(
          skillId,
          owner,
          claimLeaseMs,
        );
        if (!retained) {
          lost = true;
          throw new SkillDeletionClaimLostError();
        }
      } catch (error) {
        lost = true;
        throw error;
      }
    };
    const heartbeat = setInterval(() => {
      void assertClaim().catch((error) =>
        deps.logger.error('[skill deletion] Claim heartbeat failed:', getSafeErrorMetadata(error)),
      );
    }, claimLeaseMs / 4);
    heartbeat.unref?.();
    try {
      const progress = await runSkillDeletion(
        skillId,
        {
          ...deps.persistence,
          completeSkillDeletion: (id) => deps.persistence.completeSkillDeletion(id, owner),
          deleteBlob: (file) =>
            limitBlob
              ? limitBlob(() => deleteStoredBlob(file, config ?? undefined))
              : deleteStoredBlob(file, config ?? undefined),
          deleteReservedBlob: (intent) => {
            const deleteIntentBlob = () =>
              deleteStoredBlob(
                {
                  filepath: intent.storageKey,
                  source: intent.source,
                  ...getStorageMetadata({ filepath: intent.storageKey, source: intent.source }),
                  author: intent.author,
                  tenantId: intent.tenantId,
                },
                config ?? undefined,
              );
            return limitBlob ? limitBlob(deleteIntentBlob) : deleteIntentBlob();
          },
        },
        config?.fileConfig?.skills?.deletionCleanupConcurrency,
        assertClaim,
        journal,
        config?.skillDeletion?.batchSize,
      );
      if (progress.cleanupComplete) {
        await assertClaim();
        const scheduled = await deps.persistence.scheduleSkillDeletionRecheck(
          skillId,
          owner,
          config?.skillDeletion?.recheckIntervalMs ?? 3_600_000,
        );
        if (!scheduled) {
          lost = true;
          throw new SkillDeletionClaimLostError();
        }
      }
      return progress;
    } catch (error) {
      if (error instanceof SkillDeletionClaimLostError) return pendingDeletion(true);
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (!lost) {
        try {
          await assertClaim();
          await deps.persistence.noteSkillDeletionAttempt(skillId);
        } catch (error) {
          deps.logger.error(
            `[skill deletion] Attempt timestamp failed for ${skillId}:`,
            getSafeErrorMetadata(error),
          );
        }
      }
      try {
        await deps.persistence.releaseSkillDeletionClaim(skillId, owner);
      } catch (error) {
        deps.logger.error(
          `[skill deletion] Claim release failed for ${skillId}:`,
          getSafeErrorMetadata(error),
        );
      }
    }
  }

  async function deleteSkillById(skillId: string) {
    const config = await deps.loadConfig();
    return deleteWithClaim(skillId, config?.skillDeletion?.claimLeaseMs ?? 120_000, config);
  }

  async function deleteSkillForLegacy(skillId: string) {
    const progress = await deleteSkillById(skillId);
    return {
      deleted: progress.deleted,
      skillAbsent: progress.skillAbsent,
      cleanupComplete: progress.cleanupComplete,
      failedCleanupSteps: progress.failedSteps,
      blobCleanupManaged: true,
    };
  }

  /** Completed tombstones remain eligible for cold audits: delayed writers may surface later. */
  function startSkillDeletionSweep(options: Partial<SkillDeletionSweepOptions> = {}) {
    const { sweepIntervalMs = 60_000, claimLeaseMs = 120_000, batchSize = 100 } = options;
    let running = false;
    async function sweepAbandonedIntents() {
      const intents = await deps.persistence.listAbandonedSkillUploadIntents(batchSize);
      if (intents.length === 0) return;
      const config = await deps.loadConfig();
      const recheckIntervalMs = config?.skillDeletion?.recheckIntervalMs ?? 3_600_000;
      const limit = createConcurrencyLimiter(
        config?.fileConfig?.skills?.deletionCleanupConcurrency ??
          DEFAULT_SKILL_DELETION_CLEANUP_CONCURRENCY,
      );
      const results = await Promise.allSettled(
        intents.map((intent) =>
          limit(async () => {
            const { fileId } = intent;
            const owner = randomUUID();
            if (
              !(await deps.persistence.claimAbandonedSkillUploadIntent(fileId, owner, claimLeaseMs))
            ) {
              return;
            }
            let lost = false;
            const assertClaim = async () => {
              if (lost) throw new SkillDeletionClaimLostError();
              try {
                const retained = await deps.persistence.refreshAbandonedSkillUploadIntentClaim(
                  fileId,
                  owner,
                  claimLeaseMs,
                );
                if (!retained) {
                  lost = true;
                  throw new SkillDeletionClaimLostError();
                }
              } catch (error) {
                lost = true;
                throw error;
              }
            };
            const heartbeat = setInterval(() => {
              void assertClaim().catch((error) =>
                deps.logger.error(
                  '[skill upload intent] Claim heartbeat failed:',
                  getSafeErrorMetadata(error),
                ),
              );
            }, claimLeaseMs / 4);
            heartbeat.unref?.();
            try {
              const skillId = intent.skillId;
              await assertClaim();
              if (await deps.persistence.getSkillDeletion(skillId)) {
                // Whole-Skill deletion owns intents for this Skill.
                await assertClaim();
                if (
                  !(await deps.persistence.scheduleAbandonedSkillUploadIntentRecheck(
                    fileId,
                    owner,
                    recheckIntervalMs,
                  ))
                ) {
                  lost = true;
                  throw new SkillDeletionClaimLostError();
                }
                return;
              }
              await assertClaim();
              if (await deps.persistence.skillFileExistsForIntent(skillId, fileId)) {
                deps.logger.warn(
                  `[skill upload intent] ${fileId} still has a file row; retaining blob`,
                );
                await assertClaim();
                if (
                  !(await deps.persistence.scheduleAbandonedSkillUploadIntentRecheck(
                    fileId,
                    owner,
                    recheckIntervalMs,
                  ))
                ) {
                  lost = true;
                  throw new SkillDeletionClaimLostError();
                }
                return;
              }
              await assertClaim();
              await deleteStoredBlob(
                {
                  filepath: intent.storageKey,
                  source: intent.source,
                  ...getStorageMetadata({ filepath: intent.storageKey, source: intent.source }),
                  author: intent.author,
                  tenantId: intent.tenantId,
                },
                config,
              );
              await assertClaim();
              await deps.persistence.markSkillUploadIntentCleaned(fileId);
              await assertClaim();
              if (
                !(await deps.persistence.scheduleAbandonedSkillUploadIntentRecheck(
                  fileId,
                  owner,
                  recheckIntervalMs,
                ))
              ) {
                lost = true;
                throw new SkillDeletionClaimLostError();
              }
            } catch (error) {
              deps.logger.error(
                `[skill upload intent] Cleanup failed for ${fileId}:`,
                getSafeErrorMetadata(error),
              );
            } finally {
              clearInterval(heartbeat);
              if (!lost) {
                try {
                  await assertClaim();
                  await deps.persistence.noteAbandonedSkillUploadIntentAttempt(fileId);
                } catch (error) {
                  deps.logger.error(
                    `[skill upload intent] Attempt timestamp failed for ${fileId}:`,
                    getSafeErrorMetadata(error),
                  );
                }
              }
              try {
                await deps.persistence.releaseAbandonedSkillUploadIntentClaim(fileId, owner);
              } catch (error) {
                deps.logger.error(
                  `[skill upload intent] Claim release failed for ${fileId}:`,
                  getSafeErrorMetadata(error),
                );
              }
            }
          }),
        ),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          deps.logger.error(
            '[skill upload intent] Sweep item failed:',
            getSafeErrorMetadata(result.reason),
          );
        }
      }
    }
    async function tick() {
      if (running) return;
      running = true;
      try {
        await deps.runAsSystem(async () => {
          try {
            await deps.persistence.discoverUnjournaledDeletions(batchSize);
            const tombstones = await deps.persistence.listSkillDeletionTombstones(batchSize);
            const config = await deps.loadConfig();
            if (config?.skillDeletion?.finalizationEnabled === true) {
              const concurrency =
                config?.fileConfig?.skills?.deletionCleanupConcurrency ??
                DEFAULT_SKILL_DELETION_CLEANUP_CONCURRENCY;
              // Bound both active tombstones and their aggregate provider calls;
              // each Skill also bounds its own file fanout in runSkillDeletion.
              const limitTombstones = createConcurrencyLimiter(concurrency);
              const limitBlob = createConcurrencyLimiter(concurrency);
              await Promise.all(
                tombstones.map((tombstone) =>
                  limitTombstones(async () => {
                    const skillId = tombstone.skillId;
                    try {
                      const progress = await deleteWithClaim(
                        skillId,
                        claimLeaseMs,
                        config,
                        limitBlob,
                      );
                      if (!progress.cleanupComplete) {
                        // A live upload is never timed out automatically. Operators must verify
                        // its writer is dead before explicitly abandoning the intent.
                        deps.logger.warn(
                          `[skill deletion] ${skillId} pending manual/retry cleanup: ${progress.failedSteps.join(', ')}`,
                        );
                      }
                    } catch (error) {
                      deps.logger.error(
                        `[skill deletion] Cleanup failed for ${skillId}:`,
                        getSafeErrorMetadata(error),
                      );
                    }
                  }),
                ),
              );
            }
          } finally {
            // Active Skills can own abandoned upload intents with no deletion tombstone.
            await sweepAbandonedIntents();
          }
        });
      } catch (error) {
        deps.logger.error('[skill deletion] Sweep failed:', getSafeErrorMetadata(error));
      } finally {
        running = false;
      }
    }
    const interval = setInterval(tick, sweepIntervalMs);
    interval.unref?.();
    void tick();
    return { stop: () => clearInterval(interval), runOnce: tick };
  }

  return { deleteSkillById, deleteSkillForLegacy, startSkillDeletionSweep };
}
