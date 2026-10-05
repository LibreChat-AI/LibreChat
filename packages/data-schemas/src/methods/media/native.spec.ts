import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources, mediaSubmissionRequestSchema } from 'librechat-data-provider';
import type { FileStorage } from 'librechat-data-provider';
import type {
  MediaNativeMethods,
  MediaNativeLimits,
  MediaNativePart,
  MediaNativePartRecord,
  MediaNativeReference,
} from '~/types/mediaNative';
import type { MediaMethods, MediaOwnerScope, MediaStoredJob } from '~/types/media';
import { createMediaNativeMethods } from './native';
import { createMessageMethods } from '../message';
import { createMediaMethods } from './index';

describe('legacy native recording readers and cleanup', () => {
  let mongo: MongoMemoryServer;
  let media: MediaMethods;
  let native: MediaNativeMethods;
  let scope: MediaOwnerScope;
  const execution = {
    api: 'google.generateContent' as const,
    modelId: 'gemini-image',
    connectionId: 'google',
    catalogVersion: 'v1',
    bindingRevision: 'account-one',
  };
  const limits: MediaNativeLimits = { maxParts: 20, maxPartBytes: 1024, maxRecordingBytes: 4096 };

  async function readContinuation({
    continuationRef,
    fileId,
    ...input
  }: Omit<
    Parameters<MediaNativeMethods['getMediaNativeContinuations']>[0],
    'references' | 'limit'
  > &
    MediaNativeReference) {
    const [part] = await native.getMediaNativeContinuations({
      ...input,
      references: [{ continuationRef, fileId }],
      limit: 1,
    });
    return part;
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    media = createMediaMethods(mongoose, { ownerExists: async () => true });
    native = createMediaNativeMethods(mongoose, media);
    await media.ensureMediaIndexes();
    await native.ensureMediaNativeIndexes();
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
    native = createMediaNativeMethods(mongoose, media);
  });

  /** Seeds the persisted prerelease shape; production has no side-table writer. */
  async function start(
    modelRunId = 'run-one',
    configuredLimits = limits,
    _maxTitleChars = 20,
    expiresAt?: string,
  ): Promise<MediaStoredJob> {
    const jobId = randomUUID();
    const threadId = randomUUID();
    const turnId = randomUUID();
    const now = new Date();
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId: modelRunId,
      prompt: 'Create an image',
      operation: 'image.generate',
      selection: {
        connectionId: execution.connectionId,
        modelId: execution.modelId,
        catalogVersion: execution.catalogVersion,
      },
    });
    await mongoose.models.MediaThread.create({
      ...scope,
      threadId,
      title: 'Legacy image',
      status: 'active',
      epoch: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastTurnAt: now,
      originRequestId: modelRunId,
      nextTurnSequence: 1,
      pendingJobCount: 1,
    });
    await mongoose.models.MediaJob.create({
      ...scope,
      jobId,
      threadId,
      turnId,
      threadEpoch: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      dueAt: now,
      clientRequestId: modelRunId,
      fingerprint: 'legacy-fixture',
      request,
      execution,
      executionOwner: 'chat',
      receipt: { phase: 'accepted', jobId, threadId, turnId, clientRequestId: modelRunId },
      phase: 'running',
      operation: request.operation,
      selection: request.selection,
      provider: { certainty: 'unknown' },
      queueCapacity: 1,
      nativeSource: {
        conversationId: 'conversation',
        messageId: 'assistant-message',
        modelRunId,
        ...(expiresAt ? { expiresAt } : {}),
      },
      nativeLimits: configuredLimits,
      nativePartKeys: [],
      nativePartBytes: 0,
      nativeConsumers: ['conversation'],
      nativeRetentionState: 'live',
      publicationExpiresAt: expiresAt ? new Date(expiresAt) : null,
    });
    return (await media.getMediaJob(scope, jobId))!;
  }

  async function seedPart(input: {
    scope: MediaOwnerScope;
    jobId: string;
    chunkIndex: number;
    partIndex: number;
    part: MediaNativePart;
    maxRetainers: number;
  }): Promise<{ continuationRef: string }> {
    const continuationRef = randomUUID();
    const job = (await media.getMediaJob(input.scope, input.jobId))!;
    await mongoose.models.MediaNativePart.create({
      ...input.scope,
      jobId: input.jobId,
      chunkIndex: input.chunkIndex,
      partIndex: input.partIndex,
      continuationRef,
      fingerprint: 'legacy-fixture',
      part: input.part,
      createdAt: new Date(),
      ...(input.part.kind === 'image' ? { fileId: input.part.fileId } : {}),
      ...(job.nativeSource?.expiresAt ? { expiresAt: new Date(job.nativeSource.expiresAt) } : {}),
    });
    await mongoose.models.MediaJob.updateOne(
      { jobId: input.jobId },
      {
        $push: {
          nativePartKeys: {
            key: input.chunkIndex + ':' + input.partIndex,
            fingerprint: 'legacy-fixture',
            bytes: 1,
          },
        },
        $inc: { nativePartBytes: 1 },
      },
    );
    if (input.part.kind === 'image') {
      await mongoose.models.File.updateOne(
        { file_id: input.part.fileId },
        {
          $addToSet: { mediaRetainers: 'native:' + input.jobId },
        },
      );
    }
    return { continuationRef };
  }

  async function seedCompleted(input: { scope: MediaOwnerScope; jobId: string }) {
    const job = (await media.getMediaJob(input.scope, input.jobId))!;
    const parts = await mongoose.models.MediaNativePart.find({ jobId: input.jobId })
      .sort({ chunkIndex: 1, partIndex: 1 })
      .lean<MediaNativePartRecord[]>();
    const outputs: MediaStoredJob['outputs'] = [];
    for (const [ordinal, entry] of parts.entries()) {
      if (entry.part.kind === 'text') {
        outputs.push({
          kind: 'text',
          outputId: entry.continuationRef,
          ordinal,
          text: entry.part.text,
        });
      } else {
        const asset = (await media.getMediaAsset(input.scope, entry.part.fileId))!;
        outputs.push({
          kind: 'image',
          outputId: entry.continuationRef,
          ordinal,
          state: 'ready',
          asset,
        });
      }
    }
    await mongoose.models.MediaJob.updateOne(
      { jobId: input.jobId },
      {
        $set: {
          phase: 'succeeded',
          outputs,
          provider: {
            certainty: 'terminal',
            recovery: {
              terminalStatus: 'completed',
              parts: parts.map((entry, ordinal) => ({ ...entry.part, ordinal })),
            },
          },
        },
      },
    );
    const cover = outputs.find((output) => output.kind === 'image');
    await mongoose.models.MediaThread.updateOne(
      { threadId: job.threadId },
      {
        $set: { pendingJobCount: 0, ...(cover?.kind === 'image' ? { cover: cover.asset } : {}) },
      },
    );
    return media.getMediaJob(input.scope, input.jobId);
  }

  async function original(source: FileStorage = FileSources.local, thumbnail = false) {
    const storageKey = `images/t/${scope.tenantId ?? 'default'}/${scope.ownerId}/immutable.png`;
    const filepath =
      source === FileSources.local ? `/${storageKey}` : `https://private.example/${storageKey}`;
    const rendition = {
      source,
      storageKey: `${storageKey}.thumbnail.png`,
      filepath: `${filepath}.thumbnail.png`,
      type: 'image/png',
      bytes: 8,
      width: 16,
      height: 16,
      contentDigest: 'thumbnail-digest',
    };
    const write = await media.reserveMediaAssetWrite({
      scope,
      outputKey: 'native-image',
      rendition: 'original',
      ingestToken: 'one',
      fingerprint: 'digest',
      storageKey,
      source,
      ...(thumbnail ? { renditionLocations: [{ ...rendition, kind: 'thumbnail' as const }] } : {}),
    });
    return media.commitMediaAssetWrite({
      scope,
      writeId: write.writeId,
      content: {
        file_id: write.fileId,
        storageKey: write.storageKey,
        source,
        filename: 'immutable.png',
        type: 'image/png',
        filepath,
        bytes: 16,
        contentDigest: 'digest',
        ...(thumbnail ? { mediaRenditions: { thumbnail: rendition } } : {}),
      },
    });
  }

  it('reads ordered stored text/image/signature facts and restores them after repository restart', async () => {
    const job = await start();
    const image = await original();
    const imagePart = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 1,
      partIndex: 0,
      part: {
        kind: 'image',
        mimeType: 'image/png',
        fileId: image.file_id,
        thoughtSignature: 'private-image-signature',
      },
      maxRetainers: 4,
    });
    const text = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'Before', thoughtSignature: 'private-text-signature' },
      maxRetainers: 4,
    });
    await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 2,
      partIndex: 0,
      part: { kind: 'text', text: 'After' },
      maxRetainers: 4,
    });
    const complete = await seedCompleted({ scope, jobId: job.jobId });
    expect(complete?.outputs.map((part) => part.kind)).toEqual(['text', 'image', 'text']);
    expect(complete?.provider.recovery?.parts?.map((part) => part.ordinal)).toEqual([0, 1, 2]);
    expect(JSON.stringify(await media.getMediaJobView(scope, job.jobId))).not.toContain('private-');
    native = createMediaNativeMethods(
      mongoose,
      createMediaMethods(mongoose, { ownerExists: async () => true }),
    );
    expect(
      await readContinuation({
        scope,
        continuationRef: text.continuationRef,
        execution,
      }),
    ).toMatchObject({
      part: { kind: 'text', text: 'Before', thoughtSignature: 'private-text-signature' },
    });
    expect(await readContinuation({ scope, fileId: image.file_id, execution })).toMatchObject({
      continuationRef: imagePart.continuationRef,
      part: { thoughtSignature: 'private-image-signature' },
    });
    expect((await media.getMediaThread(scope, job.threadId))?.pendingJobCount).toBe(0);
  });

  it.each([FileSources.local, FileSources.s3] as const)(
    'restores private %s native outputs and thumbnails through the canonical public projection',
    async (source) => {
      scope.tenantId = 'tenant-one';
      const job = await start();
      const image = await original(source, true);
      await seedPart({
        scope,
        jobId: job.jobId,
        chunkIndex: 0,
        partIndex: 0,
        part: { kind: 'image', mimeType: 'image/png', fileId: image.file_id },
        maxRetainers: 4,
      });
      native = createMediaNativeMethods(
        mongoose,
        createMediaMethods(mongoose, { ownerExists: async () => true }),
      );
      const completed = await seedCompleted({ scope, jobId: job.jobId });
      expect(completed?.outputs).toEqual([
        expect.objectContaining({ kind: 'image', state: 'ready', asset: image }),
      ]);
      const publicPath = `/api/media/assets/${image.file_id}/content`;
      expect(image).toMatchObject({
        filepath: publicPath,
        renditions: { thumbnail: { filepath: `${publicPath}?rendition=thumbnail`, bytes: 8 } },
      });
      const restored = await media.getMediaJobView(scope, job.jobId);
      expect(JSON.stringify(restored)).not.toContain('private.example');
      expect(JSON.stringify(restored)).not.toContain('images/t/');
      expect(JSON.stringify(restored)).not.toContain('storageKey');
      expect((await media.getMediaThread(scope, job.threadId))?.cover).toEqual(image);
      const content = await media.getMediaAssetContent(scope, image.file_id);
      expect(content?.filepath).toContain('images/t/tenant-one/');
      expect(content?.mediaRenditions?.thumbnail?.storageKey).toContain('thumbnail.png');
      expect(content?.source).toBe(source);
    },
  );

  it('rejects continuation access across owner, model, account, and ref/file identity', async () => {
    const job = await start();
    const asset = await original();
    const receipt = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: {
        kind: 'image',
        mimeType: 'image/png',
        fileId: asset.file_id,
        thoughtSignature: 'secret',
      },
      maxRetainers: 4,
    });
    const base = { scope, execution, continuationRef: receipt.continuationRef };
    expect(
      await readContinuation({
        ...base,
        execution: { ...execution, modelId: 'other' },
      }),
    ).toBeNull();
    expect(
      await readContinuation({
        ...base,
        execution: { ...execution, bindingRevision: 'other' },
      }),
    ).toBeNull();
    expect(
      await readContinuation({
        ...base,
        scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
      }),
    ).toBeNull();
    expect(await readContinuation({ ...base, fileId: 'another-file' })).toBeNull();
    await media.retireMediaThread(scope, job.threadId);
    expect(await readContinuation(base)).not.toBeNull();
    await native.releaseMediaNativeConversation({
      scope,
      maxRetainers: 4,
      conversationId: 'conversation',
    });
    expect(await readContinuation(base)).toBeNull();
  });

  it('retains source and fork continuations independently of the Studio projection until the final consumer leaves', async () => {
    const job = await start();
    const asset = await original();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: {
        kind: 'image',
        fileId: asset.file_id,
        mimeType: 'image/png',
        thoughtSignature: 'private signature',
      },
      maxRetainers: 4,
    });
    await seedCompleted({ scope, jobId: job.jobId });
    expect(
      await native.retainMediaNativeConversation({
        scope,
        conversationId: 'fork',
        continuationRefs: [reference.continuationRef],
        limit: 20,
        maxRetainers: 4,
      }),
    ).toBe(true);
    await media.retireMediaThread(scope, job.threadId);
    await media.reconcileMediaRetirements({ scope, limit: 10 });
    const replay = (conversationId: string) =>
      readContinuation({ scope, ...reference, execution, conversationId });
    expect(await replay('conversation')).not.toBeNull();
    expect(await replay('fork')).not.toBeNull();
    expect(await replay('unregistered')).toBeNull();
    expect((await media.getMediaJob(scope, job.jobId))?.outputs).toHaveLength(1);
    await native.releaseMediaNativeConversation({
      scope,
      maxRetainers: 4,
      conversationId: 'conversation',
    });
    expect(await replay('conversation')).toBeNull();
    expect(await replay('fork')).not.toBeNull();
    expect(await media.getMediaAsset(scope, asset.file_id)).not.toBeNull();
    await native.releaseMediaNativeConversation({ scope, maxRetainers: 4, conversationId: 'fork' });
    expect(await replay('fork')).toBeNull();
    expect(await mongoose.models.MediaNativePart.countDocuments({ jobId: job.jobId })).toBe(0);
    expect(await media.getMediaJob(scope, job.jobId)).toMatchObject({
      nativeRetentionState: 'purged',
      outputs: [],
      request: { prompt: '' },
    });
    expect(await mongoose.models.File.findOne({ file_id: asset.file_id }).lean()).toMatchObject({
      mediaRetainers: [],
    });
    expect(
      await media.claimMediaAssetDeletion({
        scope,
        fileId: asset.file_id,
        token: 'final-consumer',
      }),
    ).not.toBeNull();
    expect(
      await native.retainMediaNativeConversation({
        scope,
        conversationId: 'late',
        continuationRefs: [reference.continuationRef],
        limit: 20,
        maxRetainers: 4,
      }),
    ).toBe(false);
  });

  it('recovers a crash after source-consumer release before presentation cleanup', async () => {
    const job = await start();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'sensitive' },
      maxRetainers: 4,
    });
    await seedCompleted({ scope, jobId: job.jobId });
    const failure = jest
      .spyOn(media, 'retireMediaThread')
      .mockRejectedValueOnce(new Error('interrupted database connection'));
    await expect(
      native.releaseMediaNativeConversation({
        scope,
        maxRetainers: 4,
        conversationId: 'conversation',
      }),
    ).rejects.toThrow('interrupted');
    failure.mockRestore();
    const now = new Date().toISOString();
    native = createMediaNativeMethods(mongoose, media);
    await native.reconcileMediaNativeRecordings({ scope, now, staleBefore: now, limit: 10 });
    await media.reconcileMediaRetirements({ scope, limit: 10 });
    await native.reconcileMediaNativeRecordings({ scope, now, staleBefore: now, limit: 10 });
    expect(await readContinuation({ scope, execution, ...reference })).toBeNull();
    expect(await mongoose.models.MediaNativePart.countDocuments({ jobId: job.jobId })).toBe(0);
    expect((await media.getMediaJob(scope, job.jobId))?.nativeCleanupPending).toBeUndefined();
  });

  it('restores a transcript in two bounded reads and preserves request order and authorization', async () => {
    const job = await start('batch', { ...limits, maxParts: 30 });
    const references = [];
    for (let index = 0; index < 24; index++) {
      references.push(
        await seedPart({
          scope,
          jobId: job.jobId,
          chunkIndex: index,
          partIndex: 0,
          part: { kind: 'text', text: `chunk ${index}` },
          maxRetainers: 4,
        }),
      );
    }
    const parts = jest.spyOn(mongoose.models.MediaNativePart, 'find');
    const jobs = jest.spyOn(mongoose.models.MediaJob, 'find');
    const threads = jest.spyOn(mongoose.models.MediaThread, 'find');
    const restored = await native.getMediaNativeContinuations({
      scope,
      references: [...references].reverse(),
      execution,
      conversationId: 'conversation',
      limit: 30,
    });
    expect(restored.map((part) => part?.part)).toEqual(
      Array.from({ length: 24 }, (_, index) => ({ kind: 'text', text: `chunk ${23 - index}` })),
    );
    expect(parts).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(threads).not.toHaveBeenCalled();
    parts.mockRestore();
    jobs.mockRestore();
    threads.mockRestore();
    expect(
      await native.getMediaNativeContinuations({
        scope,
        references,
        execution: { ...execution, bindingRevision: 'different-account' },
        limit: 30,
      }),
    ).toEqual(Array(24).fill(null));
    await expect(
      native.getMediaNativeContinuations({ scope, references, execution, limit: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('stores part expiry as a TTL-backed date and hides an expired continuation', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const job = await start('expiring-run', limits, 20, expiresAt);
    const receipt = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'Soon gone' },
      maxRetainers: 4,
    });
    const input = { scope, execution, continuationRef: receipt.continuationRef };
    expect(await readContinuation(input)).toMatchObject({ expiresAt });
    const stored = await mongoose.models.MediaNativePart.findOne({
      continuationRef: receipt.continuationRef,
    }).lean<{ expiresAt?: Date }>();
    expect(stored?.expiresAt).toBeInstanceOf(Date);
    const indexes = await mongoose.models.MediaNativePart.listIndexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
    await mongoose.models.MediaNativePart.updateOne(
      { continuationRef: receipt.continuationRef },
      { $set: { expiresAt: new Date(0) } },
    );
    expect(await readContinuation(input)).toBeNull();
  });

  it('legacy maintenance after message deletion releases only absent consumers, preserving a saved fork and other messages', async () => {
    const job = await start();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'caption' },
      maxRetainers: 4,
    });
    await seedCompleted({ scope, jobId: job.jobId });
    const content = [{ type: 'text', text: 'caption', native_media: reference }];
    await mongoose.models.Message.create([
      { user: scope.ownerId, conversationId: 'conversation', messageId: 'source', content },
      { user: scope.ownerId, conversationId: 'fork', messageId: 'fork-one', content },
      { user: scope.ownerId, conversationId: 'fork', messageId: 'fork-two', content },
    ]);
    await native.retainMediaNativeConversation({
      scope,
      conversationId: 'fork',
      continuationRefs: [reference.continuationRef],
      maxRetainers: 4,
      limit: 4,
    });
    const messages = createMessageMethods(mongoose);
    expect(
      (await messages.deleteMessages({ user: scope.ownerId, messageId: 'source' })).deletedCount,
    ).toBe(1);
    await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 4 });
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'conversation',
      }),
    ).toBeNull();
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'fork',
      }),
    ).not.toBeNull();
    await media.reconcileMediaRetirements({ scope, limit: 10 });
    expect(
      await mongoose.models.MediaThread.findOne({ threadId: job.threadId }).lean(),
    ).toMatchObject({ status: 'retired' });
    await messages.deleteMessages({ user: scope.ownerId, messageId: 'fork-one' });
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'fork',
      }),
    ).not.toBeNull();
    await messages.deleteMessages({ user: scope.ownerId, messageId: 'fork-two' });
    await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 4 });
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'fork',
      }),
    ).toBeNull();
  });

  it('protects unpublished clone claims and reclaims an abandoned clone after the claim expires', async () => {
    const job = await start();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'caption' },
      maxRetainers: 4,
    });
    await seedCompleted({ scope, jobId: job.jobId });
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'conversation',
      messageId: 'source',
      content: [{ type: 'text', text: 'caption', native_media: reference }],
    });
    await native.retainMediaNativeConversation({
      scope,
      conversationId: 'unpublished',
      continuationRefs: [reference.continuationRef],
      maxRetainers: 4,
      limit: 4,
      pendingUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 1 });
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'unpublished',
      }),
    ).not.toBeNull();
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      { $set: { 'nativeConsumerClaims.0.expiresAt': new Date(0).toISOString() } },
    );
    await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 1 });
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'unpublished',
      }),
    ).toBeNull();
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'conversation',
      }),
    ).not.toBeNull();
  });

  it('renews one pending clone without losing another and releases only the requested consumer', async () => {
    const job = await start();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'caption' },
      maxRetainers: 4,
    });
    const pendingUntil = new Date(Date.now() + 60_000).toISOString();
    const renewedUntil = new Date(Date.now() + 120_000).toISOString();
    const retain = (conversationId: string, deadline: string) =>
      native.retainMediaNativeConversation({
        scope,
        conversationId,
        continuationRefs: [reference.continuationRef],
        maxRetainers: 4,
        limit: 4,
        pendingUntil: deadline,
      });
    expect(await retain('first-clone', pendingUntil)).toBe(true);
    expect(await retain('second-clone', pendingUntil)).toBe(true);
    expect(await retain('first-clone', renewedUntil)).toBe(true);
    expect((await media.getMediaJob(scope, job.jobId))?.nativeConsumerClaims).toEqual([
      { conversationId: 'second-clone', expiresAt: pendingUntil },
      { conversationId: 'first-clone', expiresAt: renewedUntil },
    ]);
    await native.releaseMediaNativeConversation({
      scope,
      conversationId: 'first-clone',
      maxRetainers: 4,
    });
    const stored = await media.getMediaJob(scope, job.jobId);
    expect(stored?.nativeConsumers).toEqual(['conversation', 'second-clone']);
    expect(stored?.nativeConsumerClaims).toEqual([
      { conversationId: 'second-clone', expiresAt: pendingUntil },
    ]);
  });

  it('releases an edited text-only native consumer without retaining private original text forever', async () => {
    const job = await start();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'old caption' },
      maxRetainers: 4,
    });
    await seedCompleted({ scope, jobId: job.jobId });
    const content = [{ type: 'text', text: 'corrected caption', native_media: reference }];
    await mongoose.models.Message.create({
      user: scope.ownerId,
      conversationId: 'conversation',
      messageId: 'source',
      content,
    });
    await createMessageMethods(mongoose).updateMessage(scope.ownerId, {
      messageId: 'source',
      content,
      userSubmittedPaths: ['/content/0/text'],
    });
    const stored = await mongoose.models.Message.findOne({ messageId: 'source' }).lean<{
      content: typeof content;
    }>();
    expect(stored?.content).toEqual([{ type: 'text', text: 'corrected caption' }]);
    await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 4 });
    expect((await media.getMediaJob(scope, job.jobId))?.nativeConsumers).toEqual([]);
    await media.reconcileMediaRetirements({ scope, limit: 10 });
    expect(await mongoose.models.MediaNativePart.countDocuments({ jobId: job.jobId })).toBe(0);
  });

  it('does not reconstruct prerelease consumer state from arbitrary message references', async () => {
    const job = await start();
    const reference = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'legacy caption' },
      maxRetainers: 4,
    });
    await seedCompleted({ scope, jobId: job.jobId });
    await mongoose.models.MediaJob.updateOne(
      { jobId: job.jobId },
      { $unset: { nativeConsumers: 1, nativeRetentionState: 1 } },
    );
    await mongoose.models.Message.create({
      messageId: 'fork-message',
      conversationId: 'old-fork',
      user: scope.ownerId,
      tenantId: scope.tenantId,
      content: [{ type: 'text', text: 'legacy caption', native_media: reference }],
    });
    expect(
      await readContinuation({
        scope,
        execution,
        ...reference,
        conversationId: 'old-fork',
      }),
    ).toBeNull();
    expect(await native.reconcileMediaNativeConsumers({ scope, limit: 10, maxRetainers: 4 })).toBe(
      0,
    );
  });

  it('records native failure without enabling automatic or manual paid retry', async () => {
    const job = await start();
    await native.failMediaNativeRecording({ scope, jobId: job.jobId, reason: 'provider' });
    expect(await media.getMediaJobView(scope, job.jobId)).toMatchObject({
      phase: 'failed',
      allowedActions: { cancel: false, retry: false },
    });

    expect(
      await media.claimMediaJob({
        scope,
        workerId: 'media-worker',
        now: new Date(Date.now() + 1000).toISOString(),
        leaseMs: 10000,
      }),
    ).toBeNull();
  });

  it('preserves emitted partial outputs and signatures when the original chat invocation fails', async () => {
    const job = await start();
    const image = await original();
    const receipt = await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: {
        kind: 'image',
        mimeType: 'image/png',
        fileId: image.file_id,
        thoughtSignature: 'partial-signature',
      },
      maxRetainers: 4,
    });
    const failed = await native.failMediaNativeRecording({
      scope,
      jobId: job.jobId,
      reason: 'provider',
    });
    expect(failed).toMatchObject({
      phase: 'failed',
      outputs: [{ kind: 'image', state: 'ready', asset: image }],
      provider: { recovery: { terminalStatus: 'failed' } },
    });
    expect(
      await readContinuation({
        scope,
        continuationRef: receipt.continuationRef,
        execution,
      }),
    ).toMatchObject({ part: { thoughtSignature: 'partial-signature' } });
    expect((await media.getMediaThread(scope, job.threadId))?.cover).toEqual(image);
    expect(await media.prepareMediaAccountDeletion({ scope, token: 'after-failure' })).toBe(true);
  });

  it('recovers stale native recordings from known facts without replaying the chat call', async () => {
    const job = await start();
    await seedPart({
      scope,
      jobId: job.jobId,
      chunkIndex: 0,
      partIndex: 0,
      part: { kind: 'text', text: 'Known partial', thoughtSignature: 'private' },
      maxRetainers: 4,
    });
    const now = new Date(Date.now() + 60000).toISOString();
    expect(
      await native.reconcileMediaNativeRecordings({ scope, now, staleBefore: now, limit: 1 }),
    ).toBe(1);
    const stale = await media.getMediaJob(scope, job.jobId);
    expect(stale).toMatchObject({
      phase: 'requires_attention',
      outputs: [{ kind: 'text', text: 'Known partial' }],
    });
    expect(stale?.provider.recovery?.terminalStatus).toBeUndefined();
    expect(await media.claimMediaJob({ scope, now, workerId: 'worker', leaseMs: 1000 })).toBeNull();
    expect(
      (await native.failMediaNativeRecording({ scope, jobId: job.jobId, reason: 'provider' }))
        ?.phase,
    ).toBe('failed');
  });
});
