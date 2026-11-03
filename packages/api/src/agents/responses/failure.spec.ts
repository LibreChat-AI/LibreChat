import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createResponseStorage,
  createManagedMessageId,
  createManagedConversationId,
  responseReference,
  responseReceiptKey,
  tenantStorage,
} from '@librechat/data-schemas';
import type {
  ChannelRunRecord,
  StoredResponseRecord,
  ResponseTerminalReceipt,
} from '@librechat/data-schemas';
import type { StoredResponseMessage } from './persistence';
import {
  createResponseCompletion,
  createResponseExecutionConfirmation,
  createResponseExecutionRelease,
} from './completion';
import { buildPendingBackgroundResponse, createBackgroundResponseService } from './background';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createChannelResponseProjection } from '~/channels/responses';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { normalizeResponseTurnIntent } from './turnProjection';
import { createBackgroundResponseHttpHandlers } from './http';
import { resolveResponseContinuation } from './persistence';
import { createResponseRecovery } from './maintenance';
import { createAgentRunEnvelope } from '../envelope';
import { responseRootBinding } from './scope';

const owner = { userId: 'failure-owner', tenantId: 'failure-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
const engines = ['standalone', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];

describe.each(engines)('permanent Response publication failure on %s', (engine) => {
  let server: MongoMemoryServer | undefined;
  let storage: ReturnType<typeof createResponseStorage>;
  let jobs: GenerationJobManagerClass;
  const cleanupCheckpoint = jest.fn(async () => {});
  beforeAll(async () => {
    if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `failure_${randomUUID().replace(/-/g, '')}`,
    });
  });
  beforeEach(() => {
    storage = createResponseStorage(mongoose);
    cleanupCheckpoint.mockClear();
    jobs = new GenerationJobManagerClass();
    jobs.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    jobs.initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await jobs.destroy();
    await mongoose.connection.db!.dropDatabase();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  const completion = () =>
    createResponseCompletion({
      storage,
      cleanupCheckpoint,
      confirmExecution: createResponseExecutionConfirmation(storage, jobs),
      releaseExecution: createResponseExecutionRelease(jobs, storage),
    });
  async function fixture(drained = true, withCheckpoint = false, stage = true) {
    const reserved = await storage.reserve({
      ...owner,
      responseId: createManagedMessageId(),
      conversationId: createManagedConversationId(),
      agentId: 'agent',
      requestKey: 'channel:run',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'Confirmed user input',
        background: true,
        store: true,
      }),
      fingerprint: 'fingerprint',
      dispatch: true,
      parentMessageId: 'root',
    });
    if (!reserved.ok) throw new Error('Reservation failed');
    const job = await jobs.createJob(
      reserved.record.responseId,
      owner.userId,
      reserved.record.conversationId,
      {
        initialMetadata: {
          endpoint: 'responses',
          agent_id: 'agent',
          responseMessageId: reserved.record.responseId,
          ...responseRootBinding(reserved.record),
        },
      },
    );
    const binding = {
      generationCreatedAt: job.createdAt,
      providerExecutionId: job.metadata.providerExecutionId!,
    };
    const enrolled = await storage.enrollExecution(reserved.record, binding, '{}');
    if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
      throw new Error('Enrollment failed');
    if (
      !(await jobs.beginProviderExecution(
        reserved.record.responseId,
        job.createdAt,
        binding.providerExecutionId,
      ))
    )
      throw new Error('Provider start failed');
    const seeded = await storage.prepareConversation(enrolled.record, binding, {
      context: { userId: owner.userId },
      conversation: {
        conversationId: reserved.record.conversationId,
        agent_id: 'agent',
        endpoint: 'agents',
      },
      initialAgentId: 'agent',
    });
    if (!seeded.ok) throw new Error('Conversation seed failed');
    const record = seeded.record;
    const inputId = randomUUID();
    const receipt: ResponseTerminalReceipt = {
      ...binding,
      status: 'completed',
      responseJSON: JSON.stringify({
        ...buildPendingBackgroundResponse(record),
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'answer',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'Confirmed answer', annotations: [], logprobs: [] },
            ],
          },
        ],
      }),
      turnJSON: normalizeResponseTurnIntent(
        record,
        JSON.stringify({
          version: 1,
          context: { userId: owner.userId },
          conversation: {
            conversationId: record.conversationId,
            agent_id: record.agentId,
            endpoint: 'agents',
          },
          initialAgentId: record.agentId,
          inputs: [{ index: 0, messageId: inputId, parentMessageId: 'root' }],
          parentMessageId: inputId,
          trace: {},
        }),
      ),
    };
    async function drain() {
      await jobs.completeJob(record.responseId, undefined, job.createdAt, {
        expectedProviderExecutionId: binding.providerExecutionId,
        persistencePending: true,
      });
      await jobs.markProviderExecutionDrained(
        record.responseId,
        job.createdAt,
        binding.providerExecutionId,
        true,
      );
      expect((await jobs.getJob(record.responseId))?.metadata.terminalPersistencePending).toBe(
        true,
      );
    }
    const writer = withCheckpoint
      ? storage.createCheckpointWriter(responseReference(record), {
          ...binding,
          writerId: randomUUID(),
          namespace: `${checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId)}${randomUUID()}`,
          configJSON: JSON.stringify({
            type: 'mongo',
            checkpointCollectionName: 'failure_cp',
            checkpointWritesCollectionName: 'failure_cpw',
          }),
        })
      : undefined;
    if (writer && !(await writer.open())) throw new Error('Checkpoint open failed');
    const staged = stage
      ? await storage.stageTerminal(record, record.responseId, { execution: record }, receipt)
      : undefined;
    if (staged && !staged.ok) throw new Error('Stage failed');
    if (drained) await drain();
    return { record: staged?.record ?? record, receipt, binding, drain, writer };
  }
  async function markFailure(f: Awaited<ReturnType<typeof fixture>>) {
    const saved = await storage.recordPersistenceFailure(f.record, {
      ...f.binding,
      code: 'target_retired',
      receiptKey: responseReceiptKey(f.receipt),
    });
    if (!saved.ok) throw new Error('Failure recording conflicted');
    return saved.record;
  }
  function interceptOutput(record: StoredResponseRecord, work: () => Promise<void>, after = false) {
    const collection = mongoose.models.Message.collection;
    const original = collection.findOneAndUpdate.bind(collection);
    let intercepted = false;
    return jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
      const update = args[1];
      if (!intercepted && !Array.isArray(update) && update.$set?.messageId === record.responseId) {
        intercepted = true;
        if (after) {
          const result = await original(...args);
          await work();
          return result;
        }
        await work();
      }
      return original(...args);
    });
  }
  it.each([false, true])(
    'continues confirmed history after terminal failure=%s without exposing its target map',
    (failure) =>
      scope(async () => {
        const f = await fixture();
        const enqueue = jest.fn(async () => {});
        const resolveContinuation = jest.fn(async () => {
          const continuation = await resolveResponseContinuation(
            f.record.responseId,
            owner.userId,
            {
              getMessage: async (filter) =>
                mongoose.models.Message.findOne(filter).lean<StoredResponseMessage>(),
            },
          );
          const conversation = await storage.readConversationTarget(
            owner,
            continuation.conversationId,
          );
          if (!conversation) throw new Error('Missing canonical conversation');
          return { ...continuation, conversationTarget: conversation.target };
        });
        const service = createBackgroundResponseService({
          storage,
          authorize: async () => true,
          enqueue,
          resolveContinuation,
          observe: async () => null,
          recoverTerminal: completion().finish,
          cancel: async () => {},
        });
        const envelope = createAgentRunEnvelope({
          protocol: 'responses',
          requestId: randomUUID(),
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: {
            model: 'agent',
            input: 'Follow up',
            background: true,
            previous_response_id: f.record.responseId,
          },
        });
        expect(await service.create(envelope)).toMatchObject({
          ok: false,
          status: 409,
          code: 'response_continuation_unavailable',
        });
        expect(resolveContinuation).not.toHaveBeenCalled();
        if (failure) {
          interceptOutput(
            f.record,
            async () => {
              throw new Error('Injected lost publication reply');
            },
            true,
          );
          await expect(completion().finish(f.record)).rejects.toThrow('lost publication reply');
          await completion().finish(await markFailure(f));
        } else await completion().finish(f.record);
        const prior = await storage.readContinuation(owner, f.record.responseId);
        expect(prior?.status).toBe(failure ? 'failed' : 'completed');
        expect(prior?.canonicalTargets).toBeUndefined();
        expect(
          await storage.readContinuation({ ...owner, userId: 'other' }, f.record.responseId),
        ).toBeNull();
        expect(await service.create(envelope)).toMatchObject({
          ok: true,
          response: { status: 'queued' },
        });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: f.record.conversationId,
            parentMessageId: f.record.responseId,
            conversationTarget: f.record.conversationTarget,
          }),
        );
        resolveContinuation.mockResolvedValueOnce({
          conversationId: f.record.conversationId,
          parentMessageId: f.record.responseId,
          conversationTarget: { ...f.record.conversationTarget!, id: '0'.repeat(24) },
        });
        expect(await service.create(envelope)).toMatchObject({
          ok: false,
          status: 409,
          code: 'response_continuation_unavailable',
        });
        expect(enqueue).toHaveBeenCalledTimes(1);
      }),
  );
  it('rejects oversized background HTTP input before allocating a Root or queueing work', () =>
    scope(async () => {
      const enqueue = jest.fn(async () => {});
      const onError = jest.fn();
      const service = createBackgroundResponseService({
        storage,
        recoverTerminal: completion().finish,
        authorize: async () => true,
        enqueue,
        resolveContinuation: async () => ({
          conversationId: createManagedConversationId(),
          parentMessageId: 'root',
        }),
        observe: async () => null,
        cancel: async () => {},
      });
      const handlers = createBackgroundResponseHttpHandlers({
        service: () => service,
        ordinary: {
          create: (_req, res) => {
            res.sendStatus(418);
          },
          retrieve: (_req, res) => {
            res.sendStatus(418);
          },
        },
        onError,
      });
      const app = express();
      app.use(express.json({ limit: '50mb' }));
      app.use((req, _res, next) => {
        Object.assign(req, {
          user: { id: owner.userId, tenantId: owner.tenantId },
          apiKeyId: 'key',
        });
        tenantStorage.run(owner, next);
      });
      app.post('/responses', handlers.create);
      const rejected = await request(app)
        .post('/responses')
        .send({
          model: 'agent',
          input: 'é'.repeat(8 * 1024 * 1024),
          background: true,
          store: true,
        });
      expect(rejected.status).toBe(413);
      expect(rejected.body).toMatchObject({
        error: { code: 'document_limit', type: 'invalid_request' },
      });
      expect(JSON.stringify(rejected.body)).not.toContain('é');
      expect(await mongoose.models.StoredResponse.collection.countDocuments({})).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }));
  it('finishes a missing registered target, preserves confirmed input, and reports failure through HTTP and Channels', () =>
    scope(async () => {
      const f = await fixture();
      interceptOutput(f.record, async () => {
        const root = await mongoose.models.StoredResponse.findById(f.record.storageTarget!.id)
          .select('+canonicalTargets')
          .lean<StoredResponseRecord>();
        const selected = root!.canonicalTargets!.find(
          (entry) => entry.logicalId === f.record.responseId,
        )!;
        await mongoose.models.Message.deleteOne({ _id: selected.target.id });
      });
      const finished = await completion().finish(f.record);
      expect(finished).toMatchObject({
        status: 'failed',
        persistenceFailure: { code: 'target_retired' },
      });
      const view = JSON.parse(finished.responseJSON!);
      expect(view).toMatchObject({
        id: f.record.responseId,
        status: 'failed',
        output: [],
        error: { code: 'response_persistence_failed' },
        background: true,
        store: true,
      });
      expect(JSON.stringify(view)).not.toContain('Confirmed answer');
      expect(await mongoose.models.Message.find({ user: owner.userId }).lean()).toMatchObject([
        { text: 'Confirmed user input' },
      ]);
      expect(await mongoose.models.Conversation.countDocuments({ user: owner.userId })).toBe(1);
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
      expect(await storage.read(f.record, f.record.responseId)).toMatchObject({
        status: 'failed',
        releaseAcknowledged: true,
      });
      const enqueue = jest.fn(async () => {});
      const service = createBackgroundResponseService({
        storage,
        recoverTerminal: completion().finish,
        authorize: async () => true,
        enqueue,
        resolveContinuation: async () => {
          throw new Error('Must not rebuild');
        },
        observe: async () => null,
        cancel: async () => {},
      });
      const handlers = createBackgroundResponseHttpHandlers({
        service: () => service,
        ordinary: {
          create: (_req, res) => {
            res.sendStatus(418);
          },
          retrieve: (_req, res) => {
            res.sendStatus(418);
          },
        },
        onError: (error) => {
          throw error;
        },
      });
      const app = express();
      app.use((_req, _res, next) => tenantStorage.run(owner, next));
      app.get('/:id', (req, res) => {
        req.user = { id: owner.userId, tenantId: owner.tenantId };
        return handlers.retrieve(req, res, () => {});
      });
      const retrieved = await request(app).get(`/${f.record.responseId}`);
      expect(retrieved.status).toBe(200);
      expect(retrieved.body).toMatchObject({ status: 'failed', output: [] });
      const run: ChannelRunRecord = {
        tenantId: owner.tenantId,
        channelId: 'channel',
        agentId: 'agent',
        runId: 'run',
        laneId: 'lane',
        state: 'executing',
        sequence: 1,
        payloadHash: 'payload',
        receivedAt: Date.now(),
        principal: { userId: owner.userId, channelRevision: 'revision' },
        admission: {
          eventId: 'event',
          externalChannelId: 'C1',
          externalThreadKey: 'C1:1',
          externalMessageKey: 'C1:2',
          actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
          input: 'input',
        },
        cancellationRequested: false,
        receipts: [],
        leaseEpoch: 1,
        leaseExpiresAt: Date.now() + 10000,
        execution: {
          protocol: 'responses',
          responseId: f.record.responseId,
          requestId: 'run',
          conversationId: f.record.conversationId,
          parentMessageId: 'root',
          generationCreatedAt: f.binding.generationCreatedAt,
        },
      };
      expect(
        await createChannelResponseProjection({
          storage,
          readResponse: service.retrieve,
          cancelResponse: service.cancel,
        })(run),
      ).toMatchObject({ snapshot: { status: 'failed', text: '' } });
      expect(enqueue).not.toHaveBeenCalled();
      expect(
        await storage.settleDispatch(finished, finished.responseId, {
          kind: 'create',
          id: finished.responseId,
        }),
      ).toBe(true);
      expect(await storage.read(finished, finished.responseId)).toMatchObject({
        dispatchOutbox: { state: 'settled' },
      });
      const scopes = await mongoose.models.ResponseScope.find({}).lean<
        Array<{ pendingCount: number }>
      >();
      expect(scopes.every((anchor) => anchor.pendingCount === 0)).toBe(true);
    }));
  it('recovers a missing captured Conversation after a lost failure-marker reply without recreating history', () =>
    scope(async () => {
      const f = await fixture();
      await mongoose.models.Conversation.deleteOne({ _id: f.record.conversationTarget!.id });
      const original = storage.recordPersistenceFailure.bind(storage);
      jest.spyOn(storage, 'recordPersistenceFailure').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Injected failure marker reply lost');
      });
      expect((await completion().finish(f.record)).status).toBe('failed');
      const pending = (await storage.read(f.record, f.record.responseId))!;
      expect(pending).toMatchObject({
        status: 'failed',
        persistenceFailure: { code: 'target_retired' },
        releaseAcknowledged: true,
      });
      storage = createResponseStorage(mongoose);
      const recovered = await createResponseRecovery({ storage, jobs, completion: completion() })(
        pending,
      );
      expect(recovered?.status).toBe('failed');
      expect(await mongoose.models.Conversation.countDocuments({ user: owner.userId })).toBe(0);
      expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(0);
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    }));
  it('turns an oversized immutable terminal proposal into a bounded failure after positive drain', () =>
    scope(async () => {
      const f = await fixture(false, false, false);
      const response = JSON.parse(f.receipt.responseJSON);
      response.output[0].content[0].text = 'é'.repeat(8 * 1024 * 1024);
      const oversized = { ...f.receipt, responseJSON: JSON.stringify(response) };
      const prepared = await completion().prepare(f.record, oversized);
      expect(prepared).toMatchObject({
        status: 'materializing',
        persistenceFailure: { code: 'document_limit' },
      });
      expect(prepared.preparedTerminal).toBeUndefined();
      expect(prepared.pendingTerminal).toBeUndefined();
      expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(0);
      await f.drain();
      const finished = await completion().finish(
        (await storage.read(f.record, f.record.responseId))!,
      );
      expect(finished.status).toBe('failed');
      expect(Buffer.byteLength(finished.responseJSON!, 'utf8')).toBeLessThan(64 * 1024);
      expect(JSON.parse(finished.responseJSON!)).toMatchObject({
        output: [],
        status: 'failed',
        error: { code: 'response_persistence_failed' },
      });
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    }));
  it('publishes a large valid tool result without duplicating its receipt in write filters', () =>
    scope(async () => {
      const f = await fixture(true, false, false);
      const response = JSON.parse(f.receipt.responseJSON);
      response.output = [
        {
          type: 'function_call',
          id: 'call',
          call_id: 'large',
          name: 'lookup',
          arguments: '{}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          id: 'result',
          call_id: 'large',
          output: 'x'.repeat(12 * 1024 * 1024),
          status: 'completed',
        },
      ];
      const receipt = { ...f.receipt, responseJSON: JSON.stringify(response) };
      const prepared = await completion().prepare(f.record, receipt);
      expect(prepared.preparedTerminal).toBeDefined();
      const finished = await completion().finish(prepared);
      expect(finished.status).toBe('completed');
      expect(finished.pendingTerminal).toBeUndefined();
      expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(2);
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    }));
  it('fails an oversized canonical Message instead of retrying its accepted immutable receipt forever', () =>
    scope(async () => {
      const f = await fixture(true, false, false);
      const response = JSON.parse(f.receipt.responseJSON);
      response.output[0].content[0].text = 'x'.repeat(8 * 1024 * 1024);
      const receipt = { ...f.receipt, responseJSON: JSON.stringify(response) };
      const prepared = await completion().prepare(f.record, receipt);
      expect(prepared.preparedTerminal).toBeDefined();
      const finished = await completion().finish(prepared);
      expect(finished).toMatchObject({
        status: 'failed',
        persistenceFailure: { code: 'document_limit' },
      });
      expect(await mongoose.models.Message.countDocuments({ messageId: f.record.responseId })).toBe(
        0,
      );
      expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(1);
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    }));
  it('fences an already admitted delayed canonical writer before acknowledging failure', () =>
    scope(async () => {
      const f = await fixture();
      let entered!: () => void;
      let resume!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      interceptOutput(f.record, async () => {
        entered();
        await gate;
      });
      const first = completion().finish(f.record);
      try {
        await ready;
        const failed = await markFailure(f);
        const finished = await completion().finish(failed);
        expect(finished.status).toBe('failed');
        expect(
          await mongoose.models.Message.countDocuments({ messageId: f.record.responseId }),
        ).toBe(0);
      } finally {
        resume();
      }
      expect((await first).status).toBe('failed');
      expect(await mongoose.models.Message.countDocuments({ messageId: f.record.responseId })).toBe(
        0,
      );
      expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(1);
    }));
  it('preserves a canonical writer that won before sealing despite a lost journal acknowledgment', () =>
    scope(async () => {
      const f = await fixture();
      interceptOutput(
        f.record,
        async () => {
          throw new Error('Injected publication reply lost');
        },
        true,
      );
      await expect(completion().finish(f.record)).rejects.toThrow('publication reply lost');
      const failed = await markFailure(f);
      expect((await completion().finish(failed)).status).toBe('failed');
      expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(2);
      expect(
        await mongoose.models.Message.findOne({ messageId: f.record.responseId }).lean(),
      ).toMatchObject({ text: 'Confirmed answer' });
      const root = await mongoose.models.StoredResponse.findById(f.record.storageTarget!.id)
        .select('+canonicalTargets')
        .lean<StoredResponseRecord>();
      expect(
        root!.canonicalTargets!.find((entry) => entry.logicalId === f.record.responseId)?.phase,
      ).toBe('published');
    }));
  it('retains failure authority until the real provider and exact saver settle, then survives restart and lost final reply', () =>
    scope(async () => {
      const f = await fixture(false, true);
      const failed = await markFailure(f);
      expect((await completion().finish(failed)).status).toBe('materializing');
      expect(cleanupCheckpoint).not.toHaveBeenCalled();
      await f.drain();
      expect((await completion().finish(failed)).status).toBe('materializing');
      expect(cleanupCheckpoint).not.toHaveBeenCalled();
      expect(await f.writer!.settle()).toBe(true);
      storage = createResponseStorage(mongoose);
      const original = storage.finishPersistenceFailure.bind(storage);
      jest.spyOn(storage, 'finishPersistenceFailure').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Injected final reply lost');
      });
      const finished = await completion().finish(
        (await storage.read(f.record, f.record.responseId))!,
      );
      expect(finished.status).toBe('failed');
      expect(cleanupCheckpoint).toHaveBeenCalledTimes(1);
      expect(await storage.read(f.record, f.record.responseId)).toMatchObject({
        status: 'failed',
        releaseAcknowledged: true,
      });
      expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
      const recovered = await completion().finish(
        (await storage.read(f.record, f.record.responseId))!,
      );
      expect(recovered.status).toBe('failed');
    }));
});
