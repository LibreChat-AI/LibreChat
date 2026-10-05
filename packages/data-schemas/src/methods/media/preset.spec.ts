import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  mediaPresetSchema,
  mediaPresetWriteSchema,
  mediaPresetSettingsSchema,
} from 'librechat-data-provider';
import type { MediaPresetWriteInput } from 'librechat-data-provider';
import type { MediaMethods, MediaOwnerScope } from '~/types/media';
import type { MediaPresetMethods } from '~/types/mediaPreset';
import type { MediaStoredPreset } from '~/types/mediaPreset';
import type { IMongoFile } from '~/types/file';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createMediaFileConsumerMethods } from './consumers';
import { createMediaPresetMethods } from './preset';
import { createMediaMethods } from './index';
import { createMethods } from '../index';
import { createModels } from '~/models';

describe('media presets on standalone MongoDB', () => {
  let mongo: MongoMemoryServer;
  let media: MediaMethods;
  let presets: MediaPresetMethods;
  let scope: MediaOwnerScope;
  let assetSequence = 0;
  const consumerConfig = {
    maxAssetRetainers: 8,
    consumerClaimMs: 60_000,
    consumerReconcileMs: 1_000,
  };
  const settings = mediaPresetSettingsSchema.parse({
    operation: 'image.generate',
    connectionId: 'images',
    modelId: 'model-a',
    parameters: { quality: 'high' },
  });
  const write = (title: string, extra: Partial<MediaPresetWriteInput> = {}) =>
    mediaPresetWriteSchema.parse({ title, settings, ...extra });
  const create = (presetId: string, title: string, extra?: Partial<MediaPresetWriteInput>) =>
    presets.createMediaPreset({
      scope,
      presetId,
      write: write(title, extra),
      maxPresets: 5,
      consumerConfig,
    });
  const ids = async (owner = scope) =>
    (await presets.listMediaPresets(owner)).map((preset) => [preset.presetId, preset.isDefault]);

  async function asset(extra: Partial<IMongoFile> = {}) {
    const fileId = `f17ecafe-0000-4000-8000-${String(++assetSequence).padStart(12, '0')}`;
    await mongoose.models.File.create({
      user: scope.ownerId,
      file_id: fileId,
      bytes: 8,
      filename: 'reference.png',
      filepath: '/images/reference.png',
      source: 'local',
      type: 'image/png',
      mediaOutputKey: fileId,
      mediaContentDigest: 'digest',
      mediaRendition: 'original',
      mediaLifecycle: 'live',
      mediaRetainers: ['thread:original:1'],
      ...extra,
    });
    return fileId;
  }
  const file = (fileId: string) =>
    mongoose.models.File.findOne({ file_id: fileId }).lean<IMongoFile | null>();
  const withInputs = (...fileIds: string[]) => ({
    settings: {
      ...settings,
      inputs: fileIds.map((file_id) => ({ file_id, role: 'reference' as const })),
    },
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    media = createMediaMethods(mongoose, { ownerExists: async () => true });
    presets = createMediaPresetMethods(mongoose, media);
    await media.ensureMediaIndexes();
    await presets.ensureMediaPresetIndexes();
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    assetSequence = 0;
  });

  it('creates, lists, updates and deletes presets while keeping one default per owner', async () => {
    const first = await create('p1', 'Bright', { isDefault: true });
    expect(mediaPresetSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({ presetId: 'p1', title: 'Bright', isDefault: true, settings });
    expect(first).not.toHaveProperty('ownerId');
    await create('p2', 'Alpha', { isDefault: true });
    expect(await ids()).toEqual([
      ['p2', true],
      ['p1', false],
    ]);
    const third = await create('p3', 'Zed');
    expect(third.isDefault).toBe(false);
    expect(await ids()).toEqual([
      ['p2', true],
      ['p1', false],
      ['p3', false],
    ]);

    const updated = await presets.updateMediaPreset({
      scope,
      presetId: 'p3',
      update: { title: 'Aardvark', isDefault: true },
    });
    expect(updated).toMatchObject({ presetId: 'p3', title: 'Aardvark', isDefault: true });
    expect(updated!.updatedAt >= third.updatedAt).toBe(true);
    expect(updated!.createdAt).toBe(third.createdAt);
    expect(await ids()).toEqual([
      ['p3', true],
      ['p2', false],
      ['p1', false],
    ]);
    expect(await mongoose.models.MediaPreset.findOne({ presetId: 'p3' }).lean()).toMatchObject({
      version: 2,
    });

    const settingsOnly = await presets.updateMediaPreset({
      scope,
      presetId: 'p2',
      update: { settings: { ...settings, modelId: 'model-b' } },
    });
    expect(settingsOnly).toMatchObject({ isDefault: false, title: 'Alpha' });
    expect(settingsOnly?.settings.modelId).toBe('model-b');
    expect(await ids()).toEqual([
      ['p3', true],
      ['p2', false],
      ['p1', false],
    ]);

    const cleared = await presets.updateMediaPreset({
      scope,
      presetId: 'p3',
      update: { isDefault: false },
    });
    expect(cleared?.isDefault).toBe(false);
    expect(
      await presets.updateMediaPreset({ scope, presetId: 'missing', update: { title: 'Ghost' } }),
    ).toBeNull();
    expect(await ids()).toEqual([
      ['p3', false],
      ['p2', false],
      ['p1', false],
    ]);

    expect(await presets.deleteMediaPreset(scope, 'p1')).toBe(true);
    expect(await presets.deleteMediaPreset(scope, 'p1')).toBe(false);
    expect(await ids()).toEqual([
      ['p3', false],
      ['p2', false],
    ]);
  });

  it('rejects a preset beyond the configured capacity without touching other owners', async () => {
    await presets.createMediaPreset({ scope, presetId: 'p1', write: write('One'), maxPresets: 2 });
    await presets.createMediaPreset({ scope, presetId: 'p2', write: write('Two'), maxPresets: 2 });
    await expect(
      presets.createMediaPreset({ scope, presetId: 'p3', write: write('Three'), maxPresets: 2 }),
    ).rejects.toMatchObject({ code: 'capacity' });
    expect((await presets.listMediaPresets(scope)).map((preset) => preset.presetId)).toEqual([
      'p1',
      'p2',
    ]);
    const other = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    await presets.createMediaPreset({
      scope: other,
      presetId: 'p3',
      write: write('Three'),
      maxPresets: 2,
    });
    expect(await ids(other)).toEqual([['p3', false]]);
  });

  it('isolates presets by owner, tenant and tenant context', async () => {
    await create('shared-id', 'Mine', { isDefault: true });
    const stranger = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    const tenant = { ...scope, tenantId: 'tenant-a' };
    expect(await presets.listMediaPresets(stranger)).toEqual([]);
    expect(await presets.listMediaPresets(tenant)).toEqual([]);
    expect(
      await presets.updateMediaPreset({
        scope: stranger,
        presetId: 'shared-id',
        update: { title: 'Stolen' },
      }),
    ).toBeNull();
    expect(await presets.deleteMediaPreset(stranger, 'shared-id')).toBe(false);
    await presets.createMediaPreset({
      scope: stranger,
      presetId: 'shared-id',
      write: write('Theirs', { isDefault: true }),
      maxPresets: 5,
    });
    await presets.createMediaPreset({
      scope: tenant,
      presetId: 'shared-id',
      write: write('Tenant', { isDefault: true }),
      maxPresets: 5,
    });
    expect(await ids()).toEqual([['shared-id', true]]);
    expect(await ids(stranger)).toEqual([['shared-id', true]]);
    expect(await ids(tenant)).toEqual([['shared-id', true]]);
    await expect(
      tenantStorage.run({ tenantId: 'other' }, () => presets.listMediaPresets(scope)),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      presets.createMediaPreset({
        scope,
        presetId: 'shared-id',
        write: write('Again'),
        maxPresets: 5,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await presets.deleteMediaPreset(stranger, 'shared-id');
    expect(await ids(stranger)).toEqual([]);
    expect(await ids()).toEqual([['shared-id', true]]);
  });

  it('retains references independently of Studio and chat, releasing only the last preset consumer', async () => {
    const fileId = await asset();
    const created = await create('one', 'One', withInputs(fileId));
    await create('two', 'Two', withInputs(fileId));
    expect(created.assets).toEqual([
      expect.objectContaining({ file_id: fileId, filename: 'reference.png' }),
    ]);
    expect(created.assets[0]).not.toHaveProperty('storageKey');
    const db = createMethods(mongoose, { getMediaConsumerConfig: async () => consumerConfig });
    await db.recordMessage({
      user: scope.ownerId,
      conversationId: 'chat',
      messageId: 'message',
      files: [{ file_id: fileId }],
    });
    await media.releaseMediaAsset({ scope, fileId, retainer: 'thread:original:1' });
    await presets.deleteMediaPreset(scope, 'one');
    await db.deleteMessages({ user: scope.ownerId, conversationId: 'chat' });
    expect((await file(fileId))?.mediaRetainers).toEqual(['preset:two']);
    expect(await media.claimMediaAssetDeletion({ scope, fileId, token: 'retained' })).toBeNull();
    await presets.deleteMediaPreset(scope, 'two');
    expect((await file(fileId))?.mediaRetainers).toEqual([]);
    expect(
      await media.claimMediaAssetDeletion({ scope, fileId, token: 'released' }),
    ).not.toBeNull();
  });

  it('replaces and clears references without leaking the previous original', async () => {
    const first = await asset();
    const second = await asset();
    await create('preset', 'Reference', withInputs(first));
    await media.releaseMediaAsset({ scope, fileId: first, retainer: 'thread:original:1' });
    await media.releaseMediaAsset({ scope, fileId: second, retainer: 'thread:original:1' });
    const updated = await presets.updateMediaPreset({
      scope,
      presetId: 'preset',
      update: withInputs(second),
    });
    expect(updated?.assets.map((entry) => entry.file_id)).toEqual([second]);
    expect((await file(first))?.mediaRetainers).toEqual([]);
    expect((await file(second))?.mediaRetainers).toEqual(['preset:preset']);
    await presets.updateMediaPreset({ scope, presetId: 'preset', update: withInputs() });
    expect((await file(second))?.mediaRetainers).toEqual([]);
  });

  it('batches descriptors by owner and tenant and preserves unavailable saved IDs for visible restoration failure', async () => {
    const first = await asset();
    const second = await asset();
    await create('one', 'One', withInputs(first));
    await create('two', 'Two', withInputs(first, second));
    const find = jest.spyOn(mongoose.models.File, 'find');
    const listed = await presets.listMediaPresets(scope);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        user: scope.ownerId,
        tenantId: null,
        file_id: { $in: [first, second] },
      }),
    );
    expect(listed.map((entry) => entry.assets.length)).toEqual([1, 2]);
    find.mockRestore();
    await mongoose.models.File.collection.updateOne(
      { file_id: second },
      { $set: { mediaHardExpiresAt: new Date(0) } },
    );
    expect((await presets.listMediaPresets(scope))[1]).toMatchObject({
      settings: withInputs(first, second).settings,
      assets: [expect.objectContaining({ file_id: first })],
    });
  });

  it('rejects foreign, expired, retiring, hosted and over-limit references before publishing a preset', async () => {
    const owner = await asset({ user: new mongoose.Types.ObjectId() });
    const tenant = await asset({ tenantId: 'other' });
    const expired = await asset({ mediaHardExpiresAt: new Date(0) });
    const retiring = await asset({ mediaLifecycle: 'retiring' });
    for (const fileId of [owner, tenant, expired, retiring]) {
      await expect(create('bad', 'Bad', withInputs(fileId))).rejects.toBeInstanceOf(Error);
      expect(await ids()).toEqual([]);
    }
    const valid = await asset();
    await expect(
      presets.createMediaPreset({
        scope,
        presetId: 'many',
        write: write('Many', withInputs(valid, valid)),
        maxPresets: 5,
        maxInputs: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      presets.createMediaPreset({
        scope,
        presetId: 'url',
        write: {
          title: 'URL',
          settings: {
            ...settings,
            inputs: [{ file_id: valid, role: 'video', sourceURL: 'https://example.com/video.mp4' }],
          },
        },
        maxPresets: 5,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await file(valid))?.mediaRetainers).toEqual(['thread:original:1']);
  });

  it('reconciles a raw preset deletion and preserves its immutable hard expiry while referenced', async () => {
    const deadline = new Date(Date.now() + 60_000);
    const fileId = await asset({ mediaHardExpiresAt: deadline });
    await create('preset', 'Reference', withInputs(fileId));
    await media.releaseMediaAsset({ scope, fileId, retainer: 'thread:original:1' });
    expect(await file(fileId)).toMatchObject({ mediaHardExpiresAt: deadline, expiredAt: deadline });
    await mongoose.models.MediaPreset.deleteMany({ ...scope, presetId: 'preset' });
    await createMediaFileConsumerMethods(mongoose).reconcileMediaFileConsumers({
      scope,
      limit: 10,
      now: new Date(Date.now() + 2_000).toISOString(),
    });
    expect((await file(fileId))?.mediaRetainers).toEqual([]);
  });

  it('compensates a published preset whose original retired before claim confirmation', async () => {
    const fileId = await asset();
    let checks = 0;
    const racing = createMediaPresetMethods(mongoose, {
      assertMediaOwnerActive: async (owner) => {
        await media.assertMediaOwnerActive(owner);
        if (++checks === 2)
          await mongoose.models.File.updateOne({ file_id: fileId }, { mediaLifecycle: 'retiring' });
      },
    });
    await expect(
      racing.createMediaPreset({
        scope,
        presetId: 'race',
        write: write('Race', withInputs(fileId)),
        maxPresets: 5,
      }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(await ids()).toEqual([]);
  });

  it('preserves the previous preset and its reference when post-write owner validation fails transiently', async () => {
    const first = await asset();
    const second = await asset();
    await create('preset', 'Original', withInputs(first));
    let checks = 0;
    const failing = createMediaPresetMethods(mongoose, {
      assertMediaOwnerActive: async (owner) => {
        if (++checks > 1) throw new Error('Transient database failure');
        await media.assertMediaOwnerActive(owner);
      },
    });
    await expect(
      failing.updateMediaPreset({
        scope,
        presetId: 'preset',
        update: { title: 'Changed', ...withInputs(second) },
      }),
    ).rejects.toThrow('Transient database failure');
    expect((await presets.listMediaPresets(scope))[0]).toMatchObject({
      title: 'Original',
      ...withInputs(first),
    });
    expect((await file(first))?.mediaRetainers).toContain('preset:preset');
    expect((await file(second))?.mediaRetainers).not.toContain('preset:preset');
  });

  it('keeps durable references when concurrent preset updates race on the version fence', async () => {
    const fileId = await asset();
    await create('preset', 'Original', withInputs(fileId));
    const updates = await Promise.allSettled([
      presets.updateMediaPreset({ scope, presetId: 'preset', update: { title: 'First' } }),
      presets.updateMediaPreset({ scope, presetId: 'preset', update: { title: 'Second' } }),
    ]);
    expect(updates.some((result) => result.status === 'fulfilled')).toBe(true);
    const saved = await mongoose.models.MediaPreset.findOne({
      ...scope,
      presetId: 'preset',
    }).lean<MediaStoredPreset>();
    expect(['First', 'Second']).toContain(saved?.title);
    expect((await file(fileId))?.mediaRetainers).toContain('preset:preset');
    expect((await file(fileId))?.mediaConsumerClaims).toEqual([]);
  });

  it('removes presets when media account deletion completes', async () => {
    const fileId = await asset();
    await create('p1', 'Keep me', withInputs(fileId));
    const other = { ...scope, ownerId: new mongoose.Types.ObjectId().toString() };
    await presets.createMediaPreset({
      scope: other,
      presetId: 'p1',
      write: write('Other owner'),
      maxPresets: 5,
    });
    expect(await media.prepareMediaAccountDeletion({ scope, token: 'delete' })).toBe(true);
    await media.completeMediaAccountDeletion({ scope, token: 'delete' });
    await createMediaFileConsumerMethods(mongoose).reconcileMediaFileConsumers({
      scope,
      presetId: 'p1',
      limit: 10,
    });
    expect((await file(fileId))?.mediaRetainers).not.toContain('preset:p1');
    expect(await presets.listMediaPresets(scope)).toEqual([]);
    expect(await ids(other)).toEqual([['p1', false]]);
  });

  it('compensates a preset insert that resumes after account cleanup and owner TTL expiry', async () => {
    await mongoose.models.User.create({
      _id: scope.ownerId,
      email: 'preset-race@example.com',
      provider: 'local',
    });
    const strict = createMediaMethods(mongoose);
    let checks = 0;
    const paused = createMediaPresetMethods(mongoose, {
      assertMediaOwnerActive: async (owner) => {
        await strict.assertMediaOwnerActive(owner);
        if (++checks !== 1) return;
        expect(await strict.prepareMediaAccountDeletion({ scope, token: 'delete' })).toBe(true);
        await mongoose.models.User.deleteOne({ _id: scope.ownerId });
        await strict.completeMediaAccountDeletion({ scope, token: 'delete' });
        await strict.reconcileMediaAccountDeletion({ scope, limit: 10, retentionMs: 1 });
        await mongoose.models.MediaOwner.deleteMany(scope);
      },
    });
    await expect(
      paused.createMediaPreset({ scope, presetId: 'late', write: write('Late'), maxPresets: 5 }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(await ids()).toEqual([]);
    await expect(
      createMediaPresetMethods(mongoose).createMediaPreset({
        scope,
        presetId: 'retry',
        write: write('Retry'),
        maxPresets: 5,
      }),
    ).rejects.toMatchObject({ code: 'retired' });
  });

  it('discovers a crashed late preset insert after the owner tombstone expired and prunes bounded rows', async () => {
    await create('orphan-one', 'Orphan one');
    await create('orphan-two', 'Orphan two');
    await mongoose.models.MediaOwner.deleteMany(scope);
    const liveScope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    await mongoose.models.User.create({
      _id: liveScope.ownerId,
      email: 'live-preset@example.com',
      provider: 'local',
    });
    await presets.createMediaPreset({
      scope: liveScope,
      presetId: 'live',
      write: write('Live'),
      maxPresets: 5,
    });
    await mongoose.models.MediaOwner.deleteMany(liveScope);
    const strict = createMediaMethods(mongoose);
    const page = await runAsSystem(() =>
      strict.listMediaCleanupScopes({ limit: 10, now: new Date().toISOString() }),
    );
    expect(page.items).toEqual(expect.arrayContaining([scope, liveScope]));
    expect(await strict.reconcileMediaAccountDeletion({ scope, limit: 1 })).toBe(1);
    expect(await ids()).toHaveLength(1);
    expect(await strict.reconcileMediaAccountDeletion({ scope, limit: 1 })).toBe(1);
    expect(await ids()).toEqual([]);
    expect(await strict.reconcileMediaAccountDeletion({ scope: liveScope, limit: 1 })).toBe(0);
    expect(await ids(liveScope)).toEqual([['live', false]]);
  });
});
