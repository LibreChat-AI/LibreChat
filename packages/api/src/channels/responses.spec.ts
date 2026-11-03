import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createResponseStorage,
  createManagedMessageId,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  ChannelRunRecord,
  ResponseStorage,
  StoredResponseRecord,
} from '@librechat/data-schemas';
import type { AgentExecutionEnrollment } from '~/agents/remote/lifecycle';
import type { Response } from '~/agents/responses/types';
import {
  createResponseCompletion,
  createResponseExecutionConfirmation,
  createResponseExecutionRelease,
} from '~/agents/responses/completion';
import {
  buildPendingBackgroundResponse,
  createBackgroundResponseService,
} from '~/agents/responses/background';
import { createChannelResponseProjection, createChannelResponseRetirement } from './responses';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { normalizeResponseTurnIntent } from '~/agents/responses/turnProjection';
import { createBackgroundResponseHttpHandlers } from '~/agents/responses/http';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createResponseRetirement } from '~/agents/responses/retirement';
import { enrollAgentExecution } from '~/agents/remote/lifecycle';
import { GenerationJobManager } from '~/stream';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let stored: StoredResponseRecord;
let execution: AgentExecutionEnrollment | undefined;
const responseId = createManagedMessageId();
const conversationId = randomUUID();
let run: ChannelRunRecord;
const owner = { userId: 'user', tenantId: 'projection-test' };
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
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
afterEach(async () => {
  await GenerationJobManager.destroy();
});
beforeEach(async () => {
  execution = undefined;
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.Conversation.deleteMany({});
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
  const conversation = await scoped(() =>
    mongoose.models.Conversation.create({
      user: owner.userId,
      tenantId: owner.tenantId,
      conversationId: conversationId,
      endpoint: 'agents',
    }),
  );
  const reserved = await scoped(() =>
    storage.reserve({
      ...owner,
      responseId,
      requestKey: 'channel:run',
      fingerprint: 'request',
      agentId: 'agent',
      sourceKeyId: 'key',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'hello',
        background: true,
        store: true,
      }),
      conversationId: conversationId,
      conversationTarget: {
        id: String(conversation._id),
        userId: owner.userId,
        tenantId: owner.tenantId,
        conversationId: conversationId,
      },
      parentMessageId: 'root',
    }),
  );
  if (!reserved.ok) throw new Error('Reservation failed');
  stored = reserved.record;
  run = {
    tenantId: owner.tenantId,
    channelId: 'channel',
    agentId: 'agent',
    runId: 'run',
    laneId: 'lane',
    state: 'executing',
    sequence: 1,
    payloadHash: 'payload',
    receivedAt: 1000,
    principal: { userId: owner.userId, channelRevision: 'revision' },
    admission: {
      eventId: 'event',
      externalChannelId: 'C1',
      externalThreadKey: 'C1:1.0',
      externalMessageKey: 'C1:1.1',
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
      input: 'hello',
    },
    cancellationRequested: false,
    receipts: [],
    leaseEpoch: 1,
    leaseExpiresAt: Date.now() + 10000,
    execution: {
      protocol: 'responses',
      responseId: stored.responseId,
      responseTarget: stored.storageTarget,
      responseFingerprint: stored.fingerprint,
      requestId: 'run',
      conversationId: stored.conversationId,
      parentMessageId: stored.parentMessageId,
    },
  };
});
function fixture() {
  let authorized = true;
  const cancel = jest.fn(async () => {});
  const service = createBackgroundResponseService({
    storage,
    recoverTerminal: createResponseCompletion({
      storage,
      cleanupCheckpoint: async () => {},
      confirmExecution: createResponseExecutionConfirmation(storage, GenerationJobManager),
      releaseExecution: createResponseExecutionRelease(GenerationJobManager, storage),
    }).finish,
    authorize: async () => authorized,
    enqueue: async () => {
      throw new Error('Projection must not enqueue');
    },
    resolveContinuation: async () => {
      throw new Error('Projection must not rebuild history');
    },
    observe: async () => null,
    cancel,
  });
  return {
    service,
    project: createChannelResponseProjection({
      storage,
      readResponse: service.retrieve,
      cancelResponse: service.cancel,
      now: () => 6000,
    }),
    cancel,
    revoke: () => {
      authorized = false;
    },
  };
}
async function publish(response: Response) {
  if (!execution) {
    execution = await enrollAgentExecution(
      {
        runId: stored.responseId,
        userId: owner.userId,
        agentId: stored.agentId,
        conversationId: stored.conversationId,
        protocol: 'responses',
        responseRoot: stored.storageTarget,
        retainTerminalPersistence: true,
        captureTerminalOutcome: true,
        isPrincipalActive: async () => true,
      },
      { manager: GenerationJobManager },
    );
    const enrolled = await storage.enrollExecution(
      stored,
      execution.getEnrollmentIdentity(),
      JSON.stringify({ ...buildPendingBackgroundResponse(stored), status: 'in_progress' }),
    );
    if (!enrolled.ok) throw new Error('Root enrollment failed');
    await execution.beginProviderExecution();
    if (!(await storage.bindExecution(enrolled.record, execution.getPersistenceIdentity())))
      throw new Error('Provider binding failed');
    const prepared = await storage.prepareConversation(
      enrolled.record,
      execution.getPersistenceIdentity(),
      {
        context: { userId: owner.userId },
        conversation: {
          conversationId: stored.conversationId,
          agent_id: stored.agentId,
          endpoint: 'agents',
        },
        initialAgentId: stored.agentId,
      },
    );
    if (!prepared.ok) throw new Error('Conversation preparation failed');
    stored = prepared.record;
  }
  if (response.status === 'in_progress' || response.status === 'queued') {
    const published = await storage.publishProgress(stored, {
      status: response.status,
      responseJSON: JSON.stringify(response),
    });
    if (!published.ok) throw new Error('Progress publication failed');
    stored = published.record;
    return;
  }
  await execution.settle();
  const inputId = randomUUID();
  stored = await createResponseCompletion({
    storage,
    cleanupCheckpoint: async () => {},
    confirmExecution: createResponseExecutionConfirmation(storage, GenerationJobManager),
    releaseExecution: createResponseExecutionRelease(GenerationJobManager, storage),
  }).stageAndFinish(stored, {
    ...execution.getPersistenceIdentity(),
    status: response.status,
    responseJSON: JSON.stringify(response),
    turnJSON: normalizeResponseTurnIntent(
      stored,
      JSON.stringify({
        version: 1,
        context: { userId: owner.userId },
        conversation: {
          conversationId: stored.conversationId,
          agent_id: stored.agentId,
          endpoint: 'agents',
        },
        initialAgentId: stored.agentId,
        inputs: [{ index: 0, messageId: inputId, parentMessageId: 'root' }],
        parentMessageId: inputId,
        trace: {},
      }),
    ),
  });
}

it('carries a nonterminal recovery warning without publishing stale actions, output or enqueueing work', async () => {
  await scoped(async () => {
    await publish({
      ...buildPendingBackgroundResponse(stored),
      status: 'in_progress',
      recovery: 'execution_state_unavailable',
    });
    const f = fixture();
    const result = await f.project(run);
    expect(result.snapshot).toMatchObject({
      status: 'running',
      text: '',
      recovery: 'execution_state_unavailable',
    });
    expect(result.snapshot.pendingAction).toBeUndefined();
    expect(f.cancel).not.toHaveBeenCalled();
  });
});

it('projects only the canonical final assistant text and actual usage', () =>
  scoped(async () => {
    const f = fixture();
    const response: Response = {
      ...buildPendingBackgroundResponse(stored),
      status: 'completed',
      completed_at: 5,
      output: [
        {
          id: 'message',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '# Final answer', annotations: [], logprobs: [] }],
        },
        {
          id: 'call',
          type: 'function_call',
          call_id: 'tool',
          name: 'private_tool',
          arguments: 'PRIVATE arguments',
          status: 'completed',
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    };
    await publish(response);
    const result = await f.project(run);
    expect(result).toMatchObject({
      generationCreatedAt: stored.generationCreatedAt,
      snapshot: {
        responseId: stored.responseId,
        status: 'completed',
        text: '# Final answer',
        elapsedMs: 4000,
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cachedTokens: 3,
          reasoningTokens: 1,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(f.cancel).not.toHaveBeenCalled();
  }));

it('never presents intermediate output as the final Slack answer', () =>
  scoped(async () => {
    const f = fixture();
    await publish({
      ...buildPendingBackgroundResponse(stored),
      status: 'in_progress',
      output: [
        {
          id: 'message',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [{ type: 'output_text', text: 'Still changing', annotations: [], logprobs: [] }],
        },
      ],
    });
    expect((await f.project(run)).snapshot).toMatchObject({ status: 'running', text: '' });
  }));

it('keeps a cancellation request running until the Responses runtime confirms settlement', () =>
  scoped(async () => {
    const f = fixture();
    await publish({ ...buildPendingBackgroundResponse(stored), status: 'in_progress' });
    run.cancellationRequested = true;
    expect((await f.project(run)).snapshot.status).toBe('running');
    expect(f.cancel).toHaveBeenCalledTimes(1);
    await publish({
      ...buildPendingBackgroundResponse(stored),
      status: 'cancelled',
      completed_at: 5,
    });
    expect((await f.project(run)).snapshot.status).toBe('cancelled');
  }));

it('honors current source credential authority before returning output', () =>
  scoped(async () => {
    const f = fixture();
    f.revoke();
    await expect(f.project(run)).rejects.toMatchObject({ code: 'execution_identity_changed' });
  }));

it.each(['responseId', 'conversationId', 'parentMessageId', 'generationCreatedAt'])(
  'rejects changed %s rather than reading the latest conversation output',
  (field) =>
    scoped(async () => {
      const f = fixture();
      const value = field === 'responseId' ? createManagedMessageId() : 'other';
      run.execution = {
        ...run.execution!,
        [field]: field === 'generationCreatedAt' ? 5678 : value,
      };
      await expect(f.project(run)).rejects.toMatchObject({ code: 'execution_identity_changed' });
    }),
);

it.each(['expired', 'closed'] as const)(
  'retires a %s bound Response through cleanup identity without disclosing payload',
  (state) =>
    scoped(async () => {
      run.cancellationRequested = true;
      run.errorCode = 'channel_authority_changed';
      run.execution!.apiKeyId = 'key';
      if (state === 'expired')
        await mongoose.models.StoredResponse.updateOne(
          { responseId: stored.responseId },
          { $set: { expiredAt: new Date(0) } },
        );
      else await createMethods(mongoose).prepareUserResponseErasure(owner);
      expect(await storage.read(owner, stored.responseId)).toBeNull();
      const jobs = {
        getJob: jest.fn(async () => undefined),
        abortJob: jest.fn(),
        finishProviderTerminalPersistence: jest.fn(),
      };
      const retire = createChannelResponseRetirement({
        storage,
        recovery: { recoverResponse: jest.fn() },
        retireResponse: createResponseRetirement({ storage, jobs }),
      });
      await expect(retire(run)).resolves.toBe('stopped');
      expect(jobs.abortJob).not.toHaveBeenCalled();
    }),
);

it.each([
  { requestKey: 'foreign' },
  { sourceKeyId: 'foreign' },
  { parentMessageId: 'foreign' },
  { agentId: 'foreign' },
  { conversationId: 'foreign' },
])('refuses foreign cleanup binding metadata after expiry: %j', (change) =>
  scoped(async () => {
    run.cancellationRequested = true;
    run.errorCode = 'channel_authority_changed';
    run.execution!.apiKeyId = 'key';
    await mongoose.models.StoredResponse.collection.updateOne(
      { responseId: stored.responseId },
      { $set: { expiredAt: new Date(0), ...change } },
    );
    const retireResponse = jest.fn(async () => 'stopped' as const);
    const retire = createChannelResponseRetirement({
      storage,
      recovery: { recoverResponse: jest.fn() },
      retireResponse,
    });
    await expect(retire(run)).rejects.toMatchObject({ code: 'execution_identity_changed' });
    expect(retireResponse).not.toHaveBeenCalled();
  }),
);

it('preserves pending retirement when an expired generation has no drain proof', () =>
  scoped(async () => {
    run.cancellationRequested = true;
    run.errorCode = 'channel_authority_changed';
    run.execution!.apiKeyId = 'key';
    if (
      !(
        await storage.enrollExecution(
          stored,
          { generationCreatedAt: 1234, providerExecutionId: 'missing-provider' },
          '{}',
        )
      ).ok
    )
      throw new Error('Enrollment failed');
    await mongoose.models.StoredResponse.updateOne(
      { responseId: stored.responseId },
      { $set: { expiredAt: new Date(0) } },
    );
    const jobs = {
      getJob: jest.fn(async () => undefined),
      abortJob: jest.fn(),
      finishProviderTerminalPersistence: jest.fn(),
    };
    const retire = createChannelResponseRetirement({
      storage,
      recovery: { recoverResponse: jest.fn() },
      retireResponse: createResponseRetirement({ storage, jobs }),
    });
    await expect(retire(run)).resolves.toBe('pending');
    expect(jobs.abortJob).not.toHaveBeenCalled();
  }));

it('does not treat a cleanup metadata outage as successful retirement', () =>
  scoped(async () => {
    run.cancellationRequested = true;
    run.errorCode = 'channel_authority_changed';
    const retireResponse = jest.fn(async () => 'stopped' as const);
    const retire = createChannelResponseRetirement({
      storage: {
        readCleanupIdentity: async () => {
          throw new Error('cleanup store unavailable');
        },
      },
      recovery: { recoverResponse: jest.fn() },
      retireResponse,
    });
    await expect(retire(run)).rejects.toThrow('cleanup store unavailable');
    expect(retireResponse).not.toHaveBeenCalled();
  }));

it.each(['expired', 'closed', 'replaced'] as const)(
  'does not project a %s canonical Root or call the public Response service',
  (state) =>
    scoped(async () => {
      const readResponse = jest.fn();
      const cancelResponse = jest.fn();
      const project = createChannelResponseProjection({ storage, readResponse, cancelResponse });
      if (state === 'expired') {
        await mongoose.models.StoredResponse.collection.updateOne(
          { responseId: stored.responseId },
          { $set: { expiredAt: new Date(0) } },
        );
      } else if (state === 'closed') {
        await createMethods(mongoose).prepareUserResponseErasure(owner);
      } else {
        await replaceCanonicalRoot();
        expect(await storage.read(owner, stored.responseId)).not.toBeNull();
      }
      await expect(project(run)).rejects.toMatchObject({ code: 'execution_identity_changed' });
      expect(readResponse).not.toHaveBeenCalled();
      expect(cancelResponse).not.toHaveBeenCalled();
    }),
);

async function replaceCanonicalRoot() {
  const root = await mongoose.models.StoredResponse.collection.findOne({
    responseId: stored.responseId,
  });
  if (!root) throw new Error('Missing fixture Root');
  const id = new mongoose.Types.ObjectId();
  const incarnation = randomUUID();
  await mongoose.models.StoredResponse.collection.deleteOne({ _id: root._id });
  await mongoose.models.StoredResponse.collection.insertOne({
    ...root,
    _id: id,
    _managed: { ...root._managed, parentId: String(id), incarnation },
    storageTarget: { ...root.storageTarget, id: String(id), incarnation },
  });
}

it.each(['retrieve', 'cancel'] as const)(
  'keeps the authenticated Root through HTTP %s when a same-ID replacement appears',
  (operation) =>
    scoped(async () => {
      const f = fixture();
      const ordinary = jest.fn((_req, res) => {
        res.sendStatus(418);
      });
      const onError = jest.fn();
      const handlers = createBackgroundResponseHttpHandlers({
        service: () => f.service,
        ordinary: { create: ordinary, retrieve: ordinary },
        onError,
      });
      const app = express();
      app.use((req, _res, next) => {
        Object.assign(req, {
          user: { id: owner.userId, tenantId: owner.tenantId },
          preparedResponseTarget: {
            ...owner,
            responseId: stored.responseId,
            storageTarget: stored.storageTarget,
          },
        });
        next();
      });
      app.use(async (_req, _res, next) => {
        await replaceCanonicalRoot();
        next();
      });
      app.get('/responses/:id', handlers.retrieve);
      app.post('/responses/:id/cancel', handlers.cancel);
      const path = `/responses/${stored.responseId}`;
      const response =
        operation === 'retrieve'
          ? await request(app).get(path)
          : await request(app).post(`${path}/cancel`).send({});
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: 'response_not_found' } });
      expect(ordinary).not.toHaveBeenCalled();
      expect(f.cancel).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }),
);
