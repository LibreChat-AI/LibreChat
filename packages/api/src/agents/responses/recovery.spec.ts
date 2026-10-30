import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createResponseStorage,
  createModels,
  createMethods,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  ResponseStorage,
  StoredResponseRecord,
  ResponseTerminalReceipt,
} from '@librechat/data-schemas';
import { createBackgroundResponseService, buildPendingBackgroundResponse } from './background';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseCompletion } from './completion';
import { createResponseRetirement } from './retirement';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'completion-tenant' };
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  storage = createResponseStorage(mongoose);
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
    await mongoose.models.User.deleteMany({});
  });
  await scoped(async () => {
    await mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'completion-owner@example.com',
      provider: 'local',
    });
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function setup(): Promise<{
  record: StoredResponseRecord;
  receipt: ResponseTerminalReceipt;
}> {
  const reserved = await storage.reserve({
    ...owner,
    responseId: 'resp_completion',
    requestKey: 'original-request',
    fingerprint: 'original',
    agentId: 'agent',
    sourceKeyId: 'original-key',
    conversationId: 'conversation',
    parentMessageId: 'root',
    requestJSON: JSON.stringify({
      model: 'agent',
      input: 'Original input',
      background: true,
      store: true,
    }),
  });
  if (!reserved.ok) throw new Error('Reservation failed');
  const initial = {
    ...buildPendingBackgroundResponse(reserved.record),
    status: 'in_progress' as const,
  };
  const running = await storage.publish(owner, reserved.record.responseId, 0, {
    status: 'in_progress',
    generationCreatedAt: 10,
    responseJSON: JSON.stringify(initial),
  });
  if (!running.ok) throw new Error('Publication failed');
  const response = {
    ...initial,
    status: 'completed' as const,
    output: [
      {
        type: 'message',
        id: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'saved final answer', annotations: [] }],
      },
    ],
  };
  return {
    record: running.record,
    receipt: {
      generationCreatedAt: 10,
      providerExecutionId: 'provider',
      ownerId: 'winning-worker',
      status: 'completed',
      responseJSON: JSON.stringify(response),
      checkpointNamespace: 'owned-scope',
    },
  };
}

it('retains the exact completed answer across cleanup failure and a fresh recovery instance', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const cleanup = jest.fn(async () => {});
    cleanup.mockRejectedValueOnce(new Error('checkpoint unavailable'));
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: cleanup });
    await expect(completion.stageAndFinish(record, receipt)).rejects.toThrow(
      'checkpoint unavailable',
    );
    const pending = (await storage.read(owner, record.responseId))!;
    expect(pending).toMatchObject({ status: 'in_progress', pendingTerminal: receipt });
    expect(pending.responseJSON).not.toContain('saved final answer');
    const restarted = createResponseCompletion({
      storage: createResponseStorage(mongoose),
      cleanupCheckpoint: cleanup,
    });
    const complete = await restarted.finish(pending);
    expect(complete).toMatchObject({
      status: 'completed',
      responseJSON: receipt.responseJSON,
      requestKey: 'original-request',
    });
    expect(complete.pendingTerminal).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(2);
  }));

it('recovers initial-execution checkpoint cleanup without a review record or current deployment settings', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const namespace = createCheckpointNamespace(owner.userId, owner.tenantId);
    const sibling = createCheckpointNamespace(owner.userId, owner.tenantId);
    const settings = {
      type: 'mongo',
      checkpointCollectionName: 'initial_receipt_checkpoints',
      checkpointWritesCollectionName: 'initial_receipt_writes',
    };
    const savedReceipt = {
      ...receipt,
      checkpointNamespace: namespace,
      checkpointConfigJSON: JSON.stringify(settings),
    };
    const collections = [
      settings.checkpointCollectionName,
      settings.checkpointWritesCollectionName,
    ];
    for (const name of collections) {
      const collection = mongoose.connection.db!.collection(name);
      await collection.deleteMany({});
      await collection.insertMany(
        [namespace, sibling].map((scope) => ({
          thread_id: record.conversationId,
          checkpoint_ns: scope,
          checkpoint_id: scope,
        })),
      );
    }
    const unavailable = createResponseCompletion({
      storage,
      cleanupCheckpoint: async () => {
        throw new Error('checkpoint storage temporarily unavailable');
      },
    });
    await expect(unavailable.stageAndFinish(record, savedReceipt)).rejects.toThrow(
      'temporarily unavailable',
    );
    const pending = (await storage.read(owner, record.responseId))!;
    expect(pending.review).toBeUndefined();
    expect(pending.pendingTerminal).toEqual(savedReceipt);
    const restarted = createResponseCompletion({
      storage: createResponseStorage(mongoose),
      cleanupCheckpoint: cleanupResponseCheckpoint,
    });
    expect((await restarted.finish(pending)).status).toBe('completed');
    for (const name of collections) {
      const remaining = await mongoose.connection.db!.collection(name).find({}).toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].checkpoint_ns).toBe(sibling);
    }
  }));

it('retries terminal publication without losing the answer after cleanup already succeeded', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const cleanup = jest.fn(async () => {});
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: cleanup });
    jest
      .spyOn(storage, 'finishTerminal')
      .mockRejectedValueOnce(new Error('publication unavailable'));
    await expect(completion.stageAndFinish(record, receipt)).rejects.toThrow(
      'publication unavailable',
    );
    const pending = (await storage.read(owner, record.responseId))!;
    expect(pending.pendingTerminal?.responseJSON).toBe(receipt.responseJSON);
    expect((await completion.finish(pending)).responseJSON).toBe(receipt.responseJSON);
    expect(cleanup).toHaveBeenCalledTimes(2);
  }));

it('reconciles a lost finish acknowledgement and retries execution release on a later terminal read', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const finish = storage.finishTerminal.bind(storage);
    jest.spyOn(storage, 'finishTerminal').mockImplementationOnce(async (...args) => {
      await finish(...args);
      throw new Error('finish acknowledgement lost');
    });
    const release = jest.fn(async () => {});
    release.mockRejectedValueOnce(new Error('release transport unavailable'));
    const completion = createResponseCompletion({
      storage,
      cleanupCheckpoint: async () => {},
      releaseExecution: release,
    });
    await expect(completion.stageAndFinish(record, receipt)).rejects.toThrow(
      'release transport unavailable',
    );
    const published = (await storage.read(owner, record.responseId))!;
    expect(published.status).toBe('completed');
    expect(published.pendingTerminal).toBeUndefined();
    expect((await completion.finish(published)).responseJSON).toBe(receipt.responseJSON);
    expect(release).toHaveBeenCalledTimes(2);
  }));

it('reconciles a committed terminal stage whose acknowledgement was lost', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const stage = storage.stageTerminal.bind(storage);
    const spy = jest.spyOn(storage, 'stageTerminal').mockImplementationOnce(async (...args) => {
      await stage(...args);
      throw new Error('lost stage acknowledgement');
    });
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
    expect(await completion.stageAndFinish(record, receipt)).toMatchObject({
      status: 'completed',
      responseJSON: receipt.responseJSON,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  }));

it.each([false, true])(
  'stages by execution identity despite projection changes after provider drain (late Stop: %s)',
  (lateStop) =>
    scoped(async () => {
      const { record, receipt } = await setup();
      const projected = await storage.publish(owner, record.responseId, record.revision, {
        status: 'in_progress',
        responseJSON: JSON.stringify({
          ...JSON.parse(record.responseJSON!),
          recovery: 'execution_state_unavailable',
        }),
      });
      expect(projected.ok).toBe(true);
      if (lateStop) await storage.requestCancellation(owner, record.responseId, Date.now());
      const stage = jest.spyOn(storage, 'stageTerminal');
      const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
      const result = await completion.stageAndFinish(record, receipt);
      expect(result).toMatchObject({ status: 'completed', responseJSON: receipt.responseJSON });
      expect(stage).toHaveBeenCalledTimes(1);
    }),
);

it('does not replace another terminal receipt after a staging conflict', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const competing = { ...receipt, ownerId: 'another-worker' };
    expect(
      (await storage.stageTerminal(owner, record.responseId, record.revision, competing)).ok,
    ).toBe(true);
    const stage = jest.spyOn(storage, 'stageTerminal');
    const cleanup = jest.fn(async () => {});
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: cleanup });
    await expect(completion.stageAndFinish(record, receipt)).rejects.toThrow(
      'Response terminal receipt publication conflicted',
    );
    expect(stage).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect((await storage.read(owner, record.responseId))?.pendingTerminal).toEqual(competing);
  }));

it('does not retry a receipt from a different generation', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const stage = jest.spyOn(storage, 'stageTerminal');
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
    await expect(
      completion.stageAndFinish(
        { ...record, generationCreatedAt: 9 },
        { ...receipt, generationCreatedAt: 9 },
      ),
    ).rejects.toThrow('Response terminal receipt publication conflicted');
    expect(stage).toHaveBeenCalledTimes(1);
    expect((await storage.read(owner, record.responseId))?.pendingTerminal).toBeUndefined();
  }));

it.each(['provider', 'another-provider'])(
  'does not retry across a new review checkpoint owned by %s',
  (providerExecutionId) =>
    scoped(async () => {
      const { record, receipt } = await setup();
      const reviewed = await storage.publishReview(
        owner,
        record.responseId,
        record.revision,
        receipt.generationCreatedAt,
        {
          actionId: 'new-action',
          providerExecutionId,
          expiresAt: Date.now() + 60_000,
          partialResponseJSON: record.responseJSON!,
        },
        record.responseJSON!,
      );
      expect(reviewed.ok).toBe(true);
      const stage = jest.spyOn(storage, 'stageTerminal');
      const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
      await expect(completion.stageAndFinish(record, receipt)).rejects.toThrow(
        'Response terminal receipt publication conflicted',
      );
      expect(stage).toHaveBeenCalledTimes(1);
      expect((await storage.read(owner, record.responseId))?.pendingTerminal).toBeUndefined();
    }),
);

it.each([false, true])(
  'does not retry a terminal receipt after a new resume intent (admitted: %s)',
  (admitted) =>
    scoped(async () => {
      const { record, receipt } = await setup();
      const reviewed = await storage.publishReview(
        owner,
        record.responseId,
        record.revision,
        receipt.generationCreatedAt,
        {
          actionId: 'action',
          providerExecutionId: receipt.providerExecutionId,
          expiresAt: Date.now() + 60_000,
          partialResponseJSON: record.responseJSON!,
        },
        record.responseJSON!,
      );
      if (!reviewed.ok) throw new Error('Review publication failed');
      const reserved = await storage.reserveResume(
        owner,
        record.responseId,
        {
          generationCreatedAt: receipt.generationCreatedAt,
          intentId: 'intent',
          actionId: 'action',
          previousProviderExecutionId: receipt.providerExecutionId,
          providerExecutionId: 'next-provider',
          fingerprint: 'decision',
          resolutionJSON: '{}',
        },
        Date.now(),
      );
      expect(reserved.ok).toBe(true);
      if (admitted)
        expect(
          (
            await storage.admitResume(
              owner,
              record.responseId,
              'intent',
              receipt.generationCreatedAt,
              'next-provider',
              record.responseJSON!,
              Date.now(),
            )
          ).ok,
        ).toBe(true);
      const stage = jest.spyOn(storage, 'stageTerminal');
      const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
      await expect(completion.stageAndFinish(reviewed.record, receipt)).rejects.toThrow(
        'Response terminal receipt publication conflicted',
      );
      expect(stage).toHaveBeenCalledTimes(1);
      expect((await storage.read(owner, record.responseId))?.pendingTerminal).toBeUndefined();
    }),
);

it('lets authorized polling recover a saved result without queueing or observing execution', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    await storage.stageTerminal(owner, record.responseId, record.revision, receipt);
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
    const enqueue = jest.fn(async () => {
      throw new Error('No model redelivery');
    });
    const observe = jest.fn(async () => {
      throw new Error('Do not reconstruct progress');
    });
    const service = createBackgroundResponseService({
      storage,
      authorize: async () => true,
      enqueue,
      observe,
      resolveContinuation: async () => ({
        conversationId: 'conversation',
        parentMessageId: 'root',
      }),
      cancel: async () => {},
      recoverTerminal: completion.finish,
    });
    const result = await service.retrieve(owner, record.responseId);
    expect(result).toMatchObject({ ok: true, response: JSON.parse(receipt.responseJSON) });
    expect(enqueue).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  }));

it('does not let a late Stop overwrite the saved result or require a transient job to survive', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    await storage.stageTerminal(owner, record.responseId, record.revision, receipt);
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
    const getJob = jest.fn(async () => {
      throw new Error('Transient job may have expired');
    });
    const abortJob = jest.fn(async () => {
      throw new Error('No provider needs stopping');
    });
    const retire = createResponseRetirement({
      storage,
      jobs: { getJob, abortJob, finishProviderTerminalPersistence: jest.fn() },
      recoverTerminal: completion.finish,
    });
    expect(await retire(owner, record.responseId)).toBe('stopped');
    expect(await storage.read(owner, record.responseId)).toMatchObject({
      status: 'completed',
      responseJSON: receipt.responseJSON,
    });
    expect(getJob).not.toHaveBeenCalled();
    expect(abortJob).not.toHaveBeenCalled();
  }));

it('does not recover or disclose a saved reply after source authorization is revoked', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    await storage.stageTerminal(owner, record.responseId, record.revision, receipt);
    const recoverTerminal = jest.fn(async () => {
      throw new Error('Unauthorized recovery');
    });
    const cancel = jest.fn(async () => {});
    const service = createBackgroundResponseService({
      storage,
      authorize: async () => false,
      enqueue: async () => {},
      observe: async () => null,
      resolveContinuation: async () => ({
        conversationId: 'conversation',
        parentMessageId: 'root',
      }),
      cancel,
      recoverTerminal,
    });
    const denied = { ok: false, status: 404, code: 'response_not_found' };
    expect(await service.retrieve(owner, record.responseId)).toEqual(denied);
    expect(await service.cancel(owner, record.responseId)).toEqual(denied);
    expect(recoverTerminal).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect((await storage.read(owner, record.responseId))?.pendingTerminal).toEqual(receipt);
  }));

it('converges concurrent finishers on one immutable canonical result', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const staged = await storage.stageTerminal(owner, record.responseId, record.revision, receipt);
    if (!staged.ok) throw new Error('Stage failed');
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => completion.finish(staged.record)),
    );
    expect(
      results.every(
        (result) => result.status === 'completed' && result.responseJSON === receipt.responseJSON,
      ),
    ).toBe(true);
    expect((await storage.read(owner, record.responseId))?.revision).toBe(
      staged.record.revision + 1,
    );
  }));

it('rejects invalid receipt identity before it can poison the durable journal', () =>
  scoped(async () => {
    const { record, receipt } = await setup();
    const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
    await expect(
      completion.stageAndFinish(record, { ...receipt, responseJSON: 'not JSON' }),
    ).rejects.toThrow('Response terminal receipt is invalid');
    await expect(
      completion.stageAndFinish(record, { ...receipt, generationCreatedAt: 11 }),
    ).rejects.toThrow('Response terminal receipt identity changed');
    expect((await storage.read(owner, record.responseId))?.pendingTerminal).toBeUndefined();
  }));

it.each(['owner', 'conversation'] as const)(
  'discards a drained terminal payload after durable %s retirement without expiry',
  (kind) =>
    scoped(async () => {
      const { record, receipt } = await setup();
      const db = createMethods(mongoose);
      if (kind === 'owner') await db.deleteUserById(owner.userId);
      else await db.deleteConvos(owner.userId, { conversationId: record.conversationId });
      expect(await storage.read(owner, record.responseId)).toBeNull();
      const cleanup = jest.fn(async () => {});
      const release = jest.fn(async () => {});
      const completion = createResponseCompletion({
        storage,
        cleanupCheckpoint: cleanup,
        releaseExecution: release,
      });
      const retired = await completion.stageAndFinish(record, receipt);
      expect(retired).toMatchObject({
        status: 'completed',
        requestJSON: '',
        retirement: kind === 'owner' ? 'owner_deleted' : 'conversation_deleted',
      });
      expect(retired.responseJSON).toBeUndefined();
      expect(retired.pendingTerminal).toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(
        expect.objectContaining({
          retirement: kind === 'owner' ? 'owner_deleted' : 'conversation_deleted',
        }),
        receipt,
      );
      expect(await storage.read(owner, record.responseId)).toBeNull();
    }),
);

it.each(['owner', 'conversation'] as const)(
  'returns not found when an authorized read races %s retirement during recovery',
  (kind) =>
    scoped(async () => {
      const { record, receipt } = await setup();
      await storage.stageTerminal(owner, record.responseId, record.revision, receipt);
      const completion = createResponseCompletion({ storage, cleanupCheckpoint: async () => {} });
      const observe = jest.fn();
      const enqueue = jest.fn();
      const service = createBackgroundResponseService({
        storage,
        authorize: async () => true,
        observe,
        enqueue,
        resolveContinuation: async () => ({
          conversationId: record.conversationId,
          parentMessageId: 'root',
        }),
        cancel: async () => {},
        recoverTerminal: async (retained) => {
          const db = createMethods(mongoose);
          if (kind === 'owner') await db.deleteUserById(owner.userId);
          else await db.deleteConvos(owner.userId, { conversationId: record.conversationId });
          return completion.finish(retained);
        },
      });
      const result = await service.retrieve(owner, record.responseId);
      expect(result).toEqual({ ok: false, status: 404, code: 'response_not_found' });
      expect(JSON.stringify(result)).not.toContain('saved final answer');
      expect(observe).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    }),
);
