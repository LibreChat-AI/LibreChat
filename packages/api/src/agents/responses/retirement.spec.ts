import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { ResponseStorage } from '@librechat/data-schemas';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createResponseCompletion, createResponseExecutionRelease } from './completion';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { buildPendingBackgroundResponse } from './background';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponseRetirement } from './retirement';

const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'stop-tenant' };
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let jobs: GenerationJobManagerClass;

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
  });
  await scoped(async () => {
    await mongoose.models.User.deleteMany({});
    await mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'stop-owner@example.com',
      provider: 'local',
    });
  });
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
  });
  jobs.initialize();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await jobs.destroy();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function fixture() {
  const responseId = 'resp_running_stop';
  const execution = await enrollAgentExecution(
    {
      runId: responseId,
      userId: owner.userId,
      conversationId: 'conversation',
      agentId: 'agent',
      protocol: 'responses',
      retainTerminalPersistence: true,
      isPrincipalActive: async () => true,
    },
    { manager: jobs },
  );
  const reserved = await storage.reserve({
    ...owner,
    responseId,
    requestKey: 'original-request',
    fingerprint: 'original',
    agentId: 'agent',
    sourceKeyId: 'original-key',
    conversationId: 'conversation',
    parentMessageId: 'root',
    requestJSON: JSON.stringify({ model: 'agent', input: 'Test', background: true, store: true }),
  });
  if (!reserved.ok) throw new Error('Reservation failed');
  const running = await storage.publish(owner, responseId, 0, {
    status: 'in_progress',
    generationCreatedAt: execution.createdAt,
    responseJSON: JSON.stringify({
      ...buildPendingBackgroundResponse(reserved.record),
      status: 'in_progress',
    }),
  });
  if (!running.ok) throw new Error('Publication failed');
  await execution.beginProviderExecution();
  const completion = createResponseCompletion({
    storage,
    cleanupCheckpoint: async () => {},
    releaseExecution: createResponseExecutionRelease(jobs),
  });
  const retire = createResponseRetirement({
    storage,
    jobs,
    recoverTerminal: completion.finish,
  });
  /** Force the live failure ordering: provider settles before abort's chat publication. */
  const abort = jobs.abortJob.bind(jobs);
  jest.spyOn(jobs, 'abortJob').mockImplementationOnce((id, options) =>
    abort(id, {
      ...options,
      beforePublish: async (result) => {
        expect(execution.signal.aborted).toBe(true);
        await execution.settle();
        expect((await jobs.getJob(id))?.metadata.providerDrained).toBe(true);
        await options?.beforePublish?.(result);
      },
    }),
  );
  return { execution, responseId, retire, completion };
}

it('retains a running Stop after provider drain until canonical cancellation releases it with default cleanup', () =>
  scoped(async () => {
    const f = await fixture();
    const publishChat = jest.spyOn(jobs, 'publishTerminalClaim');
    const stage = storage.stageTerminal.bind(storage);
    jest.spyOn(storage, 'stageTerminal').mockImplementationOnce(async (...args) => {
      expect(await jobs.getJob(f.responseId)).toMatchObject({
        status: 'aborted',
        createdAt: f.execution.createdAt,
        metadata: { providerDrained: true, terminalPersistencePending: true },
      });
      expect(await storage.read(owner, f.responseId)).toMatchObject({
        status: 'in_progress',
        cancellationRequestedAt: expect.any(Number),
      });
      return stage(...args);
    });
    expect(await f.retire(owner, f.responseId)).toBe('stopped');
    expect(publishChat).not.toHaveBeenCalled();
    expect((await storage.read(owner, f.responseId))?.status).toBe('cancelled');
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
    expect(await f.retire(owner, f.responseId)).toBe('stopped');
  }));

it('drains expired work through metadata identity without publishing private cancellation output', () =>
  scoped(async () => {
    const f = await fixture();
    await mongoose.models.StoredResponse.updateOne(
      { responseId: f.responseId },
      {
        $set: { expiredAt: new Date(Date.now() - 1) },
      },
    );
    expect(await storage.read(owner, f.responseId)).toBeNull();
    const stage = jest.spyOn(storage, 'stageTerminal');
    const release = jest.spyOn(jobs, 'finishProviderTerminalPersistence');
    expect(await f.retire(owner, f.responseId)).toBe('stopped');
    expect(stage).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.execution.signal.aborted).toBe(true);
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
    expect(await storage.read(owner, f.responseId)).toBeNull();
  }));

it('keeps drained Stop proof through canonical receipt failure and retry without executing again', () =>
  scoped(async () => {
    const f = await fixture();
    jest.spyOn(storage, 'stageTerminal').mockRejectedValue(new Error('receipt unavailable'));
    await expect(f.retire(owner, f.responseId)).rejects.toThrow('receipt unavailable');
    expect(await jobs.getJob(f.responseId)).toMatchObject({
      status: 'aborted',
      metadata: { providerDrained: true, terminalPersistencePending: true },
    });
    jest.mocked(storage.stageTerminal).mockRestore();
    expect(await f.retire(owner, f.responseId)).toBe('stopped');
    expect((await storage.read(owner, f.responseId))?.status).toBe('cancelled');
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
  }));

it('drains through the retained journal after conversation erasure closes admission', () =>
  scoped(async () => {
    const f = await fixture();
    createModels(mongoose);
    await mongoose.models.Conversation.create({
      conversationId: 'conversation',
      user: owner.userId,
      tenantId: owner.tenantId,
      endpoint: 'agents',
    });
    const db = createMethods(mongoose);
    await db.deleteConvos(
      owner.userId,
      { conversationId: 'conversation' },
      {
        beforeDelete: async () => {
          expect((await storage.read(owner, f.responseId))?.cancellationRequestedAt).toEqual(
            expect.any(Number),
          );
          expect(await f.retire(owner, f.responseId)).toBe('stopped');
        },
      },
    );
    expect(await storage.read(owner, f.responseId)).toBeNull();
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
  }));

it('does not relabel an already-completed provider as cancelled before its canonical publication', () =>
  scoped(async () => {
    const f = await fixture();
    await f.execution.settle();
    const stage = jest.spyOn(storage, 'stageTerminal');
    expect(await f.retire(owner, f.responseId)).toBe('pending');
    expect(stage).not.toHaveBeenCalled();
    expect((await jobs.getJob(f.responseId))?.status).toBe('complete');
    expect((await storage.read(owner, f.responseId))?.status).toBe('in_progress');
  }));

it('repeated Stop recovers a running runtime receipt failure without a paused review or a new execution', () =>
  scoped(async () => {
    const f = await fixture();
    await storage.requestCancellation(owner, f.responseId, Date.now());
    await jobs.abortJob(f.responseId, {
      expectedCreatedAt: f.execution.createdAt,
      awaitProviderDrain: true,
      retainTerminalPersistence: true,
    });
    const identity = await f.execution.confirmTerminalIdentity();
    expect(identity.outcome).toBe('aborted');
    const record = (await storage.read(owner, f.responseId))!;
    expect(record.review).toBeUndefined();
    jest.spyOn(storage, 'stageTerminal').mockRejectedValueOnce(new Error('runtime receipt failed'));
    await expect(
      f.completion.stageAndFinish(record, {
        ...identity,
        status: 'cancelled',
        responseJSON: JSON.stringify({
          ...buildPendingBackgroundResponse(record),
          status: 'cancelled',
        }),
      }),
    ).rejects.toThrow('runtime receipt failed');
    expect((await storage.read(owner, f.responseId))?.pendingTerminal).toBeUndefined();
    expect((await jobs.getJob(f.responseId))?.metadata.terminalPersistencePending).toBe(true);
    expect(await f.retire(owner, f.responseId)).toBe('stopped');
    expect((await storage.read(owner, f.responseId))?.status).toBe('cancelled');
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
  }));

it('preserves ordinary abort publication and default cleanup when retention is not requested', () =>
  scoped(async () => {
    const f = await fixture();
    const publishChat = jest.spyOn(jobs, 'publishTerminalClaim');
    expect(await jobs.abortJob(f.responseId, { awaitProviderDrain: true })).toMatchObject({
      success: true,
      finalEvent: { aborted: true },
    });
    expect(publishChat).toHaveBeenCalledTimes(1);
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
    await expect(f.execution.confirmTerminalIdentity()).rejects.toThrow(
      'terminal settlement could not be confirmed',
    );
  }));

it('rejects retained abort on unsupported stores before changing the owned generation', () =>
  scoped(async () => {
    const f = await fixture();
    Object.defineProperty(jobs.getJobStore(), 'providerTerminalPersistence', {
      value: false,
      configurable: true,
    });
    await expect(f.retire(owner, f.responseId)).rejects.toThrow('barrier is unavailable');
    expect((await jobs.getJob(f.responseId))?.status).toBe('running');
    expect(f.execution.signal.aborted).toBe(false);
    Object.defineProperty(jobs.getJobStore(), 'providerTerminalPersistence', { value: true });
    await f.execution.settle();
  }));

it('releases retained provider proof through the complete fallback recovery', () =>
  scoped(async () => {
    const f = await fixture();
    const retire = createResponseRetirement({ storage, jobs, cleanupCheckpoint: async () => {} });
    expect(await retire(owner, f.responseId)).toBe('stopped');
    expect((await storage.read(owner, f.responseId))?.status).toBe('cancelled');
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
    expect(await retire(owner, f.responseId)).toBe('stopped');
  }));

it('keeps the fallback retention barrier until failed checkpoint cleanup is retried', () =>
  scoped(async () => {
    const f = await fixture();
    await f.execution.settle();
    const record = (await storage.read(owner, f.responseId))!;
    const job = (await jobs.getJob(f.responseId))!;
    const receipt = {
      generationCreatedAt: f.execution.createdAt,
      providerExecutionId: job.metadata.providerExecutionId!,
      ownerId: job.metadata.providerExecutionOwnerId,
      status: 'completed' as const,
      responseJSON: JSON.stringify({
        ...buildPendingBackgroundResponse(record),
        status: 'completed',
      }),
      checkpointNamespace: 'owned-scope',
      checkpointConfigJSON: '{"pinned":true}',
    };
    expect(
      (await storage.stageTerminal(owner, f.responseId, { execution: record }, receipt)).ok,
    ).toBe(true);
    const cleanup = jest.fn(async () => {});
    cleanup.mockRejectedValueOnce(new Error('checkpoint unavailable'));
    const retire = createResponseRetirement({ storage, jobs, cleanupCheckpoint: cleanup });
    await expect(retire(owner, f.responseId)).rejects.toThrow('checkpoint unavailable');
    expect((await jobs.getJob(f.responseId))?.metadata.terminalPersistencePending).toBe(true);
    expect((await storage.read(owner, f.responseId))?.pendingTerminal).toEqual(receipt);
    expect(await retire(owner, f.responseId)).toBe('stopped');
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(await jobs.getJob(f.responseId)).toBeUndefined();
  }));

it.each(['owner', 'conversation'] as const)(
  'drains a retained provider after %s erasure without an expiry deadline',
  (kind) =>
    scoped(async () => {
      const f = await fixture();
      const db = createMethods(mongoose);
      if (kind === 'owner') await db.deleteUserById(owner.userId);
      else await db.deleteConvos(owner.userId, { conversationId: 'conversation' });
      expect(await storage.read(owner, f.responseId)).toBeNull();
      const job = (await jobs.getJob(f.responseId))!;
      expect(
        await storage.readCleanupIdentity(owner, f.responseId, {
          ...owner,
          responseId: f.responseId,
          agentId: 'agent',
          conversationId: 'conversation',
          generationCreatedAt: job.createdAt,
        }),
      ).toMatchObject({ retirement: kind === 'owner' ? 'owner_deleted' : 'conversation_deleted' });
      expect(await f.retire(owner, f.responseId)).toBe('stopped');
      expect(await jobs.getJob(f.responseId)).toBeUndefined();
      expect(await storage.read(owner, f.responseId)).toBeNull();
    }),
);
