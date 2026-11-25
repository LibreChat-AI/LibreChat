import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from '~/models';
import { createMethods } from './index';

jest.mock('~/models/plugins/mongoMeili', () => jest.fn());
jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const models = createModels(mongoose);
const methods = createMethods(mongoose);
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all(Object.values(models).map((model) => model.init()));
}, 60_000);

beforeEach(async () => {
  await Promise.all([
    models.Conversation.deleteMany({}),
    models.Message.deleteMany({}),
    models.AgentQueuedTurn.deleteMany({}),
    models.AgentQueuedTurnSequence.deleteMany({}),
    models.AgentTriggerDelivery.deleteMany({}),
    models.AgentTriggerLaneSequence.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

async function admitQueuedTurn(awaitTerminalHandling?: true) {
  const user = new mongoose.Types.ObjectId();
  const now = new Date();
  const scope = { user, conversationId: 'queued-conversation', tenantId: 'tenant-1' };
  await models.Conversation.create({ ...scope, user: user.toString(), endpoint: 'agents' });
  const queued = await methods.enqueueAgentQueuedTurn({
    ...scope,
    agentId: 'agent-1',
    parentMessageId: 'parent-1',
    clientRequestId: 'request-1',
    text: 'follow up',
    availableAt: now,
  });
  const deliveryKey = `queued-${queued.turn.queuedTurnId}`;
  const turnScope = { ...scope, queuedTurnId: queued.turn.queuedTurnId, deliveryKey };
  await methods.reserveAgentQueuedTurnDelivery(turnScope);
  await methods.enqueueAgentTriggerDelivery({
    ...scope,
    deliveryKey,
    fingerprint: deliveryKey,
    orderingKey: deliveryKey,
    availableAt: now,
    awaitTerminalHandling,
    envelope: {
      mode: 'continue',
      event: { source: { type: 'internal', id: 'agent-queued-turn' } },
      target: { conversationId: scope.conversationId, bindingId: 'queued-binding' },
    },
  });
  await methods.markQueuedTurnScheduled({ ...turnScope, scheduledAt: now });
  const claim = {
    ...turnScope,
    claimId: 'turn-claim',
    claimBy: 'turn-worker',
    now,
    leaseUntil: new Date(now.getTime() + 60_000),
  };
  await methods.claimNextAgentQueuedTurn(claim);
  await methods.beginAgentQueuedTurnAdmission({
    ...claim,
    admissionId: deliveryKey,
    startedAt: now,
  });
  await expect(
    methods.markAgentQueuedTurnAdmitted({
      ...claim,
      admissionId: deliveryKey,
      admissionMode: 'ordinary',
      lineagePredecessorId: `root:${createHash('sha256').update('parent-1').digest('base64url')}`,
      generationId: 'generation-1',
      generationCreatedAt: now.getTime(),
      settledAt: now,
    }),
  ).resolves.toMatchObject({ outcome: 'admitted' });
  const deliveryClaim = await methods.claimNextAgentTriggerDelivery({
    workerId: 'delivery-worker',
    claimToken: 'delivery-claim',
    now,
    leaseUntil: claim.leaseUntil,
  });
  if (deliveryClaim == null) {
    throw new Error('Expected a delivery claim');
  }
  const fence = {
    id: deliveryClaim.id,
    workerId: 'delivery-worker',
    claimToken: 'delivery-claim',
  };
  const attempt = await methods.beginAgentTriggerDeliveryAttempt({ ...fence, now });
  if (attempt == null) {
    throw new Error('Expected a delivery attempt');
  }
  await expect(
    methods.completeAgentTriggerDelivery({
      ...fence,
      attempt,
      awaitTerminalHandling,
      settledAt: now,
      result: { status: 'started', conversationId: scope.conversationId },
      handling: {
        status: 'started',
        conversationId: scope.conversationId,
        streamId: 'generation-1',
        generationCreatedAt: now.getTime(),
        startedAt: now,
      },
    }),
  ).resolves.toBe(true);
  return { ...turnScope, now };
}

describe('queued-turn conversation deletion through createMethods', () => {
  it('requires explicit opt-in and the matching internal source for transport-only success', async () => {
    const turn = await admitQueuedTurn();
    const retirement = {
      deliveryKey: turn.deliveryKey,
      sourceId: 'agent-queued-turn',
      settledAt: new Date(),
      reason: 'queued_turn_conversation_deleted',
    };

    await expect(methods.retireAgentTriggerDelivery(retirement)).resolves.toBe(false);
    await expect(
      methods.retireAgentTriggerDelivery({
        ...retirement,
        sourceId: 'background-tool-completion',
        allowSucceeded: true,
      }),
    ).resolves.toBe(false);
    await expect(
      methods.retireAgentTriggerDelivery({ ...retirement, allowSucceeded: true }),
    ).resolves.toBe(true);
    await expect(
      methods.retireAgentTriggerDelivery({ ...retirement, allowSucceeded: true }),
    ).resolves.toBe(true);
  });

  it.each(['published', 'retiring', undefined] as const)(
    'deletes an admitted turn with a successful delivery and deliveryState %s',
    async (deliveryState) => {
      const turn = await admitQueuedTurn();
      await models.AgentQueuedTurn.updateOne(
        { _id: turn.queuedTurnId },
        deliveryState == null ? { $unset: { deliveryState: 1 } } : { $set: { deliveryState } },
      );
      const before = await models.AgentTriggerDelivery.findOne({
        deliveryKey: turn.deliveryKey,
      }).lean();
      const unrelated = await models.Conversation.create({
        user: turn.user.toString(),
        conversationId: 'unrelated-conversation',
        endpoint: 'agents',
      });

      await expect(
        methods.deleteConvos(turn.user.toString(), { conversationId: turn.conversationId }),
      ).resolves.toMatchObject({ deletedCount: 1, conversationIds: [turn.conversationId] });

      expect(await models.AgentQueuedTurn.countDocuments({ _id: turn.queuedTurnId })).toBe(0);
      expect(await models.Conversation.findById(unrelated._id)).not.toBeNull();
      expect(await models.Conversation.findOne({ conversationId: turn.conversationId })).toBeNull();
      await expect(
        models.AgentTriggerDelivery.findOne({ deliveryKey: turn.deliveryKey }).lean(),
      ).resolves.toMatchObject({
        status: 'succeeded',
        result: before?.result,
        handling: before?.handling,
        settledAt: before?.settledAt,
        expiresAt: before?.expiresAt,
      });
    },
  );

  it.each([false, true])(
    'deletes only the selected conversation (has queued turn: %s) and preserves unrelated work',
    async (hasQueuedTurn) => {
      const admitted = await admitQueuedTurn();
      const owner = { user: admitted.user, tenantId: admitted.tenantId };
      const enqueue = (conversationId: string) =>
        methods.enqueueAgentQueuedTurn({
          ...owner,
          conversationId,
          agentId: 'agent-1',
          parentMessageId: 'parent-1',
          clientRequestId: 'pending-turn',
          text: 'keep this queued turn',
          availableAt: admitted.now,
        });
      await enqueue(admitted.conversationId);
      const selected = await models.Conversation.create({
        ...owner,
        user: owner.user.toString(),
        conversationId: 'selected-conversation',
        endpoint: 'agents',
      });
      if (hasQueuedTurn) {
        await enqueue(selected.conversationId);
      }
      const unrelated = { conversationId: admitted.conversationId };
      const before = {
        turns: await models.AgentQueuedTurn.find(unrelated).sort('_id').lean(),
        lane: await models.AgentQueuedTurnSequence.findOne(unrelated).lean(),
        conversation: await models.Conversation.findOne(unrelated).lean(),
        delivery: await models.AgentTriggerDelivery.findOne({
          deliveryKey: admitted.deliveryKey,
        }).lean(),
      };

      await expect(
        methods.deleteConvos(owner.user.toString(), { conversationId: selected.conversationId }),
      ).resolves.toMatchObject({ deletedCount: 1, conversationIds: [selected.conversationId] });

      expect(await models.Conversation.findById(selected._id)).toBeNull();
      expect(
        await models.AgentQueuedTurn.countDocuments({ conversationId: selected.conversationId }),
      ).toBe(0);
      await expect(models.AgentQueuedTurn.find(unrelated).sort('_id').lean()).resolves.toEqual(
        before.turns,
      );
      await expect(models.AgentQueuedTurnSequence.findOne(unrelated).lean()).resolves.toEqual(
        before.lane,
      );
      await expect(models.Conversation.findOne(unrelated).lean()).resolves.toEqual(
        before.conversation,
      );
      await expect(
        models.AgentTriggerDelivery.findOne({ deliveryKey: admitted.deliveryKey }).lean(),
      ).resolves.toEqual(before.delivery);
    },
  );

  it('keeps explicit terminal-handling fences and recovers a failed retirement on retry', async () => {
    const turn = await admitQueuedTurn(true);
    const remove = () =>
      methods.deleteConvos(turn.user.toString(), { conversationId: turn.conversationId });

    await expect(remove()).rejects.toThrow('deliveries must retire');
    await expect(models.AgentQueuedTurn.findById(turn.queuedTurnId).lean()).resolves.toMatchObject({
      deliveryState: 'retiring',
    });
    expect(
      await models.Conversation.findOne({ conversationId: turn.conversationId }),
    ).not.toBeNull();

    await models.AgentTriggerDelivery.updateOne(
      { deliveryKey: turn.deliveryKey },
      { $set: { 'handling.status': 'applied', 'handling.settledAt': new Date() } },
    );
    await expect(remove()).resolves.toMatchObject({ deletedCount: 1 });
  });

  it('recovers a retiring source after its successful delivery receipt expires', async () => {
    const turn = await admitQueuedTurn();
    await methods.beginAgentQueuedTurnMissingDeliveryRetirement({ deliveryKey: turn.deliveryKey });
    await models.AgentTriggerDelivery.deleteOne({ deliveryKey: turn.deliveryKey });

    await expect(
      methods.deleteConvos(turn.user.toString(), { conversationId: turn.conversationId }),
    ).resolves.toMatchObject({ deletedCount: 1 });
  });
});
