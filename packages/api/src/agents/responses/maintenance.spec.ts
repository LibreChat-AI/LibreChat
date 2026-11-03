import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createResponseStorage,
  createManagedMessageId,
  createManagedConversationId,
  responseReference,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import {
  createResponseCompletion,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { buildPendingBackgroundResponse } from './background';
import { enrollAgentExecution } from '../remote/lifecycle';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseDispatchOutbox } from './outbox';
import { createResponseRetirement } from './retirement';
import { createResponseRecovery } from './maintenance';

const owner = { userId: 'maintenance-owner', tenantId: 'maintenance-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
const engines = ['standalone', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];

describe.each(engines)('Response maintenance on %s', (engine) => {
  let mongo: MongoMemoryServer | undefined;
  let jobs: GenerationJobManagerClass;
  let storage: ResponseStorage;
  beforeAll(async () => {
    if (engine === 'standalone') mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `maintenance_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  beforeEach(async () => {
    storage = createResponseStorage(mongoose);
    await mongoose.connection.db!.dropDatabase();
    jobs = new GenerationJobManagerClass();
    jobs.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
    });
    jobs.initialize();
  });
  afterEach(async () => {
    await jobs.destroy();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  async function fixture(enroll = true) {
    const reserved = await storage.reserve({
      ...owner,
      responseId: createManagedMessageId(),
      conversationId: createManagedConversationId(),
      agentId: 'agent',
      sourceKeyId: 'key',
      requestKey: randomUUID(),
      fingerprint: randomUUID(),
      parentMessageId: 'root',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'private input',
        background: true,
        store: true,
      }),
      dispatch: true,
    });
    if (!reserved.ok) throw new Error('Reservation failed');
    let record = reserved.record;
    const execution = await enrollAgentExecution(
      {
        responseRoot: responseReference(record).target,
        runId: record.responseId,
        userId: record.userId,
        conversationId: record.conversationId,
        agentId: record.agentId,
        protocol: 'responses',
        retainTerminalPersistence: true,
        isPrincipalActive: async () => true,
      },
      { manager: jobs },
    );
    if (enroll) {
      const enrolled = await storage.enrollExecution(
        record,
        execution.getEnrollmentIdentity(),
        '{}',
      );
      if (!enrolled.ok) throw new Error('Enrollment failed');
      record = enrolled.record;
      await execution.beginProviderExecution();
      if (!(await storage.bindExecution(record, execution.getPersistenceIdentity())))
        throw new Error('Binding failed');
    }
    expect(
      await storage.settleDispatch(record, record.responseId, {
        kind: 'create',
        id: record.responseId,
      }),
    ).toBe(true);
    return { record, execution };
  }

  function maintenance(current = storage) {
    const completion = createResponseCompletion({
      storage: current,
      cleanupCheckpoint: cleanupResponseCheckpoint,
      confirmExecution: createResponseExecutionConfirmation(current, jobs),
      releaseExecution: createResponseExecutionRelease(jobs, current),
    });
    const retire = createResponseRetirement({
      storage: current,
      jobs,
      cleanupCheckpoint: cleanupResponseCheckpoint,
    });
    const enqueue = jest.fn(async () => {
      throw new Error('Recovery must not execute a provider');
    });
    const onError = jest.fn();
    const outbox = createResponseDispatchOutbox({
      storage: current,
      create: { enqueue, deliveryKey: () => 'not-used' },
      authorize: async () => true,
      retire: (record) => retire(record, record.responseId),
      recover: createResponseRecovery({ storage: current, jobs, completion }),
      onError,
      isReady: () => true,
    });
    return { outbox, enqueue, onError };
  }

  async function prepare(
    record: StoredResponseRecord,
    execution: Awaited<ReturnType<typeof enrollAgentExecution>>,
  ) {
    const receipt = {
      ...execution.getPersistenceIdentity(),
      status: 'completed' as const,
      responseJSON: JSON.stringify({
        ...buildPendingBackgroundResponse(record),
        status: 'completed',
        output: [{ type: 'message', content: 'private retained answer' }],
      }),
    };
    expect(
      (await storage.prepareTerminal(record, record.responseId, { execution: record }, receipt)).ok,
    ).toBe(true);
  }

  it('finishes a prepared answer and provider release after dispatch settled, without polling or executing again', () =>
    scope(async () => {
      const f = await fixture();
      await prepare(f.record, f.execution);
      await f.execution.settle();
      const page = await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1));
      expect(page.responses).toHaveLength(1);
      expect(Object.keys(page.responses[0]).sort()).toEqual([
        'responseId',
        'storageTarget',
        'tenantId',
        'userId',
      ]);
      expect(JSON.stringify(page)).not.toContain('private');
      const recovered = maintenance(createResponseStorage(mongoose));
      await recovered.outbox.recoverPending(1, { found: false });
      const current = (await storage.read(f.record, f.record.responseId))!;
      expect(current.status).toBe('completed');
      expect(current.responseJSON).toContain('private retained answer');
      expect(await storage.readExecutionProof(current)).toMatchObject({
        releaseAcknowledged: true,
      });
      expect(await jobs.getJob(current.responseId)).toBeUndefined();
      expect(
        (await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1))).responses,
      ).toEqual([]);
      expect(recovered.enqueue).not.toHaveBeenCalled();
      expect(recovered.onError).not.toHaveBeenCalled();
    }));

  it('retries provider release from the terminal Root after a fresh maintenance owner starts', () =>
    scope(async () => {
      const f = await fixture();
      await prepare(f.record, f.execution);
      await f.execution.settle();
      jest
        .spyOn(jobs, 'finishProviderTerminalPersistence')
        .mockRejectedValueOnce(new Error('Release unavailable'));
      const first = maintenance();
      await first.outbox.recoverPending(1, { found: false });
      expect((await storage.read(f.record, f.record.responseId))?.status).toBe('completed');
      expect(await storage.readExecutionProof(f.record)).toMatchObject({
        releaseAcknowledged: false,
      });
      expect(first.onError).toHaveBeenCalledTimes(1);
      const retry = maintenance(createResponseStorage(mongoose));
      await retry.outbox.recoverPending(1, { found: false });
      expect(await storage.readExecutionProof(f.record)).toMatchObject({
        releaseAcknowledged: true,
      });
      expect(retry.onError).not.toHaveBeenCalled();
      expect(retry.enqueue).not.toHaveBeenCalled();
    }));

  it('recovers a terminal never-started job whose Root enrollment never applied', () =>
    scope(async () => {
      const f = await fixture(false);
      await f.execution.settle(new Error('Enrollment unavailable'));
      const job = (await jobs.getJob(f.record.responseId))!;
      expect(job).toMatchObject({ status: 'error', metadata: { providerDrained: true } });
      expect(job.metadata.providerExecutionStartedId).toBeUndefined();
      const recovered = maintenance();
      await recovered.outbox.recoverPending(1, { found: false });
      const current = (await storage.read(f.record, f.record.responseId))!;
      expect(current).toMatchObject({ status: 'failed', generationCreatedAt: job.createdAt });
      expect(await storage.readExecutionProof(current)).toMatchObject({
        outcome: 'error',
        releaseAcknowledged: true,
      });
      expect(current.responseJSON).not.toContain('Enrollment unavailable');
      expect((await jobs.getJob(current.responseId))?.metadata.terminalPersistencePending).not.toBe(
        true,
      );
      expect(
        (await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1))).responses,
      ).toEqual([]);
      expect(recovered.onError).not.toHaveBeenCalled();
      expect(recovered.enqueue).not.toHaveBeenCalled();
    }));

  it('reclaims expired Roots after exact drain and release without disclosing their payload', () =>
    scope(async () => {
      const f = await fixture();
      await f.execution.settle();
      await mongoose.models.StoredResponse.updateOne(
        { responseId: f.record.responseId },
        { $set: { expiredAt: new Date(0) } },
      );
      expect(await storage.read(f.record, f.record.responseId)).toBeNull();
      const recovered = maintenance();
      await recovered.outbox.recoverPending(1, { found: false });
      expect(await storage.readCleanupIdentity(f.record, f.record.responseId)).toBeNull();
      expect(
        await mongoose.models.StoredResponse.collection.findOne({
          responseId: f.record.responseId,
        }),
      ).toBeNull();
      expect(recovered.enqueue).not.toHaveBeenCalled();
      expect(recovered.onError).not.toHaveBeenCalled();
    }));

  it('rotates past an unresolved retired writer and keeps its authority when an external write arrives later', () =>
    scope(async () => {
      const unresolved = await fixture();
      const job = (await jobs.getJob(unresolved.record.responseId))!;
      const binding = unresolved.execution.getPersistenceIdentity();
      const writer = storage.createCheckpointWriter(responseReference(unresolved.record), {
        ...binding,
        writerId: randomUUID(),
        namespace: job.metadata.checkpointNamespace!,
        configJSON: JSON.stringify({
          type: 'mongo',
          checkpointCollectionName: 'pending_cp',
          checkpointWritesCollectionName: 'pending_writes',
        }),
      });
      expect(await writer.open()).toBe(true);
      await unresolved.execution.settle();
      const settled = await unresolved.execution.confirmTerminalIdentity();
      expect(
        await storage.settleExecution(
          responseReference(unresolved.record),
          settled,
          settled.outcome,
        ),
      ).toBe(true);
      await jobs.getJobStore().deleteJob(unresolved.record.responseId, job.createdAt);
      await mongoose.models.StoredResponse.updateOne(
        { responseId: unresolved.record.responseId },
        { $set: { expiredAt: new Date(0) } },
      );
      const next = await fixture();
      await prepare(next.record, next.execution);
      await next.execution.settle();
      const recovered = maintenance();
      await recovered.outbox.recoverPending(1, { found: false });
      expect(
        await storage.readCleanupIdentity(unresolved.record, unresolved.record.responseId),
      ).toMatchObject({ retirement: 'expired' });
      expect(await storage.readExecutionProof(unresolved.record)).toBeNull();
      expect(await mongoose.connection.db!.collection('pending_cp').countDocuments()).toBe(0);
      // A potentially applied external upsert may still arrive after an empty read.
      // Only the exact writer can settle this uncertainty; absence is not an ACK.
      await mongoose.connection.db!.collection('pending_cp').insertOne({
        thread_id: unresolved.record.conversationId,
        checkpoint_ns: job.metadata.checkpointNamespace,
        payload: 'delayed private checkpoint',
      });
      await recovered.outbox.recoverPending(1, { found: false });
      expect((await storage.read(next.record, next.record.responseId))?.status).toBe('completed');
      expect(
        await storage.readCleanupIdentity(unresolved.record, unresolved.record.responseId),
      ).not.toBeNull();
      expect(await mongoose.connection.db!.collection('pending_cp').countDocuments()).toBe(1);
      expect(recovered.enqueue).not.toHaveBeenCalled();
      expect(recovered.onError).not.toHaveBeenCalled();
    }));

  it('releases a never-started attempt when Stop wins the queued Root before enrollment', () =>
    scope(async () => {
      const f = await fixture(false);
      await f.execution.settle(new Error('Enrollment unavailable'));
      expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
        true,
      );
      const stop = createResponseRetirement({
        storage,
        jobs,
        cleanupCheckpoint: cleanupResponseCheckpoint,
      });
      expect(await stop(f.record, f.record.responseId)).toBe('stopped');
      const cancelled = (await storage.read(f.record, f.record.responseId))!;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.generationCreatedAt).toBeUndefined();
      const recovered = maintenance(createResponseStorage(mongoose));
      await recovered.outbox.recoverPending(1, { found: false });
      expect(
        (await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending,
      ).not.toBe(true);
      expect(recovered.onError).not.toHaveBeenCalled();
      expect(recovered.enqueue).not.toHaveBeenCalled();
    }));

  it('does not invent a result or drain proof from an absent started job', () =>
    scope(async () => {
      const f = await fixture();
      await jobs.getJobStore().deleteJob(f.record.responseId, f.execution.createdAt);
      const recovered = maintenance();
      await recovered.outbox.recoverPending(1, { found: false });
      expect((await storage.read(f.record, f.record.responseId))?.status).toBe('in_progress');
      expect(await storage.readExecutionProof(f.record)).toBeNull();
      expect(recovered.onError).not.toHaveBeenCalled();
      expect(recovered.enqueue).not.toHaveBeenCalled();
    }));
});
