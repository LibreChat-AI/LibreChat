import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type { ConnectionBinding, Connections } from './connection';
import type { ConnectionRecord } from '~/models/connection';
import { runAsSystem, tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { createConnections } from './connection';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const DB_SETUP_TIMEOUT_MS = 60_000;
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let server: MongoMemoryServer;
let Connection: Model<ConnectionRecord>;
let connections: Connections;

const as = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantStorage.run({ tenantId }, fn);

/** Every stored row, whichever tenant holds it, oldest first. */
const stored = (): Promise<ConnectionRecord[]> =>
  runAsSystem(async () => Connection.find({}).sort({ createdAt: 1 }).lean<ConnectionRecord[]>());

const install = (overrides: Partial<ConnectionBinding> = {}): ConnectionBinding => ({
  provider: 'github',
  installation: '1001',
  account: { id: '77', name: 'octo' },
  createdBy: 'user-1',
  ...overrides,
});

async function bound(tenantId: string, binding: ConnectionBinding = install()) {
  const result = await as(tenantId, async () => connections.bind(binding));
  if (!result.ok) throw new Error(`bind refused: ${result.error.code}`);
  return result.value;
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, DB_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  // Built for each test, model included, so a test that reads through the store also covers
  // how the store and the collection's schema are made.
  if (mongoose.models.AgentEventConnection) mongoose.deleteModel('AgentEventConnection');
  connections = createConnections(mongoose);
  Connection = mongoose.models.AgentEventConnection as Model<ConnectionRecord>;
  await runAsSystem(async () => Connection.deleteMany({}));
});

describe('bind', () => {
  it('stores an active connection for the calling tenant', async () => {
    const connection = await bound(TENANT_A);

    expect(connection).toEqual({
      id: expect.stringMatching(/^conn_[0-9a-f-]{36}$/),
      tenantId: TENANT_A,
      provider: 'github',
      installation: '1001',
      account: { id: '77', name: 'octo' },
      status: 'active',
      createdBy: 'user-1',
    });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: connection.id, tenantId: TENANT_A, status: 'active' });
  });

  it('gives each install its own id', async () => {
    const first = await bound(TENANT_A);
    const second = await bound(TENANT_A, install({ installation: '1002' }));

    expect(second.id).not.toBe(first.id);
    expect(await stored()).toHaveLength(2);
  });

  it('refreshes the account when the same tenant binds the install again', async () => {
    // Bound between two others, so neither the oldest nor the newest row is the one meant.
    const older = await bound(TENANT_A, install({ installation: '1000' }));
    const first = await bound(TENANT_A);
    const newer = await bound(TENANT_A, install({ installation: '1002' }));
    await as(TENANT_A, async () => connections.mark(first.id, 'suspended'));

    const again = await bound(
      TENANT_A,
      install({ account: { id: '77', name: 'octo-renamed' }, createdBy: 'user-2' }),
    );

    // The id, the provider's hold and the first binder all survive a second bind.
    expect(again).toEqual({
      ...first,
      account: { id: '77', name: 'octo-renamed' },
      status: 'suspended',
    });
    expect(await as(TENANT_A, async () => connections.get(older.id))).toEqual(older);
    expect(await as(TENANT_A, async () => connections.get(newer.id))).toEqual(newer);
    expect(await stored()).toHaveLength(3);
  });

  it('holds a second bind to the same checks as the first', async () => {
    const first = await bound(TENANT_A);

    await expect(
      as(TENANT_A, async () => connections.bind(install({ account: { id: '77', name: '' } }))),
    ).rejects.toThrow(/account\.name/);
    expect(await as(TENANT_A, async () => connections.get(first.id))).toEqual(first);
  });

  it('refuses an install another tenant holds and leaves that tenant its record', async () => {
    const held = await bound(TENANT_A);

    const result = await as(TENANT_B, async () =>
      connections.bind(install({ account: { id: '77', name: 'hijack' }, createdBy: 'user-9' })),
    );

    expect(result).toEqual({ ok: false, error: { code: 'taken' } });
    expect(await as(TENANT_A, async () => connections.get(held.id))).toEqual(held);
    expect(await stored()).toHaveLength(1);
  });

  it('treats the same install id under another provider as a different install', async () => {
    await bound(TENANT_A);
    // Only one provider exists yet, so the other provider's row is written past the schema.
    await Connection.collection.updateOne({}, { $set: { provider: 'other' } });

    const mine = await bound(TENANT_B);
    expect(mine.tenantId).toBe(TENANT_B);
    expect(await stored()).toHaveLength(2);
  });

  it('settles concurrent binds of one install by one tenant on a single connection', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => as(TENANT_A, async () => connections.bind(install()))),
    );

    const ids = new Set(results.map((result) => (result.ok ? result.value.id : result.error.code)));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^conn_/);
    expect(await stored()).toHaveLength(1);
  });

  it.each([
    ['a caller with no tenant, of an install a tenant holds', TENANT_A, undefined],
    ['a tenant, of an install held with no tenant', undefined, TENANT_B],
  ])('refuses a bind by %s', async (_name, holder, caller) => {
    const scoped = <T>(tenantId: string | undefined, fn: () => Promise<T>) =>
      tenantId == null ? fn() : as(tenantId, fn);
    const held = await scoped(holder, async () => connections.bind(install()));

    const result = await scoped(caller, async () =>
      connections.bind(install({ account: { id: '77', name: 'hijack' } })),
    );

    expect(result).toEqual({ ok: false, error: { code: 'taken' } });
    expect(await connections.resolve({ provider: 'github', installation: '1001' })).toEqual(
      held.ok && held.value,
    );
  });

  it('refreshes a connection with no tenant when it is bound again with none', async () => {
    const first = await connections.bind(install());

    const again = await connections.bind(install({ account: { id: '77', name: 'renamed' } }));

    expect(again).toEqual({
      ok: true,
      value: { ...(first.ok && first.value), account: { id: '77', name: 'renamed' } },
    });
    expect(await stored()).toHaveLength(1);
  });

  it('stores a connection without a tenant where there is none', async () => {
    const result = await connections.bind(install());

    expect(result.ok).toBe(true);
    expect(result.ok && 'tenantId' in result.value).toBe(false);
    const [row] = await stored();
    expect(row.tenantId).toBeUndefined();
  });

  it('refuses to bind from the cross-tenant system scope', async () => {
    await expect(
      tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, async () => connections.bind(install())),
    ).rejects.toThrow('Binding a connection requires a tenant scope');
    expect(await stored()).toHaveLength(0);
  });

  it.each([
    ['a provider it does not know', install({ provider: 'linear' as 'github' }), /provider/],
    ['a bind with no provider', install({ provider: undefined }), /provider/],
    ['an install with no id', install({ installation: '' }), /installation/],
    ['an account with no id', install({ account: { id: '', name: 'octo' } }), /account\.id/],
    ['an account with no name', install({ account: { id: '77', name: '' } }), /account\.name/],
    ['a bind with no binder', install({ createdBy: '' }), /createdBy/],
  ])('refuses %s', async (_name, binding, path) => {
    await expect(as(TENANT_A, async () => connections.bind(binding))).rejects.toThrow(path);
    expect(await stored()).toHaveLength(0);
  });

  it('builds the indexes that decide a bind where automatic indexing is off', async () => {
    const manual = new mongoose.Mongoose();
    manual.set('autoIndex', false);
    await manual.connect(server.getUri(), { dbName: 'manual-indexes' });
    try {
      const store = createConnections(manual);
      const first = await tenantStorage.run({ tenantId: TENANT_A }, async () =>
        store.bind(install()),
      );
      const second = await tenantStorage.run({ tenantId: TENANT_B }, async () =>
        store.bind(install()),
      );

      expect(first.ok).toBe(true);
      expect(second).toEqual({ ok: false, error: { code: 'taken' } });
    } finally {
      await manual.connection.dropDatabase();
      await manual.disconnect();
    }
  });
});

describe('the collection', () => {
  const row = {
    id: 'conn_1',
    provider: 'github',
    installation: '1001',
    account: { id: '77', name: 'octo' },
    status: 'active',
    createdBy: 'user-1',
  };

  it('accepts a whole row', async () => {
    await expect(new Connection(row).validate()).resolves.toBeUndefined();
  });

  // The store always supplies these, so only a write that goes around it can leave one out.
  it.each(['id', 'status'] as const)('refuses a row with no %s', async (field) => {
    await expect(new Connection({ ...row, [field]: undefined }).validate()).rejects.toThrow(
      new RegExp(`\\b${field}\\b`),
    );
  });
});

describe('indexes', () => {
  it('are the three the reads and the bind rely on', async () => {
    await Connection.createIndexes();
    const indexes = await Connection.listIndexes();

    expect(
      indexes
        .filter((index) => index.name !== '_id_')
        .map(({ key, unique }) => ({ key, unique: unique === true })),
    ).toEqual([
      { key: { id: 1 }, unique: true },
      { key: { provider: 1, installation: 1 }, unique: true },
      { key: { tenantId: 1, createdAt: -1 }, unique: false },
    ]);
  });
});

describe('get', () => {
  it("reads the calling tenant's connection and not another tenant's", async () => {
    const mine = await bound(TENANT_A);

    expect(await as(TENANT_A, async () => connections.get(mine.id))).toEqual(mine);
    expect(await as(TENANT_B, async () => connections.get(mine.id))).toBeNull();
  });

  it('answers null for an id nothing has', async () => {
    await bound(TENANT_A);

    expect(await as(TENANT_A, async () => connections.get('conn_none'))).toBeNull();
  });
});

describe('list', () => {
  it("lists the calling tenant's connections, newest first", async () => {
    const older = await bound(TENANT_A, install({ installation: '1' }));
    const newer = await bound(TENANT_A, install({ installation: '2' }));
    await bound(TENANT_B, install({ installation: '3' }));
    await Connection.collection.updateOne(
      { id: older.id },
      { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } },
    );

    expect(await as(TENANT_A, async () => connections.list())).toEqual([newer, older]);
    expect(await as(TENANT_B, async () => connections.list())).toHaveLength(1);
  });

  it('orders by its own sort, not by the index that happens to serve it', async () => {
    const older = await bound(TENANT_A, install({ installation: '1' }));
    const newer = await bound(TENANT_A, install({ installation: '2' }));
    await Connection.collection.updateOne(
      { id: older.id },
      { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } },
    );
    await Connection.init();
    await Connection.collection.dropIndex('tenantId_1_createdAt_-1');

    expect(await as(TENANT_A, async () => connections.list())).toEqual([newer, older]);
  });

  it('is empty for a tenant with none', async () => {
    await bound(TENANT_A);

    expect(await as(TENANT_B, async () => connections.list())).toEqual([]);
  });
});

describe('resolve', () => {
  it('finds a connection by id or by install, whichever tenant holds it', async () => {
    const held = await bound(TENANT_A);
    await bound(TENANT_B, install({ installation: '2002' }));

    expect(await connections.resolve({ id: held.id })).toEqual(held);
    expect(await connections.resolve({ provider: 'github', installation: '1001' })).toEqual(held);
    // A caller inside another tenant's scope still resolves it: this read finds the tenant.
    expect(await as(TENANT_B, async () => connections.resolve({ id: held.id }))).toEqual(held);
  });

  it('answers null when nothing holds the ref', async () => {
    await bound(TENANT_A);

    expect(await connections.resolve({ id: 'conn_none' })).toBeNull();
    expect(await connections.resolve({ provider: 'github', installation: '9' })).toBeNull();
  });

  it('reads the install of the provider named, not of any provider', async () => {
    const held = await bound(TENANT_A);
    await Connection.collection.updateOne({ id: held.id }, { $set: { provider: 'other' } });

    expect(await connections.resolve({ provider: 'github', installation: '1001' })).toBeNull();
  });

  describe('where every read must name a tenant', () => {
    const original = process.env.TENANT_ISOLATION_STRICT;

    beforeEach(() => {
      process.env.TENANT_ISOLATION_STRICT = 'true';
      _resetStrictCache();
    });

    afterEach(() => {
      if (original === undefined) delete process.env.TENANT_ISOLATION_STRICT;
      else process.env.TENANT_ISOLATION_STRICT = original;
      _resetStrictCache();
    });

    it('resolves with no tenant in scope, while a scoped read is refused', async () => {
      const held = await bound(TENANT_A);

      expect(await connections.resolve({ id: held.id })).toEqual(held);
      await expect(connections.get(held.id)).rejects.toThrow(
        /Connection attempted without tenant context/,
      );
    });
  });
});

describe('mark', () => {
  it("records the provider's hold and its release", async () => {
    const held = await bound(TENANT_A);

    expect(await as(TENANT_A, async () => connections.mark(held.id, 'suspended'))).toEqual({
      ...held,
      status: 'suspended',
    });
    expect(await as(TENANT_A, async () => connections.mark(held.id, 'active'))).toEqual(held);
  });

  it("does not reach another tenant's connection", async () => {
    const held = await bound(TENANT_A);

    expect(await as(TENANT_B, async () => connections.mark(held.id, 'suspended'))).toBeNull();
    expect(await as(TENANT_A, async () => connections.get(held.id))).toEqual(held);
  });

  it('answers null for an id nothing has', async () => {
    expect(await as(TENANT_A, async () => connections.mark('conn_none', 'suspended'))).toBeNull();
  });

  it('refuses a status there is not', async () => {
    const held = await bound(TENANT_A);

    await expect(
      as(TENANT_A, async () => connections.mark(held.id, 'removed' as 'active')),
    ).rejects.toThrow(/status/);
    expect(await as(TENANT_A, async () => connections.get(held.id))).toEqual(held);
  });
});

describe('a caller with no tenant', () => {
  it("is not shown a tenant's connection, and cannot change or delete it", async () => {
    const held = await bound(TENANT_A);

    expect(await connections.get(held.id)).toBeNull();
    expect(await connections.list()).toEqual([]);
    expect(await connections.mark(held.id, 'suspended')).toBeNull();
    expect(await connections.remove(held.id)).toBe(false);
    expect(await runAsSystem(async () => connections.get(held.id))).toBeNull();
    expect(await as(TENANT_A, async () => connections.get(held.id))).toEqual(held);
  });

  it('reads, marks and removes a connection that has none', async () => {
    await bound(TENANT_A);
    const result = await connections.bind(install({ installation: '2002' }));
    const loose = result.ok ? result.value : undefined;
    if (loose == null) throw new Error('bind refused');

    expect(await connections.get(loose.id)).toEqual(loose);
    expect(await connections.list()).toEqual([loose]);
    expect(await connections.mark(loose.id, 'suspended')).toEqual({
      ...loose,
      status: 'suspended',
    });
    expect(await as(TENANT_A, async () => connections.get(loose.id))).toBeNull();
    expect(await connections.remove(loose.id)).toBe(true);
    expect(await stored()).toHaveLength(1);
  });
});

describe('remove', () => {
  it('deletes the record, after which the install can be bound afresh', async () => {
    const held = await bound(TENANT_A);

    expect(await as(TENANT_A, async () => connections.remove(held.id))).toBe(true);
    expect(await stored()).toHaveLength(0);

    const next = await bound(TENANT_B);
    expect(next.id).not.toBe(held.id);
    expect(next.tenantId).toBe(TENANT_B);
  });

  it("does not delete another tenant's connection", async () => {
    const held = await bound(TENANT_A);

    expect(await as(TENANT_B, async () => connections.remove(held.id))).toBe(false);
    expect(await stored()).toHaveLength(1);
  });

  it('answers false for an id nothing has', async () => {
    await bound(TENANT_A);

    expect(await as(TENANT_A, async () => connections.remove('conn_none'))).toBe(false);
    expect(await stored()).toHaveLength(1);
  });
});
