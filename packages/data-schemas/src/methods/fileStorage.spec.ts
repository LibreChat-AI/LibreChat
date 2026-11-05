import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FileStorageClaim, IMongoFile } from '~/types/file';
import type { AllMethods, FileStorageMethods } from './index';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileStorageMethods } from './fileStorage';
import { createModels } from '~/models';

let File: mongoose.Model<IMongoFile>;
let methods: FileStorageMethods;
let peer: FileStorageMethods;
let mongoServer: MongoMemoryServer;
let modelNames: string[];
const user = new mongoose.Types.ObjectId();
const updatedAt = new Date('2026-10-20T00:00:00Z');
const claim: FileStorageClaim = {
  file_id: 'storage-fence',
  userId: user.toString(),
  tenantId: 'tenant-a',
  token: 'owner-token',
};
const deletion = { ...claim, updatedAt };
const originalStrict = process.env.TENANT_ISOLATION_STRICT;

const seed = (overrides = {}) =>
  File.collection.insertOne({
    file_id: claim.file_id,
    user,
    tenantId: claim.tenantId,
    filename: 'notes.txt',
    filepath: '/uploads/notes.txt',
    type: 'text/plain',
    bytes: 100,
    source: 'local',
    createdAt: updatedAt,
    updatedAt,
    metadata: { futureField: 'preserve-me' },
    ...overrides,
  });
const read = () => File.collection.findOne({ file_id: claim.file_id, user });

beforeAll(async () => {
  delete process.env.TENANT_ISOLATION_STRICT;
  _resetStrictCache();
  mongoServer = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongoServer.getUri());
  const models = createModels(mongoose);
  modelNames = Object.keys(models);
  Object.assign(mongoose.models, models);
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  methods = createFileStorageMethods(mongoose);
  peer = createFileStorageMethods(mongoose);
}, 30_000);

beforeEach(async () => {
  await runAsSystem(() => File.deleteMany({}));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  for (const name of modelNames ?? []) delete mongoose.models[name];
  if (originalStrict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
  else process.env.TENANT_ISOLATION_STRICT = originalStrict;
  _resetStrictCache();
});

describe('file storage fence', () => {
  it('exports every storage claim method through the shared factory contract', () => {
    const publicMethods: Pick<AllMethods, keyof FileStorageMethods> = methods;
    expect(Object.keys(publicMethods)).toHaveLength(5);
  });
  it('retains every concurrent provisioning owner until release', async () => {
    await seed();
    const claims = ['code-a', 'code-b', 'search'].map((token) => ({ ...claim, token }));
    expect(await Promise.all(claims.map(methods.acquireFileProvision))).toEqual([true, true, true]);
    expect(await peer.acquireFileProvision(claims[0])).toBe(true);
    expect((await read())?.storageOperations?.provisioning?.sort()).toEqual([
      'code-a',
      'code-b',
      'search',
    ]);
    expect(await peer.acquireFileDeletion(deletion)).toBeNull();
    expect(await peer.releaseFileProvision({ ...claim, token: 'thief' })).toBe(true);
    expect((await read())?.storageOperations?.provisioning).toContain(claims[0].token);
    expect(await methods.releaseFileProvision(claims[0])).toBe(true);
    expect(await peer.acquireFileDeletion(deletion)).toBeNull();
    expect(await Promise.all(claims.slice(1).map(methods.releaseFileProvision))).toEqual([
      true,
      true,
    ]);
    expect(await peer.acquireFileDeletion(deletion)).toEqual({ resumed: false });
  });

  it('blocks provisioning when deletion wins first, without automatic takeover', async () => {
    await seed();
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
    expect(await peer.acquireFileProvision({ ...claim, token: 'late' })).toBe(false);
    expect(await peer.acquireFileDeletion({ ...deletion, token: 'other-delete' })).toBeNull();
    expect(await methods.acquireFileDeletion(deletion)).toBeNull();
    expect(
      await peer.releaseFileDeletion({ ...claim, token: 'thief', retainDeletion: false }),
    ).toBe(false);
    expect((await read())?.storageOperations).toEqual({
      deleting: claim.token,
      deletionPending: true,
    });
  });

  it('atomically chooses exactly one winner in a cross-factory provision/delete race', async () => {
    await seed();
    const [provisioned, deleted] = await Promise.all([
      methods.acquireFileProvision(claim),
      peer.acquireFileDeletion(deletion),
    ]);
    expect(Number(provisioned) + Number(deleted !== null)).toBe(1);
    const operations = (await read())?.storageOperations;
    if (provisioned) {
      expect(operations).toEqual({ provisioning: [claim.token] });
    } else {
      expect(operations).toEqual({ deleting: claim.token, deletionPending: true });
    }
  });

  it('admits only one of simultaneous delete claimants', async () => {
    await seed();
    const results = await Promise.all([
      methods.acquireFileDeletion(deletion),
      peer.acquireFileDeletion({ ...deletion, token: 'peer' }),
    ]);
    expect(results.filter((result) => result !== null)).toEqual([{ resumed: false }]);
  });

  it('clears pending on pre-primary failure to permit lazy repair', async () => {
    await seed();
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(true);
    expect((await read())?.storageOperations).toEqual({});
    expect(await peer.acquireFileProvision(claim)).toBe(true);
    expect(await peer.releaseFileProvision(claim)).toBe(true);
    expect(await peer.acquireFileDeletion(deletion)).toEqual({ resumed: false });
  });

  it('retains primary-success intent and resumes without reprovisioning', async () => {
    await seed();
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: true })).toBe(true);
    expect((await read())?.storageOperations).toEqual({ deletionPending: true });
    expect(await peer.acquireFileProvision(claim)).toBe(false);
    const retry = { ...deletion, token: 'retry' };
    expect(await peer.acquireFileDeletion(retry)).toEqual({ resumed: true });
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(false);
    expect(await peer.releaseFileDeletion({ ...retry, retainDeletion: true })).toBe(true);
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: true });
  });

  it('requires the deletion content snapshot but not a provisioning snapshot', async () => {
    await seed();
    expect(await methods.acquireFileDeletion({ ...deletion, updatedAt: new Date(0) })).toBeNull();
    expect(await methods.acquireFileDeletion(claim)).toBeNull();
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    expect(await methods.releaseFileProvision(claim)).toBe(true);
    expect(
      await methods.acquireFileDeletion({ ...deletion, updatedAt: updatedAt.toISOString() }),
    ).toEqual({ resumed: false });
  });

  it('can claim an explicitly absent legacy snapshot', async () => {
    await seed();
    await File.collection.updateOne({ file_id: claim.file_id }, { $unset: { updatedAt: '' } });
    expect(await methods.acquireFileDeletion(claim)).toEqual({ resumed: false });
  });

  it('persists a code result only for its active owner and tenant claim', async () => {
    await seed();
    const code = {
      routeKey: 'default',
      ref: {
        kind: 'user' as const,
        id: claim.userId,
        storage_session_id: 'session',
        file_id: 'remote',
      },
    };
    expect(await methods.commitFileProvision({ claim, code })).toBe(false);
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    expect(await methods.commitFileProvision({ claim: { ...claim, token: 'stale' }, code })).toBe(
      false,
    );
    expect(await methods.commitFileProvision({ claim, code })).toBe(true);
    expect((await read())?.metadata?.codeEnvRefs?.default).toEqual(code.ref);
    expect(
      await peer.acquireFileDeletion({ ...deletion, updatedAt: (await read())?.updatedAt }),
    ).toBeNull();
    expect(await methods.releaseFileProvision(claim)).toBe(true);
    expect(await methods.commitFileProvision({ claim, code })).toBe(false);
  });

  it('records a vector namespace without releasing the provisioning claim early', async () => {
    await seed();
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    expect(
      await methods.commitFileProvision({ claim, embedded: true, entityId: 'namespace' }),
    ).toBe(true);
    const stored = await read();
    expect(stored?.embedded).toBe(true);
    expect(stored?.metadata?.embeddedEntities).toEqual(['namespace']);
    expect(stored?.storageOperations?.provisioning).toEqual([claim.token]);
  });

  it('cannot complete a stale upload against a recreated file identity', async () => {
    await seed();
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    await File.collection.deleteMany({});
    await seed();
    expect(await methods.commitFileProvision({ claim, embedded: true })).toBe(false);
    expect(await methods.releaseFileProvision(claim)).toBe(true);
    expect((await read())?.embedded).toBeUndefined();
  });

  it.each(['provision', 'delete'])(
    'retains the durable retry anchor beyond upload TTL while holding %s',
    async (operation) => {
      await seed({ expiresAt: new Date(Date.now() + 60_000) });
      if (operation === 'provision') expect(await methods.acquireFileProvision(claim)).toBe(true);
      else expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
      expect((await read())?.expiresAt).toBeUndefined();
      expect((await read())?.updatedAt).toEqual(updatedAt);
    },
  );

  it('never upserts missing files for any claim or release', async () => {
    expect(await methods.acquireFileProvision(claim)).toBe(false);
    expect(await methods.releaseFileProvision(claim)).toBe(false);
    expect(await methods.acquireFileDeletion(deletion)).toBeNull();
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(false);
    expect(await File.collection.countDocuments()).toBe(0);
  });

  it.each([
    { userId: new mongoose.Types.ObjectId().toString() },
    { tenantId: 'tenant-b' },
    { tenantId: undefined },
    { tenantId: null },
    { file_id: 'other-file' },
  ])('isolates every claim and release for scope %j', async (scope) => {
    await seed();
    const other = { ...claim, ...scope };
    expect(await runAsSystem(() => peer.acquireFileProvision(other))).toBe(false);
    expect(await runAsSystem(() => peer.acquireFileDeletion({ ...other, updatedAt }))).toBeNull();
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    expect(await runAsSystem(() => peer.releaseFileProvision(other))).toBe(false);
    expect(await methods.releaseFileProvision(claim)).toBe(true);
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
    expect(
      await runAsSystem(() => peer.releaseFileDeletion({ ...other, retainDeletion: false })),
    ).toBe(false);
    expect((await read())?.storageOperations?.deleting).toBe(claim.token);
  });

  it.each([undefined, null])(
    'explicitly scopes legacy tenant %j even in system context',
    async (tenantId) => {
      await seed({ tenantId: undefined });
      await seed({ tenantId: 'tenant-a' });
      const legacy = { ...claim, tenantId };
      expect(await runAsSystem(() => methods.acquireFileProvision(legacy))).toBe(true);
      const rows = await File.collection.find({ file_id: claim.file_id }).toArray();
      expect(rows.find((row) => row.tenantId === 'tenant-a')?.storageOperations).toBeUndefined();
      expect(await runAsSystem(() => methods.releaseFileProvision(legacy))).toBe(true);
      expect(
        await runAsSystem(() => methods.acquireFileDeletion({ ...legacy, updatedAt })),
      ).toEqual({
        resumed: false,
      });
      expect(
        await runAsSystem(() => methods.releaseFileDeletion({ ...legacy, retainDeletion: true })),
      ).toBe(true);
    },
  );

  it('cannot have its explicit tenant overwritten by ambient tenant middleware', async () => {
    await seed();
    await seed({ tenantId: 'tenant-b' });
    const context = { tenantId: 'tenant-b' };
    expect(await tenantStorage.run(context, () => methods.acquireFileProvision(claim))).toBe(false);
    expect(
      await tenantStorage.run(context, () => methods.acquireFileDeletion(deletion)),
    ).toBeNull();
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    expect(await tenantStorage.run(context, () => methods.releaseFileProvision(claim))).toBe(false);
    expect(await methods.releaseFileProvision(claim)).toBe(true);
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
    expect(
      await tenantStorage.run(context, () =>
        methods.releaseFileDeletion({ ...claim, retainDeletion: false }),
      ),
    ).toBe(false);
    expect(
      await File.collection.countDocuments({
        storageOperations: { $exists: true },
        tenantId: 'tenant-b',
      }),
    ).toBe(0);
  });

  it('preserves timestamps, content, metadata, and unknown fields', async () => {
    await seed({
      futureField: { value: 'untouched' },
      storageOperations: { futureFence: 'untouched' },
    });
    const before = await read();
    const unchanged = async () => {
      const after = await read();
      expect(after).toEqual({
        ...before,
        storageOperations: { ...after?.storageOperations, futureFence: 'untouched' },
      });
    };
    expect(await methods.acquireFileProvision(claim)).toBe(true);
    await unchanged();
    expect(await methods.releaseFileProvision(claim)).toBe(true);
    await unchanged();
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
    await unchanged();
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: true })).toBe(true);
    await unchanged();
    expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: true });
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(true);
    await unchanged();
  });

  it('propagates database failures instead of reporting contention or absence', async () => {
    const disconnected = new mongoose.Mongoose();
    disconnected.model<IMongoFile>('File', File.schema.clone().set('bufferCommands', false));
    const unavailable = createFileStorageMethods(disconnected);
    await expect(unavailable.acquireFileProvision(claim)).rejects.toThrow();
    await expect(unavailable.releaseFileProvision(claim)).rejects.toThrow();
    await expect(unavailable.acquireFileDeletion(deletion)).rejects.toThrow();
    await expect(
      unavailable.releaseFileDeletion({ ...claim, retainDeletion: false }),
    ).rejects.toThrow();
  });

  it.each([
    { token: '' },
    { token: '   ' },
    { token: null },
    { token: { $ne: '' } },
    { userId: '' },
    { userId: 'not-an-object-id' },
    { userId: { $ne: null } },
    { file_id: '' },
    { tenantId: '' },
  ])('rejects invalid claim scope %j without writing', async (invalid) => {
    await seed();
    const before = await read();
    // Exercise untrusted runtime input without weakening the public contract.
    const data = { ...claim, ...invalid } as FileStorageClaim;
    await expect(methods.acquireFileProvision(data)).rejects.toThrow('valid file storage');
    await expect(methods.releaseFileProvision(data)).rejects.toThrow('valid file storage');
    await expect(methods.acquireFileDeletion({ ...data, updatedAt })).rejects.toThrow(
      'valid file storage',
    );
    await expect(methods.releaseFileDeletion({ ...data, retainDeletion: false })).rejects.toThrow(
      'valid file storage',
    );
    expect(await read()).toEqual(before);
  });
});

describe('deletion release acknowledgement recovery', () => {
  it.each([true, false])(
    'acknowledges repeated release without changing pending intent, retain=%s',
    async (retainDeletion) => {
      await seed();
      expect(await methods.acquireFileDeletion(deletion)).toEqual({ resumed: false });
      expect(await methods.releaseFileDeletion({ ...claim, retainDeletion })).toBe(true);
      expect(await peer.releaseFileDeletion({ ...claim, retainDeletion: !retainDeletion })).toBe(
        true,
      );
      expect((await read())?.storageOperations?.deletionPending).toBe(
        retainDeletion ? true : undefined,
      );
      expect((await read())?.storageOperations?.deleting).toBeUndefined();
    },
  );

  it('does not acknowledge a release for a missing record, another owner, or another tenant', async () => {
    await seed();
    for (const wrong of [
      { ...claim, file_id: 'missing' },
      { ...claim, userId: new mongoose.Types.ObjectId().toString() },
      { ...claim, tenantId: 'other-tenant' },
    ])
      expect(await methods.releaseFileDeletion({ ...wrong, retainDeletion: false })).toBe(false);
  });

  it('never releases a newer deletion token when replaying an old release', async () => {
    await seed();
    expect(await methods.acquireFileDeletion(deletion)).not.toBeNull();
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(true);
    expect(await peer.acquireFileDeletion({ ...deletion, token: 'new-token' })).not.toBeNull();
    expect(await methods.releaseFileDeletion({ ...claim, retainDeletion: false })).toBe(false);
    expect((await read())?.storageOperations?.deleting).toBe('new-token');
    expect((await read())?.storageOperations?.deletionPending).toBe(true);
  });
});
