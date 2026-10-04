import IoRedis from 'ioredis';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import type {
  SubagentTaskRuntime,
  SubagentTaskStartRequest,
  SubagentTaskStartResult,
} from '@librechat/agents';
import type { AllMethods } from '@librechat/data-schemas';
import type { AgentTriggerDeliveryPersistence, AgentTriggerService } from './triggers/service';
import type { SubagentTaskWakeupRegistration } from './subagentThreads';
import type { AgentTriggerFetch } from './triggers/host';
import {
  createSubagentCompletionWakeupHandler,
  createSubagentCompletionWakeupResolver,
} from './subagentCompletionWakeup';
import {
  RedisSubagentTaskControlTransport,
  SubagentTaskOwnerUnavailableError,
} from './subagentTaskRouting';
import { buildSubagentThreadTaskConfig, SubagentThreadTaskStore } from './subagentThreads';
import { __resetShutdownStateForTests } from '../app/shutdown';
import { createAgentTriggerService } from './triggers/service';
import { SubagentActivityStream } from './subagentActivity';
import { RedisEventTransport } from '~/stream';

const DB_SETUP_TIMEOUT_MS = 60_000;
const REDIS_URI = process.env.REDIS_URI;
const describeWithRedis = REDIS_URI == null ? describe.skip : describe;

let mongod: MongoMemoryServer;
let methods: AllMethods;
let triggerService: AgentTriggerService | undefined;
const redisClients: IoRedis[] = [];
const taskStores: SubagentThreadTaskStore[] = [];

function accepted(
  started: SubagentTaskStartResult,
): Extract<SubagentTaskStartResult, { accepted: true }> {
  if (!started.accepted) {
    throw new Error('Expected the child task to be accepted.');
  }
  return started;
}

async function waitUntil<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the cross-replica integration condition.');
}

function redisClient(): IoRedis {
  const client = new IoRedis(REDIS_URI!, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redisClients.push(client);
  return client;
}

async function connectedRedisClient(): Promise<IoRedis> {
  const client = redisClient();
  await client.connect();
  return client;
}

async function createRoutingTransport(instanceId: string, namespace: string) {
  const [publisher, subscriber] = await Promise.all([
    connectedRedisClient(),
    connectedRedisClient(),
  ]);
  return new RedisSubagentTaskControlTransport(publisher, subscriber, {
    instanceId,
    namespace,
    registrationHeartbeatMs: 1_000,
    requestTimeoutMs: 1_000,
    retryDelayMs: 25,
  });
}

async function createActivityStream(): Promise<SubagentActivityStream> {
  const [publisher, subscriber] = await Promise.all([
    connectedRedisClient(),
    connectedRedisClient(),
  ]);
  return new SubagentActivityStream(new RedisEventTransport(publisher, subscriber));
}

function taskRequest(
  scopeId: string,
  input: string,
  subagentType: string,
  run: SubagentTaskStartRequest['run'],
): SubagentTaskStartRequest {
  return {
    scopeId,
    idempotencyKey: randomUUID(),
    parentRunId: 'parent-response',
    parentAgentId: 'agent_parent',
    parentToolCallId: randomUUID(),
    input,
    subagentKind: 'agent',
    subagentType,
    run,
  };
}

async function saveParent(userId: string, tenantId: string, conversationId: string): Promise<void> {
  await tenantStorage.run({ tenantId, userId }, async () => {
    await methods.saveConvo(
      { userId },
      {
        conversationId,
        tenantId,
        endpoint: EModelEndpoint.agents,
        title: 'Cross-replica parent',
        agent_id: 'agent_parent',
      },
    );
    await methods.saveMessage(
      { userId },
      {
        messageId: 'parent-response',
        conversationId,
        parentMessageId: String(Constants.NO_PARENT),
        sender: 'Director',
        text: 'I dispatched two child tasks.',
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: false,
      },
    );
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.connect(mongod.getUri(), { autoIndex: false });
}, DB_SETUP_TIMEOUT_MS);

afterEach(async () => {
  await triggerService?.stop();
  triggerService = undefined;
  __resetShutdownStateForTests();
  await Promise.all(
    taskStores.splice(0).map(async (store) => {
      await store.destroyTaskControlTransport().catch(() => undefined);
      store.destroyActivityStream();
    }),
  );
  await Promise.all(redisClients.splice(0).map((client) => client.quit().catch(() => undefined)));
  await mongoose.connection.db?.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
}, DB_SETUP_TIMEOUT_MS);

describeWithRedis('subagent cross-replica orchestration', () => {
  it('routes controls to the execution owner and delivers two sibling wakeups once after owner loss', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const tenantId = 'tenant-cross-replica';
    const parentConversationId = randomUUID();
    await saveParent(userId, tenantId, parentConversationId);

    const continuationEffects = new Map<string, { input: string; parentMessageId: string }>();
    let dropFirstReceipt = true;
    const fetcher = jest.fn<ReturnType<AgentTriggerFetch>, Parameters<AgentTriggerFetch>>(
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          text: string;
          parentMessageId: string;
          conversationId: string;
          clientRequestId: string;
        };
        if (!continuationEffects.has(body.clientRequestId)) {
          const userMessageId = `${body.clientRequestId}:user`;
          const assistantMessageId = `${body.clientRequestId}:assistant`;
          await tenantStorage.run({ tenantId, userId }, async () => {
            await methods.saveMessage(
              { userId },
              {
                messageId: userMessageId,
                conversationId: body.conversationId,
                parentMessageId: body.parentMessageId,
                sender: 'User',
                text: body.text,
                endpoint: EModelEndpoint.agents,
                isCreatedByUser: true,
              },
            );
            await methods.saveMessage(
              { userId },
              {
                messageId: assistantMessageId,
                conversationId: body.conversationId,
                parentMessageId: userMessageId,
                sender: 'Director',
                text: 'Accepted the child result.',
                endpoint: EModelEndpoint.agents,
                isCreatedByUser: false,
              },
            );
          });
          continuationEffects.set(body.clientRequestId, {
            input: body.text,
            parentMessageId: body.parentMessageId,
          });
          /** The parent continuation committed, but its HTTP receipt was lost. The
           * durable delivery must retry with the same client request identity. */
          if (dropFirstReceipt) {
            dropFirstReceipt = false;
            throw new Error('response lost after admission');
          }
        }
        return new Response(
          JSON.stringify({
            status: 'started',
            streamId: body.conversationId,
            conversationId: body.conversationId,
            generationCreatedAt: Date.now(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );

    const resolver = createSubagentCompletionWakeupResolver({
      methods,
      getGenerationJob: async () => null,
    });
    triggerService = createAgentTriggerService({
      methods: methods as AllMethods & AgentTriggerDeliveryPersistence,
      fetch: fetcher,
      mintToken: () => 'trigger-token',
      prepareContinue: resolver,
      deliveryOptions: { concurrency: 2, tickMs: 1_000, retryBaseMs: 5, retryCapMs: 20 },
    });
    await triggerService.initialize({
      address: { address: '127.0.0.1', family: 'IPv4', port: 3080 },
    });

    const receipts: Array<{ deliveryKey: string; replayed: boolean }> = [];
    const registrations: SubagentTaskWakeupRegistration[] = [];
    const wakeup = createSubagentCompletionWakeupHandler(async (envelope, options) => {
      const receipt = await triggerService!.enqueue(envelope, options);
      receipts.push(receipt);
      return receipt;
    });
    const ownerStore = new SubagentThreadTaskStore(methods, {
      onTaskPrepared: async (registration) => {
        registrations.push(registration);
        /** A crash-retried preparation can invoke the producer again; enqueueing the
         * same task identity must retain one durable delivery. */
        await wakeup(registration);
        await wakeup(registration);
      },
    });
    const requesterStore = new SubagentThreadTaskStore(methods);
    taskStores.push(ownerStore, requesterStore);
    const namespace = `subagent-integration-${randomUUID()}`;
    await ownerStore.configureTaskControlTransport(
      await createRoutingTransport('execution-owner', namespace),
    );
    await requesterStore.configureTaskControlTransport(
      await createRoutingTransport('delivery-owner', namespace),
    );
    ownerStore.configureActivityStream(await createActivityStream());
    requesterStore.configureActivityStream(await createActivityStream());
    const config = buildSubagentThreadTaskConfig(
      ownerStore,
      { userId, tenantId, parentConversationId },
      { completionWakeups: true },
    );

    const releases: Array<() => void> = [];
    const entered: Promise<void>[] = [];
    const childRun = (result: string) => {
      let markEntered = (): void => undefined;
      entered.push(new Promise<void>((resolve) => (markEntered = resolve)));
      return async (runtime: SubagentTaskRuntime) => {
        markEntered();
        return new Promise<{ content: string }>((resolve) =>
          releases.push(() => {
            runtime.reportProgress({
              runId: 'root-run',
              parentRunId: 'parent-run',
              subagentRunId: runtime.taskId,
              subagentType: 'worker',
              subagentKind: 'agent',
              subagentAgentId: 'agent-worker',
              parentToolCallId: 'tool-call',
              depth: 1,
              ancestry: [],
              phase: 'message_delta',
              data: { delta: { content: [{ type: 'text', text: result }] } },
              timestamp: new Date().toISOString(),
            });
            resolve({ content: result });
          }),
        );
      };
    };
    const first = config.store.start(
      taskRequest(
        config.scopeId,
        'first child task',
        'researcher',
        childRun('First durable result.'),
      ),
    );
    const second = config.store.start(
      taskRequest(
        config.scopeId,
        'second child task',
        'reviewer',
        childRun('Second durable result.'),
      ),
    );
    await Promise.all(entered);

    const firstTaskId = accepted(first).task.taskId;
    const secondTaskId = accepted(second).task.taskId;
    const remoteActivity: unknown[] = [];
    let resolveRemoteDone!: (status: string) => void;
    const remoteDone = new Promise<string>((resolve) => {
      resolveRemoteDone = resolve;
    });
    const remoteSubscription = requesterStore.subscribeActivity(
      accepted(first).task.threadId!,
      firstTaskId,
      {
        onEvent: (event) =>
          remoteActivity.push(
            ...(event.event === 'subagent_activity_replay' ? event.data : [event]),
          ),
        onDone: (event) => resolveRemoteDone(event.status),
      },
    );
    await remoteSubscription.ready;
    await expect(requesterStore.listTasks(config.scopeId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: firstTaskId, status: 'running' }),
        expect.objectContaining({ taskId: secondTaskId, status: 'running' }),
      ]),
    );
    await expect(
      requesterStore.controlTask(
        config.scopeId,
        firstTaskId,
        { action: 'queue', message: 'Include the primary source.' },
        'cross-replica-steer',
      ),
    ).resolves.toMatchObject({ status: 'accepted' });

    releases.forEach((release) => release());
    await expect(remoteDone).resolves.toBe('completed');
    expect(remoteActivity).toEqual([
      expect.objectContaining({
        event: 'on_subagent_update',
        data: expect.objectContaining({ subagentRunId: firstTaskId }),
      }),
    ]);
    await waitUntil(() => {
      const tasks = [
        ownerStore.get(config.scopeId, firstTaskId),
        ownerStore.get(config.scopeId, secondTaskId),
      ];
      return tasks.every((task) => task?.status === 'completed') ? true : undefined;
    });
    await ownerStore.destroyTaskControlTransport();

    await expect(
      requesterStore.controlTask(
        config.scopeId,
        firstTaskId,
        { action: 'cancel' },
        'owner-gone-control',
      ),
    ).rejects.toBeInstanceOf(SubagentTaskOwnerUnavailableError);

    const uniqueReceipts = new Map(receipts.map((receipt) => [receipt.deliveryKey, receipt]));
    expect(registrations).toHaveLength(2);
    expect(receipts).toHaveLength(4);
    expect(uniqueReceipts.size).toBe(2);
    expect(receipts.filter((receipt) => receipt.replayed)).toHaveLength(2);

    const deliveries = await waitUntil(async () => {
      const deliveries = await Promise.all(
        [...uniqueReceipts.keys()].map((key) => triggerService!.getDelivery(key)),
      );
      const dead = deliveries.find((delivery) => delivery?.status === 'dead');
      if (dead != null) {
        throw new Error(`Wakeup dead-lettered: ${JSON.stringify(dead.lastError)}`);
      }
      return deliveries.every((delivery) => delivery?.status === 'succeeded')
        ? deliveries
        : undefined;
    });

    expect(continuationEffects.size).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(deliveries.map((delivery) => delivery?.attempts).sort()).toEqual([1, 2]);
    expect([...continuationEffects.values()].map(({ input }) => input)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('First durable result.'),
        expect.stringContaining('Second durable result.'),
      ]),
    );
    expect([...continuationEffects.values()].map(({ parentMessageId }) => parentMessageId)).toEqual(
      expect.arrayContaining([
        'parent-response',
        expect.stringMatching(/^trigger_[a-f0-9]{64}:assistant$/),
      ]),
    );
    const parentMessages = await methods.getMessages({
      user: userId,
      conversationId: parentConversationId,
    });
    expect(parentMessages.filter((message) => message.isCreatedByUser)).toHaveLength(2);
    expect(parentMessages.filter((message) => !message.isCreatedByUser)).toHaveLength(3);

    await requesterStore.destroyTaskControlTransport();
  });
});
