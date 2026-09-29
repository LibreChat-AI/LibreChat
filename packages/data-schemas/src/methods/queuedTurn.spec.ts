import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type {
  IAgentQueuedTurnDocument,
  IAgentQueuedTurnSequenceDocument,
} from '~/types/queuedTurn';
import {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
  createAgentQueuedTurnMethods,
  type AgentQueuedTurnMethods,
} from './queuedTurn';
import {
  createAgentQueuedTurnModel,
  createAgentQueuedTurnSequenceModel,
} from '../models/queuedTurn';

const DB_SETUP_TIMEOUT_MS = 60_000;
const START = new Date('2026-08-30T12:00:00.000Z');
const LATER = new Date(START.getTime() + 60_000);
let mongoServer: MongoMemoryServer;
let Turn: Model<IAgentQueuedTurnDocument>;
let Sequence: Model<IAgentQueuedTurnSequenceDocument>;
let methods: AgentQueuedTurnMethods;
let user: mongoose.Types.ObjectId;
let counter = 0;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Turn = createAgentQueuedTurnModel(mongoose);
  Sequence = createAgentQueuedTurnSequenceModel(mongoose);
  await Promise.all([Turn.init(), Sequence.init()]);
  methods = createAgentQueuedTurnMethods(mongoose);
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all([Turn.deleteMany({}), Sequence.deleteMany({})]);
  user = new mongoose.Types.ObjectId();
  counter += 1;
});

function enqueueInput(
  overrides: Partial<Parameters<typeof methods.enqueueAgentQueuedTurn>[0]> = {},
) {
  return {
    user,
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    parentMessageId: 'parent-1',
    clientRequestId: `request-${counter}`,
    text: 'follow up',
    availableAt: START,
    ...overrides,
  };
}

function claimInput(
  queuedTurnId: string,
  overrides: Partial<Parameters<typeof methods.claimNextAgentQueuedTurn>[0]> = {},
) {
  return {
    user,
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    queuedTurnId,
    claimId: 'claim-1',
    claimBy: 'worker-1',
    now: START,
    leaseUntil: LATER,
    ...overrides,
  };
}

function rootLineageId(parentMessageId = 'parent-1') {
  return `root:${createHash('sha256').update(parentMessageId).digest('base64url')}`;
}

describe('agent queued turn methods', () => {
  it('normalizes payloads, replays the same request, and conflicts on changed content', async () => {
    const input = enqueueInput({
      text: '  follow up  ',
      files: [
        { file_id: ' file-1 ', filename: ' report.pdf ', llmDeliveryPath: 'text' },
        { file_id: 'file-1', filename: 'ignored duplicate' },
      ],
      quotes: [' quote ', '', 'second'],
      manualSkills: [' skill-a ', 'skill-a'],
      expectedPredecessorCreatedAt: 42,
    });

    const first = await methods.enqueueAgentQueuedTurn(input);
    const replay = await methods.enqueueAgentQueuedTurn({
      ...input,
      text: 'follow up',
      /** Older replicas do not know the display-only delivery marker; their retry
       * must still replay the same accepted intent during a rolling deployment. */
      files: [{ file_id: 'file-1', filename: 'report.pdf' }],
      quotes: ['quote', 'second'],
      manualSkills: ['skill-a'],
    });

    expect(first.replayed).toBe(false);
    expect(first.turn).toMatchObject({
      queuedTurnId: expect.any(String),
      agentId: 'agent-1',
      parentMessageId: 'parent-1',
      sequence: 1,
      status: 'queued',
      text: 'follow up',
      files: [{ file_id: 'file-1', filename: 'report.pdf', llmDeliveryPath: 'text' }],
      quotes: ['quote', 'second'],
      manualSkills: ['skill-a'],
      expectedPredecessorCreatedAt: 42,
    });
    expect(replay).toMatchObject({
      replayed: true,
      turn: { queuedTurnId: first.turn.queuedTurnId },
    });
    await expect(
      methods.enqueueAgentQueuedTurn({ ...input, agentId: 'agent-2' }),
    ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
    await expect(
      methods.enqueueAgentQueuedTurn({
        ...input,
        parentMessageId: 'different-parent',
      }),
    ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
    expect(await Turn.countDocuments()).toBe(1);
  });

  it('refuses an unfenced approval snapshot before inserting a row', async () => {
    await expect(
      methods.enqueueAgentQueuedTurn(enqueueInput({ codeApprovalMode: 'ask' })),
    ).rejects.toThrow('versioned delivery reservation');
    expect(await Turn.countDocuments()).toBe(0);
  });

  it('keeps the selected approval mode on queued, claimed, and retried turns', async () => {
    const input = enqueueInput({
      codeApprovalMode: 'fullAccess',
      deliveryReservation: { queuedTurnId: '507f191e810c19729de860ea', deliveryKey: 'v2-key' },
    });
    const first = await methods.enqueueAgentQueuedTurn(input);
    expect(first.turn.codeApprovalMode).toBe('fullAccess');
    expect(first.turn).toMatchObject({ deliveryKey: 'v2-key', deliveryState: 'publishing' });
    const scope = {
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
    };
    await expect(
      methods.reserveAgentQueuedTurnDelivery({ ...scope, deliveryKey: 'legacy-v1-key' }),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    await expect(
      methods.reserveAgentQueuedTurnDelivery({ ...scope, deliveryKey: 'v2-key' }),
    ).resolves.toMatchObject({ outcome: 'already_reserved' });

    expect((await methods.enqueueAgentQueuedTurn(input)).replayed).toBe(true);
    await expect(
      methods.enqueueAgentQueuedTurn({ ...input, codeApprovalMode: 'ask' }),
    ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
    const claimed = await methods.claimNextAgentQueuedTurn(claimInput(first.turn.queuedTurnId));
    expect(claimed.outcome).toBe('acquired');
    if (claimed.outcome === 'acquired') expect(claimed.claim.codeApprovalMode).toBe('fullAccess');
    const listed = await methods.listActiveAgentQueuedTurns({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
    });
    expect(listed[0]?.codeApprovalMode).toBe('fullAccess');
  });

  it('keeps old queued turns without a mode and rejects an upgraded same-id replay', async () => {
    const input = enqueueInput();
    const created = await methods.enqueueAgentQueuedTurn(input);
    expect(created.turn.codeApprovalMode).toBeUndefined();
    expect((await methods.enqueueAgentQueuedTurn(input)).replayed).toBe(true);
    await expect(
      methods.enqueueAgentQueuedTurn({
        ...input,
        codeApprovalMode: 'fullAccess',
        deliveryReservation: { queuedTurnId: '507f191e810c19729de860ea', deliveryKey: 'v2-key' },
      }),
    ).rejects.toBeInstanceOf(AgentQueuedTurnConflictError);
  });

  it('looks up terminal receipts by owner-scoped request identity', async () => {
    const created = await methods.enqueueAgentQueuedTurn(enqueueInput());

    await expect(
      methods.getAgentQueuedTurnByClientRequestId({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        clientRequestId: created.turn.clientRequestId,
      }),
    ).resolves.toMatchObject({ queuedTurnId: created.turn.queuedTurnId });
    await expect(
      methods.getAgentQueuedTurnByClientRequestId({
        user,
        tenantId: 'tenant-1',
        conversationId: 'another-conversation',
        clientRequestId: created.turn.clientRequestId,
      }),
    ).resolves.toBeNull();
  });

  it('allocates monotonic conversation sequences under concurrent enqueue', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        methods.enqueueAgentQueuedTurn(
          enqueueInput({
            clientRequestId: `concurrent-${index}`,
            text: `turn ${index}`,
          }),
        ),
      ),
    );

    const sequences = results.map(({ turn }) => turn.sequence).sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(8);
    expect(sequences.every((value, index) => index === 0 || value > sequences[index - 1])).toBe(
      true,
    );
  });

  it('blocks claims behind a visible reservation and repairs it oldest-first', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'visible-first' }),
    );
    const lane = await Sequence.findOne({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
    }).lean();
    if (lane?.laneId == null) {
      throw new Error('Expected a durable queued-turn lane');
    }
    await Turn.create({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      parentMessageId: 'parent-1',
      clientRequestId: 'interrupted-reservation',
      fingerprint: 'x'.repeat(43),
      laneId: lane.laneId,
      activeSlot: ((first.turn.activeSlot ?? 0) + 1) % 100,
      status: 'reserving',
      priority: false,
      text: 'repair me',
      attempts: 0,
      availableAt: START,
      deliveryState: 'pending',
    });

    await expect(
      methods.claimNextAgentQueuedTurn(claimInput(first.turn.queuedTurnId)),
    ).resolves.toMatchObject({ outcome: 'blocked' });
    await methods.findQueuedTurnsNeedingDelivery();
    await expect(
      methods.claimNextAgentQueuedTurn(claimInput(first.turn.queuedTurnId)),
    ).resolves.toMatchObject({ outcome: 'acquired' });
    await expect(
      Turn.findOne({ clientRequestId: 'interrupted-reservation' }).lean(),
    ).resolves.toMatchObject({ status: 'queued', sequence: expect.any(Number) });
  });

  it('reports reservation-only recovery activity when deleted lanes yield no deliveries', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'lost-lane-first' }),
    );
    const second = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'lost-lane-second' }),
    );
    await Turn.updateMany(
      { _id: { $in: [first.turn.queuedTurnId, second.turn.queuedTurnId] } },
      {
        $set: { status: 'reserving' },
        $unset: { sequence: 1 },
      },
    );
    await Sequence.deleteMany({});
    for (let i = 0; i < 2; i++) {
      const activity = { found: false };
      expect(await methods.findQueuedTurnsNeedingDelivery(1, activity)).toEqual([]);
      expect(activity.found).toBe(true);
    }
    const empty = { found: false };
    expect(await methods.findQueuedTurnsNeedingDelivery(1, empty)).toEqual([]);
    expect(empty.found).toBe(false);
  });

  it('caps each conversation at 100 active turns while preserving exact replay', async () => {
    const inputs = Array.from({ length: 101 }, (_, index) =>
      enqueueInput({ clientRequestId: `capacity-${index}`, text: `turn ${index}` }),
    );
    const results = await Promise.allSettled(
      inputs.map((input) => methods.enqueueAgentQueuedTurn(input)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(100);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AgentQueuedTurnCapacityError);

    const first = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof methods.enqueueAgentQueuedTurn>>
      > => result.status === 'fulfilled',
    );
    if (first == null) {
      throw new Error('Expected one successful enqueue');
    }
    const replayInput = inputs.find(
      (input) => input.clientRequestId === first.value.turn.clientRequestId,
    );
    if (replayInput == null) {
      throw new Error('Expected the matching replay input');
    }
    await expect(methods.enqueueAgentQueuedTurn(replayInput)).resolves.toMatchObject({
      replayed: true,
      turn: { queuedTurnId: first.value.turn.queuedTurnId },
    });
    expect(await methods.listActiveAgentQueuedTurns(enqueueInput())).toHaveLength(100);
  });

  it('reuses a terminalized active slot and isolates capacity by owner scope', async () => {
    const queued = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        methods.enqueueAgentQueuedTurn(
          enqueueInput({ clientRequestId: `slot-${index}`, text: `turn ${index}` }),
        ),
      ),
    );
    await expect(
      methods.cancelAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued[0].turn.queuedTurnId,
        settledAt: START,
      }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ clientRequestId: 'reused-slot', text: 'replacement' }),
      ),
    ).resolves.toMatchObject({ replayed: false, turn: { status: 'queued' } });
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ clientRequestId: 'capacity-overflow', text: 'overflow' }),
      ),
    ).rejects.toBeInstanceOf(AgentQueuedTurnCapacityError);

    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({
          conversationId: 'conversation-2',
          clientRequestId: 'other-conversation',
        }),
      ),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ tenantId: 'tenant-2', clientRequestId: 'other-tenant' }),
      ),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ user: new mongoose.Types.ObjectId(), clientRequestId: 'other-user' }),
      ),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('keeps untenant records in the untenant owner scope', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ tenantId: undefined, clientRequestId: 'untenant' }),
    );

    expect(queued.turn.tenantId).toBeUndefined();
    await expect(
      methods.listActiveAgentQueuedTurns({
        user,
        conversationId: 'conversation-1',
      }),
    ).resolves.toMatchObject([{ queuedTurnId: queued.turn.queuedTurnId }]);
    await expect(
      methods.listActiveAgentQueuedTurns({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toEqual([]);
  });

  it('lists and claims priority then FIFO without skipping the expected head', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'first', text: 'first' }),
    );
    const second = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'second', text: 'second' }),
    );
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'priority',
        text: 'priority',
        priority: true,
      }),
    );

    const active = await methods.listActiveAgentQueuedTurns(enqueueInput());
    expect(active.map((turn) => turn.clientRequestId)).toEqual(['priority', 'first', 'second']);
    await expect(
      methods.claimNextAgentQueuedTurn(claimInput(first.turn.queuedTurnId)),
    ).resolves.toEqual({
      outcome: 'blocked',
      claim: null,
    });

    const acquired = await methods.claimNextAgentQueuedTurn(claimInput(priority.turn.queuedTurnId));
    expect(acquired).toMatchObject({
      outcome: 'acquired',
      claim: { queuedTurnId: priority.turn.queuedTurnId, attempts: 1 },
    });
    const replayed = await methods.claimNextAgentQueuedTurn(claimInput(priority.turn.queuedTurnId));
    expect(replayed).toMatchObject({
      outcome: 'replayed',
      claim: { queuedTurnId: priority.turn.queuedTurnId, attempts: 1 },
    });
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(second.turn.queuedTurnId, {
          claimId: 'other',
          claimBy: 'worker-2',
        }),
      ),
    ).resolves.toEqual({ outcome: 'blocked', claim: null });
  });

  it('serializes competing claims across independent method instances', async () => {
    const normal = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'concurrent-claim-normal' }),
    );
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'concurrent-claim-priority', priority: true }),
    );
    const otherReplica = createAgentQueuedTurnMethods(mongoose);

    const [normalResult, priorityResult] = await Promise.all([
      methods.claimNextAgentQueuedTurn(
        claimInput(normal.turn.queuedTurnId, { claimId: 'normal-claim' }),
      ),
      otherReplica.claimNextAgentQueuedTurn(
        claimInput(priority.turn.queuedTurnId, {
          claimId: 'priority-claim',
          claimBy: 'worker-2',
        }),
      ),
    ]);

    expect(normalResult).toEqual({ outcome: 'blocked', claim: null });
    expect(priorityResult).toMatchObject({
      outcome: 'acquired',
      claim: { queuedTurnId: priority.turn.queuedTurnId },
    });
    await expect(Turn.countDocuments({ status: 'claimed' })).resolves.toBe(1);
  });

  it('keeps priority work behind an existing admission-order claim', async () => {
    const normal = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'claimed-before-priority' }),
    );
    const normalClaim = claimInput(normal.turn.queuedTurnId, { claimId: 'normal-owner' });
    await expect(methods.claimNextAgentQueuedTurn(normalClaim)).resolves.toMatchObject({
      outcome: 'acquired',
    });
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'priority-after-claim', priority: true }),
    );
    const otherReplica = createAgentQueuedTurnMethods(mongoose);

    await expect(
      otherReplica.claimNextAgentQueuedTurn(
        claimInput(priority.turn.queuedTurnId, {
          claimId: 'priority-owner',
          claimBy: 'worker-2',
        }),
      ),
    ).resolves.toEqual({ outcome: 'blocked', claim: null });

    await methods.releaseAgentQueuedTurn({
      ...normalClaim,
      disposition: 'dead',
      settledAt: START,
      failure: { code: 'TEST_SETTLED', message: 'Release the lane reservation' },
    });
    await expect(
      otherReplica.claimNextAgentQueuedTurn(
        claimInput(priority.turn.queuedTurnId, {
          claimId: 'priority-owner',
          claimBy: 'worker-2',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'acquired' });
  });

  it('keeps one durable admission owner after the lane-writer lease is stolen', async () => {
    const normal = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'durable-owner-normal' }),
    );
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(normal.turn.queuedTurnId, {
          claimId: 'durable-owner',
          leaseUntil: new Date(START.getTime() + 1),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'acquired' });
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'durable-owner-priority', priority: true }),
    );

    await Sequence.updateOne(
      { user, tenantId: 'tenant-1', conversationId: 'conversation-1' },
      {
        $set: {
          writerId: 'stolen-writer',
          writerUntil: new Date(START.getTime() + 60_000),
        },
      },
    );
    const otherReplica = createAgentQueuedTurnMethods(mongoose);
    await expect(
      otherReplica.claimNextAgentQueuedTurn(
        claimInput(priority.turn.queuedTurnId, {
          claimId: 'priority-after-stolen-writer',
          claimBy: 'worker-2',
          now: new Date(START.getTime() + 2),
          leaseUntil: LATER,
        }),
      ),
    ).resolves.toEqual({ outcome: 'blocked', claim: null });
    await expect(Turn.countDocuments({ admissionSlot: true })).resolves.toBe(1);
  });

  it('rejects a pre-slot replica claim through the legacy-written status shell', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'cross-version-first' }),
    );
    const second = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'cross-version-second', priority: true }),
    );
    await Turn.updateOne(
      { _id: first.turn.queuedTurnId },
      {
        $set: {
          status: 'claimed',
          admissionSlot: true,
          claimId: 'new-replica-claim',
          claimBy: 'new-replica',
          claimUntil: LATER,
        },
      },
    );

    await expect(
      Turn.updateOne(
        { _id: second.turn.queuedTurnId },
        {
          $set: {
            status: 'claimed',
            claimId: 'legacy-replica-claim',
            claimBy: 'legacy-replica',
            claimUntil: LATER,
          },
        },
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('retires and fail-closes duplicate pre-fence admission lanes before index creation', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'duplicate-admission-first' }),
    );
    const second = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'duplicate-admission-second' }),
    );
    const third = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        conversationId: 'conversation-2',
        clientRequestId: 'duplicate-claim-first',
      }),
    );
    const fourth = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        conversationId: 'conversation-2',
        clientRequestId: 'duplicate-claim-second',
      }),
    );
    await Turn.collection.dropIndex('agent_queued_turn_claim_lane');
    await Turn.collection.dropIndex('agent_queued_turn_admission_started_lane');
    for (const [turn, deliveryKey, status] of [
      [first, 'legacy-duplicate-first', 'dead'],
      [second, 'legacy-duplicate-second', 'claimed'],
    ] as const) {
      await Turn.updateOne(
        { _id: turn.turn.queuedTurnId },
        {
          $set: {
            status,
            deliveryKey,
            deliveryState: 'published',
            admissionId: deliveryKey,
            admissionStartedAt: START,
            ...(status === 'dead' && {
              terminalReceipt: {
                outcome: 'dead',
                settledAt: START,
                failure: {
                  code: 'ADMISSION_INDETERMINATE',
                  message: 'Legacy admission owner disappeared',
                },
              },
            }),
          },
        },
      );
    }
    for (const [turn, deliveryKey] of [
      [third, 'legacy-claim-first'],
      [fourth, 'legacy-claim-second'],
    ] as const) {
      await Turn.updateOne(
        { _id: turn.turn.queuedTurnId },
        {
          $set: {
            status: 'claimed',
            deliveryKey,
            deliveryState: 'published',
            claimId: deliveryKey,
            claimBy: 'legacy-worker',
            claimUntil: LATER,
          },
        },
      );
    }

    await expect(methods.ensureAgentQueuedTurnIndexes()).resolves.toBeUndefined();
    await expect(
      Sequence.findOne({ user, tenantId: 'tenant-1', conversationId: 'conversation-1' }).lean(),
    ).resolves.toMatchObject({ retiredAt: expect.any(Date) });
    await expect(
      Sequence.findOne({ user, tenantId: 'tenant-1', conversationId: 'conversation-2' }).lean(),
    ).resolves.toMatchObject({ retiredAt: expect.any(Date) });
    await expect(
      Turn.find({
        _id: {
          $in: [
            first.turn.queuedTurnId,
            second.turn.queuedTurnId,
            third.turn.queuedTurnId,
            fourth.turn.queuedTurnId,
          ],
        },
      })
        .sort({ sequence: 1 })
        .lean(),
    ).resolves.toMatchObject([
      {
        status: 'dead',
        terminalReceipt: {
          failure: { code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE' },
        },
      },
      {
        status: 'dead',
        terminalReceipt: {
          failure: { code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE' },
        },
      },
      {
        status: 'dead',
        terminalReceipt: {
          failure: { code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE' },
        },
      },
      {
        status: 'dead',
        terminalReceipt: {
          failure: { code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE' },
        },
      },
    ]);
    await expect(Turn.countDocuments({ admissionStartedAt: { $exists: true } })).resolves.toBe(0);
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ clientRequestId: 'duplicate-admission-follow-up' }),
      ),
    ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({
          conversationId: 'conversation-2',
          clientRequestId: 'duplicate-claim-follow-up',
        }),
      ),
    ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);
    await expect(Turn.collection.indexExists('agent_queued_turn_claim_lane')).resolves.toBe(true);
    await expect(
      Turn.collection.indexExists('agent_queued_turn_admission_started_lane'),
    ).resolves.toBe(true);
  });

  it('reclaims an expired exact lease but never replays a different claim identity', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(enqueueInput());
    const first = await methods.claimNextAgentQueuedTurn(
      claimInput(queued.turn.queuedTurnId, {
        now: START,
        leaseUntil: new Date(START.getTime() + 1),
      }),
    );
    expect(first.outcome).toBe('acquired');
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'priority-after-expired-claim', priority: true }),
    );

    const reclaimed = await methods.claimNextAgentQueuedTurn(
      claimInput(queued.turn.queuedTurnId, {
        claimId: 'claim-2',
        claimBy: 'worker-2',
        now: new Date(START.getTime() + 2),
        leaseUntil: LATER,
      }),
    );
    expect(reclaimed).toMatchObject({
      outcome: 'acquired',
      claim: { attempts: 2 },
    });
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(priority.turn.queuedTurnId, {
          claimId: 'priority-claim',
          claimBy: 'worker-3',
          now: new Date(START.getTime() + 2),
          leaseUntil: LATER,
        }),
      ),
    ).resolves.toEqual({ outcome: 'blocked', claim: null });
  });

  it('repairs delivery scheduling idempotently and leaves unscheduled replays discoverable', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(enqueueInput());
    expect(await methods.findQueuedTurnsNeedingDelivery()).toMatchObject([
      { queuedTurnId: queued.turn.queuedTurnId },
    ]);
    const replay = await methods.enqueueAgentQueuedTurn(enqueueInput());
    expect(replay.replayed).toBe(true);
    expect(replay.turn).not.toHaveProperty('scheduledAt');

    await expect(
      methods.reserveAgentQueuedTurnDelivery({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-1',
      }),
    ).resolves.toMatchObject({ outcome: 'reserved' });
    const scheduled = await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-1',
      scheduledAt: START,
    });
    expect(scheduled).toMatchObject({
      outcome: 'scheduled',
      turn: { deliveryKey: 'delivery-1', scheduledAt: START },
    });
    await expect(
      methods.reserveAgentQueuedTurnDelivery({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-1',
      }),
    ).resolves.toMatchObject({ outcome: 'already_reserved' });
    await expect(
      methods.markQueuedTurnScheduled({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-1',
      }),
    ).resolves.toMatchObject({ outcome: 'already_scheduled' });
    await expect(
      methods.reserveAgentQueuedTurnDelivery({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-2',
      }),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    await expect(
      methods.markQueuedTurnScheduled({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-2',
      }),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    expect(await methods.findQueuedTurnsNeedingDelivery()).toEqual([]);
  });

  it('acknowledges a reserved delivery after a worker claims the queue row', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(enqueueInput());
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-fast',
    });
    await methods.claimNextAgentQueuedTurn(claimInput(queued.turn.queuedTurnId));

    await expect(
      methods.markQueuedTurnScheduled({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-fast',
        scheduledAt: START,
      }),
    ).resolves.toMatchObject({
      outcome: 'scheduled',
      turn: { status: 'claimed', deliveryKey: 'delivery-fast', scheduledAt: START },
    });
  });

  it('cancels claimed work until its admission fence starts', async () => {
    const cancellable = await methods.enqueueAgentQueuedTurn(enqueueInput());
    const cancelled = await methods.cancelAgentQueuedTurn({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: cancellable.turn.queuedTurnId,
      settledAt: START,
    });
    expect(cancelled).toMatchObject({
      outcome: 'cancelled',
      turn: { status: 'cancelled' },
    });
    await expect(
      methods.cancelAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: cancellable.turn.queuedTurnId,
      }),
    ).resolves.toMatchObject({ outcome: 'already_cancelled' });
    await expect(
      methods.claimNextAgentQueuedTurn(claimInput(cancellable.turn.queuedTurnId)),
    ).resolves.toEqual({ outcome: 'missing', claim: null });

    const claimed = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'claimed', text: 'claimed' }),
    );
    await methods.claimNextAgentQueuedTurn(claimInput(claimed.turn.queuedTurnId));
    await expect(
      methods.cancelAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: claimed.turn.queuedTurnId,
      }),
    ).resolves.toMatchObject({ outcome: 'cancelled', turn: { status: 'cancelled' } });

    const admitting = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'admitting', text: 'admitting' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: admitting.turn.queuedTurnId,
      deliveryKey: 'admission-cancel',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: admitting.turn.queuedTurnId,
      deliveryKey: 'admission-cancel',
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(claimInput(admitting.turn.queuedTurnId));
    await methods.beginAgentQueuedTurnAdmission({
      ...claimInput(admitting.turn.queuedTurnId),
      admissionId: 'admission-cancel',
      startedAt: START,
    });
    await expect(
      methods.cancelAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: admitting.turn.queuedTurnId,
      }),
    ).resolves.toMatchObject({ outcome: 'not_cancellable' });
  });

  it('retries, dead-letters, and admits only through the exact claim fence', async () => {
    const retry = await methods.enqueueAgentQueuedTurn(enqueueInput());
    await methods.claimNextAgentQueuedTurn(claimInput(retry.turn.queuedTurnId));
    await expect(
      methods.releaseAgentQueuedTurn({
        ...claimInput(retry.turn.queuedTurnId),
        disposition: 'retry',
        availableAt: LATER,
      }),
    ).resolves.toMatchObject({
      outcome: 'released',
      turn: { status: 'queued', availableAt: LATER },
    });

    const dead = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'dead', text: 'dead', priority: true }),
    );
    await methods.claimNextAgentQueuedTurn(claimInput(dead.turn.queuedTurnId));
    await expect(
      methods.releaseAgentQueuedTurn({
        ...claimInput(dead.turn.queuedTurnId),
        disposition: 'dead',
        settledAt: START,
        failure: { code: 'BROKEN', message: 'cannot continue' },
      }),
    ).resolves.toMatchObject({
      outcome: 'dead',
      turn: {
        status: 'dead',
        terminalReceipt: { outcome: 'dead', failure: { code: 'BROKEN' } },
      },
    });
    await methods.cancelAgentQueuedTurn({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: dead.turn.queuedTurnId,
      settledAt: START,
    });

    const admitted = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'admitted',
        text: 'admitted',
        priority: true,
        expectedPredecessorCreatedAt: 83,
      }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: admitted.turn.queuedTurnId,
      deliveryKey: 'admission-1',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: admitted.turn.queuedTurnId,
      deliveryKey: 'admission-1',
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(claimInput(admitted.turn.queuedTurnId));
    const admissionInput = {
      ...claimInput(admitted.turn.queuedTurnId),
      admissionId: 'admission-1',
      admissionMode: 'ordinary' as const,
      generationId: 'generation-1',
      generationCreatedAt: 84,
      effectivePredecessorCreatedAt: 83,
      lineagePredecessorId: rootLineageId(),
      settledAt: START,
    };
    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...claimInput(admitted.turn.queuedTurnId),
        admissionId: 'admission-1',
        startedAt: START,
      }),
    ).resolves.toMatchObject({
      outcome: 'started',
      turn: { admissionEffectivePredecessorCreatedAt: 83 },
    });
    await expect(methods.markAgentQueuedTurnAdmitted(admissionInput)).resolves.toMatchObject({
      outcome: 'admitted',
      turn: {
        status: 'admitted',
        deliveryState: 'published',
        terminalReceipt: {
          admissionId: 'admission-1',
          effectivePredecessorCreatedAt: 83,
        },
      },
    });
    await expect(
      methods.hasAgentQueuedTurnAdmissionReceipt({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: admitted.turn.queuedTurnId,
        admissionId: 'admission-1',
        generationId: 'generation-1',
        generationCreatedAt: 84,
        effectivePredecessorCreatedAt: 83,
      }),
    ).resolves.toBe(true);
    await expect(
      methods.hasAgentQueuedTurnAdmissionReceipt({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: admitted.turn.queuedTurnId,
        admissionId: 'admission-1',
        generationId: 'generation-1',
        generationCreatedAt: 85,
        effectivePredecessorCreatedAt: 83,
      }),
    ).resolves.toBe(false);
    await expect(
      methods.hasAgentQueuedTurnAdmissionReceipt({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: admitted.turn.queuedTurnId,
        admissionId: 'admission-1',
        generationId: 'generation-1',
        generationCreatedAt: 84,
        effectivePredecessorCreatedAt: 82,
      }),
    ).resolves.toBe(false);
    await expect(methods.markAgentQueuedTurnAdmitted(admissionInput)).resolves.toMatchObject({
      outcome: 'already_admitted',
    });
    await expect(
      methods.markAgentQueuedTurnAdmitted({
        ...admissionInput,
        admissionId: 'different',
      }),
    ).resolves.toMatchObject({ outcome: 'conflict' });
  });

  it('lists a dead receipt until the user dismisses it', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(enqueueInput());
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-dead',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-dead',
      scheduledAt: START,
    });
    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-dead',
        settledAt: START,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
      }),
    ).resolves.toMatchObject({ outcome: 'dead' });

    await expect(
      methods.listAgentQueuedTurnReceipts({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toMatchObject([
      {
        queuedTurnId: queued.turn.queuedTurnId,
        status: 'dead',
        terminalReceipt: {
          outcome: 'dead',
          failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'could not admit turn' },
        },
      },
    ]);
    await expect(
      methods.cancelAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        settledAt: LATER,
      }),
    ).resolves.toMatchObject({ outcome: 'cancelled', turn: { status: 'cancelled' } });
    await expect(
      methods.listAgentQueuedTurnReceipts({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toEqual([]);
  });

  it('keeps an ambiguous admission fenced when its predecessor boundary is unavailable', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'ambiguous-admission' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-ambiguous-admission',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-ambiguous-admission',
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(
      claimInput(queued.turn.queuedTurnId, { claimId: 'delivery-ambiguous-admission' }),
    );
    await methods.beginAgentQueuedTurnAdmission({
      ...claimInput(queued.turn.queuedTurnId, { claimId: 'delivery-ambiguous-admission' }),
      admissionId: 'delivery-ambiguous-admission',
      startedAt: START,
    });
    await Turn.updateOne(
      { _id: queued.turn.queuedTurnId },
      { $unset: { admissionLineagePredecessorId: 1 } },
    );
    const incompleteEvidence = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'ambiguous-admission-evidence' }),
    );
    await Turn.updateOne(
      { _id: incompleteEvidence.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            lineagePredecessorId: rootLineageId(),
          },
        },
        $unset: { activeSlot: 1 },
      },
    );

    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(queued.turn.queuedTurnId, {
          claimId: 'replacement-delivery',
          claimBy: 'replacement-worker',
          now: LATER,
          leaseUntil: new Date(LATER.getTime() + 60_000),
        }),
      ),
    ).resolves.toEqual({ outcome: 'blocked', claim: null });
    await expect(
      methods.claimQueuedTurnsForAdmissionReconciliation({
        claimId: 'reconciliation-owner',
        claimBy: 'reconciliation-worker',
        now: LATER,
        leaseUntil: new Date(LATER.getTime() + 60_000),
        limit: 1,
      }),
    ).resolves.toMatchObject([
      {
        queuedTurnId: queued.turn.queuedTurnId,
        status: 'claimed',
        reconciliationClaimId: 'reconciliation-owner',
      },
    ]);

    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-ambiguous-admission',
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
        admissionEvidence: {
          generationId: 'generation-without-predecessor-proof',
          generationCreatedAt: 42,
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'admission_indeterminate',
      turn: {
        status: 'claimed',
        admissionId: 'delivery-ambiguous-admission',
        deliveryState: 'published',
        terminalReceipt: { failure: { code: 'ADMISSION_INDETERMINATE' } },
      },
    });
    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-ambiguous-admission',
        settledAt: new Date(LATER.getTime() + 1),
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'duplicate terminal callback' },
      }),
    ).resolves.toMatchObject({ outcome: 'already_terminal' });
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'priority-behind-indeterminate', priority: true }),
    );
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(priority.turn.queuedTurnId, {
          claimId: 'priority-behind-indeterminate',
          claimBy: 'worker-2',
          now: LATER,
          leaseUntil: new Date(LATER.getTime() + 60_000),
        }),
      ),
    ).resolves.toEqual({ outcome: 'blocked', claim: null });
    await expect(Turn.findOne({ _id: queued.turn.queuedTurnId }).lean()).resolves.toMatchObject({
      admissionSlot: true,
    });
    await expect(
      Turn.updateOne(
        { _id: priority.turn.queuedTurnId },
        {
          $set: {
            status: 'claimed',
            claimId: 'legacy-priority-claim',
            claimBy: 'legacy-worker',
            claimUntil: new Date(LATER.getTime() + 60_000),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      methods.cancelAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
      }),
    ).resolves.toMatchObject({ outcome: 'not_cancellable' });
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(queued.turn.queuedTurnId, {
          claimId: 'delivery-ambiguous-admission',
          now: LATER,
          leaseUntil: new Date(LATER.getTime() + 60_000),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'blocked' });
    await expect(
      methods.prepareAgentQueuedTurnConversationDeletion({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      }),
    ).rejects.toThrow('admission must settle');

    /** A legacy worker changes its owner shell to `dead` when quarantine
     * begins. It may then claim a successor, but the common started-admission
     * index must prevent that successor from crossing the provider boundary. */
    await Turn.updateOne(
      { _id: queued.turn.queuedTurnId },
      { $set: { status: 'dead' }, $unset: { admissionSlot: 1 } },
    );
    await expect(
      Turn.updateOne(
        { _id: priority.turn.queuedTurnId },
        {
          $set: {
            status: 'claimed',
            claimId: 'legacy-priority-claim',
            claimBy: 'legacy-worker',
            claimUntil: new Date(LATER.getTime() + 60_000),
          },
        },
      ),
    ).resolves.toMatchObject({ modifiedCount: 1 });
    await expect(
      Turn.updateOne(
        { _id: priority.turn.queuedTurnId },
        {
          $set: {
            admissionId: 'legacy-priority-claim',
            admissionStartedAt: new Date(LATER.getTime() + 1),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('reconciles a root admission through explicit lineage without a timestamp boundary', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'root-lineage-reconciliation' }),
    );
    const deliveryKey = 'root-lineage-delivery';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey,
      scheduledAt: START,
    });
    const queuedClaim = claimInput(queued.turn.queuedTurnId, { claimId: deliveryKey });
    await methods.claimNextAgentQueuedTurn(queuedClaim);
    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...queuedClaim,
        admissionId: deliveryKey,
        startedAt: START,
      }),
    ).resolves.toMatchObject({
      outcome: 'started',
      turn: { admissionLineagePredecessorId: rootLineageId() },
    });
    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
        admissionEvidence: { generationId: 'root-generation', generationCreatedAt: 42 },
      }),
    ).resolves.toMatchObject({
      outcome: 'admission_reconciled',
      turn: {
        status: 'admitted',
        terminalReceipt: {
          generationId: 'root-generation',
          generationCreatedAt: 42,
          lineagePredecessorId: rootLineageId(),
          rootPredecessor: true,
        },
      },
    });
  });

  it('reconstructs a pre-upgrade chained boundary during exact-evidence reconciliation', async () => {
    const predecessor = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'reconciled-predecessor',
        expectedPredecessorCreatedAt: 40,
      }),
    );
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'reconciled-admission', expectedPredecessorCreatedAt: 40 }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: predecessor.turn.queuedTurnId,
      deliveryKey: 'delivery-reconciled-predecessor',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: predecessor.turn.queuedTurnId,
      deliveryKey: 'delivery-reconciled-predecessor',
      scheduledAt: START,
    });
    const predecessorClaim = claimInput(predecessor.turn.queuedTurnId, {
      claimId: 'delivery-reconciled-predecessor',
    });
    await methods.claimNextAgentQueuedTurn(predecessorClaim);
    await methods.beginAgentQueuedTurnAdmission({
      ...predecessorClaim,
      admissionId: 'delivery-reconciled-predecessor',
      startedAt: START,
    });
    await methods.markAgentQueuedTurnAdmitted({
      ...predecessorClaim,
      admissionId: 'delivery-reconciled-predecessor',
      admissionMode: 'ordinary',
      generationId: 'generation-predecessor',
      generationCreatedAt: 41,
      effectivePredecessorCreatedAt: 40,
      lineagePredecessorId: rootLineageId(),
      settledAt: START,
    });
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-reconciled-admission',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-reconciled-admission',
      scheduledAt: START,
    });
    const admissionClaim = claimInput(queued.turn.queuedTurnId, {
      claimId: 'delivery-reconciled-admission',
    });
    await expect(methods.claimNextAgentQueuedTurn(admissionClaim)).resolves.toMatchObject({
      outcome: 'acquired',
    });
    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...admissionClaim,
        admissionId: 'delivery-reconciled-admission',
        startedAt: START,
      }),
    ).resolves.toMatchObject({
      outcome: 'started',
      turn: { expectedPredecessorCreatedAt: 40 },
    });

    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey: 'delivery-reconciled-admission',
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
        admissionEvidence: {
          generationId: 'generation-reconciled',
          generationCreatedAt: 42,
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'admission_reconciled',
      turn: {
        status: 'admitted',
        terminalReceipt: {
          admissionId: 'delivery-reconciled-admission',
          generationId: 'generation-reconciled',
          generationCreatedAt: 42,
          effectivePredecessorCreatedAt: 41,
        },
      },
    });
  });

  it('reconciles a quarantined admission after exact evidence arrives and unblocks its successor', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'late-reconciled-admission',
        expectedPredecessorCreatedAt: 41,
      }),
    );
    const successor = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'late-reconciled-successor',
        expectedPredecessorCreatedAt: 41,
      }),
    );
    const deliveryKey = 'delivery-late-reconciled-admission';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey,
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(
      claimInput(first.turn.queuedTurnId, { claimId: deliveryKey }),
    );
    await methods.beginAgentQueuedTurnAdmission({
      ...claimInput(first.turn.queuedTurnId, { claimId: deliveryKey }),
      admissionId: deliveryKey,
      startedAt: START,
    });
    await methods.deadLetterAgentQueuedTurn({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey,
      settledAt: LATER,
      failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
    });

    await expect(
      methods.claimQueuedTurnsForAdmissionReconciliation({
        claimId: 'reconciliation-1',
        claimBy: 'reconciler-1',
        now: new Date(LATER.getTime() + 1),
        leaseUntil: new Date(LATER.getTime() + 60_001),
      }),
    ).resolves.toMatchObject([{ queuedTurnId: first.turn.queuedTurnId }]);
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(successor.turn.queuedTurnId, { claimId: 'successor-delivery' }),
      ),
    ).resolves.toMatchObject({ outcome: 'blocked' });
    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: first.turn.queuedTurnId,
        deliveryKey,
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
        admissionEvidence: {
          generationId: 'generation-late-reconciled',
          generationCreatedAt: 43,
        },
      }),
    ).resolves.toMatchObject({ outcome: 'admission_reconciled', turn: { status: 'admitted' } });
    await expect(
      methods.claimQueuedTurnsForAdmissionReconciliation({
        claimId: 'reconciliation-2',
        claimBy: 'reconciler-1',
        now: new Date(LATER.getTime() + 1),
        leaseUntil: new Date(LATER.getTime() + 60_001),
      }),
    ).resolves.toEqual([]);
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(successor.turn.queuedTurnId, { claimId: 'successor-delivery' }),
      ),
    ).resolves.toMatchObject({ outcome: 'acquired' });
  });

  it('keeps protocol-v2 job evidence indeterminate until the exact source receipt arrives', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'source-fenced-evidence' }),
    );
    const successor = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'source-fenced-successor' }),
    );
    const deliveryKey = 'source-fenced-delivery';
    const claim = claimInput(first.turn.queuedTurnId, { claimId: deliveryKey });
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey,
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(claim);
    await methods.beginAgentQueuedTurnAdmission({
      ...claim,
      admissionId: deliveryKey,
      startedAt: START,
      admissionProtocolVersion: 2,
    });

    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: first.turn.queuedTurnId,
        deliveryKey,
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'source receipt unavailable' },
        admissionEvidence: {
          generationId: 'transient-job-generation',
          generationCreatedAt: 43,
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'admission_indeterminate',
      turn: {
        status: 'claimed',
        admissionProtocolVersion: 2,
        admissionSlot: true,
        terminalReceipt: { failure: { code: 'ADMISSION_INDETERMINATE' } },
      },
    });
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(successor.turn.queuedTurnId, { claimId: 'source-fenced-successor' }),
      ),
    ).resolves.toMatchObject({ outcome: 'blocked' });

    /** A protocol-v2 owner created before admission slots existed can already
     * be in the legacy dead shell when its authoritative source receipt lands. */
    await Turn.updateOne(
      { _id: first.turn.queuedTurnId },
      {
        $set: { status: 'dead' },
        $unset: { admissionSlot: 1, claimId: 1, claimBy: 1, claimUntil: 1 },
      },
    );

    await expect(
      methods.markAgentQueuedTurnAdmitted({
        ...claim,
        admissionId: deliveryKey,
        admissionMode: 'ordinary',
        generationId: 'exact-source-generation',
        generationCreatedAt: 44,
        lineagePredecessorId: rootLineageId(),
        settledAt: new Date(LATER.getTime() + 1),
      }),
    ).resolves.toMatchObject({ outcome: 'admitted', turn: { status: 'admitted' } });
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(successor.turn.queuedTurnId, { claimId: 'source-fenced-successor' }),
      ),
    ).resolves.toMatchObject({ outcome: 'acquired' });
  });

  it('leases reconciliation fairly while preserving a late exact receipt', async () => {
    const quarantine = async (conversationId: string, clientRequestId: string) => {
      const queued = await methods.enqueueAgentQueuedTurn(
        enqueueInput({ conversationId, clientRequestId }),
      );
      const deliveryKey = `delivery-${clientRequestId}`;
      const scope = { user, tenantId: 'tenant-1', conversationId };
      await methods.reserveAgentQueuedTurnDelivery({
        ...scope,
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
      });
      await methods.markQueuedTurnScheduled({
        ...scope,
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
        scheduledAt: START,
      });
      const claim = {
        ...scope,
        queuedTurnId: queued.turn.queuedTurnId,
        claimId: deliveryKey,
        claimBy: 'worker-1',
        now: START,
        leaseUntil: LATER,
      };
      await methods.claimNextAgentQueuedTurn(claim);
      await methods.beginAgentQueuedTurnAdmission({
        ...claim,
        admissionId: deliveryKey,
        startedAt: START,
        admissionProtocolVersion: 2,
      });
      await methods.deadLetterAgentQueuedTurn({
        ...scope,
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
      });
      return { queued, deliveryKey, claim };
    };
    const first = await quarantine('conversation-1', 'reconciliation-fair-1');
    const second = await quarantine('conversation-2', 'reconciliation-fair-2');
    const claimNow = new Date(LATER.getTime() + 1);
    const firstBatch = await methods.claimQueuedTurnsForAdmissionReconciliation({
      claimId: 'reconciliation-fair-claim-1',
      claimBy: 'reconciler-1',
      now: claimNow,
      leaseUntil: new Date(claimNow.getTime() + 60_000),
      limit: 1,
    });
    expect(firstBatch).toMatchObject([{ queuedTurnId: first.queued.turn.queuedTurnId }]);
    await methods.deferAgentQueuedTurnAdmissionReconciliation({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.queued.turn.queuedTurnId,
      deliveryKey: first.deliveryKey,
      claimId: 'reconciliation-fair-claim-1',
      claimBy: 'reconciler-1',
      availableAt: new Date(claimNow.getTime() + 60_000),
    });

    const secondBatch = await methods.claimQueuedTurnsForAdmissionReconciliation({
      claimId: 'reconciliation-fair-claim-2',
      claimBy: 'reconciler-1',
      now: claimNow,
      leaseUntil: new Date(claimNow.getTime() + 60_000),
      limit: 1,
    });
    expect(secondBatch).toMatchObject([{ queuedTurnId: second.queued.turn.queuedTurnId }]);
    await expect(
      methods.deferAgentQueuedTurnAdmissionReconciliation({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-2',
        queuedTurnId: second.queued.turn.queuedTurnId,
        deliveryKey: second.deliveryKey,
        claimId: 'reconciliation-fair-claim-2',
        claimBy: 'reconciler-1',
        availableAt: new Date(claimNow.getTime() + 60_000),
      }),
    ).resolves.toBe(true);
    await expect(
      methods.markAgentQueuedTurnAdmitted({
        ...second.claim,
        admissionId: second.deliveryKey,
        admissionMode: 'ordinary',
        generationId: 'generation-late-proof',
        generationCreatedAt: 44,
        lineagePredecessorId: rootLineageId(),
        settledAt: new Date(claimNow.getTime() + 1),
      }),
    ).resolves.toMatchObject({ outcome: 'admitted', turn: { status: 'admitted' } });
  });

  it('scopes effective predecessor epochs to one captured queue root', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'root-a-1', expectedPredecessorCreatedAt: 10 }),
    );
    const sameRoot = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'root-a-2', expectedPredecessorCreatedAt: 10 }),
    );
    const laterRoot = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'root-b-1',
        parentMessageId: 'parent-2',
        expectedPredecessorCreatedAt: 10,
      }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey: 'admission-root-a',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey: 'admission-root-a',
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(claimInput(first.turn.queuedTurnId));
    await methods.beginAgentQueuedTurnAdmission({
      ...claimInput(first.turn.queuedTurnId),
      admissionId: 'admission-root-a',
      startedAt: START,
    });
    await methods.markAgentQueuedTurnAdmitted({
      ...claimInput(first.turn.queuedTurnId),
      admissionId: 'admission-root-a',
      admissionMode: 'ordinary',
      generationCreatedAt: 11,
      effectivePredecessorCreatedAt: 10,
      lineagePredecessorId: rootLineageId(),
      settledAt: START,
    });

    await expect(
      methods.getEffectiveAgentQueuedTurnPredecessor({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        sequence: sameRoot.turn.sequence,
        rootParentMessageId: 'parent-1',
        expectedPredecessorCreatedAt: 10,
      }),
    ).resolves.toEqual({
      effectivePredecessorCreatedAt: 11,
      lineagePredecessorId: first.turn.queuedTurnId,
    });
    await expect(
      methods.getEffectiveAgentQueuedTurnPredecessor({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        sequence: laterRoot.turn.sequence,
        rootParentMessageId: 'parent-2',
        expectedPredecessorCreatedAt: 10,
      }),
    ).resolves.toEqual({
      effectivePredecessorCreatedAt: 10,
      lineagePredecessorId: rootLineageId('parent-2'),
    });

    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: sameRoot.turn.queuedTurnId,
      deliveryKey: 'admission-root-a-2',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: sameRoot.turn.queuedTurnId,
      deliveryKey: 'admission-root-a-2',
      scheduledAt: START,
    });
    const sameRootClaim = claimInput(sameRoot.turn.queuedTurnId, {
      claimId: 'admission-root-a-2',
    });
    await methods.claimNextAgentQueuedTurn(sameRootClaim);
    await methods.beginAgentQueuedTurnAdmission({
      ...sameRootClaim,
      admissionId: 'admission-root-a-2',
      startedAt: START,
    });
    await methods.markAgentQueuedTurnAdmitted({
      ...sameRootClaim,
      admissionId: 'admission-root-a-2',
      admissionMode: 'ordinary',
      generationCreatedAt: 12,
      effectivePredecessorCreatedAt: 11,
      lineagePredecessorId: first.turn.queuedTurnId,
      settledAt: START,
    });
    await expect(
      methods.getAgentQueuedTurnByClientRequestId({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        clientRequestId: 'root-a-2',
      }),
    ).resolves.toMatchObject({
      terminalReceipt: { effectivePredecessorCreatedAt: 11 },
    });
  });

  it('uses queued-turn identity when consecutive generations share a timestamp', async () => {
    const first = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'same-timestamp-first', expectedPredecessorCreatedAt: 10 }),
    );
    const second = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'same-timestamp-second', expectedPredecessorCreatedAt: 10 }),
    );
    const firstDelivery = 'same-timestamp-first-delivery';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey: firstDelivery,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: first.turn.queuedTurnId,
      deliveryKey: firstDelivery,
      scheduledAt: START,
    });
    const firstClaim = claimInput(first.turn.queuedTurnId, { claimId: firstDelivery });
    await methods.claimNextAgentQueuedTurn(firstClaim);
    await methods.beginAgentQueuedTurnAdmission({
      ...firstClaim,
      admissionId: firstDelivery,
      startedAt: START,
    });
    await methods.markAgentQueuedTurnAdmitted({
      ...firstClaim,
      admissionId: firstDelivery,
      admissionMode: 'ordinary',
      generationCreatedAt: 10,
      effectivePredecessorCreatedAt: 10,
      lineagePredecessorId: rootLineageId(),
      settledAt: START,
    });

    const secondDelivery = 'same-timestamp-second-delivery';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: second.turn.queuedTurnId,
      deliveryKey: secondDelivery,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: second.turn.queuedTurnId,
      deliveryKey: secondDelivery,
      scheduledAt: LATER,
    });
    const secondClaim = claimInput(second.turn.queuedTurnId, {
      claimId: secondDelivery,
      now: LATER,
      leaseUntil: new Date(LATER.getTime() + 60_000),
    });
    await methods.claimNextAgentQueuedTurn(secondClaim);
    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...secondClaim,
        admissionId: secondDelivery,
        startedAt: LATER,
      }),
    ).resolves.toMatchObject({
      outcome: 'started',
      turn: {
        admissionEffectivePredecessorCreatedAt: 10,
        admissionLineagePredecessorId: first.turn.queuedTurnId,
      },
    });
  });

  it('fails closed when an admitted predecessor lacks generation evidence', async () => {
    const incomplete = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'incomplete-predecessor', expectedPredecessorCreatedAt: 10 }),
    );
    const target = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'after-incomplete-predecessor',
        expectedPredecessorCreatedAt: 10,
      }),
    );
    await Turn.updateOne(
      { _id: incomplete.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            effectivePredecessorCreatedAt: 10,
            lineagePredecessorId: rootLineageId(),
          },
        },
        $unset: { activeSlot: 1 },
      },
    );
    const deliveryKey = 'after-incomplete-delivery';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: target.turn.queuedTurnId,
      deliveryKey,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: target.turn.queuedTurnId,
      deliveryKey,
      scheduledAt: START,
    });
    const targetClaim = claimInput(target.turn.queuedTurnId, { claimId: deliveryKey });
    await methods.claimNextAgentQueuedTurn(targetClaim);
    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...targetClaim,
        admissionId: deliveryKey,
        startedAt: START,
      }),
    ).resolves.toMatchObject({
      outcome: 'order_unavailable',
      turn: {
        status: 'dead',
        terminalReceipt: {
          failure: { code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE' },
        },
      },
    });
  });

  it('derives the predecessor from admission order when priority overtakes sequence', async () => {
    const normal = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'priority-normal', expectedPredecessorCreatedAt: 10 }),
    );
    const priority = await methods.enqueueAgentQueuedTurn(
      enqueueInput({
        clientRequestId: 'priority-overtake',
        expectedPredecessorCreatedAt: 10,
        priority: true,
      }),
    );
    const priorityDelivery = 'admission-priority-overtake';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: priority.turn.queuedTurnId,
      deliveryKey: priorityDelivery,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: priority.turn.queuedTurnId,
      deliveryKey: priorityDelivery,
      scheduledAt: START,
    });
    const priorityClaim = claimInput(priority.turn.queuedTurnId, {
      claimId: priorityDelivery,
    });
    await expect(methods.claimNextAgentQueuedTurn(priorityClaim)).resolves.toMatchObject({
      outcome: 'acquired',
    });
    await methods.beginAgentQueuedTurnAdmission({
      ...priorityClaim,
      admissionId: priorityDelivery,
      startedAt: START,
    });
    await methods.markAgentQueuedTurnAdmitted({
      ...priorityClaim,
      admissionId: priorityDelivery,
      admissionMode: 'ordinary',
      generationCreatedAt: 11,
      effectivePredecessorCreatedAt: 10,
      lineagePredecessorId: rootLineageId(),
      settledAt: START,
    });

    await Turn.updateOne(
      { _id: priority.turn.queuedTurnId },
      {
        $unset: {
          'terminalReceipt.effectivePredecessorCreatedAt': 1,
          'terminalReceipt.lineagePredecessorId': 1,
        },
      },
    );
    await expect(
      methods.getEffectiveAgentQueuedTurnPredecessor({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        sequence: normal.turn.sequence,
        rootParentMessageId: 'parent-1',
        expectedPredecessorCreatedAt: 10,
        allowLegacyPredecessorInference: true,
      }),
    ).resolves.toEqual({
      effectivePredecessorCreatedAt: 11,
      lineagePredecessorId: priority.turn.queuedTurnId,
    });
    await Turn.updateOne(
      { _id: priority.turn.queuedTurnId },
      {
        $set: {
          'terminalReceipt.effectivePredecessorCreatedAt': 10,
          'terminalReceipt.lineagePredecessorId': rootLineageId(),
        },
      },
    );

    const normalDelivery = 'admission-priority-normal';
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: normal.turn.queuedTurnId,
      deliveryKey: normalDelivery,
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: normal.turn.queuedTurnId,
      deliveryKey: normalDelivery,
      scheduledAt: START,
    });
    const normalClaim = claimInput(normal.turn.queuedTurnId, { claimId: normalDelivery });
    await expect(methods.claimNextAgentQueuedTurn(normalClaim)).resolves.toMatchObject({
      outcome: 'acquired',
    });
    await methods.beginAgentQueuedTurnAdmission({
      ...normalClaim,
      admissionId: normalDelivery,
      startedAt: LATER,
    });
    await methods.markAgentQueuedTurnAdmitted({
      ...normalClaim,
      admissionId: normalDelivery,
      admissionMode: 'ordinary',
      generationCreatedAt: 12,
      effectivePredecessorCreatedAt: 11,
      lineagePredecessorId: priority.turn.queuedTurnId,
      settledAt: LATER,
    });
    await Turn.updateOne(
      { _id: normal.turn.queuedTurnId },
      { $unset: { 'terminalReceipt.effectivePredecessorCreatedAt': 1 } },
    );

    await expect(
      methods.getAgentQueuedTurnByClientRequestId({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        clientRequestId: 'priority-normal',
      }),
    ).resolves.toMatchObject({
      terminalReceipt: { effectivePredecessorCreatedAt: 11 },
    });

    await Turn.updateMany(
      { _id: { $in: [priority.turn.queuedTurnId, normal.turn.queuedTurnId] } },
      {
        $unset: {
          'terminalReceipt.effectivePredecessorCreatedAt': 1,
          'terminalReceipt.lineagePredecessorId': 1,
        },
      },
    );
    const ambiguous = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'priority-ambiguous', expectedPredecessorCreatedAt: 10 }),
    );
    await expect(
      methods.getEffectiveAgentQueuedTurnPredecessor({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        sequence: ambiguous.turn.sequence,
        rootParentMessageId: 'parent-1',
        expectedPredecessorCreatedAt: 10,
      }),
    ).resolves.toBeNull();
  });

  it('rejects an inferred legacy edge that reconnects to an exact-edge tail', async () => {
    const exact = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'cycle-exact', expectedPredecessorCreatedAt: 10 }),
    );
    const legacy = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'cycle-legacy', expectedPredecessorCreatedAt: 10 }),
    );
    const target = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'cycle-target', expectedPredecessorCreatedAt: 10 }),
    );
    await Turn.updateOne(
      { _id: exact.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            generationCreatedAt: 11,
            effectivePredecessorCreatedAt: 10,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );
    await Turn.updateOne(
      { _id: legacy.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            generationCreatedAt: 11,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );

    await expect(
      methods.getEffectiveAgentQueuedTurnPredecessor({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        sequence: target.turn.sequence,
        rootParentMessageId: 'parent-1',
        expectedPredecessorCreatedAt: 10,
        allowLegacyPredecessorInference: true,
      }),
    ).resolves.toBeNull();
  });

  it('does not repair a legacy receipt through its successor edge', async () => {
    const target = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'repair-target', expectedPredecessorCreatedAt: 10 }),
    );
    const successor = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'repair-successor', expectedPredecessorCreatedAt: 10 }),
    );
    await Turn.updateOne(
      { _id: target.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: START,
            generationCreatedAt: 10,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );
    await Turn.updateOne(
      { _id: successor.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: LATER,
            generationCreatedAt: 11,
            effectivePredecessorCreatedAt: 10,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );

    const repaired = await methods.getAgentQueuedTurnByClientRequestId({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      clientRequestId: 'repair-target',
    });
    expect(repaired?.terminalReceipt?.effectivePredecessorCreatedAt).toBeUndefined();
  });

  it('keeps exact late evidence quarantined behind an ambiguous legacy successor', async () => {
    const target = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'reconcile-target', expectedPredecessorCreatedAt: 10 }),
    );
    const successor = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'reconcile-successor', expectedPredecessorCreatedAt: 10 }),
    );
    const deliveryKey = 'reconcile-target-delivery';
    await Turn.updateOne(
      { _id: target.turn.queuedTurnId },
      {
        $set: {
          status: 'claimed',
          deliveryKey,
          deliveryState: 'published',
          claimId: deliveryKey,
          claimBy: 'worker-1',
          claimUntil: LATER,
          admissionId: deliveryKey,
          admissionStartedAt: START,
        },
      },
    );
    await Turn.updateOne(
      { _id: successor.turn.queuedTurnId },
      {
        $set: {
          status: 'admitted',
          terminalReceipt: {
            outcome: 'admitted',
            settledAt: LATER,
            generationCreatedAt: 11,
            effectivePredecessorCreatedAt: 10,
          },
        },
        $unset: { activeSlot: 1 },
      },
    );

    await expect(
      methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: target.turn.queuedTurnId,
        deliveryKey,
        settledAt: LATER,
        failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'result unavailable' },
        admissionEvidence: { generationCreatedAt: 10 },
      }),
    ).resolves.toMatchObject({
      outcome: 'admission_indeterminate',
      turn: {
        status: 'claimed',
        terminalReceipt: {
          failure: { code: 'ADMISSION_INDETERMINATE' },
        },
      },
    });
  });

  it('projects the newest failures when more than 100 dead receipts await dismissal', async () => {
    const deadIds: string[] = [];
    for (let index = 0; index < 101; index++) {
      const queued = await methods.enqueueAgentQueuedTurn(
        enqueueInput({ clientRequestId: `dead-${index}`, text: `dead ${index}` }),
      );
      const deliveryKey = `delivery-${index}`;
      await methods.reserveAgentQueuedTurnDelivery({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
      });
      await methods.markQueuedTurnScheduled({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
        scheduledAt: START,
      });
      await methods.deadLetterAgentQueuedTurn({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        queuedTurnId: queued.turn.queuedTurnId,
        deliveryKey,
        settledAt: START,
        failure: { code: 'FAILED', message: `failure ${index}` },
      });
      deadIds.push(queued.turn.queuedTurnId);
    }

    const receipts = await methods.listAgentQueuedTurnReceipts({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
    });
    expect(receipts).toHaveLength(100);
    expect(receipts.map((turn) => turn.queuedTurnId)).toContain(deadIds[100]);
    expect(receipts.map((turn) => turn.queuedTurnId)).not.toContain(deadIds[0]);
  });

  it('isolates owner, tenant, and conversation scopes and drains or deletes exact scopes', async () => {
    const otherUser = new mongoose.Types.ObjectId();
    await Promise.all([
      methods.enqueueAgentQueuedTurn(enqueueInput({ clientRequestId: 'keep', text: 'keep' })),
      methods.enqueueAgentQueuedTurn(
        enqueueInput({
          clientRequestId: 'other-conversation',
          conversationId: 'conversation-2',
          text: 'other conversation',
        }),
      ),
      methods.enqueueAgentQueuedTurn(
        enqueueInput({
          clientRequestId: 'other-user',
          user: otherUser,
          text: 'other user',
        }),
      ),
    ]);

    expect(
      await methods.drainAgentQueuedTurns({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        settledAt: START,
      }),
    ).toBe(1);
    expect(
      await methods.deleteAgentQueuedTurns({
        user,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
      }),
    ).toBe(1);
    expect(await Turn.countDocuments()).toBe(2);
    expect(await Sequence.countDocuments()).toBe(2);
  });

  it('purges a user across every tenant while preserving other users', async () => {
    const otherUser = new mongoose.Types.ObjectId();
    await Promise.all([
      methods.enqueueAgentQueuedTurn(enqueueInput({ clientRequestId: 'tenant-one' })),
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ tenantId: 'tenant-2', clientRequestId: 'tenant-two' }),
      ),
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ tenantId: undefined, clientRequestId: 'untenant' }),
      ),
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ user: otherUser, clientRequestId: 'other-user' }),
      ),
    ]);

    await expect(methods.deleteAllAgentQueuedTurnsForUser({ user })).resolves.toBe(3);
    expect(await Turn.countDocuments({ user })).toBe(0);
    expect(await Sequence.countDocuments({ user })).toBe(0);
    expect(await Turn.countDocuments({ user: otherUser })).toBe(1);
    expect(await Sequence.countDocuments({ user: otherUser })).toBe(1);
  });

  it('prepares conversation deletion for replay-safe delivery retirement before payload purge', async () => {
    const tenantOne = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'delete-tenant-one' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: tenantOne.turn.queuedTurnId,
      deliveryKey: 'delivery-delete-one',
    });
    await Sequence.updateOne(
      { user, tenantId: 'tenant-1', conversationId: 'conversation-1' },
      {
        $set: {
          writerId: 'enqueue-in-flight',
          writerUntil: new Date(Date.now() + 25),
        },
      },
    );
    await methods.enqueueAgentQueuedTurn(
      enqueueInput({ tenantId: 'tenant-2', clientRequestId: 'delete-tenant-two' }),
    );
    await methods.enqueueAgentQueuedTurn(
      enqueueInput({ conversationId: 'conversation-2', clientRequestId: 'keep-conversation' }),
    );
    const untouched = await Turn.find({ _id: { $ne: tenantOne.turn.queuedTurnId } })
      .sort('_id')
      .lean();

    await expect(
      methods.prepareAgentQueuedTurnConversationDeletion({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
        settledAt: START,
      }),
    ).resolves.toEqual(['delivery-delete-one']);
    await expect(
      Sequence.findOne({ user, tenantId: 'tenant-1', conversationId: 'conversation-1' }).lean(),
    ).resolves.toMatchObject({ retiredAt: START });
    expect(
      await Turn.findById(tenantOne.turn.queuedTurnId).select('status terminalReceipt').lean(),
    ).toMatchObject({
      status: 'cancelled',
      terminalReceipt: { failure: { code: 'OWNER_DRAINED' } },
    });
    await expect(methods.findQueuedTurnsNeedingDelivery()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queuedTurnId: tenantOne.turn.queuedTurnId,
          deliveryState: 'publishing',
        }),
      ]),
    );
    await expect(
      methods.deletePreparedAgentQueuedTurnConversations({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      }),
    ).rejects.toThrow('deliveries must retire');
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: tenantOne.turn.queuedTurnId,
      deliveryKey: 'delivery-delete-one',
      scheduledAt: START,
    });
    await expect(
      methods.markAgentQueuedTurnDeliveryRetired({ deliveryKey: 'delivery-delete-one' }),
    ).resolves.toBe(true);
    await expect(
      methods.deletePreparedAgentQueuedTurnConversations({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      }),
    ).resolves.toBe(1);
    expect(await Turn.countDocuments({ user, conversationId: 'conversation-1' })).toBe(1);
    await expect(Turn.find().sort('_id').lean()).resolves.toEqual(untouched);
    await expect(
      methods.enqueueAgentQueuedTurn(
        enqueueInput({ clientRequestId: 'cannot-reopen-deleted-lane' }),
      ),
    ).rejects.toBeInstanceOf(AgentQueuedTurnLaneRetiredError);

    await methods.prepareAgentQueuedTurnConversationDeletion({
      user,
      targets: [{ conversationId: 'conversation-1', allTenants: true }],
      settledAt: START,
    });
    await methods.deletePreparedAgentQueuedTurnConversations({
      user,
      targets: [{ conversationId: 'conversation-1', allTenants: true }],
    });
    expect(await Turn.countDocuments({ user, conversationId: 'conversation-1' })).toBe(0);
    expect(await Turn.countDocuments({ user, conversationId: 'conversation-2' })).toBe(1);
    await expect(Turn.find({ conversationId: 'conversation-2' }).lean()).resolves.toEqual(
      untouched.filter((turn) => turn.conversationId === 'conversation-2'),
    );
  });

  it.each(['reserving', 'queued', 'claimed'] as const)(
    'only cancels selected conversation lanes with %s turns',
    async (status) => {
      const otherUser = new mongoose.Types.ObjectId();
      const scopes = [
        { conversationId: 'conversation-1', tenantId: 'tenant-1' },
        { conversationId: 'conversation-3', tenantId: undefined },
        { conversationId: 'conversation-2', tenantId: 'tenant-1' },
        { conversationId: 'conversation-1', tenantId: 'tenant-2' },
        { conversationId: 'conversation-1', tenantId: undefined },
        { conversationId: 'conversation-1', tenantId: 'tenant-1', user: otherUser },
      ];
      const turns = await Promise.all(
        scopes.map((scope, index) =>
          methods.enqueueAgentQueuedTurn(
            enqueueInput({ ...scope, clientRequestId: `isolation-${index}` }),
          ),
        ),
      );
      if (status === 'reserving') {
        await Turn.updateMany({}, { $set: { status, reservationWriterId: 'pending-writer' } });
      } else if (status === 'claimed') {
        for (const [index, scope] of scopes.entries()) {
          await expect(
            methods.claimNextAgentQueuedTurn(claimInput(turns[index].turn.queuedTurnId, scope)),
          ).resolves.toMatchObject({ outcome: 'acquired' });
        }
      }
      const untouchedIds = turns.slice(2).map(({ turn }) => turn.queuedTurnId);
      const untouched = await Turn.find({ _id: { $in: untouchedIds } })
        .sort('_id')
        .lean();
      const untouchedLanes = await Sequence.find({
        laneId: { $in: untouched.map((turn) => turn.laneId) },
      })
        .sort('_id')
        .lean();
      const input = { user, targets: scopes.slice(0, 2), settledAt: START };

      await expect(methods.prepareAgentQueuedTurnConversationDeletion(input)).resolves.toEqual([]);
      for (const { turn } of turns.slice(0, 2)) {
        await expect(Turn.findById(turn.queuedTurnId).lean()).resolves.toMatchObject({
          status: 'cancelled',
          deliveryState: 'retired',
          terminalReceipt: { failure: { code: 'OWNER_DRAINED' } },
        });
      }
      await expect(
        Turn.find({ _id: { $in: untouchedIds } })
          .sort('_id')
          .lean(),
      ).resolves.toEqual(untouched);
      await expect(methods.deletePreparedAgentQueuedTurnConversations(input)).resolves.toBe(2);
      await expect(Turn.find().sort('_id').lean()).resolves.toEqual(untouched);
      await expect(
        Sequence.find({ laneId: { $in: untouched.map((turn) => turn.laneId) } })
          .sort('_id')
          .lean(),
      ).resolves.toEqual(untouchedLanes);
    },
  );

  it.each([
    { name: 'tenant-scoped', targets: [{ conversationId: 'empty-chat', tenantId: 'tenant-1' }] },
    { name: 'legacy tenantless', targets: [{ conversationId: 'conversation-1' }] },
    {
      name: 'another tenant',
      targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-2' }],
    },
    { name: 'all tenants', targets: [{ conversationId: 'empty-chat', allTenants: true as const }] },
  ])(
    'deletes an empty $name conversation despite an unrelated published delivery',
    async ({ targets }) => {
      const queued = await methods.enqueueAgentQueuedTurn(enqueueInput());
      const deliveryKey = 'unrelated-published-delivery';
      const delivery = { ...claimInput(queued.turn.queuedTurnId), deliveryKey };
      await methods.reserveAgentQueuedTurnDelivery(delivery);
      await methods.markQueuedTurnScheduled({ ...delivery, scheduledAt: START });
      await methods.claimNextAgentQueuedTurn(delivery);
      await methods.beginAgentQueuedTurnAdmission({
        ...delivery,
        admissionId: deliveryKey,
        startedAt: START,
      });
      await methods.markAgentQueuedTurnAdmitted({
        ...delivery,
        admissionId: deliveryKey,
        admissionMode: 'ordinary',
        generationCreatedAt: 42,
        lineagePredecessorId: rootLineageId(),
        settledAt: LATER,
      });
      const untouched = await Turn.findById(queued.turn.queuedTurnId).lean();
      expect(untouched).toMatchObject({ status: 'admitted', deliveryState: 'published' });
      const lane = await Sequence.findOne({ laneId: untouched?.laneId }).lean();
      const input = { user, targets, settledAt: START };

      await expect(methods.prepareAgentQueuedTurnConversationDeletion(input)).resolves.toEqual([]);
      await expect(methods.deletePreparedAgentQueuedTurnConversations(input)).resolves.toBe(0);
      await expect(methods.prepareAgentQueuedTurnConversationDeletion(input)).resolves.toEqual([]);
      await expect(methods.deletePreparedAgentQueuedTurnConversations(input)).resolves.toBe(0);
      await expect(Turn.findById(queued.turn.queuedTurnId).lean()).resolves.toEqual(untouched);
      await expect(Sequence.findOne({ laneId: untouched?.laneId }).lean()).resolves.toEqual(lane);
    },
  );

  it('includes preexisting dead deliveries in conversation retirement', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'dead-before-delete' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-dead-before-delete',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-dead-before-delete',
      scheduledAt: START,
    });
    const claim = await methods.claimNextAgentQueuedTurn(claimInput(queued.turn.queuedTurnId));
    expect(claim.outcome).toBe('acquired');
    if (claim.outcome !== 'acquired') {
      throw new Error('Expected queued-turn claim');
    }
    await methods.releaseAgentQueuedTurn({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      claimId: claim.claim.claimId,
      claimBy: claim.claim.claimBy,
      disposition: 'dead',
      settledAt: START,
      failure: { code: 'TEST_DEAD', message: 'dead before conversation deletion' },
    });

    await expect(
      methods.prepareAgentQueuedTurnConversationDeletion({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      }),
    ).resolves.toEqual(['delivery-dead-before-delete']);
  });

  it('keeps an admission-crossing delivery and its conversation until admission settles', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'admission-during-delete' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-admission-during-delete',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-admission-during-delete',
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(claimInput(queued.turn.queuedTurnId));
    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...claimInput(queued.turn.queuedTurnId),
        admissionId: 'delivery-admission-during-delete',
        startedAt: START,
      }),
    ).resolves.toMatchObject({ outcome: 'started' });

    await expect(
      methods.prepareAgentQueuedTurnConversationDeletion({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
        settledAt: START,
      }),
    ).rejects.toThrow('admission must settle');
    await expect(Turn.findById(queued.turn.queuedTurnId).lean()).resolves.toMatchObject({
      status: 'claimed',
      admissionId: 'delivery-admission-during-delete',
    });
    await expect(
      Sequence.findOne({ user, tenantId: 'tenant-1', conversationId: 'conversation-1' }).lean(),
    ).resolves.not.toHaveProperty('retiredAt');

    await methods.markAgentQueuedTurnAdmitted({
      ...claimInput(queued.turn.queuedTurnId),
      admissionId: 'delivery-admission-during-delete',
      admissionMode: 'ordinary',
      generationCreatedAt: 42,
      lineagePredecessorId: rootLineageId(),
      settledAt: LATER,
    });
    await expect(
      methods.prepareAgentQueuedTurnConversationDeletion({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
        settledAt: LATER,
      }),
    ).resolves.toEqual(['delivery-admission-during-delete']);
    await expect(
      methods.deletePreparedAgentQueuedTurnConversations({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      }),
    ).rejects.toThrow('deliveries must retire');
    await expect(
      methods.markAgentQueuedTurnDeliveryRetired({
        deliveryKey: 'delivery-admission-during-delete',
      }),
    ).resolves.toBe(true);
    await expect(
      methods.deletePreparedAgentQueuedTurnConversations({
        user,
        targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      }),
    ).resolves.toBe(1);
  });

  it('fences a stale writer that resumes after conversation deletion', async () => {
    const remoteMethods = createAgentQueuedTurnMethods(mongoose);
    const originalDistinct = Turn.distinct.bind(Turn);
    let releaseDistinct!: () => void;
    let reportDistinct!: () => void;
    const distinctReleased = new Promise<void>((resolve) => {
      releaseDistinct = resolve;
    });
    const distinctReached = new Promise<void>((resolve) => {
      reportDistinct = resolve;
    });
    const distinctSpy = jest.spyOn(Turn, 'distinct').mockImplementationOnce(
      (...args: Parameters<typeof Turn.distinct>) =>
        (async () => {
          const result = await originalDistinct(...args);
          reportDistinct();
          await distinctReleased;
          return result;
        })() as ReturnType<typeof Turn.distinct>,
    );
    const enqueue = methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'stale-writer-after-delete' }),
    );
    await distinctReached;
    await Sequence.updateOne(
      { user, tenantId: 'tenant-1', conversationId: 'conversation-1' },
      { $set: { writerUntil: new Date(0) } },
    );
    await remoteMethods.prepareAgentQueuedTurnConversationDeletion({
      user,
      targets: [{ conversationId: 'conversation-1', tenantId: 'tenant-1' }],
      settledAt: START,
    });
    const retiredLane = await Sequence.findOne({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
    }).lean();
    await Sequence.deleteOne({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      retiredAt: START,
    });
    releaseDistinct();
    await expect(enqueue).rejects.toThrow('lane writer lease was lost');
    distinctSpy.mockRestore();

    const recreated = await remoteMethods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'recreated-lane-generation' }),
    );
    expect(recreated.turn.laneId).not.toBe(retiredLane?.laneId);

    await expect(remoteMethods.findQueuedTurnsNeedingDelivery()).resolves.toEqual([
      expect.objectContaining({ queuedTurnId: recreated.turn.queuedTurnId, status: 'queued' }),
    ]);
    await expect(
      Turn.findOne({ clientRequestId: 'stale-writer-after-delete' }).lean(),
    ).resolves.toMatchObject({ status: 'cancelled', deliveryState: 'retired' });
  });

  it('terminalizes an obsolete claimed row before a recreated lane can continue', async () => {
    const obsolete = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'obsolete-lane-claim' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: obsolete.turn.queuedTurnId,
      deliveryKey: 'delivery-obsolete-lane',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: obsolete.turn.queuedTurnId,
      deliveryKey: 'delivery-obsolete-lane',
      scheduledAt: START,
    });
    await methods.claimNextAgentQueuedTurn(
      claimInput(obsolete.turn.queuedTurnId, { claimId: 'delivery-obsolete-lane' }),
    );
    await Sequence.deleteOne({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
    });
    const successor = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'recreated-lane-successor' }),
    );
    expect(successor.turn.sequence).toBeGreaterThan(obsolete.turn.sequence);
    expect(successor.turn.laneId).not.toBe(obsolete.turn.laneId);

    await expect(
      methods.beginAgentQueuedTurnAdmission({
        ...claimInput(obsolete.turn.queuedTurnId, { claimId: 'delivery-obsolete-lane' }),
        admissionId: 'delivery-obsolete-lane',
        startedAt: LATER,
      }),
    ).resolves.toMatchObject({
      outcome: 'retired',
      turn: {
        status: 'cancelled',
        terminalReceipt: { failure: { code: 'LANE_RETIRED' } },
      },
    });
    await expect(
      methods.claimNextAgentQueuedTurn(
        claimInput(successor.turn.queuedTurnId, {
          claimId: 'delivery-successor',
          now: LATER,
          leaseUntil: new Date(LATER.getTime() + 60_000),
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'acquired' });
  });

  it('expires deletion fences after the bounded stale-writer safety window', async () => {
    await methods.prepareAgentQueuedTurnConversationDeletion({
      user,
      targets: [{ conversationId: 'never-queued', tenantId: 'tenant-1' }],
      settledAt: START,
    });

    await expect(
      Sequence.findOne({ user, tenantId: 'tenant-1', conversationId: 'never-queued' }).lean(),
    ).resolves.toMatchObject({
      retiredAt: START,
      expiresAt: new Date(START.getTime() + 24 * 60 * 60_000),
    });
  });

  it('retires a terminal source when its published delivery receipt has expired', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'expired-delivery' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-expired',
    });
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-expired',
      scheduledAt: START,
    });
    await methods.cancelAgentQueuedTurn({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      settledAt: LATER,
    });

    await expect(
      methods.beginAgentQueuedTurnMissingDeliveryRetirement({
        deliveryKey: 'delivery-expired',
      }),
    ).resolves.toBe(true);
    await expect(
      methods.markAgentQueuedTurnMissingDeliveryRetired({ deliveryKey: 'delivery-expired' }),
    ).resolves.toBe(true);
    await expect(Turn.findById(queued.turn.queuedTurnId).lean()).resolves.toMatchObject({
      status: 'cancelled',
      deliveryState: 'retired',
    });
  });

  it('does not infer delivery absence while publication can still cross the probe', async () => {
    const queued = await methods.enqueueAgentQueuedTurn(
      enqueueInput({ clientRequestId: 'publication-races-absence' }),
    );
    await methods.reserveAgentQueuedTurnDelivery({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-publication-race',
    });
    await methods.cancelAgentQueuedTurn({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      settledAt: START,
    });

    await expect(
      methods.beginAgentQueuedTurnMissingDeliveryRetirement({
        deliveryKey: 'delivery-publication-race',
      }),
    ).resolves.toBe(false);
    await methods.markQueuedTurnScheduled({
      user,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      queuedTurnId: queued.turn.queuedTurnId,
      deliveryKey: 'delivery-publication-race',
      scheduledAt: LATER,
    });
    await expect(
      methods.beginAgentQueuedTurnMissingDeliveryRetirement({
        deliveryKey: 'delivery-publication-race',
      }),
    ).resolves.toBe(true);
    await expect(Turn.findById(queued.turn.queuedTurnId).lean()).resolves.toMatchObject({
      deliveryState: 'retiring',
    });
  });
});
