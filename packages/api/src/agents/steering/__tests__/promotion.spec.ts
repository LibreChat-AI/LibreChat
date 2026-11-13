import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getPromotedSteerRequestId } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V3,
} from '@librechat/data-schemas';
import type { AgentContinueTriggerEnvelope } from '~/agents/triggers/envelope';
import type { AgentTriggerContinuePreparation } from '~/agents/triggers/host';
import type { AgentQueuedTurnLifecycle } from '~/agents/queuedTurns';
import type { SteerPromotionDeps } from '../promotion';
import {
  createAgentQueuedTurnLifecycle,
  createQueuedTurnDeliveryReservation,
} from '~/agents/queuedTurns';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { promoteDrainedSteers, completePromotedSteerHandoff } from '../promotion';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { getAgentTriggerIdempotencyKey } from '~/agents/triggers/envelope';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { toQueuedTurnReceipt } from '~/agents/queuedTurnHttp';
import { handleSteerRequest } from '../request';

jest.mock('../runtime', () => ({
  ...jest.requireActual('../runtime'),
  isSteeringSupported: jest.fn(() => true),
  isSteerPreemptSupported: jest.fn(() => true),
}));

jest.spyOn(console, 'log').mockImplementation();

const agentId = 'agent_steer_promotion';
const responseMessageId = 'response-ended';
const CLIENT_STEER_ID = 'client-steer-1';

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let userId: string;
let conversationId: string;
let envelopes: AgentContinueTriggerEnvelope[];
let requiredCapabilities: (string | undefined)[];
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
  requiredCapabilities = [];
  lifecycle = createAgentQueuedTurnLifecycle({
    methods,
    getGenerationJob: async (id) => (await GenerationJobManager.getJob(id)) ?? null,
    completeSteerHandoff: (handoff) =>
      completePromotedSteerHandoff(GenerationJobManager.steering, handoff),
    getGenerationAdmissionEvidence: async () => null,
    enqueue: async (envelope, options) => {
      const parsed = envelope as AgentContinueTriggerEnvelope;
      envelopes.push(parsed);
      requiredCapabilities.push(options?.requiredWorkerCapability);
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
async function acceptSteer(
  options: {
    promoteLeftover?: boolean;
    clientSteerId?: string;
    quotes?: string[];
    codeApprovalMode?: string;
  } = {},
) {
  const job = await GenerationJobManager.createJob(conversationId, userId, conversationId, {
    initialMetadata: { generationProtocolVersion: 2, agent_id: agentId, endpoint: 'agents' },
  });
  const clientSteerId = options.clientSteerId ?? CLIENT_STEER_ID;
  const accepted = await handleSteerRequest(
    { id: userId },
    {
      conversationId,
      generationCreatedAt: job.createdAt,
      clientSteerId,
      text: 'also cover the error path',
      ...(options.quotes != null && { quotes: options.quotes }),
      ...(options.promoteLeftover !== false && { promoteLeftover: true }),
      ...(options.codeApprovalMode != null && { codeApprovalMode: options.codeApprovalMode }),
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
          clientRequestId: getPromotedSteerRequestId(CLIENT_STEER_ID),
          parentMessageId: responseMessageId,
          expectedPredecessorCreatedAt: job.createdAt,
          text: 'also cover the error path',
          steer: { steerId, clientSteerId },
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
    const row = await methods.getAgentQueuedTurnByClientRequestId({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
      clientRequestId: getPromotedSteerRequestId(CLIENT_STEER_ID),
    });
    expect(row?.steerSource).toEqual({
      steerId,
      clientSteerId,
      generationCreatedAt: job.createdAt,
      handoffAt: expect.any(Date),
    });
    /** The receipt any pane reads names the steer and that this turn owns its words. */
    expect(toQueuedTurnReceipt(row!).steer).toEqual({ steerId, clientSteerId, owned: true });
    expect(envelopes).toHaveLength(1);
    /** Only a worker that proves a promoted steer's ownership may take this delivery. */
    expect(requiredCapabilities).toEqual([AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V3]);
    expect(envelopes[0].event.id).toBe(`${row?.queuedTurnId}:v3`);

    /** The promoted turn is what completion wake-ups yield to at run end. */
    await expect(
      methods.hasPendingAgentQueuedTurn({ userId, conversationId, now: new Date() }),
    ).resolves.toBe(true);

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
      clientRequestIds: [getPromotedSteerRequestId(CLIENT_STEER_ID)],
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

  it('keeps a steer on the legacy path when its owner stripped the requested quotes', async () => {
    const { job, steerId } = await acceptSteer({ quotes: ['the retry loop'] });
    const claim = await endRunUnapplied(job.createdAt);
    expect(claim.drainedSteers[0]).not.toHaveProperty('quotes');

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result).toEqual({
      promotedSteers: [],
      pendingSteers: [expect.objectContaining({ steerId })],
    });
    await expect(
      methods.listActiveAgentQueuedTurns({
        user: new mongoose.Types.ObjectId(userId),
        conversationId,
      }),
    ).resolves.toEqual([]);
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
      clientRequestIds: [getPromotedSteerRequestId(CLIENT_STEER_ID)],
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

  it('hands the client a refused row it cannot retire, and its admission cancels the row', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    await GenerationJobManager.steering.discardLeftover(
      conversationId,
      clientSteerId,
      steerId,
      { userId },
      job.createdAt,
    );
    const cancel = jest.fn(async () => {
      throw new Error('mongo unavailable');
    });

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      { ...deps, lifecycle: { ...lifecycle, cancel } },
    );

    expect(cancel).toHaveBeenCalledTimes(1);
    /** The row stays, so the client follows it instead of queuing the words. */
    expect(result).toEqual({
      pendingSteers: [],
      promotedSteers: [
        { steerId, clientSteerId, receipt: expect.objectContaining({ status: 'queued' }) },
      ],
    });
    expect(envelopes).toHaveLength(1);

    await publishFinal(claim);
    await expect(prepare(envelopes[0])).resolves.toEqual({ status: 'settled' });
    const [settled] = await methods.listAgentQueuedTurnReceipts({
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
      clientRequestIds: [getPromotedSteerRequestId(CLIENT_STEER_ID)],
    });
    expect(settled.status).toBe('cancelled');
  });

  it('keeps the row when the hand-off reply is lost, and its admission proves ownership', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    const steering = GenerationJobManager.steering;
    /** The store commits the hand-off, then the reply never arrives. */
    const promoteLeftover = jest.fn(
      async (...args: Parameters<typeof steering.promoteLeftover>) => {
        await expect(steering.promoteLeftover(...args)).resolves.toBe('promoted');
        throw new Error('reply lost');
      },
    );

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      { ...deps, steering: { promoteLeftover, getReceipt: steering.getReceipt.bind(steering) } },
    );

    expect(result).toEqual({
      pendingSteers: [],
      promotedSteers: [
        { steerId, clientSteerId, receipt: expect.objectContaining({ status: 'queued' }) },
      ],
    });
    const lookup = {
      user: new mongoose.Types.ObjectId(userId),
      conversationId,
      clientRequestId: getPromotedSteerRequestId(CLIENT_STEER_ID),
    };
    /** Unsettled: the row does not claim ownership it could not confirm. */
    const unsettled = await methods.getAgentQueuedTurnByClientRequestId(lookup);
    expect(unsettled).toMatchObject({ status: 'queued' });
    expect(unsettled?.steerSource).not.toHaveProperty('handoffAt');
    /** Wake-ups yield to it while its ownership is still unsettled, too. */
    await expect(
      methods.hasPendingAgentQueuedTurn({ userId, conversationId, now: new Date() }),
    ).resolves.toBe(true);
    await expect(steering.claim(conversationId, { userId })).resolves.toEqual([]);

    await publishFinal(claim);
    await expect(prepare(envelopes[0])).resolves.toMatchObject({
      status: 'ready',
      input: 'also cover the error path',
    });
    const owned = await methods.getAgentQueuedTurnByClientRequestId(lookup);
    expect(owned?.steerSource?.handoffAt).toBeInstanceOf(Date);
  });

  it('does not hand the parked copy to a replayed row that can no longer run', async () => {
    const { job, steerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    const steering = GenerationJobManager.steering;
    const input = {
      claim,
      conversationId,
      user: { id: userId },
      responseMessageId,
      completed: true,
    };
    const refused = await promoteDrainedSteers(input, {
      ...deps,
      steering: {
        promoteLeftover: async () => 'refused' as const,
        getReceipt: steering.getReceipt.bind(steering),
      },
    });
    expect(refused.pendingSteers).toEqual([expect.objectContaining({ steerId })]);

    const replayed = await promoteDrainedSteers(input, deps);

    expect(replayed).toEqual({
      promotedSteers: [],
      pendingSteers: [expect.objectContaining({ steerId })],
    });
    await expect(steering.claim(conversationId, { userId })).resolves.toEqual([
      expect.objectContaining({ steerId }),
    ]);
    expect(envelopes).toEqual([]);
  });

  it('joins the queue lineage of the generation it was accepted in', async () => {
    const { job, steerId } = await acceptSteer();
    const scope = { user: new mongoose.Types.ObjectId(userId), conversationId };
    const rootEpoch = job.createdAt - 60_000;
    const lineage = {
      ...scope,
      agentId,
      parentMessageId: 'root-parent',
      priority: false,
      expectedPredecessorCreatedAt: rootEpoch,
    };
    /** This generation is itself a queued turn's run, with a sibling still waiting. */
    const ran = await methods.enqueueAgentQueuedTurn({
      ...lineage,
      clientRequestId: 'ran-as-this-generation',
      text: 'first',
    });
    const waiting = await methods.enqueueAgentQueuedTurn({
      ...lineage,
      clientRequestId: 'still-waiting',
      text: 'second',
    });
    await mongoose.models.AgentQueuedTurn.updateOne(
      { _id: ran.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: new Date(),
            generationCreatedAt: job.createdAt,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );
    const claim = await endRunUnapplied(job.createdAt);

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    /** Behind the sibling, in its lineage: a lineage of its own would be stranded
     * once the sibling's run replaced this generation as the conversation's latest. */
    expect(result.promotedSteers).toEqual([
      expect.objectContaining({
        steerId,
        receipt: expect.objectContaining({
          parentMessageId: 'root-parent',
          expectedPredecessorCreatedAt: rootEpoch,
        }),
      }),
    ]);
    expect(result.promotedSteers[0]?.receipt.revision).toBeGreaterThan(waiting.turn.sequence);
    const row = await methods.getAgentQueuedTurnByClientRequestId({
      ...scope,
      clientRequestId: getPromotedSteerRequestId(CLIENT_STEER_ID),
    });
    /** The hand-off stays fenced to the generation that accepted the steer. */
    expect(row?.steerSource).toMatchObject({
      generationCreatedAt: job.createdAt,
      handoffAt: expect.any(Date),
    });
  });

  it('joins a lineage that a root admission opened, without giving it an epoch', async () => {
    const { job, steerId } = await acceptSteer();
    const scope = { user: new mongoose.Types.ObjectId(userId), conversationId };
    /** A queued turn with no predecessor epoch ran as this generation. */
    const ran = await methods.enqueueAgentQueuedTurn({
      ...scope,
      agentId,
      parentMessageId: 'root-parent',
      clientRequestId: 'root-admission',
      text: 'first',
      priority: false,
    });
    await mongoose.models.AgentQueuedTurn.updateOne(
      { _id: ran.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: new Date(),
            generationCreatedAt: job.createdAt,
            rootPredecessor: true,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );
    const claim = await endRunUnapplied(job.createdAt);

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result.promotedSteers).toEqual([
      expect.objectContaining({
        steerId,
        receipt: expect.objectContaining({ parentMessageId: 'root-parent' }),
      }),
    ]);
    expect(result.promotedSteers[0]?.receipt).not.toHaveProperty('expectedPredecessorCreatedAt');
  });

  it('leaves a steer whose client id cannot key a queued turn on the legacy path', async () => {
    const { job, steerId } = await acceptSteer({ clientSteerId: `local-${'x'.repeat(120)}` });
    const claim = await endRunUnapplied(job.createdAt);
    expect(claim.drainedSteers[0]).not.toHaveProperty('promoteLeftover');

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result).toEqual({
      promotedSteers: [],
      pendingSteers: [expect.objectContaining({ steerId })],
    });
  });

  it('starts the promoted turn under the approval mode the steer was sent with', async () => {
    const { job, steerId } = await acceptSteer({ codeApprovalMode: 'ask' });
    const claim = await endRunUnapplied(job.createdAt);
    expect(claim.drainedSteers[0]).toMatchObject({
      promoteLeftover: true,
      codeApprovalMode: 'ask',
    });

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result.promotedSteers).toEqual([
      expect.objectContaining({
        steerId,
        receipt: expect.objectContaining({ codeApprovalMode: 'ask' }),
      }),
    ]);
    await publishFinal(claim);
    await expect(prepare(envelopes[0])).resolves.toMatchObject({
      status: 'ready',
      codeApprovalMode: 'ask',
    });
  });

  it('leaves a steer sent under an unreadable approval mode on the legacy path', async () => {
    const { job, steerId } = await acceptSteer({ codeApprovalMode: 'yolo' });
    const claim = await endRunUnapplied(job.createdAt);
    expect(claim.drainedSteers[0]).not.toHaveProperty('promoteLeftover');

    const result = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );

    expect(result).toEqual({
      promotedSteers: [],
      pendingSteers: [expect.objectContaining({ steerId })],
    });
  });

  it('keeps the promoted mapping on the conservative frame when FINAL cannot be stored', async () => {
    const { job, steerId, clientSteerId } = await acceptSteer();
    const claim = await endRunUnapplied(job.createdAt);
    const { promotedSteers } = await promoteDrainedSteers(
      { claim, conversationId, user: { id: userId }, responseMessageId, completed: true },
      deps,
    );
    jest
      .spyOn(GenerationJobManager.getJobStore(), 'finalizeTerminalPersistence')
      .mockRejectedValueOnce(new Error('store unavailable'));

    const publication = await GenerationJobManager.publishTerminalClaim(claim, {
      final: true,
      conversation: { conversationId },
      responseMessage: { messageId: responseMessageId, conversationId },
      promotedSteers,
    });

    expect(publication.persistenceFailed).toBe(true);
    expect(publication.finalEvent).toMatchObject({
      reconcile: true,
      promotedSteers: [expect.objectContaining({ steerId, clientSteerId })],
    });
    await GenerationJobManager.finishTerminalJob(claim);
  });

  describe('a promotion interrupted between its row and its hand-off', () => {
    async function crashAfterRow() {
      const { job, steerId, clientSteerId } = await acceptSteer();
      const claim = await endRunUnapplied(job.createdAt);
      const input = {
        user: new mongoose.Types.ObjectId(userId),
        conversationId,
        agentId,
        parentMessageId: responseMessageId,
        clientRequestId: getPromotedSteerRequestId(CLIENT_STEER_ID),
        text: 'also cover the error path',
        priority: false,
        expectedPredecessorCreatedAt: job.createdAt,
        steerSource: { steerId, clientSteerId, generationCreatedAt: job.createdAt },
      };
      const { turn } = await methods.enqueueAgentQueuedTurn({
        ...input,
        deliveryReservation: createQueuedTurnDeliveryReservation(input),
      });
      await publishFinal(claim);
      await lifecycle.schedule(turn);
      return { job, steerId, clientSteerId, turn };
    }

    it('completes the hand-off at admission so the parked copy cannot recover too', async () => {
      const { job, clientSteerId, turn } = await crashAfterRow();
      await expect(
        GenerationJobManager.steering.claim(conversationId, { userId }),
      ).resolves.toHaveLength(1);

      await expect(prepare(envelopes[0])).resolves.toMatchObject({
        status: 'ready',
        parentMessageId: responseMessageId,
        expectedPredecessorCreatedAt: job.createdAt,
      });
      await expect(
        GenerationJobManager.steering.claim(conversationId, { userId }),
      ).resolves.toEqual([]);
      await expect(
        GenerationJobManager.steering.getReceipt(conversationId, clientSteerId),
      ).resolves.toMatchObject({ state: 'recovered', promotedTurnId: turn.queuedTurnId });
      const row = await methods.getAgentQueuedTurnByClientRequestId({
        user: new mongoose.Types.ObjectId(userId),
        conversationId,
        clientRequestId: turn.clientRequestId,
      });
      expect(row?.steerSource?.handoffAt).toBeInstanceOf(Date);
    });

    it('reports a failed hand-off without the error text of the job store', async () => {
      await crashAfterRow();
      const failing = createAgentQueuedTurnLifecycle({
        methods,
        getGenerationJob: async (id) => (await GenerationJobManager.getJob(id)) ?? null,
        completeSteerHandoff: async () => {
          throw new Error('connect ECONNREFUSED redis://cache.internal:6379/0');
        },
        getGenerationAdmissionEvidence: async () => null,
        enqueue: async (envelope) => ({
          deliveryKey: getAgentTriggerIdempotencyKey(envelope as AgentContinueTriggerEnvelope),
        }),
      });

      const [envelope] = envelopes;
      await expect(
        Promise.resolve().then(() =>
          failing.prepareContinue(envelope, {
            idempotencyKey: getAgentTriggerIdempotencyKey(envelope),
            attempt: 1,
            maxAttempts: 5,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'STEER_HANDOFF_UNAVAILABLE',
        message: 'The promoted steer hand-off is temporarily unavailable.',
      });
    });

    it('holds the turn for review once ownership can no longer be proven', async () => {
      await crashAfterRow();
      const store = GenerationJobManager.getJobStore() as unknown as {
        steerReceipts: Map<string, Map<string, unknown>>;
      };
      store.steerReceipts.delete(conversationId);

      await expect(prepare(envelopes[0])).resolves.toEqual({ status: 'settled' });
      const [held] = await methods.listAgentQueuedTurnReceipts({
        user: new mongoose.Types.ObjectId(userId),
        conversationId,
        clientRequestIds: [getPromotedSteerRequestId(CLIENT_STEER_ID)],
      });
      expect(held).toMatchObject({
        status: 'dead',
        terminalReceipt: expect.objectContaining({
          failure: expect.objectContaining({ code: 'STEER_HANDOFF_UNCONFIRMED' }),
        }),
      });
    });

    it('cancels the turn when a recovery already ran the parked copy', async () => {
      const { steerId } = await crashAfterRow();
      const recovery = await GenerationJobManager.createJob(
        conversationId,
        userId,
        conversationId,
        {
          recoveredSteerId: steerId,
          recoveredSteerPayload: { text: 'also cover the error path', fileIds: [], quotes: [] },
          initialMetadata: { generationProtocolVersion: 2 },
        },
      );
      await expect(
        GenerationJobManager.steering.consumeRecovered(
          conversationId,
          steerId,
          { userId },
          recovery.createdAt,
        ),
      ).resolves.toBe(true);
      const recoveryClaim = await GenerationJobManager.claimTerminalJob(
        conversationId,
        'complete',
        undefined,
        recovery.createdAt,
        { persistencePending: true },
      );
      await GenerationJobManager.publishTerminalClaim(recoveryClaim!, {
        final: true,
        conversation: { conversationId },
      });
      await GenerationJobManager.finishTerminalJob(recoveryClaim!);

      await expect(prepare(envelopes[0])).resolves.toEqual({ status: 'settled' });
      const [cancelled] = await methods.listAgentQueuedTurnReceipts({
        user: new mongoose.Types.ObjectId(userId),
        conversationId,
        clientRequestIds: [getPromotedSteerRequestId(CLIENT_STEER_ID)],
      });
      expect(cancelled.status).toBe('cancelled');
    });
  });
});
