import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
  createMethods,
  createModels,
} from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import type { AgentTriggerDeliveryPersistence, AgentTriggerService } from './triggers/service';
import type { AgentTriggerFetch } from './triggers/host';
import {
  BACKGROUND_TOOL_COMPLETION_SOURCE,
  createBackgroundToolCompletionWakeupResolver,
} from './backgroundCompletionWakeup';
import { createAgentTriggerEnvelope, getAgentTriggerIdempotencyKey } from './triggers/envelope';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { AGENT_QUEUED_TURN_SOURCE, createAgentQueuedTurnLifecycle } from './queuedTurns';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createAgentContinuationResolver } from './triggers/continuation';
import { __resetShutdownStateForTests } from '../app/shutdown';
import { createAgentTriggerService } from './triggers/service';

const DB_SETUP_TIMEOUT_MS = 60_000;
const TENANT_ID = 'tenant-1';
const AGENT_ID = 'agent_parent';
const RUN_RESPONSE_ID = 'run-response';

/** Below the five-second readiness re-check a deferred delivery otherwise waits out. */
const PROMPT_ADMISSION_MS = 2_500;

interface Dispatch {
  kind: 'queued-turn' | 'wake-up';
  parentMessageId: string;
  responseMessageId: string;
  generationCreatedAt: number;
  dispatchedAt: number;
}

let mongod: MongoMemoryServer;
let methods: AllMethods;
let userId: string;
let conversationId: string;
let manager: GenerationJobManagerClass;
let service: AgentTriggerService | undefined;
let dispatches: Dispatch[];

async function waitUntil<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function deliveryOf(source: string) {
  return mongoose.models.AgentTriggerDelivery.findOne({
    'envelope.event.source.id': source,
  }).lean<{ attempts: number; availableAt: Date; status: string }>();
}

/** Readiness deferrals push `availableAt` at least five seconds out. */
function waitForDeferral(source: string) {
  return waitUntil(async () => {
    const delivery = await deliveryOf(source);
    return delivery != null && delivery.availableAt.getTime() > Date.now() + 2_000
      ? delivery
      : undefined;
  }, `${source} to defer`);
}

/** Stands in for the agents controller: refuses to replace an active
 * generation, otherwise starts one and persists its user and response rows. */
const controller: AgentTriggerFetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as {
    text: string;
    parentMessageId: string;
    clientRequestId: string;
    agentContinuationAdmission?: unknown;
  };
  let createdAt: number;
  try {
    ({ createdAt } = await manager.createJob(conversationId, userId, conversationId, {
      rejectActivePredecessor: true,
    }));
  } catch (error) {
    if ((error as { code?: string }).code !== 'GENERATION_PREDECESSOR_MISMATCH') {
      throw error;
    }
    return new Response(JSON.stringify({ code: 'PARENT_NOT_READY' }), {
      status: 409,
      headers: { 'retry-after': '1' },
    });
  }
  const userMessageId = `${body.clientRequestId}:user`;
  const responseMessageId = `${body.clientRequestId}:assistant`;
  await mongoose.models.Message.create([
    {
      messageId: userMessageId,
      conversationId,
      user: userId,
      tenantId: TENANT_ID,
      parentMessageId: body.parentMessageId,
      isCreatedByUser: true,
      text: body.text,
      endpoint: 'agents',
    },
    {
      messageId: responseMessageId,
      conversationId,
      user: userId,
      tenantId: TENANT_ID,
      parentMessageId: userMessageId,
      isCreatedByUser: false,
      endpoint: 'agents',
      content: [],
    },
  ]);
  dispatches.push({
    kind: body.agentContinuationAdmission != null ? 'queued-turn' : 'wake-up',
    parentMessageId: body.parentMessageId,
    responseMessageId,
    generationCreatedAt: createdAt,
    dispatchedAt: Date.now(),
  });
  return new Response(
    JSON.stringify({
      status: 'started',
      streamId: conversationId,
      conversationId,
      generationCreatedAt: createdAt,
    }),
    { status: 200 },
  );
};

async function startDelivery(): Promise<{
  service: AgentTriggerService;
  lifecycle: ReturnType<typeof createAgentQueuedTurnLifecycle>;
}> {
  const getGenerationJob = async (id: string) => (await manager.getJob(id)) ?? null;
  const getGenerationAdmissionEvidence = (
    ...args: Parameters<GenerationJobManagerClass['getGenerationAdmissionEvidence']>
  ) => manager.getGenerationAdmissionEvidence(...args);
  const lifecycle = createAgentQueuedTurnLifecycle({
    methods,
    getGenerationJob,
    getGenerationAdmissionEvidence,
    enqueue: (envelope, options) => triggers.enqueue(envelope, options),
  });
  const triggers = createAgentTriggerService({
    methods: methods as AllMethods & AgentTriggerDeliveryPersistence,
    fetch: controller,
    mintToken: () => 'trigger-token',
    subscribeGenerationSettled: (listener) => manager.onGenerationSettled(listener),
    settleSourceBeforeDeadLetter: lifecycle.settleBeforeDeadLetter,
    prepareContinue: createAgentContinuationResolver({
      eventActor: async () => undefined,
      internalSources: new Map([
        [
          BACKGROUND_TOOL_COMPLETION_SOURCE,
          createBackgroundToolCompletionWakeupResolver({
            methods,
            getGenerationJob,
            getGenerationAdmissionEvidence,
          }),
        ],
        [AGENT_QUEUED_TURN_SOURCE, lifecycle.prepareContinue],
      ]),
    }),
    deliveryOptions: { concurrency: 4, tickMs: 20, maxIdleTickMs: 50 },
  });
  await triggers.initialize({ address: { address: '127.0.0.1', family: 'IPv4', port: 3080 } });
  service = triggers;
  return { service: triggers, lifecycle };
}

async function enqueueWakeup(triggers: AgentTriggerService): Promise<string> {
  const taskId = 'background-task';
  const envelope = createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: taskId,
    deliveryId: taskId,
    receivedAt: Date.now(),
    principal: { id: userId, tenantId: TENANT_ID },
    event: {
      id: taskId,
      type: 'background-tool.completion',
      occurredAt: Date.now(),
      source: { id: BACKGROUND_TOOL_COMPLETION_SOURCE, type: 'internal' },
      payload: { taskId, toolCallId: taskId, toolName: 'tool' },
    },
    target: { conversationId, parentMessageId: RUN_RESPONSE_ID, agentId: AGENT_ID },
    input: 'waiting',
  });
  const { deliveryKey } = await triggers.enqueue(envelope, {
    orderingKey: taskId,
    requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
  });
  expect(deliveryKey).toBe(getAgentTriggerIdempotencyKey(envelope));
  await triggers.persistBackgroundToolResult({
    deliveryKey,
    sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
    result: { status: 'completed', output: 'tool output', settledAt: new Date() },
  });
  return deliveryKey;
}

async function enqueueQueuedTurn(
  lifecycle: ReturnType<typeof createAgentQueuedTurnLifecycle>,
  predecessorCreatedAt: number,
) {
  const { turn } = await methods.enqueueAgentQueuedTurn({
    user: new mongoose.Types.ObjectId(userId),
    tenantId: TENANT_ID,
    conversationId,
    agentId: AGENT_ID,
    parentMessageId: RUN_RESPONSE_ID,
    clientRequestId: 'queued-follow-up',
    text: 'follow-up queued while the run was busy',
    expectedPredecessorCreatedAt: predecessorCreatedAt,
  });
  await lifecycle.schedule(turn);
  return turn;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createMethods(mongoose);
  await mongoose.connect(mongod.getUri());
  await methods.ensureAgentQueuedTurnIndexes();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  __resetShutdownStateForTests();
  await Promise.all(
    [
      'AgentTriggerDelivery',
      'AgentTriggerLaneSequence',
      'AgentQueuedTurn',
      'AgentQueuedTurnSequence',
      'Conversation',
      'Message',
    ].map((name) => mongoose.models[name].deleteMany({})),
  );
  dispatches = [];
  userId = new mongoose.Types.ObjectId().toString();
  conversationId = `conversation-${userId}`;
  manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 0 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  manager.initialize();
  await mongoose.models.Conversation.create({
    conversationId,
    user: userId,
    tenantId: TENANT_ID,
    endpoint: 'agents',
    agent_id: AGENT_ID,
  });
  await mongoose.models.Message.create({
    messageId: RUN_RESPONSE_ID,
    conversationId,
    user: userId,
    tenantId: TENANT_ID,
    parentMessageId: 'run-request',
    isCreatedByUser: false,
    endpoint: 'agents',
    content: [],
  });
});

afterEach(async () => {
  await service?.stop();
  service = undefined;
  await manager.destroy();
  __resetShutdownStateForTests();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
}, DB_SETUP_TIMEOUT_MS);

describe('completion wake-ups and queued user turns at run end', () => {
  it('admits the queued turn first, then runs the wake-up chained to its response', async () => {
    const run = await manager.createJob(conversationId, userId, conversationId);
    const { service: triggers, lifecycle } = await startDelivery();
    const wakeupKey = await enqueueWakeup(triggers);
    const queued = await enqueueQueuedTurn(lifecycle, run.createdAt);
    await waitForDeferral(BACKGROUND_TOOL_COMPLETION_SOURCE);
    await waitForDeferral(AGENT_QUEUED_TURN_SOURCE);
    expect(dispatches).toEqual([]);

    const runEndedAt = Date.now();
    await manager.completeJob(conversationId, undefined, run.createdAt);

    const [userTurn] = await waitUntil(
      async () => (dispatches.length > 0 ? dispatches : undefined),
      'the first admission after the run ended',
    );
    expect(userTurn).toMatchObject({ kind: 'queued-turn', parentMessageId: RUN_RESPONSE_ID });
    expect(userTurn.dispatchedAt - runEndedAt).toBeLessThan(PROMPT_ADMISSION_MS);
    await waitUntil(async () => {
      const row = await mongoose.models.AgentQueuedTurn.findById(queued.queuedTurnId).lean<{
        status: string;
      }>();
      return row?.status === 'admitted' ? row : undefined;
    }, 'the queued turn admission receipt');
    const yielded = await waitForDeferral(BACKGROUND_TOOL_COMPLETION_SOURCE);
    expect(yielded.attempts).toBe(0);
    expect(dispatches).toHaveLength(1);

    await manager.completeJob(conversationId, undefined, userTurn.generationCreatedAt);

    const [, wakeup] = await waitUntil(
      async () => (dispatches.length > 1 ? dispatches : undefined),
      'the wake-up after the queued turn',
    );
    expect(wakeup).toMatchObject({
      kind: 'wake-up',
      parentMessageId: userTurn.responseMessageId,
    });
    await expect(
      mongoose.models.AgentTriggerDelivery.findOne({ deliveryKey: wakeupKey }).lean(),
    ).resolves.toMatchObject({ attempts: 1 });
  });

  it('runs the wake-up at run end when no queued turn is pending', async () => {
    const run = await manager.createJob(conversationId, userId, conversationId);
    const { service: triggers } = await startDelivery();
    await enqueueWakeup(triggers);
    await waitForDeferral(BACKGROUND_TOOL_COMPLETION_SOURCE);

    await manager.completeJob(conversationId, undefined, run.createdAt);

    const [wakeup] = await waitUntil(
      async () => (dispatches.length > 0 ? dispatches : undefined),
      'the wake-up after the run ended',
    );
    expect(wakeup).toMatchObject({ kind: 'wake-up', parentMessageId: RUN_RESPONSE_ID });
  });

  it('does not hold a wake-up behind a queued turn whose claim owner died', async () => {
    const run = await manager.createJob(conversationId, userId, conversationId);
    const { service: triggers } = await startDelivery();
    const { turn } = await methods.enqueueAgentQueuedTurn({
      user: new mongoose.Types.ObjectId(userId),
      tenantId: TENANT_ID,
      conversationId,
      agentId: AGENT_ID,
      parentMessageId: RUN_RESPONSE_ID,
      clientRequestId: 'abandoned-follow-up',
      text: 'follow-up whose worker disappeared',
      availableAt: new Date(Date.now() - 10 * 60_000),
    });
    const claimedAt = new Date(Date.now() - 5 * 60_000);
    await expect(
      methods.claimNextAgentQueuedTurn({
        user: new mongoose.Types.ObjectId(userId),
        tenantId: TENANT_ID,
        conversationId,
        queuedTurnId: turn.queuedTurnId,
        claimId: 'lost-claim',
        claimBy: 'lost-worker',
        now: claimedAt,
        leaseUntil: new Date(claimedAt.getTime() + 2 * 60_000),
      }),
    ).resolves.toMatchObject({ outcome: 'acquired' });
    await enqueueWakeup(triggers);
    await waitForDeferral(BACKGROUND_TOOL_COMPLETION_SOURCE);

    await manager.completeJob(conversationId, undefined, run.createdAt);

    const [wakeup] = await waitUntil(
      async () => (dispatches.length > 0 ? dispatches : undefined),
      'the wake-up past an expired queued-turn claim',
    );
    expect(wakeup).toMatchObject({ kind: 'wake-up', parentMessageId: RUN_RESPONSE_ID });
  });
});
