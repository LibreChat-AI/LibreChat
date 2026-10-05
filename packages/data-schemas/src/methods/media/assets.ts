import { randomUUID } from 'crypto';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { MediaPersistenceContext } from './context';
import type { MediaMethods } from '~/types/media';
import {
  MediaPersistenceError,
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
  toMediaAsset,
} from '~/utils/media';
import { canonical, digest, duplicate, durable, mediaDate } from './scope';
import { messageFileReferenceFilter } from '~/utils/messageFiles';
import { MEDIA_FILE_ID_PREFIX } from '~/types/media';
import { assetContext } from './views';

export function createMediaAssetsMethods({
  File,
  ensureMediaIndexes,
  activateMedia,
  AssetWrite,
  assertOwnerActive,
  releaseOwnerWork,
  admitOwnerWork,
  mongoose,
  Thread,
}: Pick<
  MediaPersistenceContext,
  | 'File'
  | 'ensureMediaIndexes'
  | 'activateMedia'
  | 'AssetWrite'
  | 'assertOwnerActive'
  | 'releaseOwnerWork'
  | 'admitOwnerWork'
  | 'mongoose'
  | 'Thread'
>): Pick<
  MediaPersistenceContext,
  | 'getMediaAsset'
  | 'getAvailableMediaFileIds'
  | 'reserveMediaAssetWrite'
  | 'commitMediaAssetWrite'
  | 'recoverMediaAssetWrites'
  | 'listMediaAssetWritesForCleanup'
  | 'incrementMediaAssetWriteDeletionAttempts'
  | 'deferMediaAssetWriteCleanup'
  | 'claimMediaAssetWriteDeletion'
  | 'completeMediaAssetWriteDeletion'
  | 'retainMediaAsset'
  | 'getMediaAssetContent'
  | 'releaseMediaAsset'
  | 'claimMediaAssetDeletion'
  | 'completeMediaAssetDeletion'
  | 'getMediaSourceFile'
  | 'isMediaFile'
  | 'getPublishedMediaAsset'
  | 'retainMediaThreadAsset'
> {
  const getMediaAsset: MediaMethods['getMediaAsset'] = async (scope, fileId) => {
    scopeFilter(scope);
    const file = await File.findOne({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
      mediaLifecycle: 'live',
      $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }],
    }).lean();
    return file ? toMediaAsset(file) : null;
  };

  const getAvailableMediaFileIds: MediaMethods['getAvailableMediaFileIds'] = async ({
    scope,
    fileIds,
  }) => {
    scopeFilter(scope);
    if (!fileIds.length) return [];
    const rows = await File.find({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: { $in: [...new Set(fileIds)] },
      mediaOutputKey: { $exists: true },
      mediaLifecycle: 'live',
      $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }],
    })
      .select({ _id: 0, file_id: 1 })
      .lean();
    return rows.map((file) => file.file_id);
  };

  const reserveMediaAssetWrite: MediaMethods['reserveMediaAssetWrite'] = async (input) => {
    await ensureMediaIndexes();
    await activateMedia();
    const scope = scopeFilter(input.scope);
    const key = {
      ...scope,
      outputKey: input.outputKey,
      rendition: input.rendition,
      ingestToken: input.ingestToken,
    };
    let row = await AssetWrite.findOne(key).lean();
    if (!row) {
      await assertOwnerActive(scope);
      const now = new Date();
      try {
        row = (
          await new AssetWrite({
            ...key,
            writeId: randomUUID(),
            fileId: `${MEDIA_FILE_ID_PREFIX}${randomUUID().slice(9)}`,
            storageKey: input.storageKey,
            source: input.source,
            storageRegion: input.storageRegion,
            filepath: input.filepath,
            renditionLocations: input.renditionLocations,
            fingerprint: input.fingerprint,
            state: 'reserved',
            createdAt: now,
            updatedAt: now,
          }).save(durable)
        ).toObject();
      } catch (error) {
        if (!duplicate(error)) {
          throw error;
        }
        row = await AssetWrite.findOne(key).lean();
      }
    }
    if (
      !row ||
      row.fingerprint !== input.fingerprint ||
      row.storageKey !== input.storageKey ||
      (row.source ?? 'local') !== (input.source ?? 'local') ||
      row.storageRegion !== input.storageRegion ||
      canonical(
        (row.renditionLocations ?? []).map(({ filepath: _path, ...location }) => location),
      ) !==
        canonical(
          (input.renditionLocations ?? []).map(({ filepath: _path, ...location }) => location),
        )
    ) {
      throw new MediaPersistenceError('conflict', 'Media asset write identity changed');
    }
    return row;
  };

  const commitMediaAssetWrite: MediaMethods['commitMediaAssetWrite'] = async ({
    scope: inputScope,
    writeId,
    content: inputContent,
  }) => {
    const scope = scopeFilter(inputScope);
    let write = await AssetWrite.findOne({ ...scope, writeId }).lean();
    if (!write || write.state === 'deleted' || (write.state === 'abandoned' && !write.asset)) {
      throw new MediaPersistenceError('not_found', 'Media asset write not found');
    }
    if (
      inputContent.file_id !== write.fileId ||
      inputContent.storageKey !== write.storageKey ||
      inputContent.source !== (write.source ?? 'local') ||
      inputContent.storageRegion !== write.storageRegion
    ) {
      throw new MediaPersistenceError('conflict', 'Media asset staging identity changed');
    }
    for (const [kind, rendition] of Object.entries(inputContent.mediaRenditions ?? {})) {
      const location = write.renditionLocations?.find((item) => item.kind === kind);
      if (
        !location ||
        location.source !== rendition.source ||
        location.storageKey !== rendition.storageKey ||
        location.storageRegion !== rendition.storageRegion
      ) {
        throw new MediaPersistenceError('conflict', 'Media rendition staging identity changed');
      }
    }
    if (write.state === 'published' || write.state === 'abandoned') {
      const asset = write.asset && (await getMediaAssetContent(scope, write.asset.file_id));
      if (!asset) {
        throw new MediaPersistenceError('retired', 'Media output identity is retired');
      }
      if (asset.contentDigest !== inputContent.contentDigest) {
        throw new MediaPersistenceError(
          'conflict',
          'Media output bytes changed for a stable identity',
        );
      }
      await releaseOwnerWork(scope, `write:${writeId}`);
      return toMediaAsset(asset);
    }
    if (write.state === 'reserved') {
      if (!(await admitOwnerWork(scope, `write:${writeId}`))) {
        throw new MediaPersistenceError('retired', 'Media account is being deleted');
      }
      // Cleanup may only claim reserved receipts. Once this CAS wins, metadata is sufficient
      // for a replacement process to finish publication without repeating the upload.
      write = await AssetWrite.findOneAndUpdate(
        { ...scope, writeId, state: 'reserved' },
        {
          $set: {
            state: 'committing',
            publicationContent: structuredClone(inputContent),
          },
        },
        { new: true, writeConcern: durable },
      ).lean();
      if (!write) {
        const current = await AssetWrite.findOne({ ...scope, writeId }).lean();
        if (current && ['committing', 'published'].includes(current.state)) {
          return commitMediaAssetWrite({ scope, writeId, content: inputContent });
        }
        await releaseOwnerWork(scope, `write:${writeId}`);
        throw new MediaPersistenceError('retired', 'Media upload was retired before publication');
      }
    }
    const content = write.publicationContent;
    if (!content || content.contentDigest !== inputContent.contentDigest) {
      throw new MediaPersistenceError('conflict', 'Media publication content changed');
    }
    const identity = {
      user: scope.ownerId,
      tenantId: scope.tenantId,
      mediaOutputKey: write.outputKey,
      mediaRendition: write.rendition,
    };
    try {
      try {
        await File.updateOne(
          identity,
          {
            $setOnInsert: {
              ...identity,
              ...content,
              mediaRenditionLocations: write.renditionLocations,
              file_id: write.fileId,
              mediaLifecycle: 'live',
              mediaEpoch: 1,
              mediaRetainers: [],
              mediaContentDigest: content.contentDigest,
              context: assetContext(write.outputKey, content.type),
              ...(content.hardExpiresAt
                ? { mediaHardExpiresAt: new Date(mediaDate(content.hardExpiresAt)) }
                : {}),
            },
          },
          { upsert: true, writeConcern: durable },
        );
      } catch (error) {
        if (!duplicate(error)) {
          throw error;
        }
      }
      const file = await File.findOne(identity).lean();
      if (
        !file ||
        file.mediaLifecycle !== 'live' ||
        (file.mediaHardExpiresAt && file.mediaHardExpiresAt <= new Date())
      ) {
        throw new MediaPersistenceError('retired', 'Media output identity is retired');
      }
      if (file.mediaContentDigest !== content.contentDigest) {
        throw new MediaPersistenceError(
          'conflict',
          'Media output bytes changed for a stable identity',
        );
      }
      const asset = toMediaAsset(file);
      await AssetWrite.updateOne(
        { ...scope, writeId, state: 'committing' },
        {
          $set: {
            state: file.file_id === write.fileId ? 'published' : 'abandoned',
            asset,
          },
          $unset: { publicationContent: 1 },
        },
        { writeConcern: durable },
      );
      await releaseOwnerWork(scope, `write:${writeId}`);
      return asset;
    } catch (error) {
      if (error instanceof MediaPersistenceError) {
        await AssetWrite.updateOne(
          { ...scope, writeId, state: 'committing' },
          {
            $set: { state: 'abandoned' },
            $unset: { publicationContent: 1 },
          },
          { writeConcern: durable },
        );
        await releaseOwnerWork(scope, `write:${writeId}`);
      }
      throw error;
    }
  };

  const recoverMediaAssetWrites: MediaMethods['recoverMediaAssetWrites'] = async ({
    scope,
    limit,
  }) => {
    const writes = await AssetWrite.find({
      ...scopeFilter(scope),
      state: 'committing',
      publicationContent: { $exists: true },
    })
      .sort({ writeId: 1 })
      .limit(positive(limit))
      .lean();
    for (const write of writes) {
      try {
        await commitMediaAssetWrite({
          scope,
          writeId: write.writeId,
          content: write.publicationContent!,
        });
      } catch (error) {
        if (!(error instanceof MediaPersistenceError)) {
          throw error;
        }
      }
    }
    return writes.length;
  };

  const listMediaAssetWritesForCleanup: MediaMethods['listMediaAssetWritesForCleanup'] = async ({
    scope,
    limit,
    staleBefore,
    now = new Date().toISOString(),
  }) =>
    AssetWrite.find({
      ...scopeFilter(scope),
      $and: [{ $or: [{ deletionRetryAt: null }, { deletionRetryAt: { $lte: mediaDate(now) } }] }],
      $or: [
        { state: 'abandoned' },
        { state: 'reserved', updatedAt: { $lte: mediaDate(staleBefore) } },
      ],
    })
      .sort({ updatedAt: 1, writeId: 1 })
      .limit(positive(limit))
      .lean();

  const incrementMediaAssetWriteDeletionAttempts: MediaMethods['incrementMediaAssetWriteDeletionAttempts'] =
    async ({ scope, writeId }) => {
      const write = await AssetWrite.findOneAndUpdate(
        { ...scopeFilter(scope), writeId, state: { $in: ['reserved', 'abandoned'] } },
        { $inc: { deletionAttempts: 1 } },
        { new: true, writeConcern: durable },
      )
        .select({ deletionAttempts: 1 })
        .lean();
      return write?.deletionAttempts ?? 0;
    };

  const deferMediaAssetWriteCleanup: MediaMethods['deferMediaAssetWriteCleanup'] = async ({
    scope,
    writeId,
    retryAt,
  }) => {
    await AssetWrite.updateOne(
      { ...scopeFilter(scope), writeId, state: { $in: ['reserved', 'abandoned'] } },
      { $max: { deletionRetryAt: mediaDate(retryAt) } },
      { writeConcern: durable },
    );
  };

  const claimMediaAssetWriteDeletion: MediaMethods['claimMediaAssetWriteDeletion'] = async ({
    scope,
    writeId,
    token,
    staleBefore,
  }) => {
    const write = await AssetWrite.findOneAndUpdate(
      {
        ...scopeFilter(scope),
        writeId,
        $or: [
          { state: { $in: ['abandoned', 'deleted'] } },
          { state: 'reserved', updatedAt: { $lte: mediaDate(staleBefore) } },
        ],
      },
      {
        $set: { state: 'abandoned', deletionToken: token },
        $unset: { publicationContent: 1 },
      },
      { new: true, writeConcern: durable },
    ).lean();
    if (!write) {
      return null;
    }
    await releaseOwnerWork(scope, `write:${writeId}`);
    // A receipt associated with any canonical File can never authorize byte cleanup.
    // Unique staging keys and the reserved/committing CAS exclude a late winning insert.
    if (
      await File.exists({
        user: scope.ownerId,
        tenantId: scope.tenantId,
        storageKey: write.storageKey,
        source: write.source ?? 'local',
        mediaOutputKey: { $exists: true },
      })
    ) {
      return null;
    }
    return {
      writeId,
      fileId: write.fileId,
      storageKey: write.storageKey,
      token,
      source: write.source,
      storageRegion: write.storageRegion,
      filepath: write.filepath,
      renditionLocations: write.renditionLocations,
    };
  };

  const completeMediaAssetWriteDeletion: MediaMethods['completeMediaAssetWriteDeletion'] = async ({
    scope,
    writeId,
    token,
  }) => {
    const result = await AssetWrite.updateOne(
      { ...scopeFilter(scope), writeId, state: 'abandoned', deletionToken: token },
      { $set: { state: 'deleted' }, $unset: { asset: 1 } },
      { writeConcern: durable },
    );
    return result.matchedCount > 0;
  };

  const retainMediaAsset: MediaMethods['retainMediaAsset'] = async ({
    scope,
    fileId,
    retainer,
    maxRetainers,
  }) => {
    scopeFilter(scope);
    positive(maxRetainers);
    const retainable = {
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
      mediaLifecycle: 'live',
      $and: [
        {
          $or: [
            { mediaRetainers: retainer },
            { $expr: { $lt: [{ $size: { $ifNull: ['$mediaRetainers', []] } }, maxRetainers] } },
          ],
        },
        { $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }] },
      ],
    };
    // The hard deadline is immutable, so reading it ahead of the fenced write is safe.
    const file = await File.findOne(retainable).select({ mediaHardExpiresAt: 1 }).lean();
    if (!file) {
      return false;
    }
    const result = await File.updateOne(
      retainable,
      {
        $addToSet: { mediaRetainers: retainer },
        ...(file.mediaHardExpiresAt ? { $set: { expiredAt: file.mediaHardExpiresAt } } : {}),
        $unset: { expiresAt: 1, ...(file.mediaHardExpiresAt ? {} : { expiredAt: 1 }) },
      },
      { writeConcern: durable },
    );
    return result.matchedCount > 0;
  };

  const getMediaAssetContent: MediaMethods['getMediaAssetContent'] = async (scope, fileId) => {
    scopeFilter(scope);
    const file = await File.findOne({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
      mediaLifecycle: 'live',
      $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }],
    }).lean();
    return file
      ? {
          ...toMediaAsset(file),
          filepath: file.filepath,
          mediaRenditions: file.mediaRenditions,
          mediaRenditionLocations: file.mediaRenditionLocations,
          source: file.source,
          storageKey: file.storageKey,
          storageRegion: file.storageRegion,
          contentDigest: file.mediaContentDigest!,
          expiredAt: file.expiredAt?.toISOString() ?? null,
          hardExpiresAt: file.mediaHardExpiresAt?.toISOString() ?? null,
        }
      : null;
  };

  const releaseMediaAsset: MediaMethods['releaseMediaAsset'] = async ({
    scope,
    fileId,
    retainer,
  }) => {
    scopeFilter(scope);
    const result = await File.updateOne(
      { user: scope.ownerId, tenantId: scope.tenantId, file_id: fileId, mediaLifecycle: 'live' },
      { $pull: { mediaRetainers: retainer } },
      { writeConcern: durable },
    );
    await File.updateOne(
      {
        user: scope.ownerId,
        tenantId: scope.tenantId,
        file_id: fileId,
        mediaLifecycle: 'live',
        mediaRetainers: { $size: 0 },
      },
      { $set: { expiredAt: new Date() } },
      { writeConcern: durable },
    );
    return result.matchedCount > 0;
  };

  const claimMediaAssetDeletion: MediaMethods['claimMediaAssetDeletion'] = async ({
    scope,
    fileId,
    token,
  }) => {
    scopeFilter(scope);
    const candidate = await File.findOne({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
    })
      .select({ mediaLifecycle: 1, mediaHardExpiresAt: 1 })
      .lean();
    if (
      candidate?.mediaLifecycle === 'live' &&
      (!candidate.mediaHardExpiresAt || candidate.mediaHardExpiresAt > new Date()) &&
      mongoose.models.Message &&
      (await mongoose.models.Message.exists({
        user: scope.ownerId,
        tenantId: scope.tenantId,
        $and: [
          messageFileReferenceFilter(fileId),
          { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
        ],
      }))
    ) {
      // Legacy saved attachments predate consumer registration. Keep the soft deadline for later collection.
      await File.updateOne(
        { user: scope.ownerId, tenantId: scope.tenantId, file_id: fileId, mediaLifecycle: 'live' },
        {
          $set: {
            deletionRetryAt: new Date(Date.now() + resolveMediaConfig().limits.consumerReconcileMs),
          },
        },
      );
      return null;
    }
    const file = await File.findOneAndUpdate(
      {
        user: scope.ownerId,
        tenantId: scope.tenantId,
        file_id: fileId,
        $or: [
          {
            mediaLifecycle: 'live',
            mediaRetainers: { $size: 0 },
            $or: [{ mediaUseUntil: null }, { mediaUseUntil: { $lte: new Date() } }],
          },
          { mediaLifecycle: 'live', mediaHardExpiresAt: { $ne: null, $lte: new Date() } },
          { mediaLifecycle: 'retiring' },
        ],
      },
      { $set: { mediaLifecycle: 'retiring', mediaDeletionToken: token }, $inc: { mediaEpoch: 1 } },
      { new: true, writeConcern: durable },
    ).lean();
    return file
      ? {
          ...toMediaAsset(file),
          filepath: file.filepath,
          mediaRenditions: file.mediaRenditions,
          mediaRenditionLocations: file.mediaRenditionLocations,
          source: file.source,
          storageKey: file.storageKey,
          storageRegion: file.storageRegion,
          contentDigest: file.mediaContentDigest!,
          expiredAt: file.expiredAt?.toISOString() ?? null,
          hardExpiresAt: file.mediaHardExpiresAt?.toISOString() ?? null,
        }
      : null;
  };

  const completeMediaAssetDeletion: MediaMethods['completeMediaAssetDeletion'] = async ({
    scope,
    fileId,
    token,
  }) => {
    scopeFilter(scope);
    const result = await File.updateOne(
      {
        user: scope.ownerId,
        tenantId: scope.tenantId,
        file_id: fileId,
        mediaLifecycle: 'retiring',
        mediaDeletionToken: token,
      },
      { $set: { mediaLifecycle: 'retired' } },
      { writeConcern: durable },
    );
    return result.matchedCount > 0;
  };

  const getMediaSourceFile: MediaMethods['getMediaSourceFile'] = async (scope, fileId) => {
    scopeFilter(scope);
    const file = await File.findOne({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
      $and: [
        { $or: [{ mediaLifecycle: { $exists: false } }, { mediaLifecycle: 'live' }] },
        { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
      ],
    }).lean();
    if (!file) {
      return null;
    }
    return {
      ...toMediaAsset(file),
      filepath: file.filepath,
      mediaRenditions: file.mediaRenditions,
      mediaRenditionLocations: file.mediaRenditionLocations,
      source: file.source,
      storageKey: file.storageKey,
      storageRegion: file.storageRegion,
      expiredAt: file.expiredAt?.toISOString() ?? null,
      hardExpiresAt: file.mediaHardExpiresAt?.toISOString() ?? null,
      sourceRevision: digest([
        String(file._id),
        file.updatedAt?.toISOString(),
        file.storageKey,
        file.filepath,
        file.bytes,
      ]),
    };
  };

  const isMediaFile: MediaMethods['isMediaFile'] = async (scope, fileId) => {
    scopeFilter(scope);
    return !!(await File.exists({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
      mediaOutputKey: { $exists: true },
    }));
  };

  const getPublishedMediaAsset: MediaMethods['getPublishedMediaAsset'] = async ({
    scope,
    outputKey,
    rendition,
  }) => {
    scopeFilter(scope);
    const file = await File.findOne({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      mediaOutputKey: outputKey,
      mediaRendition: rendition,
      mediaLifecycle: 'live',
      $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }],
    }).lean();
    if (!file) {
      return null;
    }
    const asset = toMediaAsset(file);
    // The canonical File is the publication fact when acknowledgement of the write receipt was lost.
    const write = await AssetWrite.findOneAndUpdate(
      {
        ...scopeFilter(scope),
        outputKey,
        rendition,
        fileId: file.file_id,
        state: { $in: ['reserved', 'committing'] },
      },
      {
        $set: { state: 'published', asset },
        $unset: { publicationContent: 1 },
      },
      { new: true, writeConcern: durable },
    ).lean();
    if (write) {
      await releaseOwnerWork(scope, `write:${write.writeId}`);
    }
    return asset;
  };

  const retainMediaThreadAsset: MediaMethods['retainMediaThreadAsset'] = async ({
    scope,
    threadId,
    fileId,
    maxRetainers,
  }) => {
    const thread = await Thread.findOne({
      ...scopeFilter(scope),
      threadId,
      status: 'active',
    }).lean();
    if (!thread) {
      return false;
    }
    const retainer = `thread:${threadId}:${thread.epoch}`;
    if (!(await retainMediaAsset({ scope, fileId, retainer, maxRetainers }))) {
      return false;
    }
    if (
      await Thread.exists({
        ...scopeFilter(scope),
        threadId,
        status: 'active',
        epoch: thread.epoch,
      })
    ) {
      return true;
    }
    // Retirement won after the File CAS. Compensation is repeatable and cannot publish content.
    await releaseMediaAsset({ scope, fileId, retainer });
    return false;
  };
  return {
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
  };
}
