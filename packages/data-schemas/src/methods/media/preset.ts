import { randomUUID } from 'node:crypto';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { MediaAsset, MediaPreset, MediaPresetSettings } from 'librechat-data-provider';
import type { MediaPresetMethods, MediaStoredPreset } from '~/types/mediaPreset';
import type { MediaFileConsumerWrite } from '~/types/mediaConsumers';
import type { MediaMethods, MediaOwnerScope } from '~/types/media';
import {
  mediaScopeFilter as scopeFilter,
  positiveMediaLimit as positive,
  toMediaAsset,
} from '~/utils/media';
import { createMediaMethods, MediaPersistenceError } from './index';
import { createMediaFileConsumerMethods } from './consumers';
import { createMediaPresetModel } from '~/models/media';
import { createIndexesWithRetry } from '~/utils/retry';
import { createFileModel } from '~/models/file';
import { durable, duplicate } from './scope';

function presetView(preset: MediaStoredPreset, assets: MediaAsset[]): MediaPreset {
  return {
    schemaVersion: 1,
    presetId: preset.presetId,
    title: preset.title,
    isDefault: preset.isDefault,
    settings: preset.settings,
    assets,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

/** Saved Studio generation settings. One preset per owner may be the default. */
export function createMediaPresetMethods(
  mongoose: typeof import('mongoose'),
  deps: Pick<MediaMethods, 'assertMediaOwnerActive'> = createMediaMethods(mongoose),
): MediaPresetMethods {
  const Preset = createMediaPresetModel(mongoose);
  const File = createFileModel(mongoose);
  const consumers = createMediaFileConsumerMethods(mongoose);
  let indexPromise: Promise<void> | undefined;

  async function ensureMediaPresetIndexes(): Promise<void> {
    indexPromise ??= createIndexesWithRetry(Preset)
      .then(() => undefined)
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    await indexPromise;
  }

  async function clearOtherDefaults(
    owner: MediaOwnerScope,
    presetId: string,
    now: Date,
  ): Promise<void> {
    await Preset.updateMany(
      { ...owner, presetId: { $ne: presetId }, isDefault: true },
      { $set: { isDefault: false, updatedAt: now }, $inc: { version: 1 } },
      { writeConcern: durable },
    );
  }

  const fileIds = (settings: MediaPresetSettings) => [
    ...new Set((settings.inputs ?? []).map((input) => input.file_id)),
  ];

  function validateInputs(settings: MediaPresetSettings, maxInputs: number): void {
    if ((settings.inputs?.length ?? 0) > positive(maxInputs))
      throw new MediaPersistenceError('invalid_input', 'Media preset reference limit exceeded');
    if (settings.inputs?.some((input) => input.sourceURL))
      throw new MediaPersistenceError('invalid_input', 'Media presets require uploaded originals');
  }

  async function views(
    scope: MediaOwnerScope,
    presets: MediaStoredPreset[],
  ): Promise<MediaPreset[]> {
    const ids = [...new Set(presets.flatMap((preset) => fileIds(preset.settings)))];
    const files = ids.length
      ? await File.find({
          user: scope.ownerId,
          tenantId: scope.tenantId,
          file_id: { $in: ids },
          mediaOutputKey: { $exists: true },
          mediaLifecycle: 'live',
          $or: [{ mediaHardExpiresAt: null }, { mediaHardExpiresAt: { $gt: new Date() } }],
        }).lean()
      : [];
    const assets = new Map(files.map((file) => [file.file_id, toMediaAsset(file)]));
    return presets.map((preset) =>
      presetView(
        preset,
        fileIds(preset.settings).flatMap((id) => assets.get(id) ?? []),
      ),
    );
  }

  async function release(claim: MediaFileConsumerWrite): Promise<void> {
    if (claim.fileIds.length) await consumers.releaseMediaFileConsumerClaims(claim);
  }

  const listMediaPresets: MediaPresetMethods['listMediaPresets'] = async (scope) => {
    scope = scopeFilter(scope);
    const rows = await Preset.find(scope)
      .sort({ isDefault: -1, title: 1, presetId: 1 })
      .lean<MediaStoredPreset[]>();
    return views(scope, rows);
  };

  const createMediaPreset: MediaPresetMethods['createMediaPreset'] = async ({
    scope,
    presetId,
    write,
    maxPresets,
    maxInputs = resolveMediaConfig().limits.maxInputs,
    consumerConfig = resolveMediaConfig().limits,
  }) => {
    const owner = scopeFilter(scope);
    validateInputs(write.settings, maxInputs);
    await deps.assertMediaOwnerActive(owner);
    if ((await Preset.countDocuments(owner)) >= positive(maxPresets)) {
      throw new MediaPersistenceError('capacity', 'Media preset limit reached');
    }
    const now = new Date();
    const record: MediaStoredPreset = {
      ...owner,
      schemaVersion: 1,
      presetId,
      title: write.title,
      isDefault: write.isDefault === true,
      settings: structuredClone(write.settings),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const claim: MediaFileConsumerWrite = {
      scope: owner,
      presetId,
      fileIds: fileIds(record.settings),
      token: randomUUID(),
      config: consumerConfig,
    };
    const document = new Preset(record);
    let saved = false;
    try {
      if (claim.fileIds.length) await consumers.acquireMediaFileConsumers(claim);
      await document.save(durable);
      saved = true;
      await deps.assertMediaOwnerActive(owner);
      if (claim.fileIds.length) await consumers.confirmMediaFileConsumers(claim);
      if (write.isDefault === true) await clearOtherDefaults(owner, presetId, now);
      return (await views(owner, [record]))[0];
    } catch (error) {
      if (saved)
        await Preset.deleteOne(
          { ...owner, _id: document._id, version: record.version },
          { writeConcern: durable },
        );
      if (duplicate(error))
        throw new MediaPersistenceError('conflict', 'Media preset identity already exists');
      throw error;
    } finally {
      await release(claim);
    }
  };

  const updateMediaPreset: MediaPresetMethods['updateMediaPreset'] = async ({
    scope,
    presetId,
    update,
    maxInputs = resolveMediaConfig().limits.maxInputs,
    consumerConfig = resolveMediaConfig().limits,
  }) => {
    const owner = scopeFilter(scope);
    await deps.assertMediaOwnerActive(owner);
    const previous = await Preset.findOne({ ...owner, presetId }).lean<MediaStoredPreset | null>();
    if (!previous) return null;
    const settings = update.settings ?? previous.settings;
    validateInputs(settings, maxInputs);
    const claim: MediaFileConsumerWrite = {
      scope: owner,
      presetId,
      fileIds: fileIds(settings),
      token: randomUUID(),
      config: consumerConfig,
    };
    let saved: MediaStoredPreset | null = null;
    try {
      if (claim.fileIds.length) await consumers.acquireMediaFileConsumers(claim);
      saved = await Preset.findOneAndUpdate(
        { ...owner, presetId, version: previous.version },
        {
          $set: {
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.isDefault !== undefined ? { isDefault: update.isDefault } : {}),
            ...(update.settings !== undefined ? { settings: structuredClone(settings) } : {}),
          },
          $inc: { version: 1 },
        },
        { new: true, writeConcern: durable },
      ).lean<MediaStoredPreset | null>();
      if (!saved) throw new MediaPersistenceError('conflict', 'The media preset changed');
      await deps.assertMediaOwnerActive(owner);
      if (claim.fileIds.length) await consumers.confirmMediaFileConsumers(claim);
      if (update.isDefault === true) await clearOtherDefaults(owner, presetId, saved.updatedAt);
      return (await views(owner, [saved]))[0];
    } catch (error) {
      if (saved) {
        let ownerActive = true;
        try {
          await deps.assertMediaOwnerActive(owner);
        } catch (ownerError) {
          // A transient owner lookup failure must not erase the previously saved preset.
          ownerActive = !(
            ownerError instanceof MediaPersistenceError && ownerError.code === 'retired'
          );
        }
        const filter = { ...owner, presetId, version: saved.version };
        if (!ownerActive) await Preset.deleteOne(filter, { writeConcern: durable });
        else
          await Preset.updateOne(
            filter,
            {
              $set: {
                title: previous.title,
                settings: previous.settings,
                isDefault: previous.isDefault,
              },
              $inc: { version: 1 },
            },
            { writeConcern: durable },
          );
      }
      throw error;
    } finally {
      await release({
        ...claim,
        fileIds: [...new Set([...claim.fileIds, ...fileIds(previous.settings)])],
      });
    }
  };

  const deleteMediaPreset: MediaPresetMethods['deleteMediaPreset'] = async (
    scope,
    presetId,
    consumerConfig = resolveMediaConfig().limits,
  ) => {
    const owner = scopeFilter(scope);
    const removed = await Preset.findOneAndDelete(
      { ...owner, presetId },
      { writeConcern: durable },
    ).lean<MediaStoredPreset | null>();
    if (!removed) return false;
    await release({
      scope: owner,
      presetId,
      fileIds: fileIds(removed.settings),
      token: randomUUID(),
      config: consumerConfig,
    });
    return true;
  };

  return {
    ensureMediaPresetIndexes,
    listMediaPresets,
    createMediaPreset,
    updateMediaPreset,
    deleteMediaPreset,
  };
}
