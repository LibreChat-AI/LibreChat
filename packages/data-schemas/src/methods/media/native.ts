import { detachNativeIdentity, getNativeContinuationRefs } from 'librechat-data-provider';
import type { MediaOutput } from 'librechat-data-provider';
import type {
  MediaMethods,
  MediaOwnerScope,
  MediaStoredJob,
  MediaProviderState,
} from '~/types/media';
import type { MediaNativeMethods, MediaNativePartRecord } from '~/types/mediaNative';
import { MediaPersistenceError, mediaScopeFilter as scopeFilter } from '~/utils/media';
import { createMediaJobModel, createMediaThreadModel } from '~/models/media';
import { createMediaNativePartModel } from '~/models/mediaNativePart';
import { createIndexesWithRetry } from '~/utils/retry';
import { migrateMediaDates } from '~/utils/mediaDates';
import { createMessageModel } from '~/models/message';
import { createFileModel } from '~/models/file';
import { toMediaAsset } from '~/utils/media';
import { durable } from './scope';

/** Reads and retires legacy recordings; new native output belongs to Message and File. */
export function createMediaNativeMethods(
  mongoose: typeof import('mongoose'),
  media: MediaMethods,
): MediaNativeMethods {
  const Part = createMediaNativePartModel(mongoose);
  const Job = createMediaJobModel(mongoose);
  const Thread = createMediaThreadModel(mongoose);
  const File = createFileModel(mongoose);
  const Message = createMessageModel(mongoose);

  const ensureMediaNativeIndexes: MediaNativeMethods['ensureMediaNativeIndexes'] = async () => {
    await migrateMediaDates(Part.collection, ['createdAt']);
    await createIndexesWithRetry(Part);
  };

  async function materialize(
    job: MediaStoredJob,
  ): Promise<{ outputs: MediaOutput[]; recovery: MediaProviderState['recovery'] }> {
    const parts = await Part.find({ ...scopeFilter(job), jobId: job.jobId })
      .sort({ chunkIndex: 1, partIndex: 1 })
      .limit(job.nativeLimits!.maxParts)
      .lean();
    const outputs: MediaOutput[] = [];
    const recoveryParts: NonNullable<MediaProviderState['recovery']>['parts'] = [];
    const fileIds = parts.flatMap((entry) =>
      entry.part.kind === 'image' ? [entry.part.fileId] : [],
    );
    const files = fileIds.length
      ? await File.find({
          user: job.ownerId,
          tenantId: job.tenantId,
          file_id: { $in: fileIds },
          mediaLifecycle: 'live',
          $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }],
        })
          .select(
            'file_id filename type bytes filepath width height durationSeconds source mediaRenditions',
          )
          .lean()
      : [];
    const assets = new Map(files.map((file) => [file.file_id, toMediaAsset(file)]));
    parts.forEach((entry, ordinal) => {
      const part = entry.part;
      if (part.kind === 'text') {
        recoveryParts.push({
          kind: 'text',
          ordinal,
          text: part.text,
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
        const previous = outputs[outputs.length - 1];
        if (previous?.kind === 'text') {
          previous.text += part.text;
        } else {
          outputs.push({ kind: 'text', outputId: entry.continuationRef, ordinal, text: part.text });
        }
      } else {
        recoveryParts.push({
          kind: 'image',
          ordinal,
          type: part.mimeType,
          fileId: part.fileId,
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
        const asset = assets.get(part.fileId);
        outputs.push({
          kind: 'image',
          ordinal,
          outputId: entry.continuationRef,
          state: asset ? 'ready' : 'expired',
          ...(asset ? { asset } : { error: { code: 'output_expired' as const } }),
        });
      }
    });
    return { outputs, recovery: { parts: recoveryParts, terminalStatus: 'completed' } };
  }

  const failMediaNativeRecording: MediaNativeMethods['failMediaNativeRecording'] = async ({
    scope,
    jobId,
    reason,
    resolutionId,
  }) => {
    const job = await media.getMediaJob(scope, jobId);
    if (!job?.nativeLimits || job.executionOwner !== 'chat') {
      return null;
    }
    const decision = job.recoveryDecisions?.[job.recoveryDecisions.length - 1];
    const resolving =
      resolutionId !== undefined &&
      decision?.request.clientRequestId === resolutionId &&
      decision.request.action === 'acknowledge';
    if (resolutionId !== undefined && !resolving) {
      throw new MediaPersistenceError('conflict', 'Native media recovery identity changed');
    }
    const phases = resolving ? ['reconciling'] : ['running', 'requires_attention'];
    if (!phases.includes(job.phase)) {
      return job;
    }
    const content = await materialize(job);
    const failed = await Job.findOneAndUpdate(
      {
        ...scopeFilter(scope),
        jobId,
        executionOwner: 'chat',
        phase: { $in: phases },
        version: job.version,
      },
      {
        $set: {
          phase: reason === 'aborted' ? 'cancelled' : 'failed',
          outputs: content.outputs,
          provider: {
            certainty: 'terminal',
            recovery: {
              ...content.recovery,
              terminalStatus: reason === 'aborted' ? 'cancelled' : 'failed',
            },
          },
          error: { code: reason === 'storage' ? 'storage_failed' : 'provider_rejected' },
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { new: true, writeConcern: durable },
    ).lean<MediaStoredJob | null>();
    if (failed) {
      await refreshThread(failed);
    }
    return failed;
  };

  const reconcileMediaNativeRecordings: MediaNativeMethods['reconcileMediaNativeRecordings'] =
    async (input) => {
      const scope = scopeFilter(input.scope);
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit <= 0 ||
        !Number.isFinite(Date.parse(input.now)) ||
        !Number.isFinite(Date.parse(input.staleBefore))
      ) {
        throw new MediaPersistenceError('invalid_input', 'Invalid native recovery bounds');
      }
      const jobs = await Job.find({
        ...scope,
        executionOwner: 'chat',
        phase: { $in: ['queued', 'running'] },
        updatedAt: { $lte: new Date(input.staleBefore).toISOString() },
      })
        .sort({ updatedAt: 1, jobId: 1 })
        .limit(input.limit)
        .lean<MediaStoredJob[]>();
      for (const job of jobs) {
        if (!job.nativeLimits && job.phase === 'queued') {
          // start() never returned, so the SDK has no permission to invoke the provider.
          const failed = await Job.findOneAndUpdate(
            {
              ...scope,
              jobId: job.jobId,
              executionOwner: 'chat',
              phase: 'queued',
              version: job.version,
              nativeLimits: { $exists: false },
            },
            {
              $set: {
                phase: 'failed',
                error: { code: 'provider_rejected' },
                updatedAt: new Date(input.now).toISOString(),
              },
              $inc: { version: 1 },
            },
            { new: true, writeConcern: durable },
          ).lean<MediaStoredJob | null>();
          if (failed) {
            await refreshThread(failed);
          }
          continue;
        }
        if (!job.nativeLimits) {
          continue;
        }
        const content = await materialize(job);
        const { terminalStatus: _terminalStatus, ...recovery } = content.recovery ?? {};
        await Job.updateOne(
          {
            ...scope,
            jobId: job.jobId,
            executionOwner: 'chat',
            phase: 'running',
            version: job.version,
          },
          {
            $set: {
              phase: 'requires_attention',
              outputs: content.outputs,
              provider: { ...job.provider, recovery },
              error: { code: 'submission_uncertain' },
              updatedAt: new Date(input.now).toISOString(),
            },
            $inc: { version: 1 },
          },
          { writeConcern: durable },
        );
        await refreshThread({ ...job, outputs: content.outputs });
      }
      const acknowledged = await Job.find({
        ...scope,
        executionOwner: 'chat',
        phase: 'reconciling',
        'recoveryDecisions.request.action': 'acknowledge',
      })
        .sort({ jobId: 1 })
        .limit(input.limit)
        .lean<MediaStoredJob[]>();
      for (const job of acknowledged) {
        const decision = job.recoveryDecisions?.[job.recoveryDecisions.length - 1];
        if (decision?.request.action === 'acknowledge') {
          await failMediaNativeRecording({
            scope,
            jobId: job.jobId,
            reason: 'provider',
            resolutionId: decision.request.clientRequestId,
          });
        }
      }
      const cleanup = await Job.find({
        ...scope,
        executionOwner: 'chat',
        $or: [
          { nativeCleanupPending: true },
          { nativeRetentionState: 'purging' },
          {
            'nativeSource.expiresAt': { $lte: new Date(input.now).toISOString() },
            nativeRetentionState: { $ne: 'purged' },
          },
        ],
      })
        .select({ jobId: 1, threadId: 1, nativeSource: 1, nativeConsumers: 1 })
        .sort({ jobId: 1 })
        .limit(input.limit)
        .lean();
      for (const job of cleanup) {
        const sourceReleased =
          job.nativeConsumers !== undefined &&
          !job.nativeConsumers.includes(job.nativeSource?.conversationId ?? '');
        const expired = !!job.nativeSource?.expiresAt && job.nativeSource.expiresAt <= input.now;
        if (sourceReleased || expired) {
          await media.retireMediaThread(scope, job.threadId);
        }
        const purged = await media.purgeMediaThreadPayloads({ scope, threadId: job.threadId });
        if (purged || (!sourceReleased && !expired)) {
          await Job.updateOne(
            { ...scope, jobId: job.jobId, nativeConsumers: job.nativeConsumers },
            { $unset: { nativeCleanupPending: 1 } },
            { writeConcern: durable },
          );
        }
      }
      return jobs.length;
    };

  async function refreshThread(job: MediaStoredJob): Promise<void> {
    if (['succeeded', 'failed', 'cancelled'].includes(job.phase)) {
      await media.releaseMediaPermits({ scope: scopeFilter(job), jobId: job.jobId });
    }
    const pendingJobCount = await Job.countDocuments({
      ...scopeFilter(job),
      threadId: job.threadId,
      'receipt.phase': 'accepted',
      phase: { $nin: ['succeeded', 'failed', 'cancelled'] },
    });
    await Thread.updateOne(
      { ...scopeFilter(job), threadId: job.threadId },
      { $set: { pendingJobCount }, $inc: { version: 1 } },
    );
    const cover = job.outputs.find(
      (output) => output.kind !== 'text' && output.state === 'ready' && output.asset,
    );
    if (cover && cover.kind !== 'text' && cover.asset) {
      await Thread.updateOne(
        {
          ...scopeFilter(job),
          threadId: job.threadId,
          status: 'active',
          cover: { $exists: false },
          coverExplicit: { $ne: true },
        },
        { $set: { cover: cover.asset }, $inc: { version: 1 } },
      );
    }
  }

  const getMediaNativeContinuations: MediaNativeMethods['getMediaNativeContinuations'] = async (
    input,
  ) => {
    const scope = scopeFilter(input.scope);
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.references.length > input.limit
    ) {
      throw new MediaPersistenceError('invalid_input', 'Invalid native continuation batch');
    }
    if (!input.references.length) {
      return [];
    }
    const refs = [
      ...new Set(
        input.references.flatMap((entry) => (entry.continuationRef ? [entry.continuationRef] : [])),
      ),
    ];
    const fileIds = [
      ...new Set(
        input.references.flatMap((entry) =>
          !entry.continuationRef && entry.fileId ? [entry.fileId] : [],
        ),
      ),
    ];
    const now = new Date();
    const parts = await Part.find({
      ...scope,
      $and: [
        { $or: [{ continuationRef: { $in: refs } }, { fileId: { $in: fileIds } }] },
        { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] },
      ],
    }).lean();
    const jobs = await Job.find({
      ...scope,
      jobId: { $in: [...new Set(parts.map((part) => part.jobId))] },
      executionOwner: 'chat',
      'execution.api': input.execution.api,
      'execution.modelId': input.execution.modelId,
      'execution.bindingRevision': input.execution.bindingRevision,
      nativeRetentionState: { $nin: ['purging', 'purged'] },
      $or: [
        { 'nativeSource.expiresAt': { $exists: false } },
        { 'nativeSource.expiresAt': { $gt: now.toISOString() } },
      ],
    })
      .select({ jobId: 1, threadId: 1, phase: 1, nativeConsumers: 1, nativeSource: 1 })
      .lean();
    const activeJobs = new Map(jobs.map((job) => [job.jobId, job]));
    const candidates = jobs.filter((job) => !job.nativeConsumers?.length);
    const imageIds = [...new Set(parts.flatMap((part) => (part.fileId ? [part.fileId] : [])))];
    const [threads, files] = await Promise.all([
      candidates.length
        ? Thread.find({
            ...scope,
            threadId: { $in: candidates.map((job) => job.threadId) },
            status: 'active',
          })
            .select({ threadId: 1 })
            .lean()
        : [],
      imageIds.length
        ? File.find({
            user: scope.ownerId,
            tenantId: scope.tenantId,
            file_id: { $in: imageIds },
            mediaLifecycle: 'live',
            $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: now } }],
          })
            .select({ file_id: 1 })
            .lean()
        : [],
    ]);
    const liveThreads = new Set(threads.map((thread) => thread.threadId));
    const liveFiles = new Set(files.map((file) => file.file_id));
    const byRef = new Map<string, MediaNativePartRecord>();
    const byFile = new Map<string, MediaNativePartRecord>();
    for (const part of parts) {
      const job = activeJobs.get(part.jobId);
      if (!job || (part.fileId && !liveFiles.has(part.fileId))) {
        continue;
      }
      const consumers = job.nativeConsumers ?? [];
      if (
        input.conversationId
          ? !consumers.includes(input.conversationId)
          : !consumers.length && !liveThreads.has(job.threadId)
      ) {
        continue;
      }
      const { expiresAt, createdAt, ...stored } = part;
      const record = {
        ...stored,
        createdAt: createdAt.toISOString(),
        ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      };
      byRef.set(part.continuationRef, record);
      if (part.fileId) {
        byFile.set(part.fileId, record);
      }
    }
    return input.references.map((reference) => {
      const byFileId = reference.fileId ? byFile.get(reference.fileId) : undefined;
      const record = reference.continuationRef ? byRef.get(reference.continuationRef) : byFileId;
      return record && (!reference.fileId || reference.fileId === record.fileId) ? record : null;
    });
  };

  const retainMediaNativeConversation: MediaNativeMethods['retainMediaNativeConversation'] = async (
    input,
  ) => {
    const scope = scopeFilter(input.scope);
    if (
      !input.conversationId ||
      !Number.isSafeInteger(input.maxRetainers) ||
      input.maxRetainers <= 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.continuationRefs.length > input.limit ||
      (input.pendingUntil !== undefined && !(Date.parse(input.pendingUntil) > Date.now()))
    ) {
      throw new MediaPersistenceError('invalid_input', 'Invalid native conversation consumer');
    }
    const references = [...new Set(input.continuationRefs)];
    const now = new Date();
    const parts = await Part.find({
      ...scope,
      continuationRef: { $in: references },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
    })
      .select({ jobId: 1, continuationRef: 1 })
      .lean();
    if (parts.length !== references.length) {
      return false;
    }
    for (const jobId of new Set(parts.map((part) => part.jobId))) {
      const job = await media.getMediaJob(scope, jobId);
      if (!job || !job.nativeConsumers) {
        return false;
      }
      const result = await Job.updateOne(
        {
          ...scope,
          jobId,
          executionOwner: 'chat',
          nativeRetentionState: { $nin: ['purging', 'purged'] },
          ...(input.pendingUntil
            ? { nativeConsumerClaims: job.nativeConsumerClaims ?? { $exists: false } }
            : {}),
          $and: [
            {
              $or: [
                { 'nativeSource.expiresAt': { $exists: false } },
                { 'nativeSource.expiresAt': { $gt: now.toISOString() } },
              ],
            },
            {
              $or: [
                { nativeConsumers: input.conversationId },
                {
                  $expr: {
                    $lt: [
                      {
                        $size: '$nativeConsumers',
                      },
                      input.maxRetainers,
                    ],
                  },
                },
              ],
            },
          ],
        },
        {
          $addToSet: { nativeConsumers: input.conversationId },
          $set: {
            nativeRetentionState: 'live',
            ...(input.pendingUntil
              ? {
                  nativeConsumerClaims: [
                    ...(job.nativeConsumerClaims ?? []).filter(
                      (claim) => claim.conversationId !== input.conversationId,
                    ),
                    { conversationId: input.conversationId, expiresAt: input.pendingUntil },
                  ],
                }
              : {}),
          },
        },
        { writeConcern: durable },
      );
      if (!result.matchedCount) {
        return false;
      }
    }
    return true;
  };

  const releaseMediaNativeConversation: MediaNativeMethods['releaseMediaNativeConversation'] =
    async (input) => {
      const scope = scopeFilter(input.scope);
      if (!input.conversationId) {
        throw new MediaPersistenceError('invalid_input', 'Invalid native conversation consumer');
      }
      const jobs = await Job.find({
        ...scope,
        executionOwner: 'chat',
        $or: [
          { nativeConsumers: input.conversationId },
          {
            'nativeSource.conversationId': input.conversationId,
          },
        ],
      }).lean<MediaStoredJob[]>();
      for (const job of jobs) {
        await Job.updateOne(
          { ...scope, jobId: job.jobId },
          {
            $set: { nativeCleanupPending: true },
            $pull: {
              nativeConsumers: input.conversationId,
              nativeConsumerClaims: { conversationId: input.conversationId },
            },
          },
          { writeConcern: durable },
        );
        if (job.nativeSource?.conversationId === input.conversationId) {
          await media.retireMediaThread(scope, job.threadId);
        }
        await media.purgeMediaThreadPayloads({ scope, threadId: job.threadId });
      }
    };

  const confirmMediaNativeConversation: MediaNativeMethods['confirmMediaNativeConversation'] =
    async (input) => {
      const scope = scopeFilter(input.scope);
      await Job.updateMany(
        { ...scope, executionOwner: 'chat', nativeConsumers: input.conversationId },
        { $pull: { nativeConsumerClaims: { conversationId: input.conversationId } } },
        { writeConcern: durable },
      );
    };

  const detachMediaNativeConversation: MediaNativeMethods['detachMediaNativeConversation'] = async (
    input,
  ) => {
    const scope = scopeFilter(input.scope);
    const references = new Set(input.continuationRefs);
    if (!references.size) return;
    const identity = {
      user: scope.ownerId,
      tenantId: scope.tenantId,
      conversationId: input.conversationId,
    };
    const rows = Message.find({
      ...identity,
      'content.native_media.continuationRef': { $in: [...references] },
    })
      .select({ content: 1 })
      .lean()
      .cursor();
    for await (const row of rows) {
      if (!Array.isArray(row.content)) continue;
      const content = row.content.map((part) =>
        part &&
        typeof part === 'object' &&
        getNativeContinuationRefs([part]).some((reference) => references.has(reference))
          ? detachNativeIdentity(part)
          : part,
      );
      const updated = await Message.updateOne(
        { ...identity, _id: row._id, content: row.content },
        { $set: { content } },
        { writeConcern: durable },
      );
      if (!updated.matchedCount)
        throw new MediaPersistenceError(
          'conflict',
          'The cloned conversation changed during native detachment',
        );
    }
  };

  async function reconcileNativeConsumers(
    scope: MediaOwnerScope,
    job: MediaStoredJob,
  ): Promise<void> {
    const current = await media.getMediaJob(scope, job.jobId);
    if (!current?.nativeConsumers || current.nativeRetentionState === 'purged') return;
    const now = new Date();
    const parts = await Part.find({ ...scope, jobId: job.jobId })
      .select({ continuationRef: 1 })
      .limit(job.nativeLimits?.maxParts ?? 1)
      .lean();
    const consumers = await Message.aggregate<{ conversationId: string }>([
      {
        $match: {
          user: scope.ownerId,
          tenantId: scope.tenantId,
          conversationId: { $in: current.nativeConsumers },
          'content.native_media.continuationRef': {
            $in: parts.map((part) => part.continuationRef),
          },
          $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }],
        },
      },
      { $group: { _id: '$conversationId' } },
      { $project: { _id: 0, conversationId: '$_id' } },
    ]);
    const live = new Set(consumers.map((consumer) => consumer.conversationId));
    const claims = (current.nativeConsumerClaims ?? []).filter(
      (claim) => claim.expiresAt > now.toISOString(),
    );
    for (const claim of claims) live.add(claim.conversationId);
    if (['queued', 'running'].includes(current.phase) && current.nativeSource)
      live.add(current.nativeSource.conversationId);
    const retained = current.nativeConsumers.filter((id) => live.has(id));
    const result = await Job.updateOne(
      {
        ...scope,
        jobId: current.jobId,
        nativeConsumers: current.nativeConsumers,
        nativeConsumerClaims: current.nativeConsumerClaims ?? { $exists: false },
      },
      {
        $set: {
          nativeConsumers: retained,
          nativeConsumerClaims: claims,
          nativeConsumersCheckedAt: now,
        },
      },
      { writeConcern: durable },
    );
    if (!result.matchedCount) return;
    if (current.nativeSource && !retained.includes(current.nativeSource.conversationId)) {
      await media.retireMediaThread(scope, current.threadId);
    }
    await media.purgeMediaThreadPayloads({ scope, threadId: current.threadId });
  }

  const reconcileMediaNativeMessageDeletion: MediaNativeMethods['reconcileMediaNativeMessageDeletion'] =
    async (input) => {
      const scope = scopeFilter(input.scope);
      const jobs = Job.find({
        ...scope,
        executionOwner: 'chat',
        $or: [
          { nativeConsumers: input.conversationId },
          { 'nativeSource.conversationId': input.conversationId },
        ],
      })
        .lean<MediaStoredJob>()
        .cursor();
      for await (const job of jobs) await reconcileNativeConsumers(scope, job);
    };

  const reconcileMediaNativeConsumers: MediaNativeMethods['reconcileMediaNativeConsumers'] = async (
    input,
  ) => {
    const scope = scopeFilter(input.scope);
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      !Number.isSafeInteger(input.maxRetainers) ||
      input.maxRetainers <= 0
    ) {
      throw new MediaPersistenceError(
        'invalid_input',
        'Invalid native consumer reconciliation bounds',
      );
    }
    const jobs = await Job.find({
      ...scope,
      executionOwner: 'chat',
      nativeSource: { $exists: true },
      nativeConsumers: { $exists: true },
      nativeRetentionState: { $ne: 'purged' },
      ...(input.threadId ? { threadId: input.threadId } : {}),
    })
      .sort({ nativeConsumersCheckedAt: 1, jobId: 1 })
      .limit(input.limit)
      .lean<MediaStoredJob[]>();
    for (const job of jobs) await reconcileNativeConsumers(scope, job);
    return jobs.length;
  };

  return {
    ensureMediaNativeIndexes,
    failMediaNativeRecording,
    getMediaNativeContinuations,
    retainMediaNativeConversation,
    confirmMediaNativeConversation,
    detachMediaNativeConversation,
    reconcileMediaNativeMessageDeletion,
    releaseMediaNativeConversation,
    reconcileMediaNativeConsumers,
    reconcileMediaNativeRecordings,
  };
}
