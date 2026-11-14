import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { EModelEndpoint } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods, logger } from '@librechat/data-schemas';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import type {
  SubagentTaskStartRequest,
  SubagentTaskStartResult,
  SubagentTaskRuntime,
  SubagentUpdateEvent,
} from '@librechat/agents';
import type { AllMethods, IConversation, IMessage } from '@librechat/data-schemas';
import type { FinalEvent, ServerSentEvent } from '~/types';
import { buildSubagentThreadTaskConfig, SubagentThreadTaskStore } from './subagentThreads';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createChildGenerationHost } from './subagentGeneration';

jest.spyOn(console, 'log').mockImplementation();

let mongod: MongoMemoryServer;
let methods: AllMethods;
let manager: GenerationJobManagerClass;
let loggerErrorSpy: jest.SpyInstance;

const userId = 'child-stream-user';

const progress = (
  phase: SubagentUpdateEvent['phase'],
  data: SubagentUpdateEvent['data'],
): SubagentUpdateEvent => ({
  runId: 'root-run',
  parentRunId: 'parent-run',
  subagentRunId: 'child-run',
  subagentType: 'researcher-agent',
  subagentKind: 'agent',
  subagentAgentId: 'agent-1',
  parentToolCallId: 'tool-call',
  depth: 1,
  ancestry: [],
  phase,
  data,
  timestamp: '2026-11-14T20:00:00.000Z',
});

const step = () =>
  progress('run_step', {
    id: 'step-1',
    index: 0,
    stepDetails: { type: 'message_creation', message_creation: { message_id: 'step-1' } },
  });

const words = (text: string) =>
  progress('message_delta', { id: 'step-1', delta: { content: [{ type: 'text', text }] } });

/** A child that streams, then waits for the test before it finishes or fails. */
function gatedRun(outcome: 'complete' | 'fail' = 'complete') {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run: SubagentTaskStartRequest['run'] = async (
    runtime: SubagentTaskRuntime,
    initialMessages = [],
  ) => {
    runtime.reportProgress(step());
    runtime.reportProgress(words('Looking '));
    runtime.reportProgress(words('into it.'));
    await Promise.race([
      gate,
      new Promise<void>((_resolve, reject) => {
        runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
          once: true,
        });
      }),
    ]);
    if (outcome === 'fail') throw new Error('provider exploded with key sk-secret');
    return {
      content: 'Looking into it.',
      messages: [
        ...initialMessages,
        new HumanMessage('Investigate the issue.'),
        new AIMessage('Looking into it.'),
      ],
    };
  };
  return { run, release };
}

function taskRequest(
  scopeId: string,
  overrides: Partial<SubagentTaskStartRequest>,
): SubagentTaskStartRequest {
  return {
    scopeId,
    idempotencyKey: randomUUID(),
    parentRunId: randomUUID(),
    parentAgentId: 'parent-agent',
    parentToolCallId: randomUUID(),
    input: 'Investigate the issue.',
    subagentKind: 'agent',
    subagentType: 'researcher-agent',
    run: gatedRun().run,
    ...overrides,
  };
}

function threadOf(started: SubagentTaskStartResult): { threadId: string; taskId: string } {
  if (!started.accepted || !started.task.threadId) throw new Error('Expected an accepted task.');
  return { threadId: started.task.threadId, taskId: started.task.taskId };
}

async function waitUntil(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function setup(activity?: { generationJobs: boolean }) {
  const parentConversationId = randomUUID();
  await methods.saveConvo(
    { userId },
    {
      conversationId: parentConversationId,
      endpoint: EModelEndpoint.agents,
      title: 'Parent thread',
      agent_id: 'parent-agent',
    },
  );
  const store = new SubagentThreadTaskStore(methods, {
    childGenerations: createChildGenerationHost(manager),
    ...(activity == null ? {} : { activity }),
  });
  const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
  return { store, scopeId: config.scopeId, parentConversationId };
}

/** Attaches the way the stream route does, collecting chunks and the final event. */
async function attach(threadId: string) {
  const chunks: ServerSentEvent[] = [];
  let resolveFinal!: (event: FinalEvent) => void;
  const final = new Promise<FinalEvent>((resolve) => {
    resolveFinal = resolve;
  });
  await manager.subscribe(
    threadId,
    (event) => chunks.push(event),
    (event) => resolveFinal(event as FinalEvent),
  );
  return { chunks, final };
}

const assistantRow = async (threadId: string, taskId: string) =>
  (
    await methods.getMessages(
      { user: userId, conversationId: threadId, messageId: `${taskId}:assistant` },
      '+subagentTask',
    )
  )[0];

beforeAll(async () => {
  loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  mongod = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
  loggerErrorSpy.mockRestore();
});

beforeEach(async () => {
  await Promise.all([
    (mongoose.models.Message as mongoose.Model<IMessage>).deleteMany({}),
    (mongoose.models.Conversation as mongoose.Model<IConversation>).deleteMany({}),
  ]);
  manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  manager.initialize();
});

afterEach(async () => {
  await manager.destroy();
});

describe('a background child as a generation job', () => {
  it('runs under a job keyed by its thread id that is not listed as a chat', async () => {
    const { store, scopeId, parentConversationId } = await setup();
    const { run, release } = gatedRun();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, { run })));
    await waitUntil(async () => (await manager.getJob(threadId)) != null, 'the child job');

    const job = await manager.getJob(threadId);
    expect(job).toMatchObject({ status: 'running' });
    expect(job?.metadata).toMatchObject({
      userId,
      conversationId: threadId,
      subagentTaskId: taskId,
      subagentParentConversationId: parentConversationId,
      responseMessageId: `${taskId}:assistant`,
    });
    await expect(manager.getActiveJobIdsForUser(userId)).resolves.toEqual([]);

    release();
    await waitUntil(async () => (await manager.getJob(threadId))?.status === 'complete', 'settle');
  });

  it('hands a reader who opens mid-run everything streamed so far', async () => {
    const { store, scopeId } = await setup();
    const { run, release } = gatedRun();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, { run })));
    await waitUntil(
      async () =>
        JSON.stringify((await manager.getResumeState(threadId))?.aggregatedContent ?? []).includes(
          'into it.',
        ),
      'streamed content',
    );

    const state = await manager.getResumeState(threadId);

    expect(JSON.stringify(state?.aggregatedContent)).toContain('Looking into it.');
    expect(state?.userMessage).toMatchObject({
      messageId: `${taskId}:user`,
      text: 'Investigate the issue.',
    });
    expect(state?.responseMessageId).toBe(`${taskId}:assistant`);
    expect(state?.runSteps).toHaveLength(1);

    release();
    await waitUntil(async () => (await manager.getJob(threadId))?.status === 'complete', 'settle');
  });

  it('publishes the final event only once the result row is durable', async () => {
    const { store, scopeId } = await setup();
    const { run, release } = gatedRun();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, { run })));
    await waitUntil(async () => (await manager.getJob(threadId)) != null, 'the child job');
    const { final } = await attach(threadId);
    const rowAtFinal = final.then(() => assistantRow(threadId, taskId));

    release();

    await expect(final).resolves.toMatchObject({
      final: true,
      conversation: { conversationId: threadId },
      requestMessage: { messageId: `${taskId}:user`, text: 'Investigate the issue.' },
      responseMessage: {
        messageId: `${taskId}:assistant`,
        parentMessageId: `${taskId}:user`,
        text: 'Looking into it.',
        unfinished: false,
      },
    });
    expect(JSON.stringify((await final).responseMessage?.content)).toContain('Looking into it.');
    expect((await rowAtFinal)?.subagentTask?.status).toBe('completed');
  });

  it('ends a cancelled child with an aborted final and a cancelled row', async () => {
    const { store, scopeId } = await setup();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, {})));
    await waitUntil(async () => (await manager.getJob(threadId)) != null, 'the child job');
    const { final } = await attach(threadId);

    store.control(scopeId, taskId, { action: 'cancel' });

    await expect(final).resolves.toMatchObject({ final: true, aborted: true });
    expect((await assistantRow(threadId, taskId))?.subagentTask?.status).toBe('cancelled');
    expect((await manager.getJob(threadId))?.status).toBe('aborted');
  });

  it('ends a failed child with an error row and no provider detail', async () => {
    const { store, scopeId } = await setup();
    const { run, release } = gatedRun('fail');
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, { run })));
    await waitUntil(async () => (await manager.getJob(threadId)) != null, 'the child job');
    const { final } = await attach(threadId);

    release();

    const event = await final;
    expect(event).toMatchObject({ final: true, responseMessage: { error: true } });
    expect(JSON.stringify(event)).not.toContain('sk-secret');
    expect((await assistantRow(threadId, taskId))?.error).toBe(true);
  });

  it('stops the child when its job is aborted from outside', async () => {
    const { store, scopeId } = await setup();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, {})));
    await waitUntil(async () => (await manager.getJob(threadId)) != null, 'the child job');
    const job = await manager.getJob(threadId);

    await manager.abortJob(threadId, { expectedCreatedAt: job?.createdAt });

    await waitUntil(() => store.get(scopeId, taskId)?.status === 'cancelled', 'cancellation');
    await waitUntil(
      async () => (await assistantRow(threadId, taskId))?.subagentTask?.status === 'cancelled',
      'the cancelled row',
    );
    expect(store.get(scopeId, taskId)?.status).toBe('cancelled');
    expect((await manager.getJob(threadId))?.status).toBe('aborted');
  });

  it('lets the child persist its cancellation when the job manager shuts down first', async () => {
    const { store, scopeId } = await setup();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, {})));
    await waitUntil(async () => (await manager.getJob(threadId)) != null, 'the child job');

    await manager.destroy();

    await waitUntil(() => store.get(scopeId, taskId)?.status === 'cancelled', 'cancellation');
    await waitUntil(
      async () => (await assistantRow(threadId, taskId))?.subagentTask?.status === 'cancelled',
      'the cancelled row',
    );
    expect(store.get(scopeId, taskId)?.status).toBe('cancelled');
    expect((await assistantRow(threadId, taskId))?.text).toBe('Subagent task was cancelled.');
  });

  it('gives a continuation of the thread a new generation of the same stream', async () => {
    const { store, scopeId } = await setup();
    const first = gatedRun();
    const started = threadOf(store.start(taskRequest(scopeId, { run: first.run })));
    await waitUntil(async () => (await manager.getJob(started.threadId)) != null, 'the first job');
    const firstCreatedAt = (await manager.getJob(started.threadId))?.createdAt ?? 0;
    first.release();
    await waitUntil(() => store.get(scopeId, started.taskId)?.status === 'completed', 'first task');

    const second = gatedRun();
    const continued = threadOf(
      store.start(taskRequest(scopeId, { run: second.run, threadId: started.threadId })),
    );
    await waitUntil(
      async () =>
        (await manager.getJob(started.threadId))?.metadata.subagentTaskId === continued.taskId,
      'the continuation job',
    );

    const job = await manager.getJob(started.threadId);
    expect(continued.threadId).toBe(started.threadId);
    expect(job).toMatchObject({ status: 'running' });
    expect(job?.createdAt).toBeGreaterThan(firstCreatedAt);

    second.release();
    await waitUntil(
      () => store.get(scopeId, continued.taskId)?.status === 'completed',
      'second task',
    );
  });

  it('runs without a job when the lever is off', async () => {
    const { store, scopeId } = await setup({ generationJobs: false });
    const { run, release } = gatedRun();
    const { threadId, taskId } = threadOf(store.start(taskRequest(scopeId, { run })));
    await waitUntil(
      async () =>
        (
          await methods.getMessages({
            user: userId,
            conversationId: threadId,
            messageId: `${taskId}:user`,
          })
        ).length === 1,
      'the task input row',
    );

    expect(await manager.getJob(threadId)).toBeUndefined();

    release();
    await waitUntil(() => store.get(scopeId, taskId)?.status === 'completed', 'the task');
    expect((await assistantRow(threadId, taskId))?.subagentTask?.status).toBe('completed');
  });

  it('still completes and persists the child when the stream cannot be opened', async () => {
    const parentConversationId = randomUUID();
    await methods.saveConvo(
      { userId },
      { conversationId: parentConversationId, endpoint: EModelEndpoint.agents, title: 'Parent' },
    );
    const store = new SubagentThreadTaskStore(methods, {
      childGenerations: {
        open: async () => {
          throw new Error('stream store offline');
        },
      },
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const { run, release } = gatedRun();
    const { threadId, taskId } = threadOf(store.start(taskRequest(config.scopeId, { run })));

    release();

    await waitUntil(() => store.get(config.scopeId, taskId)?.status === 'completed', 'the task');
    expect((await assistantRow(threadId, taskId))?.subagentTask?.status).toBe('completed');
  });
});
