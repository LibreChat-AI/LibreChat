import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  ResponseReservation,
  ResponseExecutionBinding,
  ResponseStorage,
  StoredResponseRecord,
  ResponseResumeReservation,
  ResponseTerminalReceipt,
} from './response';
import { eraseResponseRecords, ResponseErasurePendingError } from './responseErasure';
import { closeResponseScopes, createResponseRetention } from './responseScope';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { includeManagedAllocations } from '~/utils/managed';
import { createConversationMethods } from './conversation';
import { createConversationImportMethods } from './import';
import { createManagedMessageId } from '~/utils/managed';
import { createResponseStorage } from './response';
import { responseReference } from './responseRoot';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const oneId = createManagedMessageId();
const otherId = createManagedMessageId();
const retryId = createManagedMessageId();
const siblingId = createManagedMessageId();
const pageResponseIds = Array.from({ length: 4 }, () => createManagedMessageId());

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
const owner = { userId: 'owner', tenantId: 'tenant-a' };
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: owner.tenantId }, work);
async function executionGuard(responseId: string) {
  const execution = await scoped(() => storage.read(owner, responseId));
  if (!execution) throw new Error('Missing execution fixture');
  return { execution };
}
const reservation = (overrides: Partial<ResponseReservation> = {}): ResponseReservation => ({
  ...owner,
  responseId: oneId,
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
      Array.from({ length: 12 }, () =>
        storage.reserve(reservation({ responseId: createManagedMessageId() })),
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
    const reserved = await storage.reserve(reservation({ expiredAt }));
    if (!reserved.ok) throw new Error('Reservation failed');
    expect(await mongoose.models.StoredResponse.collection.indexExists('expiredAt_1__id_1')).toBe(
      true,
    );
    expect(
      (await mongoose.models.StoredResponse.listIndexes()).some(
        (index) => index.expireAfterSeconds != null,
      ),
    ).toBe(false);
    await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(Date.now() - 1));
    expect(await storage.read(owner, oneId)).toBeNull();
    expect(await storage.requestCancellation(owner, oneId, Date.now())).toBeNull();
    expect(await storage.attachDelivery(owner, oneId, 'late')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(
      await storage.enrollExecution(
        reserved.record,
        { generationCreatedAt: 1, providerExecutionId: 'late-provider' },
        '{"late":"private"}',
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const identity = await storage.readCleanupIdentity(owner, oneId);
    expect(identity).toMatchObject({ responseId: oneId, userId: owner.userId });
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
    expect((await storage.read(owner, oneId))?.expiredAt).toEqual(deadline);
    await methods.saveConvo(
      { userId: owner.userId, expiredAt: new Date(Date.now() + 120_000) },
      {
        conversationId: 'conversation-one',
        endpoint: 'agents',
      },
    );
    expect((await storage.read(owner, oneId))?.expiredAt).toEqual(deadline);
    await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(Date.now() - 1));
    expect(await storage.reserve(reservation({ requestKey: 'late' }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
  }));

it('applies newly resolved expiry to replay and sibling payloads in the reservation transaction', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.reserve(reservation({ responseId: siblingId, requestKey: 'sibling' }));
    const expiredAt = new Date(Date.now() + 60_000);
    const replay = await storage.reserve(reservation({ expiredAt }));
    expect(replay).toMatchObject({ ok: true, replayed: true, record: { expiredAt } });
    expect((await storage.read(owner, siblingId))?.expiredAt).toEqual(expiredAt);
    expect(await storage.reserve(reservation({ expiredAt: new Date(Date.now() - 1) }))).toEqual({
      ok: false,
      code: 'response_unavailable',
    });
    expect(await storage.read(owner, oneId)).toBeNull();
    expect(await storage.read(owner, siblingId)).toBeNull();
  }));

it('rejects changed input under the same idempotency key without replacing the original', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    expect(
      await storage.reserve(reservation({ fingerprint: 'changed', requestJSON: 'changed' })),
    ).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect((await storage.read(owner, oneId))?.fingerprint).toBe('same-request');
  }));

it('replays concurrent retries against the winning conversation rather than their fresh ids', () =>
  scoped(async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        storage.reserve(
          reservation({
            responseId: createManagedMessageId(),
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

it('fences a failed publication before returning its storage error', () =>
  scoped(async () => {
    jest
      .spyOn(mongoose.models.StoredResponse.collection, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('interrupted publication'));
    await expect(storage.reserve(reservation())).rejects.toThrow('interrupted publication');
    expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(0);
    const anchors = await mongoose.models.ResponseScope.find({}).lean();
    expect(
      anchors.every(
        (anchor) => anchor.revision > 0 && anchor.pendingCount === 0 && !anchor.pending?.length,
      ),
    ).toBe(true);
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
  expect(await storage.read(authenticated, oneId)).toBeNull();
  await runAsSystem(() => mongoose.models.User.deleteOne({ _id: user._id }));
});

it.each([undefined, ''])(
  'shares tenantless admission and reads for tenantId=%p',
  async (tenantId) => {
    const tenantless = { userId: 'tenantless', tenantId };
    await tenantStorage.run({ tenantId: '' }, async () => {
      const result = await storage.reserve(reservation(tenantless));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.tenantId || undefined).toBe(tenantId || undefined);
      expect(await storage.read({ userId: tenantless.userId }, oneId)).not.toBeNull();
      expect(
        await storage.reserve(reservation({ ...tenantless, tenantId: '', responseId: retryId })),
      ).toMatchObject({ ok: true, replayed: true });
      await mongoose.models.StoredResponse.collection.updateOne(
        { responseId: oneId },
        { $set: { tenantId: null } },
      );
      expect(await storage.read({ ...tenantless, tenantId: '' }, oneId)).not.toBeNull();
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
    const publish = collection.findOneAndUpdate.bind(collection);
    const paused = jest
      .spyOn(collection, 'findOneAndUpdate')
      .mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return publish(...args);
      });
    const pending = storage.reserve(reservation());
    await started;
    const rollback = createConversationImportMethods(mongoose).deleteImportedConversations({
      user: owner.userId,
      tenantId: owner.tenantId,
      conversationIds: ['conversation-one'],
    });
    try {
      await rollback;
      expect(
        await mongoose.models.Conversation.exists({ conversationId: 'conversation-one' }),
      ).toBeNull();
    } finally {
      release();
      paused.mockRestore();
    }
    expect((await pending).ok).toBe(false);
    await rollback;
    expect(await mongoose.models.StoredResponse.countDocuments({ userId: owner.userId })).toBe(0);
    expect(await storage.read(owner, oneId)).toBeNull();
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
        expect(await storage.read(stranger, oneId)).toBeNull();
        expect(await storage.attachDelivery(stranger, oneId, 'delivery')).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(
          await Reflect.apply(storage.publishProgress, storage, [
            { ...(await storage.read(stranger, oneId))!, revision: 0 },
            {
              status: 'completed',
              responseJSON: '{}',
            },
          ]),
        ).toEqual({ ok: false, code: 'response_conflict' });
        expect(await storage.requestCancellation(stranger, oneId, 100)).toBeNull();
      });
    }
    expect((await storage.read(owner, oneId))?.revision).toBe(0);
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
    expect((await storage.reserve(reservation({ userId: 'other', responseId: otherId }))).ok).toBe(
      true,
    );
  }));

it('attaches only one immutable queue delivery identity', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    expect((await storage.attachDelivery(owner, oneId, 'delivery')).ok).toBe(true);
    expect((await storage.attachDelivery(owner, oneId, 'delivery')).ok).toBe(true);
    expect(await storage.attachDelivery(owner, oneId, 'different')).toEqual({
      ok: false,
      code: 'response_conflict',
    });
  }));

it('CAS-cancels one unused Root and never lets progress clobber its terminal result', () =>
  scoped(async () => {
    const reserved = await storage.reserve(reservation());
    if (!reserved.ok) throw new Error('Reservation failed');
    const stopped = (await storage.requestCancellation(owner, oneId, 100))!;
    const results = await Promise.all(
      ['first', 'second'].map((winner) =>
        storage.cancelUnstarted(stopped, JSON.stringify({ winner })),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const record = (await storage.read(owner, oneId))!;
    expect(record).toMatchObject({
      status: 'cancelled',
      requestJSON: '{}',
      fingerprint: 'same-request',
    });
    expect(
      await storage.publishProgress(record, { status: 'in_progress', responseJSON: 'stale' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect((await storage.read(owner, oneId))?.responseJSON).toBe(record.responseJSON);
    expect(
      await storage.enrollExecution(
        reserved.record,
        { generationCreatedAt: 10, providerExecutionId: 'provider-one' },
        '{}',
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('rejects replacement enrollment and backwards queued transitions', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await beginExecution();
    expect(
      await storage.enrollExecution(
        running.record,
        { generationCreatedAt: 20, providerExecutionId: 'provider-other' },
        '{}',
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.publishProgress(running.record, { status: 'queued', responseJSON: '{}' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('persists cancellation intent once without claiming the provider has stopped', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await storage.requestCancellation(owner, oneId, 100);
    expect(await storage.requestCancellation(owner, oneId, 200)).toMatchObject({
      status: 'queued',
      cancellationRequestedAt: 100,
      revision: 0,
    });
  }));

it('rejects queued enrollment after cancellation without relying on a revision change', () =>
  scoped(async () => {
    const reserved = await storage.reserve(reservation());
    if (!reserved.ok) throw new Error('Reservation failed');
    await storage.requestCancellation(owner, oneId, 100);
    expect(
      await storage.enrollExecution(
        reserved.record,
        { generationCreatedAt: 10, providerExecutionId: 'provider-one' },
        '{}',
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('requires explicit valid enrollment and lets subsequent progress use its captured identity', () =>
  scoped(async () => {
    const reserved = await storage.reserve(reservation());
    if (!reserved.ok) throw new Error('Reservation failed');
    expect(
      await storage.publishProgress(reserved.record, { status: 'in_progress', responseJSON: '{}' }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    for (const generationCreatedAt of [0, -1, NaN, Infinity, 1.5])
      await expect(
        storage.enrollExecution(
          reserved.record,
          { generationCreatedAt, providerExecutionId: 'provider-one' },
          '{}',
        ),
      ).rejects.toThrow('Invalid Response provider identity');
    const running = await beginExecution();
    await storage.requestCancellation(owner, oneId, 100);
    expect(
      (
        await storage.publishProgress(running.record, {
          status: 'in_progress',
          responseJSON: '{"progress":true}',
        })
      ).ok,
    ).toBe(true);
    for (const update of [
      { status: 'completed', responseJSON: '{}' },
      { status: 'materializing', responseJSON: '{}' },
      { status: 'in_progress', generationCreatedAt: 20, responseJSON: '{}' },
      { status: 'in_progress', providerExecution: { id: 'other' }, responseJSON: '{}' },
    ])
      expect(
        await Reflect.apply(storage.publishProgress, storage, [
          (await storage.read(owner, oneId))!,
          update,
        ]),
      ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('clears a live OAuth progress hint without reopening a durable review', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await beginExecution();
    const waiting = await storage.publishProgress(running.record, {
      status: 'requires_action',
      responseJSON: '{"required_action":{"kind":"oauth"}}',
    });
    if (!waiting.ok) throw new Error('OAuth projection failed');
    const resumed = await storage.publishProgress(waiting.record, {
      status: 'in_progress',
      responseJSON: '{"status":"in_progress"}',
    });
    expect(resumed).toMatchObject({
      ok: true,
      record: { status: 'in_progress', generationCreatedAt: 10 },
    });
    expect((await storage.read(owner, oneId))?.responseJSON).not.toContain('required_action');
  }));

it.each(['prepareTerminal', 'stageTerminal'] as const)(
  'fences %s to the actual enrolled provider and owner',
  (method) =>
    scoped(async () => {
      await storage.reserve(reservation());
      const running = await beginExecution();
      for (const changed of [
        { providerExecutionId: 'other-provider' },
        { ownerId: 'other-worker' },
        { generationCreatedAt: 11 },
      ]) {
        expect(
          await storage[method](
            owner,
            oneId,
            { execution: running.record },
            { ...outcome, ...changed },
          ),
        ).toEqual({ ok: false, code: 'response_conflict' });
      }
      const record = (await storage.read(owner, oneId))!;
      expect(record.pendingTerminal).toBeUndefined();
      expect(record.preparedTerminal).toBeUndefined();
    }),
);

it.each(['progress', 'cancel'] as const)(
  'withholds %s acknowledgement when erasure closes during its actual CAS',
  (kind) =>
    scoped(async () => {
      const reserved = await storage.reserve(reservation());
      if (!reserved.ok) throw new Error('Reservation failed');
      const record =
        kind === 'progress'
          ? (await beginExecution()).record
          : (await storage.requestCancellation(owner, oneId, 100))!;
      const original = mongoose.models.StoredResponse.collection.findOneAndUpdate.bind(
        mongoose.models.StoredResponse.collection,
      );
      const write = jest
        .spyOn(mongoose.models.StoredResponse.collection, 'findOneAndUpdate')
        .mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          await closeResponseScopes(mongoose, owner);
          return result;
        });
      try {
        const result =
          kind === 'progress'
            ? await storage.publishProgress(record, {
                status: 'in_progress',
                responseJSON: '{"private":"late progress"}',
              })
            : await storage.cancelUnstarted(record, '{"private":"late cancellation"}');
        expect(result).toEqual({ ok: false, code: 'response_conflict' });
        expect(await storage.read(owner, oneId)).toBeNull();
      } finally {
        write.mockRestore();
      }
    }),
);

it.each(['progress', 'cancel'] as const)(
  'withholds %s acknowledgement when its Root expires after the actual CAS',
  (kind) =>
    scoped(async () => {
      const expiredAt = new Date(Date.now() + 60_000);
      const reserved = await storage.reserve(reservation({ expiredAt }));
      if (!reserved.ok) throw new Error('Reservation failed');
      const record =
        kind === 'progress'
          ? (await beginExecution()).record
          : (await storage.requestCancellation(owner, oneId, 100))!;
      const original = mongoose.models.StoredResponse.collection.findOneAndUpdate.bind(
        mongoose.models.StoredResponse.collection,
      );
      let clock: jest.SpyInstance | undefined;
      const write = jest
        .spyOn(mongoose.models.StoredResponse.collection, 'findOneAndUpdate')
        .mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          expect(result).not.toBeNull();
          clock = jest.spyOn(Date, 'now').mockReturnValue(expiredAt.getTime() + 1);
          return result;
        });
      try {
        const result =
          kind === 'progress'
            ? await storage.publishProgress(record, {
                status: 'in_progress',
                responseJSON: '{"private":"expired progress"}',
              })
            : await storage.cancelUnstarted(record, '{"private":"expired cancellation"}');
        expect(write).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ ok: false, code: 'response_conflict' });
      } finally {
        clock?.mockRestore();
        write.mockRestore();
      }
    }),
);

it('withholds a Root read that expires before its database reply arrives', () =>
  scoped(async () => {
    const expiredAt = new Date(Date.now() + 60_000);
    await storage.reserve(reservation({ expiredAt }));
    const original = mongoose.models.StoredResponse.collection.findOne.bind(
      mongoose.models.StoredResponse.collection,
    );
    let clock: jest.SpyInstance | undefined;
    const read = jest
      .spyOn(mongoose.models.StoredResponse.collection, 'findOne')
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        expect(result).not.toBeNull();
        clock = jest.spyOn(Date, 'now').mockReturnValue(expiredAt.getTime() + 1);
        return result;
      });
    try {
      expect(await storage.read(owner, oneId)).toBeNull();
    } finally {
      clock?.mockRestore();
      read.mockRestore();
    }
  }));

it('does not add cancellation intent to a finalized response', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await beginExecution();
    const receipt = { ...outcome, status: 'failed' as const };
    expect(
      (await storage.stageTerminal(owner, oneId, { execution: running.record }, receipt)).ok,
    ).toBe(true);
    expect((await finishConfirmed(receipt)).ok).toBe(true);
    expect(
      (await storage.requestCancellation(owner, oneId, 100))?.cancellationRequestedAt,
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

async function beginExecution(
  responseJSON = '{}',
  providerExecutionId = 'provider-one',
  overrides: Partial<ResponseExecutionBinding> = {},
) {
  const current = (await storage.read(owner, oneId))!;
  const binding = {
    generationCreatedAt: 10,
    providerExecutionId,
    ownerId: 'worker-one',
    ...overrides,
  };
  const enrolled = await storage.enrollExecution(current, binding, responseJSON);
  if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
    throw new Error('Fixture provider enrollment failed');
  return enrolled;
}
it.each([1, 'true', {}])(
  'requires a boolean provider-drain acknowledgement, rejecting %p',
  (value) =>
    scoped(async () => {
      await storage.reserve(reservation());
      const { record } = await beginExecution();
      await mongoose.models.StoredResponse.collection.updateOne(
        { responseId: record.responseId },
        { $set: { 'providerExecution.drained': value } },
      );
      expect(await storage.readExecutionProof(record)).toBeNull();
      expect(
        await storage.settleExecution(responseReference(record), {
          generationCreatedAt: 10,
          providerExecutionId: 'provider-one',
          ownerId: 'worker-one',
        }),
      ).toBe(true);
      expect(await storage.readExecutionProof(record)).toMatchObject({
        providerExecutionId: 'provider-one',
      });
    }),
);

async function finishConfirmed(receipt: ResponseTerminalReceipt) {
  const current = (await storage.read(owner, oneId))!;
  expect(await storage.settleExecution(responseReference(current), receipt, 'complete')).toBe(true);
  return storage.finishTerminal(current, oneId, current.revision, receipt);
}

async function pause() {
  await storage.reserve(reservation());
  const started = await beginExecution('{}');
  expect(started.ok).toBe(true);
  const paused = await storage.publishReview(
    owner,
    oneId,
    await executionGuard(oneId),
    10,
    review,
    '{"status":"requires_action"}',
  );
  expect(paused.ok).toBe(true);
  expect(
    await storage.settleExecution(responseReference((await storage.read(owner, oneId))!), {
      generationCreatedAt: 10,
      providerExecutionId: 'provider-one',
      ownerId: 'worker-one',
    }),
  ).toBe(true);
}

it('retains a valid private visible-token seed and rejects fractional, negative or overflowing counters', () =>
  scoped(async () => {
    await runningForReview();
    const result = await storage.publishReview(
      owner,
      oneId,
      await executionGuard(oneId),
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
          oneId,
          await executionGuard(oneId),
          10,
          { ...review, visibleOutputTokens },
          '{}',
        ),
      ).resolves.toEqual({ ok: false, code: 'response_conflict' });
    expect((await storage.read(owner, oneId))?.review?.visibleOutputTokens).toBe(13);
  }));

it('persists one immutable resume decision under concurrent equivalent retries', () =>
  scoped(async () => {
    await pause();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        storage.reserveResume(
          owner,
          oneId,
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
        oneId,
        resume({ resolutionJSON: '{"approved":false}' }),
        100,
      ),
    ).toEqual({ ok: false, code: 'resume_conflict' });
    const stored = (await storage.read(owner, oneId))!;
    expect(stored.requestJSON).toBe(reservation().requestJSON);
    expect(stored.review).toEqual(review);
    expect(stored.revision).toBe(3);
  }));

it('retains the original wire decision and does not conflate different scopes with the same SDK resolution', () =>
  scoped(async () => {
    await pause();
    expect(
      await storage.reserveResume(owner, oneId, resume({ decisionJSON: '{"scope":"once"}' }), 500),
    ).toMatchObject({ ok: true, record: { resume: { decisionJSON: '{"scope":"once"}' } } });
    expect(
      await storage.reserveResume(
        owner,
        oneId,
        resume({ decisionJSON: '{"scope":"session"}' }),
        500,
      ),
    ).toMatchObject({ ok: false, code: 'resume_conflict' });
    expect((await storage.read(owner, oneId))!.resume?.decisionJSON).toBe('{"scope":"once"}');
  }));

it('rejects expired, wrong-action, wrong-generation and wrong-provider decisions', () =>
  scoped(async () => {
    await pause();
    await expect(
      storage.reserveResume(
        owner,
        oneId,
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
      expect(await storage.reserveResume(owner, oneId, resume(overrides), 100)).toEqual({
        ok: false,
        code: 'resume_conflict',
      });
    }
    expect(await storage.reserveResume(owner, oneId, resume(), review.expiresAt)).toEqual({
      ok: false,
      code: 'resume_conflict',
    });
    expect((await storage.read(owner, oneId))?.resume).toBeUndefined();
  }));

it('keeps review and resume mutations owner- and tenant-scoped', () =>
  scoped(async () => {
    await pause();
    for (const stranger of [
      { ...owner, userId: 'other' },
      { ...owner, tenantId: 'other' },
    ]) {
      await tenantStorage.run({ tenantId: stranger.tenantId }, async () => {
        expect(
          await storage.publishReview(
            stranger,
            oneId,
            await executionGuard(oneId),
            10,
            review,
            '{}',
          ),
        ).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(await storage.reserveResume(stranger, oneId, resume(), 100)).toEqual({
          ok: false,
          code: 'resume_conflict',
        });
        expect(
          await storage.admitResume(stranger, oneId, 'intent-one', 10, 'provider-two', '{}', 100),
        ).toEqual({ ok: false, code: 'response_conflict' });
      });
    }
    expect((await storage.read(owner, oneId))?.revision).toBe(2);
  }));

it('fences late pause callbacks and allows only the admitted next segment to pause again', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    expect(
      await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, review, '{}'),
    ).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(
      await storage.admitResume(owner, oneId, 'intent-one', 10, 'wrong-provider', '{}', 101),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      (await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 101)).ok,
    ).toBe(true);
    const admitted = (await storage.read(owner, oneId))!;
    expect(admitted).toMatchObject({
      status: 'in_progress',
      revision: 4,
      resume: { state: 'admitted', admittedAt: 101 },
    });
    expect(
      (await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', 'ignored', 102))
        .ok,
    ).toBe(true);
    expect(
      await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, review, '{}'),
    ).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    await beginExecution('{}', 'provider-two');
    const next = { ...review, actionId: 'action-two', providerExecutionId: 'provider-two' };
    expect(
      (await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, next, '{}')).ok,
    ).toBe(true);
    expect(await storage.read(owner, oneId)).toMatchObject({
      status: 'requires_action',
      review: next,
      revision: 6,
    });
    expect((await storage.read(owner, oneId))?.resume).toBeUndefined();
    expect(await storage.reserveResume(owner, oneId, resume(), 103)).toEqual({
      ok: false,
      code: 'resume_conflict',
    });
  }));

it('cancellation prevents a reserved decision from admitting execution', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    await storage.requestCancellation(owner, oneId, 101);
    expect(
      await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 102),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, review, '{}'),
    ).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.reserveResume(owner, oneId, resume(), 103)).toMatchObject({
      ok: true,
      replayed: true,
      record: { status: 'requires_action', cancellationRequestedAt: 101 },
    });
  }));

it('does not admit or repause terminal responses but retains the identical decision receipt', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    const cancelled = { ...outcome, status: 'cancelled' as const };
    expect(
      (await storage.stageTerminal(owner, oneId, await executionGuard(oneId), cancelled)).ok,
    ).toBe(true);
    expect((await finishConfirmed(cancelled)).ok).toBe(true);
    const terminal = (await storage.read(owner, oneId))!;
    expect(
      await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 102),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, review, '{}'),
    ).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.reserveResume(owner, oneId, resume(), 103)).toMatchObject({
      ok: true,
      replayed: true,
      record: { status: 'cancelled', revision: terminal.revision },
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
    const running = await beginExecution('{"progress":true}');
    if (!running.ok) throw new Error('Publication failed');
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        storage.prepareTerminal(owner, oneId, { execution: running.record }, outcome),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const prepared = (await storage.read(owner, oneId))!;
    expect(prepared).toMatchObject({
      status: 'in_progress',
      responseJSON: '{"progress":true}',
      preparedTerminal: outcome,
    });
    expect(prepared.pendingTerminal).toBeUndefined();
    expect(
      await storage.prepareTerminal(
        owner,
        oneId,
        { execution: prepared },
        {
          ...outcome,
          responseJSON: 'different candidate',
        },
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await Reflect.apply(storage.publishProgress, storage, [
        { ...(await storage.read(owner, oneId))!, revision: prepared.revision },
        {
          status: 'completed',
          responseJSON: 'unconfirmed',
        },
      ]),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.stageTerminal(owner, oneId, { execution: prepared }, outcome)).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    const promoted = await storage.stageTerminal(owner, oneId, { execution: prepared }, outcome, {
      receipt: outcome,
    });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) throw new Error('Promotion failed');
    expect(promoted.record.preparedTerminal).toBeUndefined();
    expect(promoted.record.pendingTerminal).toEqual(outcome);
    expect((await finishConfirmed(outcome)).ok).toBe(true);
  }));

it('fences a racing Stop when promoting a prepared success without projection-revision retries', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await beginExecution('{}');
    if (!running.ok) throw new Error('Publication failed');
    const prepared = await storage.prepareTerminal(
      owner,
      oneId,
      { execution: running.record },
      outcome,
    );
    if (!prepared.ok) throw new Error('Preparation failed');
    const stopped = (await storage.requestCancellation(owner, oneId, 100))!;
    expect(
      await storage.stageTerminal(owner, oneId, { execution: prepared.record }, outcome, {
        receipt: outcome,
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    const cancelled = {
      ...outcome,
      status: 'cancelled' as const,
      responseJSON: '{"cancelled":true}',
    };
    const promoted = await storage.stageTerminal(owner, oneId, { execution: stopped }, cancelled, {
      receipt: outcome,
      cancellationRequestedAt: stopped.cancellationRequestedAt,
    });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) throw new Error('Promotion failed');
    expect((await finishConfirmed(cancelled)).ok).toBe(true);
    expect((await storage.read(owner, oneId))?.status).toBe('cancelled');
  }));

it('scrubs an expired prepared candidate but retains its unresolved execution authority', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await beginExecution('{}');
    if (!running.ok) throw new Error('Publication failed');
    await storage.prepareTerminal(owner, oneId, { execution: running.record }, outcome);
    await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(0));
    const identity = await storage.readCleanupIdentity(owner, oneId);
    expect(identity).toMatchObject({
      retirement: 'expired',
      checkpointNamespace: outcome.checkpointNamespace,
    });
    expect(JSON.stringify(identity)).not.toContain('private until cleanup');
    await closeResponseScopes(mongoose, owner);
    await expect(eraseResponseRecords(mongoose, owner)).rejects.toBeInstanceOf(
      ResponseErasurePendingError,
    );
    const retained = await mongoose.models.StoredResponse.collection.findOne({ responseId: oneId });
    expect(retained).toMatchObject({ generationCreatedAt: 10, _managed: { phase: 'retired' } });
    for (const field of ['requestJSON', 'responseJSON', 'preparedTerminal', 'pendingTerminal'])
      expect(retained).not.toHaveProperty(field);
    expect(await storage.read(owner, oneId)).toBeNull();
  }));

it('stages an initial terminal receipt without requiring a review or resume', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await beginExecution('{}');
    expect(
      (await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome)).ok,
    ).toBe(true);
    expect((await finishConfirmed(outcome)).ok).toBe(true);
  }));

it('stages the admitted provider terminal receipt without requiring another review', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 101);
    await beginExecution('{}', 'provider-two');
    const current = { ...outcome, providerExecutionId: 'provider-two' };
    expect(
      (await storage.stageTerminal(owner, oneId, await executionGuard(oneId), current)).ok,
    ).toBe(true);
    expect((await finishConfirmed(current)).ok).toBe(true);
  }));

it('keeps a paused response behind resume admission even with its latest revision', () =>
  scoped(async () => {
    await pause();
    expect(
      await storage.publishProgress(
        { ...(await storage.read(owner, oneId))!, revision: 2 },
        {
          status: 'in_progress',
          responseJSON: '{}',
        },
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(await storage.read(owner, oneId)).toMatchObject({
      status: 'requires_action',
      revision: 2,
      review,
    });
    expect((await storage.reserveResume(owner, oneId, resume(), 100)).ok).toBe(true);
    expect(
      (await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 101)).ok,
    ).toBe(true);
  }));

it('rejects terminal receipts from an earlier segment after resume admission and a later pause', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 101);
    await beginExecution('{}', 'provider-two');
    expect(await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome)).toEqual(
      {
        ok: false,
        code: 'response_conflict',
      },
    );
    const next = { ...review, actionId: 'action-two', providerExecutionId: 'provider-two' };
    await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, next, '{}');
    expect(await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome)).toEqual(
      {
        ok: false,
        code: 'response_conflict',
      },
    );
    const current = { ...outcome, providerExecutionId: 'provider-two' };
    expect(
      (await storage.stageTerminal(owner, oneId, await executionGuard(oneId), current)).ok,
    ).toBe(true);
    expect((await finishConfirmed(current)).ok).toBe(true);
  }));

it('durably stages one immutable terminal receipt while keeping its output private', () =>
  scoped(async () => {
    await pause();
    const results = await Promise.all(
      Array.from({ length: 12 }, async () =>
        storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const record = (await storage.read(owner, oneId))!;
    expect(record).toMatchObject({
      status: 'requires_action',
      revision: 3,
      pendingTerminal: outcome,
    });
    expect(record.responseJSON).not.toContain('private until cleanup');
    expect(
      await storage.stageTerminal(owner, oneId, await executionGuard(oneId), {
        ...outcome,
        status: 'failed',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.stageTerminal(owner, oneId, await executionGuard(oneId), {
        ...outcome,
        ownerId: 'other-worker',
      }),
    ).toEqual({ ok: false, code: 'response_conflict' });
  }));

it('prevents Stop, review and resume writes from overwriting a staged terminal outcome', () =>
  scoped(async () => {
    await pause();
    await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome);
    expect(
      await Reflect.apply(storage.publishProgress, storage, [
        { ...(await storage.read(owner, oneId))!, revision: 3 },
        {
          status: 'cancelled',
          responseJSON: 'overwrite',
        },
      ]),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      await storage.publishReview(owner, oneId, await executionGuard(oneId), 10, review, '{}'),
    ).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.reserveResume(owner, oneId, resume(), 100)).toEqual({
      ok: false,
      code: 'resume_conflict',
    });
    expect(
      (await storage.requestCancellation(owner, oneId, 100))?.cancellationRequestedAt,
    ).toBeUndefined();
  }));

it('publishes only the exact saved receipt and removes it atomically with terminal publication', () =>
  scoped(async () => {
    await pause();
    await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome);
    for (const changed of [
      { ownerId: 'other' },
      { checkpointNamespace: 'other' },
      { checkpointConfigJSON: 'other' },
      { generationCreatedAt: 11 },
      { responseJSON: 'other' },
      { providerExecutionId: 'other' },
    ]) {
      expect(await storage.finishTerminal(owner, oneId, 3, { ...outcome, ...changed })).toEqual({
        ok: false,
        code: 'response_conflict',
      });
    }
    expect((await finishConfirmed(outcome)).ok).toBe(true);
    const record = (await storage.read(owner, oneId))!;
    expect(record).toMatchObject({
      status: 'completed',
      responseJSON: outcome.responseJSON,
      revision: 4,
    });
    expect(record.pendingTerminal).toBeUndefined();
    expect(await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome)).toEqual(
      {
        ok: false,
        code: 'response_conflict',
      },
    );
  }));

it('does not stage or publish another user or tenant terminal result', () =>
  scoped(async () => {
    await pause();
    await storage.stageTerminal(owner, oneId, await executionGuard(oneId), outcome);
    for (const stranger of [
      { ...owner, userId: 'other' },
      { ...owner, tenantId: 'other' },
    ]) {
      await tenantStorage.run({ tenantId: stranger.tenantId }, async () => {
        expect(
          await storage.stageTerminal(stranger, oneId, await executionGuard(oneId), outcome),
        ).toEqual({
          ok: false,
          code: 'response_conflict',
        });
        expect(await storage.finishTerminal(stranger, oneId, 3, outcome)).toEqual({
          ok: false,
          code: 'response_conflict',
        });
      });
    }
    expect((await storage.read(owner, oneId))?.revision).toBe(3);
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
    expect(await storage.read(owner, oneId)).toBeNull();
    expect(await storage.readCleanupIdentity(owner, oneId)).toMatchObject({
      responseId: oneId,
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
  'fences delayed publication before %s erasure completes',
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
      const publish = collection.findOneAndUpdate.bind(collection);
      const paused = jest
        .spyOn(collection, 'findOneAndUpdate')
        .mockImplementation(async (...args) => {
          entered();
          await gate;
          return publish(...args);
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
        await eraseResponseRecords(
          mongoose,
          owner,
          kind === 'owner' ? undefined : ['conversation-one'],
        );
        erased = true;
      });
      try {
        await erasure;
        expect(erased).toBe(true);
      } finally {
        release();
        paused.mockRestore();
      }
      expect((await pending).ok).toBe(false);
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
        { responseId: oneId },
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
      const identity = await storage.readCleanupIdentity(owner, oneId);
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
      await mongoose.models.StoredResponse.deleteOne({ responseId: oneId });
      expect(await storage.readCleanupIdentity(owner, oneId, identity!)).toEqual(identity);
      expect(
        await storage.readCleanupIdentity(owner, oneId, {
          ...identity!,
          userId: 'another-owner',
        }),
      ).toBeNull();
      expect(
        await storage.readCleanupIdentity(owner, oneId, {
          ...identity!,
          tenantId: 'another-tenant',
        }),
      ).toBeNull();
      expect(
        await storage.readCleanupIdentity(owner, oneId, {
          ...identity!,
          responseId: 'another-response',
        }),
      ).toBeNull();
    }),
);

it('requires checkpoint cleanup for an initial staged terminal without a review or retained identity', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const running = await beginExecution('{}', 'initial-provider', {
      generationCreatedAt: 42,
      ownerId: undefined,
    });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    const staged = await storage.stageTerminal(owner, oneId, await executionGuard(oneId), {
      generationCreatedAt: 42,
      providerExecutionId: 'initial-provider',
      status: 'failed',
      responseJSON: '{}',
      checkpointNamespace: 'checkpoint-one',
      checkpointConfigJSON: '{"saver":"initial"}',
    });
    expect(staged.ok).toBe(true);
    expect(await storage.readCleanupIdentity(owner, oneId)).toMatchObject({
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
      { responseId: oneId },
      {
        $set: { generationCreatedAt: 42 },
      },
    );
    const identity = await storage.readCleanupIdentity(owner, oneId);
    expect(
      await storage.readCleanupIdentity(owner, oneId, {
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
    const retained = await storage.readCleanupIdentity(owner, oneId);
    await mongoose.models.StoredResponse.deleteOne({ responseId: oneId });
    expect(
      await storage.readCleanupIdentity(owner, oneId, {
        ...retained!,
        expiredAt: new Date(Date.now() - 1),
        retirement: 'expired',
      }),
    ).toBeNull();
    await closeResponseScopes(mongoose, { ...owner, userId: 'another-owner' });
    await closeResponseScopes(mongoose, owner, ['another-conversation']);
    expect(await storage.readCleanupIdentity(owner, oneId, retained!)).toBeNull();
  }));

it('recovers and erases owner data across existing tenant partition spellings', async () => {
  createModels(mongoose);
  const tenants = ['tenant-a', 'tenant-b', undefined, '', null];
  const unrelatedOwnerId = createManagedMessageId();
  const unrelatedConversationId = createManagedMessageId();
  for (const tenantId of tenants) {
    const responseId = createManagedMessageId();
    await tenantStorage.run({ tenantId: tenantId || undefined }, () =>
      storage.reserve(
        reservation({ responseId, requestKey: responseId, tenantId: tenantId || undefined }),
      ),
    );
    if (tenantId !== undefined)
      await runAsSystem(() =>
        mongoose.models.StoredResponse.collection.updateOne({ responseId }, { $set: { tenantId } }),
      );
  }
  await scoped(async () => {
    await storage.reserve(reservation({ userId: 'another-owner', responseId: unrelatedOwnerId }));
    await storage.reserve(
      reservation({
        conversationId: 'another-conversation',
        responseId: unrelatedConversationId,
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
    expect(remaining.map((row) => row.responseId).sort()).toEqual(
      [unrelatedConversationId, unrelatedOwnerId].sort(),
    );
  });
  for (const tenantId of ['tenant-a', 'tenant-b', undefined])
    await tenantStorage.run({ tenantId }, async () => {
      expect(
        await storage.reserve(reservation({ tenantId, requestKey: `late-${tenantId}` })),
      ).toEqual({
        ok: false,
        code: 'response_unavailable',
      });
    });
});

it('keeps incomplete staged checkpoint bindings retryable instead of mixing older settings', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    await mongoose.models.StoredResponse.updateOne(
      { responseId: oneId },
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
      responseId: oneId,
      agentId: 'agent-one',
      conversationId: 'conversation-one',
      generationCreatedAt: 42,
      checkpointNamespace: 'old-checkpoint',
      checkpointConfigJSON: 'retained-config',
    };
    expect(await storage.readCleanupIdentity(owner, oneId, retained)).toMatchObject({
      checkpointNamespace: 'new-checkpoint',
      checkpointConfigJSON: undefined,
      requiresCheckpointCleanup: true,
    });
  }));

it('propagates cleanup lookup outages instead of treating retained metadata as authority', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const retained = await storage.readCleanupIdentity(owner, oneId);
    jest
      .spyOn(mongoose.models.StoredResponse.collection, 'findOne')
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(storage.readCleanupIdentity(owner, oneId, retained!)).rejects.toThrow(
      'database unavailable',
    );
  }));

it('reserves without depending on transaction capability or session creation', () =>
  scoped(async () => {
    const session = jest
      .spyOn(mongoose, 'startSession')
      .mockRejectedValue(new Error('sessions unavailable'));
    try {
      expect(await createResponseStorage(mongoose).reserve(reservation())).toMatchObject({
        ok: true,
      });
      expect(session).not.toHaveBeenCalled();
    } finally {
      session.mockRestore();
    }
  }));

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
    expect(await storage.read(owner, oneId)).not.toHaveProperty('cancellationRequestedAt');
    expect(
      await storage.reserve(
        reservation({
          responseId: createManagedMessageId(),
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
    expect(await storage.read(owner, oneId)).toBeNull();
  }));

it('fences admission when conversation ID replacement wins before publication', () =>
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
    const publish = collection.updateOne.bind(collection);
    const paused = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return publish(...args);
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
      await replacement;
      expect(settled).toBe(true);
    } finally {
      release();
      paused.mockRestore();
    }
    expect(await pending).toEqual({ ok: false, code: 'response_unavailable' });
    expect(await replacement).toMatchObject({ conversationId: 'replacement' });
    expect(await storage.read(owner, oneId)).toBeNull();
    expect(
      await mongoose.models.Conversation.exists({ conversationId: 'racing-source' }),
    ).toBeNull();
  }));

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
    const running = await beginExecution('{}');
    if (!running.ok) throw new Error('Publication failed');
    for (let i = 0; i < 30; i++) {
      const current = (await storage.read(owner, oneId))!;
      expect(
        (
          await storage.publishProgress(
            { ...(await storage.read(owner, oneId))!, revision: current.revision },
            {
              status: 'in_progress',
              responseJSON: JSON.stringify({ progress: i }),
            },
          )
        ).ok,
      ).toBe(true);
    }
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        storage.stageTerminal(owner, oneId, { execution: running.record }, outcome),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const staged = (await storage.read(owner, oneId))!;
    expect(staged.pendingTerminal).toEqual(outcome);
    expect(staged.revision).toBe(running.record.revision + 31);
    expect(
      await storage.stageTerminal(
        owner,
        oneId,
        { execution: running.record },
        {
          ...outcome,
          ownerId: 'another-worker',
        },
      ),
    ).toEqual({ ok: false, code: 'response_conflict' });
    expect((await finishConfirmed(outcome)).ok).toBe(true);
  }));

it.each(['agentId', 'conversationId', 'sourceKeyId', 'generationCreatedAt'] as const)(
  'does not stage a retained execution with a mismatched %s',
  (field) =>
    scoped(async () => {
      await storage.reserve(reservation({ sourceKeyId: 'original-key' }));
      const running = await beginExecution('{}');
      if (!running.ok) throw new Error('Publication failed');
      const execution = {
        ...running.record,
        [field]: field === 'generationCreatedAt' ? 11 : 'other',
      };
      expect(await storage.stageTerminal(owner, oneId, { execution }, outcome)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect((await storage.read(owner, oneId))?.pendingTerminal).toBeUndefined();
    }),
);

it('matches the complete reviewed and resumed execution binding rather than its projection', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 101);
    await beginExecution('{}', 'provider-two');
    const retained = (await storage.read(owner, oneId))!;
    const receipt = { ...outcome, providerExecutionId: 'provider-two' };
    for (const execution of [
      { ...retained, review: undefined },
      { ...retained, review: { ...retained.review!, checkpointId: 'different' } },
      { ...retained, resume: { ...retained.resume!, fingerprint: 'different' } },
      { ...retained, resume: { ...retained.resume!, state: 'reserved' as const } },
    ])
      expect(await storage.stageTerminal(owner, oneId, { execution }, receipt)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
    const current = await storage.publishProgress(
      { ...(await storage.read(owner, oneId))!, revision: retained.revision },
      {
        status: 'in_progress',
        responseJSON: '{"projection":"new"}',
      },
    );
    expect(current.ok).toBe(true);
    expect((await storage.stageTerminal(owner, oneId, { execution: retained }, receipt)).ok).toBe(
      true,
    );
  }));

async function runningForReview() {
  await storage.reserve(reservation({ sourceKeyId: 'original-key' }));
  const running = await beginExecution('{}');
  if (!running.ok) throw new Error('Publication failed');
  return running.record;
}

it('publishes one immutable pause independently of polling before and after publication', () =>
  scoped(async () => {
    const running = await runningForReview();
    for (let i = 0; i < 30; i++) {
      const current = (await storage.read(owner, oneId))!;
      expect(
        (
          await storage.publishProgress(
            { ...(await storage.read(owner, oneId))!, revision: current.revision },
            {
              status: 'in_progress',
              responseJSON: JSON.stringify({ progress: i }),
            },
          )
        ).ok,
      ).toBe(true);
    }
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        storage.publishReview(owner, oneId, { execution: running }, 10, review, '{}'),
      ),
    );
    expect(attempts.every((result) => result.ok)).toBe(true);
    const paused = (await storage.read(owner, oneId))!;
    expect(paused.review).toEqual(review);
    expect(paused.revision).toBe(running.revision + 31);
    const projected = await storage.publishProgress(
      { ...(await storage.read(owner, oneId))!, revision: paused.revision },
      {
        status: 'requires_action',
        responseJSON: '{"projection":"new"}',
      },
    );
    if (!projected.ok) throw new Error('Projection failed');
    for (const execution of [running, projected.record]) {
      expect((await storage.publishReview(owner, oneId, { execution }, 10, review, '{}')).ok).toBe(
        true,
      );
      expect(
        await storage.publishReview(
          owner,
          oneId,
          { execution },
          10,
          { ...review, partialResponseJSON: '{"changed":true}' },
          '{}',
        ),
      ).toEqual({ ok: false, code: 'response_conflict' });
    }
    const saved = (await storage.read(owner, oneId))!;
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
      expect(await storage.publishReview(owner, oneId, { execution }, 10, review, '{}')).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect((await storage.read(owner, oneId))?.review).toBeUndefined();
    }),
);

it('binds the next pause to the complete admitted resume identity', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    await storage.admitResume(owner, oneId, 'intent-one', 10, 'provider-two', '{}', 101);
    await beginExecution('{}', 'provider-two');
    const retained = (await storage.read(owner, oneId))!;
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
        await storage.publishReview(owner, oneId, { execution }, 10, nextReview, '{}'),
      ).toEqual({ ok: false, code: 'response_conflict' });
    expect(
      (await storage.publishReview(owner, oneId, { execution: retained }, 10, nextReview, '{}')).ok,
    ).toBe(true);
    expect(await storage.read(owner, oneId)).toMatchObject({ review: nextReview });
    expect((await storage.read(owner, oneId))?.resume).toBeUndefined();
  }));

it.each(['cancelled', 'terminal', 'erased'] as const)(
  'does not publish a pause after %s authority wins',
  (failure) =>
    scoped(async () => {
      const running = await runningForReview();
      if (failure === 'cancelled') await storage.requestCancellation(owner, oneId, Date.now());
      if (failure === 'terminal')
        await storage.stageTerminal(owner, oneId, { execution: running }, outcome);
      if (failure === 'erased')
        await mongoose.models.StoredResponse.deleteOne({ responseId: oneId });
      expect(
        await storage.publishReview(owner, oneId, { execution: running }, 10, review, '{}'),
      ).toEqual({ ok: false, code: 'response_conflict' });
      expect((await storage.read(owner, oneId))?.review).toBeUndefined();
    }),
);

it.each(['live', 'owner_deleted', 'conversation_deleted', 'expired'] as const)(
  'preserves the canonical unenrolled generation under %s retirement',
  (reason) =>
    scoped(async () => {
      await storage.reserve(reservation());
      const retained = {
        ...owner,
        responseId: oneId,
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
      const identity = await storage.readCleanupIdentity(owner, oneId, retained);
      expect(identity).toMatchObject({
        generationCreatedAt: undefined,
        retirement: reason === 'live' ? undefined : reason,
        checkpointNamespace: reason === 'live' ? undefined : 'owned-checkpoint',
      });
      if (reason !== 'live') {
        const wrong = await storage.readCleanupIdentity(owner, oneId, {
          ...retained,
          agentId: 'wrong-agent',
        });
        expect(wrong?.generationCreatedAt).toBeUndefined();
        expect(wrong?.checkpointNamespace).toBeUndefined();
        await mongoose.models.StoredResponse.updateOne(
          { responseId: oneId },
          { $set: { generationCreatedAt: 43 } },
        );
        expect(await storage.readCleanupIdentity(owner, oneId, retained)).toMatchObject({
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
      const enrolled = await beginExecution('{}', 'provider-gap', {
        generationCreatedAt: 17,
        ownerId: undefined,
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
        oneId,
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
      expect(await storage.read(owner, oneId)).toBeNull();
      expect(
        await storage.stageTerminal(owner, oneId, { execution: prepared.record }, outcome, {
          receipt: outcome,
        }),
      ).toEqual({ ok: false, code: 'response_conflict' });
      const identity = await storage.readCleanupIdentity(owner, oneId);
      expect(identity?.retirement).toBe(
        kind === 'owner' ? 'owner_deleted' : 'conversation_deleted',
      );
      expect(JSON.stringify(identity)).not.toContain('answer');
      expect(await mongoose.models.StoredResponse.countDocuments({})).toBe(1);
    }),
);

it('retains a scrubbed pending receipt authority after closure without provider drain proof', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const enrolled = await beginExecution('{}', 'provider-pending', {
      generationCreatedAt: 17,
      ownerId: undefined,
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
      oneId,
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
    await expect(
      eraseResponseRecords(mongoose, owner, ['conversation-one']),
    ).rejects.toBeInstanceOf(ResponseErasurePendingError);
    expect(erase).not.toHaveBeenCalled();
    erase.mockRestore();
    expect(await storage.finishTerminal(owner, oneId, pending.record.revision, outcome)).toEqual({
      ok: false,
      code: 'response_conflict',
    });
    expect(await storage.read(owner, oneId)).toBeNull();
    expect(
      await mongoose.models.StoredResponse.collection.countDocuments({ responseId: oneId }),
    ).toBe(1);
  }));

it('does not disclose a local terminal CAS that lands before closure completes', () =>
  scoped(async () => {
    await storage.reserve(reservation());
    const enrolled = await beginExecution('{}', 'provider-retry', {
      generationCreatedAt: 17,
      ownerId: undefined,
    });
    if (!enrolled.ok) throw new Error('Enrollment failed');
    const receipt: ResponseTerminalReceipt = {
      generationCreatedAt: 17,
      providerExecutionId: 'provider-retry',
      status: 'completed',
      responseJSON: '{"private":"answer"}',
    };
    const original = mongoose.models.StoredResponse.collection.findOneAndUpdate.bind(
      mongoose.models.StoredResponse.collection,
    );
    const write = jest
      .spyOn(mongoose.models.StoredResponse.collection, 'findOneAndUpdate')
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        await closeResponseScopes(mongoose, owner, ['conversation-one']);
        return result;
      });
    expect(
      await storage.stageTerminal(owner, oneId, { execution: enrolled.record }, receipt),
    ).toEqual({ ok: false, code: 'response_conflict' });
    write.mockRestore();
    expect(await storage.read(owner, oneId)).toBeNull();
    await expect(
      eraseResponseRecords(mongoose, owner, ['conversation-one']),
    ).rejects.toBeInstanceOf(ResponseErasurePendingError);
    const raw = await mongoose.models.StoredResponse.collection.findOne({ responseId: oneId });
    expect(raw).toMatchObject({ _managed: { phase: 'retired' } });
    for (const field of ['requestJSON', 'responseJSON', 'pendingTerminal'])
      expect(raw).not.toHaveProperty(field);
  }));

it.each(['prepared', 'pending'] as const)(
  'keeps %s materialization private until exact publication completes',
  (phase) =>
    scoped(async () => {
      const running = await runningForReview();
      const receipt = { ...outcome, turnJSON: '{"version":1,"inputs":[],"private":"history"}' };
      const result =
        phase === 'prepared'
          ? await storage.prepareTerminal(owner, oneId, { execution: running }, receipt)
          : await storage.stageTerminal(owner, oneId, { execution: running }, receipt);
      if (!result.ok) throw new Error('Private phase admission failed');
      const record = result.record;
      expect(record.status).toBe('materializing');
      expect(record.responseJSON).toBe('{}');
      const retry = () =>
        phase === 'prepared'
          ? storage.prepareTerminal(owner, oneId, { execution: running }, receipt)
          : storage.stageTerminal(owner, oneId, { execution: running }, receipt);
      expect((await retry()).ok).toBe(true);
      expect(await storage.attachDelivery(owner, oneId, 'legacy')).toMatchObject({
        ok: false,
      });
      expect(
        await Reflect.apply(storage.publishProgress, storage, [
          { ...(await storage.read(owner, oneId))!, revision: record.revision },
          {
            status: 'completed',
            responseJSON: receipt.responseJSON,
          },
        ]),
      ).toMatchObject({ ok: false });
      expect(
        await storage.publishReview(owner, oneId, { execution: running }, 10, review, '{}'),
      ).toMatchObject({ ok: false });
      await mongoose.models.StoredResponse.updateOne(
        { responseId: oneId },
        {
          $set: { status: 'in_progress' },
        },
      );
      expect(await retry()).toMatchObject({ ok: false });
      if (phase === 'prepared') {
        expect(
          await storage.stageTerminal(owner, oneId, { execution: running }, receipt, {
            receipt,
          }),
        ).toMatchObject({ ok: false });
      } else {
        expect(
          await storage.finishTerminal(owner, oneId, record.revision, receipt, {
            intentJSON: receipt.turnJSON,
            context: { userId: owner.userId },
            conversation: { conversationId: 'conversation-one' },
            initialAgentId: 'agent-one',
            messages: [],
          }),
        ).toMatchObject({ ok: false });
      }
    }),
);

it('only enters the private phase through receipt admission and cancels prepared private work', () =>
  scoped(async () => {
    const running = await runningForReview();
    expect(
      await Reflect.apply(storage.publishProgress, storage, [
        { ...(await storage.read(owner, oneId))!, revision: running.revision },
        {
          status: 'materializing',
          responseJSON: '{}',
        },
      ]),
    ).toMatchObject({ ok: false });
    const receipt = { ...outcome, turnJSON: '{"version":1,"inputs":[]}' };
    const prepared = await storage.prepareTerminal(owner, oneId, { execution: running }, receipt);
    if (!prepared.ok) throw new Error('Preparation failed');
    expect(await storage.requestCancellation(owner, oneId, 123)).toMatchObject({
      status: 'materializing',
      cancellationRequestedAt: 123,
    });
    expect(
      await storage.stageTerminal(owner, oneId, { execution: running }, receipt, {
        receipt,
      }),
    ).toMatchObject({ ok: false });
    const cancelled = {
      ...receipt,
      status: 'cancelled' as const,
      responseJSON: '{"cancelled":true}',
    };
    const staged = await storage.stageTerminal(owner, oneId, { execution: running }, cancelled, {
      receipt,
      cancellationRequestedAt: 123,
    });
    expect(staged).toMatchObject({
      ok: true,
      record: { status: 'materializing', pendingTerminal: cancelled },
    });
  }));

it('closes and cooperatively cancels private prepared work while retaining redacted cleanup identity', () =>
  scoped(async () => {
    const running = await runningForReview();
    const receipt = { ...outcome, turnJSON: '{"version":1,"inputs":[],"private":"history"}' };
    expect((await storage.prepareTerminal(owner, oneId, { execution: running }, receipt)).ok).toBe(
      true,
    );
    await closeResponseScopes(mongoose, owner, ['conversation-one']);
    expect(await storage.read(owner, oneId)).toBeNull();
    const raw = await mongoose.models.StoredResponse.findOne({
      responseId: oneId,
    }).lean<StoredResponseRecord>();
    expect(raw).toMatchObject({
      status: 'materializing',
      cancellationRequestedAt: expect.any(Number),
    });
    expect(await storage.readCleanupIdentity(owner, oneId)).toMatchObject({
      retirement: 'conversation_deleted',
    });
    expect(JSON.stringify(await storage.readCleanupIdentity(owner, oneId))).not.toContain(
      'history',
    );
    expect(
      await storage.stageTerminal(owner, oneId, { execution: running }, receipt, {
        receipt,
        cancellationRequestedAt: raw!.cancellationRequestedAt,
      }),
    ).toMatchObject({ ok: false });
    await expect(
      eraseResponseRecords(mongoose, owner, ['conversation-one']),
    ).rejects.toBeInstanceOf(ResponseErasurePendingError);
    const retained = await mongoose.models.StoredResponse.collection.findOne({ responseId: oneId });
    expect(retained).toMatchObject({ _managed: { phase: 'retired' } });
    for (const field of ['requestJSON', 'responseJSON', 'review', 'resume', 'preparedTerminal'])
      expect(retained).not.toHaveProperty(field);
    expect(await storage.readCleanupIdentity(owner, oneId)).toMatchObject({
      retirement: 'conversation_deleted',
    });
  }));

it.each(['live', 'expired', 'closed'] as const)(
  'returns immutable cleanup binding metadata without payload for %s rows',
  (state) =>
    scoped(async () => {
      await storage.reserve(reservation({ sourceKeyId: 'run-key' }));
      if (state === 'expired')
        await createResponseRetention(mongoose)(owner, 'conversation-one', new Date(0));
      if (state === 'closed') await closeResponseScopes(mongoose, owner, ['conversation-one']);
      const identity = await storage.readCleanupIdentity(owner, oneId);
      expect(identity).toMatchObject({
        requestKey: 'request-one',
        sourceKeyId: 'run-key',
        parentMessageId: 'root',
      });
      expect(identity).not.toHaveProperty('requestJSON');
      expect(identity).not.toHaveProperty('responseJSON');
      expect(JSON.stringify(identity)).not.toContain('Hello');
    }),
);

it('atomically reserves a dispatch outbox and exposes only bounded maintenance identity', () =>
  scoped(async () => {
    const result = await storage.reserve({ ...reservation(), dispatch: true });
    expect(result).toMatchObject({
      ok: true,
      record: { dispatchOutbox: { kind: 'create', id: oneId, state: 'pending' } },
    });
    const page = await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1));
    expect(page.responses).toEqual([
      {
        ...owner,
        responseId: oneId,
        storageTarget: (await storage.read(owner, oneId))?.storageTarget,
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('Hello');
    expect(JSON.stringify(page)).not.toContain('requestJSON');
    expect(await storage.settleDispatch(owner, oneId, { kind: 'create', id: 'wrong' })).toBe(false);
    expect(await storage.settleDispatch(owner, oneId, { kind: 'create', id: oneId })).toBe(true);
    expect(
      (await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1))).responses.map(
        (row) => row.responseId,
      ),
    ).toEqual([oneId]);
  }));

it('fences late create acknowledgements from a newer resume and does not bump execution revision', () =>
  scoped(async () => {
    await pause();
    const reserved = await storage.reserveResume(owner, oneId, resume(), 100);
    expect(reserved.ok).toBe(true);
    const before = (await storage.read(owner, oneId))!;
    expect(before.dispatchOutbox).toEqual({ kind: 'resume', id: 'intent-one', state: 'pending' });
    expect(await storage.settleDispatch(owner, oneId, { kind: 'create', id: oneId })).toBe(false);
    expect(await storage.settleDispatch(owner, oneId, { kind: 'resume', id: 'wrong' })).toBe(false);
    expect((await storage.read(owner, oneId))!.dispatchOutbox).toEqual(before.dispatchOutbox);
    expect(await storage.settleDispatch(owner, oneId, { kind: 'resume', id: 'intent-one' })).toBe(
      true,
    );
    expect((await storage.read(owner, oneId))!.revision).toBe(before.revision);
    expect(
      (await runAsSystem(() => storage.listRecoveryCandidates(undefined, 10))).responses.map(
        (row) => row.responseId,
      ),
    ).toEqual([oneId]);
  }));

it('recovers pending dispatch tokens without acknowledging another tenant or closed scope', () =>
  scoped(async () => {
    await storage.reserve(reservation({ dispatch: true }));
    const page = await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1));
    expect(page.responses).toEqual([
      {
        ...owner,
        responseId: oneId,
        storageTarget: (await storage.read(owner, oneId))?.storageTarget,
      },
    ]);
    await expect(storage.listRecoveryCandidates(undefined, 1)).rejects.toThrow('system');
    await expect(runAsSystem(() => storage.listRecoveryCandidates(undefined, 0))).rejects.toThrow(
      'page',
    );
    await expect(runAsSystem(() => storage.listRecoveryCandidates('invalid', 1))).rejects.toThrow(
      'cursor',
    );
    await closeResponseScopes(mongoose, owner, ['conversation-one']);
    expect(await storage.settleDispatch(owner, oneId, { kind: 'create', id: oneId })).toBe(false);
  }));

it('does not repair an inconsistent resume marker from an earlier create', () =>
  scoped(async () => {
    await pause();
    await storage.reserveResume(owner, oneId, resume(), 100);
    await mongoose.models.StoredResponse.updateOne(
      { responseId: oneId },
      { $set: { dispatchOutbox: { kind: 'create', id: oneId, state: 'settled' } } },
    );
    expect(
      (await runAsSystem(() => storage.listRecoveryCandidates(undefined, 10))).responses.map(
        (row) => row.responseId,
      ),
    ).toEqual([oneId]);
    expect(await storage.settleDispatch(owner, oneId, { kind: 'resume', id: 'intent-one' })).toBe(
      false,
    );
  }));

it('bounds metadata pages across named and default tenants including expired cleanup authority', async () => {
  for (let i = 0; i < 4; i++) {
    const tenantId = i % 2 ? undefined : owner.tenantId;
    await tenantStorage.run({ tenantId }, () =>
      storage.reserve(
        reservation({
          tenantId,
          responseId: pageResponseIds[i],
          requestKey: 'page-' + i,
          dispatch: true,
        }),
      ),
    );
  }
  const expiredId = createManagedMessageId();
  await scoped(() =>
    storage.reserve(
      reservation({
        responseId: expiredId,
        requestKey: 'expired',
        conversationId: 'expired-conversation',
        expiredAt: new Date(Date.now() + 60000),
        dispatch: true,
      }),
    ),
  );
  await scoped(() =>
    mongoose.models.StoredResponse.updateOne(
      { responseId: expiredId },
      { $set: { expiredAt: new Date(0) } },
    ),
  );
  const found: Array<{ tenantId?: string; userId: string; responseId: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await runAsSystem(() => storage.listRecoveryCandidates(cursor, 1));
    expect(page.responses.length).toBeLessThanOrEqual(1);
    found.push(...page.responses);
    cursor = page.next;
  } while (cursor);
  expect(found.map((row) => row.responseId).sort()).toEqual([...pageResponseIds, expiredId].sort());
  expect(new Set(found.map((row) => row.tenantId))).toEqual(new Set([undefined, owner.tenantId]));
});

it('cannot overwrite a concurrently reserved resume with a late create acknowledgement', () =>
  scoped(async () => {
    await pause();
    const results = await Promise.all([
      storage.settleDispatch(owner, oneId, { kind: 'create', id: oneId }),
      storage.reserveResume(owner, oneId, resume(), 100),
    ]);
    expect(results[1]).toMatchObject({ ok: true });
    expect((await storage.read(owner, oneId))!.dispatchOutbox).toEqual({
      kind: 'resume',
      id: 'intent-one',
      state: 'pending',
    });
  }));

it('does not adopt a replacement root through an earlier maintenance page', () =>
  scoped(async () => {
    const first = await storage.reserve({ ...reservation(), dispatch: true });
    if (!first.ok) throw new Error('Reservation failed');
    const page = await runAsSystem(() => storage.listRecoveryCandidates(undefined, 1));
    expect(page.responses[0]?.storageTarget).toEqual(first.record.storageTarget);
    await mongoose.models.StoredResponse.deleteOne({ responseId: oneId });
    const replacement = await storage.reserve({ ...reservation(), dispatch: true });
    if (!replacement.ok) throw new Error('Replacement failed');
    expect(replacement.record.storageTarget?.id).not.toBe(first.record.storageTarget?.id);
    expect(await storage.read(page.responses[0], oneId)).toBeNull();
    expect((await storage.read(owner, oneId))?.storageTarget).toEqual(
      replacement.record.storageTarget,
    );
  }));

it('keeps the account and typed deletion status while a Response provider is still active', () =>
  scoped(async () => {
    const user = await mongoose.models.User.create({
      email: 'pending-response-owner@example.test',
      provider: 'local',
      tenantId: owner.tenantId,
    });
    const principal = { userId: String(user._id), tenantId: owner.tenantId };
    const reserved = await storage.reserve(reservation(principal));
    if (!reserved.ok) throw new Error('Reservation failed');
    const enrolled = await storage.enrollExecution(
      reserved.record,
      { generationCreatedAt: 100, providerExecutionId: 'active-provider' },
      '{}',
    );
    if (!enrolled.ok) throw new Error('Enrollment failed');
    await expect(
      createUserMethods(mongoose).deleteUserById(principal.userId),
    ).rejects.toMatchObject({ code: 'response_erasure_pending' });
    expect(await mongoose.models.User.exists({ _id: user._id })).not.toBeNull();
    const retained = await includeManagedAllocations(
      mongoose.models.StoredResponse.findOne({ responseId: oneId })
        .select('+providerExecution')
        .lean(),
    );
    expect(retained).not.toHaveProperty('requestJSON');
    expect(retained).not.toHaveProperty('responseJSON');
    expect(retained).toHaveProperty('providerExecution.id', 'active-provider');
  }));
