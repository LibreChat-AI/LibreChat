import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMethods,
  createModels,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
} from '@librechat/data-schemas';
import type { IMessage } from '@librechat/data-schemas';
import type { AgentTriggerFetch } from './triggers/host';
import {
  createBackgroundToolCompletionWakeupResolver,
  createBackgroundToolDeadClaimRecovery,
  BACKGROUND_TOOL_COMPLETION_SOURCE,
} from './backgroundCompletionWakeup';
import {
  backgroundTaskRegistry,
  runCheckBackgroundTask,
  getBackgroundCodeDelivery,
} from './background';
import { createAgentTriggerEnvelope, getAgentTriggerIdempotencyKey } from './triggers/envelope';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createAgentTriggerExecutionHost } from './triggers/host';
import { prepareAgentTriggerDelivery } from './triggers/delivery';
import { claimBackgroundToolResult } from './backgroundClaims';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
const conversationId = 'receipt-replay';
const parentMessageId = 'receipt-parent';
const agentId = 'agent_parent_1';
const capability = AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all(
    ['AgentTriggerDelivery', 'AgentTriggerLaneSequence', 'Conversation', 'Message'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
  userId = new mongoose.Types.ObjectId().toString();
  await mongoose.models.Conversation.create({
    conversationId,
    user: userId,
    tenantId: 'tenant-1',
    endpoint: 'agents',
    agent_id: agentId,
  });
  await mongoose.models.Message.create({
    messageId: parentMessageId,
    conversationId,
    user: userId,
    tenantId: 'tenant-1',
    parentMessageId: 'user-parent',
    isCreatedByUser: false,
    unfinished: false,
    endpoint: 'agents',
    content: [],
  });
});

async function ready(taskId: string, persistReceipt = true) {
  const envelope = createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: taskId,
    deliveryId: taskId,
    receivedAt: Date.now(),
    principal: { id: userId, tenantId: 'tenant-1' },
    event: {
      id: taskId,
      type: 'background-tool.completion',
      occurredAt: Date.now(),
      source: { id: BACKGROUND_TOOL_COMPLETION_SOURCE, type: 'internal' },
      payload: { taskId, toolCallId: taskId, toolName: 'tool' },
    },
    target: { conversationId, parentMessageId, agentId },
    input: 'waiting',
  });
  const row = prepareAgentTriggerDelivery(envelope, {
    orderingKey: taskId,
    requiredWorkerCapability: capability,
  });
  await methods.enqueueAgentTriggerDelivery(row);
  if (persistReceipt)
    await methods.persistAgentBackgroundToolResult({
      deliveryKey: row.deliveryKey,
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      result: { status: 'completed', output: taskId, settledAt: new Date() },
    });
  return envelope;
}

function owner(deliveryKey: string) {
  return {
    deliveryKey,
    userId,
    sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
    tenantId: 'tenant-1',
    conversationId,
    parentMessageId,
    agentId,
  };
}

it('replays exactly the admitted input after a lost response and a definitely rejected retry', async () => {
  const root = await ready('one');
  const sibling = await ready('two');
  const inputs: string[] = [];
  const consumed: string[] = [];
  let firstInput: string | undefined;
  let calls = 0;
  const fetcher: AgentTriggerFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { text: string };
    inputs.push(body.text);
    if (++calls === 1) {
      firstInput = body.text;
      consumed.push('one', 'two');
      throw Object.assign(new Error('lost admitted response'), { code: 'ECONNRESET' });
    }
    if (calls === 2)
      throw Object.assign(new Error('retry did not connect'), { code: 'ECONNREFUSED' });
    if (body.text !== firstInput) consumed.push('three');
    return new Response(
      JSON.stringify({
        status: 'started',
        streamId: conversationId,
        conversationId,
        generationCreatedAt: 100,
      }),
      { status: 200 },
    );
  };
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  const host = createAgentTriggerExecutionHost({
    prepareContinue: resolve,
    fetch: fetcher,
    mintToken: () => 'test',
    getBaseUrl: () => 'http://localhost',
  });
  const options = { requiredWorkerCapability: capability };
  await expect(host.dispatch(root, options)).rejects.toMatchObject({ certainty: 'ambiguous' });
  const late = await ready('three');
  await expect(host.dispatch(root, options)).rejects.toMatchObject({ certainty: 'definite' });
  await expect(host.dispatch(root, options)).resolves.toMatchObject({ status: 'started' });
  expect(inputs).toEqual([firstInput, firstInput, firstInput]);
  expect(consumed).toEqual(['one', 'two']);
  await expect(host.dispatch(sibling, options)).resolves.toMatchObject({ status: 'settled' });
  const lateEnvelope = late.mode === 'continue' ? late : undefined;
  if (lateEnvelope == null) throw new Error('Expected continuation');
  const prepared = await resolve(lateEnvelope, {
    idempotencyKey: getAgentTriggerIdempotencyKey(late),
    ...options,
  });
  expect(prepared?.status === 'ready' && prepared.input).toContain('three');
});

it('cleans a late predecessor projection without clearing its successor receipt batch', async () => {
  const root = await ready('one');
  const deliveryKey = getAgentTriggerIdempotencyKey(root);
  const scope = owner(deliveryKey);
  const old = await methods.claimAgentBackgroundToolResultBatch({
    ...scope,
    limit: 8,
    maxMetadataChars: 16000,
  });
  if (old.status !== 'acquired') throw new Error('Expected batch');
  expect(
    await methods.releaseAgentBackgroundToolResultClaims({
      ...scope,
      claimId: deliveryKey,
      batchId: old.batchId,
    }),
  ).toBe(true);
  await mongoose.models.Message.updateOne(
    { messageId: parentMessageId, user: userId },
    {
      $set: {
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'one',
              output: 'one',
              backgroundTask: {
                taskId: 'one',
                toolName: 'tool',
                status: 'completed',
                completionWakeup: true,
                completionReceipt: true,
              },
            },
          },
        ],
      },
    },
  );
  // A predecessor's delayed projection CAS lands after its cleanup completed.
  await methods.claimBackgroundToolResults({
    userId,
    conversationId,
    messageId: parentMessageId,
    taskId: 'one',
    kind: 'wakeup',
    claimId: deliveryKey,
    batchId: old.batchId,
    limit: 1,
  });
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  if (root.mode !== 'continue') throw new Error('Expected continuation');
  await expect(
    resolve(root, { idempotencyKey: deliveryKey, requiredWorkerCapability: capability }),
  ).rejects.toMatchObject({ code: 'BACKGROUND_TOOL_CLAIM_RECONCILING' });
  const successor = await methods.getAgentBackgroundToolResultBatch(scope);
  expect(successor?.batchId).not.toBe(old.batchId);
  await expect(
    resolve(root, { idempotencyKey: deliveryKey, requiredWorkerCapability: capability }),
  ).resolves.toMatchObject({ status: 'ready' });
  expect((await methods.getAgentBackgroundToolResultBatch(scope))?.batchId).toBe(
    successor?.batchId,
  );
});

it('confirms a dead owner with native admission proof instead of re-presenting its results', async () => {
  const root = await ready('one');
  const sibling = await ready('two');
  const deliveryKey = getAgentTriggerIdempotencyKey(root);
  const scope = owner(deliveryKey);
  await methods.claimAgentBackgroundToolResultBatch({
    ...scope,
    limit: 8,
    maxMetadataChars: 16000,
  });
  await mongoose.models.AgentTriggerDelivery.updateOne(
    { deliveryKey },
    { $set: { capabilityStatus: 'dead' } },
  );
  const recover = createBackgroundToolDeadClaimRecovery(
    async (key, sourceId, reason, options) =>
      methods.retireAgentTriggerDelivery({
        deliveryKey: key,
        sourceId,
        reason,
        settledAt: new Date(),
        ...options,
      }),
    methods.releaseBackgroundToolResultClaims,
    async () => null,
    async () => 'started',
    methods.releaseAgentBackgroundToolResultClaims,
    methods,
    async () => ({ generationId: conversationId, generationCreatedAt: 100 }),
  );
  expect(
    await recover({ userId, conversationId, messageId: parentMessageId, claimId: deliveryKey }),
  ).toBe(false);
  const follower = await methods.claimAgentBackgroundToolResultBatch({
    ...owner(getAgentTriggerIdempotencyKey(sibling)),
    limit: 8,
    maxMetadataChars: 16000,
  });
  expect(follower).toMatchObject({ status: 'claimed', ownerStatus: 'applied' });
});

async function project(taskId: string) {
  await mongoose.models.Message.updateOne(
    { messageId: parentMessageId, user: userId },
    {
      $push: {
        content: {
          type: 'tool_call',
          tool_call: {
            id: taskId,
            output: `durable-${taskId}`,
            backgroundTask: {
              taskId,
              toolName: 'tool',
              status: 'completed',
              settledAt: new Date(),
              completionWakeup: true,
              completionReceipt: true,
            },
          },
        },
      },
    },
  );
}

it('reconstructs a failed receipt write from the successful terminal message projection', async () => {
  const root = await ready('one', false);
  const deliveryKey = getAgentTriggerIdempotencyKey(root);
  await project('one');
  await mongoose.models.AgentTriggerDelivery.updateOne(
    { deliveryKey },
    { $set: { producerLeaseUntil: new Date(0) } },
  );
  const fetcher: AgentTriggerFetch = async (_url, init) => {
    expect(JSON.parse(String(init?.body)).text).toContain('durable-one');
    return new Response(
      JSON.stringify({
        status: 'started',
        conversationId,
        streamId: conversationId,
        generationCreatedAt: 100,
      }),
      { status: 200 },
    );
  };
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  const host = createAgentTriggerExecutionHost({
    prepareContinue: resolve,
    fetch: fetcher,
    mintToken: () => 'test',
    getBaseUrl: () => 'http://localhost',
  });
  await expect(
    host.dispatch(root, { requiredWorkerCapability: capability }),
  ).resolves.toMatchObject({ status: 'started' });
  expect(
    await methods.getAgentBackgroundToolResult({
      deliveryKey,
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
    }),
  ).toMatchObject({ output: 'durable-one', resultClaim: { appliedAt: expect.any(Date) } });
});

it('does not settle a root when a speculative manual poll and automatic owner mutually yield', async () => {
  const root = await ready('one');
  await ready('two');
  await project('one');
  const key = getAgentTriggerIdempotencyKey(root);
  let entered: () => void = () => undefined;
  let captured: () => void = () => undefined;
  let resume: () => void = () => undefined;
  const automaticEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const snapshotTaken = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const manualMayYield = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let lookups = 0;
  const getter = async (input: Parameters<typeof methods.getAgentBackgroundToolResultClaim>[0]) => {
    if (++lookups === 1) return methods.getAgentBackgroundToolResultClaim(input);
    await automaticEntered;
    const snapshot = await methods.getAgentBackgroundToolResultClaim(input);
    captured();
    await manualMayYield;
    return snapshot;
  };
  const claim = methods.claimBackgroundToolResults.bind(methods);
  const automatic = jest
    .spyOn(methods, 'claimBackgroundToolResults')
    .mockImplementation(async (input) => {
      if (input.kind === 'wakeup' && input.taskId === 'one') {
        entered();
        await snapshotTaken;
      }
      return claim(input);
    });
  const manual = claimBackgroundToolResult(methods, getter, {
    userId,
    conversationId,
    messageId: parentMessageId,
    taskId: 'one',
    kind: 'manual',
    claimId: 'manual-poll',
    generationId: 'manual-generation',
  });
  // Allow the initial manual projection CAS to commit before receipt selection.
  const deadline = Date.now() + 3000;
  while (
    (await mongoose.models.Message.findOne({
      messageId: parentMessageId,
      'content.tool_call.backgroundTask.resultClaim.claimId': 'manual-poll',
    }).lean()) == null
  ) {
    if (Date.now() > deadline) throw new Error('Manual claim did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  if (root.mode !== 'continue') throw new Error('Expected continuation');
  await expect(
    resolve(root, { idempotencyKey: key, requiredWorkerCapability: capability }),
  ).rejects.toMatchObject({ code: 'BACKGROUND_TOOL_CLAIM_RECONCILING', deferWithoutAttempt: true });
  resume();
  expect(await manual).toMatchObject({ status: 'claimed' });
  automatic.mockRestore();
  const retry = await resolve(root, { idempotencyKey: key, requiredWorkerCapability: capability });
  expect(retry?.status === 'ready' && retry.input).toContain('one');
  expect(retry?.status === 'ready' && retry.input).toContain('two');
});

it('settles a root only after a manual poll has completed receipt reconciliation', async () => {
  const root = await ready('one');
  await project('one');
  expect(
    (
      await claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
        userId,
        conversationId,
        messageId: parentMessageId,
        taskId: 'one',
        kind: 'manual',
        claimId: 'manual-poll',
      })
    ).status,
  ).toBe('acquired');
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  if (root.mode !== 'continue') throw new Error('Expected continuation');
  await expect(
    resolve(root, {
      idempotencyKey: getAgentTriggerIdempotencyKey(root),
      requiredWorkerCapability: capability,
    }),
  ).resolves.toEqual({ status: 'settled' });
});

it.each([false, true])(
  'rolls back an unconfirmed manual claim with generation identity %s',
  async (withGeneration) => {
    const root = await ready('one');
    await project('one');
    const confirmation = jest
      .spyOn(mongoose.models.Message, 'updateOne')
      .mockImplementationOnce(() => {
        throw new Error('confirmation unavailable');
      });
    await expect(
      claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
        userId,
        conversationId,
        messageId: parentMessageId,
        taskId: 'one',
        kind: 'manual',
        claimId: 'manual-poll',
        ...(withGeneration && { generationId: 'manual-generation' }),
      }),
    ).rejects.toThrow('confirmation unavailable');
    confirmation.mockRestore();
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods,
      getGenerationJob: async () => null,
    });
    if (root.mode !== 'continue') throw new Error('Expected continuation');
    const prepared = await resolve(root, {
      idempotencyKey: getAgentTriggerIdempotencyKey(root),
      requiredWorkerCapability: capability,
    });
    expect(prepared?.status === 'ready' && prepared.input).toContain('"result":"one"');
  },
);

it('resolves a committed manual confirmation whose write reply was lost', async () => {
  const root = await ready('one');
  await project('one');
  const update = mongoose.models.Message.updateOne.bind(mongoose.models.Message);
  const lostReply = jest
    .spyOn(mongoose.models.Message, 'updateOne')
    .mockImplementationOnce((...args) => {
      const query = update(...args);
      const execute = query.exec.bind(query);
      jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
        await execute();
        throw new Error('lost confirmation reply');
      });
      return query;
    });
  const consumed = await claimBackgroundToolResult(
    methods,
    methods.getAgentBackgroundToolResultClaim,
    {
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'manual',
      claimId: 'manual-poll',
      generationId: 'manual-generation',
    },
  );
  expect(consumed).toMatchObject({ status: 'acquired', results: [{ taskId: 'one' }] });
  lostReply.mockRestore();
  expect(
    await methods.releaseBackgroundToolResultClaims({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskIds: ['one'],
      kind: 'manual',
      claimId: 'manual-poll',
      onlyIfUnreconciled: true,
    }),
  ).toBe(false);
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  if (root.mode !== 'continue') throw new Error('Expected continuation');
  await expect(
    resolve(root, {
      idempotencyKey: getAgentTriggerIdempotencyKey(root),
      requiredWorkerCapability: capability,
    }),
  ).resolves.toEqual({ status: 'settled' });
});

it('recovers abandoned manual ownership after both confirmation and rollback failed', async () => {
  const root = await ready('one');
  await ready('two');
  await project('one');
  const confirmation = jest
    .spyOn(methods, 'confirmBackgroundToolResultClaim')
    .mockRejectedValueOnce(new Error('confirmation unavailable'));
  const rollback = jest
    .spyOn(methods, 'releaseBackgroundToolResultClaims')
    .mockRejectedValueOnce(new Error('rollback unavailable'));
  await expect(
    claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'manual',
      claimId: 'manual-poll',
      generationId: 'manual-generation',
    }),
  ).rejects.toThrow('rollback unavailable');
  confirmation.mockRestore();
  rollback.mockRestore();
  let active = true;
  const getGenerationJob = async () =>
    active ? { status: 'running', metadata: { responseMessageId: 'manual-generation' } } : null;
  const recover = createBackgroundToolDeadClaimRecovery(
    async () => false,
    methods.releaseBackgroundToolResultClaims,
    getGenerationJob,
    async () => 'unavailable',
  );
  const recoverDeadClaim = jest.fn(recover);
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob,
    recoverDeadClaim,
  });
  if (root.mode !== 'continue') throw new Error('Expected continuation');
  const key = getAgentTriggerIdempotencyKey(root);
  await mongoose.models.AgentTriggerDelivery.updateOne(
    { deliveryKey: key },
    { $set: { capabilityClaimToken: 'exact-queue-lease' } },
  );
  const context = {
    idempotencyKey: key,
    requiredWorkerCapability: capability,
    deliveryClaimToken: 'exact-queue-lease',
  };
  await expect(resolve(root, context)).rejects.toMatchObject({ code: 'PARENT_NOT_READY' });
  expect(recoverDeadClaim).not.toHaveBeenCalled();
  active = false;
  await expect(resolve(root, context)).rejects.toMatchObject({
    code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
    deferWithoutAttempt: true,
  });
  expect(recoverDeadClaim).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'manual',
      claimId: 'manual-poll',
      generationId: 'manual-generation',
    }),
  );
  const prepared = await resolve(root, context);
  expect(prepared?.status === 'ready' && prepared.input).toContain('one');
  expect(prepared?.status === 'ready' && prepared.input).toContain('two');
});

it('does not use a different manual owner as confirmation read-back proof', async () => {
  await ready('one');
  await project('one');
  const update = mongoose.models.Message.updateOne.bind(mongoose.models.Message);
  const replaced = jest
    .spyOn(mongoose.models.Message, 'updateOne')
    .mockImplementationOnce((...args) => {
      const query = update(...args);
      jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
        await update(
          { user: userId, messageId: parentMessageId },
          {
            $set: {
              'content.0.tool_call.backgroundTask.resultClaim': {
                kind: 'manual',
                claimId: 'successor-poll',
                receiptReconciled: true,
              },
            },
          },
        );
        throw new Error('predecessor confirmation failed');
      });
      return query;
    });
  await expect(
    claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'manual',
      claimId: 'manual-poll',
    }),
  ).rejects.toThrow('predecessor confirmation failed');
  replaced.mockRestore();
  expect(
    await methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'wakeup',
      claimId: 'automatic',
    }),
  ).toMatchObject({
    status: 'claimed',
    claim: { claimId: 'successor-poll', receiptReconciled: true },
  });
});

it.each(['missing-receipt', 'batch-root', 'batch-sibling'] as const)(
  'preserves a manual handoff committed after the %s recovery snapshot',
  async (scenario) => {
    const polled = await ready('one', scenario !== 'missing-receipt');
    const other = scenario === 'batch-sibling' ? await ready('two') : undefined;
    const root = other ?? polled;
    await project('one');
    let confirmationReached: () => void = () => undefined;
    let confirmNow: () => void = () => undefined;
    let recoveryReached: () => void = () => undefined;
    let recoverNow: () => void = () => undefined;
    const confirmationEntered = new Promise<void>((resolve) => {
      confirmationReached = resolve;
    });
    const confirmationBarrier = new Promise<void>((resolve) => {
      confirmNow = resolve;
    });
    const recoveryEntered = new Promise<void>((resolve) => {
      recoveryReached = resolve;
    });
    const recoveryBarrier = new Promise<void>((resolve) => {
      recoverNow = resolve;
    });
    const confirm = methods.confirmBackgroundToolResultClaim.bind(methods);
    const pausedConfirmation = jest
      .spyOn(methods, 'confirmBackgroundToolResultClaim')
      .mockImplementationOnce(async (input) => {
        confirmationReached();
        await confirmationBarrier;
        return confirm(input);
      });
    const manual = claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'manual',
      claimId: 'manual-poll',
      generationId: 'manual-generation',
    });
    await confirmationEntered;
    let manualActive = true;
    const release = jest.fn(methods.releaseBackgroundToolResultClaims);
    const recover = createBackgroundToolDeadClaimRecovery(
      async () => false,
      release,
      async () =>
        manualActive
          ? { status: 'running', metadata: { responseMessageId: 'manual-generation' } }
          : null,
      async () => 'unavailable',
    );
    const recoverDeadClaim = jest.fn(async (input: Parameters<typeof recover>[0]) => {
      recoveryReached();
      await recoveryBarrier;
      return recover(input);
    });
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods,
      getGenerationJob: async () => null,
      recoverDeadClaim,
    });
    if (root.mode !== 'continue') throw new Error('Expected continuation');
    const key = getAgentTriggerIdempotencyKey(root);
    await mongoose.models.AgentTriggerDelivery.updateMany(
      { deliveryKey: { $in: [key, getAgentTriggerIdempotencyKey(polled)] } },
      {
        $set: {
          capabilityStatus: 'leased',
          capabilityClaimToken: 'exact-queue-lease',
          capabilityLeaseBy: 'automatic-worker',
          capabilityLeaseUntil: new Date(Date.now() + 60_000),
        },
      },
    );
    const context = {
      idempotencyKey: key,
      requiredWorkerCapability: capability,
      deliveryClaimToken: 'exact-queue-lease',
    };
    const automatic = resolve(root, context);
    await recoveryEntered;
    confirmNow();
    expect(await manual).toMatchObject({ status: 'acquired', results: [{ taskId: 'one' }] });
    // The automatic queue lease won manual retirement. The poll returned its
    // result and its generation ended while recovery held a stale snapshot.
    expect(
      await methods.retireAgentTriggerDelivery({
        deliveryKey: getAgentTriggerIdempotencyKey(polled),
        sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
        settledAt: new Date(),
        reason: 'manual poll',
        onlyIfUnclaimed: true,
        requireTransition: true,
      }),
    ).toBe(false);
    manualActive = false;
    recoverNow();
    await expect(automatic).rejects.toMatchObject({
      code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
      deferWithoutAttempt: true,
    });
    expect(recoverDeadClaim).toHaveBeenCalledWith(
      expect.objectContaining({ onlyIfUnreconciled: true }),
    );
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manual', claimId: 'manual-poll', onlyIfUnreconciled: true }),
    );
    const claim = await methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'wakeup',
      claimId: 'probe',
    });
    expect(claim).toMatchObject({
      status: 'claimed',
      claim: { claimId: 'manual-poll', receiptReconciled: true },
    });
    const pollEnvelope = polled.mode === 'continue' ? polled : undefined;
    if (pollEnvelope == null) throw new Error('Expected polled continuation');
    await expect(
      resolve(pollEnvelope, {
        idempotencyKey: getAgentTriggerIdempotencyKey(polled),
        requiredWorkerCapability: capability,
      }),
    ).resolves.toEqual({ status: 'settled' });
    if (other != null) {
      const row = await methods.getAgentTriggerDelivery(getAgentTriggerIdempotencyKey(polled));
      if (row == null) throw new Error('Expected polled delivery');
      expect(
        await methods.completeAgentTriggerDelivery({
          id: row.id,
          workerId: 'automatic-worker',
          claimToken: 'exact-queue-lease',
          attempt: 1,
          settledAt: new Date(),
          result: { status: 'settled', mode: 'continue', conversationId },
        }),
      ).toBe(true);
      const remaining = await resolve(root, context);
      if (remaining?.status !== 'ready') throw new Error('Expected undelivered sibling');
      expect(remaining.input).toContain('"background_task_id":"two"');
      expect(remaining.input).not.toContain('"background_task_id":"one"');
      await remaining.beginDispatch?.();
    }
    pausedConfirmation.mockRestore();
  },
);

it('keeps explicit manual recovery able to reopen a committed claim after its generation ends', async () => {
  await ready('one');
  await project('one');
  await claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
    userId,
    conversationId,
    messageId: parentMessageId,
    taskId: 'one',
    kind: 'manual',
    claimId: 'manual-poll',
    generationId: 'manual-generation',
  });
  let active = true;
  const recover = createBackgroundToolDeadClaimRecovery(
    async () => false,
    methods.releaseBackgroundToolResultClaims,
    async () =>
      active ? { status: 'running', metadata: { responseMessageId: 'manual-generation' } } : null,
    async () => 'unavailable',
  );
  const input = {
    userId,
    conversationId,
    messageId: parentMessageId,
    claimId: 'manual-poll',
    kind: 'manual' as const,
    generationId: 'manual-generation',
  };
  expect(await recover(input)).toBe(false);
  active = false;
  expect(await recover({ ...input, onlyIfUnreconciled: true })).toBe(false);
  expect(await recover(input)).toBe(true);
  expect(
    (
      await methods.claimBackgroundToolResults({
        userId,
        conversationId,
        messageId: parentMessageId,
        taskId: 'one',
        kind: 'manual',
        claimId: 'next-poll',
      })
    ).status,
  ).toBe('acquired');
});

it.each(['same-generation', 'later-generation'] as const)(
  'restores manual reconciliation after %s final persistence',
  async (scenario) => {
    const generationId = scenario === 'same-generation' ? parentMessageId : 'manual-generation';
    const created = backgroundTaskRegistry.create({
      userId,
      conversationId,
      toolCallId: 'manual-final-call',
      toolName: 'tool',
      messageId: parentMessageId,
      harvestStarted: true,
    });
    if ('atCapacity' in created) throw new Error('Unexpected task capacity');
    const taskId = created.task.id;
    const root = await ready(taskId);
    await project(taskId);
    await mongoose.models.Message.updateOne(
      { user: userId, messageId: parentMessageId },
      { $set: { unfinished: true } },
    );
    const original = await mongoose.models.Message.findOne({
      user: userId,
      messageId: parentMessageId,
    }).lean<Pick<IMessage, 'content'>>();
    backgroundTaskRegistry.complete(userId, conversationId, taskId, { content: 'manual-result' });
    backgroundTaskRegistry.finishHarvest(userId, conversationId, taskId);
    backgroundTaskRegistry.markCompletionWakeup(userId, conversationId, taskId, {
      renew: async () => true,
      retire: async (reason, options) =>
        methods.retireAgentTriggerDelivery({
          deliveryKey: getAgentTriggerIdempotencyKey(root),
          sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
          settledAt: new Date(),
          reason,
          ...options,
        }),
    });
    const polled = JSON.parse(
      await runCheckBackgroundTask({
        userId,
        conversationId,
        args: { background_task_id: taskId },
        toolCallId: 'confirmed-poll',
        runId: 'manual-run',
        generationId,
        claimBackgroundToolResult: (input) =>
          claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, input),
      }),
    );
    expect(polled).toMatchObject({ status: 'completed', result: 'manual-result' });
    expect(backgroundTaskRegistry.get(userId, conversationId, taskId)?.resultClaim).toMatchObject({
      receiptReconciled: true,
    });
    // Final full persistence uses content captured before manual confirmation.
    await mongoose.models.Message.updateOne(
      { user: userId, messageId: parentMessageId },
      { $set: { unfinished: false, content: original?.content } },
    );
    const restored = getBackgroundCodeDelivery({
      userId,
      conversationId,
      args: { background_task_id: taskId },
    });
    expect(restored?.backgroundTask?.resultClaim).toMatchObject({ receiptReconciled: true });
    await methods.updateToolCallResult({
      userId,
      conversationId,
      messageId: parentMessageId,
      toolCallId: taskId,
      output: 'manual-result',
      backgroundTask: restored?.backgroundTask,
    });
    const release = jest.fn(methods.releaseBackgroundToolResultClaims);
    const recover = createBackgroundToolDeadClaimRecovery(
      async () => false,
      release,
      async () => null,
      async () => 'unavailable',
    );
    const claim = await methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId,
      kind: 'wakeup',
      claimId: 'automatic-probe',
    });
    if (claim.status !== 'claimed' || claim.claim == null)
      throw new Error('Expected preserved manual claim');
    expect(claim.claim).toMatchObject({ receiptReconciled: true });
    expect(
      await recover({
        userId,
        conversationId,
        messageId: parentMessageId,
        claimId: claim.claim.claimId,
        kind: 'manual',
        generationId,
        onlyIfUnreconciled: true,
      }),
    ).toBe(false);
    expect(
      (await methods.getAgentTriggerDelivery(getAgentTriggerIdempotencyKey(root)))?.status,
    ).toBe('succeeded');
  },
);

it.each(['admitted', 'unpublished'] as const)(
  'uses native recovery proof after custom-store %s job cleanup',
  async (state) => {
    const root = await ready('one');
    const sibling = await ready('two');
    const key = getAgentTriggerIdempotencyKey(root);
    await methods.claimAgentBackgroundToolResultBatch({
      ...owner(key),
      limit: 8,
      maxMetadataChars: 16000,
    });
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    // Historical lookup is optional; the native claim/fence CAS still exists.
    Reflect.set(store, 'getIdempotencyClaim', undefined);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    try {
      const claimed = await manager.claimGeneration(userId, key, conversationId, conversationId, 2);
      if (state === 'admitted') {
        const job = await manager.createJob(conversationId, userId, conversationId, {
          idempotencyClientRequestId: key,
          idempotencyClaimToken: claimed.existing!.claimToken,
          initialMetadata: { generationProtocolVersion: 2 },
        });
        expect(await store.deleteJob(conversationId, job.createdAt)).toBe(true);
      }
      expect(
        await manager.getGenerationAdmissionEvidence(userId, key, conversationId, conversationId),
      ).toBeNull();
      await mongoose.models.AgentTriggerDelivery.updateOne(
        { deliveryKey: key },
        { $set: { capabilityStatus: 'dead' } },
      );
      const release = jest.fn(methods.releaseAgentBackgroundToolResultClaims);
      const recover = createBackgroundToolDeadClaimRecovery(
        async (deliveryKey, sourceId, reason, options) =>
          methods.retireAgentTriggerDelivery({
            deliveryKey,
            sourceId,
            reason,
            settledAt: new Date(),
            ...options,
          }),
        methods.releaseBackgroundToolResultClaims,
        async () => null,
        ({ userId, conversationId, claimId }) =>
          manager.fenceGenerationClaimForRecovery(userId, claimId, conversationId, conversationId),
        release,
        methods,
        (...args) => manager.getGenerationAdmissionEvidence(...args),
      );
      expect(
        await recover({ userId, conversationId, messageId: parentMessageId, claimId: key }),
      ).toBe(state === 'unpublished');
      if (state === 'admitted') {
        expect(release).not.toHaveBeenCalled();
        expect(
          await methods.claimAgentBackgroundToolResultBatch({
            ...owner(getAgentTriggerIdempotencyKey(sibling)),
            limit: 8,
            maxMetadataChars: 16000,
          }),
        ).toMatchObject({ status: 'claimed', ownerStatus: 'applied' });
        const batch = await methods.getAgentBackgroundToolResultBatch(owner(key));
        expect(batch?.proofCopiedAt).toBeInstanceOf(Date);
      } else {
        expect(release).toHaveBeenCalledWith(expect.objectContaining({ recoveryFenced: true }));
        expect(
          (
            await methods.claimAgentBackgroundToolResultBatch({
              ...owner(getAgentTriggerIdempotencyKey(sibling)),
              limit: 8,
              maxMetadataChars: 16000,
            })
          ).status,
        ).toBe('acquired');
      }
    } finally {
      await manager.destroy();
    }
  },
);

it.each(['lookup', 'confirmation', 'confirmation-unknown'] as const)(
  'preserves a committed manual replay when %s is unavailable',
  async (phase) => {
    const root = await ready('one');
    await project('one');
    const key = getAgentTriggerIdempotencyKey(root);
    await mongoose.models.AgentTriggerDelivery.updateOne(
      { deliveryKey: key },
      { $set: { capabilityStatus: 'leased', capabilityClaimToken: 'automatic-lease' } },
    );
    const input = {
      userId,
      conversationId,
      taskId: 'one',
      kind: 'manual' as const,
      claimId: 'committed-poll',
      generationId: 'manual-generation',
    };
    const delivered = await claimBackgroundToolResult(
      methods,
      methods.getAgentBackgroundToolResultClaim,
      input,
    );
    expect(delivered).toMatchObject({ status: 'acquired' });
    let restore: () => void = () => undefined;
    try {
      if (phase === 'lookup') {
        await expect(
          claimBackgroundToolResult(
            methods,
            async () => {
              throw new Error('receipt lookup unavailable');
            },
            input,
          ),
        ).rejects.toThrow();
      } else if (phase === 'confirmation') {
        const failure = jest
          .spyOn(mongoose.models.Message, 'updateOne')
          .mockImplementationOnce(() => {
            throw new Error('confirmation write unavailable');
          });
        restore = () => {
          failure.mockRestore();
        };
        // Exact committed read-back succeeds even though this replay's write fails.
        await expect(
          claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
            ...input,
            generationId: undefined,
          }),
        ).resolves.toEqual(delivered);
      } else {
        const failure = jest
          .spyOn(methods, 'confirmBackgroundToolResultClaim')
          .mockRejectedValueOnce(new Error('confirmation outcome unavailable'));
        restore = () => {
          failure.mockRestore();
        };
        await expect(
          claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, input),
        ).rejects.toThrow('confirmation outcome unavailable');
      }
    } finally {
      restore();
    }
    const competitor = await methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'one',
      kind: 'wakeup',
      claimId: 'automatic-probe',
    });
    expect(competitor).toMatchObject({
      status: 'claimed',
      claim: { claimId: input.claimId, generationId: 'manual-generation', receiptReconciled: true },
    });
    expect(
      await methods.releaseBackgroundToolResultClaims({
        userId,
        conversationId,
        messageId: parentMessageId,
        taskIds: ['one'],
        kind: 'manual',
        claimId: input.claimId,
        onlyIfUnreconciled: true,
      }),
    ).toBe(false);
    if (root.mode !== 'continue') throw new Error('Expected continuation');
    const resolve = createBackgroundToolCompletionWakeupResolver({
      methods,
      getGenerationJob: async () => null,
    });
    await expect(
      resolve(root, {
        idempotencyKey: key,
        requiredWorkerCapability: capability,
        deliveryClaimToken: 'automatic-lease',
      }),
    ).resolves.toEqual({ status: 'settled' });
  },
);

it('repairs native started-fence confirmation from an applied follower after a retired owner crashed', async () => {
  const root = await ready('one');
  const sibling = await ready('two');
  const key = getAgentTriggerIdempotencyKey(root);
  const claimed = await methods.claimAgentBackgroundToolResultBatch({
    ...owner(key),
    limit: 8,
    maxMetadataChars: 16000,
  });
  if (claimed.status !== 'acquired') throw new Error('Expected frozen batch');
  await mongoose.models.AgentTriggerDelivery.updateOne(
    { deliveryKey: key },
    { $set: { capabilityStatus: 'dead' } },
  );
  const recover = createBackgroundToolDeadClaimRecovery(
    async (deliveryKey, sourceId, reason, options) =>
      methods.retireAgentTriggerDelivery({
        deliveryKey,
        sourceId,
        reason,
        settledAt: new Date(),
        ...options,
      }),
    methods.releaseBackgroundToolResultClaims,
    async () => null,
    async () => 'started',
    methods.releaseAgentBackgroundToolResultClaims,
    methods,
    async () => null,
  );
  const Delivery = mongoose.models.AgentTriggerDelivery;
  const copyFailure = jest.spyOn(Delivery, 'updateMany').mockImplementationOnce(() => {
    throw new Error('proof copy lost');
  });
  await expect(
    recover({ userId, conversationId, messageId: parentMessageId, claimId: key }),
  ).rejects.toThrow('proof copy lost');
  copyFailure.mockRestore();
  expect(await Delivery.findOne({ deliveryKey: key }).lean()).toMatchObject({
    status: 'succeeded',
  });
  expect(await Delivery.findOne({ deliveryKey: key }).lean()).not.toHaveProperty('expiresAt');
  if (sibling.mode !== 'continue') throw new Error('Expected sibling');
  const resolve = createBackgroundToolCompletionWakeupResolver({
    methods,
    getGenerationJob: async () => null,
  });
  await expect(
    resolve(sibling, {
      idempotencyKey: getAgentTriggerIdempotencyKey(sibling),
      requiredWorkerCapability: capability,
    }),
  ).resolves.toEqual({ status: 'settled' });
  expect(
    (await methods.getAgentBackgroundToolResultBatch(owner(key)))?.proofCopiedAt,
  ).toBeInstanceOf(Date);
  expect(await Delivery.findOne({ deliveryKey: key }).lean()).toHaveProperty('expiresAt');
  expect(
    await methods.getAgentBackgroundToolResultClaim({ ...owner(key), taskId: 'one' }),
  ).toMatchObject({ appliedAt: expect.any(Date) });
  expect(
    await methods.getAgentBackgroundToolResultClaim({ ...owner(key), taskId: 'two' }),
  ).toMatchObject({ appliedAt: expect.any(Date) });
});

it.each([
  ['local', false],
  ['reconstructed', false],
  ['local', true],
  ['reconstructed', true],
] as const)(
  'recovers a released physical projection through a %s poll after successor retirement %s',
  async (pollPath, replaceOwner) => {
    const root = await ready('stale-task');
    const key = getAgentTriggerIdempotencyKey(root);
    const scope = owner(key);
    await project('stale-task');
    const old = await methods.claimAgentBackgroundToolResultBatch({
      ...scope,
      limit: 8,
      maxMetadataChars: 16000,
    });
    if (old.status !== 'acquired') throw new Error('Expected predecessor batch');
    let pause: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const Message = mongoose.models.Message;
    const update = Message.findOneAndUpdate.bind(Message);
    const lateProjection = jest
      .spyOn(Message, 'findOneAndUpdate')
      .mockImplementationOnce((...args) => {
        const query = update(...args);
        const execute = query.exec.bind(query);
        jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
          pause();
          await barrier;
          return execute();
        });
        return query;
      });
    const delayed = methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'stale-task',
      kind: 'wakeup',
      claimId: key,
      batchId: old.batchId,
      limit: 1,
    });
    await paused;
    expect(
      await methods.releaseAgentBackgroundToolResultClaims({
        ...scope,
        claimId: key,
        batchId: old.batchId,
      }),
    ).toBe(true);
    if (replaceOwner) {
      const successor = await methods.claimAgentBackgroundToolResultBatch({
        ...scope,
        limit: 8,
        maxMetadataChars: 16000,
      });
      if (successor.status !== 'acquired') throw new Error('Expected successor batch');
      expect(successor.batchId).not.toBe(old.batchId);
      expect(
        await methods.releaseAgentBackgroundToolResultClaims({
          ...scope,
          claimId: key,
          batchId: successor.batchId,
        }),
      ).toBe(true);
    }
    expect(
      await methods.retireAgentTriggerDelivery({
        deliveryKey: key,
        sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
        reason: 'unadmitted owner retired',
        settledAt: new Date(),
        onlyIfUnclaimed: true,
      }),
    ).toBe(true);
    resume();
    await expect(delayed).resolves.toMatchObject({ status: 'acquired' });
    lateProjection.mockRestore();
    expect(await methods.getAgentBackgroundToolResultBatch(scope)).toBeNull();

    // A broad logical-owner release would also erase these unrelated claims.
    await project('other-epoch');
    await project('manual-task');
    await methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'other-epoch',
      kind: 'wakeup',
      claimId: key,
      batchId: 'unrelated-epoch',
      limit: 1,
    });
    await claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, {
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'manual-task',
      kind: 'manual',
      claimId: key,
    });
    if (pollPath === 'local') {
      const created = backgroundTaskRegistry.create({
        taskId: 'stale-task',
        userId,
        conversationId,
        messageId: parentMessageId,
        toolCallId: 'stale-task',
        toolName: 'tool',
      });
      if ('atCapacity' in created) throw new Error('Unexpected capacity');
      backgroundTaskRegistry.complete(userId, conversationId, created.task.id, {
        content: 'durable-stale-task',
      });
      backgroundTaskRegistry.markCompletionWakeup(userId, conversationId, created.task.id);
    }
    const store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
    try {
      const release = jest.fn(methods.releaseBackgroundToolResultClaims);
      const recover = createBackgroundToolDeadClaimRecovery(
        async (deliveryKey, sourceId, reason, options) =>
          methods.retireAgentTriggerDelivery({
            deliveryKey,
            sourceId,
            reason,
            settledAt: new Date(),
            ...options,
          }),
        release,
        async () => null,
        ({ userId, conversationId, claimId }) =>
          manager.fenceGenerationClaimForRecovery(userId, claimId, conversationId, conversationId),
        methods.releaseAgentBackgroundToolResultClaims,
        methods,
        (...args) => manager.getGenerationAdmissionEvidence(...args),
      );
      const recoverDeadBackgroundToolClaim = jest.fn(recover);
      const polled = JSON.parse(
        await runCheckBackgroundTask({
          userId,
          conversationId,
          args: { background_task_id: 'stale-task' },
          toolCallId: 'stale-poll',
          runId: 'recovery-run',
          generationId: 'recovery-generation',
          claimBackgroundToolResult: (input) =>
            claimBackgroundToolResult(methods, methods.getAgentBackgroundToolResultClaim, input),
          recoverDeadBackgroundToolClaim,
        }),
      );
      expect(polled).toMatchObject({ status: 'completed', result: 'durable-stale-task' });
      expect(recoverDeadBackgroundToolClaim).toHaveBeenCalledWith(
        expect.objectContaining({ claimId: key, batchId: old.batchId }),
      );
      expect(release).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'wakeup', claimId: key, batchId: old.batchId }),
      );
      for (const [taskId, claim] of [
        ['other-epoch', { kind: 'wakeup', claimId: key, batchId: 'unrelated-epoch' }],
        ['manual-task', { kind: 'manual', claimId: key, receiptReconciled: true }],
      ] as const) {
        expect(
          await methods.claimBackgroundToolResults({
            userId,
            conversationId,
            messageId: parentMessageId,
            taskId,
            kind: 'wakeup',
            claimId: 'probe',
          }),
        ).toMatchObject({ status: 'claimed', claim });
      }
    } finally {
      await manager.destroy();
    }
  },
);

it('does not release a stale epoch while a successor receipt batch owns the logical delivery', async () => {
  const root = await ready('stale-task');
  const key = getAgentTriggerIdempotencyKey(root);
  const scope = owner(key);
  await project('stale-task');
  const old = await methods.claimAgentBackgroundToolResultBatch({
    ...scope,
    limit: 8,
    maxMetadataChars: 16000,
  });
  if (old.status !== 'acquired') throw new Error('Expected predecessor');
  await methods.releaseAgentBackgroundToolResultClaims({
    ...scope,
    claimId: key,
    batchId: old.batchId,
  });
  const successor = await methods.claimAgentBackgroundToolResultBatch({
    ...scope,
    limit: 8,
    maxMetadataChars: 16000,
  });
  if (successor.status !== 'acquired') throw new Error('Expected successor');
  await methods.claimBackgroundToolResults({
    userId,
    conversationId,
    messageId: parentMessageId,
    taskId: 'stale-task',
    kind: 'wakeup',
    claimId: key,
    batchId: successor.batchId,
    limit: 1,
  });
  const release = jest.fn(methods.releaseBackgroundToolResultClaims);
  const retire = jest.fn(async () => true);
  const fence = jest.fn(async () => 'fenced' as const);
  const recover = createBackgroundToolDeadClaimRecovery(
    retire,
    release,
    async () => null,
    fence,
    methods.releaseAgentBackgroundToolResultClaims,
    methods,
  );
  expect(
    await recover({
      userId,
      conversationId,
      messageId: parentMessageId,
      claimId: key,
      batchId: old.batchId,
    }),
  ).toBe(false);
  expect(retire).not.toHaveBeenCalled();
  expect(fence).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(
    await methods.getAgentBackgroundToolResultClaim({ ...scope, taskId: 'stale-task' }),
  ).toMatchObject({ batchId: successor.batchId });
  expect(
    await methods.claimBackgroundToolResults({
      userId,
      conversationId,
      messageId: parentMessageId,
      taskId: 'stale-task',
      kind: 'manual',
      claimId: 'probe',
    }),
  ).toMatchObject({ status: 'claimed', claim: { claimId: key, batchId: successor.batchId } });
});
