import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  tenantStorage,
  createResponseStorage,
  createManagedMessageId,
  createManagedConversationId,
  responseReference,
} from '@librechat/data-schemas';
import type { StoredResponseRecord, ResponseTerminalReceipt } from '@librechat/data-schemas';
import {
  createResponseCompletion,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { createResponseRetirement } from './retirement';
import { responseRootBinding } from './scope';

const owner = { userId: 'release-owner', tenantId: 'release-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
let jobs: GenerationJobManagerClass;
let server: MongoMemoryServer;
let storage: ReturnType<typeof createResponseStorage>;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  storage = createResponseStorage(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await scope(async () => {
    await mongoose.models.StoredResponse?.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
});
afterEach(async () => {
  await jobs.destroy();
  jest.restoreAllMocks();
});

async function publishTerminal(record: StoredResponseRecord, receipt: ResponseTerminalReceipt) {
  const current = (await storage.read(record, record.responseId))!;
  const staged = await storage.stageTerminal(
    current,
    current.responseId,
    { execution: current },
    receipt,
  );
  if (!staged.ok) throw new Error('Fixture terminal stage failed');
  const finished = await storage.finishTerminal(
    staged.record,
    record.responseId,
    staged.record.revision,
    receipt,
  );
  if (!finished.ok) throw new Error('Fixture terminal publication failed');
  return finished.record;
}

async function fixture(phase: 'running' | 'terminal' | 'drained' = 'drained') {
  const responseId = createManagedMessageId();
  const conversationId = createManagedConversationId();
  const reserved = await storage.reserve({
    ...owner,
    responseId,
    conversationId,
    agentId: 'agent',
    sourceKeyId: 'source',
    requestKey: responseId,
    requestJSON: '{}',
    fingerprint: 'fingerprint',
    parentMessageId: 'parent',
  });
  if (!reserved.ok) throw new Error('Reservation failed');
  const job = await jobs.createJob(responseId, owner.userId, conversationId, {
    initialMetadata: {
      endpoint: 'responses',
      agent_id: 'agent',
      responseMessageId: responseId,
      ...responseRootBinding(reserved.record),
    },
  });
  const providerExecutionId = job.metadata.providerExecutionId!;
  const enrolled = await storage.enrollExecution(
    reserved.record,
    { generationCreatedAt: job.createdAt, providerExecutionId },
    '{}',
  );
  if (!enrolled.ok) throw new Error('Enrollment failed');
  await jobs.beginProviderExecution(responseId, job.createdAt, providerExecutionId);
  if (phase !== 'running')
    await jobs.completeJob(responseId, undefined, job.createdAt, {
      expectedProviderExecutionId: providerExecutionId,
      persistencePending: true,
    });
  if (phase === 'drained')
    await jobs.markProviderExecutionDrained(responseId, job.createdAt, providerExecutionId, true);
  const record: StoredResponseRecord = { ...enrolled.record, status: 'completed' };
  if (phase === 'drained')
    await storage.settleExecution(
      responseReference(record),
      { generationCreatedAt: job.createdAt, providerExecutionId },
      'complete',
    );
  const receipt: ResponseTerminalReceipt = {
    generationCreatedAt: job.createdAt,
    providerExecutionId,
    status: 'completed',
    responseJSON: '{}',
  };
  if (phase !== 'running')
    expect((await jobs.getJob(responseId))?.metadata.terminalPersistencePending).toBe(true);
  if (phase === 'drained') await publishTerminal(record, receipt);
  return { record, receipt, release: createResponseExecutionRelease(jobs, storage) };
}

it('confirms a prepared result only after the exact persisted provider outcome and drain', () =>
  scope(async () => {
    const f = await fixture('running');
    const confirm = createResponseExecutionConfirmation(storage, jobs);
    expect(await confirm(f.record, f.receipt)).toBeNull();
    await jobs.completeJob(f.record.responseId, undefined, f.receipt.generationCreatedAt, {
      expectedProviderExecutionId: f.receipt.providerExecutionId,
      persistencePending: true,
    });
    expect(await confirm(f.record, f.receipt)).toBeNull();
    await jobs.markProviderExecutionDrained(
      f.record.responseId,
      f.receipt.generationCreatedAt,
      f.receipt.providerExecutionId,
      true,
    );
    expect(await confirm(f.record, f.receipt)).toBe('complete');
    expect(await storage.readExecutionProof(f.record)).toMatchObject({ outcome: 'complete' });
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
    await publishTerminal(f.record, f.receipt);
    await f.release(f.record, f.receipt);
    expect(await confirm(f.record, f.receipt)).toBe('complete');
  }));

it('does not turn a confirmation lookup outage into missing or successful drain proof', () =>
  scope(async () => {
    const f = await fixture();
    const failure = new Error('Injected Root proof lookup outage');
    jest.spyOn(storage, 'readExecutionProof').mockRejectedValueOnce(failure);
    await expect(
      createResponseExecutionConfirmation(storage, jobs)(f.record, f.receipt),
    ).rejects.toBe(failure);
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }));

it('rejects another provider owner when confirming a prepared result', () =>
  scope(async () => {
    const f = await fixture();
    await expect(
      createResponseExecutionConfirmation(storage, jobs)(f.record, {
        ...f.receipt,
        ownerId: 'different-owner',
      }),
    ).rejects.toThrow('identity changed');
  }));

it('releases exact post-publication terminal proof with production default cleanup enabled', () =>
  scope(async () => {
    const f = await fixture();
    await f.release(f.record, f.receipt);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    await expect(f.release(f.record, f.receipt)).resolves.toBeUndefined();
  }));

it('recovers cleanup when Mongo already published and removed its pending receipt', () =>
  scope(async () => {
    const f = await fixture();
    expect(f.record.pendingTerminal).toBeUndefined();
    await f.release(f.record);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
  }));

it.each([
  { userId: 'another-owner' },
  { tenantId: 'another-tenant' },
  { agentId: 'another-agent' },
  { conversationId: 'another-conversation' },
  { generationCreatedAt: 1 },
])('does not release another execution for mismatched record %j', (change) =>
  scope(async () => {
    const f = await fixture();
    await expect(
      createResponseExecutionConfirmation(storage, jobs)({ ...f.record, ...change }, f.receipt),
    ).rejects.toThrow();
    await expect(f.release({ ...f.record, ...change }, f.receipt)).rejects.toThrow();
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }),
);

it('does not release proof for another provider attempt', () =>
  scope(async () => {
    const f = await fixture();
    await expect(
      f.release(f.record, { ...f.receipt, providerExecutionId: 'another-provider' }),
    ).rejects.toThrow('identity changed');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }));

it('does not treat a rejected release acknowledgement as success', () =>
  scope(async () => {
    const f = await fixture();
    jest.spyOn(jobs, 'finishProviderTerminalPersistence').mockResolvedValueOnce(false);
    await expect(f.release(f.record, f.receipt)).rejects.toThrow('release is unavailable');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
    await f.release(f.record, f.receipt);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
  }));

it('retries job cleanup after the marker was cleared but deletion failed', () =>
  scope(async () => {
    const f = await fixture();
    jest
      .spyOn(jobs.getJobStore(), 'deleteJob')
      .mockRejectedValueOnce(new Error('transient deletion failure'));
    await expect(f.release(f.record, f.receipt)).rejects.toThrow('transient deletion failure');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).not.toBe(
      true,
    );
    await f.release(f.record);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
  }));

it.each(['owner_deleted', 'conversation_deleted', 'expired'] as const)(
  'releases only exact drained proof for a durable %s cleanup identity',
  (retirement) =>
    scope(async () => {
      const f = await fixture();
      await f.release({ ...f.record, status: 'in_progress', retirement }, f.receipt);
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    }),
);

it('retains confirmation after the transient generation has expired', () =>
  scope(async () => {
    const f = await fixture();
    await jobs.getJobStore().deleteJob(f.record.responseId);
    expect(await createResponseExecutionConfirmation(storage, jobs)(f.record, f.receipt)).toBe(
      'complete',
    );
    await expect(f.release(f.record, f.receipt)).resolves.toBeUndefined();
  }));
it('does not substitute a drained transient job for a missing physical Root', () =>
  scope(async () => {
    const f = await fixture();
    await mongoose.models.StoredResponse.deleteOne({ responseId: f.record.responseId });
    expect(
      await createResponseExecutionConfirmation(storage, jobs)(f.record, f.receipt),
    ).toBeNull();
    await expect(f.release(f.record, f.receipt)).rejects.toThrow(
      'durable release authority is unavailable',
    );
    const retire = createResponseRetirement({ storage, jobs });
    await expect(retire(f.record, f.record.responseId, f.record)).rejects.toThrow(
      'retirement identity unavailable',
    );
    await mongoose.models.ResponseScope.updateMany({}, { $set: { closed: true } });
    // Even closure cannot turn an absent started Root into provider/checkpoint proof.
    expect(await retire(f.record, f.record.responseId, f.record)).toBe('pending');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }));

it.each(['pending', 'settled'] as const)(
  'retirement requires durable %s checkpoint proof after transient job expiry',
  (state) =>
    scope(async () => {
      const f = await fixture('terminal');
      const checkpoint = storage.createCheckpointWriter(responseReference(f.record), {
        ...f.receipt,
        writerId: randomUUID(),
        namespace: `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`,
        configJSON: JSON.stringify({
          type: 'mongo',
          checkpointCollectionName: 'release_cp',
          checkpointWritesCollectionName: 'release_writes',
        }),
      });
      expect(await checkpoint.open()).toBe(true);
      if (state === 'settled') expect(await checkpoint.settle()).toBe(true);
      await storage.settleExecution(responseReference(f.record), f.receipt, 'complete');
      await mongoose.models.StoredResponse.updateOne(
        { responseId: f.record.responseId },
        { $set: { expiredAt: new Date(Date.now() - 1) } },
      );
      await jobs.getJobStore().deleteJob(f.record.responseId);
      const cleanup = jest.fn(async () => {});
      const retire = createResponseRetirement({ storage, jobs, cleanupCheckpoint: cleanup });
      expect(await retire(f.record, f.record.responseId)).toBe(
        state === 'settled' ? 'stopped' : 'pending',
      );
      expect(cleanup).toHaveBeenCalledTimes(state === 'settled' ? 1 : 0);
      expect(
        await mongoose.models.StoredResponse.findOne({ responseId: f.record.responseId }),
      ).toBeNull();
      const retained = await storage.readCleanupIdentity(f.record, f.record.responseId);
      if (state === 'settled') {
        expect(retained).toBeNull();
        expect(
          await mongoose.models.StoredResponse.collection.countDocuments({
            ...owner,
            responseId: f.record.responseId,
          }),
        ).toBe(0);
      } else {
        expect(retained).toMatchObject({
          retirement: 'expired',
          storageTarget: f.record.storageTarget,
        });
        expect(
          await mongoose.models.StoredResponse.collection.countDocuments({
            ...owner,
            responseId: f.record.responseId,
          }),
        ).toBe(1);
      }
    }),
);

it.each(['delete', 'acknowledgment'] as const)(
  'retains erasure authority and retries safely after checkpoint %s failure',
  (failure) =>
    scope(async () => {
      const f = await fixture('terminal');
      const namespace = `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`;
      const checkpoint = storage.createCheckpointWriter(responseReference(f.record), {
        ...f.receipt,
        writerId: randomUUID(),
        namespace,
        configJSON: JSON.stringify({
          type: 'mongo',
          checkpointCollectionName: 'erasure_retry_cp',
          checkpointWritesCollectionName: 'erasure_retry_writes',
        }),
      });
      expect(await checkpoint.open()).toBe(true);
      expect(await checkpoint.settle()).toBe(true);
      await jobs.markProviderExecutionDrained(
        f.record.responseId,
        f.receipt.generationCreatedAt,
        f.receipt.providerExecutionId,
        true,
      );
      expect(
        await storage.settleExecution(responseReference(f.record), f.receipt, 'complete'),
      ).toBe(true);
      const collection = mongoose.connection.db!.collection('erasure_retry_cp');
      await collection.insertOne({ namespace, private: 'checkpoint data' });
      await mongoose.models.StoredResponse.updateOne(
        { responseId: f.record.responseId },
        { $set: { expiredAt: new Date(0) } },
      );
      let first = true;
      const cleanup = jest.fn(async () => {
        if (failure === 'delete' && first) {
          first = false;
          throw new Error('Checkpoint delete failed');
        }
        await collection.deleteMany({ namespace });
      });
      if (failure === 'acknowledgment')
        jest.spyOn(storage, 'acknowledgeCheckpointErasure').mockResolvedValueOnce(false);
      const retire = createResponseRetirement({ storage, jobs, cleanupCheckpoint: cleanup });
      await expect(retire(f.record, f.record.responseId)).rejects.toThrow(
        failure === 'delete' ? 'Checkpoint delete failed' : 'erasure acknowledgment',
      );
      expect(
        await mongoose.models.StoredResponse.collection.countDocuments({
          responseId: f.record.responseId,
        }),
      ).toBe(1);
      expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
        true,
      );
      expect(await collection.countDocuments({ namespace })).toBe(failure === 'delete' ? 1 : 0);
      expect(await retire(f.record, f.record.responseId)).toBe('stopped');
      expect(await collection.countDocuments({ namespace })).toBe(0);
      expect(
        await mongoose.models.StoredResponse.collection.countDocuments({
          responseId: f.record.responseId,
        }),
      ).toBe(0);
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
      expect(cleanup).toHaveBeenCalledTimes(2);
    }),
);

it('never cleans an expired prepared result while checkpoint commands remain unresolved', () =>
  scope(async () => {
    const f = await fixture('terminal');
    const checkpoint = storage.createCheckpointWriter(responseReference(f.record), {
      ...f.receipt,
      writerId: randomUUID(),
      namespace: `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`,
      configJSON: JSON.stringify({
        type: 'mongo',
        checkpointCollectionName: 'unknown_cp',
        checkpointWritesCollectionName: 'unknown_writes',
      }),
    });
    expect(await checkpoint.open()).toBe(true);
    await storage.settleExecution(responseReference(f.record), f.receipt, 'complete');
    const expiredAt = new Date(Date.now() - 1);
    await mongoose.models.StoredResponse.updateOne(
      { responseId: f.record.responseId },
      { $set: { expiredAt } },
    );
    const cleanupCheckpoint = jest.fn(async () => {});
    const releaseExecution = jest.fn(createResponseExecutionRelease(jobs, storage));
    const completion = createResponseCompletion({
      storage,
      cleanupCheckpoint,
      releaseExecution,
      confirmExecution: createResponseExecutionConfirmation(storage, jobs),
    });
    const responseJSON = JSON.stringify({
      id: f.record.responseId,
      model: f.record.agentId,
      object: 'response',
      status: 'completed',
      output: [],
      background: true,
      store: true,
    });
    const retired = await completion.stageAndFinish(
      { ...f.record, expiredAt, status: 'in_progress' },
      { ...f.receipt, responseJSON },
    );
    expect(retired.retirement).toBe('expired');
    expect(retired.responseJSON).toBeUndefined();
    expect(retired.status).toBe('in_progress');
    expect(cleanupCheckpoint).not.toHaveBeenCalled();
    expect(releaseExecution).not.toHaveBeenCalled();
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }));

it('imports matching transient drain without clearing an unresolved checkpoint', () =>
  scope(async () => {
    const f = await fixture('terminal');
    const writer = storage.createCheckpointWriter(responseReference(f.record), {
      ...f.receipt,
      writerId: randomUUID(),
      namespace: `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`,
      configJSON: JSON.stringify({
        type: 'mongo',
        checkpointCollectionName: 'recovery_cp',
        checkpointWritesCollectionName: 'recovery_writes',
      }),
    });
    expect(await writer.open()).toBe(true);
    await jobs.markProviderExecutionDrained(
      f.record.responseId,
      f.receipt.generationCreatedAt,
      f.receipt.providerExecutionId,
      true,
    );
    const confirm = createResponseExecutionConfirmation(storage, jobs);
    expect(await confirm(f.record, f.receipt)).toBeNull();
    expect(await storage.readExecutionProof(f.record)).toBeNull();
    await expect(f.release(f.record, f.receipt)).rejects.toThrow(
      'durable release authority is unavailable',
    );
    expect(await writer.settle()).toBe(true);
    expect(await confirm(f.record, f.receipt)).toBe('complete');
  }));
it('rejects transient drain bound to a different physical Response incarnation', () =>
  scope(async () => {
    const f = await fixture('terminal');
    await jobs.markProviderExecutionDrained(
      f.record.responseId,
      f.receipt.generationCreatedAt,
      f.receipt.providerExecutionId,
      true,
    );
    await jobs
      .getJobStore()
      .updateJob(
        f.record.responseId,
        { responseRootIncarnation: randomUUID() },
        f.receipt.generationCreatedAt,
      );
    await expect(
      createResponseExecutionConfirmation(storage, jobs)(f.record, f.receipt),
    ).rejects.toThrow('identity changed');
    expect(await storage.readExecutionProof(f.record)).toBeNull();
  }));

it('releases a bound unused job when retirement fences its root before enrollment', () =>
  scope(async () => {
    const responseId = createManagedMessageId();
    const reserved = await storage.reserve({
      ...owner,
      responseId,
      conversationId: createManagedConversationId(),
      agentId: 'agent',
      requestKey: responseId,
      fingerprint: 'unused',
      requestJSON: '{}',
      parentMessageId: 'root',
    });
    if (!reserved.ok) throw new Error('Reservation failed');
    await jobs.createJob(responseId, owner.userId, reserved.record.conversationId, {
      initialMetadata: {
        endpoint: 'responses',
        agent_id: 'agent',
        responseMessageId: responseId,
        terminalPersistenceOwner: 'external',
        ...responseRootBinding(reserved.record),
      },
    });
    await mongoose.models.StoredResponse.updateOne(
      { responseId },
      { $set: { expiredAt: new Date(Date.now() - 1) } },
    );
    const retire = createResponseRetirement({ storage, jobs });
    expect(await retire(reserved.record, responseId)).toBe('stopped');
    expect(await jobs.getJob(responseId)).toBeUndefined();
    expect(await storage.readCleanupIdentity(reserved.record, responseId)).toBeNull();
    expect(
      await mongoose.models.StoredResponse.collection.countDocuments({ ...owner, responseId }),
    ).toBe(0);
  }));

it('requires canonical terminal publication before releasing a caller-projected terminal result', () =>
  scope(async () => {
    const f = await fixture('terminal');
    await jobs.markProviderExecutionDrained(
      f.record.responseId,
      f.receipt.generationCreatedAt,
      f.receipt.providerExecutionId,
      true,
    );
    await storage.settleExecution(responseReference(f.record), f.receipt, 'complete');
    const release = jest.spyOn(jobs, 'finishProviderTerminalPersistence');
    await expect(f.release(f.record, f.receipt)).rejects.toThrow(
      'release authority is unavailable',
    );
    await expect(
      f.release({ ...f.record, retirement: 'owner_deleted' }, f.receipt),
    ).rejects.toThrow('release authority is unavailable');
    expect(release).not.toHaveBeenCalled();
    await publishTerminal(f.record, f.receipt);
    await f.release(f.record, f.receipt);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await storage.readExecutionProof(f.record)).toMatchObject({
      releaseReady: true,
      releaseAcknowledged: true,
    });
  }));

it.each(['before_commit', 'after_commit'] as const)(
  'recovers a lost durable release acknowledgement %s after actual job cleanup',
  (failure) =>
    scope(async () => {
      const f = await fixture();
      const acknowledge = storage.acknowledgeExecutionRelease.bind(storage);
      const ack = jest
        .spyOn(storage, 'acknowledgeExecutionRelease')
        .mockImplementationOnce(async (...args) => {
          if (failure === 'after_commit') expect(await acknowledge(...args)).toBe(true);
          throw new Error('Injected durable release acknowledgement loss');
        });
      await expect(f.release(f.record, f.receipt)).rejects.toThrow('acknowledgement loss');
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
      ack.mockRestore();
      await expect(
        createResponseExecutionRelease(jobs, createResponseStorage(mongoose))(f.record, f.receipt),
      ).resolves.toBeUndefined();
      expect(await storage.readExecutionProof(f.record)).toMatchObject({
        releaseAcknowledged: true,
      });
    }),
);
