import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type {
  AgentTriggerDeliveryFailure,
  IAgentTriggerDeliveryDocument,
  IAgentTriggerLaneSequenceDocument,
  IAgentTriggerUserPurgeDocument,
} from '~/types/triggerDelivery';
import type { IUser } from '~/types/user';
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
} from '~/types/triggerDelivery';
import {
  AgentTriggerDeliveryConflictError,
  createAgentTriggerDeliveryMethods,
  recordAgentEventActorReceiptMetric,
  setAgentEventActorReceiptMetricObserver,
  AgentTriggerClaimContentionError,
  CLAIM_CAS_MAX_ATTEMPTS,
  type AgentTriggerDeliveryMethods,
} from './triggerDelivery';
import { createAgentTriggerLaneSequenceModel } from '../models/triggerLaneSequence';
import { createAgentTriggerUserPurgeModel } from '../models/triggerUserPurge';
import { createAgentTriggerDeliveryModel } from '../models/triggerDelivery';
import { createConversationModel } from '../models/convo';
import { createUserModel } from '../models/user';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('~/models/plugins/mongoMeili', () => jest.fn());

const DB_SETUP_TIMEOUT_MS = 60_000;
const START = new Date('2026-08-17T12:00:00.000Z');
let mongoServer: MongoMemoryServer;
let Delivery: Model<IAgentTriggerDeliveryDocument>;
let LaneSequence: Model<IAgentTriggerLaneSequenceDocument>;
let UserPurge: Model<IAgentTriggerUserPurgeDocument>;
let User: Model<IUser>;
let methods: AgentTriggerDeliveryMethods;
let counter = 0;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Delivery = createAgentTriggerDeliveryModel(mongoose);
  LaneSequence = createAgentTriggerLaneSequenceModel(mongoose);
  UserPurge = createAgentTriggerUserPurgeModel(mongoose);
  User = createUserModel(mongoose);
  createConversationModel(mongoose);
  await Promise.all([Delivery.init(), LaneSequence.init(), UserPurge.init(), User.init()]);
  methods = createAgentTriggerDeliveryMethods(mongoose);
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  setAgentEventActorReceiptMetricObserver();
  await Promise.all([
    Delivery.deleteMany({}),
    LaneSequence.deleteMany({}),
    UserPurge.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(() => {
  setAgentEventActorReceiptMetricObserver();
});

function enqueueInput(
  overrides: Partial<Parameters<typeof methods.enqueueAgentTriggerDelivery>[0]> = {},
) {
  counter += 1;
  return {
    deliveryKey: `trigger_${counter}`,
    fingerprint: `fingerprint_${counter}`,
    orderingKey: 'ordering-1',
    envelope: { version: 1, delivery: counter },
    user: new mongoose.Types.ObjectId(),
    tenantId: 'tenant-1',
    availableAt: START,
    ...overrides,
  };
}

function transientFailure(overrides: Partial<AgentTriggerDeliveryFailure> = {}) {
  return {
    code: 'RATE_LIMITED',
    message: 'try later',
    certainty: 'definite' as const,
    retryable: true,
    attemptedAt: START,
    status: 429,
    ...overrides,
  };
}

describe('agent trigger delivery methods', () => {
  it('never lets receipt metric failures affect storage correctness', () => {
    setAgentEventActorReceiptMetricObserver(() => {
      throw new Error('metrics unavailable');
    });

    expect(() =>
      recordAgentEventActorReceiptMetric({
        operation: 'settle',
        outcome: 'success',
        resolution: 'checkpoint_verified',
      }),
    ).not.toThrow();
  });
  it('enqueues idempotently and rejects key reuse with different content', async () => {
    const input = enqueueInput();
    const first = await methods.enqueueAgentTriggerDelivery(input);
    const replay = await methods.enqueueAgentTriggerDelivery(input);

    expect(first.replayed).toBe(false);
    expect(first.delivery).toMatchObject({ status: 'pending', attempts: 0 });
    expect(replay).toMatchObject({ replayed: true, delivery: { id: first.delivery.id } });
    await expect(
      methods.enqueueAgentTriggerDelivery({ ...input, fingerprint: 'different' }),
    ).rejects.toBeInstanceOf(AgentTriggerDeliveryConflictError);
    expect(await Delivery.countDocuments()).toBe(1);
  });

  it('keeps the original mailbox rollout semantics on idempotent replay', async () => {
    const enabled = enqueueInput({ awaitTerminalHandling: true });
    const first = await methods.enqueueAgentTriggerDelivery(enabled);
    const disabledReplay = await methods.enqueueAgentTriggerDelivery({
      ...enabled,
      awaitTerminalHandling: undefined,
    });

    expect(first.delivery.awaitTerminalHandling).toBe(true);
    expect(disabledReplay).toMatchObject({
      replayed: true,
      delivery: { id: first.delivery.id, awaitTerminalHandling: true },
    });

    const disabled = enqueueInput();
    const second = await methods.enqueueAgentTriggerDelivery(disabled);
    const enabledReplay = await methods.enqueueAgentTriggerDelivery({
      ...disabled,
      awaitTerminalHandling: true,
    });

    expect(second.delivery.awaitTerminalHandling).toBeUndefined();
    expect(enabledReplay).toMatchObject({ replayed: true, delivery: { id: second.delivery.id } });
    expect(enabledReplay.delivery.awaitTerminalHandling).toBeUndefined();
  });

  it('projects public status while enforcing API key, owner, and tenant in the query', async () => {
    const user = new mongoose.Types.ObjectId();
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        tenantId: 'tenant-1',
        envelope: {
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
          privatePayload: 'x'.repeat(1024),
        },
      }),
    );

    const status = await methods.getAgentTriggerDeliveryStatus(
      queued.delivery.deliveryKey,
      user,
      'source-key-1',
      'tenant-1',
    );

    expect(status).toEqual({
      deliveryKey: queued.delivery.deliveryKey,
      status: 'pending',
      attempts: 0,
      availableAt: START,
      createdAt: expect.any(Date),
    });
    expect(status).not.toHaveProperty('envelope');
    expect(status).not.toHaveProperty('orderingKey');
    expect(status).not.toHaveProperty('history');
    await expect(
      methods.getAgentTriggerDeliveryStatus(
        queued.delivery.deliveryKey,
        new mongoose.Types.ObjectId(),
        'source-key-1',
        'tenant-1',
      ),
    ).resolves.toBeNull();

    const internal = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        tenantId: 'tenant-1',
        envelope: { event: { source: { id: 'source-key-1', type: 'schedule' } } },
      }),
    );
    await expect(
      methods.getAgentTriggerDeliveryStatus(
        internal.delivery.deliveryKey,
        user,
        'source-key-1',
        'tenant-1',
      ),
    ).resolves.toBeNull();
    await expect(
      methods.getAgentTriggerDeliveryStatus(
        queued.delivery.deliveryKey,
        user,
        'source-key-1',
        'tenant-2',
      ),
    ).resolves.toBeNull();
    await expect(
      methods.getAgentTriggerDeliveryStatus(
        queued.delivery.deliveryKey,
        user,
        'source-key-2',
        'tenant-1',
      ),
    ).resolves.toBeNull();
  });

  it('grants one atomic winner across concurrent claims', async () => {
    await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        methods.claimNextAgentTriggerDelivery({
          workerId: `worker-${index}`,
          claimToken: `claim-${index}`,
          now: START,
          leaseUntil: new Date(START.getTime() + 60_000),
        }),
      ),
    );

    expect(claims.filter((claim) => claim != null)).toHaveLength(1);
  });

  it('surfaces exhausted claim contention as a retryable failure, not an empty queue', async () => {
    const enqueued = await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const casSpy = jest.spyOn(Delivery.collection, 'findOneAndUpdate').mockResolvedValue(null);
    try {
      await expect(
        methods.claimNextAgentTriggerDelivery({
          workerId: 'worker-contended',
          claimToken: 'claim-contended',
          now: START,
          leaseUntil: new Date(START.getTime() + 60_000),
        }),
      ).rejects.toBeInstanceOf(AgentTriggerClaimContentionError);
      expect(casSpy).toHaveBeenCalledTimes(CLAIM_CAS_MAX_ATTEMPTS);
    } finally {
      casSpy.mockRestore();
    }
    /** The losing worker owns nothing: the delivery stays claimable. */
    await expect(Delivery.findById(enqueued.delivery.id).lean()).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('keeps capability work visible but nonclaimable to pre-capability consumers', async () => {
    const user = new mongoose.Types.ObjectId();
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'legacy-visible-capability-lane',
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
    );
    const stored = await Delivery.findById(queued.delivery.id).lean();
    expect(stored).toMatchObject({
      status: 'leased',
      capabilityStatus: 'pending',
      claimAvailableAt: START,
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
    });
    expect(stored!.availableAt).toEqual(START);
    expect(stored!.leaseUntil).toBeUndefined();

    /** Exact pre-shield claim semantics: ordinary pending work or an expired
     * lease. The inert outer lease has no deadline, so it is never claimable. */
    const oldClaim = await Delivery.findOneAndUpdate(
      {
        $or: [
          { status: 'pending', availableAt: { $lte: START } },
          {
            status: 'leased',
            leaseUntil: { $lte: new Date(START.getTime() - 30_000) },
          },
        ],
      },
      {
        $set: {
          status: 'leased',
          leaseBy: 'old-worker',
          leaseUntil: new Date(START.getTime() + 60_000),
          claimToken: 'old-claim',
        },
      },
      { new: true },
    ).lean();
    expect(oldClaim).toBeNull();

    const successor = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'legacy-visible-capability-lane',
        deliveryKey: 'ordinary-after-shielded-capability',
      }),
    );
    const oldSuccessorClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'old-worker',
      claimToken: 'old-successor-claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    expect(oldSuccessorClaim).toMatchObject({ id: successor.delivery.id });
    /** Exact pre-shield ordering semantics see the inert lease, but its real
     * due time and missing lease deadline produce a bounded recheck instead of
     * copying the year-9999 claim fence onto the successor. */
    const oldEarlier = await Delivery.findOne({
      orderingKey: 'legacy-visible-capability-lane',
      laneSequence: { $lt: successor.delivery.laneSequence },
      status: { $in: ['pending', 'capability_pending', 'leased', 'capability_leased'] },
    }).lean();
    expect(oldEarlier).toMatchObject({ status: 'leased', availableAt: START });
    expect(oldEarlier!.leaseUntil).toBeUndefined();
    const successorRecheckAt = new Date(START.getTime() + 5_000);
    await expect(
      methods.releaseAgentTriggerDelivery({
        id: oldSuccessorClaim!.id,
        workerId: 'old-worker',
        claimToken: 'old-successor-claim',
        availableAt: successorRecheckAt,
      }),
    ).resolves.toBe(true);
    await expect(
      Delivery.countDocuments({ user, status: 'leased', leaseUntil: { $gt: START } }),
    ).resolves.toBe(0);

    const capabilityClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'capable-worker',
      claimToken: 'capable-claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
    });
    expect(capabilityClaim).toMatchObject({ id: queued.delivery.id });
    await expect(
      Delivery.countDocuments({ user, status: 'leased', leaseUntil: { $gt: START } }),
    ).resolves.toBe(1);
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: capabilityClaim!.id,
      workerId: 'capable-worker',
      claimToken: 'capable-claim',
      now: START,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: capabilityClaim!.id,
      workerId: 'capable-worker',
      claimToken: 'capable-claim',
      attempt: attempt!,
      error: transientFailure(),
      settledAt: START,
    });
    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'new-worker',
        claimToken: 'successor-after-capability',
        now: successorRecheckAt,
        leaseUntil: new Date(successorRecheckAt.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
      }),
    ).resolves.toMatchObject({ id: successor.delivery.id });
  });

  it('shields background completion work from workers that cannot resolve it', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    const claimInput = {
      workerId: 'worker',
      claimToken: 'claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    };

    await expect(methods.claimNextAgentTriggerDelivery(claimInput)).resolves.toBeNull();
    await expect(
      methods.claimNextAgentTriggerDelivery({
        ...claimInput,
        workerId: 'background-capable-worker',
        claimToken: 'background-capable-claim',
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2],
      }),
    ).resolves.toMatchObject({ id: queued.delivery.id });
  });

  it('renews and classifies process-local completion producer liveness idempotently', async () => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const initialLease = new Date(START.getTime() + 30_000);
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-producer-lease',
        envelope: { event: { source } },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
        producerLeaseUntil: initialLease,
      }),
    );

    await expect(
      methods.getAgentTriggerDeliveryProducerLease({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        now: START,
      }),
    ).resolves.toEqual({ status: 'live', leaseUntil: initialLease });
    await expect(
      methods.getAgentTriggerDeliveryProducerLease({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        now: new Date(initialLease.getTime() + 1),
      }),
    ).resolves.toEqual({ status: 'expired', leaseUntil: initialLease });

    const renewedUntil = new Date(START.getTime() + 60_000);
    const renewal = {
      deliveryKey: queued.delivery.deliveryKey,
      sourceId: source.id,
      leaseUntil: renewedUntil,
    };
    await expect(methods.renewAgentTriggerDeliveryProducerLease(renewal)).resolves.toBe(true);
    await expect(methods.renewAgentTriggerDeliveryProducerLease(renewal)).resolves.toBe(true);
    await expect(
      methods.getAgentTriggerDeliveryProducerLease({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        now: initialLease,
      }),
    ).resolves.toEqual({ status: 'live', leaseUntil: renewedUntil });
  });

  describe('expediteAgentTriggerDeliveries', () => {
    const background = { id: 'background-tool-completion', type: 'internal' };
    const later = new Date(START.getTime() + 30_000);
    const capable = {
      workerId: 'background-capable-worker',
      claimToken: 'background-capable-claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2],
    };
    const waiting = (overrides: Partial<Parameters<typeof enqueueInput>[0]> = {}) =>
      methods.enqueueAgentTriggerDelivery(
        enqueueInput({
          orderingKey: `background-lane-${counter + 1}`,
          envelope: { event: { source: background } },
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          availableAt: later,
          ...overrides,
        }),
      );

    it('makes a deferred delivery claimable now once its result is durable', async () => {
      const target = await waiting();
      const sibling = await waiting();
      await expect(methods.claimNextAgentTriggerDelivery(capable)).resolves.toBeNull();

      await expect(
        methods.expediteAgentTriggerDeliveries({
          deliveryKeys: [target.delivery.deliveryKey],
          sourceIds: [background.id],
          now: START,
        }),
      ).resolves.toEqual({ expedited: 1, held: 0 });

      await expect(methods.claimNextAgentTriggerDelivery(capable)).resolves.toMatchObject({
        id: target.delivery.id,
      });
      await expect(
        methods.claimNextAgentTriggerDelivery({ ...capable, claimToken: 'second-claim' }),
      ).resolves.toBeNull();
      const untouched = await Delivery.findById(sibling.delivery.id).lean();
      expect(untouched?.availableAt).toEqual(later);
    });

    it("moves only the principal's waiting rows from the named sources", async () => {
      const user = new mongoose.Types.ObjectId();
      const mine = await waiting({ user });
      const otherUser = await waiting();
      const otherSource = await waiting({
        user,
        envelope: { event: { source: { id: 'agent-queued-turn', type: 'internal' } } },
      });
      const external = await waiting({
        user,
        envelope: { event: { source: { id: background.id, type: 'webhook' } } },
      });
      const due = await waiting({ user, availableAt: START });

      await expect(
        methods.expediteAgentTriggerDeliveries({ user, sourceIds: [background.id], now: START }),
      ).resolves.toEqual({ expedited: 1, held: 0 });

      const rows = await Delivery.find({
        _id: {
          $in: [mine, otherUser, otherSource, external, due].map((row) => row.delivery.id),
        },
      }).lean();
      const availableAt = new Map(rows.map((row) => [String(row._id), row.availableAt]));
      expect(availableAt.get(mine.delivery.id)).toEqual(START);
      expect(availableAt.get(otherUser.delivery.id)).toEqual(later);
      expect(availableAt.get(otherSource.delivery.id)).toEqual(later);
      expect(availableAt.get(external.delivery.id)).toEqual(later);
      expect(availableAt.get(due.delivery.id)).toEqual(START);
    });

    it('marks a delivery a worker currently holds instead of moving it', async () => {
      const user = new mongoose.Types.ObjectId();
      const held = await waiting({ user, availableAt: START });
      const claim = await methods.claimNextAgentTriggerDelivery(capable);
      expect(claim).toMatchObject({ id: held.delivery.id });
      const before = await Delivery.findById(held.delivery.id).lean();

      await expect(
        methods.expediteAgentTriggerDeliveries({
          user,
          sourceIds: [background.id],
          now: new Date(START.getTime() - 60_000),
        }),
      ).resolves.toEqual({ expedited: 0, held: 1 });

      const after = await Delivery.findById(held.delivery.id).lean();
      expect(after?.status).toBe(before?.status);
      expect(after?.availableAt).toEqual(before?.availableAt);
      expect(after?.wakeRequestedAt).toEqual(new Date(START.getTime() - 60_000));
    });

    it('re-checks at once when readiness changed while the delivery was held', async () => {
      const user = new mongoose.Types.ObjectId();
      const held = await waiting({ user, availableAt: START });
      const claim = await methods.claimNextAgentTriggerDelivery(capable);
      expect(claim).toMatchObject({ id: held.delivery.id });
      const fence = {
        id: held.delivery.id,
        workerId: capable.workerId,
        claimToken: capable.claimToken,
      };
      const attempt = await methods.beginAgentTriggerDeliveryAttempt({ ...fence, now: START });
      await expect(
        methods.expediteAgentTriggerDeliveries({ user, sourceIds: [background.id], now: START }),
      ).resolves.toEqual({ expedited: 0, held: 1 });

      const beforeDefer = Date.now();
      await expect(
        methods.deferAgentTriggerDeliveryAttempt({
          ...fence,
          attempt: attempt!,
          availableAt: later,
        }),
      ).resolves.toBe('expedited');

      const deferred = await Delivery.findById(held.delivery.id).lean();
      expect(deferred?.wakeRequestedAt).toBeUndefined();
      expect(deferred?.availableAt.getTime()).toBeGreaterThanOrEqual(beforeDefer);
      expect(deferred?.availableAt).not.toEqual(later);

      const reclaimed = await methods.claimNextAgentTriggerDelivery({
        ...capable,
        claimToken: 'second-claim',
        now: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      });
      expect(reclaimed).toMatchObject({ id: held.delivery.id });
      const secondFence = { ...fence, claimToken: 'second-claim' };
      const secondAttempt = await methods.beginAgentTriggerDeliveryAttempt({
        ...secondFence,
        now: new Date(),
      });
      await expect(
        methods.deferAgentTriggerDeliveryAttempt({
          ...secondFence,
          attempt: secondAttempt!,
          availableAt: later,
        }),
      ).resolves.toBe(true);
      expect((await Delivery.findById(held.delivery.id).lean())?.availableAt).toEqual(later);
    });

    it.each(['ordinary', 'legacy', 'shielded'] as const)(
      'honors a held wake marker on ordering release for %s leases',
      async (profile) => {
        const row = await waiting({
          availableAt: START,
          ...(profile === 'ordinary' && { requiredWorkerCapability: undefined }),
        });
        if (profile === 'legacy') {
          await Delivery.updateOne(
            { _id: row.delivery.id },
            {
              $set: { status: 'capability_pending', availableAt: START },
              $unset: { capabilityStatus: 1, leaseUntil: 1 },
            },
          );
        }
        const claimed = await methods.claimNextAgentTriggerDelivery(capable);
        expect(claimed?.id).toBe(row.delivery.id);
        const fence = {
          id: row.delivery.id,
          workerId: capable.workerId,
          claimToken: capable.claimToken,
        };
        await methods.expediteAgentTriggerDeliveries({
          deliveryKeys: [row.delivery.deliveryKey],
          sourceIds: [background.id],
          now: START,
        });
        await expect(
          methods.releaseAgentTriggerDelivery({
            ...fence,
            claimToken: 'stale',
            availableAt: later,
          }),
        ).resolves.toBe(false);
        expect((await Delivery.findById(row.delivery.id).lean())?.wakeRequestedAt).toEqual(START);
        await expect(
          methods.releaseAgentTriggerDelivery({ ...fence, availableAt: later }),
        ).resolves.toBe(true);
        const released = await Delivery.findById(row.delivery.id).lean();
        expect(released?.wakeRequestedAt).toBeUndefined();
        expect(released?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(released?.claimAvailableAt).toEqual(released?.availableAt);
        expect(released?.attempts).toBe(0);
        const reclaimed = await methods.claimNextAgentTriggerDelivery({
          ...capable,
          now: new Date(),
          claimToken: 'next',
        });
        expect(reclaimed?.id).toBe(row.delivery.id);
        await methods.releaseAgentTriggerDelivery({
          ...fence,
          claimToken: 'next',
          availableAt: later,
        });
        expect((await Delivery.findById(row.delivery.id).lean())?.availableAt).toEqual(later);
      },
    );

    it.each(['release', 'defer'] as const)(
      'does not lose an expedite between the unmarked and marked %s writes',
      async (operation) => {
        const row = await waiting({ availableAt: START });
        await methods.claimNextAgentTriggerDelivery(capable);
        const fence = {
          id: row.delivery.id,
          workerId: capable.workerId,
          claimToken: capable.claimToken,
        };
        const attempt =
          operation === 'defer'
            ? await methods.beginAgentTriggerDeliveryAttempt({ ...fence, now: START })
            : undefined;
        const updateOne = Delivery.collection.updateOne.bind(Delivery.collection);
        let injected = false;
        const spy = jest
          .spyOn(Delivery.collection, 'updateOne')
          .mockImplementation(async (filter, update, options) => {
            if (
              !injected &&
              filter.capabilityClaimToken === capable.claimToken &&
              (filter.wakeRequestedAt as { $exists?: boolean } | undefined)?.$exists === false
            ) {
              injected = true;
              await methods.expediteAgentTriggerDeliveries({
                deliveryKeys: [row.delivery.deliveryKey],
                sourceIds: [background.id],
                now: START,
              });
            }
            return updateOne(filter, update, options);
          });
        try {
          const input = { ...fence, availableAt: later };
          if (operation === 'defer') {
            await expect(
              methods.deferAgentTriggerDeliveryAttempt({ ...input, attempt: attempt! }),
            ).resolves.toBe('expedited');
          } else {
            await expect(methods.releaseAgentTriggerDelivery(input)).resolves.toBe(true);
          }
        } finally {
          spy.mockRestore();
        }
        expect(injected).toBe(true);
        const released = await Delivery.findById(row.delivery.id).lean();
        expect(released?.wakeRequestedAt).toBeUndefined();
        expect(released?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(released?.attempts).toBe(0);
      },
    );

    it('leaves unfinished siblings backed off when only named child tasks settle', async () => {
      const user = new mongoose.Types.ObjectId();
      const source = { id: 'subagent-completion', type: 'internal' };
      const task = (taskId: string) =>
        waiting({
          user,
          envelope: {
            event: { source, payload: { taskId } },
            target: { conversationId: 'parent' },
          },
        });
      const original = await task('original');
      const recovered = await task('recovered');
      const sibling = await task('sibling');
      await expect(
        methods.expediteAgentTriggerDeliveries({
          user,
          conversationId: 'parent',
          taskIds: ['original', 'recovered'],
          sourceIds: [source.id],
          now: START,
        }),
      ).resolves.toEqual({ expedited: 2, held: 0 });
      expect((await Delivery.findById(original.delivery.id).lean())?.availableAt).toEqual(START);
      expect((await Delivery.findById(recovered.delivery.id).lean())?.availableAt).toEqual(START);
      expect((await Delivery.findById(sibling.delivery.id).lean())?.availableAt).toEqual(later);
      await expect(
        methods.expediteAgentTriggerDeliveries({
          user,
          conversationId: 'parent',
          taskIds: [],
          sourceIds: [source.id],
          now: START,
        }),
      ).rejects.toThrow(TypeError);
    });

    it("narrows a principal's selection to the conversation being resumed", async () => {
      const user = new mongoose.Types.ObjectId();
      const target = await waiting({
        user,
        envelope: { event: { source: background }, target: { conversationId: 'settled-convo' } },
      });
      const other = await waiting({
        user,
        envelope: { event: { source: background }, target: { conversationId: 'other-convo' } },
      });

      await expect(
        methods.expediteAgentTriggerDeliveries({
          user,
          conversationId: 'settled-convo',
          sourceIds: [background.id],
          now: START,
        }),
      ).resolves.toEqual({ expedited: 1, held: 0 });

      expect((await Delivery.findById(target.delivery.id).lean())?.availableAt).toEqual(START);
      expect((await Delivery.findById(other.delivery.id).lean())?.availableAt).toEqual(later);
    });

    it('refuses an unbounded or malformed selection', async () => {
      await expect(
        methods.expediteAgentTriggerDeliveries({ sourceIds: [background.id], now: START }),
      ).rejects.toThrow(TypeError);
      await expect(
        methods.expediteAgentTriggerDeliveries({
          user: new mongoose.Types.ObjectId(),
          sourceIds: [],
          now: START,
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        methods.expediteAgentTriggerDeliveries({
          deliveryKeys: ['trigger_x'],
          sourceIds: [background.id],
          now: new Date(Number.NaN),
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('listPendingAgentBackgroundToolCompletions', () => {
    const background = { id: 'background-tool-completion', type: 'internal' };
    const completion = (
      user: mongoose.Types.ObjectId,
      taskId: string,
      overrides: Partial<Parameters<typeof enqueueInput>[0]> = {},
    ) =>
      methods.enqueueAgentTriggerDelivery(
        enqueueInput({
          user,
          orderingKey: `background-lane-${taskId}`,
          envelope: {
            event: {
              source: background,
              payload: { taskId, toolCallId: `call-${taskId}`, toolName: 'slow_task' },
            },
            target: { conversationId: 'conversation-1' },
          },
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          ...overrides,
        }),
      );

    it('lists what is still going to arrive, running or settled, without result content', async () => {
      const user = new mongoose.Types.ObjectId();
      const running = await completion(user, 'task-running');
      const settled = await completion(user, 'task-settled');
      await methods.persistAgentBackgroundToolResult({
        deliveryKey: settled.delivery.deliveryKey,
        sourceId: background.id,
        result: { status: 'completed', output: 'secret output', settledAt: START },
      });

      const pending = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
      });

      expect(pending.truncated).toBe(false);
      expect(pending.completions).toEqual([
        {
          deliveryKey: running.delivery.deliveryKey,
          taskId: 'task-running',
          toolCallId: 'call-task-running',
          toolName: 'slow_task',
          dispatchedAt: expect.any(Date),
          claimedByWakeup: false,
        },
        {
          deliveryKey: settled.delivery.deliveryKey,
          taskId: 'task-settled',
          toolCallId: 'call-task-settled',
          toolName: 'slow_task',
          dispatchedAt: expect.any(Date),
          result: { status: 'completed', settledAt: START },
          claimedByWakeup: false,
        },
      ]);
      expect(JSON.stringify(pending)).not.toContain('secret output');
    });

    it('excludes delivered rows and everything outside the conversation, user, and source', async () => {
      const user = new mongoose.Types.ObjectId();
      const delivered = await completion(user, 'task-delivered');
      await Delivery.updateOne({ _id: delivered.delivery.id }, { $set: { status: 'succeeded' } });
      await completion(new mongoose.Types.ObjectId(), 'task-other-user');
      await completion(user, 'task-other-conversation', {
        envelope: {
          event: {
            source: background,
            payload: {
              taskId: 'task-other-conversation',
              toolCallId: 'call',
              toolName: 'slow_task',
            },
          },
          target: { conversationId: 'conversation-2' },
        },
      });
      await completion(user, 'task-other-source', {
        envelope: {
          event: {
            source: { id: 'agent-queued-turn', type: 'internal' },
            payload: { taskId: 'task-other-source', toolCallId: 'call', toolName: 'slow_task' },
          },
          target: { conversationId: 'conversation-1' },
        },
      });
      const waiting = await completion(user, 'task-waiting');

      const pending = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
      });

      expect(pending.completions.map((entry) => entry.deliveryKey)).toEqual([
        waiting.delivery.deliveryKey,
      ]);
    });

    it('looks up one task and reports a truncated listing', async () => {
      const user = new mongoose.Types.ObjectId();
      await completion(user, 'task-first');
      const second = await completion(user, 'task-second');

      const one = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
        taskId: 'task-second',
      });
      expect(one).toEqual({
        completions: [expect.objectContaining({ deliveryKey: second.delivery.deliveryKey })],
        dead: [],
        truncated: false,
      });

      const page = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
        limit: 1,
      });
      expect(page.completions.map((entry) => entry.taskId)).toEqual(['task-second']);
      expect(page.truncated).toBe(true);
    });

    it('does not let 201 retained dead letters hide a new result or a late delivery failure', async () => {
      const user = new mongoose.Types.ObjectId();
      await Delivery.insertMany(
        Array.from({ length: 201 }, (_, index) => ({
          deliveryKey: `background-dead-${index}`,
          fingerprint: `background-dead-${index}`,
          orderingKey: `background-dead-${index}`,
          laneSequence: 1,
          envelope: {
            event: {
              source: background,
              payload: {
                taskId: `old-dead-${index}`,
                toolCallId: `call-old-dead-${index}`,
                toolName: 'slow_task',
              },
            },
            target: { conversationId: 'conversation-1' },
          },
          user,
          status: 'dead',
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          attempts: 1,
          availableAt: START,
          createdAt: new Date(START.getTime() + index * 1_000),
          updatedAt: new Date(START.getTime() + index * 1_000),
          backgroundToolResult: { status: 'completed', output: 'private output', settledAt: START },
        })),
      );
      const waiting = await completion(user, 'new-pending');
      await methods.persistAgentBackgroundToolResult({
        deliveryKey: waiting.delivery.deliveryKey,
        sourceId: background.id,
        result: { status: 'completed', output: 'private pending result', settledAt: START },
      });
      const late = await completion(user, 'late-failure');
      await methods.persistAgentBackgroundToolResult({
        deliveryKey: late.delivery.deliveryKey,
        sourceId: background.id,
        result: { status: 'completed', output: 'private late result', settledAt: START },
      });
      await Delivery.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(late.delivery.id) },
        { $set: { createdAt: new Date(START.getTime() - 60_000) } },
      );
      await Delivery.updateOne({ _id: late.delivery.id }, { $set: { status: 'dead' } });

      const listed = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
      });
      expect(listed.completions.map(({ taskId }) => taskId)).toEqual(['new-pending']);
      expect(listed.dead).toHaveLength(200);
      expect(listed.dead[0].taskId).toBe('late-failure');
      expect(listed.dead.some(({ taskId }) => taskId === 'old-dead-0')).toBe(false);
      expect(listed.truncated).toBe(true);
      expect(JSON.stringify(listed)).not.toContain('private');
    });

    it('uses a scoped index even when other conversations have waiting deliveries', async () => {
      const user = new mongoose.Types.ObjectId();
      await completion(user, 'current');
      await Delivery.insertMany(
        Array.from({ length: 80 }, (_, index) => ({
          ...enqueueInput({
            user,
            orderingKey: `unrelated-background-${index}`,
            envelope: {
              event: {
                source: background,
                payload: {
                  taskId: `unrelated-${index}`,
                  toolCallId: `call-unrelated-${index}`,
                  toolName: 'slow_task',
                },
              },
              target: { conversationId: 'another-conversation' },
            },
          }),
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          laneSequence: 1,
          status: 'pending',
          attempts: 0,
        })),
      );
      const indexes = await Delivery.collection.indexes();
      const scopeIndex = indexes.find(
        ({ key }) =>
          key.user === 1 &&
          key['envelope.event.source.id'] === 1 &&
          key['envelope.target.conversationId'] === 1 &&
          key.requiredWorkerCapability === 1 &&
          key.status === 1 &&
          key.updatedAt === -1,
      );
      if (scopeIndex == null) throw new Error('Conversation-scoped delivery index is missing');
      const plan = await Delivery.collection
        .find({
          user,
          'envelope.event.source.type': 'internal',
          'envelope.event.source.id': background.id,
          'envelope.target.conversationId': 'conversation-1',
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
          status: { $in: ['pending', 'leased', 'capability_pending'] },
          capabilityStatus: { $ne: 'dead' },
        })
        .sort({ updatedAt: -1, _id: -1 })
        .limit(1)
        .hint(scopeIndex.key)
        .explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(scopeIndex.name);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
    });

    it('omits legacy rows whose results live only on the parent message', async () => {
      const user = new mongoose.Types.ObjectId();
      await completion(user, 'task-legacy', {
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
      });

      const pending = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
      });

      expect(pending.completions).toEqual([]);
    });

    it('reports dead-lettered tasks apart from pending ones', async () => {
      const user = new mongoose.Types.ObjectId();
      const dead = await completion(user, 'task-dead');
      await Delivery.updateOne(
        { _id: dead.delivery.id },
        { $set: { status: 'leased', capabilityStatus: 'dead' } },
      );
      const deadLetter = await completion(user, 'task-dead-letter');
      await Delivery.updateOne({ _id: deadLetter.delivery.id }, { $set: { status: 'dead' } });

      const pending = await methods.listPendingAgentBackgroundToolCompletions({
        user,
        conversationId: 'conversation-1',
        sourceId: background.id,
      });

      expect(pending.completions).toEqual([]);
      expect(pending.dead.map(({ taskId }) => taskId).sort()).toEqual([
        'task-dead',
        'task-dead-letter',
      ]);
      expect(pending.dead[0]).toEqual(
        expect.objectContaining({ toolName: 'slow_task', dispatchedAt: expect.any(Date) }),
      );
    });

    it("lists a conversation's undelivered task ids for one source", async () => {
      const user = new mongoose.Types.ObjectId();
      const subagent = { id: 'subagent-completion', type: 'internal' };
      await completion(user, 'child-waiting', {
        envelope: {
          event: { source: subagent, payload: { taskId: 'child-waiting' } },
          target: { conversationId: 'conversation-1' },
        },
      });
      const delivered = await completion(user, 'child-delivered', {
        envelope: {
          event: { source: subagent, payload: { taskId: 'child-delivered' } },
          target: { conversationId: 'conversation-1' },
        },
      });
      await Delivery.updateOne({ _id: delivered.delivery.id }, { $set: { status: 'succeeded' } });

      await expect(
        methods.listUndeliveredAgentTriggerTaskIds({
          user,
          conversationId: 'conversation-1',
          sourceId: subagent.id,
        }),
      ).resolves.toEqual({ taskIds: ['child-waiting'], truncated: false });
    });

    it('distinguishes retiring a completion from finding it already delivered', async () => {
      const user = new mongoose.Types.ObjectId();
      const delivered = await completion(user, 'task-already-delivered');
      await Delivery.updateOne({ _id: delivered.delivery.id }, { $set: { status: 'succeeded' } });
      const retire = (requireTransition?: true) =>
        methods.retireAgentTriggerDelivery({
          deliveryKey: delivered.delivery.deliveryKey,
          sourceId: background.id,
          settledAt: START,
          reason: 'background result discarded by its owner',
          onlyIfUnclaimed: true,
          ...(requireTransition != null && { requireTransition }),
        });

      await expect(retire()).resolves.toBe(true);
      await expect(retire(true)).resolves.toBe(false);

      const waiting = await completion(user, 'task-still-waiting');
      await expect(
        methods.retireAgentTriggerDelivery({
          deliveryKey: waiting.delivery.deliveryKey,
          sourceId: background.id,
          settledAt: START,
          reason: 'background result discarded by its owner',
          onlyIfUnclaimed: true,
          requireTransition: true,
        }),
      ).resolves.toBe(true);
    });

    it('refuses a malformed lookup', async () => {
      await expect(
        methods.listPendingAgentBackgroundToolCompletions({
          user: new mongoose.Types.ObjectId(),
          conversationId: '',
          sourceId: background.id,
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        methods.listPendingAgentBackgroundToolCompletions({
          user: new mongoose.Types.ObjectId(),
          conversationId: 'conversation-1',
          sourceId: background.id,
          limit: 0,
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  it('persists one private background result receipt independently of message rows', async () => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-result-receipt',
        envelope: { event: { source } },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    const input = {
      deliveryKey: queued.delivery.deliveryKey,
      sourceId: source.id,
      result: { status: 'completed' as const, output: 'durable output', settledAt: START },
    };

    await expect(methods.persistAgentBackgroundToolResult(input)).resolves.toBe(true);
    await expect(methods.persistAgentBackgroundToolResult(input)).resolves.toBe(true);
    await expect(
      methods.getAgentBackgroundToolResult({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
      }),
    ).resolves.toEqual(input.result);
    await expect(
      methods.persistAgentBackgroundToolResult({
        ...input,
        result: { ...input.result, output: 'conflicting output' },
      }),
    ).resolves.toBe(false);
    const ordinaryRead = await Delivery.findById(queued.delivery.id).lean();
    expect(ordinaryRead).not.toHaveProperty('backgroundToolResult');
  });

  it('erases private result receipts when their conversation is deleted', async () => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const user = new mongoose.Types.ObjectId();
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-result-to-erase',
        user,
        envelope: {
          event: { source },
          target: { conversationId: 'conversation-to-delete' },
        },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    await methods.persistAgentBackgroundToolResult({
      deliveryKey: queued.delivery.deliveryKey,
      sourceId: source.id,
      result: { status: 'completed', output: 'private output', settledAt: START },
    });

    await methods.eraseAgentTriggerDeliveryConversationResults(user, ['conversation-to-delete']);

    await expect(
      methods.getAgentBackgroundToolResult({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
      }),
    ).resolves.toBeNull();
    await expect(Delivery.exists({ _id: queued.delivery.id })).resolves.not.toBeNull();
    await expect(
      methods.persistAgentBackgroundToolResult({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        result: { status: 'completed', output: 'late private output', settledAt: START },
      }),
    ).resolves.toBe(false);
  });

  it('does not make legacy string-owned conversation cleanup depend on an ObjectId cast', async () => {
    await expect(
      methods.prepareAgentTriggerConversationResultErasure('legacy-user', ['conversation']),
    ).resolves.toBeUndefined();
    await expect(
      methods.eraseAgentTriggerDeliveryConversationResults('legacy-user', ['conversation']),
    ).resolves.toBeUndefined();
  });

  it('recovers receipt erasure after a descendant row was already deleted', async () => {
    const user = new mongoose.Types.ObjectId();
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        envelope: { event: { source }, target: { conversationId: 'deleted-child' } },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    const lookup = { deliveryKey: queued.delivery.deliveryKey, sourceId: source.id };
    await methods.persistAgentBackgroundToolResult({
      ...lookup,
      result: { status: 'completed', output: 'private child output', settledAt: START },
    });
    await methods.prepareAgentTriggerConversationResultErasure(user, ['deleted-child']);
    await mongoose.models.Conversation.collection.insertOne({
      user: user.toString(),
      conversationId: 'deleted-child',
    });
    await methods.recoverAgentTriggerUserPurges();
    await expect(methods.getAgentBackgroundToolResult(lookup)).resolves.not.toBeNull();
    await mongoose.models.Conversation.deleteOne({ user, conversationId: 'deleted-child' });
    /** The conversation deletion committed, but the follow-up receipt erasure did not. */
    await methods.recoverAgentTriggerUserPurges();
    await expect(methods.getAgentBackgroundToolResult(lookup)).resolves.toBeNull();
    await expect(
      Delivery.exists({
        _id: queued.delivery.id,
        backgroundToolResultDeletionPendingAt: { $exists: true },
      }),
    ).resolves.toBeNull();
    await expect(
      methods.persistAgentBackgroundToolResult({
        ...lookup,
        result: { status: 'completed', output: 'late write', settledAt: START },
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ['receipt', 'BACKGROUND_TOOL_PRODUCER_LOST'],
    ['death', 'BACKGROUND_TOOL_PRODUCER_LOST'],
    ['receipt', 'PARENT_STATE_UNAVAILABLE'],
    ['death', 'PARENT_STATE_UNAVAILABLE'],
  ])('atomically fences result publication when %s wins before %s', async (winner, code) => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        envelope: { event: { source } },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    const owner = { workerId: 'worker', claimToken: 'claim', now: START };
    const claimed = await methods.claimNextAgentTriggerDelivery({
      ...owner,
      leaseUntil: new Date(START.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2],
    });
    expect(claimed).not.toBeNull();
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({ ...owner, id: claimed!.id });
    const write = () =>
      methods.persistAgentBackgroundToolResult({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        result: { status: 'completed', output: 'late output', settledAt: START },
      });
    const dead = () =>
      methods.deadLetterAgentTriggerDelivery({
        ...owner,
        id: claimed!.id,
        attempt: attempt!,
        settledAt: START,
        error: transientFailure({ code, retryable: code !== 'BACKGROUND_TOOL_PRODUCER_LOST' }),
      });
    await expect(winner === 'receipt' ? write() : dead()).resolves.toBe(true);
    await expect(winner === 'receipt' ? dead() : write()).resolves.toBe(false);
  });

  it.each(['shield', 'legacy'] as const)(
    'recovers a committed receipt after generic retry exhaustion through the %s fence',
    async (format) => {
      const source = { id: 'background-tool-completion', type: 'internal' };
      const queued = await methods.enqueueAgentTriggerDelivery(
        enqueueInput({
          envelope: { event: { source } },
          requiredWorkerCapability:
            AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
        }),
      );
      const owner = { workerId: 'worker', claimToken: 'claim', now: START };
      const claimed = await methods.claimNextAgentTriggerDelivery({
        ...owner,
        leaseUntil: new Date(START.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2],
      });
      const id = claimed!.id;
      const attempt = await methods.beginAgentTriggerDeliveryAttempt({ ...owner, id });
      if (format !== 'shield') {
        await Delivery.updateOne(
          { _id: id },
          {
            $set: {
              status: 'capability_leased',
              leaseBy: owner.workerId,
              claimToken: owner.claimToken,
              leaseUntil: new Date(START.getTime() + 60_000),
            },
            $unset: {
              capabilityStatus: 1,
              capabilityLeaseBy: 1,
              capabilityLeaseUntil: 1,
              capabilityClaimToken: 1,
            },
          },
        );
      }
      const receipt = { deliveryKey: queued.delivery.deliveryKey, sourceId: source.id };
      await methods.persistAgentBackgroundToolResult({
        ...receipt,
        result: { status: 'completed', output: 'saved output', settledAt: START },
      });
      const receiptRetryAt = new Date(START.getTime() + 300_000);
      const terminal = {
        ...owner,
        id,
        attempt: attempt!,
        settledAt: START,
        receiptRetryAt,
        error: transientFailure({ code: 'PARENT_STATE_UNAVAILABLE' }),
      };
      await expect(
        methods.deadLetterAgentTriggerDelivery({ ...terminal, claimToken: 'stale' }),
      ).resolves.toBe(false);
      expect((await Delivery.findById(id).lean())?.attempts).toBe(attempt);
      await expect(methods.deadLetterAgentTriggerDelivery(terminal)).resolves.toBe(false);
      expect(await Delivery.findById(id).lean()).toMatchObject({
        attempts: 0,
        claimAvailableAt: receiptRetryAt,
        ...(format === 'shield'
          ? { capabilityStatus: 'pending' }
          : { status: 'capability_pending' }),
      });
      await expect(methods.getAgentBackgroundToolResult(receipt)).resolves.toMatchObject({
        output: 'saved output',
      });
      const recovered = await methods.claimNextAgentTriggerDelivery({
        ...owner,
        claimToken: 'recovered',
        now: receiptRetryAt,
        leaseUntil: new Date(receiptRetryAt.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2],
      });
      expect(recovered?.id).toBe(id);
      expect(
        await methods.beginAgentTriggerDeliveryAttempt({
          ...owner,
          id,
          claimToken: 'recovered',
          now: receiptRetryAt,
        }),
      ).toBe(1);
      await expect(
        methods.deadLetterAgentTriggerDelivery({
          ...terminal,
          claimToken: 'recovered',
          settledAt: receiptRetryAt,
          error: transientFailure({ code: 'PARENT_NOT_FOUND', retryable: false }),
        }),
      ).resolves.toBe(true);
    },
  );

  it('claims an independent result receipt before returning its output', async () => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const user = new mongoose.Types.ObjectId();
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-result-to-claim',
        user,
        envelope: {
          event: {
            source,
            payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'slow_tool' },
          },
          target: {
            agentId: 'agent-1',
            conversationId: 'conversation-1',
            parentMessageId: 'response-1',
          },
        },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      }),
    );
    await methods.persistAgentBackgroundToolResult({
      deliveryKey: queued.delivery.deliveryKey,
      sourceId: source.id,
      result: { status: 'completed', output: 'private output', settledAt: START },
    });
    const claim = {
      deliveryKey: queued.delivery.deliveryKey,
      sourceId: source.id,
      userId: user.toString(),
      conversationId: 'conversation-1',
      parentMessageId: 'response-1',
      agentId: 'agent-1',
      claimId: 'delivery-claim-1',
      limit: 1,
    };

    await expect(methods.claimAgentBackgroundToolResults(claim)).resolves.toMatchObject({
      status: 'acquired',
      results: [{ taskId: 'task-1', output: 'private output' }],
    });
    await expect(
      methods.claimAgentBackgroundToolResults({ ...claim, claimId: 'delivery-claim-2' }),
    ).resolves.toEqual({ status: 'claimed', claimId: 'delivery-claim-1' });
    await expect(
      methods.getAgentBackgroundToolResultClaim({
        sourceId: source.id,
        userId: user.toString(),
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'wakeup', claimId: 'delivery-claim-1' });
    await expect(
      methods.releaseAgentBackgroundToolResultClaims({
        sourceId: source.id,
        userId: user.toString(),
        conversationId: 'conversation-1',
        parentMessageId: 'response-1',
        claimId: 'delivery-claim-1',
      }),
    ).resolves.toBe(true);
  });

  it.each([
    AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
    AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2,
  ])('keeps %s fenced through lease recovery', async (capability) => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        requiredWorkerCapability: capability,
      }),
    );
    expect(queued.delivery).toMatchObject({
      status: 'capability_pending',
      requiredWorkerCapability: capability,
    });
    const claimInput = {
      workerId: 'capable-worker',
      claimToken: 'capable-claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    };

    await expect(
      methods.claimNextAgentTriggerDelivery({
        ...claimInput,
        workerId: 'old-worker',
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1],
        claimToken: 'old-claim',
      }),
    ).resolves.toBeNull();
    const capable = await methods.claimNextAgentTriggerDelivery({
      ...claimInput,
      workerCapabilities: [capability],
    });
    expect(capable).toMatchObject({ status: 'capability_leased' });

    await Delivery.updateOne(
      { _id: capable!.id },
      { $set: { capabilityLeaseUntil: new Date(START.getTime() - 60_000) } },
    );
    const recoveryNow = new Date(START.getTime() + 60_000);
    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'old-worker',
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1],
        claimToken: 'old-recovery',
        now: recoveryNow,
        leaseUntil: new Date(recoveryNow.getTime() + 60_000),
      }),
    ).resolves.toBeNull();
    const recovered = await methods.claimNextAgentTriggerDelivery({
      workerId: 'capable-worker-2',
      claimToken: 'capable-recovery',
      now: recoveryNow,
      leaseUntil: new Date(recoveryNow.getTime() + 60_000),
      workerCapabilities: [capability],
    });
    expect(recovered).toMatchObject({ status: 'capability_leased' });

    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: recovered!.id,
      workerId: 'capable-worker-2',
      claimToken: 'capable-recovery',
      now: recoveryNow,
    });
    expect(attempt).toBe(1);
    await expect(
      methods.deadLetterAgentTriggerDelivery({
        id: recovered!.id,
        workerId: 'capable-worker-2',
        claimToken: 'capable-recovery',
        attempt: 1,
        error: transientFailure({ attemptedAt: recoveryNow }),
        settledAt: recoveryNow,
      }),
    ).resolves.toBe(true);
    await expect(Delivery.findById(recovered!.id).lean()).resolves.toMatchObject({
      status: 'capability_dead',
      capabilityStatus: 'dead',
    });

    const [deadLetter] = await methods.getAgentTriggerDeadLetters();
    expect(deadLetter).toMatchObject({ id: recovered!.id, status: 'capability_dead' });
    const requeued = await methods.requeueAgentTriggerDelivery(recovered!.id, recoveryNow);
    expect(requeued).toMatchObject({ status: 'capability_pending' });
    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'old-worker',
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1],
        claimToken: 'old-requeue',
        now: recoveryNow,
        leaseUntil: new Date(recoveryNow.getTime() + 60_000),
      }),
    ).resolves.toBeNull();
    const finalClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'capable-worker-3',
      claimToken: 'capable-final',
      now: recoveryNow,
      leaseUntil: new Date(recoveryNow.getTime() + 60_000),
      workerCapabilities: [capability],
    });
    const finalAttempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: finalClaim!.id,
      workerId: 'capable-worker-3',
      claimToken: 'capable-final',
      now: recoveryNow,
    });
    await expect(
      methods.completeAgentTriggerDelivery({
        id: finalClaim!.id,
        workerId: 'capable-worker-3',
        claimToken: 'capable-final',
        attempt: finalAttempt!,
        result: { status: 'complete' },
        settledAt: recoveryNow,
      }),
    ).resolves.toBe(true);
  });

  it('claims the oldest eligible delivery without capability traffic priority', async () => {
    const ordinary = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'ordinary-older',
        availableAt: new Date(START.getTime() - 2_000),
      }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'capability-newer',
        availableAt: new Date(START.getTime() - 1_000),
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
    );

    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'capable-worker',
        claimToken: 'claim-oldest',
        now: START,
        leaseUntil: new Date(START.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
      }),
    ).resolves.toMatchObject({ id: ordinary.delivery.id, status: 'leased' });
  });

  it('retires a failed internal completion admission and unblocks its lane successor', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'background-completion-lane';
    const source = { id: 'background-tool-completion', type: 'internal' };
    const first = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-1',
        user,
        orderingKey,
        envelope: { event: { source } },
      }),
    );
    const successor = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-2',
        user,
        orderingKey,
        envelope: { event: { source } },
      }),
    );

    const retirement = {
      deliveryKey: first.delivery.deliveryKey,
      sourceId: source.id,
      settledAt: START,
      reason: 'result persistence failed',
    };
    await expect(methods.retireAgentTriggerDelivery(retirement)).resolves.toBe(true);
    await expect(methods.retireAgentTriggerDelivery(retirement)).resolves.toBe(true);
    await expect(
      methods.retireAgentTriggerDelivery({ ...retirement, sourceId: 'other-internal-source' }),
    ).resolves.toBe(false);
    await expect(
      Delivery.findOne({ deliveryKey: first.delivery.deliveryKey }).lean(),
    ).resolves.toMatchObject({
      status: 'succeeded',
      result: {
        status: 'settled',
        backgroundToolCompletionRetired: true,
        reason: 'result persistence failed',
      },
    });

    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'successor-worker',
        claimToken: 'successor-claim',
        now: START,
        leaseUntil: new Date(START.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ id: successor.delivery.id });
  });

  it('treats an already successful internal delivery as terminal retirement evidence', async () => {
    const source = { id: 'agent-queued-turn', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'queued-turn-already-succeeded',
        envelope: { event: { source } },
      }),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'queued-turn-worker',
      claimToken: 'queued-turn-claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'queued-turn-worker',
      claimToken: 'queued-turn-claim',
      now: START,
    });
    await methods.completeAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'queued-turn-worker',
      claimToken: 'queued-turn-claim',
      attempt: attempt!,
      result: { status: 'settled' },
      settledAt: START,
    });

    await expect(
      methods.retireAgentTriggerDelivery({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        settledAt: new Date(START.getTime() + 1),
        reason: 'source already terminalized',
      }),
    ).resolves.toBe(true);
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'succeeded',
      result: { status: 'settled' },
      settledAt: START,
    });
  });

  it('does not retire a completion already leased by a resolver for a manual poll', async () => {
    const user = new mongoose.Types.ObjectId();
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-leased',
        user,
        envelope: { event: { source } },
      }),
    );
    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'completion-worker',
        claimToken: 'completion-claim',
        now: START,
        leaseUntil: new Date(START.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ id: queued.delivery.id });

    await expect(
      methods.retireAgentTriggerDelivery({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        settledAt: START,
        reason: 'manual poll elected',
        onlyIfUnclaimed: true,
      }),
    ).resolves.toBe(false);
    await expect(
      Delivery.findOne({ deliveryKey: queued.delivery.deliveryKey }).lean(),
    ).resolves.toMatchObject({ status: 'leased', leaseBy: 'completion-worker' });
  });

  it('retires a capability-shielded completion before a private resolver claims it', async () => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-shielded-pending',
        envelope: { event: { source } },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
      }),
    );
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'leased',
      capabilityStatus: 'pending',
    });

    await expect(
      methods.retireAgentTriggerDelivery({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        settledAt: START,
        reason: 'manual poll elected',
        onlyIfUnclaimed: true,
      }),
    ).resolves.toBe(true);
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'succeeded',
      result: { backgroundToolCompletionRetired: true },
    });
  });

  it('does not retire a capability completion after a private resolver claims it', async () => {
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-private-lease',
        envelope: { event: { source } },
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1,
      }),
    );
    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'background-capable-worker',
        claimToken: 'background-capable-claim',
        now: START,
        leaseUntil: new Date(START.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1],
      }),
    ).resolves.toMatchObject({ id: queued.delivery.id });

    await expect(
      methods.retireAgentTriggerDelivery({
        deliveryKey: queued.delivery.deliveryKey,
        sourceId: source.id,
        settledAt: START,
        reason: 'manual poll elected',
        onlyIfUnclaimed: true,
      }),
    ).resolves.toBe(false);
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'leased',
      capabilityStatus: 'leased',
    });
  });

  it('reconciles only an irreversibly dead completion for manual polling', async () => {
    const user = new mongoose.Types.ObjectId();
    const source = { id: 'background-tool-completion', type: 'internal' };
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'background-completion-dead',
        user,
        envelope: { event: { source } },
      }),
    );
    await Delivery.updateOne(
      { _id: queued.delivery.id },
      { $set: { status: 'dead', settledAt: START } },
    );

    const retirement = {
      deliveryKey: queued.delivery.deliveryKey,
      sourceId: source.id,
      settledAt: new Date(START.getTime() + 1),
      reason: 'manual poll recovered dead completion',
      onlyIfDead: true,
    } as const;
    await expect(methods.retireAgentTriggerDelivery(retirement)).resolves.toBe(true);
    /** A later claim-release retry must recognize the recovery receipt even
     * though the delivery no longer has a dead status. */
    await expect(methods.retireAgentTriggerDelivery(retirement)).resolves.toBe(true);
    await expect(
      Delivery.findOne({ deliveryKey: queued.delivery.deliveryKey }).lean(),
    ).resolves.toMatchObject({
      status: 'succeeded',
      result: { backgroundToolCompletionRetired: true },
    });
  });

  it('claims older capability work before newer ordinary work', async () => {
    const capability = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'capability-older',
        availableAt: new Date(START.getTime() - 2_000),
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        deliveryKey: 'ordinary-newer',
        availableAt: new Date(START.getTime() - 1_000),
      }),
    );

    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'capable-worker',
        claimToken: 'claim-oldest-capability',
        now: START,
        leaseUntil: new Date(START.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
      }),
    ).resolves.toMatchObject({ id: capability.delivery.id, status: 'capability_leased' });
  });

  it('adopts capability publication completed by a legacy lane publisher', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'legacy-capability-publication';
    const capability = await Delivery.create({
      ...enqueueInput({
        user,
        orderingKey,
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
      status: 'staging',
      capabilityStatus: 'publishing',
      claimAvailableAt: START,
      availableAt: new Date('9999-12-31T23:59:59.999Z'),
      leaseUntil: new Date('9999-12-31T23:59:59.999Z'),
      laneSequence: 0,
      attempts: 0,
      requeueCount: 0,
      stagingRecoveryAt: START,
    });
    await LaneSequence.create({
      _id: orderingKey,
      value: 1,
      user,
      publisherDeliveryId: capability._id,
      publisherStartedAt: START,
    });

    /** Exact pre-capability publication writes: the old replica assigns the
     * reserved sequence and releases the publisher without touching private fields. */
    await Delivery.updateOne(
      { _id: capability._id, orderingKey, status: 'staging' },
      {
        $set: { status: 'capability_pending', laneSequence: 1 },
        $unset: { stagingRecoveryAt: 1 },
      },
    );
    await LaneSequence.updateOne(
      { _id: orderingKey, value: 1, publisherDeliveryId: capability._id },
      {
        $set: { tailDeliveryId: capability._id },
        $unset: { publisherDeliveryId: 1, publisherStartedAt: 1 },
      },
    );

    const later = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ user, orderingKey, deliveryKey: 'ordinary-after-capability' }),
    );

    await expect(Delivery.findById(capability._id).lean()).resolves.toMatchObject({
      status: 'leased',
      capabilityStatus: 'pending',
      laneSequence: 1,
    });
    expect(later.delivery).toMatchObject({ laneSequence: 2 });
  });

  it('keeps a privately dead capability delivery nonblocking to old and new workers', async () => {
    const orderingKey = 'dead-capability-lane';
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        orderingKey,
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'capable-worker',
      claimToken: 'capable-dead-claim',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
    });
    await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'capable-worker',
      claimToken: 'capable-dead-claim',
      now: START,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'capable-worker',
      claimToken: 'capable-dead-claim',
      attempt: 1,
      error: transientFailure(),
      settledAt: START,
    });
    const successor = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ orderingKey, deliveryKey: 'successor-after-dead-capability' }),
    );

    await expect(Delivery.findById(claim!.id).lean()).resolves.toMatchObject({
      status: 'capability_dead',
      capabilityStatus: 'dead',
    });
    /** Exact pre-shield ordering query. A `pending` shell here would make an
     * old worker defer the successor until the year-9999 availability fence. */
    const oldEarlier = await Delivery.findOne({
      orderingKey,
      laneSequence: { $lt: successor.delivery.laneSequence },
      $or: [
        {
          status: {
            $in: ['pending', 'capability_pending', 'leased', 'capability_leased'],
          },
        },
        {
          status: 'succeeded',
          batchRootId: { $exists: false },
          awaitTerminalHandling: true,
          'handling.status': 'started',
        },
      ],
    }).lean();
    expect(oldEarlier).toBeNull();
    await expect(methods.findEarlierAgentTriggerDelivery(successor.delivery)).resolves.toBeNull();
    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'new-worker',
        claimToken: 'new-worker-successor-claim',
        now: START,
        leaseUntil: new Date(START.getTime() + 60_000),
        workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
      }),
    ).resolves.toMatchObject({ id: successor.delivery.id });
  });

  it('adopts a private dead delivery explicitly requeued by a pre-shield replica', async () => {
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        orderingKey: 'legacy-requeued-dead-capability',
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'capable-worker',
      claimToken: 'claim-before-legacy-requeue',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
    });
    await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'capable-worker',
      claimToken: 'claim-before-legacy-requeue',
      now: START,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'capable-worker',
      claimToken: 'claim-before-legacy-requeue',
      attempt: 1,
      error: transientFailure(),
      settledAt: START,
    });

    const requeueAt = new Date(START.getTime() + 1_000);
    /** Final state produced by the pre-shield requeue implementation: it
     * recognizes `capability_dead`, republishes `capability_pending`, and does
     * not know that the private lifecycle field must also be reset. */
    await Delivery.updateOne(
      { _id: claim!.id, status: 'capability_dead', capabilityStatus: 'dead' },
      {
        $set: { status: 'capability_pending', availableAt: requeueAt },
        $unset: { settledAt: 1, lastError: 1 },
        $inc: { requeueCount: 1 },
      },
    );

    const reclaimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'new-worker',
      claimToken: 'claim-after-legacy-requeue',
      now: requeueAt,
      leaseUntil: new Date(requeueAt.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
    });
    expect(reclaimed).toMatchObject({ id: claim!.id, status: 'capability_leased' });
    await expect(Delivery.findById(claim!.id).lean()).resolves.toMatchObject({
      status: 'leased',
      capabilityStatus: 'leased',
      claimAvailableAt: requeueAt,
    });
  });

  it('accepts legacy success as terminal over stale private dead state', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        orderingKey: 'legacy-completed-dead-capability',
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
      }),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'capable-worker',
      claimToken: 'claim-before-legacy-success',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
      workerCapabilities: [AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1],
    });
    await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'capable-worker',
      claimToken: 'claim-before-legacy-success',
      now: START,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'capable-worker',
      claimToken: 'claim-before-legacy-success',
      attempt: 1,
      error: transientFailure(),
      settledAt: START,
    });

    const requeueAt = new Date(START.getTime() + 1_000);
    await Delivery.updateOne(
      { _id: claim!.id, status: 'capability_dead', capabilityStatus: 'dead' },
      {
        $set: { status: 'capability_pending', availableAt: requeueAt },
        $unset: { settledAt: 1, lastError: 1 },
        $inc: { requeueCount: 1 },
      },
    );
    const legacyLeaseUntil = new Date(requeueAt.getTime() + 60_000);
    const legacyClaim = await Delivery.findOneAndUpdate(
      { _id: claim!.id, status: 'capability_pending', availableAt: { $lte: requeueAt } },
      {
        $set: {
          status: 'capability_leased',
          leaseBy: 'old-worker',
          leaseUntil: legacyLeaseUntil,
          claimToken: 'old-success-claim',
        },
      },
      { new: true },
    ).lean();
    expect(legacyClaim).toMatchObject({
      status: 'capability_leased',
      capabilityStatus: 'dead',
    });

    const completedAt = new Date(requeueAt.getTime() + 1_000);
    /** Exact terminal write left by the pre-shield worker: the outer lifecycle
     * succeeds while the private lifecycle remains unknown and stale. */
    await Delivery.updateOne(
      {
        _id: claim!.id,
        status: 'capability_leased',
        leaseBy: 'old-worker',
        claimToken: 'old-success-claim',
      },
      {
        $set: {
          status: 'succeeded',
          attempts: 2,
          result: { status: 'legacy-complete' },
          settledAt: completedAt,
        },
        $unset: {
          leaseBy: 1,
          leaseUntil: 1,
          claimToken: 1,
          lastError: 1,
        },
      },
    );

    await expect(
      methods.getAgentTriggerDelivery(queued.delivery.deliveryKey),
    ).resolves.toMatchObject({
      status: 'succeeded',
      result: { status: 'legacy-complete' },
    });
    await expect(methods.getAgentTriggerDeadLetters()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: claim!.id })]),
    );
  });

  it('allocates a replica-stable monotonic sequence within an ordering lane', async () => {
    const user = new mongoose.Types.ObjectId();
    const replicas = [
      createAgentTriggerDeliveryMethods(mongoose),
      createAgentTriggerDeliveryMethods(mongoose),
    ];
    const enqueued = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        replicas[index % replicas.length].enqueueAgentTriggerDelivery(
          enqueueInput({ user, orderingKey: 'shared-lane' }),
        ),
      ),
    );

    expect(enqueued.map(({ delivery }) => delivery.laneSequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it('does not publish a later requeue through a stale lane reservation', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'stale-publication-generation';
    const originalUpdateOne = Delivery.collection.updateOne.bind(Delivery.collection);
    let releaseStalePublication!: () => void;
    let stalePublicationPaused!: () => void;
    const stalePublicationGate = new Promise<void>((resolve) => {
      releaseStalePublication = resolve;
    });
    const stalePublicationObserved = new Promise<void>((resolve) => {
      stalePublicationPaused = resolve;
    });
    let paused = false;
    const updateSpy = jest
      .spyOn(Delivery.collection, 'updateOne')
      .mockImplementation(async (filter, update, options) => {
        const status = (filter.status ??
          (filter.$or as Array<{ status?: { $in?: string[] } }> | undefined)?.find(
            (condition) => condition.status != null,
          )?.status) as { $in?: string[] } | undefined;
        if (
          !paused &&
          filter.orderingKey === orderingKey &&
          status?.$in?.includes('staging') === true &&
          filter.requeueCount === 0
        ) {
          paused = true;
          stalePublicationPaused();
          await stalePublicationGate;
        }
        return originalUpdateOne(filter, update, options);
      });

    try {
      const enqueue = methods.enqueueAgentTriggerDelivery(enqueueInput({ user, orderingKey }));
      await stalePublicationObserved;

      await expect(methods.recoverAgentTriggerLanePublications(1)).resolves.toBe(1);
      const published = await Delivery.findOne({ orderingKey }).lean();
      expect(published).toMatchObject({ status: 'pending', laneSequence: 1, requeueCount: 0 });

      await originalUpdateOne(
        { _id: published!._id },
        {
          $set: {
            status: 'staging',
            laneSequence: 0,
            requeueCount: 1,
            stagingRecoveryAt: new Date(),
          },
        },
      );
      await LaneSequence.updateOne(
        {
          _id: orderingKey,
          value: 1,
          publisherDeliveryId: { $exists: false },
        },
        {
          $inc: { value: 1 },
          $set: {
            publisherDeliveryId: published!._id,
            publisherRequeueCount: 1,
            publisherStartedAt: new Date(),
          },
        },
      );

      releaseStalePublication();
      await expect(enqueue).resolves.toMatchObject({
        delivery: { status: 'pending', laneSequence: 2, requeueCount: 1 },
      });
      await expect(Delivery.findById(published!._id).lean()).resolves.toMatchObject({
        status: 'pending',
        laneSequence: 2,
        requeueCount: 1,
      });
    } finally {
      releaseStalePublication();
      updateSpy.mockRestore();
    }
  });

  it('coalesces a concurrent replica burst behind one claimable root and settles every receipt', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceUntil = new Date(Date.now() + 60_000);
    const coalesceFrom = new Date(coalesceUntil.getTime() - 750);
    const replicas = [
      createAgentTriggerDeliveryMethods(mongoose),
      createAgentTriggerDeliveryMethods(mongoose),
    ];
    const inputs = Array.from({ length: 4 }, (_, index) =>
      enqueueInput({
        user,
        orderingKey: 'commentary-lane',
        coalesceKey: 'trigger_batch_commentary',
        coalesceFrom,
        coalesceUntil,
        availableAt: coalesceUntil,
        awaitTerminalHandling: true,
        envelopeBytes: 128,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-1' },
          event: {
            id: `event-${index}`,
            source: { id: 'source-key', type: 'remote_api_key' },
          },
        },
      }),
    );
    const queued = await Promise.all(
      inputs.map((input, index) =>
        replicas[index % replicas.length].enqueueAgentTriggerDelivery(input),
      ),
    );
    const persisted = await Delivery.find({ orderingKey: 'commentary-lane' })
      .sort({ laneSequence: 1 })
      .lean();
    const [root] = persisted.filter((row) => row.status === 'pending');

    expect(persisted.filter((row) => row.status === 'pending')).toHaveLength(1);
    expect(persisted.filter((row) => row.status === 'batched')).toHaveLength(3);
    expect(root).toMatchObject({ batchSize: 4, batchBytes: 512 });
    expect(root?.batchMemberIds).toHaveLength(3);

    const claims = await Promise.all(
      replicas.map((replica, index) =>
        replica.claimNextAgentTriggerDelivery({
          workerId: `worker-${index}`,
          claimToken: `claim-${index}`,
          now: coalesceUntil,
          leaseUntil: new Date(coalesceUntil.getTime() + 60_000),
        }),
      ),
    );
    const [claim] = claims.filter((candidate) => candidate != null);
    expect(claims.filter((candidate) => candidate != null)).toHaveLength(1);
    expect(claim).toBeDefined();
    const members = await methods.getAgentTriggerDeliveryBatch(claim!);
    expect(members.map((member) => member.deliveryKey)).toHaveLength(3);

    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: claim!.leaseBy,
      claimToken: claim!.claimToken,
      now: coalesceUntil,
    });
    const result = {
      mode: 'continue',
      status: 'started',
      conversationId: 'child-thread',
      streamId: 'child-thread',
      generationCreatedAt: 1_787_000_000_000,
    };
    await expect(
      methods.completeAgentTriggerDelivery({
        id: claim!.id,
        workerId: claim!.leaseBy,
        claimToken: claim!.claimToken,
        attempt: attempt!,
        result,
        settledAt: coalesceUntil,
        awaitTerminalHandling: true,
        handling: {
          status: 'started',
          conversationId: 'child-thread',
          streamId: 'child-thread',
          generationCreatedAt: 1_787_000_000_000,
          startedAt: coalesceUntil,
        },
      }),
    ).resolves.toBe(true);

    const settled = await Delivery.find({ orderingKey: 'commentary-lane' }).lean();
    expect(settled).toHaveLength(4);
    expect(settled.every((row) => row.status === 'succeeded')).toBe(true);
    expect(settled.map((row) => row.result)).toEqual(Array(4).fill(result));
    expect(new Set(queued.map(({ delivery }) => delivery.deliveryKey)).size).toBe(4);
    const receipts = await Promise.all(
      queued.map(({ delivery }) =>
        methods.getAgentTriggerDeliveryStatus(delivery.deliveryKey, user, 'source-key', 'tenant-1'),
      ),
    );
    expect(receipts).toHaveLength(4);
    expect(receipts.every((receipt) => receipt?.status === 'succeeded')).toBe(true);
    expect(receipts.every((receipt) => receipt?.handling?.status === 'started')).toBe(true);
    expect(
      (
        await Delivery.find({ _id: { $in: queued.map(({ delivery }) => delivery.id) } }).lean()
      ).every((row) => row.expiresAt == null),
    ).toBe(true);

    const later = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'commentary-lane',
        awaitTerminalHandling: true,
        availableAt: coalesceUntil,
      }),
    );
    const laterClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-later',
      claimToken: 'claim-later',
      now: coalesceUntil,
      leaseUntil: new Date(coalesceUntil.getTime() + 60_000),
    });
    expect(laterClaim?.id).toBe(later.delivery.id);
    await expect(methods.findEarlierAgentTriggerDelivery(laterClaim!)).resolves.toMatchObject({
      reason: 'active_handling',
    });

    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: root!.deliveryKey,
        conversationId: 'child-thread',
        generationCreatedAt: 1_787_000_000_000,
        status: 'completed_no_action',
        settledAt: new Date(coalesceUntil.getTime() + 1_000),
      }),
    ).resolves.toBe(true);
    await expect(methods.findEarlierAgentTriggerDelivery(laterClaim!)).resolves.toBeNull();

    let terminal = await Delivery.find({ orderingKey: 'commentary-lane' }).lean();
    const batchIds = new Set(queued.map(({ delivery }) => delivery.id));
    expect(
      terminal
        .filter((row) => batchIds.has(String(row._id)))
        .every((row) => row.handling?.status === 'completed_no_action'),
    ).toBe(true);

    const recoveringMember = terminal.find(
      (row) => batchIds.has(String(row._id)) && String(row._id) !== String(root!._id),
    );
    await Delivery.updateOne(
      { _id: recoveringMember!._id },
      { $set: { 'handling.status': 'started' } },
    );
    await expect(methods.findEarlierAgentTriggerDelivery(laterClaim!)).resolves.toBeNull();
    await Delivery.updateOne({ _id: recoveringMember!._id }, { $unset: { handling: 1 } });
    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: root!.deliveryKey,
        conversationId: 'child-thread',
        generationCreatedAt: 1_787_000_000_000,
        status: 'completed_no_action',
        settledAt: new Date(coalesceUntil.getTime() + 1_000),
      }),
    ).resolves.toBe(true);
    terminal = await Delivery.find({ orderingKey: 'commentary-lane' }).lean();
    expect(
      terminal
        .filter((row) => batchIds.has(String(row._id)))
        .every((row) => row.handling?.status === 'completed_no_action'),
    ).toBe(true);
    expect(
      terminal
        .filter((row) => batchIds.has(String(row._id)))
        .every(
          (row) =>
            row.expiresAt?.getTime() === coalesceUntil.getTime() + 1_000 + 90 * 24 * 60 * 60_000,
        ),
    ).toBe(true);
  });

  it('promotes mailbox semantics when an enabled delivery joins an unmarked batch root', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceUntil = new Date(Date.now() + 60_000);
    const shared = {
      user,
      orderingKey: 'mixed-rollout-batch',
      coalesceKey: 'trigger_batch_mixed_rollout',
      coalesceFrom: new Date(coalesceUntil.getTime() - 750),
      coalesceUntil,
      availableAt: coalesceUntil,
      envelopeBytes: 128,
    };
    const first = await methods.enqueueAgentTriggerDelivery(enqueueInput(shared));
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ ...shared, awaitTerminalHandling: true }),
    );

    const root = await Delivery.findById(first.delivery.id).lean();
    expect(root).toMatchObject({
      status: 'pending',
      awaitTerminalHandling: true,
      batchSize: 2,
    });
  });

  it.each(['complete', 'dead', 'cleanup'] as const)(
    'signals maintenance after %s finalization fails without undoing root settlement',
    async (mode) => {
      const user = new mongoose.Types.ObjectId();
      const coalesceUntil = new Date(Date.now() + 60_000);
      const shared = {
        user,
        orderingKey: 'inline-recovery',
        coalesceKey: 'inline-batch',
        coalesceFrom: new Date(coalesceUntil.getTime() - 750),
        coalesceUntil,
        availableAt: coalesceUntil,
        envelopeBytes: 128,
      };
      const root = await methods.enqueueAgentTriggerDelivery(enqueueInput(shared));
      if (mode !== 'cleanup') await methods.enqueueAgentTriggerDelivery(enqueueInput(shared));
      const claimed = await methods.claimNextAgentTriggerDelivery({
        workerId: 'worker-1',
        claimToken: 'inline-finalization-claim',
        now: coalesceUntil,
        leaseUntil: new Date(coalesceUntil.getTime() + 60_000),
      });
      expect(claimed?.id).toBe(root.delivery.id);
      const input = {
        id: claimed!.id,
        workerId: 'worker-1',
        claimToken: claimed!.claimToken!,
        attempt: 1,
        settledAt: coalesceUntil,
      };
      const failure =
        mode === 'cleanup'
          ? jest
              .spyOn(LaneSequence, 'updateOne')
              .mockRejectedValueOnce(new Error('cleanup interrupted'))
          : jest
              .spyOn(Delivery, 'updateMany')
              .mockRejectedValueOnce(new Error('batch interrupted'));
      const recovery = { required: false };
      try {
        const settled =
          mode === 'dead'
            ? await methods.deadLetterAgentTriggerDelivery(
                { ...input, error: transientFailure({ retryable: false }) },
                recovery,
              )
            : await methods.completeAgentTriggerDelivery(
                { ...input, result: { accepted: true } },
                recovery,
              );
        expect(settled).toBe(true);
        expect(recovery.required).toBe(true);
      } finally {
        failure.mockRestore();
      }
      expect((await Delivery.findById(root.delivery.id).lean())?.status).toBe(
        mode === 'dead' ? 'dead' : 'succeeded',
      );
      await methods.recoverAgentTriggerBatchReceipts();
      await methods.reclaimInactiveAgentTriggerLanes();
      const rows = await Delivery.find({ orderingKey: shared.orderingKey }).lean();
      expect(rows.every((row) => row.status === (mode === 'dead' ? 'dead' : 'succeeded'))).toBe(
        true,
      );
      if (mode !== 'dead') expect(await LaneSequence.findById(shared.orderingKey)).toBeNull();
    },
  );

  it('recovers batch receipts and lane cleanup after root settlement was interrupted', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceUntil = new Date(Date.now() + 60_000);
    const coalesceFrom = new Date(coalesceUntil.getTime() - 750);
    await Promise.all(
      Array.from({ length: 2 }, (_, index) =>
        methods.enqueueAgentTriggerDelivery(
          enqueueInput({
            user,
            orderingKey: 'batch-recovery-lane',
            coalesceKey: 'trigger_batch_recovery',
            coalesceFrom,
            coalesceUntil,
            availableAt: coalesceUntil,
            envelopeBytes: 128,
            envelope: {
              event: {
                id: `recovery-event-${index}`,
                source: { id: 'source-key', type: 'remote_api_key' },
              },
            },
          }),
        ),
      ),
    );
    const root = await Delivery.findOne({
      orderingKey: 'batch-recovery-lane',
      status: 'pending',
    }).lean();
    expect(root?._id).toBeDefined();
    const result = { mode: 'continue', status: 'started', conversationId: 'child-thread' };
    await Delivery.updateOne(
      { _id: root!._id },
      {
        $set: {
          status: 'succeeded',
          attempts: 1,
          result,
          settledAt: START,
          expiresAt: new Date(START.getTime() + 90 * 24 * 60 * 60_000),
          laneCleanupPendingAt: START,
        },
      },
    );

    await expect(methods.recoverAgentTriggerBatchReceipts()).resolves.toBe(1);

    const deliveries = await Delivery.find({ orderingKey: 'batch-recovery-lane' }).lean();
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => delivery.status === 'succeeded')).toBe(true);
    expect(deliveries.map((delivery) => delivery.result)).toEqual(Array(2).fill(result));
    expect(deliveries.find((delivery) => String(delivery._id) === String(root!._id))).toMatchObject(
      {
        batchMembersSettledAt: START,
      },
    );
    expect(await LaneSequence.exists({ _id: 'batch-recovery-lane' })).toBeNull();

    await expect(methods.recoverAgentTriggerBatchReceipts()).resolves.toBe(0);
    const histories = await Delivery.find({ orderingKey: 'batch-recovery-lane' })
      .select('history')
      .lean();
    expect(histories.map(({ history }) => history?.length ?? 0).sort()).toEqual([0, 1]);
  });

  it('starts the next linear batch outside the collection window and enforces the size cap', async () => {
    const user = new mongoose.Types.ObjectId();
    const openUntil = new Date(Date.now() + 60_000);
    const openFrom = new Date(openUntil.getTime() - 750);
    const inputs = Array.from({ length: 9 }, () =>
      enqueueInput({
        user,
        orderingKey: 'bounded-lane',
        coalesceKey: 'trigger_batch_bounded',
        coalesceFrom: openFrom,
        coalesceUntil: openUntil,
        availableAt: openUntil,
        envelopeBytes: 64,
      }),
    );
    await Promise.all(inputs.map((input) => methods.enqueueAgentTriggerDelivery(input)));

    expect(await Delivery.countDocuments({ orderingKey: 'bounded-lane', status: 'pending' })).toBe(
      2,
    );
    expect(await Delivery.countDocuments({ orderingKey: 'bounded-lane', status: 'batched' })).toBe(
      7,
    );

    const closedUntil = new Date(Date.now() - 1);
    const closedFrom = new Date(closedUntil.getTime() - 750);
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'closed-lane',
        coalesceKey: 'trigger_batch_closed',
        coalesceFrom: closedFrom,
        coalesceUntil: closedUntil,
        availableAt: closedUntil,
        envelopeBytes: 64,
      }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'closed-lane',
        coalesceKey: 'trigger_batch_closed',
        coalesceFrom: closedFrom,
        coalesceUntil: closedUntil,
        availableAt: closedUntil,
        envelopeBytes: 64,
      }),
    );
    expect(await Delivery.countDocuments({ orderingKey: 'closed-lane', status: 'pending' })).toBe(
      2,
    );

    const nearUntil = new Date(Date.now() + 60_000);
    const distantUntil = new Date(nearUntil.getTime() + 24 * 60 * 60_000);
    const nearFrom = new Date(nearUntil.getTime() - 750);
    const distantFrom = new Date(distantUntil.getTime() - 750);
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'scheduled-lane',
        coalesceKey: 'trigger_batch_scheduled',
        coalesceFrom: nearFrom,
        coalesceUntil: nearUntil,
        availableAt: nearUntil,
        envelopeBytes: 64,
      }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'scheduled-lane',
        coalesceKey: 'trigger_batch_scheduled',
        coalesceFrom: distantFrom,
        coalesceUntil: distantUntil,
        availableAt: distantUntil,
        envelopeBytes: 64,
      }),
    );
    expect(
      await Delivery.countDocuments({ orderingKey: 'scheduled-lane', status: 'pending' }),
    ).toBe(2);
  });

  it('intersects overlapping batch windows regardless of publication order', async () => {
    const user = new mongoose.Types.ObjectId();
    const earlierFrom = new Date(Date.now() + 60_000);
    const earlierUntil = new Date(earlierFrom.getTime() + 750);
    const laterFrom = new Date(earlierFrom.getTime() + 250);
    const laterUntil = new Date(laterFrom.getTime() + 750);
    const shared = {
      user,
      orderingKey: 'overlapping-window-lane',
      coalesceKey: 'trigger_batch_overlapping',
      envelopeBytes: 64,
    };

    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        ...shared,
        coalesceFrom: laterFrom,
        coalesceUntil: laterUntil,
        availableAt: laterUntil,
      }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        ...shared,
        coalesceFrom: earlierFrom,
        coalesceUntil: earlierUntil,
        availableAt: earlierUntil,
      }),
    );

    const rows = await Delivery.find({ orderingKey: shared.orderingKey }).lean();
    const root = rows.find((row) => row.status === 'pending');
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'batched')).toHaveLength(1);
    expect(root).toMatchObject({
      batchSize: 2,
      coalesceFrom: laterFrom,
      coalesceUntil: earlierUntil,
      availableAt: earlierUntil,
    });
  });

  it('starts a new batch when another delivery has taken the lane tail', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceFrom = new Date(Date.now() + 60_000);
    const coalesceUntil = new Date(coalesceFrom.getTime() + 750);
    const shared = {
      user,
      orderingKey: 'intervening-delivery-lane',
      coalesceFrom,
      coalesceUntil,
      availableAt: coalesceUntil,
      envelopeBytes: 64,
    };

    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ ...shared, coalesceKey: 'trigger_batch_first' }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ ...shared, coalesceKey: 'trigger_batch_intervening' }),
    );
    await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ ...shared, coalesceKey: 'trigger_batch_first' }),
    );

    const rows = await Delivery.find({ orderingKey: shared.orderingKey })
      .sort({ laneSequence: 1 })
      .lean();
    expect(rows.map(({ status }) => status)).toEqual(['pending', 'pending', 'pending']);
    expect(rows.map(({ batchSize }) => batchSize)).toEqual([1, 1, 1]);
  });

  it('requeues a dead batch as a root instead of nesting it under a newer batch', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceUntil = new Date(Date.now() + 60_000);
    const coalesceFrom = new Date(coalesceUntil.getTime() - 750);
    const shared = {
      user,
      orderingKey: 'batch-requeue-lane',
      coalesceKey: 'trigger_batch_requeue',
      coalesceFrom,
      coalesceUntil,
      availableAt: coalesceUntil,
      envelopeBytes: 128,
    };
    await Promise.all(
      Array.from({ length: 2 }, () => methods.enqueueAgentTriggerDelivery(enqueueInput(shared))),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: coalesceUntil,
      leaseUntil: new Date(coalesceUntil.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: coalesceUntil,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      error: transientFailure({ retryable: false }),
      settledAt: coalesceUntil,
    });
    await methods.enqueueAgentTriggerDelivery(enqueueInput(shared));

    const requeued = await methods.requeueAgentTriggerDelivery(claim!.id, coalesceUntil);

    expect(requeued).toMatchObject({ status: 'pending', batchSize: 2 });
    expect(requeued?.requeueCount).toBe(1);
    expect(requeued?.batchRootId).toBeUndefined();
    const rows = await Delivery.find({ orderingKey: 'batch-requeue-lane' }).lean();
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(2);
    expect(
      rows.filter((row) => row.batchRootId != null && String(row.batchRootId) === claim!.id),
    ).toHaveLength(1);
    expect(rows.find((row) => row.status === 'batched')?.batchRootRequeueCount).toBe(1);
  });

  it('does not let stale batch operations overwrite a receipt from a newer generation', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceUntil = new Date(Date.now() + 60_000);
    const shared = {
      user,
      orderingKey: 'batch-generation-lane',
      coalesceKey: 'trigger_batch_generation',
      coalesceFrom: new Date(coalesceUntil.getTime() - 750),
      coalesceUntil,
      availableAt: coalesceUntil,
      envelopeBytes: 128,
    };
    await Promise.all(
      Array.from({ length: 2 }, () => methods.enqueueAgentTriggerDelivery(enqueueInput(shared))),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: coalesceUntil,
      leaseUntil: new Date(coalesceUntil.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: coalesceUntil,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      error: transientFailure({ retryable: false }),
      settledAt: coalesceUntil,
    });
    const root = await Delivery.findById(claim!.id).lean();
    const memberId = root!.batchMemberIds![0];
    await Delivery.updateOne({ _id: root!._id }, { $unset: { batchMembersSettledAt: 1 } });
    await Delivery.updateOne(
      { _id: memberId },
      {
        $set: {
          status: 'succeeded',
          batchRootRequeueCount: 1,
          settledAt: new Date(coalesceUntil.getTime() + 1_000),
        },
        $unset: { lastError: 1 },
      },
    );

    await expect(methods.requeueAgentTriggerDelivery(claim!.id, coalesceUntil)).rejects.toThrow(
      'Not every agent trigger batch receipt could be prepared for requeue',
    );
    await expect(Delivery.findById(memberId).lean()).resolves.toMatchObject({
      status: 'succeeded',
      batchRootRequeueCount: 1,
    });
    await expect(methods.recoverAgentTriggerLanePublications()).rejects.toThrow(
      'Not every agent trigger batch receipt could be prepared for requeue',
    );
    await expect(Delivery.findById(memberId).lean()).resolves.toMatchObject({
      status: 'succeeded',
      batchRootRequeueCount: 1,
    });
    expect((await Delivery.findById(root!._id).lean())?.batchMembersSettledAt).toBeUndefined();
  });

  it('recovers batch requeue after claiming the root before member preparation', async () => {
    const user = new mongoose.Types.ObjectId();
    const coalesceUntil = new Date(Date.now() + 60_000);
    const shared = {
      user,
      orderingKey: 'batch-requeue-recovery-lane',
      coalesceKey: 'trigger_batch_requeue_recovery',
      coalesceFrom: new Date(coalesceUntil.getTime() - 750),
      coalesceUntil,
      availableAt: coalesceUntil,
      envelopeBytes: 128,
    };
    await Promise.all(
      Array.from({ length: 2 }, () => methods.enqueueAgentTriggerDelivery(enqueueInput(shared))),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: coalesceUntil,
      leaseUntil: new Date(coalesceUntil.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: coalesceUntil,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      error: transientFailure({ retryable: false }),
      settledAt: coalesceUntil,
    });
    const transition = jest.spyOn(Delivery, 'updateMany').mockImplementationOnce(() => {
      throw new Error('process interrupted before member preparation');
    });

    await expect(methods.requeueAgentTriggerDelivery(claim!.id, coalesceUntil)).rejects.toThrow(
      'process interrupted before member preparation',
    );
    transition.mockRestore();
    await expect(Delivery.findById(claim!.id).lean()).resolves.toMatchObject({
      status: 'staging',
      requeueCount: 1,
    });
    const preparedMember = await Delivery.findOne({ batchRootId: claim!.id }).lean();
    expect(preparedMember).toMatchObject({ status: 'dead' });

    await expect(methods.recoverAgentTriggerLanePublications()).resolves.toBeGreaterThan(0);
    await expect(Delivery.findById(claim!.id).lean()).resolves.toMatchObject({
      status: 'pending',
      requeueCount: 1,
    });
    await expect(Delivery.findById(preparedMember!._id).lean()).resolves.toMatchObject({
      status: 'batched',
      batchRootRequeueCount: 1,
    });
  });

  it('publishes an abandoned lane owner before allocating the next sequence', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'publication-race';
    const firstInput = enqueueInput({ user, orderingKey, availableAt: START });
    const first = await Delivery.create({
      ...firstInput,
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });
    await LaneSequence.create({
      _id: orderingKey,
      value: 1,
      user,
      tailDeliveryId: first._id,
      publisherDeliveryId: first._id,
      publisherStartedAt: START,
    });

    const second = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ user, orderingKey, availableAt: START }),
    );

    await expect(Delivery.findById(first._id).lean()).resolves.toMatchObject({
      status: 'pending',
      laneSequence: 1,
    });
    expect(second.delivery).toMatchObject({ status: 'pending', laneSequence: 2 });
    await expect(methods.findEarlierAgentTriggerDelivery(second.delivery)).resolves.toEqual({
      availableAt: START,
    });
    await expect(LaneSequence.findById(orderingKey).lean()).resolves.toMatchObject({ value: 2 });
    expect((await LaneSequence.findById(orderingKey).lean())?.publisherDeliveryId).toBeUndefined();
  });

  it('publishes an orphaned staging row before a later delivery in the lane', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'orphaned-staging';
    const firstInput = enqueueInput({ user, orderingKey, availableAt: START });
    const first = await Delivery.create({
      ...firstInput,
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });

    const second = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ user, orderingKey, availableAt: START }),
    );

    await expect(Delivery.findById(first._id).lean()).resolves.toMatchObject({
      status: 'pending',
      laneSequence: 1,
    });
    expect(second.delivery).toMatchObject({ status: 'pending', laneSequence: 2 });
    await expect(methods.findEarlierAgentTriggerDelivery(second.delivery)).resolves.toEqual({
      availableAt: START,
    });
  });

  it('discovers an orphaned staging row during maintenance recovery', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'maintenance-staging';
    const staged = await Delivery.create({
      ...enqueueInput({ user, orderingKey }),
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
      stagingRecoveryAt: START,
    });

    await expect(methods.recoverAgentTriggerLanePublications(1)).resolves.toBe(1);
    await expect(Delivery.findById(staged._id).lean()).resolves.toMatchObject({
      status: 'pending',
      laneSequence: 1,
    });
    await expect(LaneSequence.findById(orderingKey).lean()).resolves.toMatchObject({ value: 1 });
  });

  it('backfills and recovers a staging row created before the fairness cursor existed', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'legacy-maintenance-staging';
    const staged = await Delivery.create({
      ...enqueueInput({ user, orderingKey }),
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });

    await expect(methods.recoverAgentTriggerLanePublications(1)).resolves.toBe(1);
    await expect(Delivery.findById(staged._id).lean()).resolves.toMatchObject({
      status: 'pending',
      laneSequence: 1,
    });
  });

  it('leaves staging unpublished while its durable user purge marker exists', async () => {
    const emptyActivity = { found: false };
    await expect(methods.recoverAgentTriggerLanePublications(1, emptyActivity)).resolves.toBe(0);
    expect(emptyActivity.found).toBe(false);
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'purge-fenced-staging';
    await UserPurge.create({ _id: user, fenceStartedAt: START, tenantId: 'tenant-1' });
    const staged = await Delivery.create({
      ...enqueueInput({ user, orderingKey }),
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
      stagingRecoveryAt: START,
    });

    const activity = { found: false };
    await expect(methods.recoverAgentTriggerLanePublications(1, activity)).resolves.toBe(0);
    expect(activity.found).toBe(true);
    await expect(Delivery.findById(staged._id).lean()).resolves.toMatchObject({
      status: 'staging',
      laneSequence: 0,
    });
    await expect(LaneSequence.findById(orderingKey)).resolves.toBeNull();
  });

  it('leaves an existing lane publisher fenced while its user purge marker exists', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'purge-fenced-publisher';
    await UserPurge.create({ _id: user, fenceStartedAt: START, tenantId: 'tenant-1' });
    const staged = await Delivery.create({
      ...enqueueInput({ user, orderingKey }),
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });
    await LaneSequence.create({
      _id: orderingKey,
      value: 1,
      user,
      tailDeliveryId: staged._id,
      publisherDeliveryId: staged._id,
      publisherStartedAt: START,
    });

    await expect(methods.recoverAgentTriggerLanePublications(1)).resolves.toBe(0);
    await expect(Delivery.findById(staged._id).lean()).resolves.toMatchObject({
      status: 'staging',
      laneSequence: 0,
    });
    await expect(LaneSequence.findById(orderingKey).lean()).resolves.toMatchObject({
      publisherDeliveryId: staged._id,
      value: 1,
    });
  });

  it('rotates purge-fenced staging rows so later recovery work is not starved', async () => {
    const users = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
    for (let index = 0; index < users.length; index += 1) {
      if (index < 2) {
        await UserPurge.create({ _id: users[index], fenceStartedAt: START });
      }
      await Delivery.create({
        ...enqueueInput({ user: users[index], orderingKey: `staging-rotation-${index}` }),
        laneSequence: 0,
        status: 'staging',
        attempts: 0,
        requeueCount: 0,
        stagingRecoveryAt: new Date(START.getTime() + index),
      });
    }

    await expect(methods.recoverAgentTriggerLanePublications(2)).resolves.toBe(0);
    await expect(methods.recoverAgentTriggerLanePublications(2)).resolves.toBe(1);
    await expect(
      Delivery.findOne({ orderingKey: 'staging-rotation-2' }).lean(),
    ).resolves.toMatchObject({ status: 'pending', laneSequence: 1 });
  });

  it('rotates purge-fenced publishers so later recovery work is not starved', async () => {
    const users = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
    for (let index = 0; index < users.length; index += 1) {
      if (index < 2) {
        await UserPurge.create({ _id: users[index], fenceStartedAt: START });
      }
      const orderingKey = `publisher-rotation-${index}`;
      const staged = await Delivery.create({
        ...enqueueInput({ user: users[index], orderingKey }),
        laneSequence: 0,
        status: 'staging',
        attempts: 0,
        requeueCount: 0,
        stagingRecoveryAt: START,
      });
      await LaneSequence.create({
        _id: orderingKey,
        value: 1,
        user: users[index],
        publisherDeliveryId: staged._id,
        publisherStartedAt: new Date(START.getTime() + index),
      });
    }

    await expect(methods.recoverAgentTriggerLanePublications(2)).resolves.toBe(0);
    await expect(methods.recoverAgentTriggerLanePublications(2)).resolves.toBe(1);
    await expect(
      Delivery.findOne({ orderingKey: 'publisher-rotation-2' }).lean(),
    ).resolves.toMatchObject({ status: 'pending', laneSequence: 1 });
  });

  it('abandons a lane acquired concurrently with a new purge marker', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'purge-race-staging';
    const staged = await Delivery.create({
      ...enqueueInput({ user, orderingKey }),
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });
    const purgeExists = jest
      .spyOn(UserPurge, 'exists')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: user } as never);

    try {
      await expect(methods.recoverAgentTriggerLanePublications(1)).resolves.toBe(0);
    } finally {
      purgeExists.mockRestore();
    }
    await expect(Delivery.findById(staged._id).lean()).resolves.toMatchObject({
      status: 'staging',
      laneSequence: 0,
    });
    await expect(LaneSequence.findById(orderingKey)).resolves.toBeNull();
  });

  it('builds a sparse index for the periodic publisher recovery scan', async () => {
    const [laneIndexes, deliveryIndexes] = await Promise.all([
      LaneSequence.collection.indexes(),
      Delivery.collection.indexes(),
    ]);

    expect(laneIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { publisherStartedAt: 1 }, sparse: true }),
      ]),
    );
    expect(deliveryIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { stagingRecoveryAt: 1 }, sparse: true }),
        expect.objectContaining({ key: { laneCleanupPendingAt: 1 }, sparse: true }),
      ]),
    );
  });

  it("indexes a user's waiting deliveries for settle-time expediting", async () => {
    const deliveryIndexes = await Delivery.collection.indexes();
    const userIndex = deliveryIndexes.find(
      (index) =>
        JSON.stringify(index.key) === JSON.stringify({ user: 1, status: 1, availableAt: 1 }),
    );
    expect(userIndex).toBeDefined();
    /** A sparse index would skip every row the expedite and listing reads need. */
    expect(userIndex?.sparse).toBeUndefined();
    expect(userIndex?.partialFilterExpression).toBeUndefined();
  });

  it('publishes an idempotent replay on its persisted ordering lane', async () => {
    const user = new mongoose.Types.ObjectId();
    const input = enqueueInput({ user, orderingKey: 'original-lane' });
    await Delivery.create({
      ...input,
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });

    const replay = await methods.enqueueAgentTriggerDelivery({
      ...input,
      orderingKey: 'changed-lane',
    });

    expect(replay).toMatchObject({
      replayed: true,
      delivery: { orderingKey: 'original-lane', laneSequence: 1, status: 'pending' },
    });
    await expect(LaneSequence.findById('original-lane').lean()).resolves.toMatchObject({
      value: 1,
    });
    await expect(LaneSequence.findById('changed-lane').lean()).resolves.toBeNull();
  });

  it('resumes its own abandoned publication without allocating a second sequence', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'publication-replay';
    const input = enqueueInput({ user, orderingKey, availableAt: START });
    const staged = await Delivery.create({
      ...input,
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });
    await LaneSequence.create({
      _id: orderingKey,
      value: 1,
      user,
      tailDeliveryId: staged._id,
      publisherDeliveryId: staged._id,
      publisherStartedAt: START,
    });

    const replay = await methods.enqueueAgentTriggerDelivery(input);

    expect(replay).toMatchObject({ replayed: true, delivery: { laneSequence: 1 } });
    await expect(LaneSequence.findById(orderingKey).lean()).resolves.toMatchObject({ value: 1 });
  });

  it('orders a lane by its atomic sequence instead of tied timestamps or process ObjectIds', async () => {
    const user = new mongoose.Types.ObjectId();
    const common = {
      orderingKey: 'tied-lane',
      envelope: { version: 1 },
      user,
      status: 'pending' as const,
      attempts: 0,
      availableAt: START,
      createdAt: START,
      updatedAt: START,
    };
    await Delivery.create([
      {
        ...common,
        _id: new mongoose.Types.ObjectId('ffffffffffffffffffffffff'),
        deliveryKey: 'first-by-sequence',
        fingerprint: 'first',
        laneSequence: 1,
      },
      {
        ...common,
        _id: new mongoose.Types.ObjectId('000000000000000000000001'),
        deliveryKey: 'second-by-sequence',
        fingerprint: 'second',
        laneSequence: 2,
      },
    ]);

    await expect(
      methods.findEarlierAgentTriggerDelivery({
        orderingKey: 'tied-lane',
        laneSequence: 2,
      }),
    ).resolves.toEqual({ availableAt: START });
  });

  it('honors the lease skew margin before takeover', async () => {
    await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const first = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    expect(first).not.toBeNull();

    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'worker-2',
        claimToken: 'claim-2',
        now: new Date(START.getTime() + 70_000),
        leaseUntil: new Date(START.getTime() + 130_000),
      }),
    ).resolves.toBeNull();

    await expect(
      methods.claimNextAgentTriggerDelivery({
        workerId: 'worker-2',
        claimToken: 'claim-2',
        now: new Date(START.getTime() + 91_000),
        leaseUntil: new Date(START.getTime() + 151_000),
      }),
    ).resolves.toMatchObject({ claimToken: 'claim-2', leaseBy: 'worker-2' });
  });

  it('fences every settlement against a stale claimant', async () => {
    await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const first = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 10_000),
    });
    expect(first).not.toBeNull();
    const second = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-2',
      now: new Date(START.getTime() + 41_000),
      leaseUntil: new Date(START.getTime() + 101_000),
    });
    expect(second).not.toBeNull();

    await expect(
      methods.completeAgentTriggerDelivery({
        id: first!.id,
        workerId: 'worker-1',
        claimToken: 'claim-1',
        attempt: 1,
        result: { conversationId: 'stale' },
        settledAt: START,
      }),
    ).resolves.toBe(false);
    await expect(
      methods.beginAgentTriggerDeliveryAttempt({
        id: second!.id,
        workerId: 'worker-1',
        claimToken: 'claim-2',
        now: new Date(START.getTime() + 41_000),
      }),
    ).resolves.toBe(1);
  });

  it('blocks a due delivery behind an earlier pending item in its ordering lane', async () => {
    const first = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ availableAt: new Date(START.getTime() + 60_000) }),
    );
    await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    expect(claimed?.id).not.toBe(first.delivery.id);

    await expect(methods.findEarlierAgentTriggerDelivery(claimed!)).resolves.toEqual({
      availableAt: new Date(START.getTime() + 60_000),
    });
  });

  it('keeps a binding lane queued until the earlier child turn settles', async () => {
    const user = new mongoose.Types.ObjectId();
    const first = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ user, orderingKey: 'binding-lane', awaitTerminalHandling: true }),
    );
    const firstClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const firstAttempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: firstClaim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    const generationCreatedAt = START.getTime() + 1_000;
    await methods.completeAgentTriggerDelivery({
      id: firstClaim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: firstAttempt!,
      result: {
        mode: 'continue',
        status: 'started',
        conversationId: 'actor-thread',
        streamId: 'actor-thread',
        generationCreatedAt,
      },
      settledAt: new Date(generationCreatedAt),
      awaitTerminalHandling: true,
      handling: {
        status: 'started',
        conversationId: 'actor-thread',
        streamId: 'actor-thread',
        generationCreatedAt,
        startedAt: new Date(generationCreatedAt),
      },
    });
    const second = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ user, orderingKey: 'binding-lane', awaitTerminalHandling: true }),
    );
    const secondClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-2',
      claimToken: 'claim-2',
      now: new Date(generationCreatedAt),
      leaseUntil: new Date(generationCreatedAt + 60_000),
    });

    expect(firstClaim?.id).toBe(first.delivery.id);
    expect(second.delivery.laneSequence).toBe(first.delivery.laneSequence + 1);
    await expect(methods.findEarlierAgentTriggerDelivery(secondClaim!)).resolves.toMatchObject({
      availableAt: START,
      reason: 'active_handling',
    });
    await expect(Delivery.findById(first.delivery.id).lean()).resolves.not.toHaveProperty(
      'expiresAt',
    );

    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: first.delivery.deliveryKey,
        conversationId: 'actor-thread',
        generationCreatedAt,
        status: 'applied',
        settledAt: new Date(generationCreatedAt + 1_000),
        action: { toolName: 'submit_action' },
      }),
    ).resolves.toBe(true);
    await expect(Delivery.findById(first.delivery.id).lean()).resolves.toMatchObject({
      expiresAt: new Date(generationCreatedAt + 1_000 + 90 * 24 * 60 * 60_000),
    });
    await expect(methods.findEarlierAgentTriggerDelivery(secondClaim!)).resolves.toBeNull();
  });

  it('reclaims a binding lane only after its admitted child turn settles', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({ orderingKey: 'settling-binding-lane', awaitTerminalHandling: true }),
    );
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    const generationCreatedAt = START.getTime() + 1_000;
    await methods.completeAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      result: {
        mode: 'continue',
        status: 'started',
        conversationId: 'actor-thread',
        streamId: 'actor-thread',
        generationCreatedAt,
      },
      settledAt: new Date(generationCreatedAt),
      awaitTerminalHandling: true,
      handling: {
        status: 'started',
        conversationId: 'actor-thread',
        streamId: 'actor-thread',
        generationCreatedAt,
        startedAt: new Date(generationCreatedAt),
      },
    });

    await expect(LaneSequence.findById('settling-binding-lane')).resolves.not.toBeNull();
    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: queued.delivery.deliveryKey,
        conversationId: 'actor-thread',
        generationCreatedAt,
        status: 'completed_no_action',
        settledAt: new Date(generationCreatedAt + 1_000),
      }),
    ).resolves.toBe(true);
    await expect(LaneSequence.findById('settling-binding-lane')).resolves.toBeNull();
  });

  it('records retry and success outcomes and expires only successful rows', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const first = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: first!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    await methods.retryAgentTriggerDelivery({
      id: first!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      error: transientFailure(),
      availableAt: new Date(START.getTime() + 1_000),
    });

    const second = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-2',
      claimToken: 'claim-2',
      now: new Date(START.getTime() + 1_000),
      leaseUntil: new Date(START.getTime() + 61_000),
    });
    const secondAttempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: second!.id,
      workerId: 'worker-2',
      claimToken: 'claim-2',
      now: new Date(START.getTime() + 1_000),
    });
    await methods.completeAgentTriggerDelivery({
      id: second!.id,
      workerId: 'worker-2',
      claimToken: 'claim-2',
      attempt: secondAttempt!,
      result: { conversationId: 'conversation-1' },
      settledAt: new Date(START.getTime() + 2_000),
    });

    const stored = await methods.getAgentTriggerDelivery(queued.delivery.deliveryKey);
    expect(stored).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      result: { conversationId: 'conversation-1' },
      history: [
        { attempt: 1, outcome: 'retry', workerId: 'worker-1' },
        { attempt: 2, outcome: 'succeeded', workerId: 'worker-2' },
      ],
    });
    expect(stored?.expiresAt?.getTime()).toBe(
      new Date(START.getTime() + 2_000).getTime() + 90 * 24 * 60 * 60_000,
    );
  });

  it('projects a bound continuation as started after generation admission', async () => {
    const user = new mongoose.Types.ObjectId();
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-1' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });

    await methods.completeAgentTriggerDelivery({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      result: {
        mode: 'continue',
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
      },
      settledAt: new Date(START.getTime() + 1_000),
      handling: {
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
        startedAt: new Date(START.getTime() + 1_000),
      },
    });

    await expect(
      methods.getAgentTriggerDeliveryStatus(
        queued.delivery.deliveryKey,
        user,
        'source-key-1',
        'tenant-1',
      ),
    ).resolves.toMatchObject({
      status: 'succeeded',
      handling: {
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
        startedAt: new Date(START.getTime() + 1_000),
      },
    });
  });

  it('settles only the exact started generation and rejects stale terminal callbacks', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-1' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    await methods.completeAgentTriggerDelivery({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      result: {
        mode: 'continue',
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
      },
      settledAt: new Date(START.getTime() + 1_000),
      handling: {
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
        startedAt: new Date(START.getTime() + 1_000),
      },
    });

    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: queued.delivery.deliveryKey,
        conversationId: 'conversation-1',
        generationCreatedAt: 1_786_999_999_999,
        status: 'failed',
        settledAt: new Date(START.getTime() + 2_000),
        error: 'stale failure',
      }),
    ).resolves.toBe(false);
    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: queued.delivery.deliveryKey,
        conversationId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
        status: 'failed',
        settledAt: new Date(START.getTime() + 3_000),
        error: 'provider rejected the model',
      }),
    ).resolves.toBe(true);
    await expect(
      methods.settleAgentTriggerHandlingOutcome({
        deliveryKey: queued.delivery.deliveryKey,
        conversationId: 'conversation-1',
        generationCreatedAt: 1_787_000_000_000,
        status: 'applied',
        settledAt: new Date(START.getTime() + 4_000),
        action: { toolName: 'submit_move' },
      }),
    ).resolves.toBe(false);

    await expect(
      methods.getAgentTriggerDelivery(queued.delivery.deliveryKey),
    ).resolves.toMatchObject({
      handling: {
        status: 'failed',
        settledAt: new Date(START.getTime() + 3_000),
        error: 'provider rejected the model',
      },
    });
  });

  it('settles the public outcome and exact actor receipt in one delivery row', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        awaitTerminalHandling: true,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-1' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    const generationCreatedAt = START.getTime() + 1_000;
    const actionAdmission = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      tenantId: 'tenant-1',
      bindingId: 'binding-1',
      conversationId: 'conversation-1',
      admittedAt: new Date(generationCreatedAt + 500),
      admissionId: 'admission-1',
    };
    /** The loopback child starts after the HTTP `started` response but before
     * the delivery engine commits that result, so admission must work while
     * the exact transport attempt is still leased. */
    await expect(methods.admitAgentEventActorAction(actionAdmission)).resolves.toBe(true);
    await expect(methods.hasAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(true);
    await expect(methods.getAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(
      'admission-1',
    );
    await expect(methods.admitAgentEventActorAction(actionAdmission)).resolves.toBe(false);
    const successorAdmission = { ...actionAdmission, admissionId: 'admission-2' };
    await expect(methods.admitAgentEventActorAction(successorAdmission)).resolves.toBe(false);
    await expect(methods.releaseAgentEventActorAction(actionAdmission)).resolves.toBe(true);
    await expect(methods.admitAgentEventActorAction(successorAdmission)).resolves.toBe(true);
    /** The predecessor's delayed release cannot clear its successor. */
    await expect(methods.releaseAgentEventActorAction(actionAdmission)).resolves.toBe(false);
    await expect(methods.hasAgentEventActorActionAdmission(successorAdmission)).resolves.toBe(true);
    await expect(methods.releaseAgentEventActorAction(successorAdmission)).resolves.toBe(true);
    await expect(methods.hasAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(false);
    await expect(methods.getAgentEventActorActionAdmission(actionAdmission)).resolves.toBeNull();
    /** A pre-token worker's live admission must remain opaque but protected
     * throughout a rolling upgrade. New workers may observe the fence, but
     * cannot replace or release it without its (unavailable) owner token. */
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      { $set: { actorActionAdmittedAt: actionAdmission.admittedAt } },
    );
    await expect(methods.hasAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(true);
    await expect(methods.admitAgentEventActorAction(successorAdmission)).resolves.toBe(false);
    await expect(methods.releaseAgentEventActorAction(actionAdmission)).resolves.toBe(false);
    /** An old worker can also leave a newer worker's stale token behind, then
     * write a fresh token-unaware timestamp. Timestamp ownership remains the
     * admission fence even when that retained token does not identify it. */
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      { $set: { actorActionAdmissionId: 'stale-new-worker-token' } },
    );
    await expect(methods.hasAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(true);
    await expect(methods.admitAgentEventActorAction(successorAdmission)).resolves.toBe(false);
    await expect(methods.releaseAgentEventActorAction(actionAdmission)).resolves.toBe(false);
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      { $unset: { actorActionAdmittedAt: 1, actorActionAdmissionId: 1 } },
    );
    await methods.completeAgentTriggerDelivery({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      result: { status: 'started' },
      settledAt: new Date(generationCreatedAt),
      awaitTerminalHandling: true,
      handling: {
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt,
        startedAt: new Date(generationCreatedAt),
      },
    });
    const activeDelivery = await methods.getAgentTriggerDelivery(queued.delivery.deliveryKey);
    expect(activeDelivery).toMatchObject({ handling: { status: 'started' } });
    expect(activeDelivery).not.toHaveProperty('expiresAt');
    const actorReceipt = {
      bindingId: 'binding-1',
      resolution: 'checkpoint_verified' as const,
      checkpoint: {
        threadId: 'conversation-1',
        checkpointId: 'checkpoint-1',
        checkpointNs: 'event:1',
      },
      action: { toolName: 'submit_move', toolCallId: 'call-1' },
    };
    const settlement = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      tenantId: 'tenant-1',
      bindingId: actorReceipt.bindingId,
      conversationId: 'conversation-1',
      generationCreatedAt,
      status: 'applied' as const,
      settledAt: new Date(generationCreatedAt + 1_000),
      requiresActionAdmission: true as const,
      receipt: {
        resolution: actorReceipt.resolution,
        checkpoint: actorReceipt.checkpoint,
        action: actorReceipt.action,
      },
    };

    await expect(methods.settleAgentEventActorReceipt(settlement)).resolves.toBe(false);
    await expect(methods.admitAgentEventActorAction(actionAdmission)).resolves.toBe(true);
    await expect(methods.hasAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(true);
    await expect(methods.admitAgentEventActorAction(actionAdmission)).resolves.toBe(false);
    await expect(methods.releaseAgentEventActorAction(actionAdmission)).resolves.toBe(true);
    await expect(methods.hasAgentEventActorActionAdmission(actionAdmission)).resolves.toBe(false);
    await expect(methods.admitAgentEventActorAction(actionAdmission)).resolves.toBe(true);
    await expect(methods.settleAgentEventActorReceipt(settlement)).resolves.toBe(true);
    await expect(methods.releaseAgentEventActorAction(actionAdmission)).resolves.toBe(false);
    const settledDelivery = await Delivery.findOne({ deliveryKey: settlement.deliveryKey })
      .select('+actorActionAdmittedAt +actorActionAdmissionId')
      .lean();
    expect(settledDelivery).not.toHaveProperty('actorActionAdmittedAt');
    expect(settledDelivery).not.toHaveProperty('actorActionAdmissionId');
    await expect(
      methods.countActiveAgentTriggerDeliveriesByUser(queued.delivery.user, settlement.settledAt),
    ).resolves.toBe(0);
    /** Simulate a receipt written by the pre-normalization build after
     * transport dead-lettered the root. Exact replay must retire that dead
     * state instead of leaving a non-requeueable dead letter. */
    await Delivery.updateOne(
      { deliveryKey: settlement.deliveryKey },
      { $set: { status: 'dead', lastError: transientFailure() } },
    );
    await expect(methods.settleAgentEventActorReceipt(settlement)).resolves.toBe(true);
    await expect(
      Delivery.findOne({ deliveryKey: settlement.deliveryKey }).lean(),
    ).resolves.toMatchObject({ status: 'succeeded' });
    for (const conflict of [
      { ...settlement, user: new mongoose.Types.ObjectId() },
      { ...settlement, tenantId: 'tenant-2' },
      { ...settlement, bindingId: 'binding-2' },
      { ...settlement, conversationId: 'conversation-2' },
      {
        ...settlement,
        receipt: {
          ...settlement.receipt,
          checkpoint: { ...settlement.receipt.checkpoint, checkpointId: 'checkpoint-2' },
        },
      },
      {
        ...settlement,
        receipt: { ...settlement.receipt, action: { toolName: 'resign_game' } },
      },
      {
        ...settlement,
        status: 'failed' as const,
        receipt: { ...settlement.receipt, resolution: 'action_compensated' as const },
      },
    ]) {
      await expect(methods.settleAgentEventActorReceipt(conflict)).resolves.toBe(false);
    }
    await expect(
      methods.getAgentTriggerDelivery(queued.delivery.deliveryKey),
    ).resolves.toMatchObject({
      handling: { status: 'applied', action: actorReceipt.action },
      expiresAt: new Date(generationCreatedAt + 1_000 + 90 * 24 * 60 * 60_000),
      actorReceipt: {
        ...actorReceipt,
        settledAt: new Date(generationCreatedAt + 1_000),
      },
    });
    await expect(
      methods.getAgentEventActorReceipt({
        deliveryKey: queued.delivery.deliveryKey,
        user: queued.delivery.user,
        tenantId: 'tenant-1',
        bindingId: 'binding-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toEqual({
      ...actorReceipt,
      settledAt: new Date(generationCreatedAt + 1_000),
    });
    const publicStatus = await methods.getAgentTriggerDeliveryStatus(
      queued.delivery.deliveryKey,
      queued.delivery.user,
      'source-key-1',
      'tenant-1',
    );
    expect(publicStatus).not.toHaveProperty('actorReceipt');
    await expect(
      methods.getAgentEventActorReceipt({
        deliveryKey: queued.delivery.deliveryKey,
        user: new mongoose.Types.ObjectId(),
        tenantId: 'tenant-1',
        bindingId: 'binding-1',
        conversationId: 'conversation-1',
      }),
    ).resolves.toBeNull();
  });

  it('persists detached evidence before the started transport response settles', async () => {
    const bindingId = 'binding-detached-leased';
    const conversationId = 'conversation-detached-leased';
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        awaitTerminalHandling: true,
        tenantId: undefined,
        envelope: {
          mode: 'continue',
          target: { bindingId },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-detached-leased',
      claimToken: 'claim-detached-leased',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-detached-leased',
      claimToken: 'claim-detached-leased',
      now: START,
    });
    const generationCreatedAt = START.getTime() + 1_000;
    await expect(
      methods.admitAgentEventActorAction({
        deliveryKey: queued.delivery.deliveryKey,
        user: queued.delivery.user,
        bindingId,
        conversationId,
        admittedAt: new Date(generationCreatedAt),
        admissionId: 'admission-detached-leased',
      }),
    ).resolves.toBe(true);
    const reservation = await methods.reserveAgentEventActorDetachedAction({
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      bindingId,
      conversationId,
      generationCreatedAt,
      turnId: 'response-detached-leased:0',
      invocationId: queued.delivery.deliveryKey,
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-detached-leased',
      reservedAt: new Date(generationCreatedAt + 1_000),
      recoveryAfter: new Date(generationCreatedAt + 61_000),
    });
    expect(reservation.status).toBe('reserved');
    const update = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      bindingId,
      conversationId,
      generationCreatedAt,
      taskId: reservation.action.taskId,
      idempotencyKey: reservation.action.idempotencyKey,
      observedAt: new Date(generationCreatedAt + 2_000),
      recoveryAfter: new Date(generationCreatedAt + 1_802_000),
    };
    await expect(methods.markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
      status: 'applied',
    });
    const retryAt = new Date(generationCreatedAt + 3_000);
    await expect(
      methods.retryAgentTriggerDelivery({
        id: claimed!.id,
        workerId: 'worker-detached-leased',
        claimToken: 'claim-detached-leased',
        attempt: attempt!,
        error: transientFailure({ attemptedAt: retryAt }),
        availableAt: retryAt,
      }),
    ).resolves.toBe(true);
    await expect(methods.markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
      status: 'already_applied',
    });
    const retryClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-detached-retry',
      claimToken: 'claim-detached-retry',
      now: retryAt,
      leaseUntil: new Date(retryAt.getTime() + 60_000),
    });
    const retryAttempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: retryClaim!.id,
      workerId: 'worker-detached-retry',
      claimToken: 'claim-detached-retry',
      now: retryAt,
    });
    await expect(
      methods.deadLetterAgentTriggerDelivery({
        id: retryClaim!.id,
        workerId: 'worker-detached-retry',
        claimToken: 'claim-detached-retry',
        attempt: retryAttempt!,
        error: transientFailure({ attemptedAt: retryAt }),
        settledAt: retryAt,
      }),
    ).resolves.toBe(true);
    await expect(
      methods.settleAgentEventActorDetachedAction({
        ...update,
        status: 'succeeded',
        result: 'accepted',
        observedAt: new Date(generationCreatedAt + 4_000),
      }),
    ).resolves.toEqual({ status: 'applied' });
    await expect(
      methods.getAgentEventActorDetachedAction({
        deliveryKey: queued.delivery.deliveryKey,
        user: queued.delivery.user,
        bindingId,
        conversationId,
        generationCreatedAt,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: 'succeeded', result: 'accepted' }));
  });

  it('reserves a detached retry for the exact leased owner before handling is persisted', async () => {
    const bindingId = 'binding-detached-leased-retry';
    const conversationId = 'conversation-detached-leased-retry';
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        awaitTerminalHandling: true,
        tenantId: undefined,
        envelope: {
          mode: 'continue',
          target: { bindingId },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-detached-leased-retry',
      claimToken: 'claim-detached-leased-retry',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const generationCreatedAt = START.getTime() + 1_000;
    await expect(
      methods.admitAgentEventActorAction({
        deliveryKey: queued.delivery.deliveryKey,
        user: queued.delivery.user,
        bindingId,
        conversationId,
        admittedAt: new Date(generationCreatedAt),
        admissionId: 'admission-detached-leased-retry',
      }),
    ).resolves.toBe(true);
    const first = await methods.reserveAgentEventActorDetachedAction({
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      bindingId,
      conversationId,
      generationCreatedAt,
      turnId: 'response-detached-leased-retry:0',
      invocationId: queued.delivery.deliveryKey,
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-detached-leased-retry-1',
      reservedAt: new Date(generationCreatedAt + 1_000),
      recoveryAfter: new Date(generationCreatedAt + 61_000),
    });
    await expect(
      methods.settleAgentEventActorDetachedAction({
        deliveryKey: queued.delivery.deliveryKey,
        user: queued.delivery.user,
        bindingId,
        conversationId,
        generationCreatedAt,
        taskId: first.action.taskId,
        idempotencyKey: first.action.idempotencyKey,
        status: 'failed',
        error: 'definite adapter failure',
        observedAt: new Date(generationCreatedAt + 2_000),
      }),
    ).resolves.toEqual({ status: 'applied' });

    const retryInput = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      bindingId,
      conversationId,
      generationCreatedAt,
      turnId: 'response-detached-leased-retry:1',
      invocationId: queued.delivery.deliveryKey,
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-detached-leased-retry-2',
      reservedAt: new Date(generationCreatedAt + 3_000),
      recoveryAfter: new Date(generationCreatedAt + 63_000),
    };
    const retry = await methods.reserveAgentEventActorDetachedAction(retryInput);

    expect(retry).toMatchObject({
      status: 'reserved',
      action: {
        launchAttempt: 1,
        toolCallId: 'call-detached-leased-retry-2',
        status: 'reserved',
      },
    });
    await expect(
      methods.settleAgentEventActorDetachedAction({
        deliveryKey: queued.delivery.deliveryKey,
        user: queued.delivery.user,
        bindingId,
        conversationId,
        generationCreatedAt,
        taskId: retry.action.taskId,
        idempotencyKey: retry.action.idempotencyKey,
        status: 'failed',
        error: 'retry adapter failure',
        observedAt: new Date(generationCreatedAt + 4_000),
      }),
    ).resolves.toEqual({ status: 'applied' });
    await expect(
      methods.reserveAgentEventActorDetachedAction({
        ...retryInput,
        reservedAt: new Date(generationCreatedAt + 5_000),
        recoveryAfter: new Date(generationCreatedAt + 65_000),
      }),
    ).resolves.toMatchObject({
      status: 'replay',
      action: {
        taskId: retry.action.taskId,
        idempotencyKey: retry.action.idempotencyKey,
        launchAttempt: 1,
        status: 'failed',
      },
    });
    const stored = await Delivery.findOne({ deliveryKey: queued.delivery.deliveryKey })
      .select('+actorDetachedActionHistory')
      .lean();
    expect(stored).toMatchObject({
      status: 'leased',
      actorDetachedActionHistory: [
        expect.objectContaining({ taskId: first.action.taskId, status: 'failed' }),
      ],
    });
    expect(stored).not.toHaveProperty('handling');
  });

  it('gives one replica the detached expected-action launch reservation', async () => {
    const bindingId = 'binding-detached-1';
    const conversationId = 'conversation-detached-1';
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        awaitTerminalHandling: true,
        tenantId: undefined,
        envelope: {
          mode: 'continue',
          target: { bindingId },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-detached-1',
      claimToken: 'claim-detached-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-detached-1',
      claimToken: 'claim-detached-1',
      now: START,
    });
    const generationCreatedAt = START.getTime() + 1_000;
    const admission = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      bindingId,
      conversationId,
      admittedAt: new Date(generationCreatedAt),
      admissionId: 'admission-detached-1',
    };
    await expect(methods.admitAgentEventActorAction(admission)).resolves.toBe(true);
    await methods.completeAgentTriggerDelivery({
      id: claimed!.id,
      workerId: 'worker-detached-1',
      claimToken: 'claim-detached-1',
      attempt: attempt!,
      result: { status: 'started' },
      settledAt: new Date(generationCreatedAt),
      awaitTerminalHandling: true,
      handling: {
        status: 'started',
        conversationId,
        streamId: conversationId,
        generationCreatedAt,
        startedAt: new Date(generationCreatedAt),
      },
    });
    const reservation = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      bindingId,
      conversationId,
      generationCreatedAt,
      turnId: 'response-detached-1:0',
      invocationId: queued.delivery.deliveryKey,
      expectedToolName: 'submit_move',
      toolName: 'submit_move_mcp_chess',
      toolCallId: 'call-detached-1',
      reservedAt: new Date(generationCreatedAt + 1_000),
      recoveryAfter: new Date(generationCreatedAt + 61_000),
    };

    const contenders = await Promise.all([
      methods.reserveAgentEventActorDetachedAction(reservation),
      methods.reserveAgentEventActorDetachedAction(reservation),
    ]);

    expect(contenders.map((result) => result.status).sort()).toEqual(['replay', 'reserved']);
    expect(contenders[0].action).toEqual(contenders[1].action);
    expect(contenders[0].action).toMatchObject({
      version: 1,
      invocationId: reservation.invocationId,
      expectedToolName: reservation.expectedToolName,
      toolName: reservation.toolName,
      toolCallId: reservation.toolCallId,
      taskId: expect.stringMatching(/^event_actor_[a-f0-9]{64}$/),
      status: 'reserved',
      launchAttempt: 0,
      reservedAt: reservation.reservedAt,
    });
    expect(contenders[0].action.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    await expect(methods.reserveAgentEventActorDetachedAction(reservation)).resolves.toEqual({
      status: 'replay',
      action: contenders[0].action,
    });

    const update = {
      deliveryKey: reservation.deliveryKey,
      user: reservation.user,
      bindingId,
      conversationId,
      generationCreatedAt,
      taskId: contenders[0].action.taskId,
      idempotencyKey: contenders[0].action.idempotencyKey,
      observedAt: new Date(generationCreatedAt + 2_000),
      recoveryAfter: new Date(generationCreatedAt + 1_802_000),
    };
    /** The same durable state covers process death both before invoke and in
     * the unobservable invoke->acknowledgement window: neither permits relaunch. */
    await expect(
      methods.markAgentEventActorDetachedActionLaunchIndeterminate({
        ...update,
        observedAt: reservation.recoveryAfter,
      }),
    ).resolves.toEqual({ status: 'applied' });
    await expect(
      methods.settleAgentEventActorDetachedAction({
        ...update,
        status: 'failed',
        error: 'move service unavailable',
      }),
    ).resolves.toEqual({ status: 'applied' });
    await expect(methods.markAgentEventActorDetachedActionRunning(update)).resolves.toEqual({
      status: 'already_applied',
    });
    await expect(
      methods.settleAgentEventActorDetachedAction({
        ...update,
        observedAt: new Date(generationCreatedAt + 5_000),
        status: 'failed',
        error: 'move service unavailable',
      }),
    ).resolves.toEqual({ status: 'already_applied' });
    await expect(
      methods.settleAgentEventActorDetachedAction({
        ...update,
        status: 'succeeded',
        result: 'conflicting result',
      }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(methods.reserveAgentEventActorDetachedAction(reservation)).resolves.toMatchObject({
      status: 'replay',
      action: { taskId: contenders[0].action.taskId, status: 'failed' },
    });
    const retryReservation = await methods.reserveAgentEventActorDetachedAction({
      ...reservation,
      turnId: 'response-detached-1:1',
      reservedAt: new Date(generationCreatedAt + 3_000),
      recoveryAfter: new Date(generationCreatedAt + 63_000),
    });
    expect(retryReservation).toMatchObject({
      status: 'reserved',
      action: {
        launchAttempt: 1,
        toolCallId: reservation.toolCallId,
        status: 'reserved',
      },
    });
    expect(retryReservation.action.taskId).not.toBe(contenders[0].action.taskId);
    const retryUpdate = {
      ...update,
      taskId: retryReservation.action.taskId,
      idempotencyKey: retryReservation.action.idempotencyKey,
      observedAt: new Date(generationCreatedAt + 4_000),
    };
    await expect(
      methods.markAgentEventActorDetachedActionRunning({
        ...retryUpdate,
        recoveryAfter: new Date(generationCreatedAt + 1_804_000),
      }),
    ).resolves.toEqual({ status: 'applied' });
    await expect(
      methods.markAgentEventActorDetachedActionLaunchIndeterminate({
        ...retryUpdate,
        observedAt: new Date(generationCreatedAt + 1_803_999),
      }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(
      methods.markAgentEventActorDetachedActionLaunchIndeterminate({
        ...retryUpdate,
        observedAt: new Date(generationCreatedAt + 1_804_000),
      }),
    ).resolves.toEqual({ status: 'applied' });
    await expect(
      methods.markAgentEventActorDetachedActionLaunchIndeterminate({
        ...retryUpdate,
        observedAt: new Date(generationCreatedAt + 1_805_000),
      }),
    ).resolves.toEqual({ status: 'already_applied' });
    await expect(
      methods.settleAgentEventActorDetachedAction({
        ...retryUpdate,
        observedAt: new Date(generationCreatedAt + 1_806_000),
        status: 'succeeded',
        result: 'move accepted',
      }),
    ).resolves.toEqual({ status: 'applied' });
    const stored = await Delivery.findOne({ deliveryKey: reservation.deliveryKey })
      .select('+actorDetachedAction +actorDetachedActionHistory')
      .lean();
    expect(stored?.actorDetachedAction).toMatchObject({
      status: 'succeeded',
      result: 'move accepted',
      launchAttempt: 1,
    });
    expect(stored?.actorDetachedActionHistory).toEqual([
      expect.objectContaining({
        taskId: contenders[0].action.taskId,
        status: 'failed',
        error: 'move service unavailable',
      }),
    ]);
    await expect(
      methods.getAgentEventActorDetachedAction({
        deliveryKey: reservation.deliveryKey,
        user: reservation.user,
        bindingId,
        conversationId,
        generationCreatedAt,
      }),
    ).resolves.toMatchObject({
      taskId: retryReservation.action.taskId,
      status: 'succeeded',
      result: 'move accepted',
    });
  });

  it('serializes no-action settlement against renewed action admission', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        awaitTerminalHandling: true,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-1' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    const generationCreatedAt = START.getTime() + 1_000;
    await methods.completeAgentTriggerDelivery({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      result: { status: 'started' },
      settledAt: new Date(generationCreatedAt),
      awaitTerminalHandling: true,
      handling: {
        status: 'started',
        conversationId: 'conversation-1',
        streamId: 'conversation-1',
        generationCreatedAt,
        startedAt: new Date(generationCreatedAt),
      },
    });
    const admission = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      tenantId: 'tenant-1',
      bindingId: 'binding-1',
      conversationId: 'conversation-1',
      admittedAt: new Date(generationCreatedAt + 500),
      admissionId: 'admission-1',
    };
    const noAction = {
      deliveryKey: queued.delivery.deliveryKey,
      conversationId: 'conversation-1',
      generationCreatedAt,
      status: 'completed_no_action' as const,
      settledAt: new Date(generationCreatedAt + 1_000),
    };

    await expect(methods.admitAgentEventActorAction(admission)).resolves.toBe(true);
    await expect(methods.settleAgentTriggerHandlingOutcome(noAction)).resolves.toBe(false);
    await expect(methods.releaseAgentEventActorAction(admission)).resolves.toBe(true);
    await expect(methods.settleAgentTriggerHandlingOutcome(noAction)).resolves.toBe(true);
    await expect(methods.admitAgentEventActorAction(admission)).resolves.toBe(false);
  });

  it('lazily backfills one exact legacy receipt and rejects conflicting identities', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-legacy' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const generationCreatedAt = START.getTime() + 2_000;
    const action = { toolName: 'submit_move', toolCallId: 'call-legacy' };
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'dead',
          handling: {
            status: 'applied',
            conversationId: 'conversation-legacy',
            streamId: 'conversation-legacy',
            generationCreatedAt,
            startedAt: START,
            settledAt: START,
            action,
          },
          settledAt: START,
          expiresAt: new Date(START.getTime() + 1_000),
        },
      },
    );
    const input = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      tenantId: 'tenant-1',
      bindingId: 'binding-legacy',
      conversationId: 'conversation-legacy',
      generationCreatedAt,
      status: 'applied' as const,
      settledAt: new Date(START.getTime() + 3_000),
      receipt: {
        resolution: 'checkpoint_verified' as const,
        checkpoint: {
          threadId: 'conversation-legacy',
          checkpointId: 'checkpoint-legacy',
          checkpointNs: 'event-actor/legacy',
        },
        action,
      },
    };

    await expect(
      Promise.all([
        methods.backfillAgentEventActorReceipt(input),
        methods.backfillAgentEventActorReceipt(input),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(
      methods.backfillAgentEventActorReceipt({
        ...input,
        receipt: {
          ...input.receipt,
          checkpoint: { ...input.receipt.checkpoint, checkpointId: 'different' },
        },
      }),
    ).resolves.toBe(false);
    await expect(
      methods.getAgentEventActorReceipt({
        deliveryKey: input.deliveryKey,
        user: input.user,
        tenantId: input.tenantId,
        bindingId: input.bindingId,
        conversationId: input.conversationId,
      }),
    ).resolves.toEqual({
      bindingId: input.bindingId,
      ...input.receipt,
      settledAt: input.settledAt,
    });
    const stored = await Delivery.findOne({ deliveryKey: input.deliveryKey }).lean();
    expect(stored?.status).toBe('succeeded');
    expect(stored?.expiresAt?.getTime()).toBeGreaterThan(START.getTime() + 1_000);
  });

  it('does not let more than 1,024 unexpired receipts block or evict another actor receipt', async () => {
    const user = new mongoose.Types.ObjectId();
    const settledAt = new Date(START.getTime() + 10_000);
    const expiresAt = new Date(settledAt.getTime() + 90 * 24 * 60 * 60_000);
    await Delivery.insertMany(
      Array.from({ length: 1_025 }, (_, index) => ({
        deliveryKey: `retained-receipt-${index}`,
        fingerprint: `retained-fingerprint-${index}`,
        orderingKey: `retained-lane-${index}`,
        laneSequence: 1,
        envelope: { mode: 'continue', target: { bindingId: `binding-${index}` } },
        user,
        tenantId: 'tenant-1',
        status: 'succeeded',
        attempts: 1,
        availableAt: START,
        handling: {
          status: 'applied',
          conversationId: `conversation-${index}`,
          streamId: `conversation-${index}`,
          generationCreatedAt: START.getTime() + index,
          startedAt: START,
          settledAt,
          action: { toolName: 'submit_move', toolCallId: `call-${index}` },
        },
        actorReceipt: {
          bindingId: `binding-${index}`,
          resolution: 'checkpoint_verified',
          checkpoint: {
            threadId: `conversation-${index}`,
            checkpointId: `checkpoint-${index}`,
            checkpointNs: `event-actor/${index}`,
          },
          action: { toolName: 'submit_move', toolCallId: `call-${index}` },
          settledAt,
        },
        settledAt,
        expiresAt,
      })),
    );

    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey: 'fresh-receipt-lane',
        awaitTerminalHandling: true,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-fresh' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const generationCreatedAt = settledAt.getTime() + 1_000;
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'succeeded',
          handling: {
            status: 'started',
            conversationId: 'conversation-fresh',
            streamId: 'conversation-fresh',
            generationCreatedAt,
            startedAt: settledAt,
          },
        },
      },
    );

    await expect(
      methods.settleAgentEventActorReceipt({
        deliveryKey: queued.delivery.deliveryKey,
        user,
        tenantId: 'tenant-1',
        bindingId: 'binding-fresh',
        conversationId: 'conversation-fresh',
        generationCreatedAt,
        status: 'applied',
        settledAt: new Date(generationCreatedAt + 1_000),
        receipt: {
          resolution: 'checkpoint_verified',
          checkpoint: {
            threadId: 'conversation-fresh',
            checkpointId: 'checkpoint-fresh',
            checkpointNs: 'event-actor/fresh',
          },
          action: { toolName: 'submit_move', toolCallId: 'call-fresh' },
        },
      }),
    ).resolves.toBe(true);

    expect(await Delivery.countDocuments({ actorReceipt: { $exists: true } })).toBe(1_026);
    await expect(
      methods.getAgentEventActorReceipt({
        deliveryKey: 'retained-receipt-0',
        user,
        tenantId: 'tenant-1',
        bindingId: 'binding-0',
        conversationId: 'conversation-0',
      }),
    ).resolves.toMatchObject({
      resolution: 'checkpoint_verified',
      action: { toolCallId: 'call-0' },
    });
    await expect(
      methods.settleAgentEventActorReceipt({
        deliveryKey: 'retained-receipt-0',
        user,
        tenantId: 'tenant-1',
        bindingId: 'binding-0',
        conversationId: 'conversation-0',
        generationCreatedAt: START.getTime(),
        status: 'applied',
        settledAt,
        receipt: {
          resolution: 'checkpoint_verified',
          checkpoint: {
            threadId: 'conversation-0',
            checkpointId: 'stale-owner-checkpoint',
            checkpointNs: 'event-actor/0',
          },
          action: { toolName: 'submit_move', toolCallId: 'call-0' },
        },
      }),
    ).resolves.toBe(false);
    await Delivery.insertMany([
      {
        deliveryKey: 'actor-retry-without-mailbox-flag',
        fingerprint: 'actor-retry-without-mailbox-flag',
        orderingKey: 'actor-retry-lane',
        laneSequence: 1,
        envelope: { mode: 'continue', target: { bindingId: 'binding-retry' } },
        user,
        tenantId: 'tenant-1',
        status: 'pending',
        attempts: 2,
        availableAt: START,
        handling: {
          status: 'started',
          conversationId: 'conversation-retry',
          streamId: 'conversation-retry',
          generationCreatedAt: START.getTime(),
          startedAt: START,
        },
      },
      {
        deliveryKey: 'actor-dead-without-mailbox-flag',
        fingerprint: 'actor-dead-without-mailbox-flag',
        orderingKey: 'actor-dead-lane',
        laneSequence: 1,
        envelope: { mode: 'continue', target: { bindingId: 'binding-dead' } },
        user,
        tenantId: 'tenant-1',
        status: 'dead',
        attempts: 3,
        availableAt: START,
        handling: {
          status: 'started',
          conversationId: 'conversation-dead',
          streamId: 'conversation-dead',
          generationCreatedAt: START.getTime(),
          startedAt: START,
        },
      },
    ]);
    await expect(
      methods.getAgentEventActorReceiptStorageMetrics(new Date(START.getTime() + 20_000)),
    ).resolves.toMatchObject({
      retainedByResolution: {
        checkpoint_verified: 1_026,
        action_compensated: 0,
        history_repaired: 0,
      },
      expiryEligible: 0,
      retryDeliveries: 1,
      deadDeliveries: 1,
    });
  });

  it('never migrates a compensated legacy receipt as an applied outcome', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-compensated' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const generationCreatedAt = START.getTime() + 6_000;
    const checkpoint = {
      threadId: 'conversation-compensated',
      checkpointId: 'checkpoint-compensated',
      checkpointNs: 'event-actor/compensated',
    };
    const action = { toolName: 'submit_move', toolCallId: 'call-compensated' };
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'succeeded',
          handling: {
            status: 'failed',
            conversationId: 'conversation-compensated',
            streamId: 'conversation-compensated',
            generationCreatedAt,
            startedAt: START,
            settledAt: START,
            error: 'Applied action was compensated',
          },
          settledAt: START,
          expiresAt: new Date(START.getTime() + 90 * 24 * 60 * 60_000),
        },
      },
    );
    const common = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      tenantId: 'tenant-1',
      bindingId: 'binding-compensated',
      conversationId: 'conversation-compensated',
      generationCreatedAt,
      settledAt: new Date(START.getTime() + 7_000),
      receipt: { checkpoint, action },
    };

    await expect(
      methods.backfillAgentEventActorReceipt({
        ...common,
        status: 'failed',
        receipt: { ...common.receipt, resolution: 'action_compensated' },
      }),
    ).resolves.toBe(true);
    await expect(
      methods.backfillAgentEventActorReceipt({
        ...common,
        status: 'applied',
        receipt: { ...common.receipt, resolution: 'checkpoint_verified' },
      }),
    ).resolves.toBe(false);
    await expect(
      methods.getAgentEventActorReceipt({
        deliveryKey: common.deliveryKey,
        user: common.user,
        tenantId: common.tenantId,
        bindingId: common.bindingId,
        conversationId: common.conversationId,
      }),
    ).resolves.toMatchObject({ resolution: 'action_compensated' });
  });

  it('allows exactly one winner when verification races compensation', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        awaitTerminalHandling: true,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-race' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const generationCreatedAt = START.getTime() + 4_000;
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'succeeded',
          awaitTerminalHandling: true,
          handling: {
            status: 'started',
            conversationId: 'conversation-race',
            streamId: 'conversation-race',
            generationCreatedAt,
            startedAt: START,
          },
        },
      },
    );
    const checkpoint = {
      threadId: 'conversation-race',
      checkpointId: 'checkpoint-race',
      checkpointNs: 'event-actor/race',
    };
    const common = {
      deliveryKey: queued.delivery.deliveryKey,
      user: queued.delivery.user,
      tenantId: 'tenant-1',
      bindingId: 'binding-race',
      conversationId: 'conversation-race',
      generationCreatedAt,
      settledAt: new Date(START.getTime() + 5_000),
    };
    const [verified, compensated] = await Promise.all([
      methods.settleAgentEventActorReceipt({
        ...common,
        status: 'applied',
        receipt: {
          resolution: 'checkpoint_verified',
          checkpoint,
          action: { toolName: 'submit_move' },
        },
      }),
      methods.settleAgentEventActorReceipt({
        ...common,
        status: 'failed',
        error: 'operator compensated action',
        receipt: {
          resolution: 'action_compensated',
          checkpoint,
          action: { toolName: 'submit_move' },
        },
      }),
    ]);

    expect(Number(verified) + Number(compensated)).toBe(1);
    const stored = await methods.getAgentTriggerDelivery(queued.delivery.deliveryKey);
    expect(stored?.handling?.status).toBe(verified ? 'applied' : 'failed');
    expect(stored?.actorReceipt?.resolution).toBe(
      verified ? 'checkpoint_verified' : 'action_compensated',
    );
  });

  it('reclaims an inactive high-cardinality lane after its tail succeeds', async () => {
    const orderingKey = 'one-shot-resource-lane';
    await methods.enqueueAgentTriggerDelivery(enqueueInput({ orderingKey }));
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });

    await expect(
      methods.completeAgentTriggerDelivery({
        id: claimed!.id,
        workerId: 'worker-1',
        claimToken: 'claim-1',
        attempt: attempt!,
        result: { ok: true },
        settledAt: START,
      }),
    ).resolves.toBe(true);

    expect(await LaneSequence.countDocuments({ _id: orderingKey })).toBe(0);
  });

  it('rediscovers lane cleanup when success commits before its cleanup marker', async () => {
    const orderingKey = 'crashed-lane-cleanup';
    const queued = await methods.enqueueAgentTriggerDelivery(enqueueInput({ orderingKey }));
    const claimed = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claimed!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    const laneUpdate = jest
      .spyOn(LaneSequence, 'updateOne')
      .mockRejectedValueOnce(new Error('down'));

    try {
      await expect(
        methods.completeAgentTriggerDelivery({
          id: claimed!.id,
          workerId: 'worker-1',
          claimToken: 'claim-1',
          attempt: attempt!,
          result: { ok: true },
          settledAt: START,
        }),
      ).resolves.toBe(true);
    } finally {
      laneUpdate.mockRestore();
    }
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'succeeded',
      laneCleanupPendingAt: START,
    });

    await expect(methods.reclaimInactiveAgentTriggerLanes(1)).resolves.toBe(1);
    await expect(LaneSequence.findById(orderingKey)).resolves.toBeNull();
    expect(
      (await Delivery.findById(queued.delivery.id).lean())?.laneCleanupPendingAt,
    ).toBeUndefined();
  });

  it('restores the retry budget when dispatch is deferred before execution', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(enqueueInput());
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });

    await expect(
      methods.deferAgentTriggerDeliveryAttempt({
        id: claim!.id,
        workerId: 'worker-1',
        claimToken: 'claim-1',
        attempt: attempt!,
        availableAt: new Date(START.getTime() + 5_000),
      }),
    ).resolves.toBe(true);

    await expect(
      methods.getAgentTriggerDelivery(queued.delivery.deliveryKey),
    ).resolves.toMatchObject({
      status: 'pending',
      attempts: 0,
      availableAt: new Date(START.getTime() + 5_000),
    });
  });

  it('retains dead letters, truncates failure text, and supports explicit requeue', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'dead-letter-requeue';
    const queued = await methods.enqueueAgentTriggerDelivery(enqueueInput({ user, orderingKey }));
    const claim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    const attempt = await methods.beginAgentTriggerDeliveryAttempt({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
    });
    await methods.deadLetterAgentTriggerDelivery({
      id: claim!.id,
      workerId: 'worker-1',
      claimToken: 'claim-1',
      attempt: attempt!,
      error: transientFailure({
        code: 'X'.repeat(256),
        message: 'x'.repeat(3_000),
        retryable: false,
      }),
      settledAt: START,
    });

    const [dead] = await methods.getAgentTriggerDeadLetters();
    expect(dead).toMatchObject({ id: queued.delivery.id, status: 'dead' });
    expect(dead.lastError?.code).toHaveLength(128);
    expect(dead.lastError?.message).toHaveLength(2048);
    expect(dead.expiresAt).toBeUndefined();

    const later = await methods.enqueueAgentTriggerDelivery(enqueueInput({ user, orderingKey }));
    const laterClaim = await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-2',
      claimToken: 'claim-2',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    expect(laterClaim?.id).toBe(later.delivery.id);

    const stagedAhead = await Delivery.create({
      ...enqueueInput({ user, orderingKey }),
      laneSequence: 0,
      status: 'staging',
      attempts: 0,
      requeueCount: 0,
    });
    await Delivery.collection.updateOne(
      { _id: stagedAhead._id },
      { $set: { updatedAt: new Date(0) } },
    );

    const requeued = await methods.requeueAgentTriggerDelivery(dead.id, START);
    expect(requeued).toMatchObject({
      status: 'pending',
      attempts: 0,
      requeueCount: 1,
      laneSequence: 4,
    });
    await expect(Delivery.findById(stagedAhead._id).lean()).resolves.toMatchObject({
      status: 'pending',
      laneSequence: 3,
    });
    expect(requeued?.lastError).toBeUndefined();
    await expect(methods.findEarlierAgentTriggerDelivery(requeued!)).resolves.toEqual({
      availableAt: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });
    expect(await methods.getAgentTriggerDeadLetters()).toEqual([]);
    await expect(methods.getAgentTriggerDeadLetters(Number.NaN)).rejects.toThrow(
      'Agent trigger dead-letter limit must be a positive integer',
    );
  });

  it('retires a dead letter when its admitted actor action later settles', async () => {
    const user = new mongoose.Types.ObjectId();
    const orderingKey = 'late-terminal-batch';
    const queued = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        orderingKey,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-late-terminal' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
    );
    const generationCreatedAt = START.getTime() + 1_000;
    const member = await Delivery.create({
      ...enqueueInput({
        user,
        orderingKey,
        envelope: {
          mode: 'continue',
          target: { bindingId: 'binding-late-terminal' },
          event: { source: { id: 'source-key-1', type: 'remote_api_key' } },
        },
      }),
      laneSequence: 2,
      status: 'dead',
      attempts: 3,
      requeueCount: 0,
      batchRootId: queued.delivery.id,
      settledAt: START,
      lastError: transientFailure(),
      handling: {
        status: 'started',
        conversationId: 'conversation-late-terminal',
        streamId: 'conversation-late-terminal',
        generationCreatedAt,
        startedAt: START,
      },
    });
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'dead',
          attempts: 3,
          batchMemberIds: [member._id],
          batchMembersSettledAt: START,
          actorActionAdmittedAt: START,
          handling: {
            status: 'started',
            conversationId: 'conversation-late-terminal',
            streamId: 'conversation-late-terminal',
            generationCreatedAt,
            startedAt: START,
          },
        },
      },
    );

    await expect(
      methods.settleAgentEventActorReceipt({
        deliveryKey: queued.delivery.deliveryKey,
        user,
        tenantId: 'tenant-1',
        bindingId: 'binding-late-terminal',
        conversationId: 'conversation-late-terminal',
        generationCreatedAt,
        status: 'applied',
        settledAt: new Date(generationCreatedAt + 1_000),
        requiresActionAdmission: true,
        receipt: {
          resolution: 'checkpoint_verified',
          checkpoint: {
            threadId: 'conversation-late-terminal',
            checkpointId: 'checkpoint-late-terminal',
            checkpointNs: 'event-actor/late-terminal',
          },
          action: { toolName: 'submit_move' },
        },
      }),
    ).resolves.toBe(true);
    await expect(
      methods.getAgentTriggerDelivery(queued.delivery.deliveryKey),
    ).resolves.toMatchObject({ status: 'succeeded', handling: { status: 'applied' } });
    expect(
      (await methods.getAgentTriggerDelivery(queued.delivery.deliveryKey))?.lastError,
    ).toBeUndefined();
    await expect(Delivery.findById(member._id).lean()).resolves.toMatchObject({
      status: 'succeeded',
      handling: { status: 'applied' },
    });
    await expect(
      methods.getAgentTriggerDeliveryStatus(member.deliveryKey, user, 'source-key-1', 'tenant-1'),
    ).resolves.toMatchObject({ status: 'succeeded', handling: { status: 'applied' } });
    await expect(LaneSequence.findById(orderingKey).lean()).resolves.toBeNull();
    await expect(
      methods.requeueAgentTriggerDelivery(queued.delivery.id, START),
    ).resolves.toBeNull();
  });

  it('does not requeue a legacy terminal outcome before its receipt is migrated', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(enqueueInput());
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'dead',
          handling: {
            status: 'applied',
            conversationId: 'legacy-terminal-conversation',
            streamId: 'legacy-terminal-conversation',
            generationCreatedAt: START.getTime(),
            startedAt: START,
            settledAt: START,
            action: { toolName: 'submit_move' },
          },
        },
      },
    );

    await expect(
      methods.requeueAgentTriggerDelivery(queued.delivery.id, START),
    ).resolves.toBeNull();
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'dead',
      handling: { status: 'applied' },
    });
  });

  it('does not requeue ambiguous legacy started handling', async () => {
    const queued = await methods.enqueueAgentTriggerDelivery(enqueueInput());
    await Delivery.updateOne(
      { deliveryKey: queued.delivery.deliveryKey },
      {
        $set: {
          status: 'dead',
          handling: {
            status: 'started',
            conversationId: 'legacy-started-conversation',
            streamId: 'legacy-started-conversation',
            generationCreatedAt: START.getTime(),
            startedAt: START,
          },
        },
      },
    );

    await expect(
      methods.requeueAgentTriggerDelivery(queued.delivery.id, START),
    ).resolves.toBeNull();
    await expect(Delivery.findById(queued.delivery.id).lean()).resolves.toMatchObject({
      status: 'dead',
      handling: { status: 'started' },
    });
  });

  it('counts live leases and detached launch authority while an account deletion drains', async () => {
    const user = new mongoose.Types.ObjectId();
    const leased = await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    const detached = await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    const admitted = await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await methods.claimNextAgentTriggerDelivery({
      workerId: 'worker-1',
      claimToken: 'claim-1',
      now: START,
      leaseUntil: new Date(START.getTime() + 60_000),
    });

    await Delivery.updateOne(
      { _id: detached.delivery.id },
      {
        $set: {
          status: 'succeeded',
          actorDetachedAction: {
            version: 1,
            invocationId: detached.delivery.deliveryKey,
            expectedToolName: 'submit_move',
            toolName: 'submit_move_mcp_chess',
            toolCallId: 'call-delete-drain',
            turnId: 'response-delete-drain:0',
            taskId: `event_actor_${'d'.repeat(64)}`,
            idempotencyKey: 'd'.repeat(64),
            launchAttempt: 0,
            status: 'running',
            reservedAt: START,
            observedAt: START,
            recoveryAfter: new Date(START.getTime() + 60_000),
            launchedAt: START,
          },
        },
      },
    );
    await Delivery.updateOne(
      { _id: admitted.delivery.id },
      {
        $set: {
          status: 'succeeded',
          actorActionAdmittedAt: START,
          actorActionAdmissionId: 'admission-delete-drain',
        },
      },
    );

    expect(leased.delivery.id).not.toBe(detached.delivery.id);
    expect(await methods.countActiveAgentTriggerDeliveriesByUser(user, START)).toBe(3);
    expect(
      await methods.countActiveAgentTriggerDeliveriesByUser(
        user,
        new Date(START.getTime() + 60_001),
      ),
    ).toBe(2);
    await Delivery.updateOne(
      { _id: detached.delivery.id },
      { $set: { 'actorDetachedAction.status': 'launch_indeterminate' } },
    );
    expect(
      await methods.countActiveAgentTriggerDeliveriesByUser(
        user,
        new Date(START.getTime() + 60_001),
      ),
    ).toBe(2);
    await Delivery.updateOne(
      { _id: detached.delivery.id },
      { $set: { 'actorDetachedAction.status': 'succeeded' } },
    );
    expect(
      await methods.countActiveAgentTriggerDeliveriesByUser(
        user,
        new Date(START.getTime() + 60_001),
      ),
    ).toBe(1);
    await Delivery.updateOne(
      { _id: admitted.delivery.id },
      { $unset: { actorActionAdmittedAt: 1, actorActionAdmissionId: 1 } },
    );
    expect(
      await methods.countActiveAgentTriggerDeliveriesByUser(
        user,
        new Date(START.getTime() + 60_001),
      ),
    ).toBe(0);
  });

  it('serializes account deletion against action admission on each delivery row', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    await User.create({
      _id: user,
      email: 'admission-fence@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    const first = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        envelope: { mode: 'continue', target: { bindingId: 'binding-purge' } },
      }),
    );
    const second = await methods.enqueueAgentTriggerDelivery(
      enqueueInput({
        user,
        envelope: { mode: 'continue', target: { bindingId: 'binding-purge' } },
      }),
    );
    await Delivery.updateMany({ user }, { $set: { status: 'succeeded' } });
    const admission = {
      deliveryKey: first.delivery.deliveryKey,
      user,
      tenantId: 'tenant-1',
      bindingId: 'binding-purge',
      conversationId: 'conversation-purge',
      admittedAt: START,
      admissionId: 'admission-before-purge',
    };

    await expect(methods.admitAgentEventActorAction(admission)).resolves.toBe(true);
    await methods.prepareAgentTriggerUserPurge(user, fenceStartedAt);
    await expect(
      methods.countActiveAgentTriggerDeliveriesByUser(user, new Date(START.getTime() + 60_001)),
    ).resolves.toBe(1);
    await expect(
      methods.admitAgentEventActorAction({
        ...admission,
        deliveryKey: second.delivery.deliveryKey,
        admissionId: 'admission-after-purge',
      }),
    ).resolves.toBe(false);
    await expect(
      Delivery.countDocuments({ user, actorActionAdmissionClosedAt: fenceStartedAt }),
    ).resolves.toBe(2);

    await expect(methods.cancelAgentTriggerUserPurge(user, fenceStartedAt)).resolves.toBe(true);
    await expect(
      Delivery.countDocuments({ user, actorActionAdmissionClosedAt: { $exists: true } }),
    ).resolves.toBe(0);
    await expect(
      methods.admitAgentEventActorAction({
        ...admission,
        deliveryKey: second.delivery.deliveryKey,
        admissionId: 'admission-after-cancel',
      }),
    ).resolves.toBe(true);
  });

  it('deletes all queued payloads for an erased user', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    await User.create({
      _id: user,
      email: 'immediate-purge@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await methods.enqueueAgentTriggerDelivery(enqueueInput({ orderingKey: 'ordering-other' }));
    await methods.prepareAgentTriggerUserPurge(user, fenceStartedAt);
    await User.deleteOne({ _id: user });

    await methods.deleteAgentTriggerDeliveriesByUser(user);

    expect(await Delivery.countDocuments({ user })).toBe(0);
    expect(await Delivery.countDocuments()).toBe(1);
    expect(await LaneSequence.countDocuments({ user })).toBe(0);
    expect(await LaneSequence.countDocuments()).toBe(1);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(0);
  });

  it('retains trigger purge state when queued-turn cleanup fails', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    let unavailable = true;
    const purgeQueuedTurnsForUser = jest.fn(async () => {
      if (unavailable) {
        throw new Error('queued-turn store unavailable');
      }
    });
    const purgeMethods = createAgentTriggerDeliveryMethods(mongoose, {
      purgeQueuedTurnsForUser,
    });
    await User.create({
      _id: user,
      email: 'purge-callback@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await purgeMethods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await purgeMethods.prepareAgentTriggerUserPurge(user, fenceStartedAt);
    await User.deleteOne({ _id: user });

    await expect(purgeMethods.deleteAgentTriggerDeliveriesByUser(user)).rejects.toThrow(
      'queued-turn store unavailable',
    );
    expect(await Delivery.countDocuments({ user })).toBe(1);
    expect(await LaneSequence.countDocuments({ user })).toBe(1);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(1);

    unavailable = false;
    await expect(purgeMethods.deleteAgentTriggerDeliveriesByUser(user)).resolves.toBeUndefined();
    expect(await Delivery.countDocuments({ user })).toBe(0);
    expect(await LaneSequence.countDocuments({ user })).toBe(0);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(0);
    expect(purgeQueuedTurnsForUser).toHaveBeenCalledTimes(2);
  });

  it('recovers an armed purge after the user deletion commits', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    await User.create({
      _id: user,
      email: 'purge@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await methods.prepareAgentTriggerUserPurge(user, fenceStartedAt, 'tenant-1');

    await expect(methods.recoverAgentTriggerUserPurges()).resolves.toBe(0);
    expect(await Delivery.countDocuments({ user })).toBe(1);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(1);

    await User.deleteOne({ _id: user });
    await expect(methods.recoverAgentTriggerUserPurges()).resolves.toBe(1);
    expect(await Delivery.countDocuments({ user })).toBe(0);
    expect(await LaneSequence.countDocuments({ user })).toBe(0);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(0);
  });

  it('retains a recovery marker when queued-turn purge cannot be confirmed', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    let unavailable = true;
    const purgeQueuedTurnsForUser = jest.fn(async () => {
      if (unavailable) {
        throw new Error('queued-turn store unavailable');
      }
    });
    const purgeMethods = createAgentTriggerDeliveryMethods(mongoose, {
      purgeQueuedTurnsForUser,
    });
    await User.create({
      _id: user,
      email: 'purge-recovery-callback@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await purgeMethods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await purgeMethods.prepareAgentTriggerUserPurge(user, fenceStartedAt);
    await User.deleteOne({ _id: user });

    await expect(purgeMethods.recoverAgentTriggerUserPurges()).rejects.toThrow(
      'queued-turn store unavailable',
    );
    expect(await Delivery.countDocuments({ user })).toBe(1);
    expect(await LaneSequence.countDocuments({ user })).toBe(1);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(1);

    unavailable = false;
    await expect(purgeMethods.recoverAgentTriggerUserPurges()).resolves.toBe(1);
    expect(await Delivery.countDocuments({ user })).toBe(0);
    expect(await LaneSequence.countDocuments({ user })).toBe(0);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(0);
  });

  it('rotates active purge markers so a later committed purge is recovered', async () => {
    const users = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
    for (const [index, user] of users.entries()) {
      await User.create({
        _id: user,
        email: `purge-rotation-${index}@example.com`,
        provider: 'local',
        agentTriggerDeletionStartedAt: START,
      });
      await methods.prepareAgentTriggerUserPurge(user, START);
    }
    await Delivery.create({
      ...enqueueInput({ user: users[2], orderingKey: 'committed-purge-lane' }),
      laneSequence: 1,
      status: 'pending',
      attempts: 0,
      requeueCount: 0,
    });
    await User.deleteOne({ _id: users[2] });

    await expect(methods.recoverAgentTriggerUserPurges(2)).resolves.toBe(0);
    await expect(methods.recoverAgentTriggerUserPurges(2)).resolves.toBe(1);
    expect(await UserPurge.countDocuments({ _id: users[2] })).toBe(0);
    expect(await Delivery.countDocuments({ user: users[2] })).toBe(0);
    expect(await UserPurge.countDocuments({ _id: { $in: users.slice(0, 2) } })).toBe(2);
  });

  it('disarms a stale purge marker without touching an active user delivery', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    await User.create({
      _id: user,
      email: 'rollback@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await methods.enqueueAgentTriggerDelivery(enqueueInput({ user }));
    await methods.prepareAgentTriggerUserPurge(user, fenceStartedAt);
    await User.updateOne({ _id: user }, { $unset: { agentTriggerDeletionStartedAt: 1 } });

    await expect(methods.recoverAgentTriggerUserPurges()).resolves.toBe(0);
    expect(await Delivery.countDocuments({ user })).toBe(1);
    expect(
      await Delivery.countDocuments({ user, actorActionAdmissionClosedAt: { $exists: true } }),
    ).toBe(0);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(0);
  });

  it('lets only the exact deletion owner cancel a prepared purge', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    await User.create({
      _id: user,
      email: 'owner@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await methods.prepareAgentTriggerUserPurge(user, fenceStartedAt);

    await expect(
      methods.cancelAgentTriggerUserPurge(user, new Date(START.getTime() + 1)),
    ).resolves.toBe(false);
    await expect(methods.cancelAgentTriggerUserPurge(user, fenceStartedAt)).resolves.toBe(true);
  });

  it('cannot disarm purge recovery after the user commit', async () => {
    const user = new mongoose.Types.ObjectId();
    const fenceStartedAt = new Date(START);
    await User.create({
      _id: user,
      email: 'committed@example.com',
      provider: 'local',
      agentTriggerDeletionStartedAt: fenceStartedAt,
    });
    await methods.prepareAgentTriggerUserPurge(user, fenceStartedAt);
    await User.deleteOne({ _id: user });

    await expect(methods.cancelAgentTriggerUserPurge(user, fenceStartedAt)).resolves.toBe(false);
    expect(await UserPurge.countDocuments({ _id: user })).toBe(1);
  });
});
