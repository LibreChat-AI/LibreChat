import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createResponseStorage,
  responseReference,
  tenantStorage,
  runAsSystem,
  getTenantId,
  SYSTEM_TENANT_ID,
  createManagedConversationId,
} from '@librechat/data-schemas';
import type { ResponseOwner, StoredResponseRecord, ResponseStorage } from '@librechat/data-schemas';
import {
  createResponseCompletion,
  createResponseExecutionRelease,
  createResponseExecutionConfirmation,
} from './completion';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { cleanupResponseCheckpoint } from './checkpoint';
import { createResponseDispatchOutbox } from './outbox';
import { backgroundResponseDeliveryKey } from './queue';
import { createResponseRetirement } from './retirement';
import { createResponseRecovery } from './maintenance';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let jobs: GenerationJobManagerClass;
const managedId = (label: string) =>
  'resp_d_' + createHash('sha256').update(label).digest('hex').slice(0, 32);
const owner: ResponseOwner = { userId: 'owner', tenantId: 'named' };
const scoped = <T>(principal: ResponseOwner, fn: () => Promise<T>) =>
  tenantStorage.run({ tenantId: principal.tenantId }, fn);
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
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  jobs.initialize();
  await runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  });
});
afterEach(async () => {
  await jobs.destroy();
});
async function reserve(label: string, principal = owner, dispatch = true, background = true) {
  const id = managedId(label);
  const result = await scoped(principal, () =>
    storage.reserve({
      ...principal,
      responseId: id,
      requestKey: id,
      fingerprint: id,
      agentId: 'agent',
      requestJSON: JSON.stringify({
        model: 'agent',
        input: 'private fixture request',
        background,
        store: true,
      }),
      conversationId: createManagedConversationId(),
      parentMessageId: 'root',
      dispatch,
    }),
  );
  if (!result.ok) throw new Error('Fixture reservation failed');
  return result.record;
}
function fixture() {
  let ready = true;
  let fail: string | undefined;
  const published = new Map<string, string>();
  const enqueue = jest.fn(async (record: StoredResponseRecord) => {
    expect(getTenantId()).toBe(record.tenantId || undefined);
    if (record.responseId === fail) throw new Error('Fixture publication unavailable');
    published.set(backgroundResponseDeliveryKey(record), record.responseId);
  });
  const contexts: Array<{ kind: string; tenantId?: string }> = [];
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'listRecoveryCandidates')
        return async (...args: Parameters<ResponseStorage['listRecoveryCandidates']>) => {
          contexts.push({ kind: 'metadata', tenantId: getTenantId() });
          expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
          return target.listRecoveryCandidates(...args);
        };
      if (property === 'read')
        return async (principal: ResponseOwner, id: string) => {
          contexts.push({ kind: 'record', tenantId: getTenantId() });
          expect(getTenantId()).toBe(principal.tenantId || undefined);
          expect(getTenantId()).not.toBe(SYSTEM_TENANT_ID);
          return target.read(principal, id);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const completion = createResponseCompletion({
    storage,
    cleanupCheckpoint: cleanupResponseCheckpoint,
    confirmExecution: createResponseExecutionConfirmation(storage, jobs),
    releaseExecution: createResponseExecutionRelease(jobs, storage),
  });
  const stop = createResponseRetirement({
    storage,
    jobs,
    cleanupCheckpoint: cleanupResponseCheckpoint,
  });
  const retire = jest.fn((record: ResponseOwner & { responseId: string }) =>
    stop(record, record.responseId),
  );
  const onError = jest.fn();
  const deps = {
    storage: proxy,
    create: { enqueue, deliveryKey: backgroundResponseDeliveryKey },
    authorize: async (record: StoredResponseRecord) => record.responseId !== managedId('denied'),
    recover: createResponseRecovery({ storage, jobs, completion }),
    retire,
    onError,
    isReady: () => ready,
  };
  return {
    outbox: createResponseDispatchOutbox(deps),
    deps,
    contexts,
    published,
    enqueue,
    retire,
    onError,
    setReady: (value: boolean) => {
      ready = value;
    },
    setFailure: (id?: string) => {
      fail = id == null ? undefined : managedId(id);
    },
  };
}

it('uses bounded pages and canonical tenant contexts without a failed first intent starving later work', async () => {
  for (let i = 0; i < 5; i++)
    await reserve('record-' + i, i % 2 ? { userId: 'default-owner' } : owner);
  const f = fixture();
  f.setFailure('record-0');
  for (let i = 0; i < 5; i++) await f.outbox.recoverPending(1, { found: false });
  expect([...f.published.values()].sort()).toEqual(
    ['record-1', 'record-2', 'record-3', 'record-4'].map(managedId).sort(),
  );
  expect(f.onError).toHaveBeenCalledTimes(1);
  f.setFailure();
  await f.outbox.recoverPending(1, { found: false });
  expect(f.published.size).toBe(5);
  expect(new Set(f.contexts.filter((x) => x.kind === 'record').map((x) => x.tenantId))).toEqual(
    new Set(['named', undefined]),
  );
  const remaining = await runAsSystem(() => storage.listRecoveryCandidates(undefined, 10));
  expect(remaining.responses).toHaveLength(5);
  for (const record of remaining.responses)
    expect(
      (await scoped(record, () => storage.read(record, record.responseId)))?.dispatchOutbox?.state,
    ).toBe('settled');
});

it('preserves immutable delivery identity under concurrent inline/recovery-style publishers', async () => {
  const record = await reserve('concurrent');
  const first = fixture();
  const second = createResponseDispatchOutbox(first.deps);
  await Promise.all([
    first.outbox.recoverPending(5, { found: false }),
    second.recoverPending(5, { found: false }),
  ]);
  expect(first.published.size).toBe(1);
  expect([...first.published.keys()]).toEqual([backgroundResponseDeliveryKey(record)]);
  const count = first.enqueue.mock.calls.length;
  await first.outbox.recoverPending(5, { found: false });
  expect(first.enqueue).toHaveBeenCalledTimes(count);
});

it('retires denied or cancelled work and never executes expired or closed scopes', async () => {
  await reserve('denied');
  const cancelled = await reserve('cancelled');
  await scoped(owner, () => storage.requestCancellation(owner, cancelled.responseId, Date.now()));
  const existingScopes = await mongoose.models.ResponseScope.distinct('_id');
  await reserve('closed');
  await mongoose.models.ResponseScope.updateMany(
    { _id: { $nin: existingScopes } },
    { $set: { closed: true } },
  );
  await reserve('expired');
  await runAsSystem(() =>
    mongoose.models.StoredResponse.updateOne(
      { responseId: managedId('expired') },
      { $set: { expiredAt: new Date(0) } },
    ),
  );
  const f = fixture();
  await f.outbox.recoverPending(10, { found: false });
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.retire.mock.calls.map(([record]) => record.responseId).sort()).toEqual(
    ['cancelled', 'denied', 'closed', 'expired'].map(managedId).sort(),
  );
  expect(f.onError).not.toHaveBeenCalled();
});

it('leaves unready publication untouched and ignores records without a dispatch token', async () => {
  await reserve('legacy', owner, false);
  await reserve('foreground', owner, false, false);
  const f = fixture();
  f.setReady(false);
  await f.outbox.recoverPending(5, { found: false });
  expect(f.contexts).toEqual([]);
  f.setReady(true);
  await f.outbox.recoverPending(5, { found: false });
  expect([...f.published.values()]).toEqual([]);
  expect(
    (await scoped(owner, () => storage.read(owner, managedId('foreground'))))?.dispatchOutbox,
  ).toBeUndefined();
});

it('fails closed on unknown future dispatch formats', async () => {
  await reserve('future');
  await mongoose.models.StoredResponse.collection.updateOne(
    { responseId: managedId('future') },
    { $set: { dispatchOutbox: { kind: 'future', id: 'future', state: 'pending' } } },
  );
  const f = fixture();
  await f.outbox.recoverPending(5, { found: false });
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(
    await scoped(owner, () =>
      storage.settleDispatch(owner, managedId('future'), {
        kind: 'create',
        id: managedId('future'),
      }),
    ),
  ).toBe(false);
});

it('settles a consumed resume after another pause without enqueueing it again', async () => {
  await scoped(owner, async () => {
    const record = await reserve('pause-before-ack');
    const started = await storage.enrollExecution(
      record,
      { generationCreatedAt: 10, providerExecutionId: 'provider-one' },
      '{}',
    );
    if (!started.ok) throw new Error('Fixture start failed');
    const review = {
      actionId: 'first',
      providerExecutionId: 'provider-one',
      expiresAt: 1000,
      partialResponseJSON: '{}',
    };
    const paused = await storage.publishReview(
      owner,
      record.responseId,
      { execution: started.record },
      10,
      review,
      '{}',
    );
    expect(paused.ok).toBe(true);
    expect(
      (
        await storage.reserveResume(
          owner,
          record.responseId,
          {
            generationCreatedAt: 10,
            intentId: 'resume-one',
            actionId: 'first',
            previousProviderExecutionId: 'provider-one',
            providerExecutionId: 'provider-two',
            fingerprint: 'approved',
            resolutionJSON: '{}',
          },
          100,
        )
      ).ok,
    ).toBe(true);
    const admitted = await storage.admitResume(
      owner,
      record.responseId,
      'resume-one',
      10,
      'provider-two',
      '{}',
      101,
    );
    if (!admitted.ok) throw new Error('Fixture resume admission failed');
    if (
      !(await storage.settleExecution(responseReference(started.record), {
        generationCreatedAt: 10,
        providerExecutionId: 'provider-one',
      }))
    )
      throw new Error('Fixture provider settlement failed');
    if (
      !(
        await storage.enrollExecution(
          admitted.record,
          { generationCreatedAt: 10, providerExecutionId: 'provider-two' },
          '{}',
        )
      ).ok
    )
      throw new Error('Fixture resume enrollment failed');
    const nextReview = { ...review, actionId: 'second', providerExecutionId: 'provider-two' };
    const pausedAgain = await storage.publishReview(
      owner,
      record.responseId,
      { execution: admitted.record },
      10,
      nextReview,
      '{}',
    );
    if (!pausedAgain.ok) throw new Error('Fixture second pause failed');
    expect(pausedAgain.record.resume).toBeUndefined();
    expect(pausedAgain.record.dispatchOutbox).toEqual({
      kind: 'resume',
      id: 'resume-one',
      state: 'pending',
    });
    const f = fixture();
    const resumeEnqueue = jest.fn();
    const outbox = createResponseDispatchOutbox({ ...f.deps, resume: { enqueue: resumeEnqueue } });
    expect(await outbox.recoverPending(10, { found: false })).toBe(1);
    expect(resumeEnqueue).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    const settled = (await storage.read(owner, record.responseId))!;
    expect(settled).toMatchObject({
      revision: pausedAgain.record.revision,
      status: 'requires_action',
      review: nextReview,
      dispatchOutbox: { kind: 'resume', id: 'resume-one', state: 'settled' },
    });
    expect(
      await storage.settleDispatch(owner, record.responseId, { kind: 'resume', id: 'resume-one' }),
    ).toBe(true);
    const activity = { found: false };
    expect(await outbox.recoverPending(10, activity)).toBe(0);
    expect(activity.found).toBe(true);
    expect(
      (
        await storage.reserveResume(
          owner,
          record.responseId,
          {
            generationCreatedAt: 10,
            intentId: 'resume-two',
            actionId: 'second',
            previousProviderExecutionId: 'provider-two',
            providerExecutionId: 'provider-three',
            fingerprint: 'approved-two',
            resolutionJSON: '{}',
          },
          102,
        )
      ).ok,
    ).toBe(true);
    expect(
      await storage.settleDispatch(owner, record.responseId, { kind: 'resume', id: 'resume-one' }),
    ).toBe(false);
    expect((await storage.read(owner, record.responseId))?.dispatchOutbox).toEqual({
      kind: 'resume',
      id: 'resume-two',
      state: 'pending',
    });
  });
});
