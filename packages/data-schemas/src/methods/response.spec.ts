import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  ResponseReservation,
  ResponseStorage,
  ResponseResumeReservation,
  ResponseTerminalReceipt,
} from './response';
import {
  closeResponseScopes,
  eraseResponseRecords,
  createResponseRetention,
} from './responseScope';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createConversationMethods } from './conversation';
import { createConversationImportMethods } from './import';
import { createResponseStorage } from './response';
import { createModels } from '~/models';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
const owner = { userId: 'owner', tenantId: 'tenant-a' };
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: owner.tenantId }, work);
const reservation = (overrides: Partial<ResponseReservation> = {}): ResponseReservation => ({
  ...owner,
  responseId: 'resp_one',
  requestKey: 'request-one',
  fingerprint: 'same-request',
  agentId: 'agent-one',
  requestJSON: JSON.stringify({
    model: 'agent-one',
    input: 'Hello',
    background: true,
    store: true,
  }),
  conversationId: 'conversation-one',
  parentMessageId: 'root',
  ...overrides,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  storage = createResponseStorage(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
});

it('creates correctness indexes with autoIndex disabled and deduplicates concurrent requests', () =>
  scoped(async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        storage.reserve(reservation({ responseId: `resp_${index}` })),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const records = results.flatMap((result) => (result.ok ? [result.record.responseId] : []));
    expect(new Set(records).size).toBe(1);
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
  }));

it('expires private reads and mutations immediately while retaining only cleanup identity', () =>
  scoped(async () => {
    const expiredAt = new Date(Date.now() + 60_000);
    await storage.reserve(reservation({ expiredAt }));
    expect(await mongoose.models.StoredResponse.collection.indexExists('expiredAt_1')).toBe(true);
    await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(Date.now() - 1));
    expect(await storage.read(owner, 'resp_one')).toBeNull();
    expect(await storage.requestCancellation(owner, 'resp_one', Date.now())).toBeNull();
    expect(await storage.attachDelivery(owner, 'resp_one', 'late')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(
      await storage.publish(owner, 'resp_one', 0, {
        status: 'in_progress',
        responseJSON: '{"late":"private"}',
        generationCreatedAt: 1,
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const identity = await storage.readCleanupIdentity(owner, 'resp_one');
    expect(identity).toMatchObject({ responseId: 'resp_one', userId: owner.userId });
    expect(JSON.stringify(identity)).not.toContain('Hello');
    expect(identity).not.toHaveProperty('requestJSON');
    expect(identity).not.toHaveProperty('responseJSON');
    await mongoose.models.StoredResponse.deleteMany({});
    expect(await storage.reserve(reservation())).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
  }));

it('propagates conversation retention before parent persistence and never lengthens response expiry', () =>
  scoped(async () => {
    createModels(mongoose);
    await storage.reserve(reservation());
    const methods = createConversationMethods(mongoose, {
      getMessages: jest.fn(async () => []),
      deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    });
    const deadline = new Date(Date.now() + 60_000);
    await methods.saveConvo(
      { userId: owner.userId, expiredAt: deadline },
      {
        conversationId: 'conversation-one',
        endpoint: 'agents',
      },
    );
    expect((await storage.read(owner, 'resp_one'))?.expiredAt).toEqual(deadline);
    await methods.saveConvo(
      { userId: owner.userId, expiredAt: new Date(Date.now() + 120_000) },
      {
        conversationId: 'conversation-one',
        endpoint: 'agents',
      },
    );
    expect((await storage.read(owner, 'resp_one'))?.expiredAt).toEqual(deadline);
    await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(Date.now() - 1));
    expect(await storage.reserve(reservation({ requestKey: 'late' }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
  }));

it('applies newly resolved expiry to replay and sibling payloads in the reservation transaction', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.reserve(reservation({ responseId: 'resp_sibling', requestKey: 'sibling' }));
    const expiredAt = new Date(Date.now() + 60_000);
    const replay = await storage.reserve(reservation({ expiredAt }));
    expect(replay).toMatchObject({ ok: true, replayed: true, record: { expiredAt } });
    expect((await storage.read(owner, 'resp_sibling'))?.expiredAt).toEqual(expiredAt);
    expect(await storage.reserve(reservation({ expiredAt: new Date(Date.now() - 1) }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    expect(await storage.read(owner, 'resp_one')).toBeNull();
    expect(await storage.read(owner, 'resp_sibling')).toBeNull();
  }));

it('rejects changed input under the same idempotency key without replacing the original', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    expect(
      await storage.reserve(reservation({ fingerprint: 'changed', requestJSON: 'changed' })),
    ).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect((await storage.read(owner, 'resp_one'))?.fingerprint).toBe('same-request');
  }));

it('replays concurrent retries against the winning conversation rather than their fresh ids', () =>
  scoped(async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        storage.reserve(
          reservation({
            responseId: `resp_${index}`,
            conversationId: `conversation-${index}`,
          }),
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      new Set(results.flatMap((result) => (result.ok ? [result.record.conversationId] : []))).size,
    ).toBe(1);
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
  }));

it('rolls back admission writes when insertion fails before commit', () =>
  scoped(async () => {
    jest
      .spyOn(mongoose.models.StoredResponse.collection, 'insertOne')
      .mockRejectedValueOnce(new Error('interrupted insertion'));
    await expect(storage.reserve(reservation())).rejects.toThrow('interrupted insertion');
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
    const anchors = await mongoose.models.ResponseScope.find({}).lean();
    expect(anchors.every((anchor) => anchor.revision === 0)).toBe(true);
    await closeResponseScopes(mongoose, owner);
    expect(await storage.reserve(reservation())).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
  }));

it('fences an authenticated delayed reservation before missing-root recovery probes', async () => {
  createModels(mongoose);
  const user = await runAsSystem(() =>
    mongoose.models.User.create({
      email: 'response-recovery@example.com',
      provider: 'local',
      tenantId: owner.tenantId,
    }),
  );
  const authenticated = { userId: String(user._id), tenantId: user.tenantId };
  const conversationId = 'already-deleted-root';
  let delayedResult;
  const methods = createConversationMethods(mongoose, {
    getMessages: jest.fn(async () => {
      // This request passed authority before recovery, then reached reserve after its probes began.
      delayedResult = await storage.reserve(reservation({ ...authenticated, conversationId }));
      return [];
    }),
    deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
  });
  await runAsSystem(() =>
    methods.deleteConvos(authenticated.userId, { conversationId }, { allowEmpty: true }),
  );
  expect(delayedResult).toEqual({ ok: false, code: 'response_unavailable' });
  expect(await storage.read(authenticated, 'resp_one')).toBeNull();
  await runAsSystem(() => mongoose.models.User.deleteOne({ _id: user._id }));
});

it.each([undefined, ''])(
  'shares tenantless admission and reads for tenantId=%p',
  async (tenantId) => {
    const tenantless = { userId: 'tenantless', tenantId };
    await tenantStorage.run({ tenantId: '' }, async () => {
      const result = await storage.reserve(reservation(tenantless));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.tenantId).toBe(tenantId);
      expect(await storage.read({ userId: tenantless.userId }, 'resp_one')).not.toBeNull();
      expect(
        await storage.reserve(
          reservation({ ...tenantless, tenantId: '', responseId: 'resp_retry' }),
        ),
      ).toMatchObject({ ok: true, replayed: true });
      await mongoose.models.StoredResponse.collection.updateOne(
        { responseId: 'resp_one' },
        { $set: { tenantId: null } },
      );
      expect(await storage.read({ ...tenantless, tenantId: '' }, 'resp_one')).not.toBeNull();
      await closeResponseScopes(mongoose, { ...tenantless, tenantId: '' });
      expect(
        await storage.reserve(
          reservation({ userId: tenantless.userId, tenantId: undefined, requestKey: 'later' }),
        ),
      ).toEqual({
        ok: false,
        code: 'response_unavailable',
      });
    });
  },
);

it('fences an in-flight response before import rollback deletes its conversation', () =>
  scoped(async () => {
    createModels(mongoose);
    await mongoose.models.Conversation.create({
      user: owner.userId,
      conversationId: 'conversation-one',
      endpoint: 'agents',
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.StoredResponse.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const pending = storage.reserve(reservation());
    await started;
    const rollback = createConversationImportMethods(mongoose).deleteImportedConversations({
      user: owner.userId,
      tenantId: owner.tenantId,
      conversationIds: ['conversation-one'],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        await mongoose.models.Conversation.exists({ conversationId: 'conversation-one' }),
      ).not.toBeNull();
    } finally {
      release();
      paused.mockRestore();
    }
    expect((await pending).ok).toBe(true);
    await rollback;
    expect(await storage.read(owner, 'resp_one')).toBeNull();
    expect(
      await mongoose.models.Conversation.exists({ conversationId: 'conversation-one' }),
    ).toBeNull();
    expect(await storage.reserve(reservation())).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
  }));

it('does not reveal or mutate a response belonging to another user or tenant', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    for (const stranger of [
      { ...owner, userId: 'stranger' },
      { ...owner, tenantId: 'tenant-b' },
    ]) {
      await tenantStorage.run({ tenantId: stranger.tenantId }, async () => {
        expect(await storage.read(stranger, 'resp_one')).toBeNull();
        expect(await storage.attachDelivery(stranger, 'resp_one', 'delivery')).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(
          await storage.publish(stranger, 'resp_one', 0, {
            status: 'completed',
            responseJSON: '{}',
          }),
        ).toEqual({ ok: false, code: 'response_conflict' });
        expect(await storage.requestCancellation(stranger, 'resp_one', 100)).toBeNull();
      });
    }
    expect((await storage.read(owner, 'resp_one'))?.revision).toBe(0);
  }));

it('rejects an explicit owner tenant that disagrees with authenticated async context', () =>
  scoped(async () => {
    await expect(storage.reserve(reservation({ tenantId: 'tenant-b' }))).rejects.toThrow(
      'Response tenant does not match authenticated scope',
    );
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
  }));

it('allows the same request key independently for another authenticated owner', () =>
  scoped(async () => {
    expect((await storage.reserve(reservation())).ok).toBe(true);
    expect(
      (await storage.reserve(reservation({ userId: 'other', responseId: 'resp_other' }))).ok,
    ).toBe(true);
  }));

it('attaches only one immutable queue delivery identity', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    expect((await storage.attachDelivery(owner, 'resp_one', 'delivery')).ok).toBe(true);
    expect((await storage.attachDelivery(owner, 'resp_one', 'delivery')).ok).toBe(true);
    expect(await storage.attachDelivery(owner, 'resp_one', 'different')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
  }));

it('CAS-publishes one terminal result and never allows a stale observer to clobber it', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const results = await Promise.all(
      ['completed', 'cancelled'].map((status) =>
        storage.publish(owner, 'resp_one', 0, {
          status: status as 'completed' | 'cancelled',
          responseJSON: status,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const record = (await storage.read(owner, 'resp_one'))!;
    expect(
      await storage.publish(owner, 'resp_one', record.revision, {
        status: 'in_progress',
        responseJSON: 'stale',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect((await storage.read(owner, 'resp_one'))?.responseJSON).toBe(record.responseJSON);
  }));

it('rejects a replacement generation and backwards queued transitions', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    expect(
      (
        await storage.publish(owner, 'resp_one', 0, {
          status: 'in_progress',
          responseJSON: '{}',
          generationCreatedAt: 10,
        })
      ).ok,
    ).toBe(true);
    expect(
      await storage.publish(owner, 'resp_one', 1, {
        status: 'completed',
        responseJSON: '{}',
        generationCreatedAt: 20,
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.publish(owner, 'resp_one', 1, { status: 'queued', responseJSON: '{}' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('persists cancellation intent once without claiming the provider has stopped', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.requestCancellation(owner, 'resp_one', 100);
    const record = await storage.requestCancellation(owner, 'resp_one', 200);
    expect(record).toMatchObject({ status: 'queued', cancellationRequestedAt: 100, revision: 0 });
  }));

it('rejects queued execution after cancellation without relying on a revision change', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.requestCancellation(owner, 'resp_one', 100);
    expect(
      await storage.publish(owner, 'resp_one', 0, {
        status: 'in_progress',
        generationCreatedAt: 10,
        responseJSON: '{}',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('requires a usable initial generation and permits subsequent progress without repeating it', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    expect(
      await storage.publish(owner, 'resp_one', 0, { status: 'in_progress', responseJSON: '{}' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    for (const generationCreatedAt of [0, -1, NaN, Infinity, 1.5])
      await expect(
        storage.publish(owner, 'resp_one', 0, {
          status: 'in_progress',
          generationCreatedAt,
          responseJSON: '{}',
        }),
      ).rejects.toThrow('Invalid response generation identity');
    expect(
      (
        await storage.publish(owner, 'resp_one', 0, {
          status: 'in_progress',
          generationCreatedAt: 10,
          responseJSON: '{}',
        })
      ).ok,
    ).toBe(true);
    await storage.requestCancellation(owner, 'resp_one', 100);
    expect(
      (
        await storage.publish(owner, 'resp_one', 1, {
          status: 'in_progress',
          responseJSON: '{"progress":true}',
        })
      ).ok,
    ).toBe(true);
  }));

it('does not add cancellation intent to an already completed response', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.publish(owner, 'resp_one', 0, { status: 'completed', responseJSON: '{}' });
    expect(
      (await storage.requestCancellation(owner, 'resp_one', 100))?.cancellationRequestedAt,
    ).toBeUndefined();
  }));

const review = {
  actionId: 'action-one',
  providerExecutionId: 'provider-one',
  expiresAt: 1000,
  partialResponseJSON: '{"private":"checkpoint seed"}',
};
const resume = (overrides: Partial<ResponseResumeReservation> = {}): ResponseResumeReservation => ({
  generationCreatedAt: 10,
  intentId: 'intent-one',
  actionId: review.actionId,
  previousProviderExecutionId: review.providerExecutionId,
  providerExecutionId: 'provider-two',
  fingerprint: 'decision-one',
  resolutionJSON: '{"approved":true}',
  ...overrides,
});

async function pause() {
  await storage.reserve(reservation());
  const started = await storage.publish(owner, 'resp_one', 0, {
    status: 'in_progress',
    responseJSON: '{}',
    generationCreatedAt: 10,
  });
  expect(started.ok).toBe(true);
  const paused = await storage.publishReview(
    owner,
    'resp_one',
    1,
    10,
    review,
    '{"status":"requires_action"}',
  );
  expect(paused.ok).toBe(true);
}

it('retains a valid private visible-token seed and rejects fractional, negative or overflowing counters', () =>
  scoped(async () => {
    await pause();
    const result = await storage.publishReview(
      owner,
      'resp_one',
      2,
      10,
      { ...review, visibleOutputTokens: 13 },
      '{"status":"requires_action"}',
    );
    expect(result).toMatchObject({ ok: true, record: { review: { visibleOutputTokens: 13 } } });
    if (!result.ok) throw new Error('Review publication failed');
    expect(result.record.responseJSON).not.toContain('visibleOutputTokens');
    for (const visibleOutputTokens of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        storage.publishReview(
          owner,
          'resp_one',
          result.record.revision,
          10,
          { ...review, visibleOutputTokens },
          '{}',
        ),
      ).rejects.toThrow();
    expect((await storage.read(owner, 'resp_one'))?.review?.visibleOutputTokens).toBe(13);
  }));

it('persists one immutable resume decision under concurrent equivalent retries', () =>
  scoped(async () => {
    await pause();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        storage.reserveResume(
          owner,
          'resp_one',
          resume({
            intentId: `intent-${index}`,
            providerExecutionId: `next-${index}`,
          }),
          100,
        ),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    const intents = results.flatMap((result) =>
      result.ok ? [result.record.resume?.intentId] : [],
    );
    expect(new Set(intents).size).toBe(1);
    expect(
      await storage.reserveResume(
        owner,
        'resp_one',
        resume({ resolutionJSON: '{"approved":false}' }),
        100,
      ),
    ).toEqual({ ok: false, code: 'resume_conflict' });
    const stored = (await storage.read(owner, 'resp_one'))!;
    expect(stored.requestJSON).toBe(reservation().requestJSON);
    expect(stored.review).toEqual(review);
    expect(stored.revision).toBe(3);
  }));

it('retains the original wire decision and does not conflate different scopes with the same SDK resolution', () =>
  scoped(async () => {
    await pause();
    expect(
      await storage.reserveResume(
        owner,
        'resp_one',
        resume({ decisionJSON: '{"scope":"once"}' }),
        500,
      ),
    ).toMatchObject({ ok: true, record: { resume: { decisionJSON: '{"scope":"once"}' } } });
    expect(
      await storage.reserveResume(
        owner,
        'resp_one',
        resume({ decisionJSON: '{"scope":"session"}' }),
        500,
      ),
    ).toMatchObject({ ok: false, code: 'resume_conflict' });
    expect((await storage.read(owner, 'resp_one'))!.resume?.decisionJSON).toBe('{"scope":"once"}');
  }));

it('rejects expired, wrong-action, wrong-generation and wrong-provider decisions', () =>
  scoped(async () => {
    await pause();
    await expect(
      storage.reserveResume(
        owner,
        'resp_one',
        resume({
          providerExecutionId: review.providerExecutionId,
        }),
        100,
      ),
    ).rejects.toThrow('Resume requires a new provider execution identity');
    for (const overrides of [
      { actionId: 'other' },
      { generationCreatedAt: 11 },
      { previousProviderExecutionId: 'other' },
    ]) {
      expect(await storage.reserveResume(owner, 'resp_one', resume(overrides), 100)).toEqual({
        ok: false,
        code: 'resume_conflict',
      });
    }
    expect(await storage.reserveResume(owner, 'resp_one', resume(), review.expiresAt)).toEqual({
      ok: false,
      code: 'resume_conflict',
    });
    expect((await storage.read(owner, 'resp_one'))?.resume).toBeUndefined();
  }));

it('keeps review and resume mutations owner- and tenant-scoped', () =>
  scoped(async () => {
    await pause();
    for (const stranger of [
      { ...owner, userId: 'other' },
      { ...owner, tenantId: 'other' },
    ]) {
      await tenantStorage.run({ tenantId: stranger.tenantId }, async () => {
        expect(await storage.publishReview(stranger, 'resp_one', 2, 10, review, '{}')).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(await storage.reserveResume(stranger, 'resp_one', resume(), 100)).toEqual({
          ok: false,
          code: 'resume_conflict',
        });
        expect(
          await storage.admitResume(
            stranger,
            'resp_one',
            'intent-one',
            10,
            'provider-two',
            '{}',
            100,
          ),
        ).toEqual({ ok: false, code: 'response_conflict' });
      });
    }
    expect((await storage.read(owner, 'resp_one'))?.revision).toBe(2);
  }));

it('fences late pause callbacks and allows only the admitted next segment to pause again', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    expect(await storage.publishReview(owner, 'resp_one', 3, 10, review, '{}')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(
      await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'wrong-provider', '{}', 101),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      (await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 101))
        .ok,
    ).toBe(true);
    const admitted = (await storage.read(owner, 'resp_one'))!;
    expect(admitted).toMatchObject({
      status: 'in_progress',
      revision: 4,
      resume: { state: 'admitted', admittedAt: 101 },
    });
    expect(
      (
        await storage.admitResume(
          owner,
          'resp_one',
          'intent-one',
          10,
          'provider-two',
          'ignored',
          102,
        )
      ).ok,
    ).toBe(true);
    expect(await storage.publishReview(owner, 'resp_one', 4, 10, review, '{}')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    const next = { ...review, actionId: 'action-two', providerExecutionId: 'provider-two' };
    expect((await storage.publishReview(owner, 'resp_one', 4, 10, next, '{}')).ok).toBe(true);
    expect(await storage.read(owner, 'resp_one')).toMatchObject({
      status: 'requires_action',
      review: next,
      revision: 5,
    });
    expect((await storage.read(owner, 'resp_one'))?.resume).toBeUndefined();
    expect(await storage.reserveResume(owner, 'resp_one', resume(), 103)).toEqual({
      ok: false,
      code: 'resume_conflict',
    });
  }));

it('cancellation prevents a reserved decision from admitting execution', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    await storage.requestCancellation(owner, 'resp_one', 101);
    expect(
      await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 102),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.publishReview(owner, 'resp_one', 3, 10, review, '{}')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.reserveResume(owner, 'resp_one', resume(), 103)).toMatchObject({
      ok: true,
      replayed: true,
      record: { status: 'requires_action', cancellationRequestedAt: 101 },
    });
  }));

it('does not admit or repause terminal responses but retains the identical decision receipt', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    expect(
      (await storage.publish(owner, 'resp_one', 3, { status: 'cancelled', responseJSON: '{}' })).ok,
    ).toBe(true);
    expect(
      await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 102),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.publishReview(owner, 'resp_one', 4, 10, review, '{}')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.reserveResume(owner, 'resp_one', resume(), 103)).toMatchObject({
      ok: true,
      replayed: true,
      record: { status: 'cancelled', revision: 4 },
    });
  }));

const outcome: ResponseTerminalReceipt = {
  generationCreatedAt: 10,
  providerExecutionId: 'provider-one',
  ownerId: 'worker-one',
  status: 'completed',
  responseJSON: '{"final":"private until cleanup"}',
  checkpointNamespace: 'owned-checkpoint',
};

it('prepares one immutable result privately and moves it atomically into the confirmed journal', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      generationCreatedAt: 10,
      responseJSON: '{"progress":true}',
    });
    if (!running.ok) throw new Error('Publication failed');
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        storage.prepareTerminal(owner, 'resp_one', { execution: running.record }, outcome),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const prepared = (await storage.read(owner, 'resp_one'))!;
    expect(prepared).toMatchObject({
      status: 'in_progress',
      responseJSON: '{"progress":true}',
      preparedTerminal: outcome,
    });
    expect(prepared.pendingTerminal).toBeUndefined();
    expect(
      await storage.prepareTerminal(
        owner,
        'resp_one',
        { execution: prepared },
        {
          ...outcome,
          responseJSON: 'different candidate',
        },
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.publish(owner, 'resp_one', prepared.revision, {
        status: 'completed',
        responseJSON: 'unconfirmed',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.stageTerminal(owner, 'resp_one', { execution: prepared }, outcome),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const promoted = await storage.stageTerminal(
      owner,
      'resp_one',
      { execution: prepared },
      outcome,
      { receipt: outcome },
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) throw new Error('Promotion failed');
    expect(promoted.record.preparedTerminal).toBeUndefined();
    expect(promoted.record.pendingTerminal).toEqual(outcome);
    expect(
      (await storage.finishTerminal(owner, 'resp_one', promoted.record.revision, outcome)).ok,
    ).toBe(true);
  }));

it('fences a racing Stop when promoting a prepared success without projection-revision retries', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      generationCreatedAt: 10,
      responseJSON: '{}',
    });
    if (!running.ok) throw new Error('Publication failed');
    const prepared = await storage.prepareTerminal(
      owner,
      'resp_one',
      { execution: running.record },
      outcome,
    );
    if (!prepared.ok) throw new Error('Preparation failed');
    const stopped = (await storage.requestCancellation(owner, 'resp_one', 100))!;
    expect(
      await storage.stageTerminal(owner, 'resp_one', { execution: prepared.record }, outcome, {
        receipt: outcome,
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const cancelled = {
      ...outcome,
      status: 'cancelled' as const,
      responseJSON: '{"cancelled":true}',
    };
    const promoted = await storage.stageTerminal(
      owner,
      'resp_one',
      { execution: stopped },
      cancelled,
      { receipt: outcome, cancellationRequestedAt: stopped.cancellationRequestedAt },
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) throw new Error('Promotion failed');
    expect(
      (await storage.finishTerminal(owner, 'resp_one', promoted.record.revision, cancelled)).ok,
    ).toBe(true);
    expect((await storage.read(owner, 'resp_one'))?.status).toBe('cancelled');
  }));

it('retains only a prepared checkpoint binding for expired cleanup and erases the entire candidate', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      generationCreatedAt: 10,
      responseJSON: '{}',
    });
    if (!running.ok) throw new Error('Publication failed');
    await storage.prepareTerminal(owner, 'resp_one', { execution: running.record }, outcome);
    await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(0));
    const identity = await storage.readCleanupIdentity(owner, 'resp_one');
    expect(identity).toMatchObject({
      retirement: 'expired',
      checkpointNamespace: outcome.checkpointNamespace,
    });
    expect(JSON.stringify(identity)).not.toContain('private until cleanup');
    await closeResponseScopes(mongoose, owner);
    await eraseResponseRecords(mongoose, owner);
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
  }));

it('stages an initial terminal receipt without requiring a review or resume', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      responseJSON: '{}',
      generationCreatedAt: 10,
    });
    expect((await storage.stageTerminal(owner, 'resp_one', 1, outcome)).ok).toBe(true);
    expect((await storage.finishTerminal(owner, 'resp_one', 2, outcome)).ok).toBe(true);
  }));

it('stages the admitted provider terminal receipt without requiring another review', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 101);
    const current = { ...outcome, providerExecutionId: 'provider-two' };
    expect((await storage.stageTerminal(owner, 'resp_one', 4, current)).ok).toBe(true);
    expect((await storage.finishTerminal(owner, 'resp_one', 5, current)).ok).toBe(true);
  }));

it('keeps a paused response behind resume admission even with its latest revision', () =>
  scoped(async () => {
    await pause();
    expect(
      await storage.publish(owner, 'resp_one', 2, {
        status: 'in_progress',
        responseJSON: '{}',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.read(owner, 'resp_one')).toMatchObject({
      status: 'requires_action',
      revision: 2,
      review,
    });
    expect((await storage.reserveResume(owner, 'resp_one', resume(), 100)).ok).toBe(true);
    expect(
      (await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 101))
        .ok,
    ).toBe(true);
  }));

it('rejects terminal receipts from an earlier segment after resume admission and a later pause', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 101);
    expect(await storage.stageTerminal(owner, 'resp_one', 4, outcome)).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    const next = { ...review, actionId: 'action-two', providerExecutionId: 'provider-two' };
    await storage.publishReview(owner, 'resp_one', 4, 10, next, '{}');
    expect(await storage.stageTerminal(owner, 'resp_one', 5, outcome)).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    const current = { ...outcome, providerExecutionId: 'provider-two' };
    expect((await storage.stageTerminal(owner, 'resp_one', 5, current)).ok).toBe(true);
    expect((await storage.finishTerminal(owner, 'resp_one', 6, current)).ok).toBe(true);
  }));

it('durably stages one immutable terminal receipt while keeping its output private', () =>
  scoped(async () => {
    await pause();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => storage.stageTerminal(owner, 'resp_one', 2, outcome)),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const record = (await storage.read(owner, 'resp_one'))!;
    expect(record).toMatchObject({
      status: 'requires_action',
      revision: 3,
      pendingTerminal: outcome,
    });
    expect(record.responseJSON).not.toContain('private until cleanup');
    expect(
      await storage.stageTerminal(owner, 'resp_one', 3, { ...outcome, status: 'failed' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.stageTerminal(owner, 'resp_one', 3, { ...outcome, ownerId: 'other-worker' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('prevents Stop, review and resume writes from overwriting a staged terminal outcome', () =>
  scoped(async () => {
    await pause();
    await storage.stageTerminal(owner, 'resp_one', 2, outcome);
    expect(
      await storage.publish(owner, 'resp_one', 3, {
        status: 'cancelled',
        responseJSON: 'overwrite',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.publishReview(owner, 'resp_one', 3, 10, review, '{}')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.reserveResume(owner, 'resp_one', resume(), 100)).toEqual({
      ok: false,
      code: 'resume_conflict',
    });
    expect(
      (await storage.requestCancellation(owner, 'resp_one', 100))?.cancellationRequestedAt,
    ).toBeUndefined();
  }));

it('publishes only the exact saved receipt and removes it atomically with terminal publication', () =>
  scoped(async () => {
    await pause();
    await storage.stageTerminal(owner, 'resp_one', 2, outcome);
    for (const changed of [
      { ownerId: 'other' },
      { checkpointNamespace: 'other' },
      { checkpointConfigJSON: 'other' },
      { generationCreatedAt: 11 },
      { responseJSON: 'other' },
      { providerExecutionId: 'other' },
    ]) {
      expect(
        await storage.finishTerminal(owner, 'resp_one', 3, { ...outcome, ...changed }),
      ).toEqual({ ok: false, code: 'response_conflict' });
    }
    expect((await storage.finishTerminal(owner, 'resp_one', 3, outcome)).ok).toBe(true);
    const record = (await storage.read(owner, 'resp_one'))!;
    expect(record).toMatchObject({
      status: 'completed',
      responseJSON: outcome.responseJSON,
      revision: 4,
    });
    expect(record.pendingTerminal).toBeUndefined();
    expect(await storage.stageTerminal(owner, 'resp_one', 4, outcome)).toEqual({
      ok: false,
      code: 'response_conflict',
    });
  }));

it('does not stage or publish another user or tenant terminal result', () =>
  scoped(async () => {
    await pause();
    await storage.stageTerminal(owner, 'resp_one', 2, outcome);
    for (const stranger of [
      { ...owner, userId: 'other' },
      { ...owner, tenantId: 'other' },
    ]) {
      await tenantStorage.run({ tenantId: stranger.tenantId }, async () => {
        expect(await storage.stageTerminal(stranger, 'resp_one', 3, outcome)).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(await storage.finishTerminal(stranger, 'resp_one', 3, outcome)).toEqual({
          ok: false,
          code: 'response_conflict',
        });
      });
    }
    expect((await storage.read(owner, 'resp_one'))?.revision).toBe(3);
  }));

it('never initializes a closed owner or conversation scope back to open', () =>
  scoped(async () => {
    await closeResponseScopes(mongoose, owner);
    expect(await storage.reserve(reservation())).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    await mongoose.models.ResponseScope.deleteMany({});
    await closeResponseScopes(mongoose, owner, ['conversation-one']);
    expect(await storage.reserve(reservation())).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
  }));

it('retains the cleanup journal but cannot replay a closed conversation through a fresh continuation', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await Promise.all([
      closeResponseScopes(mongoose, owner, ['conversation-one']),
      closeResponseScopes(mongoose, owner, ['conversation-one']),
    ]);
    expect(await storage.read(owner, 'resp_one')).toBeNull();
    expect(await storage.readCleanupIdentity(owner, 'resp_one')).toMatchObject({
      responseId: 'resp_one',
      retirement: 'conversation_deleted',
    });
    expect(await storage.reserve(reservation({ conversationId: 'fresh-conversation' }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
  }));

it('does not close another tenant or owner and retains only hashed scope metadata', () =>
  scoped(async () => {
    await closeResponseScopes(mongoose, { ...owner, tenantId: 'other-tenant' });
    await closeResponseScopes(mongoose, { ...owner, userId: 'other-owner' });
    expect((await storage.reserve(reservation())).ok).toBe(true);
    const anchors = JSON.stringify(await mongoose.models.ResponseScope.find({}).lean());
    expect(anchors).not.toContain(owner.userId);
    expect(anchors).not.toContain(owner.tenantId);
    expect(anchors).not.toContain('Hello');
  }));

it.each(['owner', 'conversation', 'retention'])(
  'waits for admitted insertion before %s erasure sweeps records',
  (kind) =>
    scoped(async () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const collection = mongoose.models.StoredResponse.collection;
      const insert = collection.insertOne.bind(collection);
      const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
        entered();
        await gate;
        return insert(...args);
      });
      const pending = storage.reserve(reservation());
      await started;
      let erased = false;
      const intent =
        kind === 'retention'
          ? createResponseRetention(mongoose)(owner, 'conversation-one', new Date(Date.now() - 1))
          : closeResponseScopes(
              mongoose,
              owner,
              kind === 'conversation' ? ['conversation-one'] : undefined,
            );
      const erasure = intent.then(async () => {
        await mongoose.models.StoredResponse.deleteMany({ userId: owner.userId });
        erased = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(erased).toBe(false);
      } finally {
        release();
        paused.mockRestore();
      }
      expect((await pending).ok).toBe(true);
      await erasure;
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
      expect(await storage.reserve(reservation())).toEqual({
        ok: false,
        code: 'response_unavailable',
      });
    }),
);

it.each(['owner_deleted', 'conversation_deleted', 'expired'] as const)(
  'keeps %s cleanup authority after private row removal without inventing a deadline',
  (retirement) =>
    scoped(async () => {
      await storage.reserve(reservation());
      await mongoose.models.StoredResponse.updateOne(
        { responseId: 'resp_one' },
        {
          $set: {
            generationCreatedAt: 42,
            pendingTerminal: {
              generationCreatedAt: 42,
              providerExecutionId: 'initial-provider',
              status: 'failed',
              responseJSON: '{"private":"answer"}',
              checkpointNamespace: 'checkpoint-one',
              checkpointConfigJSON: '{"saver":"pinned"}',
            },
          },
        },
      );
      if (retirement === 'expired')
        await createResponseRetention(mongoose)(
          owner,
          'conversation-one',
          new Date(Date.now() - 1000),
        );
      else
        await closeResponseScopes(
          mongoose,
          owner,
          retirement === 'conversation_deleted' ? ['conversation-one'] : undefined,
        );
      const identity = await storage.readCleanupIdentity(owner, 'resp_one');
      expect(identity).toMatchObject({
        retirement,
        generationCreatedAt: 42,
        checkpointNamespace: 'checkpoint-one',
        checkpointConfigJSON: '{"saver":"pinned"}',
        requiresCheckpointCleanup: true,
      });
      expect(identity).not.toHaveProperty('requestJSON');
      expect(identity).not.toHaveProperty('responseJSON');
      expect(identity).not.toHaveProperty('pendingTerminal');
      if (retirement !== 'expired') expect(identity?.expiredAt).toBeUndefined();
      await mongoose.models.StoredResponse.deleteOne({ responseId: 'resp_one' });
      expect(await storage.readCleanupIdentity(owner, 'resp_one', identity!)).toEqual(identity);
      expect(
        await storage.readCleanupIdentity(owner, 'resp_one', {
          ...identity!,
          userId: 'another-owner',
        }),
      ).toBeNull();
      expect(
        await storage.readCleanupIdentity(owner, 'resp_one', {
          ...identity!,
          tenantId: 'another-tenant',
        }),
      ).toBeNull();
      expect(
        await storage.readCleanupIdentity(owner, 'resp_one', {
          ...identity!,
          responseId: 'another-response',
        }),
      ).toBeNull();
    }),
);

it('requires checkpoint cleanup for an initial staged terminal without a review or retained identity', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      generationCreatedAt: 42,
      responseJSON: '{}',
    });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    const staged = await storage.stageTerminal(owner, 'resp_one', running.record.revision, {
      generationCreatedAt: 42,
      providerExecutionId: 'initial-provider',
      status: 'failed',
      responseJSON: '{}',
      checkpointNamespace: 'checkpoint-one',
      checkpointConfigJSON: '{"saver":"initial"}',
    });
    expect(staged.ok).toBe(true);
    expect(await storage.readCleanupIdentity(owner, 'resp_one')).toMatchObject({
      checkpointNamespace: 'checkpoint-one',
      checkpointConfigJSON: '{"saver":"initial"}',
      requiresCheckpointCleanup: true,
    });
  }));

it.each([
  { userId: 'another-owner' },
  { tenantId: 'another-tenant' },
  { responseId: 'another-response' },
  { conversationId: 'another-conversation' },
  { agentId: 'another-agent' },
  { generationCreatedAt: 43 },
])('never mixes retained checkpoint metadata from a different identity: %p', (changed) =>
  scoped(async () => {
    await storage.reserve(reservation());
    await mongoose.models.StoredResponse.updateOne(
      { responseId: 'resp_one' },
      {
        $set: { generationCreatedAt: 42 },
      },
    );
    const identity = await storage.readCleanupIdentity(owner, 'resp_one');
    expect(
      await storage.readCleanupIdentity(owner, 'resp_one', {
        ...identity!,
        ...changed,
        checkpointNamespace: 'wrong-checkpoint',
        checkpointConfigJSON: 'wrong-config',
        requiresCheckpointCleanup: true,
      }),
    ).toMatchObject({
      checkpointNamespace: undefined,
      checkpointConfigJSON: undefined,
      requiresCheckpointCleanup: false,
    });
  }),
);

it('rejects a missing row with no retirement proof even when retained data claims expiry', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const retained = await storage.readCleanupIdentity(owner, 'resp_one');
    await mongoose.models.StoredResponse.deleteOne({ responseId: 'resp_one' });
    expect(
      await storage.readCleanupIdentity(owner, 'resp_one', {
        ...retained!,
        expiredAt: new Date(Date.now() - 1),
        retirement: 'expired',
      }),
    ).toBeNull();
    await closeResponseScopes(mongoose, { ...owner, userId: 'another-owner' });
    await closeResponseScopes(mongoose, owner, ['another-conversation']);
    expect(await storage.readCleanupIdentity(owner, 'resp_one', retained!)).toBeNull();
  }));

it('recovers and erases all legacy partitions inside an ordinary tenant request', async () => {
  createModels(mongoose);
  const tenants = ['tenant-a', 'tenant-b', undefined, '', null];
  await runAsSystem(async () => {
    for (const [index, tenantId] of tenants.entries()) {
      const responseId = `legacy-${index}`;
      // Distinct request keys let all tenantless legacy spellings coexist.
      await storage.reserve(
        reservation({ responseId, requestKey: responseId, tenantId: tenantId || undefined }),
      );
      if (tenantId !== undefined)
        await mongoose.models.StoredResponse.collection.updateOne(
          { responseId },
          { $set: { tenantId } },
        );
    }
    await storage.reserve(reservation({ userId: 'another-owner', responseId: 'unrelated-owner' }));
    await storage.reserve(
      reservation({
        conversationId: 'another-conversation',
        responseId: 'unrelated-conversation',
        requestKey: 'unrelated-conversation',
      }),
    );
  });
  const methods = createConversationMethods(mongoose, {
    getMessages: jest.fn(async () => []),
    deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
  });
  await scoped(async () => {
    await methods.deleteConvos(owner.userId, { conversationId: 'conversation-one' });
    await methods.deleteConvos(
      owner.userId,
      { conversationId: 'conversation-one' },
      { allowEmpty: true },
    );
  });
  await runAsSystem(async () => {
    const remaining = await mongoose.models.StoredResponse.find({}).select('responseId').lean();
    expect(remaining.map((row) => row.responseId).sort()).toEqual([
      'unrelated-conversation',
      'unrelated-owner',
    ]);
    for (const tenantId of ['tenant-a', 'tenant-b', undefined])
      expect(
        await storage.reserve(reservation({ tenantId, requestKey: `late-${tenantId}` })),
      ).toEqual({ ok: false, code: 'response_unavailable' });
  });
});

it('keeps incomplete staged checkpoint bindings retryable instead of mixing older settings', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await mongoose.models.StoredResponse.updateOne(
      { responseId: 'resp_one' },
      {
        $set: {
          generationCreatedAt: 42,
          review: {
            actionId: 'old-review',
            providerExecutionId: 'old-provider',
            expiresAt: Date.now() + 1000,
            partialResponseJSON: '{}',
            checkpointConfigJSON: 'old-config',
          },
          pendingTerminal: {
            generationCreatedAt: 42,
            providerExecutionId: 'new-provider',
            status: 'failed',
            responseJSON: '{}',
            checkpointNamespace: 'new-checkpoint',
          },
        },
      },
    );
    const retained = {
      ...owner,
      responseId: 'resp_one',
      agentId: 'agent-one',
      conversationId: 'conversation-one',
      generationCreatedAt: 42,
      checkpointNamespace: 'old-checkpoint',
      checkpointConfigJSON: 'retained-config',
    };
    expect(await storage.readCleanupIdentity(owner, 'resp_one', retained)).toMatchObject({
      checkpointNamespace: 'new-checkpoint',
      checkpointConfigJSON: undefined,
      requiresCheckpointCleanup: true,
    });
  }));

it('propagates cleanup lookup outages instead of treating retained metadata as authority', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const retained = await storage.readCleanupIdentity(owner, 'resp_one');
    jest
      .spyOn(mongoose.models.StoredResponse.collection, 'findOne')
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(storage.readCleanupIdentity(owner, 'resp_one', retained!)).rejects.toThrow(
      'database unavailable',
    );
  }));

it.each(['session', 'commit'] as const)(
  'retries reservation after a transient capability %s failure',
  (failure) =>
    scoped(async () => {
      const fresh = createResponseStorage(mongoose);
      if (failure === 'session')
        jest
          .spyOn(mongoose, 'startSession')
          .mockRejectedValueOnce(new Error('transient probe outage'));
      else {
        const session = await mongoose.startSession();
        jest
          .spyOn(session, 'commitTransaction')
          .mockRejectedValueOnce(new Error('transient probe outage'));
        jest.spyOn(mongoose, 'startSession').mockResolvedValueOnce(session);
      }
      await expect(fresh.reserve(reservation())).rejects.toThrow('transient probe outage');
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
      expect(await mongoose.models.ResponseScope.countDocuments({})).toBe(0);
      expect(await fresh.reserve(reservation())).toMatchObject({ ok: true, replayed: false });
    }),
);

it('keeps response-bound conversation identity immutable without cancelling its work', () =>
  scoped(async () => {
    createModels(mongoose);
    const methods = createConversationMethods(mongoose, {
      getMessages: jest.fn(async () => []),
      deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    });
    await methods.saveConvo(
      { userId: owner.userId },
      { conversationId: 'immutable-source', endpoint: 'agents' },
    );
    await storage.reserve(reservation({ conversationId: 'immutable-source' }));
    expect(
      await methods.saveConvo(
        { userId: owner.userId },
        {
          conversationId: 'immutable-source',
          newConversationId: 'replacement',
          endpoint: 'agents',
        },
      ),
    ).toEqual({ message: 'Conversation ID cannot be replaced after persistence.' });
    expect(
      await mongoose.models.Conversation.exists({
        user: owner.userId,
        conversationId: 'immutable-source',
      }),
    ).not.toBeNull();
    expect(
      await mongoose.models.Conversation.exists({
        user: owner.userId,
        conversationId: 'replacement',
      }),
    ).toBeNull();
    expect(await storage.read(owner, 'resp_one')).not.toHaveProperty('cancellationRequestedAt');
    expect(
      await storage.reserve(
        reservation({
          responseId: 'another',
          requestKey: 'another',
          conversationId: 'immutable-source',
        }),
      ),
    ).toMatchObject({ ok: true });
  }));

it('fences an empty old identity and propagates retention to its replacement before admitting work', () =>
  scoped(async () => {
    createModels(mongoose);
    const methods = createConversationMethods(mongoose, {
      getMessages: jest.fn(async () => []),
      deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    });
    const expiredAt = new Date(Date.now() + 60_000);
    expect(
      await methods.saveConvo(
        { userId: owner.userId, expiredAt },
        {
          conversationId: 'initial-source',
          newConversationId: 'replacement',
          endpoint: 'agents',
        },
      ),
    ).toMatchObject({ conversationId: 'replacement' });
    expect(await storage.reserve(reservation({ conversationId: 'initial-source' }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    expect(await storage.reserve(reservation({ conversationId: 'replacement' }))).toMatchObject({
      ok: true,
      record: { expiredAt },
    });
    await methods.deleteConvos(owner.userId, { conversationId: 'replacement' });
    expect(await storage.read(owner, 'resp_one')).toBeNull();
  }));

it('serializes ID replacement with a reservation already inserting private data', () =>
  scoped(async () => {
    createModels(mongoose);
    const methods = createConversationMethods(mongoose, {
      getMessages: jest.fn(async () => []),
      deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.StoredResponse.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const pending = storage.reserve(reservation({ conversationId: 'racing-source' }));
    await started;
    let settled = false;
    const replacement = methods
      .saveConvo(
        { userId: owner.userId },
        {
          conversationId: 'racing-source',
          newConversationId: 'replacement',
          endpoint: 'agents',
        },
      )
      .then((value) => {
        settled = true;
        return value;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    expect(await pending).toMatchObject({ ok: true });
    expect(await replacement).toEqual({
      message: 'Conversation ID cannot be replaced after persistence.',
    });
    expect(await storage.read(owner, 'resp_one')).toMatchObject({
      conversationId: 'racing-source',
    });
    expect(
      await mongoose.models.Conversation.exists({ conversationId: 'racing-source' }),
    ).toBeNull();
  }));

it.each(['transient_read', 'missing_canary', 'failed_canary_create'] as const)(
  'classifies capability probe errors without caching an outage: %s',
  (kind) =>
    scoped(async () => {
      const db = mongoose.connection.db!;
      const probe = db.collection('__transaction_test__');
      const collection = db.collection.bind(db);
      jest
        .spyOn(db, 'collection')
        .mockImplementation((name, options) =>
          name === '__transaction_test__' ? probe : collection(name, options),
        );
      const failure =
        kind === 'transient_read'
          ? new Error('transient database read outage')
          : new mongoose.mongo.MongoServerError({
              code: 303,
              message: 'Feature not supported: non-existent collection in transaction',
            });
      const read = jest.spyOn(probe, 'findOne').mockRejectedValueOnce(failure);
      if (kind === 'failed_canary_create')
        jest
          .spyOn(db, 'createCollection')
          .mockRejectedValueOnce(new Error('canary creation denied'));
      const fresh = createResponseStorage(mongoose);
      if (kind === 'missing_canary') {
        expect(await fresh.reserve(reservation())).toMatchObject({ ok: true });
        expect(read).toHaveBeenCalledTimes(2);
      } else {
        await expect(fresh.reserve(reservation())).rejects.toThrow(
          kind === 'transient_read' ? 'transient database read outage' : 'canary creation denied',
        );
        expect(await fresh.reserve(reservation())).toMatchObject({ ok: true });
      }
    }),
);

it('never renames a source conversation inserted after initial assignment checked absence', () =>
  scoped(async () => {
    createModels(mongoose);
    const sourceId = 'late-initial-source';
    const collection = mongoose.models.Conversation.collection;
    const find = collection.findOne.bind(collection);
    let inserted = false;
    jest.spyOn(collection, 'findOne').mockImplementation(async (...args) => {
      const found = await find(...args);
      if (!inserted && args[0]?.conversationId === sourceId && found == null) {
        inserted = true;
        await collection.insertOne({
          user: owner.userId,
          tenantId: owner.tenantId,
          conversationId: sourceId,
          endpoint: 'agents',
          title: 'Concurrent source',
        });
      }
      return found;
    });
    const methods = createConversationMethods(mongoose, {
      getMessages: jest.fn(async () => []),
      deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    });
    expect(
      await methods.saveConvo(
        { userId: owner.userId },
        {
          conversationId: sourceId,
          newConversationId: 'initial-destination',
          endpoint: 'agents',
        },
      ),
    ).toMatchObject({ conversationId: 'initial-destination' });
    expect(
      await mongoose.models.Conversation.findOne({ conversationId: sourceId }).lean(),
    ).toMatchObject({ title: 'Concurrent source' });
  }));

it('retries a failed initial ID assignment without reopening its unused source scope', () =>
  scoped(async () => {
    createModels(mongoose);
    const methods = createConversationMethods(mongoose, {
      getMessages: jest.fn(async () => []),
      deleteMessages: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    });
    jest
      .spyOn(mongoose.models.Conversation.collection, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('parent write unavailable'));
    const input = {
      conversationId: 'failed-initial-source',
      newConversationId: 'retry-initial-destination',
      endpoint: 'agents',
    };
    expect(await methods.saveConvo({ userId: owner.userId }, input)).toEqual({
      message: 'Error saving conversation',
    });
    expect(await storage.reserve(reservation({ conversationId: input.conversationId }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    expect(await methods.saveConvo({ userId: owner.userId }, input)).toMatchObject({
      conversationId: input.newConversationId,
    });
    expect(
      await storage.reserve(reservation({ conversationId: input.newConversationId })),
    ).toMatchObject({ ok: true });
  }));

it('stages one exact execution receipt independently of repeated projection revisions', () =>
  scoped(async () => {
    await storage.reserve(reservation({ sourceKeyId: 'original-key' }));
    const running = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      generationCreatedAt: 10,
      responseJSON: '{}',
    });
    if (!running.ok) throw new Error('Publication failed');
    for (let i = 0; i < 30; i++) {
      const current = (await storage.read(owner, 'resp_one'))!;
      expect(
        (
          await storage.publish(owner, 'resp_one', current.revision, {
            status: 'in_progress',
            responseJSON: JSON.stringify({ progress: i }),
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await storage.stageTerminal(owner, 'resp_one', running.record.revision, outcome),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        storage.stageTerminal(owner, 'resp_one', { execution: running.record }, outcome),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const staged = (await storage.read(owner, 'resp_one'))!;
    expect(staged.pendingTerminal).toEqual(outcome);
    expect(staged.revision).toBe(running.record.revision + 31);
    expect(
      await storage.stageTerminal(
        owner,
        'resp_one',
        { execution: running.record },
        {
          ...outcome,
          ownerId: 'another-worker',
        },
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect((await storage.finishTerminal(owner, 'resp_one', staged.revision, outcome)).ok).toBe(
      true,
    );
  }));

it.each(['agentId', 'conversationId', 'sourceKeyId', 'generationCreatedAt'] as const)(
  'does not stage a retained execution with a mismatched %s',
  (field) =>
    scoped(async () => {
      await storage.reserve(reservation({ sourceKeyId: 'original-key' }));
      const running = await storage.publish(owner, 'resp_one', 0, {
        status: 'in_progress',
        generationCreatedAt: 10,
        responseJSON: '{}',
      });
      if (!running.ok) throw new Error('Publication failed');
      const execution = {
        ...running.record,
        [field]: field === 'generationCreatedAt' ? 11 : 'other',
      };
      expect(await storage.stageTerminal(owner, 'resp_one', { execution }, outcome)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect((await storage.read(owner, 'resp_one'))?.pendingTerminal).toBeUndefined();
    }),
);

it('matches the complete reviewed and resumed execution binding rather than its projection', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 101);
    const retained = (await storage.read(owner, 'resp_one'))!;
    const receipt = { ...outcome, providerExecutionId: 'provider-two' };
    for (const execution of [
      { ...retained, review: undefined },
      { ...retained, review: { ...retained.review!, checkpointId: 'different' } },
      { ...retained, resume: { ...retained.resume!, fingerprint: 'different' } },
      { ...retained, resume: { ...retained.resume!, state: 'reserved' as const } },
    ])
      expect(await storage.stageTerminal(owner, 'resp_one', { execution }, receipt)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
    const current = await storage.publish(owner, 'resp_one', retained.revision, {
      status: 'in_progress',
      responseJSON: '{"projection":"new"}',
    });
    expect(current.ok).toBe(true);
    expect(
      (await storage.stageTerminal(owner, 'resp_one', { execution: retained }, receipt)).ok,
    ).toBe(true);
  }));

async function runningForReview() {
  await storage.reserve(reservation({ sourceKeyId: 'original-key' }));
  const running = await storage.publish(owner, 'resp_one', 0, {
    status: 'in_progress',
    generationCreatedAt: 10,
    responseJSON: '{}',
  });
  if (!running.ok) throw new Error('Publication failed');
  return running.record;
}

it('publishes one immutable pause independently of polling before and after publication', () =>
  scoped(async () => {
    const running = await runningForReview();
    for (let i = 0; i < 30; i++) {
      const current = (await storage.read(owner, 'resp_one'))!;
      expect(
        (
          await storage.publish(owner, 'resp_one', current.revision, {
            status: 'in_progress',
            responseJSON: JSON.stringify({ progress: i }),
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await storage.publishReview(owner, 'resp_one', running.revision, 10, review, '{}'),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        storage.publishReview(owner, 'resp_one', { execution: running }, 10, review, '{}'),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const paused = (await storage.read(owner, 'resp_one'))!;
    expect(paused.review).toEqual(review);
    expect(paused.revision).toBe(running.revision + 31);
    const projected = await storage.publish(owner, 'resp_one', paused.revision, {
      status: 'requires_action',
      responseJSON: '{"projection":"new"}',
    });
    if (!projected.ok) throw new Error('Projection failed');
    for (const execution of [running, projected.record]) {
      expect(
        (await storage.publishReview(owner, 'resp_one', { execution }, 10, review, '{}')).ok,
      ).toBe(true);
      expect(
        await storage.publishReview(
          owner,
          'resp_one',
          { execution },
          10,
          { ...review, partialResponseJSON: '{"changed":true}' },
          '{}',
        ),
      ).toEqual({ ok: false, code: 'response_conflict' });
    }
    const saved = (await storage.read(owner, 'resp_one'))!;
    expect(saved.revision).toBe(projected.record.revision);
    expect(saved.responseJSON).toBe('{"projection":"new"}');
    expect(saved.review).toEqual(review);
  }));

it.each(['agentId', 'conversationId', 'sourceKeyId', 'generationCreatedAt'] as const)(
  'rejects a pause from a mismatched %s',
  (field) =>
    scoped(async () => {
      const running = await runningForReview();
      const execution = { ...running, [field]: field === 'generationCreatedAt' ? 11 : 'other' };
      expect(
        await storage.publishReview(owner, 'resp_one', { execution }, 10, review, '{}'),
      ).toEqual({ ok: false, code: 'response_conflict' });
      expect((await storage.read(owner, 'resp_one'))?.review).toBeUndefined();
    }),
);

it('binds the next pause to the complete admitted resume identity', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, 'resp_one', resume(), 100);
    await storage.admitResume(owner, 'resp_one', 'intent-one', 10, 'provider-two', '{}', 101);
    const retained = (await storage.read(owner, 'resp_one'))!;
    const nextReview = {
      ...review,
      actionId: 'second-action',
      providerExecutionId: 'provider-two',
    };
    for (const execution of [
      { ...retained, review: undefined },
      { ...retained, review: { ...retained.review!, checkpointId: 'different' } },
      { ...retained, resume: { ...retained.resume!, fingerprint: 'different' } },
      { ...retained, resume: { ...retained.resume!, state: 'reserved' as const } },
    ])
      expect(
        await storage.publishReview(owner, 'resp_one', { execution }, 10, nextReview, '{}'),
      ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      (
        await storage.publishReview(
          owner,
          'resp_one',
          { execution: retained },
          10,
          nextReview,
          '{}',
        )
      ).ok,
    ).toBe(true);
    expect(await storage.read(owner, 'resp_one')).toMatchObject({ review: nextReview });
    expect((await storage.read(owner, 'resp_one'))?.resume).toBeUndefined();
  }));

it.each(['cancelled', 'terminal', 'erased'] as const)(
  'does not publish a pause after %s authority wins',
  (failure) =>
    scoped(async () => {
      const running = await runningForReview();
      if (failure === 'cancelled') await storage.requestCancellation(owner, 'resp_one', Date.now());
      if (failure === 'terminal')
        await storage.stageTerminal(owner, 'resp_one', { execution: running }, outcome);
      if (failure === 'erased')
        await mongoose.models.StoredResponse.deleteOne({ responseId: 'resp_one' });
      expect(
        await storage.publishReview(owner, 'resp_one', { execution: running }, 10, review, '{}'),
      ).toEqual({ ok: false, code: 'response_conflict' });
      expect((await storage.read(owner, 'resp_one'))?.review).toBeUndefined();
    }),
);

it.each(['live', 'owner_deleted', 'conversation_deleted', 'expired'] as const)(
  'supplements an unpublished generation only under durable retirement proof: %s',
  (reason) =>
    scoped(async () => {
      await storage.reserve(reservation());
      const retained = {
        ...owner,
        responseId: 'resp_one',
        agentId: 'agent-one',
        conversationId: 'conversation-one',
        generationCreatedAt: 42,
        checkpointNamespace: 'owned-checkpoint',
        checkpointConfigJSON: 'pinned-settings',
      };
      if (reason === 'expired')
        await createResponseRetention(mongoose)(
          owner,
          'conversation-one',
          new Date(Date.now() - 1000),
        );
      else if (reason !== 'live')
        await closeResponseScopes(
          mongoose,
          owner,
          reason === 'conversation_deleted' ? ['conversation-one'] : undefined,
        );
      const identity = await storage.readCleanupIdentity(owner, 'resp_one', retained);
      expect(identity).toMatchObject({
        generationCreatedAt: reason === 'live' ? undefined : 42,
        retirement: reason === 'live' ? undefined : reason,
        checkpointNamespace: reason === 'live' ? undefined : 'owned-checkpoint',
      });
      if (reason !== 'live') {
        const wrong = await storage.readCleanupIdentity(owner, 'resp_one', {
          ...retained,
          agentId: 'wrong-agent',
        });
        expect(wrong?.generationCreatedAt).toBeUndefined();
        expect(wrong?.checkpointNamespace).toBeUndefined();
        await mongoose.models.StoredResponse.updateOne(
          { responseId: 'resp_one' },
          { $set: { generationCreatedAt: 43 } },
        );
        expect(await storage.readCleanupIdentity(owner, 'resp_one', retained)).toMatchObject({
          generationCreatedAt: 43,
          checkpointNamespace: undefined,
        });
      }
    }),
);

it.each(['owner', 'conversation'] as const)(
  'fences both terminal phases and private reads in the %s anchor-close to cancellation gap',
  (kind) =>
    scoped(async () => {
      await storage.reserve(reservation());
      const enrolled = await storage.publish(owner, 'resp_one', 0, {
        status: 'in_progress',
        responseJSON: '{}',
        generationCreatedAt: 17,
      });
      if (!enrolled.ok) throw new Error('Enrollment failed');
      const outcome: ResponseTerminalReceipt = {
        generationCreatedAt: 17,
        providerExecutionId: 'provider-gap',
        status: 'completed',
        responseJSON: '{"private":"answer"}',
      };
      const prepared = await storage.prepareTerminal(
        owner,
        'resp_one',
        { execution: enrolled.record },
        outcome,
      );
      if (!prepared.ok) throw new Error('Preparation failed');
      const updateMany = jest
        .spyOn(mongoose.models.StoredResponse, 'updateMany')
        .mockImplementationOnce(() => {
          throw new Error('Erasure interrupted after durable anchor closure');
        });
      await expect(
        closeResponseScopes(
          mongoose,
          owner,
          kind === 'conversation' ? ['conversation-one'] : undefined,
        ),
      ).rejects.toThrow('Erasure interrupted');
      updateMany.mockRestore();
      expect(await storage.read(owner, 'resp_one')).toBeNull();
      expect(
        await storage.stageTerminal(owner, 'resp_one', { execution: prepared.record }, outcome, {
          receipt: outcome,
        }),
      ).toEqual({ ok: false, code: 'response_conflict' });
      const identity = await storage.readCleanupIdentity(owner, 'resp_one');
      expect(identity?.retirement).toBe(
        kind === 'owner' ? 'owner_deleted' : 'conversation_deleted',
      );
      expect(JSON.stringify(identity)).not.toContain('answer');
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
    }),
);

it('cannot finish a pending terminal receipt after scope closure even when physical erasure fails', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const enrolled = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      responseJSON: '{}',
      generationCreatedAt: 17,
    });
    if (!enrolled.ok) throw new Error('Enrollment failed');
    const outcome: ResponseTerminalReceipt = {
      generationCreatedAt: 17,
      providerExecutionId: 'provider-pending',
      status: 'completed',
      responseJSON: '{"private":"answer"}',
    };
    const pending = await storage.stageTerminal(
      owner,
      'resp_one',
      { execution: enrolled.record },
      outcome,
    );
    if (!pending.ok) throw new Error('Staging failed');
    await closeResponseScopes(mongoose, owner, ['conversation-one']);
    const erase = jest
      .spyOn(mongoose.models.StoredResponse, 'deleteMany')
      .mockImplementationOnce(() => {
        throw new Error('Physical erasure temporarily unavailable');
      });
    await expect(eraseResponseRecords(mongoose, owner)).rejects.toThrow('Physical erasure');
    erase.mockRestore();
    expect(
      await storage.finishTerminal(owner, 'resp_one', pending.record.revision, outcome),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.read(owner, 'resp_one')).toBeNull();
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
  }));

it('does not return an aborted attempt success when the transaction retries after scope closure', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const enrolled = await storage.publish(owner, 'resp_one', 0, {
      status: 'in_progress',
      responseJSON: '{}',
      generationCreatedAt: 17,
    });
    if (!enrolled.ok) throw new Error('Enrollment failed');
    const outcome: ResponseTerminalReceipt = {
      generationCreatedAt: 17,
      providerExecutionId: 'provider-retry',
      status: 'completed',
      responseJSON: '{"private":"answer"}',
    };
    const session = await mongoose.startSession();
    const start = jest.spyOn(mongoose, 'startSession').mockResolvedValueOnce(session);
    const commit = jest.spyOn(session, 'commitTransaction').mockImplementationOnce(async () => {
      await session.abortTransaction();
      await closeResponseScopes(mongoose, owner, ['conversation-one']);
      const error = new mongoose.mongo.MongoServerError({
        message: 'Retry transaction after closure',
      });
      error.addErrorLabel('TransientTransactionError');
      throw error;
    });
    try {
      expect(
        await storage.stageTerminal(owner, 'resp_one', { execution: enrolled.record }, outcome),
      ).toEqual({ ok: false, code: 'response_conflict' });
      expect(commit).toHaveBeenCalledTimes(2);
      expect(await storage.read(owner, 'resp_one')).toBeNull();
      const stored = await mongoose.models.StoredResponse.findOne({
        responseId: 'resp_one',
      }).lean();
      expect(stored).toMatchObject({ status: 'in_progress' });
      expect(stored).not.toHaveProperty('pendingTerminal');
    } finally {
      start.mockRestore();
      commit.mockRestore();
    }
  }));
