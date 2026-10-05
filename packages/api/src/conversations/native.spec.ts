import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContentTypes, mediaSubmissionRequestSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createMediaMethods,
  createMediaNativeMethods,
} from '@librechat/data-schemas';
import type { MediaMethods, MediaNativeMethods, MediaOwnerScope } from '@librechat/data-schemas';
import { executeConversationImportWrites } from './import';
import { saveNativeConversationClone } from './native';

describe('native conversation clone publication', () => {
  let mongo: MongoMemoryServer;
  let media: MediaMethods;
  let native: MediaNativeMethods;
  let scope: MediaOwnerScope;
  let repository: ReturnType<typeof createMethods>;
  const execution = {
    api: 'google.generateContent' as const,
    modelId: 'image-model',
    connectionId: 'google',
    catalogVersion: 'v1',
    bindingRevision: 'credential',
  };
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    media = createMediaMethods(mongoose, { ownerExists: async () => true });
    native = createMediaNativeMethods(mongoose, media);
    repository = createMethods(mongoose);
    await media.ensureMediaIndexes();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
  });

  async function source() {
    const jobId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    const reference = { continuationRef: randomUUID() };
    const now = new Date();
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId: 'native',
      operation: 'image.generate',
      prompt: 'image',
      selection: { connectionId: 'google', modelId: 'image-model', catalogVersion: 'v1' },
    });
    await mongoose.models.MediaThread.create({
      ...scope,
      threadId,
      title: 'Legacy caption',
      status: 'active',
      epoch: 0,
      originRequestId: 'native',
      createdAt: now,
      updatedAt: now,
    });
    await mongoose.models.MediaJob.create({
      ...scope,
      jobId,
      threadId,
      turnId,
      threadEpoch: 0,
      createdAt: now,
      updatedAt: now,
      dueAt: now,
      clientRequestId: 'native',
      fingerprint: 'legacy-fixture',
      request,
      execution,
      executionOwner: 'chat',
      phase: 'succeeded',
      operation: request.operation,
      selection: request.selection,
      queueCapacity: 1,
      receipt: { phase: 'accepted', jobId, threadId, turnId, clientRequestId: 'native' },
      provider: { certainty: 'terminal', recovery: { terminalStatus: 'completed' } },
      nativeSource: { conversationId: 'source', messageId: 'source-message', modelRunId: 'run' },
      nativeLimits: { maxParts: 4, maxPartBytes: 1024, maxRecordingBytes: 4096 },
      nativePartKeys: [{ key: '0:0', fingerprint: 'legacy-fixture', bytes: 1 }],
      nativePartBytes: 1,
      nativeConsumers: ['source'],
      nativeRetentionState: 'live',
      outputs: [{ kind: 'text', ordinal: 0, outputId: reference.continuationRef, text: 'caption' }],
    });
    await mongoose.models.MediaNativePart.create({
      ...scope,
      ...reference,
      jobId,
      chunkIndex: 0,
      partIndex: 0,
      fingerprint: 'legacy-fixture',
      createdAt: now,
      part: { kind: 'text', text: 'caption' },
    });
    const content = [
      { type: ContentTypes.TEXT as const, text: 'caption', native_media: reference },
    ];
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'source',
      messageId: 'source-message',
      content,
    });
    return { reference, content, job: { jobId, threadId } };
  }

  it('retains after publication, survives concurrent maintenance, and keeps source and fork independent', async () => {
    const { reference, content, job } = await source();
    await saveNativeConversationClone({
      scope,
      sourceConversationId: 'source',
      conversationId: 'fork',
      messages: [{ content }],
      repository,
      loadConfig: async () => ({}),
      save: async () => {
        await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 4 });
        expect(
          await native.getMediaNativeContinuations({
            scope,
            execution,
            references: [reference],
            limit: 1,
            conversationId: 'fork',
          }),
        ).toEqual([null]);
        await mongoose.models.Message.create({
          user: scope.ownerId,
          conversationId: 'fork',
          messageId: 'fork-message',
          content,
        });
      },
    });
    expect((await media.getMediaJob(scope, job.jobId))?.nativeConsumerClaims ?? []).toEqual([]);
    await native.releaseMediaNativeConversation({
      scope,
      conversationId: 'source',
      maxRetainers: 4,
    });
    expect(
      await native.getMediaNativeContinuations({
        scope,
        execution,
        references: [reference],
        limit: 1,
        conversationId: 'fork',
      }),
    ).toMatchObject([reference]);
  });

  it('compensates failed publication without releasing the source consumer', async () => {
    const { reference, content } = await source();
    await expect(
      saveNativeConversationClone({
        scope,
        sourceConversationId: 'source',
        conversationId: 'failed-fork',
        messages: [{ content }],
        repository,
        loadConfig: async () => ({}),
        save: () =>
          executeConversationImportWrites({
            saveConversations: async () => {},
            saveMessages: async () => {
              await mongoose.models.Message.create({
                user: scope.ownerId,
                conversationId: 'failed-fork',
                messageId: 'partial',
                content,
              });
              throw new Error('partial write');
            },
            deleteMessages: async () => {
              await mongoose.models.Message.deleteMany({
                user: scope.ownerId,
                conversationId: 'failed-fork',
              });
            },
            deleteConversations: async () => {},
            updateTagCounts: async () => {},
          }),
      }),
    ).rejects.toThrow('partial write');
    expect(
      await native.getMediaNativeContinuations({
        scope,
        execution,
        references: [reference],
        limit: 1,
        conversationId: 'failed-fork',
      }),
    ).toEqual([null]);
    expect(
      await native.getMediaNativeContinuations({
        scope,
        execution,
        references: [reference],
        limit: 1,
        conversationId: 'source',
      }),
    ).toMatchObject([reference]);
  });

  it('keeps a committed clone successful when claim confirmation temporarily fails', async () => {
    const { reference, content } = await source();
    const confirm = jest
      .spyOn(repository, 'confirmMediaNativeConversation')
      .mockRejectedValueOnce(new Error('temporary confirmation failure'));
    const onCleanupError = jest.fn();
    await expect(
      saveNativeConversationClone({
        scope,
        sourceConversationId: 'source',
        conversationId: 'committed',
        messages: [{ content }],
        repository,
        loadConfig: async () => ({}),
        onCleanupError,
        save: async () => {
          await mongoose.models.Message.create({
            user: scope.ownerId,
            conversationId: 'committed',
            messageId: 'committed-message',
            content,
          });
        },
      }),
    ).resolves.toBeUndefined();
    expect(onCleanupError).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
    await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 4 });
    expect(
      await native.getMediaNativeContinuations({
        scope,
        execution,
        references: [reference],
        limit: 1,
        conversationId: 'committed',
      }),
    ).toMatchObject([reference]);
  });

  it('keeps a visible clone and detaches only unavailable native identity after retention expires', async () => {
    const { reference, content } = await source();
    await expect(
      saveNativeConversationClone({
        scope,
        sourceConversationId: 'source',
        conversationId: 'expired-copy',
        messages: [{ content }],
        repository,
        loadConfig: async () => ({}),
        save: async () => {
          await mongoose.models.Message.create({
            user: scope.ownerId,
            conversationId: 'expired-copy',
            messageId: 'expired-message',
            content,
          });
          await mongoose.models.MediaNativePart.updateOne(
            { continuationRef: reference.continuationRef },
            { $set: { expiresAt: new Date(0) } },
          );
        },
      }),
    ).resolves.toBeUndefined();
    expect(
      await mongoose.models.Message.countDocuments({
        user: scope.ownerId,
        conversationId: 'expired-copy',
      }),
    ).toBe(1);
    expect(
      (
        await mongoose.models.Message.findOne({ messageId: 'expired-message' }).lean<{
          content: Array<{ text?: string; native_media?: object }>;
        }>()
      )?.content,
    ).toEqual([{ type: ContentTypes.TEXT, text: 'caption' }]);
    expect(
      await mongoose.models.Message.countDocuments({
        user: scope.ownerId,
        conversationId: 'source',
      }),
    ).toBe(1);
  });
});
