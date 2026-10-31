import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createResponseStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
  SYSTEM_TENANT_ID,
} from '@librechat/data-schemas';
import type { ResponseOwner, StoredResponseRecord, ResponseStorage } from '@librechat/data-schemas';
import { createResponseDispatchOutbox } from './outbox';
import { backgroundResponseDeliveryKey } from './queue';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
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
beforeEach(async () =>
  runAsSystem(async () => {
    await mongoose.models.StoredResponse.deleteMany({});
    await mongoose.models.ResponseScope?.deleteMany({});
  }),
);
async function reserve(id: string, principal = owner, dispatch = true, background = true) {
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
      conversationId: id,
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
      if (property === 'listPendingDispatches')
        return async (...args: Parameters<ResponseStorage['listPendingDispatches']>) => {
          contexts.push({ kind: 'metadata', tenantId: getTenantId() });
          expect(getTenantId()).toBe(SYSTEM_TENANT_ID);
          return target.listPendingDispatches(...args);
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
  const retire = jest.fn(async (record: StoredResponseRecord) => {
    const cancelled = await storage.requestCancellation(record, record.responseId, Date.now());
    if (!cancelled) return 'pending' as const;
    const result = await storage.publish(record, record.responseId, cancelled.revision, {
      status: 'cancelled',
      responseJSON: '{"status":"cancelled"}',
    });
    return result.ok ? ('stopped' as const) : ('pending' as const);
  });
  const onError = jest.fn();
  const deps = {
    storage: proxy,
    create: { enqueue, deliveryKey: backgroundResponseDeliveryKey },
    authorize: async (record: StoredResponseRecord) => record.responseId !== 'denied',
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
      fail = id;
    },
  };
}

it('uses bounded pages and canonical tenant contexts without a failed first intent starving later work', async () => {
  for (let i = 0; i < 5; i++)
    await reserve('record-' + i, i % 2 ? { userId: 'default-owner' } : owner);
  const f = fixture();
  f.setFailure('record-0');
  for (let i = 0; i < 5; i++) await f.outbox.recoverPending(1, { found: false });
  expect([...f.published.values()].sort()).toEqual([
    'record-1',
    'record-2',
    'record-3',
    'record-4',
  ]);
  expect(f.onError).toHaveBeenCalledTimes(1);
  f.setFailure();
  await f.outbox.recoverPending(1, { found: false });
  expect(f.published.size).toBe(5);
  expect(new Set(f.contexts.filter((x) => x.kind === 'record').map((x) => x.tenantId))).toEqual(
    new Set(['named', undefined]),
  );
  expect(
    (await runAsSystem(() => storage.listPendingDispatches(undefined, 10, false))).responses,
  ).toEqual([]);
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
      { responseId: 'expired' },
      { $set: { expiredAt: new Date(0) } },
    ),
  );
  const f = fixture();
  await f.outbox.recoverPending(10, { found: false });
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.retire.mock.calls.map(([record]) => record.responseId).sort()).toEqual([
    'cancelled',
    'denied',
  ]);
  expect(f.onError).not.toHaveBeenCalled();
});

it('leaves unready publication untouched and repairs legacy background reservations only', async () => {
  await reserve('legacy', owner, false);
  await reserve('foreground', owner, false, false);
  const f = fixture();
  f.setReady(false);
  await f.outbox.recoverPending(5, { found: false });
  expect(f.contexts).toEqual([]);
  f.setReady(true);
  await f.outbox.recoverPending(5, { found: false });
  expect([...f.published.values()]).toEqual(['legacy']);
  expect(
    (await scoped(owner, () => storage.read(owner, 'foreground')))?.dispatchOutbox,
  ).toBeUndefined();
});

it('fails closed on unknown future dispatch formats', async () => {
  await reserve('future');
  await mongoose.models.StoredResponse.collection.updateOne(
    { responseId: 'future' },
    { $set: { dispatchOutbox: { kind: 'future', id: 'future', state: 'pending' } } },
  );
  const f = fixture();
  await f.outbox.recoverPending(5, { found: false });
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(
    await scoped(owner, () =>
      storage.settleDispatch(owner, 'future', { kind: 'create', id: 'future' }),
    ),
  ).toBe(false);
});
