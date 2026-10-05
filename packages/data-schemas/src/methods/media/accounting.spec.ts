import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mediaSubmissionRequestSchema } from 'librechat-data-provider';
import type { MediaAccountingStep, MediaAccountingMethods } from '~/types/mediaAccounting';
import type { MediaOwnerScope, MediaMethods } from '~/types/media';
import type { IBalance } from '~/types/balance';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createMediaSettlementModel } from '~/models/mediaSettlement';
import { createTransactionModel } from '~/models/transaction';
import { createMediaAccountingMethods } from './accounting';
import { createTransactionMethods } from '../transaction';
import { createBalanceModel } from '~/models/balance';
import { createUserModel } from '~/models/user';
import { createMediaMethods } from './index';

describe('media accounting on standalone MongoDB', () => {
  let mongo: MongoMemoryServer;
  let scope: MediaOwnerScope;
  let media: MediaMethods;
  let accounting: MediaAccountingMethods;
  let ordinary: ReturnType<typeof createTransactionMethods>;
  const policy = { maxHoldsPerUser: 4, maxAttempts: 30 };
  const now = '2026-09-16T00:00:00.000Z';
  const reviewAt = '2026-09-17T00:00:00.000Z';

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    media = createMediaMethods(mongoose, { ownerExists: async () => true });
    createBalanceModel(mongoose);
    createTransactionModel(mongoose);
    createMediaSettlementModel(mongoose);
    ordinary = createTransactionMethods(mongoose, {
      getMultiplier: () => 1,
      getCacheMultiplier: () => 1,
    });
    accounting = createMediaAccountingMethods(mongoose, {
      prepareBalance: ordinary.prepareBalance,
    });
    await media.ensureMediaIndexes();
    await accounting.ensureMediaAccountingIndexes();
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
    accounting = createMediaAccountingMethods(mongoose, {
      prepareBalance: ordinary.prepareBalance,
    });
    await mongoose.models.Balance.create({ user: scope.ownerId, tokenCredits: 1_000 });
  });

  async function job(
    key = 'request-1',
    executionOwner: 'media' | 'chat' = 'media',
  ): Promise<string> {
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId: key,
      operation: 'image.generate',
      prompt: 'An observatory',
      selection: { connectionId: 'images', modelId: 'model-a', catalogVersion: 'v1' },
    });
    const receipt = await media.stageMediaSubmission({
      scope,
      request,
      maxActiveJobs: 20,
      maxPendingTotal: 100,
      execution: { ...request.selection, api: 'openrouter.images', bindingRevision: 'binding' },
    });
    await media.publishMediaSubmission(scope, receipt.jobId, {
      maxRetainers: 4,
      maxTitleChars: 20,
    });
    if (executionOwner === 'chat') {
      // Seed the legacy persisted owner; new native output never creates a Studio job.
      await mongoose.models.MediaJob.updateOne(
        { ...scope, jobId: receipt.jobId },
        { $set: { executionOwner }, $unset: { activeSlot: 1 } },
      );
    }
    return receipt.jobId;
  }
  const hold = (jobId: string, maxCredits = 400) => ({
    scope,
    jobId,
    estimatedCredits: maxCredits,
    maxCredits,
    policy,
    now,
    reviewAt,
  });
  const settle = (jobId: string, credits = 250) => ({
    scope,
    jobId,
    policy,
    effect: { kind: 'charge' as const, credits, costUSD: 0.25 },
  });
  const balance = () =>
    mongoose.models.Balance.findOne({ user: scope.ownerId })
      .select(
        '+reservedCredits +mediaHolds +mediaDebtCredits +mediaPendingSettlement +mediaSettlementSequence',
      )
      .lean<IBalance>();

  it('upgrades receipt and hold timestamps without changing held credits or settlement identity', async () => {
    const jobId = await job('date-upgrade');
    const acquired = await accounting.acquireMediaHold(hold(jobId));
    await mongoose.models.MediaSettlement.collection.updateOne(
      { settlementId: acquired.settlementId },
      {
        $set: { createdAt: now, reviewAt },
      },
    );
    await mongoose.models.Balance.collection.updateOne(
      { user: new mongoose.Types.ObjectId(scope.ownerId) },
      {
        $set: { 'mediaHolds.0.reviewAt': reviewAt },
      },
    );
    await accounting.ensureMediaAccountingIndexes();
    expect(
      await mongoose.models.MediaSettlement.collection.findOne({
        settlementId: acquired.settlementId,
      }),
    ).toMatchObject({ createdAt: new Date(now), reviewAt: new Date(reviewAt), jobId });
    expect(await balance()).toMatchObject({
      tokenCredits: 1000,
      reservedCredits: 400,
      mediaHolds: [
        { settlementId: acquired.settlementId, jobId, amount: 400, reviewAt: new Date(reviewAt) },
      ],
    });
  });

  it('absorbs a frozen shortfall without consuming another job hold or creating debt', async () => {
    const charged = await job('charged');
    const protectedJob = await job('protected');
    await accounting.acquireMediaHold(hold(charged, 400));
    await accounting.acquireMediaHold(hold(protectedJob, 600));
    const input = {
      ...settle(charged, 800),
      effect: {
        ...settle(charged, 800).effect,
        shortfall: 'absorb' as const,
        costSource: 'tokens' as const,
      },
    };
    await expect(accounting.settleMediaJob(input)).resolves.toEqual(
      expect.objectContaining({
        status: 'settled',
        result: {
          debitedCredits: 400,
          debtCredits: 0,
          releasedCredits: 400,
          remainingCredits: 600,
        },
      }),
    );
    await accounting.settleMediaJob({ ...input, policy: { ...policy, shortfall: 'debt' } });
    expect(await balance()).toEqual(
      expect.objectContaining({
        tokenCredits: 600,
        reservedCredits: 600,
        mediaDebtCredits: 0,
        mediaHolds: [expect.objectContaining({ jobId: protectedJob, amount: 600 })],
      }),
    );
    const receipts = await mongoose.models.Transaction.find({ mediaJobId: charged }).lean();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual(
      expect.objectContaining({
        rawAmount: -800,
        tokenValue: -400,
        debtCredits: 0,
        costSource: 'tokens',
      }),
    );
  });

  function pause() {
    let arrive: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    return {
      entered,
      resume,
      wait: async () => {
        arrive();
        await released;
      },
    };
  }

  async function deleteCancelledOwner(jobId: string) {
    await media.cancelMediaJob(scope, jobId);
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect(
      await media.prepareMediaAccountDeletion({ scope, token: 'delete-paused-admission' }),
    ).toBe(true);
    expect(await accounting.hasMediaAccountingObligations(scope)).toBe(false);
    await media.completeMediaAccountDeletion({ scope, token: 'delete-paused-admission' });
    await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
  }

  it.each<MediaAccountingStep>([
    'registering',
    'registered',
    'admitted',
    'pinned',
    'checked',
    'held',
  ])(
    'cannot restore a hold after cancellation and deletion while admission is paused at %s',
    async (step) => {
      const jobId = await job();
      const stopped = pause();
      const delayed = createMediaAccountingMethods(mongoose, {
        prepareBalance: ordinary.prepareBalance,
        afterStep: async (current) => {
          if (current === step) await stopped.wait();
        },
      });
      const work = delayed.acquireMediaHold(hold(jobId)).catch((error: Error) => error);
      await stopped.entered;
      try {
        await deleteCancelledOwner(jobId);
      } finally {
        stopped.resume();
      }
      await work;
      await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
      expect(await balance()).toBeNull();
      expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(0);
      expect(await media.getMediaJob(scope, jobId)).toBeNull();
    },
  );

  it('fences a delayed hold CAS against a recreated balance, including a legacy balance generation', async () => {
    await ordinary.deleteBalances({ user: scope.ownerId });
    await mongoose.models.Balance.create({
      _id: scope.ownerId,
      user: scope.ownerId,
      tokenCredits: 1000,
    });
    await mongoose.models.Balance.updateOne(
      { _id: scope.ownerId },
      { $unset: { mediaGeneration: 1 } },
    );
    const jobId = await job();
    const stopped = pause();
    const delayed = createMediaAccountingMethods(mongoose, {
      prepareBalance: ordinary.prepareBalance,
      afterStep: async (step) => {
        if (step === 'checked') await stopped.wait();
      },
    });
    const work = delayed.acquireMediaHold(hold(jobId)).catch((error: Error) => error);
    await stopped.entered;
    const previous = await mongoose.models.Balance.findById(scope.ownerId)
      .select('+mediaGeneration')
      .lean<IBalance>();
    expect(previous?.mediaGeneration).toEqual(expect.any(String));
    try {
      await deleteCancelledOwner(jobId);
      await ordinary.prepareBalance({
        user: scope.ownerId,
        amount: 0,
        initialBalance: { tokenCredits: 1000 },
      });
      const recreated = await mongoose.models.Balance.findById(scope.ownerId)
        .select('+mediaGeneration')
        .lean<IBalance>();
      expect(recreated?.mediaGeneration).not.toBe(previous?.mediaGeneration);
    } finally {
      stopped.resume();
    }
    await work;
    expect((await balance())?.mediaHolds).toBeUndefined();
    expect((await balance())?.reservedCredits ?? 0).toBe(0);
    await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
    expect(await balance()).toBeNull();
  });

  it('fences a paused initializer against a recreated receipt and reclaims its late default balance', async () => {
    const jobId = await job();
    const registering = pause();
    const registered = pause();
    const preparing = pause();
    const late = createMediaAccountingMethods(mongoose, {
      prepareBalance: ordinary.prepareBalance,
      afterStep: async (step) => {
        if (step === 'registering') await registering.wait();
        if (step === 'registered') await registered.wait();
      },
    });
    const stale = createMediaAccountingMethods(mongoose, {
      prepareBalance: async (input) => {
        await preparing.wait();
        return ordinary.prepareBalance(input);
      },
    });
    const lateWork = late.acquireMediaHold(hold(jobId)).catch((error: Error) => error);
    await registering.entered;
    const staleWork = stale
      .acquireMediaHold({ ...hold(jobId), initialBalance: { tokenCredits: 1000 } })
      .catch((error: Error) => error);
    await preparing.entered;
    try {
      await deleteCancelledOwner(jobId);
      registering.resume();
      await registered.entered;
      preparing.resume();
      await staleWork;
      expect((await balance())?.mediaHolds).toBeUndefined();
      expect((await balance())?.reservedCredits ?? 0).toBe(0);
      await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
      expect(await balance()).toBeNull();
      expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(0);
    } finally {
      registering.resume();
      registered.resume();
      preparing.resume();
      await Promise.all([lateWork, staleWork]);
    }
  });

  it('does not restore a held job marker after cancellation settled the paused allocation', async () => {
    const jobId = await job();
    const stopped = pause();
    const delayed = createMediaAccountingMethods(mongoose, {
      afterStep: async (step) => {
        if (step === 'held') await stopped.wait();
      },
    });
    const work = delayed.acquireMediaHold(hold(jobId));
    await stopped.entered;
    try {
      await media.cancelMediaJob(scope, jobId);
      await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    } finally {
      stopped.resume();
    }
    await work;
    const current = await media.getMediaJob(scope, jobId);
    expect(current).toMatchObject({ phase: 'cancelled', accounting: { phase: 'settled' } });
    expect(await balance()).toMatchObject({
      tokenCredits: 1000,
      reservedCredits: 0,
      mediaHolds: [],
    });
    expect(await media.prepareMediaAccountDeletion({ scope, token: 'after-held' })).toBe(true);
  });

  it('reclaims an unstarted debt receipt registered after its owner and balance were deleted', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await accounting.settleMediaJob(settle(jobId, 1500));
    await ordinary.updateBalance({ user: scope.ownerId, incrementValue: 100 });
    await media.cancelMediaJob(scope, jobId);
    const stopped = pause();
    const delayed = createMediaAccountingMethods(mongoose, {
      afterStep: async (step) => {
        if (step === 'registering') await stopped.wait();
      },
    });
    const work = delayed.reconcileMediaAccounting({ scope, limit: 10, policy });
    await stopped.entered;
    try {
      expect(await media.prepareMediaAccountDeletion({ scope, token: 'delete-before-debt' })).toBe(
        true,
      );
      expect(await accounting.hasMediaAccountingObligations(scope)).toBe(false);
      await media.completeMediaAccountDeletion({ scope, token: 'delete-before-debt' });
      await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
    } finally {
      stopped.resume();
    }
    await work;
    await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
    expect(await balance()).toBeNull();
    expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(0);
    expect(await mongoose.models.Transaction.countDocuments({ context: 'media_debt' })).toBe(0);
  });

  it('reclaims a delayed ledger upsert after another reconciler completed account deletion', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    const stopped = pause();
    const delayed = createMediaAccountingMethods(mongoose, {
      afterStep: async (step) => {
        if (step === 'projected') await stopped.wait();
      },
    });
    const work = delayed.settleMediaJob(settle(jobId));
    await stopped.entered;
    try {
      await accounting.settleMediaJob(settle(jobId));
      await media.cancelMediaJob(scope, jobId);
      expect(
        await media.prepareMediaAccountDeletion({ scope, token: 'delete-before-ledger-replay' }),
      ).toBe(true);
      await media.completeMediaAccountDeletion({ scope, token: 'delete-before-ledger-replay' });
      await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
      expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(0);
    } finally {
      stopped.resume();
    }
    await work;
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(0);
    await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(0);
    expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(0);
    expect(await balance()).toBeNull();
  });

  it('initializes the shared balance without creating a second reservation', async () => {
    const jobId = await job();
    await ordinary.deleteBalances({ user: scope.ownerId });
    expect(
      await accounting.acquireMediaHold({
        ...hold(jobId),
        initialBalance: { tokenCredits: 800, autoRefillEnabled: false },
      }),
    ).toMatchObject({ status: 'held', availableCredits: 400 });
    expect(await balance()).toMatchObject({ tokenCredits: 800, reservedCredits: 400 });
    const stored = await mongoose.models.Balance.findOne({ user: scope.ownerId })
      .select('+reservations')
      .lean<IBalance>();
    expect(stored?.reservations).toBeUndefined();
    expect(await mongoose.models.Balance.countDocuments()).toBe(1);
  });

  it('uses the existing auto-refill ledger and skips maintenance for an already-held job', async () => {
    const jobId = await job();
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId },
      {
        $set: {
          tokenCredits: 100,
          autoRefillEnabled: true,
          refillAmount: 500,
          refillIntervalValue: 1,
          refillIntervalUnit: 'days',
          lastRefill: new Date(0),
        },
      },
    );
    expect((await accounting.acquireMediaHold(hold(jobId))).status).toBe('held');
    expect(await balance()).toMatchObject({ tokenCredits: 600, reservedCredits: 400 });
    expect(await mongoose.models.Transaction.countDocuments({ context: 'autoRefill' })).toBe(1);
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId },
      { $set: { lastRefill: new Date(0) } },
    );
    expect((await accounting.acquireMediaHold(hold(jobId))).status).toBe('held');
    expect(await balance()).toMatchObject({ tokenCredits: 600, reservedCredits: 400 });
    expect(await mongoose.models.Transaction.countDocuments({ context: 'autoRefill' })).toBe(1);
  });

  it('prunes expired chat reservations while preserving other durable media holds', async () => {
    const first = await job('first');
    const second = await job('second');
    await accounting.acquireMediaHold(hold(first));
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId },
      {
        $push: { reservations: { id: 'expired', amount: 500, expiresAt: new Date(0) } },
        $inc: { reservedCredits: 500 },
      },
    );
    expect((await accounting.acquireMediaHold(hold(second))).status).toBe('held');
    expect(await balance()).toMatchObject({ tokenCredits: 1_000, reservedCredits: 800 });
    expect((await balance())?.mediaHolds).toHaveLength(2);
  });

  it('keeps shared balance maintenance inside the explicit media tenant scope', async () => {
    const unscopedBalance = await balance();
    scope = { ...scope, tenantId: 'tenant-a' };
    await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, async () => {
      await mongoose.models.Balance.create({
        user: scope.ownerId,
        tokenCredits: 100,
        autoRefillEnabled: true,
        refillAmount: 500,
        refillIntervalValue: 1,
        refillIntervalUnit: 'days',
        lastRefill: new Date(0),
      });
    });
    const jobId = await job();
    expect((await accounting.acquireMediaHold(hold(jobId))).status).toBe('held');
    const tenantBalance = await tenantStorage.run(
      { tenantId: scope.tenantId ?? undefined },
      async () => balance(),
    );
    expect(tenantBalance).toMatchObject({ tokenCredits: 600, reservedCredits: 400 });
    expect(await mongoose.models.Balance.findById(unscopedBalance?._id).lean()).toMatchObject({
      tokenCredits: 1_000,
    });
  });

  it('preserves provider token usage in the existing transaction ledger', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    const charge = settle(jobId);
    await accounting.settleMediaJob({
      ...charge,
      effect: { ...charge.effect, inputTokens: 20, outputTokens: 30, model: 'model-a' },
    });
    expect(await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean()).toMatchObject({
      tokenType: 'credits',
      model: 'model-a',
      rawAmount: -250,
      tokenValue: -250,
      inputTokens: 20,
      outputTokens: 30,
      costUSD: 0.25,
    });
  });

  it('keeps legacy null-tenant maintenance from selecting an older tenant balance', async () => {
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId, tenantId: null },
      {
        $set: {
          tokenCredits: 100,
          autoRefillEnabled: true,
          refillAmount: 500,
          refillIntervalValue: 1,
          refillIntervalUnit: 'days',
          lastRefill: new Date(0),
        },
      },
    );
    const other = await mongoose.models.Balance.create({
      _id: '000000000000000000000001',
      user: scope.ownerId,
      tenantId: 'tenant-a',
      tokenCredits: 5_000,
    });
    const jobId = await job();
    expect((await accounting.acquireMediaHold(hold(jobId))).status).toBe('held');
    expect(
      await mongoose.models.Balance.findOne({ user: scope.ownerId, tenantId: null })
        .select('+reservedCredits')
        .lean(),
    ).toMatchObject({ tokenCredits: 600, reservedCredits: 400 });
    expect(await mongoose.models.Balance.findById(other._id).lean()).toMatchObject({
      tokenCredits: 5_000,
    });
  });

  it.each<MediaAccountingStep>(['pinned', 'held'])(
    'recovers an unacknowledged hold after %s',
    async (step) => {
      const jobId = await job();
      let failed = false;
      const crashing = createMediaAccountingMethods(mongoose, {
        afterStep: async (current) => {
          if (current === step && !failed) {
            failed = true;
            throw new Error('crash');
          }
        },
      });
      await expect(crashing.acquireMediaHold(hold(jobId))).rejects.toThrow('crash');
      expect((await accounting.acquireMediaHold(hold(jobId))).status).toBe('held');
      expect((await balance())?.reservedCredits).toBe(400);
      expect((await balance())?.mediaHolds).toHaveLength(1);
    },
  );

  it.each<MediaAccountingStep>([
    'effect',
    'allocated',
    'assigned',
    'applied',
    'projected',
    'ledger',
    'published',
    'cleared',
  ])('settles once across a crash after %s', async (step) => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    let failed = false;
    const crashing = createMediaAccountingMethods(mongoose, {
      afterStep: async (current) => {
        if (current === step && !failed) {
          failed = true;
          throw new Error('crash');
        }
      },
    });
    await expect(crashing.settleMediaJob(settle(jobId))).rejects.toThrow('crash');
    expect((await accounting.settleMediaJob(settle(jobId))).status).toBe('settled');
    await accounting.settleMediaJob(settle(jobId));
    const stored = await balance();
    expect(stored?.tokenCredits).toBe(750);
    expect(stored?.reservedCredits).toBe(0);
    expect(stored?.mediaHolds).toEqual([]);
    expect(stored?.mediaPendingSettlement).toBeUndefined();
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(1);
    expect((await accounting.acquireMediaHold(hold(jobId))).status).toBe('settled');
    expect((await balance())?.reservedCredits).toBe(0);
  });

  it('serializes concurrent settlements and rejects a changed effect', async () => {
    const first = await job('first');
    const second = await job('second');
    await Promise.all([
      accounting.acquireMediaHold(hold(first)),
      accounting.acquireMediaHold(hold(second)),
    ]);
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createMediaAccountingMethods(mongoose).settleMediaJob(settle(index % 2 ? first : second)),
      ),
    );
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect((await balance())?.tokenCredits).toBe(500);
    expect(await mongoose.models.Transaction.countDocuments()).toBe(2);
    await expect(accounting.settleMediaJob(settle(first, 251))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('bounds media capacity and preserves holds past ordinary reservation expiry', async () => {
    const first = await job('first');
    const second = await job('second');
    await accounting.acquireMediaHold(hold(first, 800));
    expect((await accounting.acquireMediaHold(hold(second, 300))).status).toBe('insufficient');
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId },
      {
        $push: {
          reservations: {
            id: 'expired',
            amount: 100,
            expiresAt: new Date(0),
          },
        },
        $inc: { reservedCredits: 100 },
      },
    );
    const ordinaryResult = await ordinary.reserveBalance({
      user: scope.ownerId,
      reservationId: 'chat',
      amount: 201,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(ordinaryResult).toEqual({ reserved: false, balance: 200 });
    expect(
      (await ordinary.findBalanceByUser(scope.ownerId, { includeReservedCredits: true }))
        ?.reservedCredits,
    ).toBe(800);
    expect((await balance())?.mediaHolds).toHaveLength(1);
  });

  it.each(['media-first', 'chat-first'])(
    'preserves chat liability and collects the same overage after a refill (%s)',
    async (order) => {
      const jobId = await job();
      const chat = { user: scope.ownerId, reservationId: 'chat', amount: 600 };
      expect(
        await ordinary.reserveBalance({ ...chat, expiresAt: new Date(Date.now() + 60_000) }),
      ).toMatchObject({ reserved: true });
      expect(await accounting.acquireMediaHold(hold(jobId))).toMatchObject({ status: 'held' });
      const settleChat = async () => {
        await ordinary.updateBalance({ user: scope.ownerId, incrementValue: -chat.amount });
        await ordinary.releaseBalanceReservation(chat);
      };
      if (order === 'chat-first') await settleChat();
      await accounting.settleMediaJob(settle(jobId, 800));
      if (order === 'media-first') {
        expect(await balance()).toMatchObject({
          tokenCredits: 600,
          reservedCredits: 600,
          mediaDebtCredits: 400,
        });
        await settleChat();
      }
      await accounting.settleMediaJob(settle(jobId, 800));
      expect(await balance()).toMatchObject({
        tokenCredits: 0,
        reservedCredits: 0,
        mediaDebtCredits: 400,
      });
      await ordinary.updateBalance({ user: scope.ownerId, incrementValue: 400 });
      await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
      await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
      expect(await balance()).toMatchObject({ tokenCredits: 0, mediaDebtCredits: 0 });
      expect(await mongoose.models.Transaction.countDocuments({ context: 'media' })).toBe(1);
      expect(await mongoose.models.Transaction.countDocuments({ context: 'media_debt' })).toBe(1);
    },
  );

  it('preserves every other hold through concurrent media settlements and an ordinary debit', async () => {
    const first = await job('first');
    const second = await job('second');
    const chat = { user: scope.ownerId, reservationId: 'chat', amount: 400 };
    await ordinary.reserveBalance({ ...chat, expiresAt: new Date(Date.now() + 60_000) });
    await accounting.acquireMediaHold(hold(first, 300));
    await accounting.acquireMediaHold(hold(second, 300));
    const effects = [settle(first, 650), settle(second, 650)];
    await Promise.all([
      ...effects.flatMap((effect) => [
        accounting.settleMediaJob(effect),
        accounting.settleMediaJob(effect),
      ]),
      ordinary.updateBalance({ user: scope.ownerId, incrementValue: -chat.amount }),
    ]);
    await ordinary.releaseBalanceReservation(chat);
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect(await balance()).toMatchObject({
      tokenCredits: 0,
      reservedCredits: 0,
      mediaDebtCredits: 700,
      mediaHolds: [],
    });
    expect(await mongoose.models.Transaction.countDocuments({ context: 'media' })).toBe(2);
    await ordinary.updateBalance({ user: scope.ownerId, incrementValue: 710 });
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect(await balance()).toMatchObject({ tokenCredits: 10, mediaDebtCredits: 0 });
  });

  it.each(['media-first', 'chat-first'] as const)(
    'attributes another writer consuming a held reservation without changing the chat debit contract (%s)',
    async (order) => {
      const jobId = await job();
      const chat = { user: scope.ownerId, reservationId: 'chat-overrun', amount: 600 };
      await ordinary.reserveBalance({ ...chat, expiresAt: new Date(Date.now() + 60_000) });
      await accounting.acquireMediaHold(hold(jobId));
      const chargeChat = async () => {
        await ordinary.updateBalance({ user: scope.ownerId, incrementValue: -900 });
        await ordinary.releaseBalanceReservation(chat);
      };
      if (order === 'chat-first') await chargeChat();
      await accounting.settleMediaJob(settle(jobId, 400));
      if (order === 'media-first') await chargeChat();
      const receipt = await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean<{
        overrunDebtCredits?: number;
        holdShortfallCredits?: number;
      }>();
      expect(receipt).toMatchObject({
        debtCredits: order === 'chat-first' ? 300 : 0,
        tokenValue: order === 'chat-first' ? -100 : -400,
      });
      expect(receipt?.overrunDebtCredits ?? 0).toBe(0);
      expect(receipt?.holdShortfallCredits ?? 0).toBe(order === 'chat-first' ? 300 : 0);
      expect((await balance())?.tokenCredits).toBe(0);
    },
  );

  it('prunes expired chat reservations during settlement and separates media overrun from consumed hold', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId },
      {
        $push: { reservations: { id: 'crashed-chat', amount: 600, expiresAt: new Date(0) } },
        $inc: { reservedCredits: 600 },
      },
    );
    await ordinary.updateBalance({ user: scope.ownerId, incrementValue: -900 });
    await accounting.settleMediaJob(settle(jobId, 600));
    expect(await balance()).toMatchObject({
      tokenCredits: 0,
      reservedCredits: 0,
      mediaDebtCredits: 500,
    });
    expect(await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean()).toMatchObject({
      debtCredits: 500,
      overrunDebtCredits: 200,
      holdShortfallCredits: 300,
    });
  });

  it('collects owed credits after a crashed chat reservation expires without another admission', async () => {
    await mongoose.models.Balance.updateOne(
      { user: scope.ownerId },
      {
        $set: {
          mediaDebtCredits: 400,
          reservedCredits: 1000,
          reservations: [{ id: 'expired', amount: 1000, expiresAt: new Date(0) }],
        },
      },
    );
    await job();
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect(await balance()).toMatchObject({
      tokenCredits: 600,
      reservedCredits: 0,
      mediaDebtCredits: 0,
    });
  });

  it('surfaces overdue holds for recovery while preserving terminal provider evidence and live leases', async () => {
    const completed = await job('completed');
    const running = await job('running');
    await accounting.acquireMediaHold(hold(completed, 300));
    await accounting.acquireMediaHold(hold(running, 300));
    await mongoose.models.MediaJob.updateOne(
      { jobId: completed },
      {
        $set: {
          phase: 'succeeded',
          provider: {
            certainty: 'terminal',
            operationId: 'paid',
            recovery: { terminalStatus: 'completed', parts: [] },
          },
        },
      },
    );
    await mongoose.models.MediaJob.updateOne(
      { jobId: running },
      {
        $set: {
          phase: 'running',
          leaseUntil: new Date(Date.now() + 60_000).toISOString(),
          leaseToken: 'live',
        },
      },
    );
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect(await media.getMediaJob(scope, completed)).toMatchObject({
      phase: 'requires_attention',
      accountingReview: { previousPhase: 'succeeded', reviewAt },
      provider: {
        certainty: 'terminal',
        operationId: 'paid',
        recovery: { terminalStatus: 'completed' },
      },
    });
    expect(await media.getMediaJob(scope, running)).toMatchObject({
      phase: 'running',
      leaseToken: 'live',
    });
    await accounting.settleMediaJob(settle(completed, 200));
    expect(await media.getMediaJob(scope, completed)).toMatchObject({
      phase: 'succeeded',
      accounting: { phase: 'settled' },
    });
    await mongoose.models.MediaJob.updateOne(
      { jobId: running },
      { $set: { leaseUntil: new Date(0).toISOString() } },
    );
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect((await media.getMediaJob(scope, running))?.phase).toBe('requires_attention');
    await mongoose.models.MediaJob.updateOne(
      { jobId: running },
      { $set: { phase: 'running' }, $inc: { version: 1 } },
    );
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect((await media.getMediaJob(scope, running))?.phase).toBe('running');
  });

  it.each<MediaAccountingStep>(['allocated', 'applied', 'ledger', 'cleared'])(
    'preserves concurrent chat funds and debt when media recovery resumes after %s',
    async (step) => {
      const jobId = await job();
      const chat = { user: scope.ownerId, reservationId: 'chat', amount: 600 };
      await ordinary.reserveBalance({ ...chat, expiresAt: new Date(Date.now() + 60_000) });
      await accounting.acquireMediaHold(hold(jobId));
      let crashed = false;
      const crashing = createMediaAccountingMethods(mongoose, {
        afterStep: async (current) => {
          if (current === step && !crashed) {
            crashed = true;
            throw new Error('crash');
          }
        },
      });
      await expect(crashing.settleMediaJob(settle(jobId, 800))).rejects.toThrow('crash');
      await ordinary.updateBalance({ user: scope.ownerId, incrementValue: -600 });
      await ordinary.releaseBalanceReservation(chat);
      await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
      await accounting.settleMediaJob(settle(jobId, 800));
      expect(await balance()).toMatchObject({
        tokenCredits: 0,
        reservedCredits: 0,
        mediaDebtCredits: 400,
      });
      expect(await mongoose.models.Transaction.countDocuments({ context: 'media' })).toBe(1);
    },
  );

  it('records cost provenance without invalidating existing settlement identities', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    const input = settle(jobId);
    await accounting.settleMediaJob({
      ...input,
      effect: { ...input.effect, costSource: 'provider' },
    });
    expect(await accounting.settleMediaJob(input)).toMatchObject({ status: 'settled' });
    expect(await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean()).toMatchObject({
      costSource: 'provider',
      costUSD: 0.25,
    });
    expect(await mongoose.models.Transaction.countDocuments({ context: 'media' })).toBe(1);
  });

  it('records excess paid cost as debt, keeps refill/admission honest, and never blocks deletion', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await accounting.settleMediaJob(settle(jobId, 1_050));
    expect(await balance()).toMatchObject({ tokenCredits: 0, mediaDebtCredits: 50 });
    const receipt = await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean();
    expect(receipt).toMatchObject({
      costUSD: 0.25,
      rawAmount: -1_050,
      tokenValue: -1_000,
      debtCredits: 50,
    });
    // Provider cost, requested credits and wallet debit differ during a shortfall.
    expect(receipt).not.toHaveProperty('mediaCostUSD');
    expect(receipt).not.toHaveProperty('mediaAccountingMode');
    expect(receipt).not.toHaveProperty('mediaFingerprint');
    await ordinary.updateBalance({ user: scope.ownerId, incrementValue: 60 });
    expect(
      await ordinary.reserveBalance({
        user: scope.ownerId,
        reservationId: 'chat',
        amount: 11,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ reserved: false, balance: 10 });
    expect(await accounting.hasMediaAccountingObligations(scope)).toBe(false);
    expect((await ordinary.deleteBalances({ user: scope.ownerId })).deletedCount).toBe(1);
  });

  it.each(['before completion', 'before history deletion', 'after history deletion'] as const)(
    'recovers account accounting cleanup after User deletion and a crash %s',
    async (crash) => {
      const User = createUserModel(mongoose);
      await User.create({ _id: scope.ownerId, email: 'deleted-media-owner@example.test' });
      const jobId = await job();
      await accounting.acquireMediaHold(hold(jobId));
      await accounting.settleMediaJob(settle(jobId));
      await mongoose.models.MediaJob.updateOne(
        { ...scope, jobId },
        {
          $set: { phase: 'failed', 'provider.certainty': 'terminal' },
        },
      );
      expect(await media.prepareMediaAccountDeletion({ scope, token: 'delete-settled' })).toBe(
        true,
      );
      await User.deleteOne({ _id: scope.ownerId });
      if (crash !== 'before completion') {
        const Settlement = mongoose.models.MediaSettlement;
        const remove = Settlement.deleteMany.bind(Settlement);
        const interrupted = jest
          .spyOn(Settlement, 'deleteMany')
          .mockImplementationOnce((...args) => {
            const query = remove(...args);
            const execute = query.exec.bind(query);
            jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
              if (crash === 'after history deletion') await execute();
              throw new Error('Interrupted account settlement cleanup');
            });
            return query;
          });
        try {
          await expect(
            media.completeMediaAccountDeletion({ scope, token: 'delete-settled' }),
          ).rejects.toThrow('Interrupted account settlement cleanup');
        } finally {
          interrupted.mockRestore();
        }
      }
      expect(await mongoose.models.MediaOwner.findOne(scope).lean()).toMatchObject({
        status: crash === 'before completion' ? 'deleting' : 'deleted',
        deletionPrepared: true,
      });
      expect(await media.getMediaJob(scope, jobId)).not.toBeNull();
      await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
      await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
      expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(0);
      expect(await media.getMediaJob(scope, jobId)).toBeNull();
      expect(await mongoose.models.MediaOwner.findOne(scope).lean()).toMatchObject({
        status: 'deleted',
      });
    },
  );

  it('retains unsettled accounting and job evidence until deletion recovery can safely purge them', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await media.cancelMediaJob(scope, jobId);
    expect(await media.prepareMediaAccountDeletion({ scope, token: 'delete-held' })).toBe(true);
    await expect(
      media.completeMediaAccountDeletion({ scope, token: 'delete-held' }),
    ).rejects.toThrow('Outstanding media accounting prevents history deletion');
    await expect(media.reconcileMediaAccountDeletion({ scope, limit: 10 })).rejects.toThrow(
      'Outstanding media accounting prevents history deletion',
    );
    expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(1);
    expect(await media.getMediaJob(scope, jobId)).not.toBeNull();
    expect(await balance()).toMatchObject({ reservedCredits: 400, tokenCredits: 1000 });

    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
    expect(await mongoose.models.MediaSettlement.countDocuments(scope)).toBe(0);
    expect(await media.getMediaJob(scope, jobId)).toBeNull();
    expect(await balance()).toBeNull();
  });

  it.each([
    ['balance', false],
    ['balance', true],
    ['transactions', false],
    ['transactions', true],
  ] as const)(
    'reclaims a real %s image ledger receipt inserted after owner tombstone removal (interrupted=%s)',
    async (mode, interrupted) => {
      const User = createUserModel(mongoose);
      await User.create({ _id: scope.ownerId, email: 'late-ledger@example.test' });
      const jobId = await job('late-ledger');
      if (mode === 'balance') await accounting.acquireMediaHold(hold(jobId));
      const stopped = pause();
      const delayed = createMediaAccountingMethods(mongoose, {
        upsertCreditsTransaction: async (input) => {
          await stopped.wait();
          return ordinary.upsertCreditsTransaction(input);
        },
      });
      const charge = {
        ...settle(jobId),
        effect: { ...settle(jobId).effect, operation: 'image.generate' as const },
      };
      const usage = { scope, jobId, credits: 250, costUSD: 0.25 };
      const publish = (repository: MediaAccountingMethods) =>
        mode === 'balance' ? repository.settleMediaJob(charge) : repository.recordMediaUsage(usage);
      const late = publish(delayed).catch((error: Error) => error);
      await stopped.entered;
      let ownerRead: jest.SpyInstance | undefined;
      try {
        await publish(accounting);
        expect(
          await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean(),
        ).toMatchObject({
          context: 'image_generation',
        });
        await mongoose.models.MediaJob.updateOne(
          { ...scope, jobId },
          { $set: { phase: 'failed', 'provider.certainty': 'terminal' } },
        );
        expect(await media.prepareMediaAccountDeletion({ scope, token: 'late-ledger' })).toBe(true);
        await User.deleteOne({ _id: scope.ownerId });
        await media.completeMediaAccountDeletion({ scope, token: 'late-ledger' });
        expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(0);
        await media.reconcileMediaAccountDeletion({ scope, limit: 10 });
        await mongoose.models.MediaOwner.deleteOne(scope);
        if (interrupted) {
          ownerRead = jest
            .spyOn(mongoose.models.MediaOwner, 'findOne')
            .mockImplementationOnce(() => {
              throw new Error('Interrupted after ledger insertion');
            });
        }
      } finally {
        stopped.resume();
      }
      const result = await late;
      ownerRead?.mockRestore();
      if (interrupted) {
        expect(result).toEqual(new Error('Interrupted after ledger insertion'));
        expect(
          await mongoose.models.Transaction.findOne({ mediaJobId: jobId })
            .select('+mediaAccountPending')
            .lean(),
        ).toMatchObject({ context: 'image_generation', mediaAccountPending: true });
        const scopes = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
          accounting.listMediaAccountingScopes({ limit: 1 }),
        );
        expect(scopes.items).toContainEqual(scope);
        await accounting.reconcileMediaAccounting({ scope, limit: 1, policy });
      }
      expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(0);
      expect(await balance()).toBeNull();
      expect(await mongoose.models.MediaOwner.exists(scope)).toBeNull();
    },
  );

  it('does not recreate a ledger row deleted after its owner validation', async () => {
    const jobId = await job('validation-race');
    const Owner = mongoose.models.MediaOwner;
    const findOwner = Owner.findOne.bind(Owner);
    const validation = jest.spyOn(Owner, 'findOne').mockImplementationOnce((...args) => {
      const query = findOwner(...args);
      const execute = query.exec.bind(query);
      jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
        const result = await execute();
        await mongoose.models.Transaction.deleteMany({ mediaJobId: jobId });
        return result;
      });
      return query;
    });
    try {
      await accounting.recordMediaUsage({ scope, jobId, credits: 250, costUSD: 0.25 });
    } finally {
      validation.mockRestore();
    }
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(0);
  });

  it('bounds pending-ledger reconciliation and keeps another tenant and deleting owner fenced', async () => {
    await job('pending-ledger-scope');
    const Transaction = mongoose.models.Transaction;
    await Transaction.insertMany([
      ...['first', 'second'].map((id) => ({
        user: scope.ownerId,
        tenantId: null,
        tokenType: 'credits',
        mediaSettlementId: id,
        mediaAccountPending: true,
      })),
      {
        user: scope.ownerId,
        tenantId: 'other-tenant',
        tokenType: 'credits',
        mediaSettlementId: 'foreign',
        mediaAccountPending: true,
      },
    ]);
    await accounting.reconcileMediaAccounting({ scope, limit: 1, policy });
    expect(await Transaction.countDocuments({ tenantId: null, mediaAccountPending: true })).toBe(1);
    expect(
      await Transaction.countDocuments({ tenantId: 'other-tenant', mediaAccountPending: true }),
    ).toBe(1);
    expect(await Transaction.findOne({ mediaSettlementId: 'second' }).lean()).not.toHaveProperty(
      'mediaAccountPending',
    );
    await mongoose.models.MediaOwner.updateOne(scope, { $set: { status: 'deleting' } });
    await accounting.reconcileMediaAccounting({ scope, limit: 1, policy });
    expect(await Transaction.countDocuments({ tenantId: null, mediaAccountPending: true })).toBe(1);
    await mongoose.models.MediaOwner.updateOne(scope, { $set: { status: 'active' } });
    await accounting.reconcileMediaAccounting({ scope, limit: 1, policy });
    expect(await Transaction.countDocuments({ tenantId: null, mediaAccountPending: true })).toBe(0);
    expect(
      await Transaction.countDocuments({ tenantId: 'other-tenant', mediaAccountPending: true }),
    ).toBe(1);
  });

  it('releases only a certain no-charge result and never charges native chat again', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await accounting.releaseMediaHold({ scope, jobId, policy, certainNoCharge: true });
    expect(await balance()).toMatchObject({ tokenCredits: 1_000, reservedCredits: 0 });
    const chatJob = await job('chat', 'chat');
    await expect(accounting.acquireMediaHold(hold(chatJob))).rejects.toMatchObject({
      code: 'invalid_job',
    });
    await expect(
      accounting.acquireMediaHold({
        ...hold(jobId),
        scope: { ...scope, ownerId: new mongoose.Types.ObjectId().toString() },
      }),
    ).rejects.toMatchObject({ code: 'invalid_job' });
  });

  it('collects debt from refilled credits through the recoverable settlement slot', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await accounting.settleMediaJob(settle(jobId, 1_050));
    await ordinary.updateBalance({ user: scope.ownerId, incrementValue: 60 });
    let failed = false;
    const crashing = createMediaAccountingMethods(mongoose, {
      afterStep: async (step) => {
        if (step === 'applied' && !failed) {
          failed = true;
          throw new Error('crash');
        }
      },
    });
    await expect(crashing.reconcileMediaAccounting({ scope, limit: 10, policy })).rejects.toThrow(
      'crash',
    );
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    await accounting.reconcileMediaAccounting({ scope, limit: 10, policy });
    expect(await balance()).toMatchObject({
      tokenCredits: 10,
      mediaDebtCredits: 0,
      reservedCredits: 0,
    });
    expect(await mongoose.models.Transaction.countDocuments({ context: 'media_debt' })).toBe(1);
  });

  it('pins the original balance and protects pending liabilities from deletion', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    expect((await ordinary.deleteBalances({ user: scope.ownerId })).deletedCount).toBe(0);
    await expect(accounting.deleteMediaAccountingHistory(scope)).rejects.toMatchObject({
      code: 'invariant',
    });
    const pinned = await balance();
    await mongoose.models.Balance.create({
      _id: new mongoose.Types.ObjectId('000000000000000000000001'),
      user: scope.ownerId,
      tokenCredits: 5_000,
    });
    await accounting.settleMediaJob(settle(jobId));
    expect(
      (await mongoose.models.Balance.findById(pinned?._id).lean<IBalance>())?.tokenCredits,
    ).toBe(750);
    expect(
      (await mongoose.models.Balance.findById('000000000000000000000001').lean<IBalance>())
        ?.tokenCredits,
    ).toBe(5_000);
  });

  it('records transaction-only usage once without debiting or inventing a cost', async () => {
    const jobId = await job();
    await accounting.recordMediaUsage({ scope, jobId, inputTokens: 20, outputTokens: 30 });
    await accounting.recordMediaUsage({ scope, jobId, inputTokens: 20, outputTokens: 30 });
    expect((await balance())?.tokenCredits).toBe(1_000);
    expect(await mongoose.models.MediaSettlement.countDocuments()).toBe(0);
    expect(await mongoose.models.Transaction.countDocuments()).toBe(1);
    const transaction = await mongoose.models.Transaction.findOne({ mediaJobId: jobId }).lean<{
      tokenValue?: number;
      costUSD?: number;
    }>();
    expect(transaction?.tokenValue).toBeUndefined();
    expect(transaction?.costUSD).toBeUndefined();
    await expect(accounting.recordMediaUsage({ scope, jobId, costUSD: 1 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('replays an existing transaction-only receipt after shared-writer and column-name changes', async () => {
    const jobId = await job();
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const settlementId = hash(JSON.stringify([scope.tenantId, scope.ownerId, jobId]));
    const descriptor = {
      user: scope.ownerId,
      tenantId: scope.tenantId,
      tokenType: 'credits',
      context: 'media',
      model: 'model-a',
      rawAmount: -250,
      tokenValue: -250,
      rate: 1,
      inputTokens: 20,
      mediaOutputTokens: 30,
      mediaSettlementId: settlementId,
      mediaJobId: jobId,
      mediaCostUSD: 0.25,
      mediaAccountingMode: 'transactions',
    };
    const fingerprint = hash(JSON.stringify(descriptor));
    const _id = new mongoose.Types.ObjectId(hash(`media:${settlementId}`).slice(0, 24));
    await mongoose.models.Transaction.collection.insertOne({
      ...descriptor,
      _id,
      user: new mongoose.Types.ObjectId(scope.ownerId),
      mediaFingerprint: fingerprint,
      mediaCostSource: 'provider',
    });
    await accounting.recordMediaUsage({
      scope,
      jobId,
      credits: 250,
      costUSD: 0.25,
      model: 'model-a',
      inputTokens: 20,
      outputTokens: 30,
      costSource: 'provider',
    });
    expect(await mongoose.models.Transaction.countDocuments({ mediaJobId: jobId })).toBe(1);
    expect(await mongoose.models.Transaction.findById(_id).lean()).toEqual(
      expect.objectContaining({ tokenValue: -250, mediaFingerprint: fingerprint }),
    );
    expect(await media.getMediaJob(scope, jobId)).toEqual(
      expect.objectContaining({
        accounting: expect.objectContaining({ phase: 'settled', credits: 250 }),
      }),
    );
    expect((await balance())?.tokenCredits).toBe(1000);
  });

  it('rejects a scope that differs from the active tenant context', async () => {
    const jobId = await job();
    await expect(
      tenantStorage.run({ tenantId: 'other-tenant' }, () =>
        accounting.acquireMediaHold(hold(jobId)),
      ),
    ).rejects.toMatchObject({ code: 'invalid_job' });
  });

  it('discovers debt and unacknowledged holds without retired threads or expiring assets', async () => {
    const heldJob = await job();
    await accounting.acquireMediaHold(hold(heldJob));
    expect(await accounting.hasMediaAccountingObligations(scope)).toBe(true);
    const later = { ownerId: 'fffffffffffffffffffffffe', tenantId: 'tenant-b' };
    await mongoose.models.Balance.create({
      user: later.ownerId,
      tenantId: later.tenantId,
      tokenCredits: 100,
      mediaDebtCredits: 10,
    });
    await expect(accounting.listMediaAccountingScopes({ limit: 1 })).rejects.toMatchObject({
      code: 'invalid_job',
    });
    const first = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
      accounting.listMediaAccountingScopes({ limit: 1 }),
    );
    expect(first.items).toEqual([scope]);
    expect(first.nextCursor).toBeDefined();
    const next = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
      accounting.listMediaAccountingScopes({ limit: 1, cursor: first.nextCursor }),
    );
    expect(next.items).toEqual([later]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('releases a durable hold when a queued job is cancelled before dispatch', async () => {
    const jobId = await job();
    await accounting.acquireMediaHold(hold(jobId));
    await media.cancelMediaJob(scope, jobId);
    await accounting.reconcileMediaAccounting({ scope, limit: 20, policy });
    expect((await balance())?.tokenCredits).toBe(1_000);
    expect((await balance())?.reservedCredits).toBe(0);
    expect(await accounting.hasMediaAccountingObligations(scope)).toBe(false);
  });

  it('collects debt from its pinned legacy balance without letting debt alone hold accounting hostage', async () => {
    const jobId = await job();
    const pinned = await balance();
    await accounting.acquireMediaHold(hold(jobId));
    await accounting.settleMediaJob(settle(jobId, 1_200));
    expect(await accounting.hasMediaAccountingObligations(scope)).toBe(false);
    await mongoose.models.Balance.create({
      _id: '000000000000000000000001',
      user: scope.ownerId,
      tokenCredits: 5_000,
    });
    await mongoose.models.Balance.updateOne({ _id: pinned?._id }, { $set: { tokenCredits: 200 } });
    await accounting.reconcileMediaAccounting({ scope, limit: 20, policy });
    const debtBalance = await mongoose.models.Balance.findById(pinned?._id)
      .select('+mediaDebtCredits')
      .lean<IBalance>();
    expect(debtBalance?.tokenCredits).toBe(0);
    expect(debtBalance?.mediaDebtCredits).toBe(0);
    expect(
      (await mongoose.models.Balance.findById('000000000000000000000001').lean<IBalance>())
        ?.tokenCredits,
    ).toBe(5_000);
    await accounting.deleteMediaAccountingHistory(scope);
    expect(await mongoose.models.MediaSettlement.countDocuments()).toBe(0);
  });
});
