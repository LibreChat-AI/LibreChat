import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createResponseStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  ChannelRunRecord,
  ResponseStorage,
  StoredResponseRecord,
} from '@librechat/data-schemas';
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
import { createResponseRetirement } from '~/agents/responses/retirement';
import { GenerationJobManager } from '~/stream';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let stored: StoredResponseRecord;
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
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.Conversation.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
  const reserved = await scoped(() =>
    storage.reserve({
      ...owner,
      responseId: 'resp_saved',
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
      conversationId: 'conversation',
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
      confirmExecution: createResponseExecutionConfirmation(GenerationJobManager),
      releaseExecution: createResponseExecutionRelease(GenerationJobManager),
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
  const result = await storage.publish(owner, stored.responseId, stored.revision, {
    status: response.status,
    responseJSON: JSON.stringify(response),
    generationCreatedAt: 1234,
  });
  if (!result.ok) throw new Error('Publication failed');
  stored = result.record;
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
      generationCreatedAt: 1234,
      snapshot: {
        responseId: 'resp_saved',
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
      run.execution = {
        ...run.execution!,
        [field]: field === 'generationCreatedAt' ? 5678 : 'other',
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
      else {
        await mongoose.models.Conversation.create({
          user: owner.userId,
          tenantId: owner.tenantId,
          conversationId: stored.conversationId,
          endpoint: 'agents',
        });
        await expect(
          createMethods(mongoose).deleteConvos(
            owner.userId,
            { conversationId: stored.conversationId },
            {
              beforeDelete: async () => {
                throw new Error('erasure paused after scope closure');
              },
            },
          ),
        ).rejects.toThrow('erasure paused after scope closure');
      }
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
    await mongoose.models.StoredResponse.updateOne(
      { responseId: stored.responseId },
      { $set: { expiredAt: new Date(0), generationCreatedAt: 1234 } },
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
