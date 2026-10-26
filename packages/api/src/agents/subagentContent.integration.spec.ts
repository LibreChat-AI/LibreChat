import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { AllMethods, IMessage, SubagentContentScope } from '@librechat/data-schemas';
import type { SubagentTaskRuntime, SubagentUpdateEvent } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import {
  SubagentContentJournal,
  createSubagentTaskContentHandler,
  readSubagentContent,
} from './subagentContent';
import { buildSubagentThreadTaskConfig, SubagentThreadTaskStore } from './subagentThreads';
import { createSubagentThreadViewHandler } from './view';

let mongo: MongoMemoryServer;
let methods: AllMethods;
const stores: SubagentThreadTaskStore[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  createModels(mongoose);
  await mongoose.connect(mongo.getUri());
  methods = createMethods(mongoose);
  await Promise.all(
    ['Message', 'SubagentContent'].map((name) => mongoose.models[name].createIndexes()),
  );
});
afterEach(async () => {
  await Promise.all(
    stores.splice(0).map(async (store) => {
      await store.destroyTaskControlTransport();
      store.destroyActivityStream();
    }),
  );
  await Promise.all(
    ['Conversation', 'Message', 'SubagentContent'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const progress = (phase: SubagentUpdateEvent['phase'], data: unknown): SubagentUpdateEvent => ({
  runId: 'root',
  parentRunId: 'parent-run',
  subagentRunId: 'execution',
  subagentType: 'researcher',
  subagentKind: 'agent',
  subagentAgentId: 'researcher',
  parentToolCallId: 'dispatch',
  phase,
  data,
  timestamp: new Date().toISOString(),
});

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for content persistence');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runningTask(
  run: (runtime: SubagentTaskRuntime) => Promise<{ content: string }>,
  contentSettlementTimeoutMs = 1000,
) {
  const user = 'content-owner';
  const parentConversationId = randomUUID();
  await methods.saveConvo(
    { userId: user },
    { conversationId: parentConversationId, title: 'Parent' },
  );
  const store = new SubagentThreadTaskStore(methods, {
    activity: { contentRecoveryEnabled: true, contentFlushMs: 10, contentSettlementTimeoutMs },
  });
  stores.push(store);
  const config = buildSubagentThreadTaskConfig(store, { userId: user, parentConversationId });
  const started = store.start({
    scopeId: config.scopeId,
    idempotencyKey: randomUUID(),
    parentRunId: randomUUID(),
    parentAgentId: 'parent-agent',
    parentToolCallId: randomUUID(),
    input: 'Investigate',
    subagentKind: 'agent',
    subagentType: 'researcher',
    run,
  });
  if (!started.accepted || started.task.threadId == null) throw new Error('Task rejected');
  const scope: SubagentContentScope = {
    user,
    parentConversationId,
    conversationId: started.task.threadId,
    taskId: started.task.taskId,
  };
  return { store, scope, scopeId: config.scopeId };
}

function appFor(
  scope: SubagentContentScope,
  user: string | null = scope.user,
  tenantId?: string,
  recoveryGraceMs = 30_000,
) {
  const app = express();
  app.use((req, _res, next) => {
    if (user != null) {
      (req as ServerRequest).user = { id: user, tenantId } as ServerRequest['user'];
    }
    next();
  });
  const handler = createSubagentTaskContentHandler(methods, undefined, () => recoveryGraceMs);
  app.get(
    '/api/convos/:parentConversationId/subagents/:threadId/tasks/:taskId/content',
    (req, res) => handler(req as ServerRequest, res),
  );
  const url = `/api/convos/${scope.parentConversationId}/subagents/${scope.conversationId}/tasks/${scope.taskId}/content`;
  return { app, url };
}

it('cold-opens >100 public events and large arguments/output without running work again, then hands off terminal content', async () => {
  let finish: (value: { content: string }) => void = () => undefined;
  const result = new Promise<{ content: string }>((resolve) => {
    finish = resolve;
  });
  let executions = 0;
  const output = 'whole tool body '.repeat(30_000);
  const args = { query: 'full arguments '.repeat(10_000) };
  const { scope, store, scopeId } = await runningTask(async (runtime) => {
    executions++;
    runtime.reportProgress(
      progress('run_step', {
        id: 'message-step',
        index: 0,
        type: 'message_creation',
        stepDetails: {
          type: 'message_creation',
          message_creation: { message_id: 'visible-message' },
        },
      }),
    );
    for (let index = 0; index < 150; index++) {
      runtime.reportProgress(
        progress('message_delta', {
          id: 'message-step',
          delta: { content: [{ type: 'text', text: `${index},` }] },
        }),
      );
    }
    runtime.reportProgress(
      progress('run_step', {
        id: 'tool-step',
        index: 1,
        type: 'tool_calls',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call-1', type: 'tool_call', name: 'lookup', args }],
        },
      }),
    );
    runtime.reportProgress(
      progress('run_step_completed', {
        result: {
          id: 'tool-step',
          type: 'tool_call',
          tool_call: { id: 'call-1', name: 'lookup', args, output, progress: 1 },
        },
      }),
    );
    return result;
  });
  await until(async () => (await methods.getSubagentContentHead(scope))?.throughSequence === 152);
  const { app, url } = appFor(scope);
  const opened = await request(app).get(url).expect(200);
  expect(opened.body).toMatchObject({
    mode: 'snapshot',
    status: 'running',
    recovery: 'partial',
    targetThroughSequence: 152,
    messageId: `${scope.taskId}:assistant`,
    parentMessageId: `${scope.taskId}:user`,
  });
  expect(JSON.stringify(opened.body.content)).toContain('0,1,2,');
  expect(JSON.stringify(opened.body.content)).toContain('148,149,');
  expect(opened.body.nextCursor).toBeDefined();
  const suffix = await request(app)
    .get(`${url}?cursor=${encodeURIComponent(opened.body.nextCursor)}`)
    .expect(200);
  expect(suffix.body).toMatchObject({
    mode: 'suffix',
    throughSequence: 152,
    targetThroughSequence: 152,
  });
  expect(suffix.body.events.at(-1).frame.data.result.tool_call.output).toBe(output);
  expect(JSON.stringify(opened.body.content)).toContain(args.query);
  expect(opened.body.runSteps.map((step: { id: string }) => step.id)).toEqual([
    'message-step',
    'tool-step',
  ]);
  expect(executions).toBe(1);
  expect(JSON.stringify(opened.body)).not.toContain('subagentTranscript');
  finish({ content: 'Done' });
  await until(async () => store.get(scopeId, scope.taskId)?.status === 'completed');
  const terminal = await request(app).get(url).expect(200);
  expect(terminal.body).toMatchObject({
    status: 'completed',
    recovery: 'complete',
    targetThroughSequence: 152,
  });
  expect(terminal.body.content).toEqual(opened.body.content);
  expect(await store.claimTask(scopeId, scope.taskId)).toMatchObject({
    status: 'completed',
    result: 'Done',
  });
  expect(executions).toBe(1);
});

it('denies owner, parent, tenant and missing-task access before journal reads', async () => {
  const { scope } = await runningTask(async () => ({ content: 'Done' }));
  const read = jest.spyOn(methods, 'getSubagentContentHead');
  const anonymous = appFor(scope, null);
  await request(anonymous.app).get(anonymous.url).expect(404);
  const unauthorized = appFor(scope, 'other-owner');
  await request(unauthorized.app).get(unauthorized.url).expect(404);
  const foreignTenant = appFor(scope, scope.user, 'other-tenant');
  await request(foreignTenant.app).get(foreignTenant.url).expect(404);
  const wrongParent = appFor({ ...scope, parentConversationId: randomUUID() });
  await request(wrongParent.app).get(wrongParent.url).expect(404);
  const missingTask = appFor({ ...scope, taskId: 'missing' });
  await request(missingTask.app).get(missingTask.url).expect(404);
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
});

it('keeps a snapshot at its sampled revision and returns the racing suffix exactly once', async () => {
  let release: (value: { content: string }) => void = () => undefined;
  const running = new Promise<{ content: string }>((resolve) => {
    release = resolve;
  });
  const { scope } = await runningTask(async () => running);
  await until(
    async () =>
      (await methods.getMessages({ user: scope.user, conversationId: scope.conversationId }))
        .length > 0,
  );
  const journal = new SubagentContentJournal({
    scope,
    flushMs: 10_000,
    batchBytes: 1_000_000,
    append: methods.appendSubagentContentBatch,
    notify: async () => undefined,
    onError: () => undefined,
  });
  const delta = (text: string) =>
    progress('message_delta', { id: 's', delta: { content: [{ type: 'text', text }] } });
  journal.record(delta('first'), 0);
  await journal.flush();
  const sampled = await methods.getSubagentContentHead(scope);
  journal.record(delta('second'), 1);
  await journal.flush();
  const snapshot = await readSubagentContent(
    { ...methods, getSubagentContentHead: async () => sampled },
    scope,
  );
  expect(snapshot).toMatchObject({ ok: true, value: { revision: 1, throughSequence: 0 } });
  const suffix = await readSubagentContent(methods, scope, 0);
  expect(suffix).toMatchObject({
    ok: true,
    value: { revision: 2, throughSequence: 1, events: [{ sequence: 1 }] },
  });
  expect(suffix.ok && suffix.value.events).toHaveLength(1);
  expect(await readSubagentContent(methods, scope, 1)).toMatchObject({
    ok: true,
    value: { events: [] },
  });
  expect(await readSubagentContent(methods, scope, 2)).toMatchObject({
    ok: false,
    error: { code: 'SUBAGENT_CONTENT_AHEAD' },
  });
  await journal.close();
  release({ content: 'Done' });
});

it('pins paged suffixes to the original revision without losing or repeating events', async () => {
  let release: (value: { content: string }) => void = () => undefined;
  const running = new Promise<{ content: string }>((resolve) => {
    release = resolve;
  });
  const { scope } = await runningTask(async () => running);
  await until(
    async () =>
      (await methods.getMessages({ user: scope.user, conversationId: scope.conversationId }))
        .length > 0,
  );
  const journal = new SubagentContentJournal({
    scope,
    flushMs: 10_000,
    batchBytes: 1024,
    append: methods.appendSubagentContentBatch,
    notify: async () => undefined,
    onError: () => undefined,
  });
  for (let sequence = 0; sequence < 40; sequence++) {
    journal.record(
      progress('message_delta', {
        id: 's',
        delta: { content: [{ type: 'text', text: `${sequence}:${'x'.repeat(200)}` }] },
      }),
      sequence,
    );
  }
  await journal.flush();
  const first = await readSubagentContent(methods, scope, -1, { pageBytes: 1024 });
  if (!first.ok) throw new Error('Expected first page');
  const sequences = first.value.events.map((event) => event.sequence);
  let cursor = first.value.nextCursor;
  journal.record(
    progress('message_delta', {
      id: 's',
      delta: { content: [{ type: 'text', text: 'racing suffix' }] },
    }),
    40,
  );
  await journal.flush();
  while (cursor != null) {
    const pin: { afterSequence: number; throughRevision: number } = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const page = await readSubagentContent(methods, scope, pin.afterSequence, {
      pageBytes: 1024,
      throughRevision: pin.throughRevision,
    });
    if (!page.ok) throw new Error('Expected suffix page');
    sequences.push(...page.value.events.map((event) => event.sequence));
    cursor = page.value.nextCursor;
  }
  expect(sequences).toEqual(Array.from({ length: 40 }, (_, index) => index));
  expect(await readSubagentContent(methods, scope, 39)).toMatchObject({
    ok: true,
    value: { events: [{ sequence: 40 }] },
  });
  await journal.close();
  release({ content: 'Done' });
});

it('retains failed-batch bytes for retry and reports a missing committed range instead of plausible empty history', async () => {
  let release: (value: { content: string }) => void = () => undefined;
  const running = new Promise<{ content: string }>((resolve) => {
    release = resolve;
  });
  const { scope } = await runningTask(async () => running);
  await until(
    async () =>
      (await methods.getMessages({ user: scope.user, conversationId: scope.conversationId }))
        .length > 0,
  );
  const append = jest
    .fn(methods.appendSubagentContentBatch)
    .mockRejectedValueOnce(new Error('database unavailable'));
  const journal = new SubagentContentJournal({
    scope,
    flushMs: 10_000,
    batchBytes: 1_000_000,
    append,
    notify: async () => undefined,
    onError: () => undefined,
  });
  journal.record(
    progress('message_delta', {
      id: 's',
      delta: { content: [{ type: 'text', text: 'retained' }] },
    }),
    0,
  );
  await expect(journal.flush()).rejects.toThrow('database unavailable');
  await expect(journal.flush()).resolves.toEqual({ ok: true });
  expect(append.mock.calls[0][0].eventsJson).toBe(append.mock.calls[1][0].eventsJson);
  expect(append.mock.calls[1][0].revision).toBe(1);
  await mongoose.models.SubagentContent.deleteMany({ taskId: scope.taskId, fragment: { $gte: 0 } });
  await expect(readSubagentContent(methods, scope)).rejects.toThrow('Incomplete committed');
  await journal.close();
  release({ content: 'Done' });
});

it('returns a typed gap when an indexed suffix seek passes a missing committed revision', async () => {
  const scope: SubagentContentScope = {
    user: 'gap-owner',
    parentConversationId: randomUUID(),
    conversationId: randomUUID(),
    taskId: randomUUID(),
  };
  const records = [0, 1, 2].flatMap((sequence) => {
    const payload = JSON.stringify([{ sequence, frame: { event: 'on_message_delta', data: {} } }]);
    const base = {
      ...scope,
      revision: sequence + 1,
      fromSequence: sequence,
      throughSequence: sequence,
      fragments: 1,
      digest: createHash('sha256').update(payload).digest('hex'),
    };
    return [
      { ...base, _id: randomUUID(), fragment: -1 },
      { ...base, _id: randomUUID(), fragment: 0, payload },
    ];
  });
  await mongoose.models.SubagentContent.create(records);
  await mongoose.models.SubagentContent.deleteMany({ ...scope, revision: 2 });
  expect(await readSubagentContent(methods, scope, 0)).toEqual({
    ok: false,
    error: { code: 'SUBAGENT_CONTENT_GAP' },
  });
});

it('expires and deletes task journals with the owning messages, without resurrecting deleted work', async () => {
  const { scope, store, scopeId } = await runningTask(async (runtime) => {
    runtime.reportProgress(
      progress('message_delta', {
        id: 's',
        delta: { content: [{ type: 'text', text: 'visible' }] },
      }),
    );
    return { content: 'Done' };
  });
  await until(async () => store.get(scopeId, scope.taskId)?.status === 'completed');
  expect(await methods.getSubagentContentHead(scope)).not.toBeNull();
  const { app, url } = appFor(scope);
  await mongoose.models.Message.updateMany(
    { conversationId: scope.conversationId },
    { $set: { expiredAt: new Date(0) } },
  );
  await request(app).get(url).expect(404);
  await methods.deleteMessages({ user: scope.user, conversationId: scope.conversationId });
  expect(await mongoose.models.SubagentContent.countDocuments({ taskId: scope.taskId })).toBe(0);
  expect(
    await methods.appendSubagentContentBatch({
      ...scope,
      revision: 2,
      fromSequence: 1,
      throughSequence: 1,
      eventsJson: '[]',
    }),
  ).toEqual({ ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } });
  await request(app).get(url).expect(404);
});

it('keeps partial public content on task failure and never discloses a recovery exception', async () => {
  const { scope, store, scopeId } = await runningTask(async (runtime) => {
    runtime.reportProgress(
      progress('run_step', {
        id: 's',
        index: 0,
        type: 'message_creation',
        stepDetails: { type: 'message_creation', message_creation: { message_id: 'visible' } },
      }),
    );
    runtime.reportProgress(
      progress('message_delta', {
        id: 's',
        delta: { content: [{ type: 'text', text: 'Partial work' }] },
      }),
    );
    throw new Error('provider failure');
  });
  await until(async () => store.get(scopeId, scope.taskId)?.status === 'error');
  const { app, url } = appFor(scope);
  const partial = await request(app).get(url).expect(200);
  expect(partial.body).toMatchObject({
    status: 'failed',
    throughSequence: 1,
    recovery: 'complete',
  });
  expect(JSON.stringify(partial.body.content)).toContain('Partial work');
  const read = jest
    .spyOn(methods, 'getSubagentContentHead')
    .mockRejectedValueOnce(new Error('private database payload'));
  const failed = await request(app).get(url).expect(503);
  expect(failed.body).toEqual({
    error: 'Subagent content unavailable',
    code: 'SUBAGENT_CONTENT_UNAVAILABLE',
  });
  expect(JSON.stringify(failed.body)).not.toContain('private');
  read.mockRestore();
});

it('settles the child result and releases ownership when final content persistence stalls', async () => {
  let release: () => void = () => undefined;
  const pending = new Promise<{ ok: false; error: { code: 'SUBAGENT_CONTENT_GONE' } }>(
    (resolve) => {
      release = () => resolve({ ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } });
    },
  );
  const append = jest
    .spyOn(methods, 'appendSubagentContentBatch')
    .mockImplementation(() => pending);
  try {
    const { scope, store, scopeId } = await runningTask(async (runtime) => {
      runtime.reportProgress(
        progress('message_delta', {
          id: 's',
          delta: { content: [{ type: 'text', text: 'Partial capture' }] },
        }),
      );
      return { content: 'Durable task result' };
    }, 100);
    await until(async () => store.get(scopeId, scope.taskId)?.status === 'completed');
    expect(store.isThreadActiveForOwner(scope.user, scope.conversationId)).toBe(false);
    const terminal = (
      await methods.getMessages(
        { user: scope.user, conversationId: scope.conversationId },
        '+subagentContent',
      )
    ).find((message) => message.messageId === `${scope.taskId}:assistant`);
    expect(terminal).toMatchObject({
      text: 'Durable task result',
      subagentContent: { version: 1, throughSequence: 0 },
    });
    const { app, url } = appFor(scope);
    const response = await request(app).get(url).expect(200);
    expect(response.body).toMatchObject({
      status: 'completed',
      recovery: 'partial',
      throughSequence: -1,
    });
    const retryUntil = response.body.retryUntil;
    expect(retryUntil).toBeGreaterThan(Date.now());
    const repeated = await request(app).get(url).expect(200);
    expect(repeated.body.retryUntil).toBe(retryUntil);
    const disabled = appFor(scope, scope.user, undefined, 0);
    const noGrace = await request(disabled.app).get(disabled.url).expect(200);
    expect(noGrace.body).not.toHaveProperty('retryUntil');
    await mongoose.models.Message.updateOne(
      { user: scope.user, messageId: `${scope.taskId}:assistant` },
      { $set: { createdAt: new Date(0) } },
      { overwriteImmutable: true, timestamps: false },
    );
    const expired = await request(app).get(url).expect(200);
    expect(expired.body).not.toHaveProperty('retryUntil');
    expect(await store.claimTask(scopeId, scope.taskId)).toMatchObject({
      status: 'completed',
      result: 'Durable task result',
    });
  } finally {
    release();
    append.mockRestore();
  }
});

it('preserves the committed prefix when the timed-out final database append finishes after lease release', async () => {
  const appends: Array<ReturnType<typeof methods.appendSubagentContentBatch>> = [];
  const appendContent = methods.appendSubagentContentBatch;
  const observeAppend = jest
    .spyOn(methods, 'appendSubagentContentBatch')
    .mockImplementation((input) => {
      const operation = appendContent(input);
      appends.push(operation);
      return operation;
    });
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { scope, store, scopeId } = await runningTask(async (runtime) => {
    runtime.reportProgress(
      progress('run_step', {
        id: 'text',
        index: 0,
        stepDetails: {
          type: 'message_creation',
          message_creation: { message_id: 'retained' },
        },
      }),
    );
    runtime.reportProgress(
      progress('message_delta', {
        id: 'text',
        delta: { content: [{ type: 'text', text: 'Retained prefix. ' }] },
      }),
    );
    await finished;
    runtime.reportProgress(
      progress('message_delta', {
        id: 'text',
        delta: { content: [{ type: 'text', text: 'Late suffix.' }] },
      }),
    );
    return { content: 'Durable result' };
  }, 100);
  await until(async () => (await methods.getSubagentContentHead(scope))?.throughSequence === 1);
  const prefix = await methods.getSubagentContentHead(scope);
  const collection = mongoose.models.SubagentContent.collection;
  const bulkWrite = collection.bulkWrite.bind(collection);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const pending = jest.spyOn(collection, 'bulkWrite').mockImplementation(async (...args) => {
    await released;
    try {
      return await bulkWrite(...args);
    } finally {
      completed();
    }
  });
  try {
    finish();
    await until(async () => store.get(scopeId, scope.taskId)?.status === 'completed');
    expect(store.isThreadActiveForOwner(scope.user, scope.conversationId)).toBe(false);
    expect(await methods.getSubagentContentHead(scope)).toEqual(prefix);
    release();
    await completion;
    await Promise.all(appends);
    expect(await methods.getSubagentContentHead(scope)).toMatchObject({ throughSequence: 2 });
    const recovered = await readSubagentContent(methods, scope);
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        throughSequence: 2,
        content: [{ type: 'text', text: 'Retained prefix. Late suffix.' }],
      },
    });
    expect(await store.claimTask(scopeId, scope.taskId)).toMatchObject({
      status: 'completed',
      result: 'Durable result',
    });
  } finally {
    finish();
    release();
    pending.mockRestore();
    observeAppend.mockRestore();
  }
});

it.each(['deleted', 'expired'] as const)(
  'removes in-flight content when the retained child is %s, not merely settled',
  async (lifetime) => {
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { scope } = await runningTask(async () => {
      await finished;
      return { content: 'Done' };
    });
    await until(
      async () =>
        (
          await methods.getMessages({
            user: scope.user,
            conversationId: scope.conversationId,
          })
        ).length > 0,
    );
    const first = await methods.appendSubagentContentBatch({
      ...scope,
      revision: 1,
      fromSequence: 0,
      throughSequence: 0,
      eventsJson: '[]',
    });
    expect(first).toEqual({ ok: true });
    const collection = mongoose.models.SubagentContent.collection;
    const bulkWrite = collection.bulkWrite.bind(collection);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = jest.spyOn(collection, 'bulkWrite').mockImplementation(async (...args) => {
      started();
      await released;
      return bulkWrite(...args);
    });
    const late = methods.appendSubagentContentBatch({
      ...scope,
      revision: 2,
      fromSequence: 1,
      throughSequence: 1,
      eventsJson: '[]',
    });
    try {
      await entering;
      const conversation = mongoose.models.Conversation;
      const filter = { user: scope.user, conversationId: scope.conversationId };
      if (lifetime === 'deleted') await conversation.deleteOne(filter);
      else await conversation.updateOne(filter, { $set: { expiredAt: new Date(0) } });
      release();
      expect(await late).toEqual({ ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } });
      expect(await mongoose.models.SubagentContent.countDocuments({ taskId: scope.taskId })).toBe(
        0,
      );
    } finally {
      release();
      await late;
      pending.mockRestore();
      finish();
    }
  },
);

describe('selective task content deletion', () => {
  const batch = { revision: 1, fromSequence: 0, throughSequence: 0, eventsJson: '[]' };
  const nextBatch = { ...batch, revision: 2, fromSequence: 1, throughSequence: 1 };
  const gone = { ok: false, error: { code: 'SUBAGENT_CONTENT_GONE' } };
  type Selection = 'user' | 'assistant' | 'both';

  const owner = (scope: SubagentContentScope) => ({
    user: scope.user,
    tenantId: scope.tenantId ?? { $exists: false },
  });
  const sourceFilter = (scope: SubagentContentScope, selection: Selection) => ({
    ...owner(scope),
    conversationId: scope.conversationId,
    messageId:
      selection === 'both'
        ? { $in: [`${scope.taskId}:user`, `${scope.taskId}:assistant`] }
        : `${scope.taskId}:${selection}`,
  });
  const journalFilter = (scope: SubagentContentScope) => ({
    ...owner(scope),
    conversationId: scope.conversationId,
    taskId: scope.taskId,
  });

  async function seedTask(tenantId?: string): Promise<SubagentContentScope> {
    const scope: SubagentContentScope = {
      user: 'deletion-owner',
      parentConversationId: randomUUID(),
      conversationId: randomUUID(),
      taskId: randomUUID(),
      ...(tenantId == null ? {} : { tenantId }),
    };
    await mongoose.models.Conversation.create([
      {
        user: scope.user,
        tenantId,
        conversationId: scope.parentConversationId,
        endpoint: 'agents',
      },
      {
        user: scope.user,
        tenantId,
        conversationId: scope.conversationId,
        endpoint: 'agents',
        subagentThread: {
          rootConversationId: scope.parentConversationId,
          parentConversationId: scope.parentConversationId,
          parentMessageId: 'parent-message',
          parentToolCallId: 'dispatch',
          subagentType: 'researcher',
          subagentKind: 'agent',
          depth: 1,
        },
        subagentThreadLease: {
          taskId: scope.taskId,
          token: 'lease',
          expiresAt: new Date(Date.now() + 60_000),
        },
      },
    ]);
    await mongoose.models.Message.create(
      (['user', 'assistant'] as const).map((role) => ({
        user: scope.user,
        tenantId,
        conversationId: scope.conversationId,
        messageId: `${scope.taskId}:${role}`,
        isCreatedByUser: role === 'user',
        subagentContent: { version: 1 },
      })),
    );
    expect(await methods.appendSubagentContentBatch({ ...scope, ...batch })).toEqual({ ok: true });
    return scope;
  }

  describe.each(['journal', 'source'] as const)('%s deletion failure', (failure) => {
    it.each(['user', 'assistant', 'both'] as const)(
      'keeps the %s source discoverable and revoked until retry succeeds',
      async (selection) => {
        const scope = await seedTask();
        const filter = sourceFilter(scope, selection);
        const collection =
          failure === 'journal'
            ? mongoose.models.SubagentContent.collection
            : mongoose.models.Message.collection;
        const outage = new Error('deletion storage unavailable');
        const failed = jest.spyOn(collection, 'deleteMany').mockRejectedValueOnce(outage);
        try {
          await expect(methods.deleteMessages(filter)).rejects.toThrow(outage);
          expect(await mongoose.models.Message.countDocuments(filter)).toBe(
            selection === 'both' ? 2 : 1,
          );
          const sources = await mongoose.models.Message.find(sourceFilter(scope, 'both'))
            .select('+subagentContent')
            .lean<Array<Pick<IMessage, 'subagentContent'>>>();
          expect(sources).toHaveLength(2);
          expect(sources.every((source) => source.subagentContent?.deleted === true)).toBe(true);
          const read = jest.spyOn(methods, 'getSubagentContentHead');
          const revoked = appFor(scope);
          const response = await request(revoked.app).get(revoked.url).expect(409);
          expect(response.body.code).toBe('SUBAGENT_CONTENT_UNAVAILABLE');
          expect(read).not.toHaveBeenCalled();
          read.mockRestore();
          expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(
            failure === 'journal' ? 2 : 0,
          );
          await expect(methods.deleteMessages(filter)).resolves.toMatchObject({
            acknowledged: true,
            deletedCount: selection === 'both' ? 2 : 1,
          });
          expect(await mongoose.models.Message.countDocuments(filter)).toBe(0);
          expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(
            0,
          );
          expect(await methods.appendSubagentContentBatch({ ...scope, ...nextBatch })).toEqual(
            gone,
          );
        } finally {
          failed.mockRestore();
        }
      },
    );
  });

  it('retries an ambiguously committed source deletion without retaining payloads', async () => {
    const scope = await seedTask();
    const collection = mongoose.models.Message.collection;
    const deleteMany = collection.deleteMany.bind(collection);
    const failed = jest.spyOn(collection, 'deleteMany').mockImplementationOnce(async (...args) => {
      await deleteMany(...args);
      throw new Error('source acknowledgement lost');
    });
    try {
      const filter = sourceFilter(scope, 'both');
      await expect(methods.deleteMessages(filter)).rejects.toThrow('source acknowledgement lost');
      expect(await mongoose.models.Message.countDocuments(filter)).toBe(0);
      expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
      await expect(methods.deleteMessages(filter)).resolves.toMatchObject({ deletedCount: 0 });
    } finally {
      failed.mockRestore();
    }
  });

  it('does not remove sources or payloads when revocation fails', async () => {
    const scope = await seedTask();
    const failed = jest
      .spyOn(mongoose.models.Message.collection, 'updateMany')
      .mockRejectedValueOnce(new Error('revocation unavailable'));
    try {
      const filter = sourceFilter(scope, 'assistant');
      await expect(methods.deleteMessages(filter)).rejects.toThrow('revocation unavailable');
      expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'both'))).toBe(2);
      expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(2);
      await expect(methods.deleteMessages(filter)).resolves.toMatchObject({ deletedCount: 1 });
    } finally {
      failed.mockRestore();
    }
  });

  it.each([undefined, 'tenant-a'])(
    'preserves adjacent task, owner, child and tenant scopes (%s)',
    async (tenantId) => {
      const scope = await seedTask(tenantId);
      const neighbors = [
        { ...scope, taskId: randomUUID() },
        { ...scope, conversationId: randomUUID(), taskId: randomUUID() },
        { ...scope, user: 'another-owner' },
        { ...scope, tenantId: 'tenant-b' },
      ];
      for (const neighbor of neighbors) {
        await mongoose.models.Message.create({
          user: neighbor.user,
          tenantId: neighbor.tenantId,
          conversationId: neighbor.conversationId,
          messageId: `${neighbor.taskId}:assistant`,
          subagentContent: { version: 1 },
        });
        await mongoose.models.SubagentContent.create({
          ...neighbor,
          ...batch,
          _id: randomUUID(),
          fragment: 0,
          fragments: 1,
          digest: 'unrelated',
          payload: 'retained',
        });
      }
      const otherChildJournal = { ...scope, conversationId: randomUUID() };
      await mongoose.models.SubagentContent.create({
        ...otherChildJournal,
        ...batch,
        _id: randomUUID(),
        fragment: 0,
        fragments: 1,
        digest: 'unrelated',
        payload: 'retained',
      });
      const missing = { ...sourceFilter(scope, 'assistant'), messageId: 'missing:assistant' };
      await expect(methods.deleteMessages(missing)).resolves.toMatchObject({ deletedCount: 0 });
      expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(2);
      await methods.deleteMessages(sourceFilter(scope, 'assistant'));
      expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'user'))).toBe(1);
      expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
      expect(
        await mongoose.models.SubagentContent.countDocuments(journalFilter(otherChildJournal)),
      ).toBe(1);
      for (const neighbor of neighbors) {
        const source = await mongoose.models.Message.findOne(sourceFilter(neighbor, 'assistant'))
          .select('+subagentContent')
          .lean<Pick<IMessage, 'subagentContent'> | null>();
        expect(source?.subagentContent).toMatchObject({ version: 1 });
        expect(source?.subagentContent).not.toHaveProperty('deleted');
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(neighbor))).toBe(
          1,
        );
      }
    },
  );

  it.each([undefined, 'tenant-a'])(
    'does not report successful conversation deletion before journal cleanup succeeds (%s)',
    async (tenantId) => {
      const scope = await seedTask(tenantId);
      const unrelated = await seedTask(tenantId);
      const Content = mongoose.models.SubagentContent;
      const Conversation = mongoose.models.Conversation;
      const journalDelete = Content.collection.deleteMany.bind(Content.collection);
      const conversationDelete = Conversation.collection.deleteMany.bind(Conversation.collection);
      let successfulCleanup = false;
      const cleanup = jest
        .spyOn(Content.collection, 'deleteMany')
        .mockRejectedValueOnce(new Error('journal temporarily unavailable'))
        .mockImplementation(async (...args) => {
          const result = await journalDelete(...args);
          successfulCleanup = true;
          return result;
        });
      const deleting = jest
        .spyOn(Conversation.collection, 'deleteMany')
        .mockImplementation(async (...args) => {
          expect(successfulCleanup).toBe(true);
          expect(await Content.countDocuments(journalFilter(scope))).toBe(0);
          return conversationDelete(...args);
        });
      try {
        const result = await methods.deleteConvos(scope.user, {
          conversationId: scope.conversationId,
        });
        expect(result.deletedCount).toBe(1);
        expect(result.messages.acknowledged).toBe(true);
        expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'both'))).toBe(0);
        expect(await Content.countDocuments(journalFilter(scope))).toBe(0);
        expect(await Content.countDocuments(journalFilter(unrelated))).toBe(2);
        expect(
          await Conversation.countDocuments({
            user: unrelated.user,
            conversationId: unrelated.conversationId,
          }),
        ).toBe(1);
      } finally {
        cleanup.mockRestore();
        deleting.mockRestore();
      }
    },
  );

  it.each(['revocation', 'journal', 'conversation'] as const)(
    'keeps a failed %s barrier discoverable for a direct conversation retry',
    async (failure) => {
      const scope = await seedTask();
      const Message = mongoose.models.Message;
      const Conversation = mongoose.models.Conversation;
      const Content = mongoose.models.SubagentContent;
      const injectFailure = {
        revocation: () => jest.spyOn(Message.collection, 'updateMany'),
        journal: () => jest.spyOn(Content.collection, 'deleteMany'),
        conversation: () => jest.spyOn(Conversation.collection, 'deleteMany'),
      };
      const failed = injectFailure[failure]().mockRejectedValue(new Error('erasure unavailable'));
      try {
        await expect(
          methods.deleteConvos(scope.user, { conversationId: scope.conversationId }),
        ).rejects.toThrow('erasure unavailable');
        expect(
          await Conversation.countDocuments({
            user: scope.user,
            conversationId: scope.conversationId,
          }),
        ).toBe(1);
        expect(await Message.countDocuments(sourceFilter(scope, 'both'))).toBe(2);
        expect(await Content.countDocuments(journalFilter(scope))).toBe(
          failure === 'conversation' ? 0 : 2,
        );
        failed.mockRestore();
        const result = await methods.deleteConvos(scope.user, {
          conversationId: scope.conversationId,
        });
        expect(result.deletedCount).toBe(1);
        expect(result.messages.deletedCount).toBe(2);
        expect(await Content.countDocuments(journalFilter(scope))).toBe(0);
        expect(await Message.countDocuments(sourceFilter(scope, 'both'))).toBe(0);
      } finally {
        failed.mockRestore();
      }
    },
  );

  it('retries a committed journal deletion whose acknowledgement was lost before deleting topology', async () => {
    const scope = await seedTask();
    const collection = mongoose.models.SubagentContent.collection;
    const original = collection.deleteMany.bind(collection);
    const failed = jest.spyOn(collection, 'deleteMany').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('journal acknowledgement lost');
    });
    try {
      const result = await methods.deleteConvos(scope.user, {
        conversationId: scope.conversationId,
      });
      expect(result.deletedCount).toBe(1);
      expect(result.messages.deletedCount).toBe(2);
      expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
      expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'both'))).toBe(0);
    } finally {
      failed.mockRestore();
    }
  });

  it('preserves a failed descendant wave for root retry without losing journal scope', async () => {
    const scope = await seedTask();
    const Content = mongoose.models.SubagentContent;
    const original = Content.collection.deleteMany.bind(Content.collection);
    const failed = jest
      .spyOn(Content.collection, 'deleteMany')
      .mockImplementation(async (...args) => {
        const query = JSON.stringify(args[0]);
        if (query.includes(scope.conversationId)) throw new Error('child journal unavailable');
        return original(...args);
      });
    try {
      await expect(
        methods.deleteConvos(scope.user, { conversationId: scope.parentConversationId }),
      ).rejects.toThrow('child journal unavailable');
      expect(
        await mongoose.models.Conversation.countDocuments({
          user: scope.user,
          conversationId: scope.parentConversationId,
        }),
      ).toBe(0);
      expect(
        await mongoose.models.Conversation.countDocuments({
          user: scope.user,
          conversationId: scope.conversationId,
        }),
      ).toBe(1);
      expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'both'))).toBe(2);
      expect(await Content.countDocuments(journalFilter(scope))).toBe(2);
      failed.mockRestore();
      const result = await methods.deleteConvos(scope.user, {
        conversationId: scope.parentConversationId,
      });
      expect(result.conversationIds).toEqual([scope.parentConversationId, scope.conversationId]);
      expect(await Content.countDocuments(journalFilter(scope))).toBe(0);
      expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'both'))).toBe(0);
    } finally {
      failed.mockRestore();
    }
  });

  it.each(['owner', 'conversation'] as const)(
    'keeps whole-%s sources until journal cleanup succeeds',
    async (selection) => {
      const scope = await seedTask();
      const filter = {
        ...owner(scope),
        ...(selection === 'conversation' ? { conversationId: scope.conversationId } : {}),
      };
      const failed = jest
        .spyOn(mongoose.models.SubagentContent.collection, 'deleteMany')
        .mockRejectedValueOnce(new Error('journal unavailable'));
      try {
        await expect(methods.deleteMessages(filter)).rejects.toThrow('journal unavailable');
        expect(await mongoose.models.Message.countDocuments(sourceFilter(scope, 'both'))).toBe(2);
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(2);
        await expect(methods.deleteMessages(filter)).resolves.toMatchObject({ deletedCount: 2 });
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
      } finally {
        failed.mockRestore();
      }
    },
  );

  it.each(['user', 'assistant', 'both'] as const)(
    'cleans an admitted append after deleting %s sources',
    async (selection) => {
      const scope = await seedTask();
      const collection = mongoose.models.SubagentContent.collection;
      const bulkWrite = collection.bulkWrite.bind(collection);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const entering = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = jest
        .spyOn(collection, 'bulkWrite')
        .mockImplementationOnce(async (...args) => {
          started();
          await released;
          return bulkWrite(...args);
        });
      const late = methods.appendSubagentContentBatch({ ...scope, ...nextBatch });
      try {
        await entering;
        await methods.deleteMessages(sourceFilter(scope, selection));
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
        if (selection === 'assistant') {
          const revoked = appFor(scope);
          const response = await request(revoked.app).get(revoked.url).expect(409);
          expect(response.body.code).toBe('SUBAGENT_CONTENT_UNAVAILABLE');
        }
        release();
        expect(await late).toEqual(gone);
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
        expect(await methods.appendSubagentContentBatch({ ...scope, ...nextBatch })).toEqual(gone);
      } finally {
        release();
        await late;
        pending.mockRestore();
      }
    },
  );

  it.each(
    [undefined, 'tenant-a'].flatMap((tenantId) =>
      (['postwrite', 'fragment', 'commit'] as const).map((failure) => ({ tenantId, failure })),
    ),
  )(
    'automatically reconciles an abandoned journal after $failure cleanup failure ($tenantId)',
    async ({ tenantId, failure }) => {
      const scope = await seedTask(tenantId);
      const Model = mongoose.models.SubagentContent;
      await Model.deleteMany(journalFilter(scope));
      const neighbors = [
        { ...scope, taskId: randomUUID() },
        { ...scope, user: 'other-owner' },
        { ...scope, tenantId: tenantId == null ? 'tenant-b' : undefined },
        { ...scope, conversationId: randomUUID() },
      ];
      await Model.create(
        neighbors.map((neighbor) => ({
          ...neighbor,
          ...batch,
          _id: randomUUID(),
          fragment: 0,
          fragments: 1,
          digest: 'neighbor',
          payload: 'retained',
        })),
      );
      const collection = Model.collection;
      const bulkWrite = collection.bulkWrite.bind(collection);
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const entering = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = jest
        .spyOn(collection, 'bulkWrite')
        .mockImplementationOnce(async (...args) => {
          started();
          await released;
          const result = await bulkWrite(...args);
          if (failure === 'fragment') throw new Error('partial fragment acknowledgement lost');
          return result;
        });
      const updateOne = collection.updateOne.bind(collection);
      const commit = jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        const result = await updateOne(...args);
        if (failure === 'commit') throw new Error('commit acknowledgement lost');
        return result;
      });
      const append = jest.fn(methods.appendSubagentContentBatch);
      const notify = jest.fn(async () => undefined);
      const errors = jest.fn();
      const journal = new SubagentContentJournal({
        scope,
        flushMs: 60_000,
        batchBytes: 1,
        settlementTimeoutMs: 20,
        append,
        reconcile: methods.reconcileSubagentContent,
        cleanupRetry: { retryAttempts: 3, retryBaseDelayMs: 1, recoveryDelayMs: 100 },
        notify,
        onError: errors,
      });
      journal.record(
        progress('message_delta', {
          id: 's',
          delta: { content: [{ type: 'text', text: 'late bytes' }] },
        }),
        0,
      );
      await entering;
      journal.record(progress('message_delta', { id: 's', delta: { content: [] } }), 1);
      await expect(journal.close()).resolves.toMatchObject({
        ok: false,
        error: { code: 'SUBAGENT_CONTENT_SETTLEMENT_TIMEOUT' },
      });
      await methods.deleteMessages(sourceFilter(scope, 'both'));
      await mongoose.models.Conversation.deleteMany({
        ...owner(scope),
        conversationId: { $in: [scope.parentConversationId, scope.conversationId] },
      });
      const failed = jest
        .spyOn(collection, 'deleteMany')
        .mockRejectedValueOnce(new Error('late cleanup unavailable'));
      try {
        release();
        await until(async () => failed.mock.calls.length >= 2);
        await until(async () => (await Model.countDocuments(journalFilter(scope))) === 0);
        expect(append).toHaveBeenCalledTimes(1);
        expect(notify).not.toHaveBeenCalled();
        expect(errors).toHaveBeenCalled();
        for (const neighbor of neighbors) {
          expect(await Model.countDocuments(journalFilter(neighbor))).toBe(1);
        }
      } finally {
        release();
        await Promise.allSettled(append.mock.results.map((result) => result.value));
        failed.mockRestore();
        pending.mockRestore();
        commit.mockRestore();
      }
    },
  );

  it('retries a failed post-write cleanup after selective source erasure', async () => {
    const scope = await seedTask();
    const collection = mongoose.models.SubagentContent.collection;
    const bulkWrite = collection.bulkWrite.bind(collection);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = jest.spyOn(collection, 'bulkWrite').mockImplementationOnce(async (...args) => {
      started();
      await released;
      return bulkWrite(...args);
    });
    const late = methods.appendSubagentContentBatch({ ...scope, ...nextBatch });
    try {
      await entering;
      await methods.deleteMessages(sourceFilter(scope, 'both'));
      const failed = jest
        .spyOn(collection, 'deleteMany')
        .mockRejectedValueOnce(new Error('late cleanup unavailable'));
      try {
        release();
        await expect(late).rejects.toThrow('late cleanup unavailable');
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(2);
        expect(await methods.appendSubagentContentBatch({ ...scope, ...nextBatch })).toEqual(gone);
        expect(await mongoose.models.SubagentContent.countDocuments(journalFilter(scope))).toBe(0);
      } finally {
        failed.mockRestore();
      }
    } finally {
      release();
      await late.catch(() => undefined);
      pending.mockRestore();
    }
  });
});

it.each(['long input', 'mismatched input', 'safe boundary', 'append'] as const)(
  'preserves usable legacy history through the real parent-authorized view with %s',
  async (condition) => {
    const { scope } = await runningTask(async () => ({ content: 'Final result.' }));
    await until(
      async () =>
        (await methods.getMessages({ user: scope.user, messageId: `${scope.taskId}:assistant` }))
          .length === 1,
    );
    const prompt = condition === 'long input' ? 'Long current task. '.repeat(575) : 'Current task.';
    const activity = [
      { type: 'reasoning', text: 'Saved current reasoning.' },
      { type: 'writing', text: 'Saved current activity.' },
    ];
    const current = [
      {
        type: 'human',
        data: { content: condition === 'mismatched input' ? 'Unrelated prompt.' : prompt },
      },
      { type: 'ai', data: { content: 'Before current guidance.' } },
      {
        type: 'human',
        data: {
          content: 'Current guidance.',
          additional_kwargs: { injected: true, source: 'steer' },
        },
      },
      { type: 'ai', data: { content: 'After current guidance.' } },
    ];
    const previous = [
      { type: 'human', data: { content: 'Private previous task.' } },
      {
        type: 'human',
        data: {
          content: 'Private previous guidance.',
          additional_kwargs: { injected: true, source: 'steer' },
        },
      },
      { type: 'ai', data: { content: 'Private previous activity.' } },
    ];
    await mongoose.models.Message.updateOne(
      { user: scope.user, messageId: `${scope.taskId}:user` },
      { $set: { text: prompt } },
    );
    await mongoose.models.Message.updateOne(
      { user: scope.user, messageId: `${scope.taskId}:assistant` },
      {
        $set: {
          subagentActivityProjection: {
            taskId: scope.taskId,
            version: 1,
            activityJson: JSON.stringify(activity),
            truncated: false,
          },
          subagentTranscript: {
            taskId: scope.taskId,
            mode: condition === 'append' ? 'append' : 'replace',
            messagesJson: JSON.stringify(
              condition === 'append' ? current.slice(1) : [...previous, ...current],
            ),
          },
        },
      },
    );
    const app = express();
    app.use((req, _res, next) => {
      (req as ServerRequest).user = { id: scope.user } as ServerRequest['user'];
      next();
    });
    const handler = createSubagentThreadViewHandler(methods);
    app.get('/api/convos/:parentConversationId/subagents/:threadId', (req, res) =>
      handler(req as ServerRequest, res),
    );
    const response = await request(app)
      .get(
        `/api/convos/${scope.parentConversationId}/subagents/${scope.conversationId}?taskId=${scope.taskId}`,
      )
      .expect(200);
    expect(response.body.activity).toEqual(
      condition === 'safe boundary' || condition === 'append'
        ? [
            { type: 'writing', text: 'Before current guidance.' },
            { type: 'steer', steer: 'Current guidance.' },
            { type: 'writing', text: 'After current guidance.' },
          ]
        : activity,
    );
    expect(response.body.activityTruncated).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('Private previous');
    expect(response.body).not.toHaveProperty('subagentTranscript');
  },
);
