import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { formatAgentMessages } from '@librechat/agents';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ToolMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { Response } from './types';
import {
  createForegroundResponseTerminal,
  projectStoredResponseMessage,
  saveForegroundResponseInputs,
  requireResponseStorageWrite,
  loadForegroundResponseHistory,
} from './foreground';
import {
  createResponseContext,
  createResponseAggregator,
  buildAggregatedResponse,
} from './service';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { buildResponseInputChain, resolveResponseContinuation } from './persistence';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createStoredForegroundResponseReader } from './stored';
import { stopUserGenerations } from '~/user/generations';
import { createAgentRunEnvelope } from '../envelope';
import { executeAgentRun } from '../remote/host';

const owner = { userId: '507f1f77bcf86cd799439011', tenantId: 'foreground' };
const conversationId = '43528be3-42bb-47b8-b0e8-7cc02ef32f45';
const responseId = 'resp_foreground';
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
let mongo: MongoMemoryReplSet;
let db: ReturnType<typeof createMethods>;
const logger = { error: jest.fn() };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  db = createMethods(mongoose);
});
beforeEach(async () => {
  jest.clearAllMocks();
  await runAsSystem(async () => {
    await Promise.all([
      mongoose.models.Message.deleteMany({}),
      mongoose.models.Conversation.deleteMany({}),
      mongoose.models.User.deleteMany({}),
    ]);
  });
  await scoped(() =>
    mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'foreground@example.com',
      provider: 'local',
    }),
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

function result(): Response {
  const context = createResponseContext(
    { model: 'agent', input: 'input', store: true },
    responseId,
  );
  const aggregator = createResponseAggregator();
  aggregator.toolCalls.set('call', { id: 'call', name: 'lookup', arguments: '{"key":"a"}' });
  aggregator.toolOutputs.set('call', 'tool-result-only-in-canonical-content');
  return buildAggregatedResponse(context, aggregator, undefined, {
    status: 'unavailable',
    currency: 'USD',
    coverage: 'none',
    reason: 'pricing_unavailable',
    calls: [
      {
        model: 'provider-model',
        modelSource: 'provider_reported',
        usageType: 'message',
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reason: 'pricing_unavailable',
      },
    ],
  });
}
async function save(response: Response) {
  const context = { userId: owner.userId };
  await requireResponseStorageWrite(
    db.saveConvo(context, { conversationId, endpoint: 'agents', agent_id: 'agent' }),
    { conversationId },
  );
  const chain = buildResponseInputChain(
    [{ role: 'user' as const, content: 'input' }],
    '00000000-0000-0000-0000-000000000000',
  );
  await saveForegroundResponseInputs(
    { context, conversationId, messages: chain.messages, agentId: 'agent' },
    db,
  );
  return requireResponseStorageWrite(
    db.saveMessage(context, {
      messageId: response.id,
      conversationId,
      ...projectStoredResponseMessage(response, chain.parentMessageId),
      isCreatedByUser: false,
      sender: 'Agent',
      endpoint: 'agents',
      model: response.model,
    }),
    { conversationId, messageId: response.id },
  );
}
function appFor(
  scope = owner,
  overrides: Partial<Parameters<typeof createStoredForegroundResponseReader>[0]> = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: scope.userId } });
    tenantStorage.run(scope, next);
  });
  app.get('/:id', createStoredForegroundResponseReader({ ...db, logger, ...overrides }));
  return app;
}

it.each([conversationId, responseId])('preserves legacy tokenCount usage for %s', (id) =>
  scoped(async () => {
    await db.saveConvo({ userId: owner.userId }, { conversationId, endpoint: 'agents' });
    await db.saveMessage(
      { userId: owner.userId },
      {
        messageId: responseId,
        conversationId,
        text: 'Legacy reply',
        isCreatedByUser: false,
        tokenCount: 17,
        sender: 'Agent',
        endpoint: 'agents',
        model: 'agent',
      },
    );
    const read = await request(appFor())
      .get('/' + id)
      .expect(200);
    expect(read.body.usage).toMatchObject({ input_tokens: 0, output_tokens: 17, total_tokens: 17 });
    expect(read.body.accounting).toMatchObject({ status: 'unavailable', calls: [] });
  }),
);

it('stores canonical tool history and accounting, resolves the returned response ID and retrieves that exact turn', () =>
  scoped(async () => {
    const response = result();
    const saved = await save(response);
    expect(saved?.metadata).toMatchObject({
      responseReceipt: { accounting: response.accounting, usage: response.usage },
    });
    expect(JSON.stringify(saved?.metadata)).not.toContain('tool-result-only-in-canonical-content');
    const reference = await resolveResponseContinuation(responseId, owner.userId, db);
    expect(reference).toEqual({ conversationId, parentMessageId: responseId });
    const history = await loadForegroundResponseHistory(
      { conversationId, userId: owner.userId, previousResponseId: responseId },
      db,
    );
    expect(history).toHaveLength(2);
    expect(history[1].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_call: expect.objectContaining({ output: 'tool-result-only-in-canonical-content' }),
        }),
      ]),
    );
    const read = await request(appFor())
      .get('/' + responseId)
      .expect(200);
    expect(read.body).toMatchObject({
      id: responseId,
      store: true,
      accounting: response.accounting,
      usage: response.usage,
    });
    expect(read.body.output).toEqual(response.output);
  }));

it('retains submitted system/assistant tool replay provenance in the next selected history', () =>
  scoped(async () => {
    const context = { userId: owner.userId };
    await requireResponseStorageWrite(
      db.saveConvo(context, { conversationId, endpoint: 'agents' }),
      { conversationId },
    );
    const chain = buildResponseInputChain(
      [
        { role: 'system' as const, content: 'Caller context' },
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'tool_call',
              tool_call: {
                id: 'replay-call',
                name: 'lookup',
                args: '{}',
                output: 'caller-tool-result',
              },
            },
          ],
        },
        { role: 'user' as const, content: 'Continue' },
      ],
      '00000000-0000-0000-0000-000000000000',
    );
    await saveForegroundResponseInputs(
      { context, conversationId, messages: chain.messages, agentId: 'agent' },
      db,
    );
    const response = result();
    await requireResponseStorageWrite(
      db.saveMessage(context, {
        messageId: responseId,
        conversationId,
        ...projectStoredResponseMessage(response, chain.parentMessageId),
        isCreatedByUser: false,
        sender: 'Agent',
      }),
      { conversationId, messageId: responseId },
    );
    const history = await loadForegroundResponseHistory(
      { conversationId, userId: owner.userId, previousResponseId: responseId },
      db,
    );
    expect(history.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(history.slice(0, 3).every((message) => message.isUserSubmitted === true)).toBe(true);
    const sdk = formatAgentMessages(
      history.map((message) => ({ ...message })),
      undefined,
      new Set(['lookup']),
    );
    expect(
      sdk.messages
        .filter((message) => message instanceof ToolMessage)
        .map((message) => message.content),
    ).toContain('caller-tool-result');
    const read = await request(appFor())
      .get('/' + chain.messages[1].messageId)
      .expect(404);
    expect(JSON.stringify(read.body)).not.toContain('caller-tool-result');
  }));

it('returns 404 for a foreign tenant or erased conversation without disclosing stored output', () =>
  scoped(async () => {
    await save(result());
    const foreign = await request(appFor({ ...owner, tenantId: 'other' }))
      .get('/' + responseId)
      .expect(404);
    expect(JSON.stringify(foreign.body)).not.toContain('tool-result');
    await mongoose.models.Conversation.deleteOne({ conversationId, user: owner.userId });
    await request(appFor())
      .get('/' + responseId)
      .expect(404);
  }));

it('maps storage outages to a safe 503 and never returns an empty successful history', async () => {
  const failure = new Error('Authorization: Bearer private-secret');
  await expect(
    loadForegroundResponseHistory(
      { conversationId, userId: owner.userId },
      {
        getMessages: async () => {
          throw failure;
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'response_storage_unavailable' });
  const read = await request(
    appFor(owner, {
      getMessage: async () => {
        throw failure;
      },
    }),
  )
    .get('/' + responseId)
    .expect(503);
  expect(JSON.stringify(read.body)).not.toContain('private-secret');
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-secret');
});

it.each([null, undefined, { message: 'database unavailable' }, { conversationId: 'another' }])(
  'rejects a resolved unsuccessful write %p',
  async (value) => {
    await expect(
      requireResponseStorageWrite(Promise.resolve(value), { conversationId }),
    ).rejects.toMatchObject({ code: 'response_storage_unavailable' });
  },
);

async function settleTerminal(
  terminal: Pick<
    ReturnType<typeof createForegroundResponseTerminal>,
    'beforeSettle' | 'afterSettle' | 'onSettlementError'
  >,
  outcome: 'complete' | 'error' | 'aborted' = 'complete',
): Promise<void> {
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  try {
    await executeAgentRun(
      {
        envelope: createAgentRunEnvelope({
          protocol: 'responses',
          requestId: 'terminal-unit',
          receivedAt: Date.now(),
          principal: { id: owner.userId },
          payload: { model: 'agent', input: '' },
        }),
        runId: responseId,
        conversationId,
        captureTerminalOutcome: true,
        isPrincipalActive: async () => true,
        execute: async (execution) => {
          if (outcome === 'error') throw new Error('provider failed');
          if (outcome === 'aborted')
            await manager.abortJob(responseId, {
              expectedCreatedAt: execution.createdAt,
              awaitProviderDrain: false,
            });
        },
        handleExecutionError: () => undefined,
        beforeSettle: terminal.beforeSettle,
        afterSettle: terminal.afterSettle,
        onSettlementError: terminal.onSettlementError,
      },
      { manager },
    );
  } finally {
    await manager.destroy();
  }
}

it.each([true, false])(
  'publishes storage truth after settlement and keeps notification failure separate: requested=%s',
  async (requestedStore) => {
    const response = result();
    const context = createResponseContext({ model: 'agent', input: '' }, response.id);
    const terminal = createForegroundResponseTerminal({ context, requestedStore, logger });
    const publish = jest.fn();
    const saveResult = jest.fn(async () => ({ conversationId, messageId: response.id }));
    terminal.stage({
      fail: jest.fn(),
      response,
      save: saveResult,
      afterStore: async () => {
        throw new Error('private-secret');
      },
      publish,
    });
    expect(publish).not.toHaveBeenCalled();
    await settleTerminal(terminal);
    expect(saveResult).toHaveBeenCalledTimes(requestedStore ? 1 : 0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ store: requestedStore }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private-secret');
  },
);

it('retains provider output but reports store false on a failed optional save', async () => {
  const response = result();
  const context = createResponseContext({ model: 'agent', input: '' }, response.id);
  const terminal = createForegroundResponseTerminal({ context, requestedStore: true, logger });
  const publish = jest.fn();
  terminal.stage({
    fail: jest.fn(),
    response,
    save: async () => {
      throw new Error('storage outage');
    },
    publish,
  });
  await settleTerminal(terminal);
  expect(publish).toHaveBeenCalledWith({ ...response, store: false });
});

it.each(['error', 'cancelled'])(
  'does not save or publish a staged success after %s',
  async (outcome) => {
    const response = result();
    const terminal = createForegroundResponseTerminal({
      context: createResponseContext({ model: 'agent', input: '' }, response.id),
      requestedStore: true,
      logger,
    });
    const saveResult = jest.fn();
    const publish = jest.fn();
    terminal.stage({ fail: jest.fn(), response, save: saveResult, publish });
    await settleTerminal(terminal, outcome === 'cancelled' ? 'aborted' : 'error');
    expect(saveResult).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  },
);

it('cannot restage a completed foreground result and repeat persistence', async () => {
  const response = result();
  const terminal = createForegroundResponseTerminal({
    context: createResponseContext({ model: 'agent', input: '' }, response.id),
    requestedStore: true,
    logger,
  });
  const saveResult = jest.fn(async () => ({ conversationId, messageId: response.id }));
  const publish = jest.fn();
  const frame = { response, save: saveResult, publish, fail: jest.fn() };
  terminal.stage(frame);
  await settleTerminal(terminal);
  expect(() => terminal.stage(frame)).toThrow('already staged');
  expect(saveResult).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it('fails closed if a caller skips the tracked-write phase', async () => {
  const response = result();
  const terminal = createForegroundResponseTerminal({
    context: createResponseContext({ model: 'agent', input: '' }, response.id),
    requestedStore: true,
    logger,
  });
  const saveResult = jest.fn();
  const publish = jest.fn();
  const fail = jest.fn();
  terminal.stage({ response, save: saveResult, publish, fail });
  await terminal.afterSettle({ terminalOutcome: 'complete' }, undefined);
  expect(saveResult).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(fail).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'response_execution_unavailable' }),
  );
});

it('keeps foreground storage inside the account-erasure cleanup barrier', () =>
  scoped(async () => {
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
    });
    manager.initialize();
    let enteredSave!: () => void;
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      enteredSave = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const response = result();
    const terminal = createForegroundResponseTerminal({
      context: createResponseContext({ model: 'agent', input: '' }, response.id),
      requestedStore: true,
      logger,
    });
    const publish = jest.fn();
    const run = executeAgentRun(
      {
        envelope: createAgentRunEnvelope({
          protocol: 'responses',
          requestId: 'erase-foreground',
          receivedAt: Date.now(),
          principal: { id: owner.userId, tenantId: owner.tenantId },
          payload: { model: 'agent', input: 'input' },
        }),
        runId: response.id,
        conversationId,
        captureTerminalOutcome: true,
        isPrincipalActive: db.isSubagentOwnerAdmissible,
        execute: async () => {
          terminal.stage({
            response,
            save: async (value) => {
              enteredSave();
              await writeGate;
              return save(value);
            },
            publish,
            fail: jest.fn(),
          });
        },
        beforeSettle: terminal.beforeSettle,
        afterSettle: terminal.afterSettle,
        onSettlementError: terminal.onSettlementError,
      },
      { manager },
    );
    void run.catch(() => undefined);
    let cleanup: Promise<void> | undefined;
    try {
      await saving;
      expect(await manager.getCleanupBlockingJobIdsForUser(owner.userId, owner.tenantId)).toContain(
        response.id,
      );
      let enteredAbort!: () => void;
      const stopping = new Promise<void>((resolve) => {
        enteredAbort = resolve;
      });
      const abort = manager.abortJob.bind(manager);
      jest.spyOn(manager, 'abortJob').mockImplementation(async (...args) => {
        enteredAbort();
        return abort(...args);
      });
      let erased = false;
      cleanup = (async () => {
        await db.beginAgentTriggerUserDeletion(owner.userId, new Date());
        await stopUserGenerations(owner.userId, owner.tenantId, manager);
        await db.deleteConvos(owner.userId, {}, { allowEmpty: true });
        await db.deleteMessages({ user: owner.userId });
        await db.deleteUserById(owner.userId);
        erased = true;
      })();
      void cleanup.catch(() => undefined);
      await stopping;
      expect(erased).toBe(false);
      releaseSave();
      await Promise.all([run, cleanup]);
      expect(publish).not.toHaveBeenCalled();
      await runAsSystem(async () => {
        expect(await mongoose.models.Message.countDocuments({ user: owner.userId })).toBe(0);
        expect(await mongoose.models.Conversation.countDocuments({ user: owner.userId })).toBe(0);
        expect(await mongoose.models.User.countDocuments({ _id: owner.userId })).toBe(0);
      });
    } finally {
      releaseSave();
      await Promise.allSettled([run, cleanup ?? Promise.resolve()]);
      await manager.destroy();
    }
  }));
