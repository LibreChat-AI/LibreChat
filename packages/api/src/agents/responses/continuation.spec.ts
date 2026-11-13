import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { formatAgentMessages } from '@librechat/agents';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ToolMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { Response, FunctionCallItemParam } from './types';
import {
  createResponseContext,
  createResponseAggregator,
  buildAggregatedResponse,
  convertInputToMessages,
} from './service';
import {
  projectStoredResponseMessage,
  loadForegroundResponseHistory,
  responseClientToolNames,
} from './foreground';
import { createStoredToolContinuation, storedToolContinuationReference } from './continuation';
import { createStoredForegroundResponseReader } from './stored';
import { declaredClientToolNames } from './clientTools';

const owner = { userId: '507f1f77bcf86cd799439011', tenantId: 'client-tools' };
const conversationId = '43528be3-42bb-47b8-b0e8-7cc02ef32f45';
const responseId = 'resp_client_tools';
const tools = [
  { type: 'function' as const, name: 'lookup', parameters: { type: 'object', properties: {} } },
];
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
const logger = { error: jest.fn() };
let mongo: MongoMemoryServer;
let db: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
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
  await scoped(async () => {
    await mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'client-tools@example.com',
      provider: 'local',
    });
    await db.saveConvo(
      { userId: owner.userId },
      { conversationId, endpoint: 'agents', agent_id: 'agent' },
    );
  });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

function pending(): Response {
  const context = createResponseContext(
    { model: 'agent', input: 'lookup', tools, store: true },
    responseId,
  );
  context.tools = tools;
  const aggregator = createResponseAggregator();
  for (const id of ['call_a', 'call_b'])
    aggregator.toolCalls.set(id, { id, name: 'lookup', arguments: JSON.stringify({ key: id }) });
  return buildAggregatedResponse(context, aggregator);
}
async function save(response = pending(), extra = {}) {
  return db.saveMessage(
    { userId: owner.userId },
    {
      messageId: responseId,
      conversationId,
      ...projectStoredResponseMessage(response, '00000000-0000-0000-0000-000000000000'),
      isCreatedByUser: false,
      sender: 'Agent',
      endpoint: 'agents',
      model: 'agent',
      ...extra,
    },
  );
}
const outputs = () =>
  ['call_b', 'call_a'].map((call_id) => ({
    type: 'function_call_output',
    call_id,
    output: `result:${call_id}`,
  }));
const payload = () => ({ model: 'agent', previous_response_id: responseId, input: outputs() });

function appFor(
  scope = owner,
  overrides: Partial<Parameters<typeof createStoredToolContinuation>[0]> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: scope.userId, tenantId: scope.tenantId } });
    tenantStorage.run(scope, next);
  });
  app.post('/', createStoredToolContinuation({ ...db, logger, ...overrides }), async (req, res) => {
    const reference = storedToolContinuationReference(req, scope, req.body.previous_response_id);
    const history = reference
      ? await loadForegroundResponseHistory(
          {
            conversationId: reference.conversationId,
            userId: scope.userId,
            previousResponseId: req.body.previous_response_id,
          },
          db,
        )
      : [];
    const sdk = formatAgentMessages(
      [...history, ...convertInputToMessages(req.body.input)].map((message) => ({ ...message })),
      undefined,
      new Set([...declaredClientToolNames(req.body.tools), ...responseClientToolNames(history)]),
    );
    res.json({
      reference: storedToolContinuationReference(req, scope, req.body.previous_response_id),
      foreignReferences: [
        storedToolContinuationReference(
          req,
          { ...scope, userId: 'another' },
          req.body.previous_response_id,
        ),
        storedToolContinuationReference(
          req,
          { ...scope, tenantId: 'another' },
          req.body.previous_response_id,
        ),
        storedToolContinuationReference(req, scope, 'resp_another'),
      ],
      input: req.body.input,
      tools: sdk.messages
        .filter((message) => message instanceof ToolMessage)
        .map((message) => ({ id: message.tool_call_id, content: message.content })),
    });
  });
  app.get('/:id', createStoredForegroundResponseReader({ ...db, logger }));
  return app;
}

it('retrieves the exact pending batch and replays ordered pairs without mutating the source', () =>
  scoped(async () => {
    const response = pending();
    await save(response);
    const before = await request(appFor())
      .get('/' + responseId)
      .expect(200);
    expect(before.body.output).toEqual(response.output);
    const continued = await request(appFor()).post('/').send(payload()).expect(200);
    expect(continued.body.reference).toEqual({ conversationId, parentMessageId: responseId });
    expect(continued.body.foreignReferences).toEqual([null, null, null]);
    expect(continued.body.tools).toEqual(
      ['call_a', 'call_b'].map((id) => ({ id, content: `result:${id}` })),
    );
    const history = await loadForegroundResponseHistory(
      { conversationId, userId: owner.userId, previousResponseId: responseId },
      db,
    );
    expect(
      formatAgentMessages(
        history.map((message) => ({ ...message })),
        undefined,
        new Set(['lookup']),
      ).messages.filter((message) => message instanceof ToolMessage),
    ).toHaveLength(0);
    const after = await request(appFor())
      .get('/' + responseId)
      .expect(200);
    expect(after.body).toEqual(before.body);
  }));

it('does not duplicate explicitly replayed calls and preserves the original batch order', () =>
  scoped(async () => {
    const response = pending();
    await save(response);
    const calls = response.output.filter((item) => item.type === 'function_call');
    const continued = await request(appFor())
      .post('/')
      .send({ ...payload(), input: [...calls.reverse(), ...outputs()] })
      .expect(200);
    expect(
      continued.body.input
        .filter((item: FunctionCallItemParam) => item.type === 'function_call')
        .map((item: FunctionCallItemParam) => item.call_id),
    ).toEqual(['call_a', 'call_b']);
  }));

it.each(['none', 'partial', 'duplicate', 'unknown', 'changed', 'malformed', 'null'])(
  'rejects %s results before the execution handler',
  (kind) =>
    scoped(async () => {
      const response = pending();
      await save(response);
      let input: unknown[] = outputs();
      if (kind === 'none') input = [{ type: 'message', role: 'user', content: 'continue' }];
      if (kind === 'null') input = [null];
      if (kind === 'partial') input = outputs().slice(0, 1);
      if (kind === 'duplicate') input = [...outputs(), outputs()[0]];
      if (kind === 'unknown')
        input = [
          ...outputs(),
          { type: 'function_call_output', call_id: 'call_unknown', output: 'forged' },
        ];
      if (kind === 'changed')
        input = [
          ...response.output
            .filter((item) => item.type === 'function_call')
            .map((call) => ({ ...call, arguments: '{"changed":true}' })),
          ...outputs(),
        ];
      if (kind === 'malformed')
        input = [{ type: 'function_call_output', call_id: 'call_a', output: 42 }];
      const rejected = await request(appFor())
        .post('/')
        .send({ ...payload(), input })
        .expect(400);
      expect(rejected.body).toHaveProperty('error');
    }),
);

it.each([
  { userId: '507f1f77bcf86cd799439012', tenantId: owner.tenantId },
  { userId: owner.userId, tenantId: 'another-tenant' },
])('does not disclose another owner or tenant: %p', async (scope) => {
  await scoped(() => save());
  const app = appFor(scope);
  const denied = await request(app).post('/').send(payload()).expect(404);
  expect(JSON.stringify(denied.body)).not.toContain('call_a');
  await request(app)
    .get('/' + responseId)
    .expect(404);
});

it.each(['failed', 'cancelled', 'incomplete'] as const)('cannot continue a %s response', (status) =>
  scoped(async () => {
    await save({ ...pending(), status });
    const rejected = await request(appFor()).post('/').send(payload()).expect(400);
    expect(rejected.body).toHaveProperty('error');
  }),
);

it('cannot use a caller-submitted assistant message as a generated tool handoff', () =>
  scoped(async () => {
    await save(pending(), { isUserSubmitted: true });
    const rejected = await request(appFor()).post('/').send(payload()).expect(404);
    expect(rejected.body).toHaveProperty('error');
  }));

it('fails closed when the owning conversation has been deleted', () =>
  scoped(async () => {
    await save();
    await mongoose.models.Conversation.deleteMany({});
    const rejected = await request(appFor()).post('/').send(payload()).expect(404);
    expect(rejected.body).toHaveProperty('error');
  }));

it('returns a safe storage failure without leaking diagnostics', () =>
  scoped(async () => {
    const failure = await request(
      appFor(owner, {
        getMessage: async () => {
          throw new Error('private-storage-secret');
        },
      }),
    )
      .post('/')
      .send(payload())
      .expect(503);
    expect(JSON.stringify([failure.body, logger.error.mock.calls])).not.toContain(
      'private-storage-secret',
    );
  }));

it('keeps stateless explicit replay working', async () => {
  const calls = pending().output;
  const continued = await request(appFor())
    .post('/')
    .send({ model: 'agent', tools, input: [...calls, ...outputs()] })
    .expect(200);
  expect(continued.body.tools).toHaveLength(2);
});

it('does not hydrate a legacy call without a server-written pending receipt', () =>
  scoped(async () => {
    await save(pending(), { metadata: {} });
    const rejected = await request(appFor()).post('/').send(payload()).expect(400);
    expect(rejected.body).toHaveProperty('error');
  }));

it('does not accept caller results for an unanswered server tool', () =>
  scoped(async () => {
    await save({ ...pending(), tools: [] });
    const rejected = await request(appFor()).post('/').send(payload()).expect(400);
    expect(rejected.body).toHaveProperty('error');
  }));
