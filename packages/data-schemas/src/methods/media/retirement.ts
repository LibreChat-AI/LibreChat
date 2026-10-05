import type { MediaMethods, MediaOwnerScope } from '~/types/media';
import type { MediaPersistenceContext } from './context';
import {
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
  toMediaAsset,
} from '~/utils/media';
import { createMediaNativePartModel } from '~/models/mediaNativePart';
import { digest, durable, mediaDate, terminal } from './scope';

export function createMediaRetirementMethods({
  Job,
  Thread,
  File,
  mongoose,
  releaseMediaAsset,
  Turn,
}: Pick<
  MediaPersistenceContext,
  'Job' | 'Thread' | 'File' | 'mongoose' | 'releaseMediaAsset' | 'Turn'
>): Pick<
  MediaPersistenceContext,
  | 'retireMediaThread'
  | 'retireAllMediaThreads'
  | 'retireExpiredMediaThreads'
  | 'reconcileMediaRetirements'
  | 'purgeMediaThreadPayloads'
  | 'listMediaRetiringAssets'
> {
  const cancelRetiringThreadJobs = async (scope: MediaOwnerScope, threadId: string) => {
    const now = new Date();
    await Job.updateMany(
      { ...scope, threadId, phase: 'queued', 'provider.certainty': 'unsubmitted' },
      {
        $set: { phase: 'cancelled', cancelRequestedAt: now, updatedAt: now },
        $unset: { activeSlot: 1, leaseToken: 1, leaseOwner: 1, leaseUntil: 1 },
        $inc: { version: 1 },
      },
      { writeConcern: durable },
    );
    await Job.updateMany(
      { ...scope, threadId, phase: { $nin: terminal } },
      { $set: { cancelRequestedAt: now, updatedAt: now }, $inc: { version: 1 } },
      { writeConcern: durable },
    );
  };

  const retireMediaThread: MediaMethods['retireMediaThread'] = async (scope, threadId) => {
    scopeFilter(scope);
    const thread = await Thread.findOneAndUpdate(
      { ...scope, threadId, status: 'active' },
      {
        $set: { status: 'retiring', retiredAt: new Date() },
        $inc: { epoch: 1, version: 1 },
      },
      { new: true, writeConcern: durable },
    ).lean();
    if (!thread) return !!(await Thread.exists({ ...scope, threadId }));
    await cancelRetiringThreadJobs(scope, threadId);
    return true;
  };

  const retireAllMediaThreads: MediaMethods['retireAllMediaThreads'] = async (inputScope) => {
    const scope = scopeFilter(inputScope);
    const cutoff = new Date();
    const result = await Thread.updateMany(
      { ...scope, status: 'active', createdAt: { $lte: cutoff } },
      { $set: { status: 'retiring', retiredAt: cutoff }, $inc: { epoch: 1, version: 1 } },
      { writeConcern: durable },
    );
    // Stream retired identities so new threads and chat-only jobs cannot be cancelled by a broad owner write.
    const threads = Thread.find({ ...scope, status: 'retiring', retiredAt: { $lte: cutoff } })
      .select({ threadId: 1 })
      .lean()
      .cursor();
    for await (const thread of threads) await cancelRetiringThreadJobs(scope, thread.threadId);
    return result.modifiedCount;
  };

  const retireExpiredMediaThreads: MediaMethods['retireExpiredMediaThreads'] = async ({
    scope: inputScope,
    now,
    limit,
  }) => {
    const scope = scopeFilter(inputScope);
    const due = await Thread.find({
      ...scope,
      status: 'active',
      expiresAt: { $lte: mediaDate(now) },
    })
      .sort({ expiresAt: 1, threadId: 1 })
      .limit(positive(limit))
      .select({ threadId: 1 })
      .lean();
    for (const thread of due) {
      await retireMediaThread(scope, thread.threadId);
    }
    return due.length;
  };

  const reconcileMediaRetirements: MediaMethods['reconcileMediaRetirements'] = async ({
    scope: inputScope,
    limit,
  }) => {
    const scope = scopeFilter(inputScope);
    const threads = await Thread.find({ ...scope, status: 'retiring' })
      .sort({ threadId: 1 })
      .limit(positive(limit))
      .lean();
    for (const thread of threads) {
      // Re-run cancellation: a staged insert may have raced the first retirement sweep.
      await Job.updateMany(
        {
          ...scope,
          threadId: thread.threadId,
          phase: 'queued',
          'provider.certainty': 'unsubmitted',
        },
        {
          $set: { phase: 'cancelled', cancelRequestedAt: new Date() },
          $unset: { activeSlot: 1, leaseToken: 1, leaseOwner: 1, leaseUntil: 1 },
          $inc: { version: 1 },
        },
        { writeConcern: durable },
      );
      if (
        await Job.exists({
          ...scope,
          threadId: thread.threadId,
          $or: [
            { phase: { $nin: terminal } },
            { 'accounting.phase': 'held' },
            { 'provider.certainty': { $nin: ['unsubmitted', 'terminal'] } },
          ],
        })
      ) {
        continue;
      }
      const unlinkStamp = `thread:${thread.threadId}:${thread.epoch - 1}`;
      await File.updateMany(
        {
          user: scope.ownerId,
          tenantId: scope.tenantId,
          mediaLifecycle: 'live',
          mediaRetainers: `thread:${thread.threadId}:${thread.epoch - 1}`,
        },
        {
          $pull: { mediaRetainers: `thread:${thread.threadId}:${thread.epoch - 1}` },
          $set: { mediaUnlinkedBy: unlinkStamp },
        },
        { writeConcern: durable },
      );
      await File.updateMany(
        {
          user: scope.ownerId,
          tenantId: scope.tenantId,
          mediaLifecycle: 'live',
          mediaUnlinkedBy: unlinkStamp,
          mediaRetainers: { $size: 0 },
        },
        { $set: { expiredAt: new Date() } },
        { writeConcern: durable },
      );
      await Thread.updateOne(
        { ...scope, threadId: thread.threadId, status: 'retiring', epoch: thread.epoch },
        { $set: { status: 'retired' }, $inc: { version: 1 } },
        { writeConcern: durable },
      );
      await purgeMediaThreadPayloads({ scope, threadId: thread.threadId });
    }
    const unfinished = await Thread.find({
      ...scope,
      status: 'retired',
      payloadPurgedAt: { $exists: false },
    })
      .select({ threadId: 1 })
      .sort({ threadId: 1 })
      .limit(positive(limit))
      .lean();
    for (const thread of unfinished) {
      await purgeMediaThreadPayloads({ scope, threadId: thread.threadId });
    }
    return threads.length;
  };

  const purgeMediaThreadPayloads: MediaMethods['purgeMediaThreadPayloads'] = async ({
    scope: inputScope,
    threadId,
  }) => {
    const scope = scopeFilter(inputScope);
    if (!(await Thread.exists({ ...scope, threadId, status: 'retired' }))) {
      return false;
    }
    if (
      await Job.exists({
        ...scope,
        threadId,
        $or: [
          { phase: { $nin: terminal } },
          { 'accounting.phase': 'held' },
          { 'provider.certainty': { $nin: ['unsubmitted', 'terminal'] } },
        ],
      })
    ) {
      return false;
    }
    const now = new Date();
    await Job.updateMany(
      {
        ...scope,
        threadId,
        executionOwner: 'chat',
        nativeRetentionState: { $ne: 'purged' },
        $or: [
          { nativeConsumers: { $size: 0 } },
          { 'nativeSource.expiresAt': { $lte: now.toISOString() } },
        ],
      },
      { $set: { nativeRetentionState: 'purging' } },
      { writeConcern: durable },
    );
    const nativeJobs = await Job.find({
      ...scope,
      threadId,
      executionOwner: 'chat',
      nativeRetentionState: 'purging',
    })
      .select({ jobId: 1 })
      .lean();
    for (const job of nativeJobs) {
      await createMediaNativePartModel(mongoose).deleteMany(
        { ...scope, jobId: job.jobId },
        { writeConcern: durable },
      );
      const retainer = `native:${job.jobId}`;
      const files = await File.find({
        user: scope.ownerId,
        tenantId: scope.tenantId,
        mediaLifecycle: 'live',
        mediaRetainers: retainer,
      })
        .select({ file_id: 1 })
        .lean();
      for (const file of files) {
        await releaseMediaAsset({ scope, fileId: file.file_id, retainer });
      }
      await Job.updateOne(
        { ...scope, jobId: job.jobId, nativeRetentionState: 'purging' },
        { $set: { nativeRetentionState: 'purged', nativeConsumers: [] } },
        { writeConcern: durable },
      );
    }
    const purgeableJobs = {
      ...scope,
      threadId,
      payloadPurgedAt: { $exists: false },
      $or: [{ executionOwner: 'media' }, { nativeRetentionState: 'purged' }],
    };
    const jobs = await Job.find(purgeableJobs)
      .select({ jobId: 1, version: 1, clientRequestId: 1, operation: 1, selection: 1 })
      .lean()
      .cursor();
    for await (const job of jobs) {
      const purged = await Job.updateOne(
        { ...purgeableJobs, jobId: job.jobId, version: job.version },
        {
          $set: {
            request: {
              clientRequestId: job.clientRequestId,
              operation: job.operation,
              selection: job.selection,
              prompt: '',
              inputs: [],
              parameters: { count: 1 },
            },
            outputs: [],
            payloadPurgedAt: now,
          },
          $unset: { 'provider.recovery': 1, nativePartKeys: 1, nativePartBytes: 1 },
        },
        { writeConcern: durable },
      );
      if (!purged.matchedCount) {
        return false;
      }
    }
    await Turn.updateMany(
      { ...scope, threadId },
      { $set: { prompt: '', inputs: [] }, $unset: { importRequest: 1, importIdentityRequest: 1 } },
      { writeConcern: durable },
    );
    await Thread.updateOne(
      { ...scope, threadId, status: 'retired' },
      { $set: { title: '', payloadPurgedAt: now }, $unset: { cover: 1 } },
      { writeConcern: durable },
    );
    return true;
  };

  const listMediaRetiringAssets: MediaMethods['listMediaRetiringAssets'] = async ({
    scope,
    limit,
    now,
  }) => {
    scopeFilter(scope);
    const files = await File.find({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      mediaLifecycle: 'retiring',
      // Ordinary expiry belongs to the shared File sweep. This repairs an interrupted
      // explicit deletion whose object has no expired deadline for that sweep to discover.
      $and: [
        { $or: [{ deletionRetryAt: null }, { deletionRetryAt: { $lte: mediaDate(now) } }] },
        { $or: [{ expiredAt: null }, { expiredAt: { $gt: mediaDate(now) } }] },
      ],
    })
      .sort({ file_id: 1 })
      .limit(positive(limit))
      .lean();
    return files.map((file) => ({
      ...toMediaAsset(file),
      source: file.source,
      storageKey: file.storageKey,
      storageRegion: file.storageRegion,
      expiredAt: file.expiredAt?.toISOString() ?? null,
      hardExpiresAt: file.mediaHardExpiresAt?.toISOString() ?? null,
      sourceRevision: digest([String(file._id), file.mediaEpoch]),
    }));
  };
  return {
    retireMediaThread,
    retireAllMediaThreads,
    retireExpiredMediaThreads,
    reconcileMediaRetirements,
    purgeMediaThreadPayloads,
    listMediaRetiringAssets,
  };
}
