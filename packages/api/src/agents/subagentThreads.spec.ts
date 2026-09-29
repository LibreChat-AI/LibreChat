import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import {
  createMethods,
  createModels,
  getTenantId,
  getUserId,
  logger,
  tenantStorage,
} from '@librechat/data-schemas';
import type {
  SubagentTaskClaim,
  SubagentTaskControlCommand,
  SubagentTaskControlResult,
  SubagentTaskRuntime,
  SubagentTaskSnapshot,
  SubagentTaskStartRequest,
  SubagentTaskStartResult,
  SubagentUpdateEvent,
} from '@librechat/agents';
import type { AllMethods, IConversation, IMessage } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type {
  SubagentTaskControlHandler,
  SubagentTaskControlTransport,
} from './subagentTaskRouting';
import type { SubagentTaskWakeupRegistration } from './subagentThreads';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import {
  buildSubagentThreadTaskConfig,
  createSubagentThreadTaskStore,
  SubagentThreadTaskStore,
} from './subagentThreads';
import { controlFingerprint, SubagentTaskOwnerUnavailableError } from './subagentTaskRouting';
import { SUBAGENT_COMPLETION_DELIVERY } from './subagentDelivery';
import { createSubagentAttemptKey } from './subagentThreadIds';
import { SubagentActivityStream } from './subagentActivity';
import { createSubagentUsageSink } from './usage';

let mongod: MongoMemoryServer;
let methods: AllMethods;
let loggerErrorSpy: jest.SpyInstance;

class TestTaskRoutingHub {
  readonly owners = new Map<string, TestTaskControlTransport>();

  key(scopeId: string, taskId: string): string {
    return `${scopeId}\u0000${taskId}`;
  }
}

class ReceiptTestSubagentThreadTaskStore extends SubagentThreadTaskStore {
  emitControlReceiptForTest(
    scopeId: string,
    taskId: string,
    receipt: {
      controlId: string;
      action: 'steer' | 'queue' | 'interrupt';
      status: 'accepted' | 'applied' | 'rejected' | 'failed';
      createdAt: number;
      updatedAt: number;
      boundary?: 'preempt' | 'tool' | 'turn';
      reason?: 'withdrawn' | 'task_completed' | 'task_cancelled' | 'task_failed';
    },
  ): void {
    this.onControlReceipt(scopeId, taskId, receipt);
  }
}

class TestTaskControlTransport implements SubagentTaskControlTransport {
  private handler?: SubagentTaskControlHandler;
  readonly registrations: Array<{ scopeId: string; taskId: string; ttlMs: number }> = [];

  constructor(private readonly hub: TestTaskRoutingHub) {}

  async bind(handler: SubagentTaskControlHandler): Promise<void> {
    this.handler = handler;
  }

  async registerTask(scopeId: string, taskId: string, ttlMs: number): Promise<void> {
    this.registrations.push({ scopeId, taskId, ttlMs });
    this.hub.owners.set(this.hub.key(scopeId, taskId), this);
  }

  async hasTasks(scopeId: string): Promise<boolean> {
    const prefix = `${scopeId}\u0000`;
    return [...this.hub.owners.keys()].some((key) => key.startsWith(prefix));
  }

  async claim(scopeId: string, taskId: string): Promise<SubagentTaskClaim | undefined> {
    return this.hub.owners.get(this.hub.key(scopeId, taskId))?.handler?.claim(scopeId, taskId);
  }

  async control(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    _invocationId: string,
  ): Promise<SubagentTaskControlResult | undefined> {
    return this.hub.owners
      .get(this.hub.key(scopeId, taskId))
      ?.handler?.control(scopeId, taskId, command, _invocationId);
  }

  async list(scopeId: string): Promise<SubagentTaskSnapshot[]> {
    return [...this.remoteOwners(scopeId)].flatMap((owner) => owner.handler?.list(scopeId) ?? []);
  }

  async cancelScope(
    scopeId: string,
    threadIds: string[] | null,
    removedConversationIds?: string[],
  ): Promise<number> {
    let cancelled = 0;
    for (const owner of this.remoteOwners(scopeId)) {
      cancelled += owner.handler?.cancelScope(scopeId, threadIds, removedConversationIds) ?? 0;
    }
    return cancelled;
  }

  async destroy(): Promise<void> {}

  private remoteOwners(scopeId: string): Set<TestTaskControlTransport> {
    const owners = new Set<TestTaskControlTransport>();
    const prefix = `${scopeId}\u0000`;
    for (const [key, owner] of this.hub.owners) {
      if (key.startsWith(prefix) && owner !== this) {
        owners.add(owner);
      }
    }
    return owners;
  }
}

function taskRequest(
  scopeId: string,
  overrides: Partial<SubagentTaskStartRequest> = {},
): SubagentTaskStartRequest {
  const input = overrides.input ?? 'Investigate the issue.';
  return {
    scopeId,
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    parentRunId: overrides.parentRunId ?? randomUUID(),
    parentAgentId: overrides.parentAgentId ?? 'parent-agent',
    parentToolCallId: overrides.parentToolCallId ?? randomUUID(),
    ...(overrides.requestFingerprint == null
      ? {}
      : { requestFingerprint: overrides.requestFingerprint }),
    input,
    subagentKind: overrides.subagentKind ?? 'agent',
    subagentType: overrides.subagentType ?? 'researcher-agent',
    run:
      overrides.run ??
      (async (_runtime: SubagentTaskRuntime, initialMessages = []) => ({
        content: 'Completed the investigation.',
        messages: [
          ...initialMessages,
          new HumanMessage(input),
          new AIMessage('Completed the investigation.'),
        ],
      })),
    ...(overrides.threadId == null ? {} : { threadId: overrides.threadId }),
  };
}

function replayTransport(claim: SubagentTaskClaim): SubagentTaskControlTransport {
  return {
    bind: async () => undefined,
    registerTask: async () => undefined,
    hasTasks: async () => true,
    claim: async () => claim,
    control: async () => undefined,
    list: async () => [],
    cancelScope: async () => 0,
    destroy: async () => undefined,
  };
}

function threadSnapshot(taskId: string): SubagentTaskSnapshot {
  return {
    taskId,
    subagentType: 'researcher',
    status: 'cancelled',
    createdAt: 1,
    updatedAt: 2,
    resultAvailable: false,
    resultClaimed: true,
    pendingControls: 0,
  };
}

async function waitForSettled(
  store: SubagentThreadTaskStore,
  scopeId: string,
  started: SubagentTaskStartResult,
): Promise<void> {
  const accepted = requireAccepted(started);
  /** Coverage shards can briefly starve this polling loop while Mongo-backed
   * suites build indexes in parallel. Keep the assertion bounded without
   * treating two seconds of runner contention as a task-lifecycle failure. */
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const task = store.get(scopeId, accepted.task.taskId);
    if (task != null && task.status !== 'running') {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the subagent task.');
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function requireAccepted(
  started: SubagentTaskStartResult,
): Extract<SubagentTaskStartResult, { accepted: true }> {
  if (!started.accepted) {
    throw new Error('Expected the task to be accepted.');
  }
  return started;
}

function requireThreadId(started: SubagentTaskStartResult): string {
  const accepted = requireAccepted(started);
  if (!accepted.task.threadId) {
    throw new Error('Expected the accepted task to expose its durable thread id.');
  }
  return accepted.task.threadId;
}

async function saveParent(
  userId: string,
  conversationId: string,
  overrides: Record<string, unknown> = {},
): Promise<IConversation> {
  const saved = await methods.saveConvo(
    { userId },
    {
      conversationId,
      endpoint: EModelEndpoint.agents,
      title: 'Parent thread',
      agent_id: 'parent-agent',
      ...overrides,
    },
  );
  if (saved == null || 'message' in saved) {
    throw new Error('Failed to save parent conversation.');
  }
  return saved;
}

beforeAll(async () => {
  loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  mongod = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  loggerErrorSpy.mockRestore();
});

beforeEach(async () => {
  await Promise.all([
    (mongoose.models.Message as mongoose.Model<IMessage>).deleteMany({}),
    (mongoose.models.Conversation as mongoose.Model<IConversation>).deleteMany({}),
  ]);
});

describe('SubagentThreadTaskStore', () => {
  it('records the automatic delivery contract without hiding routed store operations', async () => {
    const store = new SubagentThreadTaskStore(methods);
    const scope = { userId: 'delivery-user', parentConversationId: randomUUID() };
    const pollOnly = buildSubagentThreadTaskConfig(store, scope);
    const automatic = buildSubagentThreadTaskConfig(store, scope, { completionWakeups: true });
    const automaticAgain = buildSubagentThreadTaskConfig(store, scope, {
      completionWakeups: true,
    });

    expect(pollOnly.store).toBe(store);
    expect(pollOnly.completionDelivery).toBeUndefined();
    expect(automatic.store).toBe(automaticAgain.store);
    expect(automatic.completionDelivery).toBe(SUBAGENT_COMPLETION_DELIVERY);
    const automaticStore = automatic.store as SubagentThreadTaskStore;
    expect(automaticStore.claimTask).toEqual(expect.any(Function));
    expect(automaticStore.controlTask).toEqual(expect.any(Function));
    await expect(automaticStore.hasTasks(automatic.scopeId)).resolves.toBe(false);
    await expect(automaticStore.listTasks(automatic.scopeId)).resolves.toEqual([]);
  });

  it('maps one logical SDK thread to a durable, view-only LibreChat conversation', async () => {
    const userId = 'user-1';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });

    const started = store.start(taskRequest(config.scopeId));
    await waitForSettled(store, config.scopeId, started);
    const threadId = requireThreadId(started);

    const conversation = await methods.getConvo(userId, threadId);
    expect(conversation).toMatchObject({
      conversationId: threadId,
      endpoint: EModelEndpoint.agents,
      agent_id: 'researcher-agent',
      subagentThread: {
        rootConversationId: parentConversationId,
        parentConversationId,
        parentAgentId: 'parent-agent',
        subagentType: 'researcher-agent',
        subagentKind: 'agent',
        depth: 1,
      },
    });
    expect(conversation?.subagentThread).not.toHaveProperty('userRunnable');
    const messages = await methods.getMessages(
      { user: userId, conversationId: threadId },
      '+subagentTranscript +subagentActivityProjection',
    );
    expect(messages.map((message) => message.text)).toEqual([
      'Investigate the issue.',
      'Completed the investigation.',
    ]);
    expect(messages[1].subagentTranscript).toMatchObject({
      taskId: requireAccepted(started).task.taskId,
      mode: 'append',
    });
    expect(messages[1].subagentActivityProjection).toEqual({
      taskId: requireAccepted(started).task.taskId,
      version: 1,
      activityJson: JSON.stringify([{ type: 'writing', text: 'Completed the investigation.' }]),
      truncated: false,
    });
  });

  it('inherits the parent retention deadline across the child transcript lifecycle', async () => {
    const userId = 'retained-subagent-user';
    const parentConversationId = randomUUID();
    const expiredAt = new Date('2030-01-01T00:00:00.000Z');
    await methods.saveConvo(
      { userId, isTemporary: true, expiredAt },
      {
        conversationId: parentConversationId,
        endpoint: EModelEndpoint.agents,
        title: 'Retained parent thread',
        agent_id: 'parent-agent',
      },
    );
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });

    const started = store.start(taskRequest(config.scopeId));
    await waitForSettled(store, config.scopeId, started);
    const threadId = requireThreadId(started);
    const [conversation, messages] = await Promise.all([
      methods.getConvo(userId, threadId),
      methods.getMessages({ user: userId, conversationId: threadId }),
    ]);

    expect(conversation).toMatchObject({ isTemporary: true, expiredAt });
    expect(messages).toHaveLength(2);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ isTemporary: true, expiredAt }),
        expect.objectContaining({ isTemporary: true, expiredAt }),
      ]),
    );
  });

  it('registers a host-safe wakeup before child provider work begins', async () => {
    const userId = 'wakeup-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const run = jest.fn(taskRequest('').run);
    const onTaskPrepared = jest.fn(async (registration: SubagentTaskWakeupRegistration) => {
      const messages = await methods.getMessages({
        user: userId,
        conversationId: registration.threadId,
        messageId: `${registration.taskId}:assistant`,
      });
      expect(messages).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
    });
    const store = new SubagentThreadTaskStore(methods, { onTaskPrepared });
    const config = buildSubagentThreadTaskConfig(
      store,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    const started = config.store.start(
      taskRequest(config.scopeId, {
        parentRunId: 'parent-response-1',
        parentAgentId: 'agent_parent_1',
        run,
      }),
    );
    await waitForSettled(store, config.scopeId, started);

    const settledTask = store.get(config.scopeId, requireAccepted(started).task.taskId);
    expect(settledTask?.error).toBeUndefined();
    expect(settledTask).toMatchObject({
      status: 'completed',
    });
    expect(onTaskPrepared).toHaveBeenCalledWith({
      userId,
      parentConversationId,
      parentMessageId: 'parent-response-1',
      parentAgentId: 'agent_parent_1',
      taskId: requireAccepted(started).task.taskId,
      threadId: requireThreadId(started),
      subagentType: 'researcher-agent',
      createdAt: expect.any(Number),
    });
  });

  it('announces a settled child only after its terminal message is durable', async () => {
    const userId = 'settled-child-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const saveMessage = jest.spyOn(methods, 'saveMessage');
    const terminalSavedAtSettle: boolean[] = [];
    const store = new SubagentThreadTaskStore(methods, {
      onTaskPrepared: jest.fn(),
      onTaskSettled: (settledUserId, settledConversationId, taskIds) => {
        expect(taskIds).toHaveLength(1);
        expect(
          saveMessage.mock.calls.some(
            ([, message]) =>
              (message as { messageId?: string }).messageId === `${taskIds[0]}:assistant`,
          ),
        ).toBe(true);
        expect(settledUserId).toBe(userId);
        expect(settledConversationId).toBe(parentConversationId);
        terminalSavedAtSettle.push(
          saveMessage.mock.calls.some(([, message]) =>
            String((message as { messageId?: string }).messageId).endsWith(':assistant'),
          ),
        );
      },
    });
    const config = buildSubagentThreadTaskConfig(
      store,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    const started = config.store.start(
      taskRequest(config.scopeId, {
        parentRunId: 'parent-response-1',
        parentAgentId: 'agent_parent_1',
      }),
    );
    await waitForSettled(store, config.scopeId, started);
    saveMessage.mockRestore();

    expect(terminalSavedAtSettle).toEqual([true]);
  });

  it.each([false, true])(
    'does not announce a child without an admitted delivery (wakeups enabled: %s)',
    async (completionWakeups) => {
      const userId = 'poll-only-settled-user';
      const parentConversationId = randomUUID();
      await saveParent(userId, parentConversationId);
      const onTaskSettled = jest.fn();
      const store = new SubagentThreadTaskStore(methods, {
        onTaskPrepared: jest.fn(() => false),
        onTaskSettled,
      });
      const config = buildSubagentThreadTaskConfig(
        store,
        { userId, parentConversationId },
        { completionWakeups },
      );
      const started = config.store.start(
        taskRequest(config.scopeId, { parentRunId: 'parent-response-1' }),
      );
      await waitForSettled(store, config.scopeId, started);

      expect(onTaskSettled).not.toHaveBeenCalled();
    },
  );

  it('keeps subagent completion delivery poll-only when wakeups are disabled', async () => {
    const userId = 'poll-only-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const onTaskPrepared = jest.fn();
    const store = new SubagentThreadTaskStore(methods, { onTaskPrepared });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });

    const started = config.store.start(taskRequest(config.scopeId));
    await waitForSettled(store, config.scopeId, started);

    expect(onTaskPrepared).not.toHaveBeenCalled();
    expect(store.get(config.scopeId, requireAccepted(started).task.taskId)?.status).toBe(
      'completed',
    );
  });

  it('streams child activity and closes only after the terminal result is durable', async () => {
    const userId = 'activity-stream-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const defaultRun = taskRequest(config.scopeId).run;
    const progress: SubagentUpdateEvent = {
      runId: 'root-run',
      parentRunId: 'parent-run',
      subagentRunId: 'child-run',
      subagentType: 'researcher-agent',
      subagentKind: 'agent',
      subagentAgentId: 'agent-1',
      parentToolCallId: 'tool-call',
      depth: 1,
      ancestry: [
        {
          subagentRunId: 'parent-run',
          subagentType: 'parent',
          subagentKind: 'agent',
          subagentAgentId: 'parent-agent',
          parentRunId: 'root-run',
        },
      ],
      phase: 'message_delta',
      data: { delta: { content: [{ type: 'text', text: 'Working.' }] } },
      timestamp: '2026-08-21T20:00:00.000Z',
    };
    const run = jest.fn(async (...args: Parameters<typeof defaultRun>) => {
      args[0].reportProgress(progress);
      return defaultRun(...args);
    });

    const started = store.start(taskRequest(config.scopeId, { run }));
    const accepted = requireAccepted(started);
    const events: unknown[] = [];
    let resolveTerminal!: (status: string) => void;
    const terminal = new Promise<string>((resolve) => {
      resolveTerminal = resolve;
    });
    store.subscribeActivity(requireThreadId(started), accepted.task.taskId, {
      onEvent: (event) => events.push(event),
      onDone: (event) => resolveTerminal(event.status),
    });

    await expect(terminal).resolves.toBe('completed');
    expect(events).toEqual([
      {
        event: 'on_subagent_update',
        data: expect.objectContaining({
          activityEventId: `${accepted.task.taskId}:0`,
          activitySequence: 0,
          data: progress.data,
        }),
      },
    ]);
    const messages = await methods.getMessages(
      {
        user: userId,
        conversationId: requireThreadId(started),
        messageId: `${accepted.task.taskId}:assistant`,
      },
      '+subagentTask',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subagentTask?.status).toBe('completed');
  });

  it('drains admitted activity before publishing the terminal event', async () => {
    const userId = 'activity-stream-drain-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const publicationOrder: string[] = [];
    let releaseFirst!: () => void;
    const firstPublication = new Promise<void>((resolve) => (releaseFirst = resolve));
    let publicationCount = 0;
    const emitChunk = jest.fn((_streamId: string, event: unknown): Promise<void> => {
      publicationCount += 1;
      const label = (event as { data?: { label?: string } }).data?.label ?? 'unknown';
      publicationOrder.push(label);
      return publicationCount === 1 ? firstPublication : Promise.resolve();
    });
    const emitDone = jest.fn(async () => {
      publicationOrder.push('done');
    });
    const transport = {
      emitChunk,
      emitDone,
      emitError: async () => undefined,
      subscribe: () => ({ unsubscribe: () => undefined }),
      getSubscriberCount: () => 0,
      isFirstSubscriber: () => true,
      onAllSubscribersLeft: () => undefined,
      cleanup: () => undefined,
      getTrackedStreamIds: () => [],
      destroy: () => undefined,
    } satisfies IEventTransport;
    store.configureActivityStream(new SubagentActivityStream(transport));
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const defaultRun = taskRequest(config.scopeId).run;
    const run = jest.fn(async (...args: Parameters<typeof defaultRun>) => {
      for (const label of ['first', 'second']) {
        args[0].reportProgress({
          runId: 'root-run',
          parentRunId: 'parent-run',
          subagentRunId: 'child-run',
          subagentType: 'researcher-agent',
          subagentKind: 'agent',
          subagentAgentId: 'agent-1',
          depth: 1,
          ancestry: [],
          phase: 'message_delta',
          label,
          timestamp: '2026-08-21T20:00:00.000Z',
        });
      }
      return defaultRun(...args);
    });

    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitUntil(() => emitChunk.mock.calls.length === 1, 'first activity publication');
    await waitForSettled(store, config.scopeId, started);
    expect(emitChunk).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitUntil(() => emitDone.mock.calls.length === 1, 'terminal activity delivery');

    expect(emitChunk).toHaveBeenCalledTimes(2);
    expect(publicationOrder).toEqual(['first', 'second', 'done']);
  });

  it('keeps activity delivery observational when its transport is unavailable', async () => {
    const userId = 'activity-stream-failure-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const emitChunk = jest.fn(() => {
      throw new Error('activity transport unavailable');
    });
    const unavailableTransport = {
      emitChunk,
      emitDone: async () => Promise.reject(new Error('activity transport unavailable')),
      emitError: async () => undefined,
      subscribe: () => ({ unsubscribe: () => undefined }),
      getSubscriberCount: () => 0,
      isFirstSubscriber: () => true,
      onAllSubscribersLeft: () => undefined,
      cleanup: () => undefined,
      getTrackedStreamIds: () => [],
      destroy: () => undefined,
    } satisfies IEventTransport;
    store.configureActivityStream(new SubagentActivityStream(unavailableTransport));
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const defaultRun = taskRequest(config.scopeId).run;
    const run = jest.fn(async (...args: Parameters<typeof defaultRun>) => {
      args[0].reportProgress({
        runId: 'root-run',
        parentRunId: 'parent-run',
        subagentRunId: 'child-run',
        subagentType: 'researcher-agent',
        subagentKind: 'agent',
        subagentAgentId: 'agent-1',
        parentToolCallId: 'tool-call',
        depth: 1,
        ancestry: [],
        phase: 'start',
        timestamp: '2026-08-21T20:00:00.000Z',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      args[0].reportProgress({
        runId: 'root-run',
        parentRunId: 'parent-run',
        subagentRunId: 'child-run',
        subagentType: 'researcher-agent',
        subagentKind: 'agent',
        subagentAgentId: 'agent-1',
        parentToolCallId: 'tool-call',
        depth: 1,
        ancestry: [],
        phase: 'message_delta',
        data: { delta: { content: [{ type: 'text', text: 'after-error' }] } },
        timestamp: '2026-08-21T20:00:00.010Z',
      });
      return defaultRun(...args);
    });

    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(store.get(config.scopeId, requireAccepted(started).task.taskId)?.status).toBe(
      'completed',
    );
    expect(emitChunk).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled activity and still attempts terminal delivery', async () => {
    const userId = 'activity-stream-stalled-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const never = () => new Promise<void>(() => undefined);
    const emitChunk = jest.fn(never);
    const emitDone = jest.fn(async () => undefined);
    const stalledTransport = {
      emitChunk,
      emitDone,
      emitError: async () => undefined,
      subscribe: () => ({ unsubscribe: () => undefined }),
      getSubscriberCount: () => 0,
      isFirstSubscriber: () => true,
      onAllSubscribersLeft: () => undefined,
      cleanup: () => undefined,
      getTrackedStreamIds: () => [],
      destroy: () => undefined,
    } satisfies IEventTransport;
    store.configureActivityStream(new SubagentActivityStream(stalledTransport));
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const defaultRun = taskRequest(config.scopeId).run;
    const run = jest.fn(async (...args: Parameters<typeof defaultRun>) => {
      for (let index = 0; index < 100; index += 1) {
        args[0].reportProgress({
          runId: 'root-run',
          parentRunId: 'parent-run',
          subagentRunId: 'child-run',
          subagentType: 'researcher-agent',
          subagentKind: 'agent',
          subagentAgentId: 'agent-1',
          depth: 1,
          ancestry: [],
          phase: 'message_delta',
          data: { delta: { content: [{ type: 'text', text: `chunk-${index}` }] } },
          timestamp: '2026-08-21T20:00:00.000Z',
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      args[0].reportProgress({
        runId: 'root-run',
        parentRunId: 'parent-run',
        subagentRunId: 'child-run',
        subagentType: 'researcher-agent',
        subagentKind: 'agent',
        subagentAgentId: 'agent-1',
        depth: 1,
        ancestry: [],
        phase: 'message_delta',
        data: { delta: { content: [{ type: 'text', text: 'after-timeout' }] } },
        timestamp: '2026-08-21T20:00:01.100Z',
      });
      return defaultRun(...args);
    });

    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(store.get(config.scopeId, requireAccepted(started).task.taskId)?.status).toBe(
      'completed',
    );
    await waitUntil(() => emitDone.mock.calls.length === 1, 'terminal activity delivery');
    expect(emitChunk).toHaveBeenCalledTimes(1);
  });

  it('fails before provider work and keeps the durable failure collectable when registration fails', async () => {
    const userId = 'wakeup-failure-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const run = jest.fn(taskRequest('').run);
    const store = new SubagentThreadTaskStore(methods, {
      onTaskPrepared: async () => Promise.reject(new Error('trigger queue unavailable')),
    });
    const config = buildSubagentThreadTaskConfig(
      store,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    const started = config.store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(run).not.toHaveBeenCalled();
    await expect(
      store.claimTask(config.scopeId, requireAccepted(started).task.taskId),
    ).resolves.toMatchObject({
      status: 'error',
    });
  });

  it('waits for initial parent persistence before creating the first child', async () => {
    const userId = 'parent-gate-user';
    const parentConversationId = randomUUID();
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let releaseParent = (_value: unknown): void => undefined;
    const parentPersistence = new Promise<unknown>((resolve) => {
      releaseParent = resolve;
    });
    const run = jest.fn(taskRequest(config.scopeId).run);
    store.registerParentPersistence(config.scopeId, parentPersistence);

    const started = store.start(taskRequest(config.scopeId, { run }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(run).not.toHaveBeenCalled();
    expect(await methods.getConvo(userId, requireThreadId(started))).toBeNull();

    await saveParent(userId, parentConversationId);
    releaseParent({
      message: { messageId: 'parent-message', conversationId: parentConversationId },
    });
    await waitForSettled(store, config.scopeId, started);

    expect(run).toHaveBeenCalledTimes(1);
    expect(await methods.getConvo(userId, requireThreadId(started))).not.toBeNull();
  });

  it('reconstructs trusted owner context after the admitting request has ended', async () => {
    const userId = 'detached-context-user';
    const tenantId = 'detached-context-tenant';
    const parentConversationId = randomUUID();
    await tenantStorage.run({ tenantId, userId }, async () =>
      saveParent(userId, parentConversationId, { tenantId }),
    );

    const observedContexts: Array<{ tenantId?: string; userId?: string }> = [];
    const observeContext = () => {
      observedContexts.push({ tenantId: getTenantId(), userId: getUserId() });
    };
    const store = new SubagentThreadTaskStore(methods, {
      isOwnerActive: async () => {
        observeContext();
        return true;
      },
    });
    const config = buildSubagentThreadTaskConfig(store, {
      userId,
      tenantId,
      parentConversationId,
    });
    const defaultRun = taskRequest(config.scopeId).run;
    const run = jest.fn(async (...args: Parameters<typeof defaultRun>) => {
      observeContext();
      return defaultRun(...args);
    });

    /** `start` deliberately runs outside `tenantStorage.run`: the detached task
     * owns only its serialized host scope once the HTTP request has returned. */
    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(run).toHaveBeenCalledTimes(1);
    expect(observedContexts.length).toBeGreaterThan(0);
    expect(observedContexts).toEqual(observedContexts.map(() => ({ tenantId, userId })));
    const messages = await tenantStorage.run({ tenantId, userId }, async () =>
      methods.getMessages({ user: userId, conversationId: requireThreadId(started) }),
    );
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.tenantId === tenantId)).toBe(true);
  });

  it('fails without leaving an orphan when parent persistence rejects', async () => {
    const userId = 'parent-gate-failure-user';
    const parentConversationId = randomUUID();
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const run = jest.fn(taskRequest(config.scopeId).run);
    store.registerParentPersistence(
      config.scopeId,
      Promise.reject(new Error('parent write failed')),
    );

    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(run).not.toHaveBeenCalled();
    expect(await methods.getConvo(userId, requireThreadId(started))).toBeNull();
    expect(store.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'error',
    });
  });

  it('retains a resolved-but-unsaved parent failure until a valid write supersedes it', async () => {
    const userId = 'parent-empty-result-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const rejectedRun = jest.fn(taskRequest(config.scopeId).run);
    store.registerParentPersistence(config.scopeId, Promise.resolve({}));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const rejected = store.start(taskRequest(config.scopeId, { run: rejectedRun }));
    await waitForSettled(store, config.scopeId, rejected);

    expect(rejectedRun).not.toHaveBeenCalled();
    expect(await methods.getConvo(userId, requireThreadId(rejected))).toBeNull();

    store.registerParentPersistence(
      config.scopeId,
      Promise.resolve({
        message: { messageId: 'next-parent-message', conversationId: parentConversationId },
      }),
    );
    const acceptedRun = jest.fn(taskRequest(config.scopeId).run);
    const accepted = store.start(taskRequest(config.scopeId, { run: acceptedRun }));
    await waitForSettled(store, config.scopeId, accepted);

    expect(acceptedRun).toHaveBeenCalledTimes(1);
  });

  it('continues with canonical transcript only and ignores non-canonical visible rows', async () => {
    const userId = 'canonical-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const first = store.start(taskRequest(config.scopeId));
    await waitForSettled(store, config.scopeId, first);
    const threadId = requireThreadId(first);

    const visibleUserId = randomUUID();
    await methods.saveMessage(
      { userId },
      {
        messageId: visibleUserId,
        conversationId: threadId,
        parentMessageId: `${requireAccepted(first).task.taskId}:assistant`,
        sender: 'User',
        text: 'A non-canonical human edit.',
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: true,
      },
    );
    await methods.saveMessage(
      { userId },
      {
        messageId: randomUUID(),
        conversationId: threadId,
        parentMessageId: visibleUserId,
        sender: 'Assistant',
        text: 'A non-canonical answer.',
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: false,
      },
    );

    let restored: BaseMessage[] = [];
    const continued = store.start(
      taskRequest(config.scopeId, {
        threadId,
        input: 'Continue the investigation.',
        run: async (_runtime, initialMessages = []) => {
          restored = initialMessages;
          return {
            content: 'Continued.',
            messages: [
              ...initialMessages,
              new HumanMessage('Continue the investigation.'),
              new AIMessage('Continued.'),
            ],
          };
        },
      }),
    );
    await waitForSettled(store, config.scopeId, continued);

    expect(restored.map((message) => message.content)).toEqual([
      'Investigate the issue.',
      'Completed the investigation.',
    ]);
  });

  it('reuses the original task and thread for an idempotent replay', async () => {
    const userId = 'idempotent-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const request = taskRequest(config.scopeId, { idempotencyKey: 'same-attempt' });

    const first = store.start(request);
    const replay = store.start(request);

    expect(first.accepted).toBe(true);
    expect(replay).toMatchObject({
      accepted: true,
      isNew: false,
      task: requireAccepted(first).task,
    });
    await waitForSettled(store, config.scopeId, first);
    expect(
      (await methods.getMessages({ user: userId, conversationId: requireThreadId(first) })).length,
    ).toBe(2);
  });

  it('replays a completed attempt across API workers without executing or billing twice', async () => {
    const userId = 'durable-idempotency-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const firstWakeup = jest.fn(async (_registration: SubagentTaskWakeupRegistration) => undefined);
    const replayWakeup = jest.fn(
      async (_registration: SubagentTaskWakeupRegistration) => undefined,
    );
    const firstWorker = new SubagentThreadTaskStore(methods, { onTaskPrepared: firstWakeup });
    const onReplaySettled = jest.fn();
    const secondWorker = new SubagentThreadTaskStore(methods, {
      onTaskPrepared: replayWakeup,
      onTaskSettled: onReplaySettled,
    });
    const config = buildSubagentThreadTaskConfig(
      firstWorker,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    const replayConfig = buildSubagentThreadTaskConfig(
      secondWorker,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    const firstRun = jest.fn(async () => ({
      content: 'Original durable result.',
      messages: [new HumanMessage('Run once.'), new AIMessage('Original durable result.')],
    }));
    const firstParentRunId = 'original-parent-response';
    const first = config.store.start(
      taskRequest(config.scopeId, {
        idempotencyKey: 'cross-worker-attempt',
        parentRunId: firstParentRunId,
        requestFingerprint: 'same-inputs',
        input: 'Run once.',
        run: firstRun,
      }),
    );
    await waitForSettled(firstWorker, config.scopeId, first);
    const durableAttempt = await methods.getMessages(
      { user: userId, conversationId: requireThreadId(first) },
      '+subagentTask',
    );
    expect(durableAttempt[durableAttempt.length - 1]?.subagentTask?.parentRunId).toBe(
      firstParentRunId,
    );

    const replayRun = jest.fn(taskRequest(config.scopeId).run);
    const replay = replayConfig.store.start(
      taskRequest(config.scopeId, {
        idempotencyKey: 'cross-worker-attempt',
        requestFingerprint: 'same-inputs',
        input: 'Run once.',
        run: replayRun,
      }),
    );
    expect(requireThreadId(replay)).toBe(requireThreadId(first));
    await waitForSettled(secondWorker, config.scopeId, replay);

    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(replayRun).not.toHaveBeenCalled();
    expect(onReplaySettled).toHaveBeenCalledTimes(1);
    expect(onReplaySettled).toHaveBeenCalledWith(userId, parentConversationId, [
      requireAccepted(first).task.taskId,
    ]);
    expect(firstWakeup).toHaveBeenCalledTimes(1);
    const firstRegistration = firstWakeup.mock.calls[0]?.[0];
    const replayRegistration = replayWakeup.mock.calls[0]?.[0];
    expect(firstRegistration?.createdAt).toBe(durableAttempt[0]?.createdAt?.getTime());
    expect(replayRegistration?.createdAt).toBe(firstRegistration?.createdAt);
    expect(replayWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: requireAccepted(first).task.taskId,
        parentMessageId: firstParentRunId,
        createdAt: firstRegistration?.createdAt,
      }),
    );
    expect(secondWorker.claim(config.scopeId, requireAccepted(replay).task.taskId)).toMatchObject({
      status: 'completed',
      result: 'Original durable result.',
    });
    expect(
      await methods.getMessages({ user: userId, conversationId: requireThreadId(first) }),
    ).toHaveLength(2);
  });

  it('rejects a conflicting durable retry across API workers', async () => {
    const userId = 'durable-conflict-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const firstWorker = new SubagentThreadTaskStore(methods);
    const secondWorker = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(firstWorker, { userId, parentConversationId });
    const first = firstWorker.start(
      taskRequest(config.scopeId, {
        idempotencyKey: 'reused-key',
        requestFingerprint: 'original-inputs',
      }),
    );
    await waitForSettled(firstWorker, config.scopeId, first);

    const conflictingRun = jest.fn(taskRequest(config.scopeId).run);
    const conflicting = secondWorker.start(
      taskRequest(config.scopeId, {
        idempotencyKey: 'reused-key',
        requestFingerprint: 'different-inputs',
        run: conflictingRun,
      }),
    );
    await waitForSettled(secondWorker, config.scopeId, conflicting);

    expect(conflictingRun).not.toHaveBeenCalled();
    expect(
      secondWorker.claim(config.scopeId, requireAccepted(conflicting).task.taskId),
    ).toMatchObject({ status: 'error' });
  });

  it('closes an abandoned durable attempt without re-executing it', async () => {
    const userId = 'abandoned-attempt-user';
    const parentConversationId = randomUUID();
    const threadId = randomUUID();
    await saveParent(userId, parentConversationId);
    const onTaskSettled = jest.fn();
    const store = new SubagentThreadTaskStore(methods, {
      onTaskPrepared: jest.fn(),
      onTaskSettled,
    });
    const config = buildSubagentThreadTaskConfig(
      store,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    await methods.saveConvo(
      { userId },
      {
        conversationId: threadId,
        endpoint: EModelEndpoint.agents,
        title: 'Abandoned child',
        agent_id: 'researcher-agent',
        subagentThread: {
          rootConversationId: parentConversationId,
          parentConversationId,
          parentMessageId: 'parent-run',
          parentToolCallId: 'parent-tool',
          parentAgentId: 'parent-agent',
          subagentType: 'researcher-agent',
          subagentKind: 'agent',
          depth: 1,
        },
      },
    );
    await methods.saveMessage(
      { userId },
      {
        messageId: 'abandoned:user',
        conversationId: threadId,
        parentMessageId: String(Constants.NO_PARENT),
        sender: 'User',
        text: 'Run once.',
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: true,
        subagentTask: {
          attemptKey: createSubagentAttemptKey(config.scopeId, 'abandoned-attempt'),
          requestFingerprint: 'same-inputs',
          status: 'running',
        },
      },
    );
    const run = jest.fn(taskRequest(config.scopeId).run);
    const retry = config.store.start(
      taskRequest(config.scopeId, {
        threadId,
        idempotencyKey: 'abandoned-attempt',
        requestFingerprint: 'same-inputs',
        run,
      }),
    );
    await waitForSettled(store, config.scopeId, retry);

    expect(run).not.toHaveBeenCalled();
    expect(onTaskSettled).toHaveBeenCalledTimes(1);
    expect(onTaskSettled).toHaveBeenCalledWith(userId, parentConversationId, [
      requireAccepted(retry).task.taskId,
      'abandoned',
    ]);
    expect(store.claim(config.scopeId, requireAccepted(retry).task.taskId)).toMatchObject({
      status: 'error',
      error:
        'Subagent task failed: The prior execution ended before its result could be persisted.',
    });
    const messages = await methods.getMessages(
      { user: userId, conversationId: threadId },
      '+subagentTask',
    );
    expect(messages.map((message) => message.subagentTask?.status)).toEqual(['running', 'error']);

    const replaySettled = jest.fn();
    const replayWorker = new SubagentThreadTaskStore(methods, {
      onTaskPrepared: jest.fn(),
      onTaskSettled: replaySettled,
    });
    const replayConfig = buildSubagentThreadTaskConfig(
      replayWorker,
      { userId, parentConversationId },
      { completionWakeups: true },
    );
    const replay = replayConfig.store.start(
      taskRequest(replayConfig.scopeId, {
        threadId,
        idempotencyKey: 'abandoned-attempt',
        requestFingerprint: 'same-inputs',
        run,
      }),
    );
    await waitForSettled(replayWorker, replayConfig.scopeId, replay);
    expect(replaySettled).toHaveBeenCalledTimes(1);
    expect(replaySettled).toHaveBeenCalledWith(userId, parentConversationId, [
      requireAccepted(retry).task.taskId,
      'abandoned',
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it('holds one active lease per child and exposes provisional ownership safely', async () => {
    const userId = 'lease-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let release = (_value: { content: string; messages: BaseMessage[] }): void => undefined;
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const result = new Promise<{ content: string; messages: BaseMessage[] }>((resolve) => {
      release = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => {
          markEntered();
          return result;
        },
      }),
    );
    const threadId = requireThreadId(started);

    expect(store.isThreadActiveForOwner(userId, threadId)).toBe(true);
    expect(store.isThreadActiveForOwner('different-user', threadId)).toBe(false);
    expect(store.isThreadActiveForOwner(userId, threadId, 'tenant-a')).toBe(false);
    await entered;
    expect(
      store.start(
        taskRequest(config.scopeId, {
          threadId,
          idempotencyKey: 'different-attempt',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'capacity' });

    release({
      content: 'Lease completed.',
      messages: [new HumanMessage('Investigate the issue.'), new AIMessage('Lease completed.')],
    });
    await waitForSettled(store, config.scopeId, started);
    expect(store.isThreadActiveForOwner(userId, threadId)).toBe(false);
  });

  it('serializes continuations across independent API worker stores', async () => {
    const userId = 'cross-worker-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const firstWorker = new SubagentThreadTaskStore(methods);
    const secondWorker = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(firstWorker, { userId, parentConversationId });
    const initial = firstWorker.start(taskRequest(config.scopeId));
    await waitForSettled(firstWorker, config.scopeId, initial);
    const threadId = requireThreadId(initial);

    let releaseFirst = (_value: { content: string; messages: BaseMessage[] }): void => undefined;
    let markFirstEntered = (): void => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstResult = new Promise<{ content: string; messages: BaseMessage[] }>((resolve) => {
      releaseFirst = resolve;
    });
    const first = firstWorker.start(
      taskRequest(config.scopeId, {
        threadId,
        input: 'First continuation.',
        run: async () => {
          markFirstEntered();
          return firstResult;
        },
      }),
    );
    await firstEntered;

    const secondRun = jest.fn(taskRequest(config.scopeId).run);
    const second = secondWorker.start(
      taskRequest(config.scopeId, {
        threadId,
        input: 'Overlapping continuation.',
        run: secondRun,
      }),
    );
    await waitForSettled(secondWorker, config.scopeId, second);
    expect(secondRun).not.toHaveBeenCalled();
    expect(secondWorker.claim(config.scopeId, requireAccepted(second).task.taskId)).toMatchObject({
      status: 'error',
    });

    releaseFirst({
      content: 'First continuation completed.',
      messages: [new HumanMessage('First continuation.'), new AIMessage('Completed.')],
    });
    await waitForSettled(firstWorker, config.scopeId, first);
  });

  it('renews the shared lease while a continuation transcript is being prepared', async () => {
    const userId = 'slow-prepare-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let slowThreadId = '';
    let blockNextRead = false;
    let markPreparing = (): void => undefined;
    const preparing = new Promise<void>((resolve) => {
      markPreparing = resolve;
    });
    let releasePreparation = (): void => undefined;
    const preparationRelease = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let leaseDeadline = new Date(0);
    let renewedPastDeadline = false;
    const slowMethods = {
      ...methods,
      acquireSubagentThreadLease: jest.fn(
        async (...args: Parameters<AllMethods['acquireSubagentThreadLease']>) => {
          const acquired = await methods.acquireSubagentThreadLease(...args);
          if (acquired) {
            leaseDeadline = args[0].expiresAt;
          }
          return acquired;
        },
      ),
      renewSubagentThreadLease: jest.fn(
        async (...args: Parameters<AllMethods['renewSubagentThreadLease']>) => {
          const renewed = await methods.renewSubagentThreadLease(...args);
          renewedPastDeadline ||= renewed && args[0].now > leaseDeadline;
          return renewed;
        },
      ),
      getMessages: jest.fn(async (...args: Parameters<AllMethods['getMessages']>) => {
        if (blockNextRead && args[0].conversationId === slowThreadId) {
          blockNextRead = false;
          markPreparing();
          await preparationRelease;
        }
        return methods.getMessages(...args);
      }),
    };
    /** The heartbeat fences itself when a renewal commits after the deadline it was
     * issued against, so the TTL is this test's tolerance for runner jitter, not just
     * its pace. Keep it well above the scheduling stalls a loaded shard produces: a
     * half-second lease turns an ordinary pause into a lapse and the prepared run is
     * refused instead of executed. */
    const options = { leaseTtlMs: 2_000, leaseHeartbeatMs: 50 };
    const firstWorker = new SubagentThreadTaskStore(slowMethods, options);
    const secondWorker = new SubagentThreadTaskStore(methods, options);
    const config = buildSubagentThreadTaskConfig(firstWorker, { userId, parentConversationId });
    const initial = firstWorker.start(taskRequest(config.scopeId));
    await waitForSettled(firstWorker, config.scopeId, initial);
    slowThreadId = requireThreadId(initial);
    blockNextRead = true;
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    const firstRun = jest.fn(taskRequest(config.scopeId).run);
    const first = firstWorker.start(
      taskRequest(config.scopeId, {
        threadId: slowThreadId,
        idempotencyKey: 'slow-preparation',
        run: firstRun,
      }),
    );
    await preparing;
    const heartbeatCall = intervalSpy.mock.calls.find(([, delay]) => delay === 50);
    const heartbeatIndex =
      heartbeatCall == null ? -1 : intervalSpy.mock.calls.indexOf(heartbeatCall);
    const heartbeat = intervalSpy.mock.results[heartbeatIndex]?.value as NodeJS.Timeout | undefined;
    const warningCall = [...timeoutSpy.mock.calls].reverse().find(([, delay]) => delay === 5_000);
    const warningIndex = warningCall == null ? -1 : timeoutSpy.mock.calls.lastIndexOf(warningCall);
    expect(warningCall?.[1]).toBe(5_000);
    const warning = timeoutSpy.mock.results[warningIndex]?.value as NodeJS.Timeout | undefined;
    expect(heartbeat?.hasRef()).toBe(true);
    expect(warning?.hasRef()).toBe(true);
    /** Wait for evidence rather than a fixed delay: a renewal that succeeds after the
     * acquired lease's own deadline proves the heartbeat carried it past expiry. */
    await waitUntil(() => renewedPastDeadline, 'the shared lease to outlive its original deadline');

    const overlappingRun = jest.fn(taskRequest(config.scopeId).run);
    const overlapping = secondWorker.start(
      taskRequest(config.scopeId, {
        threadId: slowThreadId,
        idempotencyKey: 'overlapping-preparation',
        run: overlappingRun,
      }),
    );
    await waitForSettled(secondWorker, config.scopeId, overlapping);
    expect(overlappingRun).not.toHaveBeenCalled();

    releasePreparation();
    await waitForSettled(firstWorker, config.scopeId, first);
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeat);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(warning);
    intervalSpy.mockRestore();
    timeoutSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('cancels a child when its lease renewal only commits after expiry', async () => {
    const userId = 'late-lease-renewal-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let providerEntered = false;
    let previousExpiry = 0;
    let markLateRenewal = (): void => undefined;
    const lateRenewal = new Promise<void>((resolve) => {
      markLateRenewal = resolve;
    });
    const slowMethods = {
      ...methods,
      renewSubagentThreadLease: jest.fn(
        async (...args: Parameters<AllMethods['renewSubagentThreadLease']>) => {
          if (providerEntered) {
            markLateRenewal();
            /** Wait on the last confirmed lease deadline rather than a tiny fixed TTL:
             * the renewal definitely commits after the gap, without assuming how fast
             * a loaded runner completes preparation and its first Mongo write. */
            await new Promise<void>((resolve) =>
              setTimeout(resolve, Math.max(0, previousExpiry - Date.now() + 10)),
            );
          }
          const renewed = await methods.renewSubagentThreadLease(...args);
          if (renewed) {
            previousExpiry = args[0].expiresAt.getTime();
          }
          return renewed;
        },
      ),
    };
    const store = new SubagentThreadTaskStore(slowMethods, {
      leaseTtlMs: 1_000,
      leaseHeartbeatMs: 20,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const run = jest.fn(async (runtime: SubagentTaskRuntime) => {
      providerEntered = true;
      return new Promise<{ content: string }>((_resolve, reject) => {
        runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
          once: true,
        });
      });
    });
    const started = store.start(taskRequest(config.scopeId, { run }));

    await lateRenewal;
    await waitForSettled(store, config.scopeId, started);

    expect(run).toHaveBeenCalledTimes(1);
    expect(store.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('rechecks account deletion after acquiring the shared lease', async () => {
    const userId = 'lease-fence-gap-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let ownerActive = true;
    const fencedMethods = {
      ...methods,
      acquireSubagentThreadLease: jest.fn(
        async (...args: Parameters<AllMethods['acquireSubagentThreadLease']>) => {
          const acquired = await methods.acquireSubagentThreadLease(...args);
          ownerActive = false;
          return acquired;
        },
      ),
    };
    const store = new SubagentThreadTaskStore(fencedMethods, {
      isOwnerActive: async () => ownerActive,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const run = jest.fn(taskRequest(config.scopeId).run);
    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(run).not.toHaveBeenCalled();
    expect(await methods.getConvo(userId, requireThreadId(started))).toBeNull();
    expect(await methods.countActiveSubagentThreadLeases({ user: userId, now: new Date() })).toBe(
      0,
    );
  });

  it('lets account deletion on one worker drain a child running on another', async () => {
    const userId = 'owner-drain-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let ownerActive = true;
    const options = {
      isOwnerActive: async () => ownerActive,
      // Exercise owner cancellation, not lease expiry. Keep the lease beyond the
      // drain deadline so slow CI database operations cannot bypass child startup
      // or make the drain succeed without the worker releasing its lease.
      leaseTtlMs: 30_000,
      leaseHeartbeatMs: 10,
      ownerDrainTimeoutMs: 5_000,
      ownerDrainPollMs: 5,
    };
    const workerStore = new SubagentThreadTaskStore(methods, options);
    const deletingStore = new SubagentThreadTaskStore(methods, options);
    const config = buildSubagentThreadTaskConfig(workerStore, { userId, parentConversationId });
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const started = workerStore.start(
      taskRequest(config.scopeId, {
        run: async (runtime) => {
          markEntered();
          return new Promise((_resolve, reject) => {
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          });
        },
      }),
    );
    await entered;

    ownerActive = false;
    await deletingStore.cancelAndDrainForOwner(userId);
    await waitForSettled(workerStore, config.scopeId, started);

    expect(await methods.countActiveSubagentThreadLeases({ user: userId, now: new Date() })).toBe(
      0,
    );
    expect(workerStore.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('fails account deletion closed while a cancelled provider still owns its lease', async () => {
    const userId = 'stubborn-provider-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let ownerActive = true;
    const options = {
      isOwnerActive: async () => ownerActive,
      leaseTtlMs: 1_000,
      leaseHeartbeatMs: 100,
      ownerDrainTimeoutMs: 1_500,
      ownerDrainPollMs: 20,
    };
    const workerStore = new SubagentThreadTaskStore(methods, options);
    const deletingStore = new SubagentThreadTaskStore(methods, options);
    const config = buildSubagentThreadTaskConfig(workerStore, { userId, parentConversationId });
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseProvider = (_value: { content: string; messages: BaseMessage[] }): void => undefined;
    const provider = new Promise<{ content: string; messages: BaseMessage[] }>((resolve) => {
      releaseProvider = resolve;
    });
    const started = workerStore.start(
      taskRequest(config.scopeId, {
        run: async () => {
          markEntered();
          return provider;
        },
      }),
    );
    await entered;

    ownerActive = false;
    await expect(deletingStore.cancelAndDrainForOwner(userId)).rejects.toThrow(
      'Timed out draining detached subagent tasks',
    );
    expect(await methods.countActiveSubagentThreadLeases({ user: userId, now: new Date() })).toBe(
      1,
    );

    ownerActive = true;
    releaseProvider({ content: 'Stopped.', messages: [new AIMessage('Stopped.')] });
    await waitForSettled(workerStore, config.scopeId, started);
  });

  it('does not overwrite a child title changed while detached execution is running', async () => {
    const userId = 'title-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let release = (_value: { content: string; messages: BaseMessage[] }): void => undefined;
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const result = new Promise<{ content: string; messages: BaseMessage[] }>((resolve) => {
      release = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => {
          markEntered();
          return result;
        },
      }),
    );
    await entered;
    await methods.saveConvo(
      { userId },
      { conversationId: requireThreadId(started), title: 'Renamed while running' },
      { noUpsert: true },
    );

    release({
      content: 'Renamed child completed.',
      messages: [
        new HumanMessage('Investigate the issue.'),
        new AIMessage('Renamed child completed.'),
      ],
    });
    await waitForSettled(store, config.scopeId, started);

    expect(await methods.getConvo(userId, requireThreadId(started))).toMatchObject({
      title: 'Renamed while running',
    });
  });

  it('lets deletion win over a concurrently settling detached result', async () => {
    const userId = 'deletion-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let deletedThreadId = '';
    const deletingMethods = {
      ...methods,
      saveMessage: jest.fn(async (...args: Parameters<AllMethods['saveMessage']>) => {
        const message = args[1];
        if (message.text === 'Result after deletion.') {
          deletedThreadId = message.conversationId ?? '';
          await methods.deleteConvos(userId, { conversationId: deletedThreadId });
        }
        return methods.saveMessage(...args);
      }),
    };
    const store = new SubagentThreadTaskStore(deletingMethods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => ({
          content: 'Result after deletion.',
          messages: [new AIMessage('Result after deletion.')],
        }),
      }),
    );
    await waitForSettled(store, config.scopeId, started);

    expect(deletedThreadId).toBe(requireThreadId(started));
    expect(await methods.getConvo(userId, deletedThreadId)).toBeNull();
    expect(await methods.getMessages({ user: userId, conversationId: deletedThreadId })).toEqual(
      [],
    );
    expect(store.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'error',
    });
  });

  it('bills detached usage independently and persists its rollup on the child result', async () => {
    const userId = 'usage-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const parentUsage: UsageMetadata[] = [];
    const recordDetachedUsage = jest.fn().mockResolvedValue(undefined);
    const sink = createSubagentUsageSink(
      parentUsage,
      (usage) => {
        usage.cost = 0.25;
      },
      recordDetachedUsage,
    );
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => {
          await sink({
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            model: 'gpt-5-mini',
            provider: 'openAI',
            subagentType: 'researcher-agent',
            subagentRunId: 'child-run',
            subagentAgentId: 'researcher-agent',
            runId: 'parent-run',
          });
          return {
            content: 'Usage recorded.',
            messages: [
              new HumanMessage('Investigate the issue.'),
              new AIMessage('Usage recorded.'),
            ],
          };
        },
      }),
    );
    await waitForSettled(store, config.scopeId, started);

    expect(parentUsage).toEqual([]);
    expect(recordDetachedUsage).toHaveBeenCalledTimes(1);
    const messages = await methods.getMessages({
      user: userId,
      conversationId: requireThreadId(started),
    });
    expect(messages[messages.length - 1]?.metadata?.usage).toEqual({
      input: 100,
      output: 20,
      cacheWrite: 0,
      cacheRead: 0,
      cost: 0.25,
    });
  });

  it('persists graph children without assigning a saved-agent identity', async () => {
    const userId = 'graph-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        subagentKind: 'graph',
        subagentType: 'research-team',
      }),
    );
    await waitForSettled(store, config.scopeId, started);

    const conversation = await methods.getConvo(userId, requireThreadId(started));
    expect(conversation?.agent_id).toBeUndefined();
    expect(conversation?.subagentThread).toMatchObject({
      subagentKind: 'graph',
      subagentType: 'research-team',
    });
  });

  it('inherits tenant isolation and rejects a cross-tenant continuation', async () => {
    const userId = 'tenant-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId, { tenantId: 'tenant-a' });
    const store = new SubagentThreadTaskStore(methods);
    const tenantA = buildSubagentThreadTaskConfig(store, {
      userId,
      parentConversationId,
      tenantId: 'tenant-a',
    });
    const first = store.start(taskRequest(tenantA.scopeId));
    await waitForSettled(store, tenantA.scopeId, first);

    const tenantB = buildSubagentThreadTaskConfig(store, {
      userId,
      parentConversationId,
      tenantId: 'tenant-b',
    });
    const run = jest.fn(taskRequest(tenantB.scopeId).run);
    const crossTenant = store.start(
      taskRequest(tenantB.scopeId, { threadId: requireThreadId(first), run }),
    );
    await waitForSettled(store, tenantB.scopeId, crossTenant);

    expect(run).not.toHaveBeenCalled();
    expect(store.claim(tenantB.scopeId, requireAccepted(crossTenant).task.taskId)).toMatchObject({
      status: 'error',
    });
  });

  it('removes a newly-created child when its first input cannot be persisted', async () => {
    const userId = 'rollback-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const failingMethods = {
      ...methods,
      saveMessage: jest.fn(async (...args: Parameters<AllMethods['saveMessage']>) => {
        if (args[1].isCreatedByUser === true) {
          return null;
        }
        return methods.saveMessage(...args);
      }),
    };
    const store = new SubagentThreadTaskStore(failingMethods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const run = jest.fn(taskRequest(config.scopeId).run);
    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(run).not.toHaveBeenCalled();
    expect(await methods.getConvo(userId, requireThreadId(started))).toBeNull();
  });

  it('persists a compacted canonical replacement without replaying superseded history', async () => {
    const userId = 'compaction-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const first = store.start(taskRequest(config.scopeId));
    await waitForSettled(store, config.scopeId, first);
    const threadId = requireThreadId(first);

    const compactedMessages: BaseMessage[] = [
      new HumanMessage('Condensed prior work.'),
      new AIMessage('Compact state.'),
      new HumanMessage('Continue from the compact state.'),
      new AIMessage('Compacted continuation complete.'),
    ];
    const second = store.start(
      taskRequest(config.scopeId, {
        threadId,
        input: 'Continue from the compact state.',
        run: async () => ({
          content: 'Compacted continuation complete.',
          messages: compactedMessages,
        }),
      }),
    );
    await waitForSettled(store, config.scopeId, second);

    let restored: BaseMessage[] = [];
    const third = store.start(
      taskRequest(config.scopeId, {
        threadId,
        input: 'One more turn.',
        run: async (_runtime, initialMessages = []) => {
          restored = initialMessages;
          return { content: 'Done.', messages: [...initialMessages, new AIMessage('Done.')] };
        },
      }),
    );
    await waitForSettled(store, config.scopeId, third);

    expect(restored.map((message) => message.content)).toEqual(
      compactedMessages.map((message) => message.content),
    );
    const messages = await methods.getMessages(
      { user: userId, conversationId: threadId },
      '+subagentTranscript',
    );
    expect(
      messages.find(
        (message) => message.messageId === `${requireAccepted(second).task.taskId}:assistant`,
      )?.subagentTranscript?.mode,
    ).toBe('replace');
  });

  it('holds the child lease through cancellation and discards a late success', async () => {
    const userId = 'cancel-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const first = store.start(taskRequest(config.scopeId));
    await waitForSettled(store, config.scopeId, first);
    const threadId = requireThreadId(first);

    let finishLate = (_value: { content: string; messages: BaseMessage[] }): void => undefined;
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const lateResult = new Promise<{ content: string; messages: BaseMessage[] }>((resolve) => {
      finishLate = resolve;
    });
    const cancelled = store.start(
      taskRequest(config.scopeId, {
        threadId,
        input: 'Long child turn.',
        run: async () => {
          markEntered();
          return lateResult;
        },
      }),
    );
    await entered;
    expect(
      store.control(config.scopeId, requireAccepted(cancelled).task.taskId, { action: 'cancel' })
        .status,
    ).toBe('cancelled');
    expect(
      store.start(
        taskRequest(config.scopeId, {
          threadId,
          input: 'Must not overlap.',
        }),
      ),
    ).toEqual({ accepted: false, reason: 'capacity' });

    finishLate({
      content: 'Late success must be discarded.',
      messages: [new AIMessage('Late success must be discarded.')],
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!store.isThreadActiveForOwner(userId, threadId)) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (attempt === 199) {
        throw new Error('Cancelled child execution did not release its durable lease.');
      }
    }

    const messages = await methods.getMessages({ user: userId, conversationId: threadId });
    expect(messages.map((message) => message.text)).not.toContain(
      'Late success must be discarded.',
    );
    expect(messages.map((message) => message.text)).toContain('Subagent task was cancelled.');
  });

  it('cancels an active descendant and lets parent deletion remove its durable thread', async () => {
    const userId = 'parent-delete-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finishLate = (_value: { content: string; messages: BaseMessage[] }): void => undefined;
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const lateResult = new Promise<{ content: string; messages: BaseMessage[] }>((resolve) => {
      finishLate = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => {
          markEntered();
          return lateResult;
        },
      }),
    );
    await entered;
    const threadId = requireThreadId(started);

    expect(store.cancelForConversations(userId, [parentConversationId])).toBe(1);
    await methods.deleteConvos(userId, { conversationId: parentConversationId });
    finishLate({ content: 'Too late.', messages: [new AIMessage('Too late.')] });
    await waitForSettled(store, config.scopeId, started);

    expect(await methods.getConvo(userId, parentConversationId)).toBeNull();
    expect(await methods.getConvo(userId, threadId)).toBeNull();
    expect(await methods.getMessages({ user: userId, conversationId: threadId })).toEqual([]);
  });

  it('persists task timeouts as failures rather than cancellations', async () => {
    const userId = 'timeout-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const taskTimeoutMs = 60_000;
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const store = new SubagentThreadTaskStore(methods, { taskTimeoutMs });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        input: 'Run until timeout.',
        run: async (runtime) =>
          new Promise((_resolve, reject) => {
            markEntered();
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          }),
      }),
    );
    await entered;
    const taskTimeout = timeoutSpy.mock.calls.find((call) => call[1] === taskTimeoutMs)?.[0];
    timeoutSpy.mockRestore();
    expect(taskTimeout).toBeDefined();
    (taskTimeout as () => void)();
    await waitForSettled(store, config.scopeId, started);
    await waitUntil(
      () => !store.isThreadActiveForOwner(userId, requireThreadId(started)),
      'timed-out child durable settlement',
    );

    expect(store.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'error',
      error: 'Detached subagent task timed out.',
    });
    const messages = await methods.getMessages({
      user: userId,
      conversationId: requireThreadId(started),
    });
    expect(messages.map((message) => message.text)).toContain(
      'Subagent task failed: The child run could not be completed.',
    );
    expect(messages.map((message) => message.text)).not.toContain('Subagent task was cancelled.');
  });

  it('lets durable settlement win once a successful commit has started', async () => {
    const userId = 'commit-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let markCommitStarted = (): void => undefined;
    let releaseCommit = (): void => undefined;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const blockingMethods = {
      ...methods,
      saveMessage: jest.fn(async (...args: Parameters<AllMethods['saveMessage']>) => {
        if (args[1].text === 'Committed result.') {
          markCommitStarted();
          await commitRelease;
        }
        return methods.saveMessage(...args);
      }),
    };
    const store = new SubagentThreadTaskStore(blockingMethods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => ({
          content: 'Committed result.',
          messages: [new AIMessage('Committed result.')],
        }),
      }),
    );
    await commitStarted;

    expect(
      store.control(config.scopeId, requireAccepted(started).task.taskId, { action: 'cancel' }),
    ).toMatchObject({ status: 'not_running' });
    releaseCommit();
    await waitForSettled(store, config.scopeId, started);
    expect(store.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'completed',
      result: 'Committed result.',
    });
  });

  it('fails closed for unknown, cross-parent, and mismatched-identity continuations', async () => {
    const userId = 'lineage-user';
    const firstParentId = randomUUID();
    const secondParentId = randomUUID();
    await Promise.all([saveParent(userId, firstParentId), saveParent(userId, secondParentId)]);
    const store = new SubagentThreadTaskStore(methods);
    const firstConfig = buildSubagentThreadTaskConfig(store, {
      userId,
      parentConversationId: firstParentId,
    });
    const secondConfig = buildSubagentThreadTaskConfig(store, {
      userId,
      parentConversationId: secondParentId,
    });
    const created = store.start(
      taskRequest(firstConfig.scopeId, {
        parentAgentId: 'agent-a',
        subagentType: 'self',
      }),
    );
    await waitForSettled(store, firstConfig.scopeId, created);

    const attempts = [
      {
        config: firstConfig,
        threadId: randomUUID(),
        overrides: {},
      },
      {
        config: secondConfig,
        threadId: requireThreadId(created),
        overrides: { parentAgentId: 'agent-a', subagentType: 'self' },
      },
      {
        config: firstConfig,
        threadId: requireThreadId(created),
        overrides: { parentAgentId: 'agent-b', subagentType: 'self' },
      },
      {
        config: firstConfig,
        threadId: requireThreadId(created),
        overrides: {
          parentAgentId: 'agent-a',
          subagentKind: 'graph' as const,
          subagentType: 'self',
        },
      },
    ];

    for (const attempt of attempts) {
      const run = jest.fn(taskRequest(attempt.config.scopeId).run);
      const rejected = store.start(
        taskRequest(attempt.config.scopeId, {
          threadId: attempt.threadId,
          run,
          ...attempt.overrides,
        }),
      );
      await waitForSettled(store, attempt.config.scopeId, rejected);
      expect(run).not.toHaveBeenCalled();
      expect(
        store.claim(attempt.config.scopeId, requireAccepted(rejected).task.taskId),
      ).toMatchObject({ status: 'error' });
    }
  });

  it('does not persist arbitrary executor details into the visible child chat', async () => {
    loggerErrorSpy.mockClear();
    const userId = 'safe-error-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => {
          throw new Error('Authorization: Bearer provider-secret');
        },
      }),
    );
    await waitForSettled(store, config.scopeId, started);

    const messages = await methods.getMessages({
      user: userId,
      conversationId: requireThreadId(started),
    });
    expect(messages[messages.length - 1]?.text).toBe(
      'Subagent task failed: The child run could not be completed.',
    );
    expect(JSON.stringify(messages)).not.toContain('provider-secret');
    expect(
      JSON.stringify(store.claim(config.scopeId, requireAccepted(started).task.taskId)),
    ).not.toContain('provider-secret');
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain('provider-secret');
  });

  it('routes live task polling and controls to the replica that owns the execution', async () => {
    const userId = 'routed-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods);
    const requesterStore = new SubagentThreadTaskStore(methods);
    const ownerTransport = new TestTaskControlTransport(hub);
    await ownerStore.configureTaskControlTransport(ownerTransport);
    await requesterStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async () => result,
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await Promise.resolve();
    expect(ownerTransport.registrations).toContainEqual({
      scopeId: config.scopeId,
      taskId,
      ttlMs: 30_000,
    });

    await expect(requesterStore.hasTasks(config.scopeId)).resolves.toBe(true);
    await expect(requesterStore.listTasks(config.scopeId)).resolves.toEqual([
      expect.objectContaining({ taskId, status: 'running' }),
    ]);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            {
              user: userId,
              conversationId: requireThreadId(started),
              messageId: `${taskId}:user`,
            },
            '+subagentTask',
          )
        ).length === 1,
      'the durable control receipt target',
    );
    await expect(
      requesterStore.controlTask(config.scopeId, taskId, {
        action: 'queue',
        message: 'Verify the primary source too.',
      }),
    ).resolves.toMatchObject({ status: 'accepted' });

    finish({ content: 'Cross-replica result.' });
    await waitForSettled(ownerStore, config.scopeId, started);
    await expect(requesterStore.claimTask(config.scopeId, taskId)).resolves.toMatchObject({
      status: 'completed',
      result: 'Cross-replica result.',
    });
    await expect(requesterStore.claimTask(config.scopeId, taskId)).resolves.toMatchObject({
      status: 'claimed',
    });
    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      requesterStore.destroyTaskControlTransport(),
    ]);
  });

  it('applies one control invocation once whether it arrives locally or through routing', async () => {
    const userId = 'invocation-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods);
    const requesterStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await requesterStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    let runtime: SubagentTaskRuntime | undefined;
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return result;
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    let durableInput: IMessage | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      [durableInput] = await methods.getMessages(
        { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
        '+subagentTask',
      );
      if (durableInput != null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(durableInput).toBeDefined();
    await waitUntil(() => runtime != null, 'the controlled child runtime');

    const steer = { action: 'queue' as const, message: 'Verify the primary source too.' };
    const routed = await requesterStore.controlTask(config.scopeId, taskId, steer, 'invocation-1');
    expect(routed).toMatchObject({ status: 'accepted' });

    [durableInput] = await methods.getMessages(
      { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
      '+subagentTask',
    );
    expect(durableInput?.subagentTask?.controlReceipts).toEqual([
      expect.objectContaining({
        invocationId: 'invocation-1',
        action: 'queue',
        status: 'accepted',
        message: steer.message,
      }),
    ]);

    /** The same invocation reaching the owner directly replays that result rather than
     * queueing a second steer, so local and routed callers agree. */
    await expect(
      ownerStore.controlTask(config.scopeId, taskId, steer, 'invocation-1'),
    ).resolves.toEqual(routed);
    expect(ownerStore.get(config.scopeId, taskId)?.pendingControls).toBe(1);

    const acceptedControlId =
      routed.status === 'accepted' && routed.controlId != null ? routed.controlId : undefined;
    expect(acceptedControlId).toBeDefined();
    const receiptIndex = (
      ownerStore as unknown as { controlInvocationByReceipt: Map<string, unknown> }
    ).controlInvocationByReceipt;
    expect(receiptIndex.size).toBe(1);
    expect(runtime?.drain('turn')).toEqual([
      expect.objectContaining({ content: steer.message, source: 'steer' }),
    ]);
    expect(receiptIndex.size).toBe(0);
    await waitUntil(
      () => ownerStore.get(config.scopeId, taskId) != null,
      'the owner task to remain available',
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      [durableInput] = await methods.getMessages(
        { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
        '+subagentTask',
      );
      if (durableInput?.subagentTask?.controlReceipts?.[0]?.status === 'applied') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(durableInput?.subagentTask?.controlReceipts).toEqual([
      expect.objectContaining({
        invocationId: 'invocation-1',
        status: 'applied',
        boundary: 'turn',
      }),
    ]);

    /** A delayed retry reflects the applied authoritative transition and cannot
     * downgrade the durable receipt to the original accepted snapshot. */
    await expect(
      ownerStore.controlTask(config.scopeId, taskId, steer, 'invocation-1'),
    ).resolves.toMatchObject({
      status: 'accepted',
      task: { pendingControls: 0 },
    });
    [durableInput] = await methods.getMessages(
      { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
      '+subagentTask',
    );
    expect(durableInput?.subagentTask?.controlReceipts?.[0]?.status).toBe('applied');

    /** Reusing one invocation id for different content is a caller error, not a retry. */
    await expect(
      requesterStore.controlTask(
        config.scopeId,
        taskId,
        { action: 'queue', message: 'Something else entirely.' },
        'invocation-1',
      ),
    ).resolves.toMatchObject({ status: 'invalid' });
    expect(ownerStore.get(config.scopeId, taskId)?.pendingControls).toBe(0);

    finish({ content: 'Cross-replica result.' });
    await waitForSettled(ownerStore, config.scopeId, started);
    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      requesterStore.destroyTaskControlTransport(),
    ]);
  });

  it('replays a durable control after owner loss and rejects fingerprint reuse', async () => {
    const userId = 'durable-control-replay-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const ownerStore = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = ownerStore.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );
    const command = { action: 'queue' as const, message: 'Keep the citation.' };
    await expect(
      ownerStore.controlTask(config.scopeId, taskId, command, 'durable-invocation'),
    ).resolves.toMatchObject({ status: 'accepted' });
    finish({ content: 'Done.' });
    await waitForSettled(ownerStore, config.scopeId, started);
    /** Owner shutdown is the production durability boundary. Awaiting it is both
     * stronger and less load-sensitive than polling Mongo while the async receipt
     * tail is still settling under Jest coverage instrumentation. */
    await ownerStore.destroyTaskControlTransport();
    const [settledInput] = await methods.getMessages(
      { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
      '+subagentTask',
    );
    expect(settledInput?.subagentTask?.controlReceipts).toContainEqual(
      expect.objectContaining({
        invocationId: 'durable-invocation',
        status: 'rejected',
        reason: 'task_completed',
      }),
    );

    const restartedStore = new SubagentThreadTaskStore(methods);
    (
      restartedStore as unknown as {
        taskControlTransport: {
          control: () => Promise<never>;
          destroy: () => Promise<void>;
        };
      }
    ).taskControlTransport = {
      control: async () => {
        throw new SubagentTaskOwnerUnavailableError();
      },
      destroy: async () => undefined,
    };
    await expect(
      restartedStore.controlTask(config.scopeId, taskId, command, 'durable-invocation'),
    ).resolves.toMatchObject({ status: 'not_running' });
    await expect(
      restartedStore.controlTask(
        config.scopeId,
        taskId,
        { action: 'queue', message: 'Different command.' },
        'durable-invocation',
      ),
    ).resolves.toMatchObject({ status: 'invalid' });
    await restartedStore.destroyTaskControlTransport();
  });

  it('replays the task-wide durable pending-control count after owner loss', async () => {
    const store = new SubagentThreadTaskStore(methods);
    const { scopeId } = buildSubagentThreadTaskConfig(store, {
      userId: 'durable-pending-count-user',
      parentConversationId: randomUUID(),
    });
    const command = { action: 'queue' as const, message: 'Keep both queued instructions.' };
    const now = new Date('2026-08-24T12:00:00.000Z');
    const replay = jest.spyOn(methods, 'getSubagentTaskControlReplay').mockResolvedValue({
      receipt: {
        invocationId: 'pending-count-invocation',
        fingerprint: controlFingerprint(command),
        controlId: 'pending-count-control',
        action: 'queue',
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
      },
      task: {
        taskId: 'pending-count-task',
        threadId: randomUUID(),
        subagentType: 'researcher',
        status: 'running',
        resultAvailable: false,
        resultClaimed: false,
        pendingControls: 2,
        createdAt: now,
        updatedAt: now,
      },
    });

    await expect(
      store.controlTask(scopeId, 'pending-count-task', command, 'pending-count-invocation'),
    ).resolves.toMatchObject({
      status: 'accepted',
      task: { pendingControls: 2 },
    });

    replay.mockRestore();
    await store.destroyTaskControlTransport();
  });

  it('waits for a raced authoritative receipt generation before acknowledging control', async () => {
    const userId = 'receipt-generation-race-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => (finish = resolve));
    let runtime: SubagentTaskRuntime | undefined;
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return result;
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the generation-race task seed',
    );
    await waitUntil(() => runtime != null, 'the generation-race child runtime');

    const originalRecord = methods.recordSubagentTaskControlReceipt.bind(methods);
    let releaseAccepted!: () => void;
    let releaseApplied!: () => void;
    let acceptedEntered!: () => void;
    let appliedEntered!: () => void;
    const acceptedGate = new Promise<void>((resolve) => (releaseAccepted = resolve));
    const appliedGate = new Promise<void>((resolve) => (releaseApplied = resolve));
    const sawAccepted = new Promise<void>((resolve) => (acceptedEntered = resolve));
    const sawApplied = new Promise<void>((resolve) => (appliedEntered = resolve));
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockImplementation(async (args) => {
        if (args.receipt.status === 'accepted') {
          acceptedEntered();
          await acceptedGate;
        } else if (args.receipt.status === 'applied') {
          appliedEntered();
          await appliedGate;
        }
        return originalRecord(args);
      });

    const control = store.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'Apply at the next boundary.' },
      'generation-race-invocation',
    );
    await sawAccepted;
    expect(runtime?.drain('turn')).toHaveLength(1);
    releaseAccepted();
    await sawApplied;
    let acknowledged = false;
    void control.then(() => (acknowledged = true));
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    releaseApplied();
    await expect(control).resolves.toMatchObject({
      status: 'accepted',
      task: { pendingControls: 0 },
    });

    persistence.mockRestore();
    finish({ content: 'Done.' });
    await waitForSettled(store, config.scopeId, started);
    await store.destroyTaskControlTransport();
  });

  it('refreshes retained cancellation result flags after durable collection', async () => {
    const userId = 'retained-control-claim-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (runtime) =>
          new Promise((_resolve, reject) => {
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the cancellation replay task seed',
    );

    await expect(
      store.controlTask(config.scopeId, taskId, { action: 'cancel' }, 'cancel-invocation'),
    ).resolves.toMatchObject({ status: 'cancelled' });
    await waitForSettled(store, config.scopeId, started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages({
            user: userId,
            conversationId: threadId,
            messageId: `${taskId}:assistant`,
          })
        ).length === 1,
      'the durable cancelled result',
    );
    await expect(store.claimTask(config.scopeId, taskId, 'poll-invocation')).resolves.toMatchObject(
      {
        status: 'cancelled',
        task: { resultClaimed: true },
      },
    );

    await expect(
      store.controlTask(config.scopeId, taskId, { action: 'cancel' }, 'cancel-invocation'),
    ).resolves.toMatchObject({
      status: 'cancelled',
      task: { resultAvailable: false, resultClaimed: true },
    });

    await store.destroyTaskControlTransport();
  });

  it('normalizes terminal replay storage failures at the owner boundary', async () => {
    const userId = 'terminal-replay-storage-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(taskRequest(config.scopeId));
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(store, config.scopeId, started);
    const replay = jest
      .spyOn(methods, 'getSubagentTaskControlReplay')
      .mockRejectedValue(new Error('database unavailable'));
    try {
      await expect(
        store.controlTask(config.scopeId, taskId, { action: 'cancel' }, 'storage-invocation'),
      ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    } finally {
      replay.mockRestore();
      await store.destroyTaskControlTransport();
    }
  });

  it('reserves one durable fingerprint before concurrent owners can apply controls', async () => {
    const userId = 'concurrent-control-reservation-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let runtime: SubagentTaskRuntime | undefined;
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return result;
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitUntil(() => runtime != null, 'the concurrent-control child runtime');

    const results = await Promise.all([
      store.controlTask(config.scopeId, taskId, { action: 'cancel' }, 'shared-invocation'),
      store.controlTask(
        config.scopeId,
        taskId,
        { action: 'queue', message: 'Only apply if this fingerprint wins.' },
        'shared-invocation',
      ),
    ]);
    expect(results.filter((candidate) => candidate.status === 'invalid')).toHaveLength(1);
    const winner = results.find((candidate) => candidate.status !== 'invalid');
    expect(winner?.status === 'cancelled' || winner?.status === 'accepted').toBe(true);
    if (winner?.status === 'accepted') {
      expect(runtime?.signal.aborted).toBe(false);
      expect(store.get(config.scopeId, taskId)?.pendingControls).toBe(1);
    } else {
      expect(runtime?.signal.aborted).toBe(true);
    }

    finish({ content: 'Done.' });
    await waitForSettled(store, config.scopeId, started);
    await store.destroyTaskControlTransport();
  });

  it('bounds concurrent durable reservation writers below the storage CAS retry limit', async () => {
    const userId = 'bounded-control-reservation-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods, { maxControlsPerTask: 100 });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    await waitUntil(() => store.get(config.scopeId, taskId)?.status === 'running', 'running task');

    let activeReservations = 0;
    let maxActiveReservations = 0;
    let releaseReservations = (): void => undefined;
    const reservationGate = new Promise<void>((resolve) => {
      releaseReservations = resolve;
    });
    const persist = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockImplementation(async ({ receipt }) => {
        if (receipt.status !== 'reserved') return true;
        activeReservations += 1;
        maxActiveReservations = Math.max(maxActiveReservations, activeReservations);
        await reservationGate;
        activeReservations -= 1;
        return true;
      });
    try {
      const controls = Array.from({ length: 65 }, (_, index) =>
        store.controlTask(
          config.scopeId,
          taskId,
          { action: 'queue', message: `Control ${index}` },
          `bounded-reservation-${index}`,
        ),
      );
      await waitUntil(() => activeReservations === 32, 'the reservation writer bound');
      expect(maxActiveReservations).toBe(32);
      releaseReservations();
      await expect(Promise.all(controls)).resolves.toHaveLength(65);
      expect(maxActiveReservations).toBe(32);
    } finally {
      releaseReservations();
      persist.mockRestore();
      finish({ content: 'Done.' });
      await waitForSettled(store, config.scopeId, started);
      await store.destroyTaskControlTransport();
    }
  });

  it('bounds retained terminal control invocations while persisting their receipts', async () => {
    const userId = 'terminal-control-window-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, { run: async () => ({ content: 'Done.' }) }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(store, config.scopeId, started);
    for (let index = 0; index < 65; index += 1) {
      await expect(
        store.controlTask(config.scopeId, taskId, { action: 'cancel' }, `terminal-${index}`),
      ).resolves.toMatchObject({ status: 'not_running' });
    }
    const retained = (store as unknown as { terminalControlInvocations: Map<string, unknown> })
      .terminalControlInvocations;
    expect(retained.size).toBe(64);
    const replayLookup = jest
      .spyOn(methods, 'getSubagentTaskControlReplay')
      .mockRejectedValue(new Error('database unavailable'));
    await expect(
      store.controlTask(config.scopeId, taskId, { action: 'cancel' }, 'terminal-64'),
    ).resolves.toMatchObject({ status: 'not_running' });
    expect(replayLookup).not.toHaveBeenCalled();
    replayLookup.mockRestore();
    await store.destroyTaskControlTransport();
  });

  it('refuses to evict an unpersisted terminal invocation', async () => {
    const userId = 'terminal-control-admission-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, { run: async () => ({ content: 'Done.' }) }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(store, config.scopeId, started);

    for (let index = 0; index < 64; index += 1) {
      expect(
        store.controlInvocation(config.scopeId, taskId, { action: 'cancel' }, `pending-${index}`),
      ).toMatchObject({ status: 'not_running' });
    }
    expect(
      store.controlInvocation(config.scopeId, taskId, { action: 'cancel' }, 'pending-64'),
    ).toMatchObject({ status: 'invalid' });
    const retained = (store as unknown as { terminalControlInvocations: Map<string, unknown> })
      .terminalControlInvocations;
    expect(retained.size).toBe(64);
    await store.destroyTaskControlTransport();
  });

  it('fails acceptance closed when the durable receipt target is not ready', async () => {
    const userId = 'receipt-target-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods, { controlReceiptRetryMs: 60_000 });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );

    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValue(new Error('database unavailable'));
    const command = { action: 'queue' as const, message: 'Check the source.' };
    try {
      await expect(
        store.controlTask(config.scopeId, taskId, command, 'not-ready-invocation'),
      ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
      expect(store.get(config.scopeId, taskId)?.pendingControls).toBe(0);

      await expect(
        store.controlTask(config.scopeId, taskId, command, 'not-ready-invocation'),
      ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
      expect(store.get(config.scopeId, taskId)?.pendingControls).toBe(0);
      persistence.mockRestore();

      await expect(
        store.controlTask(config.scopeId, taskId, command, 'not-ready-invocation'),
      ).resolves.toMatchObject({ status: 'accepted' });
      expect(store.get(config.scopeId, taskId)?.pendingControls).toBe(1);
    } finally {
      if (jest.isMockFunction(methods.recordSubagentTaskControlReceipt)) persistence.mockRestore();
      finish({ content: 'Done.' });
      await waitForSettled(store, config.scopeId, started);
      await store.destroyTaskControlTransport();
    }
  });

  it('drops a permanent receipt conflict and rolls back its queued control', async () => {
    const userId = 'receipt-conflict-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    await waitUntil(
      () => store.get(config.scopeId, taskId)?.threadId != null,
      'thread preparation',
    );
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockResolvedValue('conflict');
    const command = { action: 'queue' as const, message: 'Check the source.' };
    try {
      await expect(
        store.controlTask(config.scopeId, taskId, command, 'conflicting-invocation'),
      ).resolves.toMatchObject({ status: 'invalid' });
      expect(store.get(config.scopeId, taskId)?.pendingControls).toBe(0);
      await expect(
        store.controlTask(config.scopeId, taskId, command, 'conflicting-invocation'),
      ).resolves.toMatchObject({ status: 'invalid' });
      expect(persistence).toHaveBeenCalledTimes(2);
    } finally {
      persistence.mockRestore();
      finish({ content: 'Done.' });
      await waitForSettled(store, config.scopeId, started);
      await store.destroyTaskControlTransport();
    }
  });

  it('rejects a durable fingerprint conflict before applying task cancellation', async () => {
    const userId = 'receipt-preflight-conflict-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let runtime: SubagentTaskRuntime | undefined;
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return result;
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(() => runtime != null, 'the child runtime to start');
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );
    await expect(
      methods.recordSubagentTaskControlReceipt({
        userId,
        conversationId: threadId,
        taskId,
        receipt: {
          invocationId: 'conflicting-cancel',
          fingerprint: controlFingerprint({ action: 'queue', message: 'Original.' }),
          action: 'queue',
          status: 'rejected',
          reason: 'withdrawn',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).resolves.toBe(true);

    await expect(
      store.controlTask(config.scopeId, taskId, { action: 'cancel' }, 'conflicting-cancel'),
    ).resolves.toMatchObject({ status: 'invalid' });
    expect(runtime?.signal.aborted).toBe(false);
    expect(store.get(config.scopeId, taskId)?.status).toBe('running');

    finish({ content: 'Done.' });
    await waitForSettled(store, config.scopeId, started);
    await store.destroyTaskControlTransport();
  });

  it('does not replay a control whose prior owner only reserved its invocation', async () => {
    const userId = 'abandoned-control-reservation-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let runtime: SubagentTaskRuntime | undefined;
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return result;
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(() => runtime != null, 'the child runtime to start');
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );
    const command = { action: 'queue' as const, message: 'Apply this once.' };
    await expect(
      methods.recordSubagentTaskControlReceipt({
        userId,
        conversationId: threadId,
        taskId,
        receipt: {
          invocationId: 'abandoned-reservation',
          fingerprint: controlFingerprint(command),
          action: 'queue',
          status: 'reserved',
          message: command.message,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    ).resolves.toBe(true);

    /** The reservation proves a prior owner may have crossed the side-effect
     * boundary. A retry must neither apply it again nor report false acceptance. */
    await expect(
      store.controlTask(config.scopeId, taskId, command, 'abandoned-reservation'),
    ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    expect(store.get(config.scopeId, taskId)?.pendingControls).toBe(0);

    finish({ content: 'Done.' });
    await waitForSettled(store, config.scopeId, started);
    await store.destroyTaskControlTransport();
  });

  it('retains only the bounded public projection of a control payload', async () => {
    const userId = 'bounded-control-payload-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );

    await expect(
      store.controlTask(
        config.scopeId,
        taskId,
        { action: 'queue', message: 'x'.repeat(64 * 1024) },
        'bounded-payload-invocation',
      ),
    ).resolves.toMatchObject({ status: 'accepted' });
    const invocations = (
      store as unknown as {
        controlInvocations: Map<string, { command: SubagentTaskControlCommand }>;
      }
    ).controlInvocations;
    expect(invocations.values().next().value?.command).toEqual({
      action: 'queue',
      message: 'x'.repeat(4 * 1024),
    });
    await waitUntil(async () => {
      const [input] = await methods.getMessages(
        { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
        '+subagentTask',
      );
      return input?.subagentTask?.controlReceipts?.[0]?.messageTruncated === true;
    }, 'the bounded receipt truncation marker');
    await expect(
      store.controlTask(
        config.scopeId,
        taskId,
        { action: 'queue', message: `${'x'.repeat(64 * 1024 - 1)}y` },
        'bounded-payload-invocation',
      ),
    ).resolves.toMatchObject({ status: 'invalid' });

    finish({ content: 'Done.' });
    await waitForSettled(store, config.scopeId, started);
    await store.destroyTaskControlTransport();
  });

  it('restores tenant context for a routed control receipt write', async () => {
    const userId = 'routed-receipt-tenant-user';
    const tenantId = 'routed-receipt-tenant';
    const parentConversationId = randomUUID();
    await tenantStorage.run({ tenantId, userId }, async () =>
      saveParent(userId, parentConversationId, { tenantId }),
    );
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods);
    const requesterStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await requesterStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, {
      userId,
      tenantId,
      parentConversationId,
    });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = ownerStore.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      () =>
        tenantStorage.run({ tenantId, userId }, async () =>
          Boolean(
            (
              await methods.getMessages(
                { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
                '+subagentTask',
              )
            )[0],
          ),
        ),
      'the tenant-scoped task input',
    );

    const contexts: Array<{ tenantId?: string; userId?: string }> = [];
    const persistReceipt = methods.recordSubagentTaskControlReceipt;
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockImplementation((input) => {
        contexts.push({ tenantId: getTenantId(), userId: getUserId() });
        return persistReceipt(input);
      });
    try {
      await expect(
        requesterStore.controlTask(
          config.scopeId,
          taskId,
          { action: 'queue', message: 'Check the tenant source.' },
          'tenant-invocation',
        ),
      ).resolves.toMatchObject({ status: 'accepted' });
      expect(contexts).toEqual([
        { tenantId, userId },
        { tenantId, userId },
      ]);
    } finally {
      persistence.mockRestore();
      finish({ content: 'Done.' });
      await waitForSettled(ownerStore, config.scopeId, started);
      await Promise.all([
        ownerStore.destroyTaskControlTransport(),
        requesterStore.destroyTaskControlTransport(),
      ]);
    }
  });

  it('persists the target control id for cancel_message receipts', async () => {
    const userId = 'cancel-message-receipt-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );

    const queued = await store.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'Withdraw me.' },
      'queued-invocation',
    );
    expect(queued).toMatchObject({ status: 'accepted' });
    const targetControlId = queued.status === 'accepted' ? queued.controlId : undefined;
    expect(targetControlId).toBeDefined();
    await expect(
      store.controlTask(
        config.scopeId,
        taskId,
        { action: 'cancel_message', controlId: targetControlId as string },
        'cancel-message-invocation',
      ),
    ).resolves.toMatchObject({ status: 'accepted' });
    await expect(
      store.controlTask(
        config.scopeId,
        taskId,
        { action: 'cancel_message', controlId: 'missing-control' },
        'missing-cancel-message-invocation',
      ),
    ).resolves.toMatchObject({ status: 'control_not_found' });

    await waitUntil(async () => {
      const [input] = await methods.getMessages(
        { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
        '+subagentTask',
      );
      return (
        input?.subagentTask?.controlReceipts?.some(
          (receipt) => receipt.invocationId === 'cancel-message-invocation',
        ) === true
      );
    }, 'the cancel_message receipt');
    const [input] = await methods.getMessages(
      { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
      '+subagentTask',
    );
    expect(input?.subagentTask?.controlReceipts).toContainEqual(
      expect.objectContaining({
        invocationId: 'cancel-message-invocation',
        controlId: targetControlId,
        action: 'cancel_message',
        status: 'applied',
      }),
    );
    expect(input?.subagentTask?.controlReceipts).toContainEqual(
      expect.objectContaining({
        invocationId: 'missing-cancel-message-invocation',
        controlId: 'missing-control',
        action: 'cancel_message',
        status: 'rejected',
        reason: 'control_not_found',
      }),
    );

    finish({ content: 'Done.' });
    await waitForSettled(store, config.scopeId, started);
    await store.destroyTaskControlTransport();
  });

  it('retries a terminal control receipt after settlement when storage recovers', async () => {
    const userId = 'receipt-retry-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new ReceiptTestSubagentThreadTaskStore(methods, {
      controlReceiptRetryMs: 10,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => result,
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );
    const command = { action: 'queue' as const, message: 'Verify the source.' };
    const accepted = await store.controlTask(config.scopeId, taskId, command, 'retry-invocation');
    expect(accepted).toMatchObject({ status: 'accepted' });
    const controlId = accepted.status === 'accepted' ? accepted.controlId : undefined;
    expect(controlId).toBeDefined();

    const persistReceipt = methods.recordSubagentTaskControlReceipt;
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockResolvedValueOnce(false)
      .mockImplementation(persistReceipt);
    try {
      const appliedAt = Date.now();
      store.emitControlReceiptForTest(config.scopeId, taskId, {
        controlId: controlId as string,
        action: 'queue',
        status: 'applied',
        createdAt: appliedAt - 1,
        updatedAt: appliedAt,
        boundary: 'turn',
      });
      await waitUntil(
        () => persistence.mock.calls.length >= 1,
        'the applied transition persistence attempt',
      );
      finish({ content: 'Done.' });
      await waitForSettled(store, config.scopeId, started);

      await waitUntil(
        () => persistence.mock.calls.length >= 3,
        'the post-settlement receipt retry',
      );
      await waitUntil(async () => {
        const [input] = await methods.getMessages(
          { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
          '+subagentTask',
        );
        return input?.subagentTask?.controlReceipts?.[0]?.status === 'applied';
      }, 'the receipt retry to converge after terminal settlement');
      expect(persistence.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      persistence.mockRestore();
      finish({ content: 'Done.' });
      await store.destroyTaskControlTransport();
    }
  });

  it('retries a terminal receipt after result collection removes the local task', async () => {
    const userId = 'receipt-after-claim-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods, { controlReceiptRetryMs: 5 });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start(taskRequest(config.scopeId, { run: async () => result }));
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the claim-race durable task input',
    );
    await store.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'Persist the terminal transition after collection.' },
      'claim-race-invocation',
    );

    const persistReceipt = methods.recordSubagentTaskControlReceipt;
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockImplementation(persistReceipt);
    try {
      finish({ content: 'Done.' });
      await waitForSettled(store, config.scopeId, started);
      expect(store.claim(config.scopeId, taskId)).toMatchObject({ status: 'completed' });
      await waitUntil(
        () => persistence.mock.calls.length >= 1,
        'the terminal receipt persistence failure',
      );
      /** Model the SDK retention timer expiring the claimed result before the
       * storage retry fires. Pending durability must not depend on this bucket. */
      const bucket = (
        store as unknown as {
          buckets: Map<string, { tasks: Map<string, unknown> }>;
        }
      ).buckets.get(config.scopeId);
      bucket?.tasks.delete(taskId);
      expect(store.get(config.scopeId, taskId)).toBeUndefined();
      await waitUntil(async () => {
        const [input] = await methods.getMessages(
          { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
          '+subagentTask',
        );
        return input?.subagentTask?.controlReceipts?.[0]?.reason === 'task_completed';
      }, 'the post-collection terminal receipt retry');
    } finally {
      persistence.mockRestore();
      await store.destroyTaskControlTransport();
    }
  });

  it('quiesces receipt producers and flushes their final transition during shutdown', async () => {
    const userId = 'receipt-shutdown-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new ReceiptTestSubagentThreadTaskStore(methods, {
      controlReceiptRetryMs: 60_000,
      shutdownControlReceiptBackoffMs: 1,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let runtime: SubagentTaskRuntime | undefined;
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return await new Promise<{ content: string }>((_resolve, reject) => {
            taskRuntime.signal.addEventListener(
              'abort',
              () => reject(new Error('provider stopped after task cancellation')),
              { once: true },
            );
          });
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(() => runtime != null, 'the child runtime to start');
    const accepted = await store.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'Persist before shutdown.' },
      'shutdown-invocation',
    );
    expect(accepted).toMatchObject({ status: 'accepted' });

    const persistReceipt = methods.recordSubagentTaskControlReceipt;
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockImplementation(persistReceipt);
    const saveMessage = methods.saveMessage;
    let releaseCancellation = (): void => undefined;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationSaveStarted = false;
    const settlement = jest.spyOn(methods, 'saveMessage').mockImplementation(async (...args) => {
      const message = args[1] as IMessage;
      if (
        message.messageId === `${taskId}:assistant` &&
        message.subagentTask?.status === 'cancelled'
      ) {
        cancellationSaveStarted = true;
        await cancellationGate;
      }
      return saveMessage(...args);
    });

    const shutdown = store.destroyTaskControlTransport();
    await waitUntil(() => cancellationSaveStarted, 'the cancellation settlement to start');
    let shutdownResolved = false;
    void shutdown.then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);
    releaseCancellation();
    await shutdown;
    expect(runtime?.signal.aborted).toBe(true);
    const [input] = await methods.getMessages(
      { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
      '+subagentTask',
    );
    expect(input?.subagentTask?.controlReceipts).toContainEqual(
      expect.objectContaining({
        invocationId: 'shutdown-invocation',
        status: 'rejected',
        reason: 'task_cancelled',
      }),
    );
    expect(persistence).toHaveBeenCalledTimes(2);

    persistence.mockRestore();
    settlement.mockRestore();
    expect(store.get(config.scopeId, taskId)?.status).toBe('cancelled');
  });

  it('fails graceful shutdown when terminal receipts remain unavailable', async () => {
    const userId = 'receipt-shutdown-failure-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new ReceiptTestSubagentThreadTaskStore(methods, {
      shutdownControlReceiptBackoffMs: 1,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let runtime: SubagentTaskRuntime | undefined;
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return await new Promise<{ content: string }>((_resolve, reject) => {
            taskRuntime.signal.addEventListener('abort', () => reject(new Error('stopped')), {
              once: true,
            });
          });
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitUntil(() => runtime != null, 'the child runtime to start');
    await store.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'Persist me.' },
      'shutdown-failure-invocation',
    );
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValue(new Error('database unavailable'));

    await expect(store.destroyTaskControlTransport()).rejects.toBeInstanceOf(
      SubagentTaskOwnerUnavailableError,
    );
    expect(persistence.mock.calls.length).toBeGreaterThanOrEqual(4);
    persistence.mockRestore();
    await store.destroyTaskControlTransport();
    await waitForSettled(store, config.scopeId, started);
  });

  it('drops permanently unwritable control receipt work after its conversations are deleted', async () => {
    const userId = 'deleted-control-receipt-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new ReceiptTestSubagentThreadTaskStore(methods, {
      controlReceiptRetryMs: 60_000,
      shutdownControlReceiptBackoffMs: 1,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let runtime: SubagentTaskRuntime | undefined;
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async (taskRuntime) => {
          runtime = taskRuntime;
          return await new Promise<{ content: string }>((_resolve, reject) => {
            taskRuntime.signal.addEventListener('abort', () => reject(new Error('deleted')), {
              once: true,
            });
          });
        },
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(() => runtime != null, 'the child runtime to start');
    const accepted = await store.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'This receipt target will be deleted.' },
      'deleted-receipt-invocation',
    );
    expect(accepted).toMatchObject({ status: 'accepted' });
    const controlId = accepted.status === 'accepted' ? accepted.controlId : undefined;
    expect(controlId).toBeDefined();

    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValue(new Error('receipt target deleted'));
    try {
      const appliedAt = Date.now();
      store.emitControlReceiptForTest(config.scopeId, taskId, {
        controlId: controlId as string,
        action: 'queue',
        status: 'applied',
        createdAt: appliedAt - 1,
        updatedAt: appliedAt,
        boundary: 'turn',
      });
      await waitUntil(
        () => persistence.mock.calls.length >= 1,
        'the permanently unwritable receipt',
      );

      const plan = await store.planCancellationForConversations(userId, [parentConversationId]);
      await methods.deleteConvos(userId, { conversationId: parentConversationId });
      await expect(
        store.cancelPlan(plan, [parentConversationId, threadId]),
      ).resolves.toBeGreaterThanOrEqual(1);
      await waitForSettled(store, config.scopeId, started);
    } finally {
      persistence.mockRestore();
    }

    /** Deletion is a terminal storage outcome, so shutdown must not keep retrying
     * receipt rows whose authorized parent or child no longer exists. */
    await expect(store.destroyTaskControlTransport()).resolves.toBeUndefined();
  });

  it('fails a child closed when its owner address cannot be published', async () => {
    const userId = 'unregistered-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const transport = new TestTaskControlTransport(hub);
    transport.registerTask = async () => {
      throw new Error('registration failed');
    };
    const store = new SubagentThreadTaskStore(methods);
    await store.configureTaskControlTransport(transport);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const run = jest.fn(async () => ({ content: 'never reached' }));
    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    /** An unaddressable child cannot be polled, controlled, or cancelled, so no
     * provider work may start behind a failed registration. */
    expect(run).not.toHaveBeenCalled();
    expect(store.get(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'error',
    });
    await store.destroyTaskControlTransport();
  });

  it('returns a lost result to the same poll invocation and refuses a different one', async () => {
    const userId = 'durable-claim-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods);
    const requesterStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await requesterStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async () => ({ content: 'Cross-replica result.' }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(ownerStore, config.scopeId, started);

    await expect(requesterStore.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject(
      { status: 'completed', result: 'Cross-replica result.' },
    );

    /** The owner's one-shot result is gone, but the child's durable thread still holds
     * it, so the invocation that already collected it recovers its own result. */
    await expect(requesterStore.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject(
      { status: 'completed', result: 'Cross-replica result.' },
    );

    /** A different invocation is told it was collected rather than handed a copy. */
    await expect(requesterStore.claimTask(config.scopeId, taskId, 'poll-2')).resolves.toMatchObject(
      { status: 'claimed' },
    );

    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      requesterStore.destroyTaskControlTransport(),
    ]);
  });

  it('bounds a result recovered from its durable child message', async () => {
    const userId = 'large-result-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => ({ content: 'x'.repeat(150_000) }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(store, config.scopeId, started);

    await expect(store.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject({
      status: 'completed',
    });

    /** The durable message keeps the child's untruncated output, so recovering it
     * must apply the same bound a routed response would have. */
    const recovered = await store.claimTask(config.scopeId, taskId, 'poll-1');
    expect(recovered.status).toBe('completed');
    if (recovered.status === 'completed') {
      expect(recovered.result.length).toBeLessThanOrEqual(100_000);
    }
  });

  it('recovers a durable result after the owning process and registration are gone', async () => {
    const userId = 'restarted-owner-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const ownerStore = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async () => ({ content: 'Recovered without owner memory.' }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(ownerStore, config.scopeId, started);

    /** A fresh store has neither the in-memory task nor a Redis owner registration. */
    const restartedStore = new SubagentThreadTaskStore(methods);
    const unrelatedParentConversationId = randomUUID();
    await saveParent(userId, unrelatedParentConversationId);
    const unrelatedConfig = buildSubagentThreadTaskConfig(restartedStore, {
      userId,
      parentConversationId: unrelatedParentConversationId,
    });
    await expect(
      restartedStore.claimTask(unrelatedConfig.scopeId, taskId, 'wrong-parent-poll'),
    ).resolves.toEqual({ status: 'not_found' });

    await expect(restartedStore.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject(
      {
        status: 'completed',
        result: 'Recovered without owner memory.',
      },
    );
    await expect(restartedStore.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject(
      {
        status: 'completed',
        result: 'Recovered without owner memory.',
      },
    );
    await expect(restartedStore.claimTask(config.scopeId, taskId, 'poll-2')).resolves.toMatchObject(
      {
        status: 'claimed',
      },
    );
  });

  it('tells a second invocation a retained result was already collected', async () => {
    const userId = 'duplicate-claim-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => ({ content: 'Only one caller may hold this.' }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(store, config.scopeId, started);
    const threadId = requireThreadId(started);

    await expect(store.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'Only one caller may hold this.',
    });

    /** An owner replaying a retained response would hand the same terminal result to
     * another invocation; the durable record decides, so that one is told it was
     * already collected rather than being given a second copy. */
    const replayingStore = new SubagentThreadTaskStore(methods);
    await replayingStore.configureTaskControlTransport(
      replayTransport({
        status: 'completed',
        task: { ...threadSnapshot(taskId), threadId, status: 'completed' },
        result: 'Only one caller may hold this.',
      }),
    );
    await expect(replayingStore.claimTask(config.scopeId, taskId, 'poll-2')).resolves.toMatchObject(
      { status: 'claimed' },
    );

    /** The invocation that already holds it still recovers its own result. */
    await expect(replayingStore.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject(
      { status: 'completed', result: 'Only one caller may hold this.' },
    );

    await replayingStore.destroyTaskControlTransport();
  });

  it('refuses to build a store the host wired without a required method', () => {
    const { claimSubagentTaskResult: _omitted, ...incomplete } = methods;

    /** The host wires this from JavaScript, so a missing method has to fail at
     * startup rather than as an unavailable result the first time a task settles. */
    expect(() =>
      createSubagentThreadTaskStore(
        incomplete as unknown as Parameters<typeof createSubagentThreadTaskStore>[0],
      ),
    ).toThrow('claimSubagentTaskResult');
    expect(() => createSubagentThreadTaskStore(methods)).not.toThrow();
  });

  it('renews its own fence while a long deletion is still running', async () => {
    const userId = 'long-deletion-user';
    const renewals: string[] = [];
    const store = new SubagentThreadTaskStore(methods, {
      ownerDrainPollMs: 1,
      ownerDrainTimeoutMs: 30,
      ownerFenceGraceMs: 60,
      fenceOwnerAdmission: async () => undefined,
      renewOwnerAdmission: async (_userId: string, token: string) => {
        renewals.push(token);
        return true;
      },
      releaseOwnerAdmission: async () => undefined,
    });
    const listLeases = jest.spyOn(methods, 'listActiveSubagentThreadLeases').mockResolvedValue([]);
    try {
      await store.withOwnerDeletionFence(userId, undefined, async () => {
        /** A deletion outlasting its 90ms fence window must not let the fence lapse. */
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        return 'deleted';
      });
    } finally {
      listLeases.mockRestore();
    }

    expect(renewals.length).toBeGreaterThan(0);
    expect(new Set(renewals).size).toBe(1);
  });

  it('re-fences and drains again after a fence gap during deletion', async () => {
    const userId = 'deletion-gap-user';
    let recoveryAllowed = false;
    const fenceOwnerAdmission = jest.fn(async () => undefined);
    const listActiveSubagentThreadLeases = jest.fn(async () => []);
    const testMethods = { ...methods, listActiveSubagentThreadLeases };
    const renewOwnerAdmission = jest.fn(async () => {
      if (!recoveryAllowed) {
        throw new Error('database temporarily unavailable');
      }
      return false;
    });
    const store = new SubagentThreadTaskStore(testMethods, {
      ownerDrainPollMs: 1,
      ownerDrainTimeoutMs: 30,
      ownerFenceGraceMs: 60,
      fenceOwnerAdmission,
      renewOwnerAdmission,
      releaseOwnerAdmission: async () => undefined,
    });
    await expect(
      store.withOwnerDeletionFence(userId, undefined, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        recoveryAllowed = true;
        return 'deleted';
      }),
    ).resolves.toBe('deleted');

    expect(fenceOwnerAdmission).toHaveBeenCalledTimes(2);
    expect(listActiveSubagentThreadLeases).toHaveBeenCalledTimes(2);
  });

  it('does not report deletion success when post-gap recovery fails', async () => {
    const userId = 'deletion-gap-failure-user';
    const listActiveSubagentThreadLeases = jest.fn(async () => []);
    const testMethods = { ...methods, listActiveSubagentThreadLeases };
    const store = new SubagentThreadTaskStore(testMethods, {
      ownerDrainPollMs: 1,
      ownerDrainTimeoutMs: 30,
      ownerFenceGraceMs: 60,
      fenceOwnerAdmission: async () => undefined,
      renewOwnerAdmission: async () => {
        throw new Error('database unavailable');
      },
      releaseOwnerAdmission: async () => undefined,
    });
    await expect(
      store.withOwnerDeletionFence(userId, undefined, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        return 'deleted';
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('cancels a grandchild whose own conversation the cascade removed', async () => {
    const userId = 'cascade-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods, { maxThreadDepth: 3 });
    const deletingStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await deletingStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const childConversationId = randomUUID();
    await saveParent(userId, childConversationId, {
      subagentThread: {
        rootConversationId: parentConversationId,
        parentConversationId,
        parentAgentId: 'parent-agent',
        subagentType: 'researcher',
        depth: 1,
      },
    });
    /** The grandchild runs inside the child's scope, which a plan naming only the
     * deleted root never covers. */
    const config = buildSubagentThreadTaskConfig(ownerStore, {
      userId,
      parentConversationId: childConversationId,
    });
    let finish = (_value: { content: string }): void => undefined;
    const running = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = ownerStore.start(taskRequest(config.scopeId, { run: async () => running }));
    const taskId = requireAccepted(started).task.taskId;
    await Promise.resolve();

    const plan = await deletingStore.planCancellationForConversations(userId, [
      parentConversationId,
    ]);
    await expect(
      deletingStore.cancelPlan(plan, [parentConversationId, childConversationId]),
    ).resolves.toBeGreaterThanOrEqual(1);
    await waitForSettled(ownerStore, config.scopeId, started);
    expect(ownerStore.get(config.scopeId, taskId)).toMatchObject({ status: 'cancelled' });

    finish({ content: 'late' });
    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      deletingStore.destroyTaskControlTransport(),
    ]);
  });

  it('reports a result as unavailable when its collection cannot be recorded', async () => {
    const userId = 'unrecordable-claim-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const started = store.start(
      taskRequest(config.scopeId, {
        run: async () => ({ content: 'Recorded before it is handed over.' }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await waitForSettled(store, config.scopeId, started);

    /** Handing the result over without recording its claimant would let another
     * invocation collect the same one-shot output once the database recovers. */
    const claimResult = jest
      .spyOn(methods, 'claimSubagentTaskResult')
      .mockRejectedValueOnce(new Error('database unavailable'));
    try {
      await expect(store.claimTask(config.scopeId, taskId, 'poll-1')).rejects.toBeInstanceOf(
        SubagentTaskOwnerUnavailableError,
      );
    } finally {
      claimResult.mockRestore();
    }

    /** The result stays unclaimed, so a later poll still collects it exactly once. */
    await expect(store.claimTask(config.scopeId, taskId, 'poll-1')).resolves.toMatchObject({
      status: 'completed',
      result: 'Recorded before it is handed over.',
    });
    await expect(store.claimTask(config.scopeId, taskId, 'poll-2')).resolves.toMatchObject({
      status: 'claimed',
    });
  });

  it('does not spend live replay slots on controls rejected by settled tasks', async () => {
    const userId = 'invocation-eviction-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods, {
      maxControlInvocations: 2,
      completedTtlMs: 20,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    let finish = (_value: { content: string }): void => undefined;
    const running = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const live = store.start(taskRequest(config.scopeId, { run: async () => running }));
    const liveTaskId = requireAccepted(live).task.taskId;
    const settled = store.start(
      taskRequest(config.scopeId, { run: async () => ({ content: 'done' }) }),
    );
    const settledTaskId = requireAccepted(settled).task.taskId;
    await waitForSettled(store, config.scopeId, settled);

    const steer = { action: 'queue' as const, message: 'Verify the primary source too.' };
    const applied = store.controlInvocation(config.scopeId, liveTaskId, steer, 'invocation-live');
    expect(applied).toMatchObject({ status: 'accepted' });
    expect(
      store.controlInvocation(config.scopeId, settledTaskId, steer, 'invocation-settled'),
    ).toMatchObject({ status: 'not_running' });
    expect(
      (
        store as unknown as {
          controlInvocations: Map<string, unknown>;
        }
      ).controlInvocations.size,
    ).toBe(1);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (store.get(config.scopeId, settledTaskId) == null) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(store.get(config.scopeId, settledTaskId)).toBeUndefined();

    /** A second live invocation fills the window. The first live record survives, so
     * a caller retrying it replays instead of steering that child a second time. */
    store.controlInvocation(config.scopeId, liveTaskId, steer, 'invocation-later');
    expect(store.controlInvocation(config.scopeId, liveTaskId, steer, 'invocation-live')).toEqual(
      applied,
    );
    expect(store.get(config.scopeId, liveTaskId)?.pendingControls).toBe(2);

    /** With every remaining record belonging to a live task, a further invocation is
     * refused rather than displacing one: applying it unrecorded would let its own
     * retry apply the command twice. */
    expect(
      store.controlInvocation(config.scopeId, liveTaskId, steer, 'invocation-third'),
    ).toMatchObject({ status: 'invalid' });
    expect(store.get(config.scopeId, liveTaskId)?.pendingControls).toBe(2);

    finish({ content: 'done' });
    /** This store deliberately uses a 20 ms completed TTL. Under coverage the
     * task can settle and expire between polling ticks, which is also a valid
     * terminal outcome for the cleanup asserted by this test. */
    await waitUntil(
      () => store.get(config.scopeId, liveTaskId)?.status !== 'running',
      'the live replay-window task to settle or expire',
    );
    await store.destroyTaskControlTransport();
  });

  it('caps the merged local and remote task list the poll tool reads', async () => {
    const userId = 'merged-list-cap-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    /** The base store caps concurrent runs twice over — ten per scope and a hundred
     * across the store — and this test is about what the merge returns rather than
     * about admission, so both are raised to admit every task it starts. */
    const store = new SubagentThreadTaskStore(methods, {
      maxRunningPerScope: 150,
      maxRunningTotal: 150,
    });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const remote = Array.from({ length: 150 }, (_unused, index) =>
      threadSnapshot(`remote-task-${index + 1}`),
    );
    await store.configureTaskControlTransport({
      ...replayTransport({ status: 'claimed', task: threadSnapshot('remote-task-1') }),
      list: async () => remote,
    });

    const local = await Promise.all(
      Array.from({ length: 150 }, () => store.start(taskRequest(config.scopeId))),
    );
    await Promise.all(local.map((started) => waitForSettled(store, config.scopeId, started)));
    expect(store.list(config.scopeId)).toHaveLength(150);

    /** Each owner's reply and the remote aggregation are bounded on their own, but the
     * poll tool reads this merge — 300 distinct tasks must still arrive as 200. */
    await expect(store.listTasks(config.scopeId)).resolves.toHaveLength(200);

    await store.destroyTaskControlTransport();
  });

  it('routes a control for a remote task while the local invocation window is full', async () => {
    const userId = 'remote-control-under-load-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods, { maxControlInvocations: 1 });
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const remoteResult: SubagentTaskControlResult = {
      status: 'cancelled',
      task: threadSnapshot('remote-task'),
    };
    const routed = jest.fn(async () => remoteResult);
    await store.configureTaskControlTransport({
      ...replayTransport({ status: 'claimed', task: threadSnapshot('remote-task') }),
      control: routed,
    });

    let finish = (_value: { content: string }): void => undefined;
    const running = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const live = store.start(taskRequest(config.scopeId, { run: async () => running }));
    const liveTaskId = requireAccepted(live).task.taskId;
    const steer = { action: 'queue' as const, message: 'Check the changelog as well.' };
    expect(store.controlInvocation(config.scopeId, liveTaskId, steer, 'local-1')).toMatchObject({
      status: 'accepted',
    });
    const replayLookup = jest.spyOn(methods, 'getSubagentTaskControlReplay');

    /** The window holds a live task's record and cannot be swept, but a task this
     * replica never owned is the remote owner's to refuse or apply. Only that owner
     * performs the durable preflight; the requester does not repeat the Mongo read. */
    await expect(
      store.controlTask(config.scopeId, 'remote-task', { action: 'cancel' }, 'remote-1'),
    ).resolves.toEqual(remoteResult);
    expect(routed).toHaveBeenCalledWith(
      config.scopeId,
      'remote-task',
      { action: 'cancel' },
      'remote-1',
    );
    expect(replayLookup).not.toHaveBeenCalled();
    replayLookup.mockRestore();

    finish({ content: 'done' });
    await waitForSettled(store, config.scopeId, live);
    await store.destroyTaskControlTransport();
  });

  it('normalizes a storage outage after routed owner loss', async () => {
    const userId = 'remote-fallback-outage-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods);
    const { scopeId } = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    await store.configureTaskControlTransport({
      ...replayTransport({ status: 'not_found' }),
      control: async () => {
        throw new SubagentTaskOwnerUnavailableError();
      },
    });
    const replayLookup = jest
      .spyOn(methods, 'getSubagentTaskControlReplay')
      .mockRejectedValue(new Error('database unavailable'));

    await expect(
      store.controlTask(scopeId, 'remote-task', { action: 'cancel' }, 'remote-outage'),
    ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);
    expect(replayLookup).toHaveBeenCalledTimes(1);

    replayLookup.mockRestore();
    await store.destroyTaskControlTransport();
  });

  it('fails a deletion closed when the admission fence cannot be held', async () => {
    const userId = 'fence-lapse-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const store = new SubagentThreadTaskStore(methods, {
      ownerDrainTimeoutMs: 60,
      ownerFenceGraceMs: 60,
      fenceOwnerAdmission: async () => undefined,
      renewOwnerAdmission: async () => {
        throw new Error('database unavailable');
      },
      releaseOwnerAdmission: async () => undefined,
    });
    /** A drain that outlasts the 120ms fence window while every renewal rejects: the
     * last confirmed `fencedUntil` passes and nothing is left holding admission shut. */
    const leases = jest
      .spyOn(methods, 'listActiveSubagentThreadLeases')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return [];
      });
    const deletion = jest.fn(async () => 'deleted');
    try {
      await expect(store.withOwnerDeletionFence(userId, undefined, deletion)).rejects.toThrow(
        'admission fence expired',
      );
      /** Nothing was removed, so the caller can retry once the fence holds again. */
      expect(deletion).not.toHaveBeenCalled();
    } finally {
      leases.mockRestore();
    }
  });

  it('treats a renewal that lands after its own deadline as a lapse', async () => {
    const userId = 'fence-late-renewal-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let renewals = 0;
    const store = new SubagentThreadTaskStore(methods, {
      ownerDrainTimeoutMs: 60,
      ownerFenceGraceMs: 60,
      fenceOwnerAdmission: async () => undefined,
      /** Succeeds, but the first write only lands well past the 120ms deadline it was
       * meant to extend — admission stood open for the difference. */
      renewOwnerAdmission: async () => {
        renewals += 1;
        if (renewals === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
        }
        return true;
      },
      releaseOwnerAdmission: async () => undefined,
    });
    const leases = jest
      .spyOn(methods, 'listActiveSubagentThreadLeases')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        return [];
      });
    const deletion = jest.fn(async () => 'deleted');
    try {
      await expect(store.withOwnerDeletionFence(userId, undefined, deletion)).rejects.toThrow(
        'admission fence expired',
      );
      /** Every renewal reported success, so a deadline restored from the write's own
       * start time would have read as continuously fenced. */
      expect(renewals).toBeGreaterThan(0);
      expect(deletion).not.toHaveBeenCalled();
    } finally {
      leases.mockRestore();
    }
  });

  it('releases the owner fence after an in-flight renewal instead of racing it', async () => {
    const userId = 'fence-renewal-race-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    let releaseRenewal = (): void => undefined;
    const renewalBlocked = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    let markRenewing = (): void => undefined;
    const renewing = new Promise<void>((resolve) => {
      markRenewing = resolve;
    });
    const order: string[] = [];
    const fenceOwnerAdmission = jest.fn(async () => {
      order.push('fence');
    });
    /** The renewal is still waiting on the database when the deletion finishes, and it
     * reports the fence lost — the shape that used to leave a fresh, unreleasable one. */
    let renewalAttempts = 0;
    const renewOwnerAdmission = jest.fn(async () => {
      renewalAttempts += 1;
      markRenewing();
      await renewalBlocked;
      order.push('renew');
      /** The in-flight renewal discovers the entry missing and re-takes it; the
       * recovery renewal then confirms that replacement while the second drain runs. */
      return renewalAttempts > 1;
    });
    const releaseOwnerAdmission = jest.fn(async () => {
      order.push('release');
    });
    const testMethods = {
      ...methods,
      listActiveSubagentThreadLeases: jest.fn(async () => []),
    };
    const store = new SubagentThreadTaskStore(testMethods, {
      ownerDrainTimeoutMs: 60,
      ownerFenceGraceMs: 60,
      fenceOwnerAdmission,
      renewOwnerAdmission,
      releaseOwnerAdmission,
    });

    let releaseDeletion = (): void => undefined;
    const deletionBlocked = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const fenced = store.withOwnerDeletionFence(
      userId,
      undefined,
      async () => {
        await deletionBlocked;
        return 'deleted';
      },
      async () => {
        order.push('remote-drain');
      },
    );
    await renewing;
    releaseDeletion();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['fence']);

    releaseRenewal();
    await expect(fenced).resolves.toBe('deleted');
    /** The lost entry is re-taken before the recovery drain and only released after
     * the in-flight renewal and recovery renewal both settle. */
    expect(order).toEqual(['fence', 'renew', 'fence', 'renew', 'remote-drain', 'release']);
    expect(fenceOwnerAdmission).toHaveBeenCalledTimes(2);
  });

  it('cancels each drained task once and retries only unconfirmed deliveries', async () => {
    const userId = 'drain-user';
    const parentConversationId = randomUUID();
    const store = new SubagentThreadTaskStore(methods, {
      ownerDrainPollMs: 1,
      ownerDrainTimeoutMs: 5_000,
    });
    const lease = { taskId: 'task-1', parentConversationId, conversationId: randomUUID() };
    const listLeases = jest
      .spyOn(methods, 'listActiveSubagentThreadLeases')
      .mockResolvedValueOnce([lease])
      .mockResolvedValueOnce([lease])
      .mockResolvedValueOnce([lease])
      .mockResolvedValueOnce([lease])
      .mockResolvedValue([]);
    const controlTask = jest
      .spyOn(store, 'controlTask')
      .mockRejectedValueOnce(new Error('owner unavailable'))
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValue({ status: 'cancelled', task: threadSnapshot('task-1') });
    try {
      await store.cancelAndDrainForOwner(userId);

      /** An unconfirmed delivery is retried under the same invocation — including a
       * `not_found`, which means the owner's registration is missing while its lease
       * is live — and once the owner confirms, the drain only waits for the lease. */
      expect(controlTask).toHaveBeenCalledTimes(3);
      expect(new Set(controlTask.mock.calls.map((call) => call[3])).size).toBe(1);
      expect(listLeases).toHaveBeenCalledTimes(5);
    } finally {
      listLeases.mockRestore();
      controlTask.mockRestore();
    }
  });

  it('fences owner admission around the deletion it drains for', async () => {
    const userId = 'fenced-user';
    const order: string[] = [];
    const tokens: string[] = [];
    const renewed: string[] = [];
    const released: string[] = [];
    const store = new SubagentThreadTaskStore(methods, {
      ownerDrainPollMs: 1,
      fenceOwnerAdmission: async (_userId: string, token: string) => {
        tokens.push(token);
        order.push('fence');
      },
      renewOwnerAdmission: async (_userId: string, token: string) => {
        renewed.push(token);
        return true;
      },
      releaseOwnerAdmission: async (_userId: string, token: string) => {
        released.push(token);
        order.push('release');
      },
    });
    const listLeases = jest
      .spyOn(methods, 'listActiveSubagentThreadLeases')
      .mockImplementation(async () => {
        order.push('drain');
        return [];
      });
    try {
      await expect(
        store.withOwnerDeletionFence(userId, undefined, async () => {
          order.push('delete');
          return 'deleted';
        }),
      ).resolves.toBe('deleted');
      expect(order).toEqual(['fence', 'drain', 'delete', 'release']);
      /** Only the fence this deletion took is lifted, so an overlapping deletion
       * keeps admission closed until its own fence is released. */
      expect(released).toEqual(tokens);
      expect(tokens[0]).toEqual(expect.any(String));

      /** A failed deletion still lifts the fence, so one bad request cannot leave the
       * account unable to run subagents. */
      order.length = 0;
      await expect(
        store.withOwnerDeletionFence(userId, undefined, async () => {
          throw new Error('deletion failed');
        }),
      ).rejects.toThrow('deletion failed');
      expect(order).toEqual(['fence', 'drain', 'release']);
    } finally {
      listLeases.mockRestore();
    }
  });

  it('routes conversation-deletion cancellation to a remote task owner', async () => {
    const userId = 'routed-delete-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods);
    const deletingStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await deletingStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async (runtime) =>
          new Promise((_resolve, reject) => {
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    await Promise.resolve();

    const plan = await deletingStore.planCancellationForConversations(userId, [
      parentConversationId,
    ]);
    await expect(deletingStore.cancelPlan(plan)).resolves.toBe(1);
    await waitForSettled(ownerStore, config.scopeId, started);
    expect(ownerStore.get(config.scopeId, taskId)).toMatchObject({ status: 'cancelled' });

    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      deletingStore.destroyTaskControlTransport(),
    ]);
  });

  it('routes cancellation for a deleted child thread to its remote owner', async () => {
    const userId = 'routed-child-delete-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new ReceiptTestSubagentThreadTaskStore(methods, {
      controlReceiptRetryMs: 60_000,
      shutdownControlReceiptBackoffMs: 1,
    });
    const deletingStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await deletingStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async (runtime) =>
          new Promise((_resolve, reject) => {
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    const threadId = requireThreadId(started);
    await waitUntil(
      async () =>
        (
          await methods.getMessages(
            { user: userId, conversationId: threadId, messageId: `${taskId}:user` },
            '+subagentTask',
          )
        ).length === 1,
      'the durable task input',
    );
    expect(await methods.getConvo(userId, threadId)).not.toBeNull();

    const accepted = await ownerStore.controlTask(
      config.scopeId,
      taskId,
      { action: 'queue', message: 'Persist this before the child is deleted.' },
      'remote-deleted-receipt',
    );
    const controlId = accepted.status === 'accepted' ? accepted.controlId : undefined;
    expect(controlId).toBeDefined();
    const persistence = jest
      .spyOn(methods, 'recordSubagentTaskControlReceipt')
      .mockRejectedValue(new Error('receipt target deleted'));
    ownerStore.emitControlReceiptForTest(config.scopeId, taskId, {
      controlId: controlId as string,
      action: 'queue',
      status: 'applied',
      createdAt: Date.now() - 1,
      updatedAt: Date.now(),
      boundary: 'turn',
    });
    await waitUntil(() => persistence.mock.calls.length > 0, 'the remote receipt write to fail');

    /** The parent survives this deletion, so the child's own thread is the only target. */
    const plan = await deletingStore.planCancellationForConversations(userId, [threadId]);
    await methods.deleteConvos(userId, { conversationId: threadId });
    await expect(deletingStore.cancelPlan(plan, [threadId])).resolves.toBe(1);
    await waitForSettled(ownerStore, config.scopeId, started);
    expect(ownerStore.get(config.scopeId, taskId)).toMatchObject({ status: 'cancelled' });
    persistence.mockRestore();

    await expect(ownerStore.destroyTaskControlTransport()).resolves.toBeUndefined();
    await deletingStore.destroyTaskControlTransport();
  });

  it('cancels a child admitted after the deletion snapshot from its durable lease', async () => {
    const userId = 'lease-cancel-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods);
    const deletingStore = new SubagentThreadTaskStore(methods);
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await deletingStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async (runtime) =>
          new Promise((_resolve, reject) => {
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          }),
      }),
    );
    const taskId = requireAccepted(started).task.taskId;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const leases = await methods.listActiveSubagentThreadLeases({
        user: userId,
        now: new Date(),
      });
      if (leases.length > 0) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    /** Production ordering: the plan is resolved first, the cascade is deleted, and
     * only then is the plan replayed against the owner directory. */
    const plan = await deletingStore.planCancellationForConversations(userId, [
      parentConversationId,
    ]);
    await methods.deleteConvos(userId, { conversationId: parentConversationId });
    await expect(
      deletingStore.cancelPlan(plan, [parentConversationId, requireThreadId(started)]),
    ).resolves.toBeGreaterThanOrEqual(1);
    await waitForSettled(ownerStore, config.scopeId, started);
    expect(ownerStore.get(config.scopeId, taskId)).toMatchObject({ status: 'cancelled' });

    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      deletingStore.destroyTaskControlTransport(),
    ]);
  });

  it('drains only active lease addresses when deleting every conversation across replicas', async () => {
    const userId = 'routed-owner-drain-user';
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId);
    const hub = new TestTaskRoutingHub();
    const ownerStore = new SubagentThreadTaskStore(methods, { ownerDrainPollMs: 5 });
    const deletingStore = new SubagentThreadTaskStore(methods, { ownerDrainPollMs: 5 });
    await ownerStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    await deletingStore.configureTaskControlTransport(new TestTaskControlTransport(hub));
    const config = buildSubagentThreadTaskConfig(ownerStore, { userId, parentConversationId });
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const started = ownerStore.start(
      taskRequest(config.scopeId, {
        run: async (runtime) => {
          markEntered();
          return new Promise((_resolve, reject) => {
            runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
              once: true,
            });
          });
        },
      }),
    );
    await entered;

    await deletingStore.cancelAndDrainForOwner(userId);
    await waitForSettled(ownerStore, config.scopeId, started);
    expect(ownerStore.get(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'cancelled',
    });

    await Promise.all([
      ownerStore.destroyTaskControlTransport(),
      deletingStore.destroyTaskControlTransport(),
    ]);
  });

  it('delegates an owner drain for host work that is not in the task store', async () => {
    const userId = 'host-generation-drain-user';
    const parentConversationId = randomUUID();
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const token = randomUUID();
    await saveParent(userId, parentConversationId);
    await methods.saveConvo(
      { userId },
      {
        conversationId,
        endpoint: EModelEndpoint.agents,
        title: 'Event actor',
        agent_id: 'child-agent',
        subagentThread: {
          rootConversationId: parentConversationId,
          parentConversationId,
          parentMessageId: 'parent-message',
          parentToolCallId: 'event-binding',
          parentAgentId: 'parent-agent',
          subagentType: 'child-agent',
          subagentKind: 'agent',
          depth: 1,
        },
      },
    );
    await methods.acquireSubagentThreadLease({
      user: userId,
      conversationId,
      taskId,
      token,
      now: new Date(),
      expiresAt: new Date(Date.now() + 30_000),
    });
    const cancelUnroutedTask = jest.fn(async () => {
      await methods.releaseSubagentThreadLease({ user: userId, conversationId, token });
      return true;
    });
    const deletingStore = new SubagentThreadTaskStore(methods, {
      cancelUnroutedTask,
      ownerDrainPollMs: 1,
    });

    await deletingStore.cancelAndDrainForOwner(userId);

    expect(cancelUnroutedTask).toHaveBeenCalledWith({
      userId,
      parentConversationId,
      taskId,
      tenantId: undefined,
    });
    expect(await methods.countActiveSubagentThreadLeases({ user: userId, now: new Date() })).toBe(
      0,
    );
  });

  it('bounds durable delegation depth to one by default', async () => {
    const userId = 'depth-user';
    const rootConversationId = randomUUID();
    const parentConversationId = randomUUID();
    await saveParent(userId, parentConversationId, {
      subagentThread: {
        rootConversationId,
        parentConversationId: rootConversationId,
        parentMessageId: randomUUID(),
        parentToolCallId: randomUUID(),
        parentAgentId: 'root-agent',
        subagentType: 'researcher-agent',
        subagentKind: 'agent',
        depth: 1,
      },
    });
    const store = new SubagentThreadTaskStore(methods);
    const config = buildSubagentThreadTaskConfig(store, { userId, parentConversationId });
    const run = jest.fn(taskRequest(config.scopeId).run);

    expect(store.canCreateChildThread(0)).toBe(true);
    expect(store.canCreateChildThread(1)).toBe(false);
    const started = store.start(taskRequest(config.scopeId, { run }));
    await waitForSettled(store, config.scopeId, started);

    expect(run).not.toHaveBeenCalled();
    expect(store.claim(config.scopeId, requireAccepted(started).task.taskId)).toMatchObject({
      status: 'error',
    });
    expect(await methods.getConvo(userId, requireThreadId(started))).toBeNull();
  });
});
