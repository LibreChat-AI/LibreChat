import { resolveMediaConfig } from 'librechat-data-provider';
import type { FilterQuery } from 'mongoose';
import type { MediaConsumerClaim, MediaFileConsumerMethods } from '~/types/mediaConsumers';
import type { MediaOwnerScope } from '~/types/media';
import type { IMongoFile } from '~/types/file';
import { createMediaOwnerModel, createMediaPresetModel } from '~/models/media';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { messageFileReferenceFilter } from '~/utils/messageFiles';
import { createMessageModel } from '~/models/message';
import { MediaPersistenceError } from './index';
import { createFileModel } from '~/models/file';
import { isMediaFileId } from '~/types/media';

const durable = { w: 'majority' as const, j: true };
const prefix = 'conversation:';
const presetPrefix = 'preset:';

function consumerRetainer(target: Pick<MediaConsumerClaim, 'conversationId' | 'presetId'>) {
  return target.presetId
    ? `${presetPrefix}${target.presetId}`
    : `${prefix}${target.conversationId}`;
}

function fileScope(scope: MediaOwnerScope) {
  const tenant = tenantStorage.getStore()?.tenantId;
  if (
    !scope.ownerId ||
    scope.tenantId === SYSTEM_TENANT_ID ||
    scope.tenantId === '' ||
    (tenant && tenant !== SYSTEM_TENANT_ID && tenant !== scope.tenantId)
  )
    throw new MediaPersistenceError('not_found', 'Media owner scope is unavailable');
  return { user: scope.ownerId, tenantId: scope.tenantId ?? null };
}

/** File mutations arbitrate with retirement; persisted Message and Preset references establish liveness. */
export function createMediaFileConsumerMethods(
  mongoose: typeof import('mongoose'),
): MediaFileConsumerMethods {
  const File = createFileModel(mongoose);
  const Message = createMessageModel(mongoose);
  const Owner = createMediaOwnerModel(mongoose);
  const Preset = createMediaPresetModel(mongoose);

  async function reconcileFile(scope: MediaOwnerScope, fileId: string, now: Date, retryMs: number) {
    const identity = { ...fileScope(scope), file_id: fileId, mediaLifecycle: 'live' };
    const file = await File.findOne(identity).lean();
    if (!file) return;
    const claims = (file.mediaConsumerClaims ?? []).filter((claim) => claim.expiresAt > now);
    const conversations = (file.mediaRetainers ?? [])
      .filter((retainer) => retainer.startsWith(prefix))
      .map((retainer) => retainer.slice(prefix.length));
    const presets = (file.mediaRetainers ?? [])
      .filter((retainer) => retainer.startsWith(presetPrefix))
      .map((retainer) => retainer.slice(presetPrefix.length));
    const live = new Set<string>(claims.map(consumerRetainer));
    const [conversationRefs, presetRefs] = await Promise.all([
      conversations.length
        ? Message.distinct('conversationId', {
            user: scope.ownerId,
            tenantId: scope.tenantId ?? null,
            conversationId: { $in: conversations },
            $and: [
              { $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }] },
              messageFileReferenceFilter(fileId),
            ],
          })
        : [],
      presets.length
        ? Preset.distinct('presetId', {
            ownerId: scope.ownerId,
            tenantId: scope.tenantId ?? null,
            presetId: { $in: presets },
            'settings.inputs.file_id': fileId,
          })
        : [],
    ]);
    for (const id of conversationRefs) live.add(`${prefix}${id}`);
    for (const id of presetRefs) live.add(`${presetPrefix}${id}`);
    const retainers = (file.mediaRetainers ?? []).filter(
      (retainer) =>
        (!retainer.startsWith(prefix) && !retainer.startsWith(presetPrefix)) || live.has(retainer),
    );
    const deadline = retainers.length ? file.mediaHardExpiresAt : now;
    await File.updateOne(
      {
        ...identity,
        mediaConsumerRevision: file.mediaConsumerRevision ?? null,
        mediaRetainers: file.mediaRetainers ?? null,
      },
      {
        $set: {
          mediaRetainers: retainers,
          mediaConsumerClaims: claims,
          mediaConsumerReconcileAt: new Date(now.getTime() + retryMs),
          ...(deadline ? { expiredAt: deadline } : {}),
        },
        ...(!deadline ? { $unset: { expiredAt: 1 } } : {}),
        $inc: { mediaConsumerRevision: 1 },
      },
      { writeConcern: durable },
    );
  }

  const releaseMediaFileConsumerClaims: MediaFileConsumerMethods['releaseMediaFileConsumerClaims'] =
    async (input) => {
      for (const fileId of input.fileIds) {
        await File.updateOne(
          { ...fileScope(input.scope), file_id: fileId, mediaLifecycle: 'live' },
          {
            $pull: { mediaConsumerClaims: { token: input.token } },
            $inc: { mediaConsumerRevision: 1 },
          },
          { writeConcern: durable },
        );
        await reconcileFile(input.scope, fileId, new Date(), input.config.consumerReconcileMs);
      }
    };

  const acquireMediaFileConsumers: MediaFileConsumerMethods['acquireMediaFileConsumers'] = async (
    input,
  ) => {
    const { scope, token, config } = input;
    const target =
      input.presetId !== undefined
        ? { presetId: input.presetId }
        : { conversationId: input.conversationId };
    const identity = fileScope(scope);
    if (
      !(input.presetId || input.conversationId) ||
      (input.presetId && input.conversationId) ||
      !token ||
      config.maxAssetRetainers < 1 ||
      config.consumerClaimMs < 1
    ) {
      throw new MediaPersistenceError(
        'invalid_input',
        'A media consumer requires a bounded identity',
      );
    }
    if (
      await Owner.exists({
        ownerId: scope.ownerId,
        tenantId: scope.tenantId ?? null,
        status: { $ne: 'active' },
      })
    ) {
      throw new MediaPersistenceError('conflict', 'The media owner is being deleted');
    }
    const fileIds = [...new Set(input.fileIds)];
    if (fileIds.some((id) => !isMediaFileId(id))) {
      throw new MediaPersistenceError(
        'invalid_input',
        'Only media originals accept durable consumers',
      );
    }
    try {
      for (const fileId of fileIds) {
        const retainer = consumerRetainer(input);
        const file = await File.findOne({ ...identity, file_id: fileId, mediaLifecycle: 'live' })
          .select({ mediaHardExpiresAt: 1 })
          .lean();
        if (!file)
          throw new MediaPersistenceError('retired', 'The attached media original is unavailable');
        const now = new Date();
        const claim = {
          token,
          ...target,
          expiresAt: new Date(now.getTime() + config.consumerClaimMs),
        };
        const filter: FilterQuery<IMongoFile> = {
          ...identity,
          file_id: fileId,
          mediaLifecycle: 'live',
          $and: [
            { $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: now } }] },
            {
              $or: [
                { mediaRetainers: retainer },
                {
                  $expr: {
                    $lt: [
                      { $size: { $ifNull: ['$mediaRetainers', []] } },
                      config.maxAssetRetainers,
                    ],
                  },
                },
              ],
            },
            {
              $or: [
                { 'mediaConsumerClaims.token': token },
                {
                  $expr: {
                    $lt: [
                      { $size: { $ifNull: ['$mediaConsumerClaims', []] } },
                      config.maxAssetRetainers,
                    ],
                  },
                },
              ],
            },
          ],
        };
        // Revalidation refreshes only this writer's claim, never a concurrent writer's hold.
        await File.updateOne(
          { ...identity, file_id: fileId, mediaLifecycle: 'live' },
          { $pull: { mediaConsumerClaims: { token } }, $inc: { mediaConsumerRevision: 1 } },
          { writeConcern: durable },
        );
        const acquired = await File.updateOne(
          filter,
          {
            $addToSet: { mediaRetainers: retainer },
            $push: { mediaConsumerClaims: claim },
            $inc: { mediaConsumerRevision: 1 },
            $set: {
              mediaConsumerReconcileAt: now,
              ...(file.mediaHardExpiresAt ? { expiredAt: file.mediaHardExpiresAt } : {}),
            },
            $unset: { expiresAt: 1, ...(file.mediaHardExpiresAt ? {} : { expiredAt: 1 }) },
          },
          { writeConcern: durable },
        );
        if (!acquired.matchedCount) {
          throw new MediaPersistenceError(
            'capacity',
            'The attached media original is unavailable or its consumer limit is full',
          );
        }
      }
    } catch (error) {
      await releaseMediaFileConsumerClaims({ ...input, fileIds });
      throw error;
    }
  };

  const confirmMediaFileConsumers: MediaFileConsumerMethods['confirmMediaFileConsumers'] = async (
    input,
  ) => {
    // An arbitrarily delayed DB write must win the live-file fence again before acknowledgement.
    await acquireMediaFileConsumers(input);
    await releaseMediaFileConsumerClaims(input);
  };

  const reconcileMediaFileConsumers: MediaFileConsumerMethods['reconcileMediaFileConsumers'] =
    async ({
      scope,
      limit,
      cursor,
      conversationId,
      presetId,
      now = new Date().toISOString(),
      retryMs = resolveMediaConfig().limits.consumerReconcileMs,
    }) => {
      if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(retryMs) || retryMs <= 0) {
        throw new MediaPersistenceError('invalid_input', 'Consumer reconciliation must be bounded');
      }
      const at = new Date(now);
      let retainer: string | undefined;
      if (presetId) retainer = `${presetPrefix}${presetId}`;
      else if (conversationId) retainer = `${prefix}${conversationId}`;
      const files = await File.find({
        ...fileScope(scope),
        mediaLifecycle: 'live',
        ...(retainer ? { mediaRetainers: retainer } : { mediaConsumerReconcileAt: { $lte: at } }),
        ...(cursor ? { file_id: { $gt: cursor } } : {}),
      })
        .select({ file_id: 1 })
        .sort({ file_id: 1 })
        .limit(limit + 1)
        .lean();
      const page = files.slice(0, limit);
      for (const file of page) await reconcileFile(scope, file.file_id, at, retryMs);
      return {
        inspected: page.length,
        ...(files.length > limit ? { nextCursor: page[page.length - 1].file_id } : {}),
      };
    };
  return {
    acquireMediaFileConsumers,
    confirmMediaFileConsumers,
    releaseMediaFileConsumerClaims,
    reconcileMediaFileConsumers,
  };
}
