import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type {
  IAgentTriggerLaneSequenceDocument,
  IAgentTriggerDeliveryDocument,
} from '~/types/triggerDelivery';
import type { AgentTriggerDeliveryMethods } from './triggerDelivery';
import { createAgentTriggerLaneSequenceModel } from '../models/triggerLaneSequence';
import { createAgentTriggerUserPurgeModel } from '../models/triggerUserPurge';
import { createAgentTriggerDeliveryModel } from '../models/triggerDelivery';
import { createAgentTriggerDeliveryMethods } from './triggerDelivery';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('~/models/plugins/mongoMeili', () => jest.fn());

const DB_SETUP_TIMEOUT_MS = 60_000;
const START = new Date('2026-11-23T12:00:00.000Z');
const MARKER = 'MARKER-7f3a';
let mongoServer: MongoMemoryServer;
let Delivery: Model<IAgentTriggerDeliveryDocument>;
let LaneSequence: Model<IAgentTriggerLaneSequenceDocument>;
let methods: AgentTriggerDeliveryMethods;
let counter = 0;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  Delivery = createAgentTriggerDeliveryModel(mongoose);
  LaneSequence = createAgentTriggerLaneSequenceModel(mongoose);
  createAgentTriggerUserPurgeModel(mongoose);
  await Promise.all([Delivery.createIndexes(), LaneSequence.createIndexes()]);
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  methods = createAgentTriggerDeliveryMethods(mongoose);
  await Promise.all([Delivery.deleteMany({}), LaneSequence.deleteMany({})]);
});

type Enqueue = Parameters<AgentTriggerDeliveryMethods['enqueueAgentTriggerDelivery']>[0];

function input(overrides: Partial<Enqueue> = {}): Enqueue {
  counter += 1;
  return {
    deliveryKey: `trigger_dead_${counter}`,
    fingerprint: `fingerprint_${counter}`,
    orderingKey: `lane-${counter}`,
    envelope: {
      version: 1,
      mode: 'fire',
      input: `prompt ${MARKER}`,
      target: { agentId: 'agent_1' },
      event: {
        id: `event-${counter}`,
        type: 'schedule.occurrence',
        occurredAt: START.getTime(),
        payload: { secret: MARKER },
        source: { id: `schedule-${counter}`, type: 'schedule' },
      },
    },
    user: new mongoose.Types.ObjectId(),
    tenantId: 'tenant-1',
    availableAt: START,
    ...overrides,
  };
}

/** Enqueues one delivery and dead-letters it through the worker's own writes. */
async function kill(overrides: Partial<Enqueue> = {}, expiresAt?: Date): Promise<string> {
  const queued = await methods.enqueueAgentTriggerDelivery(input(overrides));
  const fence = { workerId: `worker-${counter}`, claimToken: `claim-${counter}` };
  const now = queued.delivery.availableAt;
  const claim = await methods.claimNextAgentTriggerDelivery({
    ...fence,
    now,
    leaseUntil: new Date(now.getTime() + 60_000),
  });
  if (claim == null) {
    throw new Error('expected a claimable delivery');
  }
  const attempt = await methods.beginAgentTriggerDeliveryAttempt({ id: claim.id, ...fence, now });
  const dead = await methods.deadLetterAgentTriggerDelivery({
    id: claim.id,
    ...fence,
    attempt: attempt ?? 1,
    error: {
      code: 'FIRE_REJECTED',
      message: `upstream said ${MARKER}`,
      certainty: 'definite',
      retryable: false,
      attemptedAt: now,
    },
    settledAt: now,
    ...(expiresAt != null && { expiresAt }),
  });
  if (!dead) {
    throw new Error('expected the delivery to dead-letter');
  }
  return claim.id;
}

/** Two coalesced deliveries dead-lettered as one batch; returns the root's id. */
async function killBatch(): Promise<string> {
  const until = new Date(Date.now() + 60_000);
  const shared = {
    user: new mongoose.Types.ObjectId(),
    orderingKey: `batch-lane-${counter}`,
    coalesceKey: `trigger_batch_${counter}`,
    coalesceFrom: new Date(until.getTime() - 750),
    coalesceUntil: until,
    availableAt: until,
    envelopeBytes: 128,
  };
  await methods.enqueueAgentTriggerDelivery(input(shared));
  return kill(shared);
}

/**
 * The commands one call sends to the delivery collection, and the projection its first one
 * asked for. Lane commands are left out; the lane tests below read the lane row itself.
 */
async function commands(
  run: () => Promise<unknown>,
): Promise<{ methods: string[]; projection: unknown }> {
  const sent: Array<[string, unknown]> = [];
  mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
    if (collection !== Delivery.collection.name) {
      return;
    }
    const options = args[args.length - 1] as { projection?: unknown } | undefined;
    sent.push([method, options?.projection]);
  });
  try {
    await run();
  } finally {
    mongoose.set('debug', false);
  }
  return { methods: sent.map(([method]) => method), projection: sent[0]?.[1] };
}

describe('dead letters by tenant partition', () => {
  it('lists only the dead roots of the named partition, newest first', async () => {
    const first = await kill();
    const second = await kill();
    const other = await kill({ tenantId: 'tenant-2' });
    const tenantless = await kill({ tenantId: undefined });
    await methods.enqueueAgentTriggerDelivery(input());
    await Delivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(first) },
      { $set: { updatedAt: new Date(START.getTime() - 1_000) } },
    );

    const page = await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.letters.map(({ id }) => id)).toEqual([second, first]);

    const others = await methods.listAgentTriggerDeadLetterPage('tenant-2', {
      limit: 50,
      offset: 0,
    });
    expect(others.letters.map(({ id }) => id)).toEqual([other]);

    const platform = await methods.listAgentTriggerDeadLetterPage(undefined, {
      limit: 50,
      offset: 0,
    });
    expect(platform.letters.map(({ id }) => id)).toEqual([tenantless]);
    await expect(
      methods.listAgentTriggerDeadLetterPage('', { limit: 50, offset: 0 }),
    ).resolves.toMatchObject({ total: 1 });
  });

  it('pages with a limit and an offset and counts the whole partition', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = await kill();
      await Delivery.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { updatedAt: new Date(START.getTime() + index * 1_000) } },
      );
      ids.push(id);
    }

    const head = await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 2, offset: 0 });
    expect(head.total).toBe(3);
    expect(head.letters.map(({ id }) => id)).toEqual([ids[2], ids[1]]);
    const tail = await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 2, offset: 2 });
    expect(tail.total).toBe(3);
    expect(tail.letters.map(({ id }) => id)).toEqual([ids[0]]);

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        methods.listAgentTriggerDeadLetterPage('tenant-1', { limit, offset: 0 }),
      ).rejects.toThrow('Agent trigger dead-letter limit must be a positive integer');
    }
    for (const offset of [-1, 0.5, Number.NaN]) {
      await expect(
        methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 1, offset }),
      ).rejects.toThrow('Agent trigger dead-letter offset must be a non-negative integer');
    }
  });

  it('returns at most 200 dead letters however many are asked for', async () => {
    const template = await Delivery.collection.findOne({
      _id: new mongoose.Types.ObjectId(await kill()),
    });
    await Delivery.collection.insertMany(
      Array.from({ length: 201 }, (_, index) => ({
        ...template,
        _id: new mongoose.Types.ObjectId(),
        deliveryKey: `trigger_bulk_${index}`,
      })),
    );

    const page = await methods.listAgentTriggerDeadLetterPage('tenant-1', {
      limit: 5_000,
      offset: 0,
    });

    expect(page.total).toBe(202);
    expect(page.letters).toHaveLength(200);
  });

  it('treats a blank, null or empty tenant as the tenantless partition', async () => {
    const missing = await kill({ tenantId: undefined });
    const nulled = await kill({ tenantId: undefined });
    const emptied = await kill({ tenantId: undefined });
    await kill();
    await Delivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(nulled) },
      { $set: { tenantId: null } },
    );
    await Delivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(emptied) },
      { $set: { tenantId: '' } },
    );

    for (const tenantId of [undefined, '', '   ']) {
      const page = await methods.listAgentTriggerDeadLetterPage(tenantId, { limit: 50, offset: 0 });
      expect(page.letters.map(({ id }) => id).sort()).toEqual([missing, nulled, emptied].sort());
    }
  });

  it('lists a delivery that died inside its capability shield and can requeue it', async () => {
    const set = (id: string, fields: Record<string, unknown>) =>
      Delivery.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
    const shield = { requiredWorkerCapability: 'capability-v1', capabilityStatus: 'dead' };
    const dead = await kill();
    const leased = await kill();
    const pending = await kill();
    await set(dead, { status: 'capability_dead', requiredWorkerCapability: 'capability-v1' });
    await set(leased, { status: 'leased', ...shield });
    await set(pending, { status: 'pending', ...shield });

    const page = await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 50, offset: 0 });

    expect(
      Object.fromEntries(page.letters.map(({ id, requeueable }) => [id, requeueable])),
    ).toEqual({ [dead]: true, [leased]: true, [pending]: true });
    for (const id of [leased, pending]) {
      await expect(
        methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
      ).resolves.toMatchObject({ id, requeueCount: 1 });
    }
  });

  it('leaves alone a delivery that is waiting to run though its private lifecycle reads dead', async () => {
    const set = (id: string, fields: Record<string, unknown>) =>
      Delivery.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
    const shield = { requiredWorkerCapability: 'capability-v1', capabilityStatus: 'dead' };
    /** What a pre-shield replica leaves behind when it requeues a dead capability delivery. */
    const republished = await kill();
    const publishing = await kill();
    const running = await kill();
    const bare = await kill();
    const done = await kill();
    await set(republished, { status: 'capability_pending', ...shield });
    await set(publishing, { status: 'capability_staging', ...shield });
    await set(running, { status: 'capability_leased', ...shield });
    await set(bare, { status: 'leased', capabilityStatus: 'dead' });
    await set(done, { status: 'succeeded', ...shield });

    await expect(
      methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 50, offset: 0 }),
    ).resolves.toEqual({ letters: [], total: 0 });
    for (const id of [republished, publishing, running, bare, done]) {
      await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toBeNull();
      await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(false);
      await expect(
        methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
      ).resolves.toBeNull();
    }
    await expect(Delivery.countDocuments({})).resolves.toBe(5);
  });

  it('orders by last change and then id, whatever order the index holds the rows in', async () => {
    const stamp = (id: string, fields: Record<string, unknown>) =>
      Delivery.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
    const oldest = await kill();
    const earlier = await kill();
    const later = await kill();
    /** `capability_dead` sorts ahead of `dead` in the status index, though this row is the oldest. */
    await stamp(oldest, {
      status: 'capability_dead',
      updatedAt: new Date(START.getTime() - 60_000),
    });
    await stamp(earlier, { updatedAt: START });
    await stamp(later, { updatedAt: START });

    const page = await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 50, offset: 0 });

    expect(page.letters.map(({ id }) => id)).toEqual([later, earlier, oldest]);
  });

  it('leaves out a label the stored envelope or failure does not carry as text', async () => {
    const id = await kill();
    const _id = new mongoose.Types.ObjectId(id);
    const bare = {
      id,
      deliveryKey: expect.any(String),
      user: expect.any(String),
      attempts: 1,
      requeues: 0,
      requeueable: true,
      dismissable: true,
      createdAt: expect.any(Date),
    };
    await Delivery.collection.updateOne(
      { _id },
      { $set: { 'lastError.code': '' }, $unset: { settledAt: 1, requeueCount: 1 } },
    );

    for (const envelope of [
      { event: { type: '', source: { type: 7 } }, target: {} },
      { event: { type: 3 } },
      { target: { agentId: null } },
      { version: 1 },
    ]) {
      await Delivery.collection.updateOne({ _id }, { $set: { envelope } });
      await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toStrictEqual(bare);
    }

    await Delivery.collection.updateOne({ _id }, { $unset: { envelope: 1, lastError: 1 } });
    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toStrictEqual(bare);

    await Delivery.collection.updateOne({ _id }, { $unset: { createdAt: 1 } });
    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).rejects.toThrow(
      'Persisted agent trigger delivery is missing its creation time',
    );
  });

  it('describes a dead letter without its input, payload or failure text', async () => {
    const user = new mongoose.Types.ObjectId();
    const expiresAt = new Date(START.getTime() + 86_400_000);
    const id = await kill({ user }, expiresAt);

    const letter = await methods.getAgentTriggerDeadLetter('tenant-1', id);

    expect(letter).toStrictEqual({
      id,
      deliveryKey: expect.stringMatching(/^trigger_dead_/),
      user: String(user),
      source: 'schedule',
      event: 'schedule.occurrence',
      agentId: 'agent_1',
      attempts: 1,
      requeues: 0,
      code: 'FIRE_REJECTED',
      requeueable: true,
      dismissable: true,
      createdAt: expect.any(Date),
      diedAt: START,
      expiresAt,
    });
    const page = await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 5, offset: 0 });
    expect(JSON.stringify([letter, page])).not.toContain(MARKER);
  });

  it('asks the database for labels only, on the status index, never the input or failure text', async () => {
    const id = await kill();
    const projections: Array<Record<string, unknown>> = [];
    const hints: Array<[string, unknown]> = [];
    mongoose.set('debug', (_collection: string, method: string, ...args: unknown[]) => {
      const options = args[args.length - 1] as {
        projection?: Record<string, unknown>;
        hint?: unknown;
      };
      if (method === 'find' || method === 'findOne') {
        projections.push(options.projection ?? {});
      }
      if (method !== 'findOne') {
        hints.push([method, options.hint]);
      }
    });
    try {
      await methods.listAgentTriggerDeadLetterPage('tenant-1', { limit: 5, offset: 0 });
      await methods.getAgentTriggerDeadLetter('tenant-1', id);
    } finally {
      mongoose.set('debug', false);
    }

    expect(hints).toEqual([
      ['find', { status: 1, updatedAt: -1 }],
      ['countDocuments', { status: 1, updatedAt: -1 }],
    ]);
    expect(projections).toHaveLength(2);
    for (const projection of projections) {
      expect(Object.keys(projection).sort()).toEqual([
        'actorActionAdmittedAt',
        'actorDetachedAction.status',
        'actorReceipt.resolution',
        'attempts',
        'backgroundToolResultBatch.batchId',
        'backgroundToolResultBatch.proofCopiedAt',
        'batchMemberIds',
        'batchMembersSettledAt',
        'createdAt',
        'deadLetterExpiresAt',
        'deliveryKey',
        'envelope.event.source.type',
        'envelope.event.type',
        'envelope.target.agentId',
        'expiresAt',
        'handling.status',
        'lastError.code',
        'requeueCount',
        'settledAt',
        'user',
      ]);
    }
  });

  it('reads no dead letter across partitions or for a delivery that is not dead', async () => {
    const id = await kill();
    const alive = await methods.enqueueAgentTriggerDelivery(input());

    await expect(methods.getAgentTriggerDeadLetter('tenant-2', id)).resolves.toBeNull();
    await expect(methods.getAgentTriggerDeadLetter(undefined, id)).resolves.toBeNull();
    await expect(
      methods.getAgentTriggerDeadLetter('tenant-1', alive.delivery.id),
    ).resolves.toBeNull();
    await expect(
      methods.getAgentTriggerDeadLetter('tenant-1', String(new mongoose.Types.ObjectId())),
    ).resolves.toBeNull();
  });
});

describe('requeue within a tenant partition', () => {
  it('revives only a dead letter of the named partition', async () => {
    const id = await kill();

    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-2' }),
    ).resolves.toBeNull();
    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: undefined }),
    ).resolves.toBeNull();
    await expect(Delivery.findById(id).lean()).resolves.toMatchObject({
      status: 'dead',
      requeueCount: 0,
    });

    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
    ).resolves.toMatchObject({ id, status: 'pending', requeueCount: 1 });
    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
    ).resolves.toBeNull();
  });

  it('revives no delivery from a source the caller excepts', async () => {
    const id = await kill();

    await expect(
      methods.requeueAgentTriggerDelivery(id, START, {
        tenantId: 'tenant-1',
        except: ['webhook', 'schedule'],
      }),
    ).resolves.toBeNull();
    await expect(Delivery.findById(id).lean()).resolves.toMatchObject({
      status: 'dead',
      requeueCount: 0,
    });

    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1', except: ['webhook'] }),
    ).resolves.toMatchObject({ id, status: 'pending' });
    const other = await kill();
    await expect(
      methods.requeueAgentTriggerDelivery(other, START, { tenantId: 'tenant-1', except: [] }),
    ).resolves.toMatchObject({ id: other, status: 'pending' });
  });

  it('revives a tenantless dead letter only for the tenantless partition', async () => {
    const id = await kill({ tenantId: undefined });

    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
    ).resolves.toBeNull();
    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: undefined }),
    ).resolves.toMatchObject({ id, status: 'pending' });
  });

  it('reports a delivery that reached a generation as not requeueable', async () => {
    const id = await kill();
    await Delivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          handling: {
            status: 'failed',
            conversationId: 'conversation-1',
            streamId: 'stream-1',
            generationCreatedAt: START.getTime(),
            startedAt: START,
          },
        },
      },
    );

    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      requeueable: false,
      dismissable: true,
    });
    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
    ).resolves.toBeNull();
  });

  it('reports a delivery an event actor settled as not requeueable', async () => {
    const id = await kill();
    await Delivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          actorReceipt: {
            bindingId: 'binding-1',
            resolution: 'history_repaired',
            checkpoint: { threadId: 'thread-1', checkpointNs: '' },
            action: { toolName: 'tool' },
            settledAt: START,
          },
        },
      },
    );

    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      requeueable: false,
      dismissable: true,
    });
    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
    ).resolves.toBeNull();
  });
});

describe('dismiss within a tenant partition', () => {
  it('removes only a dead letter of the named partition', async () => {
    const id = await kill();

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-2', id)).resolves.toBe(false);
    await expect(methods.dismissAgentTriggerDeadLetter(undefined, id)).resolves.toBe(false);
    await expect(Delivery.countDocuments({ _id: id })).resolves.toBe(1);

    await expect(
      commands(() => methods.dismissAgentTriggerDeadLetter('tenant-1', id)),
    ).resolves.toEqual({
      methods: ['findOneAndDelete', 'findOne'],
      projection: { _id: 1, orderingKey: 1, batchMemberIds: 1 },
    });
    await expect(Delivery.countDocuments({ _id: id })).resolves.toBe(0);
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(false);
    await expect(
      methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' }),
    ).resolves.toBeNull();
  });

  it('leaves a delivery that is not dead, or was requeued, in place', async () => {
    const alive = await methods.enqueueAgentTriggerDelivery(input());
    const id = await kill();
    await methods.requeueAgentTriggerDelivery(id, START, { tenantId: 'tenant-1' });

    await expect(
      methods.dismissAgentTriggerDeadLetter('tenant-1', alive.delivery.id),
    ).resolves.toBe(false);
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(false);
    await expect(Delivery.countDocuments({})).resolves.toBe(2);
  });

  it('removes a dead batch together with its receipts', async () => {
    const root = await killBatch();
    const bystander = await kill();
    await expect(Delivery.countDocuments({ batchRootId: root, status: 'dead' })).resolves.toBe(1);
    await expect(methods.getAgentTriggerDeadLetter('tenant-1', root)).resolves.toMatchObject({
      dismissable: true,
    });

    await expect(
      commands(() => methods.dismissAgentTriggerDeadLetter('tenant-1', root)),
    ).resolves.toEqual({
      methods: ['findOneAndDelete', 'deleteMany', 'findOne'],
      projection: { _id: 1, orderingKey: 1, batchMemberIds: 1 },
    });

    await expect(Delivery.find({}).distinct('_id')).resolves.toEqual([
      new mongoose.Types.ObjectId(bystander),
    ]);
  });

  it('refuses a batch whose receipts are not settled yet', async () => {
    const root = await killBatch();
    const _id = new mongoose.Types.ObjectId(root);
    const deadline = new Date(START.getTime() + 3_600_000);
    await Delivery.collection.updateOne(
      { _id },
      { $unset: { batchMembersSettledAt: 1 }, $set: { deadLetterExpiresAt: deadline } },
    );

    await expect(methods.getAgentTriggerDeadLetter('tenant-1', root)).resolves.toMatchObject({
      dismissable: false,
      expiresAt: deadline,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', root)).resolves.toBe(false);
    await expect(Delivery.countDocuments({})).resolves.toBe(2);

    await Delivery.collection.updateOne({ _id }, { $set: { batchMemberIds: [] } });
    await expect(methods.getAgentTriggerDeadLetter('tenant-1', root)).resolves.toMatchObject({
      dismissable: true,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', root)).resolves.toBe(true);
    await expect(Delivery.countDocuments({})).resolves.toBe(1);
  });

  it('removes only the receipts that belong to the dismissed batch and are dead', async () => {
    const root = await killBatch();
    const member = await Delivery.findOne({ batchRootId: root }).lean();
    const stray = await kill();
    const revived = await kill();
    const rootId = new mongoose.Types.ObjectId(root);
    await Delivery.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(revived) },
      { $set: { status: 'batched', batchRootId: rootId } },
    );
    await Delivery.collection.updateOne(
      { _id: rootId },
      {
        $set: {
          batchMemberIds: [
            member!._id,
            new mongoose.Types.ObjectId(stray),
            new mongoose.Types.ObjectId(revived),
          ],
        },
      },
    );

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', root)).resolves.toBe(true);

    const left = await Delivery.find({}).distinct('_id');
    expect(left.map(String).sort()).toEqual([stray, revived].sort());
  });

  it('refuses while an admitted action has no receipt and allows it once it has one', async () => {
    const id = await kill();
    const _id = new mongoose.Types.ObjectId(id);
    await Delivery.collection.updateOne({ _id }, { $set: { actorActionAdmittedAt: START } });

    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      requeueable: false,
      dismissable: false,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(false);

    await Delivery.collection.updateOne(
      { _id },
      {
        $set: {
          actorReceipt: {
            bindingId: 'binding-1',
            resolution: 'action_compensated',
            checkpoint: { threadId: 'thread-1', checkpointNs: '' },
            action: { toolName: 'tool' },
            settledAt: START,
          },
        },
      },
    );
    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      requeueable: false,
      dismissable: true,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);
  });

  it('refuses the owner of a result batch until its followers hold their proof', async () => {
    const id = await kill();
    const _id = new mongoose.Types.ObjectId(id);
    await Delivery.collection.updateOne(
      { _id },
      {
        $set: {
          backgroundToolResultBatch: { batchId: 'batch-1', dispatchCount: 1, candidates: [] },
        },
      },
    );

    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      dismissable: false,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(false);

    await Delivery.collection.updateOne(
      { _id },
      { $set: { 'backgroundToolResultBatch.proofCopiedAt': START } },
    );
    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      dismissable: true,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);
  });

  it('refuses while a detached action is still running', async () => {
    const id = await kill();
    const _id = new mongoose.Types.ObjectId(id);
    await Delivery.collection.updateOne(
      { _id },
      { $set: { 'actorDetachedAction.status': 'running' } },
    );

    await expect(methods.getAgentTriggerDeadLetter('tenant-1', id)).resolves.toMatchObject({
      dismissable: false,
    });
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(false);

    await Delivery.collection.updateOne(
      { _id },
      { $set: { 'actorDetachedAction.status': 'failed' } },
    );
    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);
  });
});

describe('lane of a dismissed dead letter', () => {
  const lane = (orderingKey: string) => LaneSequence.findById(orderingKey).lean();
  const laneOf = async (id: string) =>
    (await Delivery.findById(id).select('orderingKey').lean())!.orderingKey;

  it('reclaims the lane at once instead of at the deadline it was given', async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const id = await kill({}, expiresAt);
    const orderingKey = await laneOf(id);
    await expect(lane(orderingKey)).resolves.toMatchObject({
      cleanupRequestedAt: new Date(expiresAt.getTime() + 60_000),
    });

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);

    await expect(lane(orderingKey)).resolves.toBeNull();
  });

  it('reclaims a lane that no deadline would ever have released', async () => {
    const id = await kill();
    const orderingKey = await laneOf(id);
    await expect(lane(orderingKey)).resolves.not.toHaveProperty('cleanupRequestedAt');

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);

    await expect(lane(orderingKey)).resolves.toBeNull();
  });

  it('reclaims the lane of a dismissed batch once its receipts are gone too', async () => {
    const root = await killBatch();
    const orderingKey = await laneOf(root);

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', root)).resolves.toBe(true);

    await expect(Delivery.countDocuments({ orderingKey })).resolves.toBe(0);
    await expect(lane(orderingKey)).resolves.toBeNull();
  });

  it('keeps a lane another dead letter still holds, until that one is removed', async () => {
    const orderingKey = `shared-lane-${counter}`;
    const later = new Date(Date.now() + 60 * 60_000);
    const first = await kill({ orderingKey }, new Date(Date.now() + 30 * 24 * 60 * 60_000));
    const second = await kill({ orderingKey }, later);

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', first)).resolves.toBe(true);

    await expect(lane(orderingKey)).resolves.toMatchObject({
      cleanupRequestedAt: new Date(later.getTime() + 60_000),
    });
    await expect(methods.reclaimInactiveAgentTriggerLanes()).resolves.toBe(0);

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', second)).resolves.toBe(true);
    await expect(lane(orderingKey)).resolves.toBeNull();
  });

  it('keeps the lane while a delivery is still waiting on it', async () => {
    const orderingKey = `busy-lane-${counter}`;
    const id = await kill({ orderingKey });
    const waiting = await methods.enqueueAgentTriggerDelivery(input({ orderingKey }));

    await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);

    await expect(lane(orderingKey)).resolves.toMatchObject({ _id: orderingKey });
    await expect(lane(orderingKey)).resolves.not.toHaveProperty('cleanupRequestedAt');
    await expect(Delivery.findById(waiting.delivery.id).lean()).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('keeps a dismissal that succeeded when the lane cannot be reached', async () => {
    const id = await kill();
    const orderingKey = await laneOf(id);
    const failure = jest.spyOn(LaneSequence, 'updateOne').mockImplementationOnce(() => {
      throw new Error('lane write failed');
    });
    try {
      await expect(methods.dismissAgentTriggerDeadLetter('tenant-1', id)).resolves.toBe(true);
    } finally {
      failure.mockRestore();
    }
    await expect(Delivery.countDocuments({ _id: id })).resolves.toBe(0);
    await expect(lane(orderingKey)).resolves.toMatchObject({ _id: orderingKey });
  });
});
