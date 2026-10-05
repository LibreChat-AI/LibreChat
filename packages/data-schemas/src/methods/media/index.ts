import type { MediaJobDiagnosticsResponse } from 'librechat-data-provider';
import type { FilterQuery, PipelineStage } from 'mongoose';
import type { MediaMethods, MediaOwnerScope, MediaStoredJob } from '~/types/media';
import {
  createMediaActivationModel,
  createMediaAssetWriteModel,
  createMediaJobModel,
  createMediaOwnerModel,
  createMediaPermitModel,
  createMediaPresetModel,
  createMediaThreadModel,
  createMediaTurnModel,
} from '~/models/media';
import {
  MediaPersistenceError,
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
} from '~/utils/media';
import { canonical, claimable, cursorOf, cursorParts, durable, mediaDate } from './scope';
import { migrateMediaDates, migrateMediaUnlinkMarker } from '~/utils/mediaDates';
import { SYSTEM_TENANT_ID, tenantStorage } from '~/config/tenantContext';
import { createMediaPublicationMethods } from './publication';
import { createMediaAccountingMethods } from './accounting';
import { createMediaRetirementMethods } from './retirement';
import { createIndexesWithRetry } from '~/utils/retry';
import { createMediaAccountMethods } from './account';
import { createMediaPermitsMethods } from './permits';
import { createMediaThreadsMethods } from './threads';
import { createMediaAssetsMethods } from './assets';
import { createFileModel } from '~/models/file';
import { createUserModel } from '~/models/user';
import { createMediaJobsMethods } from './jobs';
import { jobView } from './views';
export { MediaPersistenceError } from '~/utils/media';
export { deriveMediaThreadTitle } from './scope';

/** Storage-native protocol; no transactions, in-process locks, or provider calls. */
export type MediaPersistenceDeps = {
  /** A fixture may supply its own user boundary; production checks the real, explicitly scoped User. */
  ownerExists?: (scope: MediaOwnerScope) => Promise<boolean>;
};
export function createMediaMethods(
  mongoose: typeof import('mongoose'),
  deps: MediaPersistenceDeps = {},
): MediaMethods {
  const File = createFileModel(mongoose);

  const Thread = createMediaThreadModel(mongoose);

  const Turn = createMediaTurnModel(mongoose);

  const Job = createMediaJobModel(mongoose);

  const AssetWrite = createMediaAssetWriteModel(mongoose);

  const Permit = createMediaPermitModel(mongoose);

  const Activation = createMediaActivationModel(mongoose);

  const Owner = createMediaOwnerModel(mongoose);

  const Preset = createMediaPresetModel(mongoose);

  const accounting = createMediaAccountingMethods(mongoose);

  const ownerExists =
    deps.ownerExists ??
    (async (scope: MediaOwnerScope) =>
      !!(await createUserModel(mongoose).exists({
        _id: scope.ownerId,
        tenantId: scope.tenantId ?? null,
      })));

  let indexPromise: Promise<void> | undefined;

  async function ensureMediaIndexes(): Promise<void> {
    indexPromise ??= Promise.all([
      migrateMediaDates(Thread.collection, [
        'createdAt',
        'updatedAt',
        'retiredAt',
        'expiresAt',
        'payloadPurgedAt',
        'titleClaim.claimedAt',
      ]),
      migrateMediaDates(Turn.collection, ['createdAt', 'updatedAt', 'publicationExpiresAt']),
      migrateMediaDates(Job.collection, [
        'createdAt',
        'updatedAt',
        'publicationExpiresAt',
        'payloadPurgedAt',
        'dueAt',
        'leaseUntil',
        'cancelRequestedAt',
        'dispatchGrantedAt',
        'nativeConsumersCheckedAt',
      ]),
      migrateMediaDates(AssetWrite.collection, ['createdAt', 'updatedAt', 'deletionRetryAt']),
      migrateMediaUnlinkMarker(File.collection),
      migrateMediaDates(Permit.collection, ['createdAt']),
      migrateMediaDates(Activation.collection, ['activatedAt']),
      migrateMediaDates(Owner.collection, ['updatedAt']),
      migrateMediaDates(Preset.collection, ['createdAt', 'updatedAt']),
    ])
      .then(() =>
        Promise.all(
          [Thread, Turn, Job, AssetWrite, File, Permit, Activation, Owner, Preset].map((model) =>
            createIndexesWithRetry(model),
          ),
        ),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    await indexPromise;
  }

  async function globalScopes(
    kind: 'job' | 'turn' | 'thread' | 'file' | 'owner' | 'write' | 'preset',
    query: PipelineStage.Match['$match'],
    limit: number,
  ): Promise<MediaOwnerScope[]> {
    const model = {
      job: Job,
      turn: Turn,
      thread: Thread,
      file: File,
      owner: Owner,
      write: AssetWrite,
      preset: Preset,
    }[kind];
    return model.aggregate<MediaOwnerScope>([
      { $match: query },
      {
        $group: {
          _id: {
            ownerId: kind === 'file' ? { $toString: '$user' } : '$ownerId',
            tenantId: { $ifNull: ['$tenantId', null] },
          },
        },
      },
      { $project: { _id: 0, ownerId: '$_id.ownerId', tenantId: '$_id.tenantId' } },
      { $sort: { ownerId: 1, tenantId: 1 } },
      { $limit: limit + 1 },
    ]);
  }

  const listDueMediaScopes: MediaMethods['listDueMediaScopes'] = async ({ now, limit, cursor }) => {
    if (tenantStorage.getStore()?.tenantId !== SYSTEM_TENANT_ID) {
      throw new MediaPersistenceError(
        'not_found',
        'System context required for media recovery scan',
      );
    }
    positive(limit);
    const after = cursorParts(cursor);
    const query: FilterQuery<MediaStoredJob> = {
      $or: [
        { 'receipt.phase': 'preparing' },
        {
          executionOwner: 'media',
          'receipt.phase': 'accepted',
          phase: { $in: claimable },
          dueAt: { $lte: mediaDate(now) },
        },
      ],
    };
    if (after) {
      query.$and = [
        {
          $or: [{ ownerId: { $gt: after[1] } }, { ownerId: after[1], tenantId: { $gt: after[0] } }],
        },
      ];
    }
    const [jobs, imports] = await Promise.all([
      globalScopes('job', query, limit),
      globalScopes(
        'turn',
        {
          kind: 'import',
          publicationPhase: 'preparing',
          ...(query.$and ? { $and: query.$and } : {}),
        },
        limit,
      ),
    ]);
    const unique = new Map(
      [...jobs, ...imports].map((row) => [
        canonical([row.ownerId, row.tenantId]),
        { ownerId: row.ownerId, tenantId: row.tenantId ?? null },
      ]),
    );
    const rows = [...unique.values()].sort(
      (a, b) =>
        a.ownerId.localeCompare(b.ownerId) || (a.tenantId ?? '').localeCompare(b.tenantId ?? ''),
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      ...(last && (rows.length > limit || jobs.length > limit || imports.length > limit)
        ? { nextCursor: cursorOf(last.tenantId ?? '', last.ownerId) }
        : {}),
    };
  };

  const activateMedia: MediaMethods['activateMedia'] = async () => {
    await Activation.updateOne(
      { key: 'media-v1' },
      {
        $setOnInsert: {
          key: 'media-v1',
          activatedAt: new Date(),
        },
      },
      { upsert: true, writeConcern: durable },
    );
  };

  const hasMediaActivation: MediaMethods['hasMediaActivation'] = async () =>
    !!(await Activation.exists({ key: 'media-v1' }));

  const listMediaCleanupScopes: MediaMethods['listMediaCleanupScopes'] = async ({
    limit,
    cursor,
    now,
  }) => {
    if (tenantStorage.getStore()?.tenantId !== SYSTEM_TENANT_ID) {
      throw new MediaPersistenceError('not_found', 'System context required for media cleanup');
    }
    positive(limit);
    const after = cursorParts(cursor);
    const threadAfter = after
      ? {
          $or: [{ ownerId: { $gt: after[1] } }, { ownerId: after[1], tenantId: { $gt: after[0] } }],
        }
      : {};
    const fileAfter = after
      ? {
          $or: [
            { user: { $gt: new mongoose.Types.ObjectId(after[1]) } },
            { user: new mongoose.Types.ObjectId(after[1]), tenantId: { $gt: after[0] } },
          ],
        }
      : {};
    const [threads, expiring, files, nativeJobs, deletedOwners, assetWrites, presets] =
      await Promise.all([
        globalScopes(
          'thread',
          {
            $and: [
              threadAfter,
              {
                $or: [
                  { status: 'retiring' },
                  { status: 'retired', payloadPurgedAt: { $exists: false } },
                ],
              },
            ],
          },
          limit,
        ),
        globalScopes(
          'thread',
          { status: 'active', expiresAt: { $lte: mediaDate(now) }, ...threadAfter },
          limit,
        ),
        globalScopes(
          'file',
          {
            $and: [
              fileAfter,
              { $or: [{ deletionRetryAt: null }, { deletionRetryAt: { $lte: mediaDate(now) } }] },
              {
                $or: [
                  {
                    mediaLifecycle: 'live',
                    mediaConsumerReconcileAt: { $lte: mediaDate(now) },
                  },
                  {
                    mediaLifecycle: 'retiring',
                    $or: [{ expiredAt: null }, { expiredAt: { $gt: mediaDate(now) } }],
                  },
                ],
              },
            ],
          },
          limit,
        ),
        globalScopes(
          'job',
          {
            executionOwner: 'chat',
            $and: [
              threadAfter,
              {
                $or: [
                  { phase: { $in: ['queued', 'running'] } },
                  { nativeRetentionState: 'purging' },
                  { nativeCleanupPending: true },
                  { nativeConsumersTracked: true, nativeRetentionState: { $ne: 'purged' } },
                  { phase: 'reconciling', 'recoveryDecisions.request.action': 'acknowledge' },
                  {
                    'nativeSource.expiresAt': { $lte: mediaDate(now).toISOString() },
                    nativeRetentionState: { $ne: 'purged' },
                  },
                ],
              },
            ],
          },
          limit,
        ),
        globalScopes('owner', { status: { $in: ['deleting', 'deleted'] }, ...threadAfter }, limit),
        globalScopes(
          'write',
          {
            state: { $in: ['reserved', 'committing', 'abandoned'] },
            $and: [
              threadAfter,
              { $or: [{ deletionRetryAt: null }, { deletionRetryAt: { $lte: mediaDate(now) } }] },
            ],
          },
          limit,
        ),
        globalScopes('preset', threadAfter, limit),
      ]);
    const scopes = [
      ...threads,
      ...expiring,
      ...nativeJobs,
      ...deletedOwners,
      ...assetWrites,
      ...files,
      ...presets,
    ];
    const rows = [...new Map(scopes.map((scope) => [canonical(scope), scope])).values()].sort(
      (a, b) =>
        a.ownerId.localeCompare(b.ownerId) || (a.tenantId ?? '').localeCompare(b.tenantId ?? ''),
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      ...(last &&
      (rows.length > limit ||
        threads.length > limit ||
        expiring.length > limit ||
        files.length > limit ||
        nativeJobs.length > limit ||
        deletedOwners.length > limit ||
        assetWrites.length > limit ||
        presets.length > limit)
        ? { nextCursor: cursorOf(last.tenantId ?? '', last.ownerId) }
        : {}),
    };
  };

  const {
    stage,
    refreshThread,
    publishMediaSubmission,
    stageMediaImport,
    publishMediaImport,
    recoverMediaPublications,
  } = createMediaPublicationMethods({
    Thread,
    ensureMediaIndexes: (...args) => ensureMediaIndexes(...args),
    activateMedia: (...args) => activateMedia(...args),
    Job,
    assertOwnerActive: (...args) => assertOwnerActive(...args),
    Turn,
    acquireMediaPermit: (...args) => acquireMediaPermit(...args),
    getJob: (...args) => getJob(...args),
    File,
    retainMediaThreadAsset: (...args) => retainMediaThreadAsset(...args),
    admitOwnerWork: (...args) => admitOwnerWork(...args),
    releaseOwnerWork: (...args) => releaseOwnerWork(...args),
  });
  const {
    getMediaThread,
    listMediaThreads,
    listMediaTurnJobs,
    listMediaTurns,
    getMediaLatestImageContext,
    getMediaLatestVideoContext,
    replaceMediaThreadTitle,
    updateMediaThread,
  } = createMediaThreadsMethods({ Thread, Job, Turn, File, mongoose });
  const {
    getJob,
    claimMediaJob,
    renewMediaJob,
    beginMediaSubmission,
    releaseMediaJobLease,
    recordMediaJobObservation,
    cancelMediaJob,
    retryMediaJob,
  } = createMediaJobsMethods({
    Job,
    admitOwnerWork: (...args) => admitOwnerWork(...args),
    Thread,
    releaseOwnerWork: (...args) => releaseOwnerWork(...args),
    releaseMediaPermits: (...args) => releaseMediaPermits(...args),
    refreshThread: (...args) => refreshThread(...args),
    stage: (...args) => stage(...args),
  });
  const {
    getMediaAsset,
    getAvailableMediaFileIds,
    reserveMediaAssetWrite,
    commitMediaAssetWrite,
    recoverMediaAssetWrites,
    listMediaAssetWritesForCleanup,
    incrementMediaAssetWriteDeletionAttempts,
    deferMediaAssetWriteCleanup,
    claimMediaAssetWriteDeletion,
    completeMediaAssetWriteDeletion,
    retainMediaAsset,
    getMediaAssetContent,
    releaseMediaAsset,
    claimMediaAssetDeletion,
    completeMediaAssetDeletion,
    getMediaSourceFile,
    isMediaFile,
    getPublishedMediaAsset,
    retainMediaThreadAsset,
  } = createMediaAssetsMethods({
    File,
    ensureMediaIndexes: (...args) => ensureMediaIndexes(...args),
    activateMedia: (...args) => activateMedia(...args),
    AssetWrite,
    assertOwnerActive: (...args) => assertOwnerActive(...args),
    releaseOwnerWork: (...args) => releaseOwnerWork(...args),
    admitOwnerWork: (...args) => admitOwnerWork(...args),
    mongoose,
    Thread,
  });
  const { acquireMediaPermit, acquireMediaPermits, releaseMediaPermits, reconcileMediaPermits } =
    createMediaPermitsMethods({
      getJob: (...args) => getJob(...args),
      Permit,
      Job,
      releaseOwnerWork: (...args) => releaseOwnerWork(...args),
    });
  const {
    assertOwnerActive,
    admitOwnerWork,
    releaseOwnerWork,
    prepareMediaAccountDeletion,
    cancelMediaAccountDeletion,
    completeMediaAccountDeletion,
    reconcileMediaAccountDeletion,
  } = createMediaAccountMethods({
    Owner,
    ownerExists,
    ensureMediaIndexes: (...args) => ensureMediaIndexes(...args),
    AssetWrite,
    Job,
    Turn,
    mongoose,
    accounting,
    Thread,
    Preset,
    File,
    reconcileMediaRetirements: (...args) => reconcileMediaRetirements(...args),
    releaseMediaPermits: (...args) => releaseMediaPermits(...args),
    Permit,
  });
  const {
    retireMediaThread,
    retireAllMediaThreads,
    retireExpiredMediaThreads,
    reconcileMediaRetirements,
    purgeMediaThreadPayloads,
    listMediaRetiringAssets,
  } = createMediaRetirementMethods({
    Job,
    Thread,
    File,
    mongoose,
    releaseMediaAsset: (...args) => releaseMediaAsset(...args),
    Turn,
  });

  return {
    assertMediaOwnerActive: async (scope) => {
      await activateMedia();
      await assertOwnerActive(scope);
    },
    prepareMediaAccountDeletion,
    getMediaBacklogMetrics: async () => {
      if (tenantStorage.getStore()?.tenantId !== SYSTEM_TENANT_ID) {
        throw new MediaPersistenceError('not_found', 'System context required for media metrics');
      }
      const now = Date.now();
      const [
        queued,
        requiresAttention,
        activePermits,
        oldest,
        pendingAccountDeletions,
        activeJobs,
        oldestQueued,
      ] = await Promise.all([
        Job.countDocuments({
          executionOwner: 'media',
          'receipt.phase': 'accepted',
          phase: 'queued',
        }),
        Job.countDocuments({ phase: 'requires_attention' }),
        Permit.countDocuments({ kind: 'deployment' }),
        Job.findOne({
          phase: { $in: claimable },
          leaseUntil: { $lte: new Date(now) },
        })
          .sort({ leaseUntil: 1 })
          .select('leaseUntil')
          .lean(),
        Owner.countDocuments({ status: 'deleting' }),
        Job.countDocuments({
          executionOwner: 'media',
          'receipt.phase': 'accepted',
          phase: {
            $in: ['submitting', 'running', 'ingesting', 'reconciling'],
          },
        }),
        Job.findOne({ executionOwner: 'media', 'receipt.phase': 'accepted', phase: 'queued' })
          .sort({ createdAt: 1 })
          .select('createdAt')
          .lean(),
      ]);
      return {
        queued,
        requiresAttention,
        activePermits,
        activeJobs,
        oldestQueuedAgeSeconds: oldestQueued
          ? Math.max(0, (now - oldestQueued.createdAt.getTime()) / 1000)
          : 0,
        pendingAccountDeletions,
        oldestExpiredLeaseSeconds: oldest?.leaseUntil
          ? Math.max(0, (now - oldest.leaseUntil.getTime()) / 1000)
          : 0,
      };
    },
    cancelMediaAccountDeletion,
    completeMediaAccountDeletion,
    reconcileMediaAccountDeletion,
    activateMedia,
    hasMediaActivation,
    ensureMediaIndexes,
    stageMediaSubmission: (input) => stage(input),
    publishMediaSubmission,
    getMediaSubmission: async (scope, clientRequestId) =>
      (await Job.findOne({ ...scopeFilter(scope), clientRequestId }).lean())?.receipt ?? null,
    stageMediaImport,
    publishMediaImport,
    getMediaImport: async (scope, clientRequestId) =>
      (await Turn.findOne({ ...scopeFilter(scope), kind: 'import', clientRequestId }).lean())
        ?.importReceipt ?? null,
    getMediaThread,
    listMediaThreads,
    listMediaTurns,
    getMediaLatestImageContext,
    getMediaLatestVideoContext,
    listMediaTurnJobs,
    getMediaJob: getJob,
    getMediaParentContext: async (scope, threadId, parentTurnId) => {
      if (!(await Thread.exists({ ...scopeFilter(scope), threadId, status: 'active' }))) {
        return null;
      }
      return Job.findOne({
        ...scopeFilter(scope),
        threadId,
        turnId: parentTurnId,
        phase: 'succeeded',
        'receipt.phase': 'accepted',
      })
        .sort({ createdAt: -1, jobId: -1 })
        .lean<MediaStoredJob | null>();
    },
    getMediaJobView: async (scope, jobId) => {
      const job = await getJob(scope, jobId);
      return job &&
        (await Thread.exists({ ...scopeFilter(scope), threadId: job.threadId, status: 'active' }))
        ? jobView(job)
        : null;
    },
    getMediaJobDiagnostics: async (scope, jobId) => {
      const [result] = await Job.aggregate<MediaJobDiagnosticsResponse>([
        { $match: { ...scopeFilter(scope), jobId, 'receipt.phase': 'accepted' } },
        {
          $lookup: {
            // eslint-disable-next-line no-restricted-syntax -- Collection metadata only; both sides of the lookup use the explicit owner and tenant scope.
            from: Thread.collection.name,
            let: { threadId: '$threadId' },
            pipeline: [
              {
                $match: {
                  ...scopeFilter(scope),
                  status: 'active',
                  $expr: { $eq: ['$threadId', '$$threadId'] },
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: 'thread',
          },
        },
        { $match: { 'thread.0': { $exists: true } } },
        { $project: { _id: 0, diagnostic: '$provider.recovery.diagnostic' } },
        { $limit: 1 },
      ]);
      return result ?? null;
    },
    updateMediaThread,
    replaceMediaThreadTitle,
    claimMediaJob,
    renewMediaJob,
    releaseMediaJobLease,
    beginMediaSubmission,
    recordMediaJobObservation,
    cancelMediaJob,
    retryMediaJob,
    retireMediaThread,
    retireAllMediaThreads,
    listDueMediaScopes,
    recoverMediaPublications,
    reserveMediaAssetWrite,
    commitMediaAssetWrite,
    recoverMediaAssetWrites,
    listMediaAssetWritesForCleanup,
    incrementMediaAssetWriteDeletionAttempts,
    deferMediaAssetWriteCleanup,
    claimMediaAssetWriteDeletion,
    completeMediaAssetWriteDeletion,
    getMediaAsset,
    getAvailableMediaFileIds,
    getMediaAssetContent,
    getMediaSourceFile,
    isMediaFile,
    retainMediaThreadAsset,
    getPublishedMediaAsset,
    retainMediaAsset,
    releaseMediaAsset,
    claimMediaAssetDeletion,
    completeMediaAssetDeletion,
    acquireMediaPermit,
    acquireMediaPermits,
    releaseMediaPermits,
    reconcileMediaPermits,
    listMediaCleanupScopes,
    reconcileMediaRetirements,
    purgeMediaThreadPayloads,
    retireExpiredMediaThreads,
    listMediaRetiringAssets,
  };
}
