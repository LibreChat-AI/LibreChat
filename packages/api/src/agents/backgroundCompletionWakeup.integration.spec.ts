import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMethods,
  createModels,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
} from '@librechat/data-schemas';
import type { AgentTriggerFetch } from './triggers/host';
import {
  createBackgroundToolCompletionWakeupResolver,
  createBackgroundToolDeadClaimRecovery,
  BACKGROUND_TOOL_COMPLETION_SOURCE,
} from './backgroundCompletionWakeup';
import { createAgentTriggerEnvelope, getAgentTriggerIdempotencyKey } from './triggers/envelope';
import { createAgentTriggerExecutionHost } from './triggers/host';
import { prepareAgentTriggerDelivery } from './triggers/delivery';

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

async function ready(taskId: string) {
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
