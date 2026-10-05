import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { ContentTypes } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MediaConsumerConfig, MediaFileConsumerWrite } from '~/types/mediaConsumers';
import type { MediaOwnerScope } from '~/types/media';
import type { IMessage } from '~/types/message';
import type { IMongoFile } from '~/types/file';
import { createMediaFileConsumerMethods } from './consumers';
import { createMessageMethods } from '../message';
import { createMediaMethods } from './index';
import { createMethods } from '../index';
import { createModels } from '~/models';

describe('media file conversation consumers', () => {
  let mongo: MongoMemoryServer;
  let db: ReturnType<typeof createMethods>;
  let scope: MediaOwnerScope;
  let sweepOffset: number;
  const config: MediaConsumerConfig = {
    maxAssetRetainers: 8,
    consumerClaimMs: 60_000,
    consumerReconcileMs: 1000,
  };
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    db = createMethods(mongoose, { getMediaConsumerConfig: async () => config });
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    sweepOffset = 0;
  });

  async function asset(options: { hardExpiresAt?: Date; retained?: boolean; id?: string } = {}) {
    const fileId = options.id ?? `f17ecafe-${randomUUID().slice(9)}`;
    await mongoose.models.File.create({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      file_id: fileId,
      bytes: 8,
      filename: 'image.png',
      filepath: '/media/image.png',
      source: 'local',
      type: 'image/png',
      mediaOutputKey: fileId,
      mediaContentDigest: 'digest',
      mediaRendition: 'original',
      mediaLifecycle: 'live',
      mediaRetainers: options.retained === false ? [] : ['thread:studio:1'],
      mediaHardExpiresAt: options.hardExpiresAt,
      ...(options.retained === false ? { expiredAt: new Date(0) } : {}),
    });
    return fileId;
  }
  const file = (fileId: string) =>
    mongoose.models.File.findOne({ file_id: fileId }).lean<IMongoFile | null>();
  const reconcile = (conversationId?: string) =>
    db.reconcileMediaFileConsumers({
      scope,
      conversationId,
      limit: 20,
      now: new Date(Date.now() + (sweepOffset += 2000)).toISOString(),
      retryMs: 1000,
    });
  const claim = (
    fileId: string,
    conversationId: string,
    token: string = randomUUID(),
  ): MediaFileConsumerWrite => ({ scope, fileIds: [fileId], conversationId, token, config });

  it('keeps the original after Studio retirement, and releases only the final chat reference', async () => {
    const fileId = await asset();
    const conversationId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    for (const messageId of [first, second])
      await db.saveMessage(
        { userId: scope.ownerId },
        { conversationId, messageId, files: [{ file_id: fileId }] },
      );
    await db.releaseMediaAsset({ scope, fileId, retainer: 'thread:studio:1' });
    expect((await file(fileId))?.mediaRetainers).toEqual([`conversation:${conversationId}`]);
    expect(await db.getMediaAssetContent(scope, fileId)).toMatchObject({
      file_id: fileId,
      filepath: '/media/image.png',
    });
    expect(await db.claimMediaAssetDeletion({ scope, fileId, token: 'delete' })).toBeNull();
    await db.deleteMessages({ user: scope.ownerId, conversationId, messageId: first });
    expect((await file(fileId))?.mediaRetainers).toEqual([`conversation:${conversationId}`]);
    await db.deleteMessages({ user: scope.ownerId, conversationId, messageId: second });
    expect((await file(fileId))?.mediaRetainers).toEqual([]);
    expect(await db.claimMediaAssetDeletion({ scope, fileId, token: 'delete' })).not.toBeNull();
  });

  it('keeps a completed message deletion when immediate reconciliation fails', async () => {
    const fileId = await asset({ retained: false });
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.saveMessage(
      { userId: scope.ownerId },
      { conversationId, messageId, files: [{ file_id: fileId }] },
    );
    expect((await file(fileId))?.mediaRetainers).toEqual([`conversation:${conversationId}`]);
    jest.spyOn(mongoose.models.File, 'find').mockImplementationOnce(() => {
      throw new Error('File collection unavailable');
    });
    await expect(
      db.deleteMessages({ user: scope.ownerId, conversationId, messageId }),
    ).resolves.toMatchObject({ deletedCount: 1 });
    expect((await file(fileId))?.mediaRetainers).toEqual([`conversation:${conversationId}`]);
    await db.reconcileMediaFileConsumers({
      scope,
      limit: 10,
      now: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await file(fileId))?.mediaRetainers).toEqual([]);
  });

  it("does not return another writer's consumer token from duplicate-key recovery", async () => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId,
      messageId,
      isCreatedByUser: false,
      mediaConsumerToken: 'concurrent-writer',
    });
    jest.spyOn(mongoose.models.Message, 'findOneAndUpdate').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error collection: messages'), {
        code: 11000,
      }),
    );
    const recovered = await db.saveMessage(
      { userId: scope.ownerId },
      { conversationId, messageId, text: 'retry' },
    );
    expect(recovered).toMatchObject({ messageId });
    expect(recovered).not.toHaveProperty('mediaConsumerToken');
  });

  it.each(['files', 'attachments', 'image_file', 'steer'] as const)(
    'tracks %s in record and bulk writers, including raw rollback and TTL',
    async (kind) => {
      const fileId = await asset();
      const conversationId = randomUUID();
      const fields =
        kind === 'files' || kind === 'attachments'
          ? { [kind]: [{ file_id: fileId }] }
          : {
              content: [
                kind === 'image_file'
                  ? { type: ContentTypes.IMAGE_FILE, image_file: { file_id: fileId } }
                  : { type: ContentTypes.STEER, files: [{ file_id: fileId }] },
              ],
            };
      await db.recordMessage({
        user: scope.ownerId,
        conversationId,
        messageId: 'record',
        ...fields,
      });
      await db.bulkSaveMessages([
        { user: scope.ownerId, conversationId: 'clone', messageId: 'bulk', ...fields },
      ]);
      await db.releaseMediaAsset({ scope, fileId, retainer: 'thread:studio:1' });
      await mongoose.models.Message.deleteMany({ conversationId });
      await reconcile();
      expect((await file(fileId))?.mediaRetainers).toEqual(['conversation:clone']);
      await mongoose.models.Message.updateMany(
        { conversationId: 'clone' },
        { expiredAt: new Date(0) },
      );
      await reconcile();
      expect((await file(fileId))?.mediaRetainers).toEqual([]);
    },
  );

  it('distinguishes omitted files from an explicit removal', async () => {
    const fileId = await asset();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.saveMessage(
      { userId: scope.ownerId },
      { conversationId, messageId, files: [{ file_id: fileId }] },
    );
    await db.saveMessage({ userId: scope.ownerId }, { conversationId, messageId, text: 'edited' });
    await reconcile(conversationId);
    expect((await file(fileId))?.mediaRetainers).toContain(`conversation:${conversationId}`);
    await db.saveMessage({ userId: scope.ownerId }, { conversationId, messageId, files: [] });
    await reconcile(conversationId);
    expect((await file(fileId))?.mediaRetainers).not.toContain(`conversation:${conversationId}`);
  });

  it('does not let one failed writer release another pending writer in the same conversation', async () => {
    const fileId = await asset({ retained: false });
    const first = claim(fileId, 'conversation', 'first');
    const second = claim(fileId, 'conversation', 'second');
    await db.acquireMediaFileConsumers(first);
    await db.acquireMediaFileConsumers(second);
    await db.releaseMediaFileConsumerClaims(first);
    expect((await file(fileId))?.mediaConsumerClaims).toEqual([
      expect.objectContaining({ token: 'second' }),
    ]);
    expect(await db.claimMediaAssetDeletion({ scope, fileId, token: 'delete' })).toBeNull();
    await db.releaseMediaFileConsumerClaims(second);
    expect((await file(fileId))?.mediaRetainers).toEqual([]);
  });

  it('rejects and compensates a DB write that finishes after its claim expired and bytes retired', async () => {
    const fileId = await asset({ retained: false });
    const consumers = createMediaFileConsumerMethods(mongoose);
    const writers = createMessageMethods(mongoose, {
      getMediaConsumerConfig: async () => config,
      mediaFiles: {
        ...consumers,
        acquireMediaFileConsumers: async (input) => {
          await consumers.acquireMediaFileConsumers(input);
          await consumers.reconcileMediaFileConsumers({
            scope,
            limit: 10,
            now: new Date(Date.now() + config.consumerClaimMs + 1).toISOString(),
          });
          expect(
            await db.claimMediaAssetDeletion({ scope, fileId, token: 'delete' }),
          ).not.toBeNull();
          await db.completeMediaAssetDeletion({ scope, fileId, token: 'delete' });
        },
      },
    });
    await expect(
      writers.recordMessage({
        user: scope.ownerId,
        conversationId: 'late',
        messageId: 'late',
        text: 'keep text',
        files: [{ file_id: fileId }],
      }),
    ).rejects.toThrow();
    const saved = await mongoose.models.Message.findOne({
      messageId: 'late',
    }).lean<IMessage | null>();
    expect(saved).toMatchObject({ text: 'keep text', files: [] });
    expect(saved?.mediaConsumerToken).toBeUndefined();
  });

  it('reconciles persisted content after a crash before confirmation', async () => {
    const fileId = await asset({ retained: false });
    await db.acquireMediaFileConsumers(claim(fileId, 'saved'));
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'saved',
      messageId: 'saved',
      files: [{ file_id: fileId }],
    });
    await db.reconcileMediaFileConsumers({
      scope,
      limit: 10,
      now: new Date(Date.now() + config.consumerClaimMs + 1).toISOString(),
    });
    expect((await file(fileId))?.mediaConsumerClaims).toEqual([]);
    expect((await file(fileId))?.mediaRetainers).toEqual(['conversation:saved']);
  });

  it('preflights clone file availability in one owner-and-tenant-scoped lookup', async () => {
    const available = await asset();
    const foreignOwner = await asset();
    const foreignTenant = await asset();
    const expired = await asset({ hardExpiresAt: new Date(0) });
    const retiring = await asset();
    await mongoose.models.File.collection.updateOne(
      { file_id: foreignOwner },
      { $set: { user: new mongoose.Types.ObjectId() } },
    );
    await mongoose.models.File.collection.updateOne(
      { file_id: foreignTenant },
      { $set: { tenantId: 'another-tenant' } },
    );
    await mongoose.models.File.updateOne({ file_id: retiring }, { mediaLifecycle: 'retiring' });
    const find = jest.spyOn(mongoose.models.File, 'find');
    const fileIds = [available, available, foreignOwner, foreignTenant, expired, retiring];
    expect(await db.getAvailableMediaFileIds({ scope, fileIds })).toEqual([available]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        user: scope.ownerId,
        tenantId: null,
        file_id: { $in: [...new Set(fileIds)] },
        mediaLifecycle: 'live',
      }),
    );
    find.mockClear();
    expect(await db.getAvailableMediaFileIds({ scope, fileIds: [] })).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects foreign owner, tenant, retiring and hard-expired originals without changing usage', async () => {
    const fileId = await asset();
    for (const wrong of [
      { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null },
      { ...scope, tenantId: 'other' },
    ]) {
      await expect(
        db.acquireMediaFileConsumers({ ...claim(fileId, 'foreign'), scope: wrong }),
      ).rejects.toThrow();
    }
    await mongoose.models.File.updateOne({ file_id: fileId }, { mediaLifecycle: 'retiring' });
    expect(
      await db.updateFileUsage({ file_id: fileId, user: scope.ownerId, tenantId: null }),
    ).toBeNull();
    const expired = await asset({ hardExpiresAt: new Date(0) });
    await expect(db.acquireMediaFileConsumers(claim(expired, 'expired'))).rejects.toThrow();
    expect(
      await db.updateFileUsage({ file_id: expired, user: scope.ownerId, tenantId: null }),
    ).toBeNull();
    expect((await file(expired))?.mediaRetainers).toEqual(['thread:studio:1']);
  });

  it('preserves the immutable hard deadline when a permanent chat retains an ordinary expiring creation', async () => {
    const deadline = new Date(Date.now() + 60_000);
    const fileId = await asset({ hardExpiresAt: deadline });
    await db.recordMessage({
      user: scope.ownerId,
      conversationId: 'all',
      messageId: 'all',
      files: [{ file_id: fileId }],
    });
    expect((await file(fileId))?.mediaHardExpiresAt).toEqual(deadline);
    expect((await file(fileId))?.expiredAt).toEqual(deadline);
    await db.releaseMediaAsset({ scope, fileId, retainer: 'thread:studio:1' });
    expect(await file(fileId)).toMatchObject({
      mediaRetainers: ['conversation:all'],
      mediaHardExpiresAt: deadline,
      expiredAt: deadline,
    });
    expect(await db.claimMediaAssetDeletion({ scope, fileId, token: 'retained' })).toBeNull();
    await db.deleteMessages({ user: scope.ownerId, conversationId: 'all', messageId: 'all' });
    expect((await file(fileId))?.mediaHardExpiresAt).toEqual(deadline);
    expect(await db.claimMediaAssetDeletion({ scope, fileId, token: 'released' })).not.toBeNull();
  });

  it('bounds consumers explicitly and does not leave claims after a refused attach', async () => {
    const fileId = await asset();
    await expect(
      db.acquireMediaFileConsumers({
        ...claim(fileId, 'full'),
        config: { ...config, maxAssetRetainers: 1 },
      }),
    ).rejects.toMatchObject({ code: 'capacity' });
    expect((await file(fileId))?.mediaRetainers).toEqual(['thread:studio:1']);
    expect((await file(fileId))?.mediaConsumerClaims).toEqual([]);
  });

  it('protects legacy saved refs without starving later expired files', async () => {
    const first = await asset({ retained: false, id: 'f17ecafe-0000-4000-8000-000000000001' });
    const second = await asset({ retained: false, id: 'f17ecafe-0000-4000-8000-000000000002' });
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'legacy',
      messageId: 'legacy',
      attachments: [{ file_id: first }],
    });
    expect(await db.claimMediaAssetDeletion({ scope, fileId: first, token: 'delete' })).toBeNull();
    expect((await db.getExpiredFiles(1)).map((asset) => asset.file_id)).toEqual([second]);
    await mongoose.models.Message.deleteMany({ messageId: 'legacy' });
    expect(
      await db.claimMediaAssetDeletion({ scope, fileId: first, token: 'delete' }),
    ).not.toBeNull();
  });

  it('repairs a partial bulk failure without clearing another conversation consumer', async () => {
    const fileId = await asset({ retained: false });
    await db.recordMessage({
      user: scope.ownerId,
      conversationId: 'existing',
      messageId: 'existing',
      files: [{ file_id: fileId }],
    });
    const original = mongoose.models.Message.bulkWrite.bind(mongoose.models.Message);
    jest
      .spyOn(mongoose.models.Message, 'bulkWrite')
      .mockImplementationOnce(async (ops, options) => {
        await original(ops.slice(0, 1), options);
        throw new Error('partial bulk failure');
      });
    await expect(
      db.bulkSaveMessages([
        {
          user: scope.ownerId,
          conversationId: 'partial',
          messageId: 'one',
          files: [{ file_id: fileId }],
        },
        {
          user: scope.ownerId,
          conversationId: 'partial',
          messageId: 'two',
          files: [{ file_id: fileId }],
        },
      ]),
    ).rejects.toThrow('partial bulk failure');
    expect((await file(fileId))?.mediaRetainers).toEqual(['conversation:existing']);
    expect((await file(fileId))?.mediaConsumerClaims).toEqual([]);
  });

  it('imports unavailable, foreign or capacity-limited parts as placeholders while retaining owned originals', async () => {
    const fileId = await asset();
    const full = await asset();
    const foreignOwner = await asset();
    const foreignTenant = await asset();
    await mongoose.models.File.collection.updateOne(
      { file_id: foreignOwner },
      { $set: { user: new mongoose.Types.ObjectId() } },
    );
    await mongoose.models.File.collection.updateOne(
      { file_id: foreignTenant },
      { $set: { tenantId: 'another-tenant' } },
    );
    await mongoose.models.File.updateOne(
      { file_id: full },
      {
        $set: {
          mediaRetainers: Array.from(
            { length: config.maxAssetRetainers },
            (_, i) => `thread:${i}:1`,
          ),
        },
      },
    );
    const missing = `f17ecafe-${randomUUID().slice(9)}`;
    const messages = [
      {
        user: scope.ownerId,
        conversationId: 'import',
        messageId: 'import',
        content: [
          { type: ContentTypes.IMAGE_FILE, image_file: { file_id: fileId, filepath: '/one' } },
          { type: ContentTypes.IMAGE_FILE, image_file: { file_id: missing, filepath: '/missing' } },
          { type: ContentTypes.IMAGE_FILE, image_file: { file_id: full, filepath: '/full' } },
          {
            type: ContentTypes.IMAGE_FILE,
            image_file: { file_id: foreignOwner, filepath: '/foreign-owner' },
          },
          {
            type: ContentTypes.IMAGE_FILE,
            image_file: { file_id: foreignTenant, filepath: '/foreign-tenant' },
          },
        ],
      },
    ];
    await db.bulkSaveMessages(messages, true, { unavailableMedia: 'placeholder' });
    expect(messages[0].content[0].image_file.file_id).toBe(fileId);
    expect(messages[0].content[1].image_file.file_id).toBe('');
    expect(messages[0].content[2].image_file.file_id).toBe('');
    expect(messages[0].content[3].image_file.file_id).toBe('');
    expect(messages[0].content[4].image_file.file_id).toBe('');
    expect((await file(fileId))?.mediaRetainers).toContain('conversation:import');
    expect((await file(foreignOwner))?.mediaRetainers).toEqual(['thread:studio:1']);
    expect((await file(foreignTenant))?.mediaRetainers).toEqual(['thread:studio:1']);
  });

  it('retains an original appended to a completed tool result and releases it after raw message removal', async () => {
    const fileId = await asset();
    const messageId = randomUUID();
    const conversationId = randomUUID();
    await db.saveMessage(
      { userId: scope.ownerId },
      {
        conversationId,
        messageId,
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: { id: 'background', name: 'media', args: '{}' },
          },
        ],
      },
    );
    expect(
      await db.updateToolCallResult({
        userId: scope.ownerId,
        conversationId,
        messageId,
        toolCallId: 'background',
        output: 'finished',
        attachments: [{ file_id: fileId }],
      }),
    ).toMatchObject({ matched: true });
    await db.releaseMediaAsset({ scope, fileId, retainer: 'thread:studio:1' });
    expect((await file(fileId))?.mediaRetainers).toEqual([`conversation:${conversationId}`]);
    await mongoose.models.Message.deleteMany({ user: scope.ownerId, conversationId });
    await reconcile();
    expect((await file(fileId))?.mediaRetainers).toEqual([]);
  });

  it('rejects raw immutable writes and only permits explicitly scoped retired metadata deletion', async () => {
    const fileId = await asset();
    await mongoose.models.File.updateOne({ file_id: fileId }, { $set: { filepath: '/replaced' } });
    expect((await file(fileId))?.filepath).toBe('/media/image.png');
    await expect(
      mongoose.models.File.updateOne(
        { file_id: fileId },
        { filename: 'new.png' },
        { upsert: true },
      ),
    ).rejects.toThrow('immutable media protocol');
    const document = await mongoose.models.File.findOne({ file_id: fileId });
    document!.filepath = '/mutated';
    await expect(document!.save()).rejects.toThrow('immutable content');
    await expect(
      mongoose.models.File.create({
        user: scope.ownerId,
        file_id: `f17ecafe-${randomUUID().slice(9)}`,
        filename: 'fake',
        filepath: '/fake',
        bytes: 1,
        type: 'image/png',
      }),
    ).rejects.toThrow('immutable media provenance');
    expect((await mongoose.models.File.deleteMany({ user: scope.ownerId })).deletedCount).toBe(0);
    await expect(
      mongoose.models.File.deleteMany({ user: scope.ownerId }, { mediaRetirement: true }),
    ).rejects.toThrow('owner-and-tenant-scoped');
    for (const filter of [
      { user: { $ne: null }, tenantId: null },
      { user: scope.ownerId, tenantId: { $ne: 'foreign' } },
      { user: scope.ownerId, tenantId: undefined },
    ]) {
      await expect(
        mongoose.models.File.deleteMany(
          { ...filter, mediaLifecycle: 'retired' },
          { mediaRetirement: true },
        ),
      ).rejects.toThrow('owner-and-tenant-scoped');
    }
    await mongoose.models.File.updateOne({ file_id: fileId }, { mediaLifecycle: 'retired' });
    expect(
      (
        await mongoose.models.File.deleteMany(
          { user: scope.ownerId, tenantId: null, file_id: fileId, mediaLifecycle: 'retired' },
          { mediaRetirement: true },
        )
      ).deletedCount,
    ).toBe(1);
  });

  it('expires a fully retired owner fence while keeping the late-uploader cleanup receipt usable', async () => {
    await mongoose.models.User.create({
      _id: scope.ownerId,
      email: 'retention@example.com',
      provider: 'local',
    });
    const strict = createMediaMethods(mongoose);
    const write = await strict.reserveMediaAssetWrite({
      scope,
      outputKey: 'pending',
      rendition: 'original',
      ingestToken: 'pending',
      fingerprint: 'pending',
      storageKey: 'images/pending.png',
    });
    expect(await strict.prepareMediaAccountDeletion({ scope, token: 'account' })).toBe(true);
    await mongoose.models.User.deleteOne({ _id: scope.ownerId });
    await strict.completeMediaAccountDeletion({ scope, token: 'account' });
    await strict.reconcileMediaAccountDeletion({ scope, limit: 10, retentionMs: 5000 });
    expect(
      (await mongoose.models.MediaOwner.findOne(scope).lean<{ expiresAt?: Date }>())?.expiresAt,
    ).toBeUndefined();
    await strict.claimMediaAssetWriteDeletion({
      scope,
      writeId: write.writeId,
      token: 'cleanup',
      staleBefore: new Date(Date.now() + 1000).toISOString(),
    });
    await strict.completeMediaAssetWriteDeletion({
      scope,
      writeId: write.writeId,
      token: 'cleanup',
    });
    await strict.reconcileMediaAccountDeletion({ scope, limit: 10, retentionMs: 5000 });
    expect(
      (await mongoose.models.MediaOwner.findOne(scope).lean<{ expiresAt?: Date }>())?.expiresAt,
    ).toBeInstanceOf(Date);
    await mongoose.models.MediaOwner.deleteMany(scope);
    await expect(
      strict.reserveMediaAssetWrite({
        scope,
        outputKey: 'resurrect',
        rendition: 'original',
        ingestToken: 'resurrect',
        fingerprint: 'resurrect',
        storageKey: 'images/resurrect.png',
      }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(
      await strict.claimMediaAssetWriteDeletion({
        scope,
        writeId: write.writeId,
        token: 'late-put',
        staleBefore: new Date().toISOString(),
      }),
    ).toMatchObject({ storageKey: 'images/pending.png' });
  });

  it('does not activate a replacement owner after a paused creation check', async () => {
    const strict = createMediaMethods(mongoose, {
      ownerExists: async () => {
        await mongoose.models.MediaOwner.deleteMany(scope);
        await mongoose.models.MediaOwner.create({
          ...scope,
          status: 'initializing',
          creationToken: 'replacement',
          workIds: [],
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
    });
    await expect(
      strict.reserveMediaAssetWrite({
        scope,
        outputKey: 'paused',
        rendition: 'original',
        ingestToken: 'paused',
        fingerprint: 'paused',
        storageKey: 'images/paused.png',
      }),
    ).rejects.toMatchObject({ code: 'retired' });
    expect(await mongoose.models.MediaOwner.findOne(scope).lean()).toMatchObject({
      status: 'initializing',
      creationToken: 'replacement',
    });
  });
});
