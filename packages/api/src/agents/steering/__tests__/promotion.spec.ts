import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { AgentContinueTriggerEnvelope } from '~/agents/triggers/envelope';
import type { AgentTriggerContinuePreparation } from '~/agents/triggers/host';
import type { AgentQueuedTurnLifecycle } from '~/agents/queuedTurns';
import type { SteerPromotionDeps } from '../promotion';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { promoteDrainedSteers, getPromotedSteerRequestId } from '../promotion';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { getAgentTriggerIdempotencyKey } from '~/agents/triggers/envelope';
import { createAgentQueuedTurnLifecycle } from '~/agents/queuedTurns';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { handleSteerRequest } from '../request';

jest.mock('../runtime', () => ({
  ...jest.requireActual('../runtime'),
  isSteeringSupported: jest.fn(() => true),
  isSteerPreemptSupported: jest.fn(() => true),
}));

jest.spyOn(console, 'log').mockImplementation();

const agentId = 'agent_steer_promotion';
const responseMessageId = 'response-ended';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
let conversationId: string;
let envelopes: AgentContinueTriggerEnvelope[];
let lifecycle: AgentQueuedTurnLifecycle;
let deps: SteerPromotionDeps;

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
    ['AgentQueuedTurn', 'AgentQueuedTurnSequence', 'Conversation', 'Message'].map((name) =>
      mongoose.models[name].deleteMany({}),
    ),
  );
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  userId = new mongoose.Types.ObjectId().toString();
  conversationId = `steer-promotion-${new mongoose.Types.ObjectId().toString()}`;
  await mongoose.models.Conversation.create({
    conversationId,
    user: userId,
    endpoint: 'agents',
    agent_id: agentId,
  });
  envelopes = [];
  lifecycle = createAgentQueuedTurnLifecycle({
    methods,
    getGenerationJob: async (id) => (await GenerationJobManager.getJob(id)) ?? null,
    getGenerationAdmissionEvidence: async () => null,
    enqueue: async (envelope) => {
      const parsed = envelope as AgentContinueTriggerEnvelope;
      envelopes.push(parsed);
      return { deliveryKey: getAgentTriggerIdempotencyKey(parsed) };
    },
  });
  deps = {
    methods,
    lifecycle,
    steering: GenerationJobManager.steering,
  };
});

afterEach(async () => {
  await GenerationJobManager.destroy();
});

/** A running v2 generation with one accepted (202) steer still queued. */
async function acceptSteer(options: { promoteLeftover?: boolean; clientSteerId?: string } = {}) {
  const job = await GenerationJobManager.createJob(conversationId, userId, conversationId, {
    initialMetadata: { generationProtocolVersion: 2, agent_id: agentId, endpoint: 'agents' },
  });
  const clientSteerId = options.clientSteerId ?? 'client-steer-1';
  const accepted = await handleSteerRequest(
    { id: userId },
    {
      conversationId,
      generationCreatedAt: job.createdAt,
      clientSteerId,
      text: 'also cover the error path',
      ...(options.promoteLeftover !== false && { promoteLeftover: true }),
    },
    { generationProtocolVersion: 2 },
  );
  expect(accepted.status).toBe(202);
  return { job, clientSteerId, steerId: accepted.body.steerId as string };
}

/** The run ends without applying the steer: the terminal CAS drains and parks it,
 * and the controller persists the response before publishing FINAL. */
async function endRunUnapplied(createdAt: number) {
  const claim = await GenerationJobManager.claimTerminalJob(
    conversationId,
    'complete',
    undefined,
    createdAt,
    { persistencePending: true },
  );
  expect(claim).not.toBeNull();
  await mongoose.models.Message.create([
    {
      messageId: 'user-ended',
      conversationId,
      user: userId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      isCreatedByUser: true,
      endpoint: 'agents',
    },
    {
      messageId: responseMessageId,
      conversationId,
      user: userId,
      parentMessageId: 'user-ended',
      isCreatedByUser: false,
      unfinished: false,
      endpoint: 'agents',
    },
  ]);
  return claim!;
}

async function publishFinal(claim: NonNullable<Awaited<ReturnType<typeof endRunUnapplied>>>) {
  await GenerationJobManager.publishTerminalClaim(claim, {
    final: true,
    conversation: { conversationId },
    responseMessage: { messageId: responseMessageId, conversationId },
  });
  await GenerationJobManager.finishTerminalJob(claim);
}

function prepare(envelope: AgentContinueTriggerEnvelope) {
  return lifecycle.prepareContinue(envelope, {
    idempotencyKey: getAgentTriggerIdempotencyKey(envelope),
    attempt: 1,
    maxAttempts: 5,
  });
}

describe('promoteDrainedSteers', () => {
  it('turns an accepted steer the run never applied into an admitted server queued turn', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    expect(claim.drainedSteers).toEqual([
      expect.objectContaining({ steerId, clientSteerId, promoteLeftover: true }),
    ]);

    const result = await promoteDrainedSteers(
      {
        claim,
        conversationId,
        user: { id: userId },
        responseMessageId,
        responseContent: [],
        completed: true,
      },
      deps,
    );

    expect(result.pendingSteers).toEqual([]);
    expect(result.promotedSteers).toEqual([
      {
        steerId,
        clientSteerId,
        receipt: expect.objectContaining({
          status: 'queued',
          conversationId,
          clientRequestId: getPromotedSteerRequestId(steerId),
          parentMessageId: responseMessageId,
          expectedPredecessorCreatedAt: job.createdAt,
          text: 'also cover the error path',
        }),
      },
    ]);
    const durable = await methods.listActiveAgentQueuedTurns({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
    });
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({
      parentMessageId: responseMessageId,
      expectedPredecessorCreatedAt: job.createdAt,
      agentId,
    });
    expect(envelopes).toHaveLength(1);

    /** FINAL is not yet durable: the ended generation still owns the conversation. */
    await expect(prepare(envelopes[0])).rejects.toMatchObject({ code: 'PARENT_NOT_READY' });

    await publishFinal(claim);
    const prepared = (await prepare(envelopes[0])) as Extract<
      AgentTriggerContinuePreparation,
      { status: 'ready' }
    >;
    expect(prepared).toMatchObject({
      status: 'ready',
      input: 'also cover the error path',
      parentMessageId: responseMessageId,
      expectedPredecessorCreatedAt: job.createdAt,
    });
    await prepared.settleOnAdmission?.({
      mode: 'continue',
      status: 'started',
      conversationId,
      streamId: conversationId,
      generationCreatedAt: job.createdAt + 1,
    });
    const [admitted] = await methods.listAgentQueuedTurnReceipts({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
      clientRequestIds: [getPromotedSteerRequestId(steerId)],
    });
    expect(admitted.status).toBe('admitted');
  });

  it('retires every legacy recovery surface so the words cannot queue twice', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    const input = {
      claim,
      conversationId,
      user: { id: userId },
      responseMessageId,
      completed: true,
    };
    const first = await promoteDrainedSteers(input, deps);
    expect(first.promotedSteers).toHaveLength(1);

    /** A status read (reload, closed tab) no longer offers the parked copy. */
    await expect(GenerationJobManager.steering.claim(conversationId, { userId })).resolves.toEqual(
      [],
    );
    /** A lost-ACK retry of the steer POST settles instead of reporting a leftover. */
    const retried = await handleSteerRequest(
      { id: userId },
      {
        conversationId,
        clientSteerId,
        text: 'also cover the error path',
        promoteLeftover: true,
      },
      { generationProtocolVersion: 2 },
    );
    expect(retried).toMatchObject({ status: 202, body: { settled: true, leftover: false } });
    /** A client that converted the steer locally anyway cannot start it as a recovery. */
    await publishFinal(claim);
    await expect(
      GenerationJobManager.createJob(conversationId, userId, conversationId, {
        recoveredSteerId: steerId,
        recoveredSteerPayload: {
          text: 'also cover the error path',
          fileIds: [],
          quotes: [],
        },
        initialMetadata: { generationProtocolVersion: 2 },
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_PAYLOAD_MISMATCH', reason: 'source_missing' });

    /** Replaying the promotion resolves to the same durable row. */
    const replay = await promoteDrainedSteers(input, deps);
    expect(replay.promotedSteers[0]?.receipt.queuedTurnId).toBe(
      first.promotedSteers[0]?.receipt.queuedTurnId,
    );
    const durable = await methods.listActiveAgentQueuedTurns({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
    });
    expect(durable).toHaveLength(1);
  });

  it('leaves a steer from a client that cannot adopt receipts on the legacy path', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer({ promoteLeftover: false });
    const claim = await endRunUnapplied(job.createdAt);

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result.promotedSteers).toEqual([]);
    expect(result.pendingSteers).toEqual([
      expect.objectContaining({ steerId, clientSteerId, text: 'also cover the error path' }),
    ]);
    expect(result.pendingSteers[0]).not.toHaveProperty('promoteLeftover');
    await expect(
      methods.listActiveAgentQueuedTurns({
        user: new mongoose.Types.ObjectId(userId),
        conversationId,
      }),
    ).resolves.toEqual([]);
    await expect(GenerationJobManager.steering.claim(conversationId, { userId })).resolves.toEqual([
      expect.objectContaining({ steerId }),
    ]);
    expect(envelopes).toEqual([]);
  });

  it('does not promote the leftovers of a run that ended unfinished', async () => {
    const { job, steerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: false },
      deps,
    );

    expect(result).toEqual({
      promotedSteers: [],
      pendingSteers: [expect.objectContaining({ steerId })],
    });
    await expect(GenerationJobManager.steering.claim(conversationId, { userId })).resolves.toEqual([
      expect.objectContaining({ steerId }),
    ]);
  });

  it('retires the row and keeps the legacy copy when the user discarded the leftover first', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    await expect(
      GenerationJobManager.steering.discardLeftover(
        conversationId,
        clientSteerId,
        steerId,
        { userId },
        job.createdAt,
      ),
    ).resolves.toBe(true);

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result.promotedSteers).toEqual([]);
    expect(result.pendingSteers).toEqual([expect.objectContaining({ steerId })]);
    const [retired] = await methods.listAgentQueuedTurnReceipts({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
      clientRequestIds: [getPromotedSteerRequestId(steerId)],
    });
    expect(retired.status).toBe('cancelled');
    expect(envelopes).toEqual([]);
  });

  it('chains behind a turn already queued against the same generation', async () => {
    const { job, steerId } = await acceptSteer();
    const queued = await methods.enqueueAgentQueuedTurn({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
      agentId,
      parentMessageId: 'user-ended',
      clientRequestId: 'queued-during-run',
      text: 'then summarize',
      priority: false,
      expectedPredecessorCreatedAt: job.createdAt,
    });
    const claim = await endRunUnapplied(job.createdAt);

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result.promotedSteers).toEqual([
      expect.objectContaining({
        steerId,
        receipt: expect.objectContaining({
          parentMessageId: 'user-ended',
          expectedPredecessorCreatedAt: job.createdAt,
        }),
      }),
    ]);
    expect(result.promotedSteers[0]?.receipt.revision).toBeGreaterThan(queued.turn.sequence ?? 0);
  });
});
