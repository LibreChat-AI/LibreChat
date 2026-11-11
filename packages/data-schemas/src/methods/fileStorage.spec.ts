import mongoose from 'mongoose';
import { FileContext } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FileStorageClaim, IMongoFile } from '~/types/file';
import type { AllMethods, FileStorageMethods } from './index';
import { _resetStrictCache } from '~/models/plugins/tenantIsolation';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileStorageMethods } from './fileStorage';
import { createMethods } from './index';
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
  describe('unfinished snapshot releases', () => {
    async function reserve() {
      return createMethods(mongoose).claimCodeFile({
        filename: 'report.txt',
        conversationId: 'snapshot-conversation',
        file_id: claim.file_id,
        user: claim.userId,
        tenantId: claim.tenantId,
        sourceDispatchedAt: 100,
        snapshot: true,
      });
    }

    it('gives only a fresh snapshot reservation the existing upload TTL', async () => {
      const startedAt = Date.now();
      await reserve();
      const reservation = await read();
      expect(reservation?.expiresAt).toBeInstanceOf(Date);
      expect(reservation!.expiresAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 3_600_000);
      expect(reservation!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000);
      expect(reservation?.filepath).toBeUndefined();
      expect(reservation?.storageOperations?.provisioning).toBeUndefined();
      await File.init();
      expect(await File.collection.indexes()).toContainEqual(
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 3600 }),
      );
    });

    it('retains the deadline when acquisition fails before the database write', async () => {
      await reserve();
      const reservation = await read();
      expect(reservation?.expiresAt).toBeInstanceOf(Date);
      jest.spyOn(File, 'updateOne').mockRejectedValueOnce(new Error('Database unavailable'));
      await expect(peer.acquireFileProvision(claim)).rejects.toThrow('Database unavailable');
      expect(await read()).toEqual(reservation);
      expect((await read())?.storageOperations?.provisioning).toBeUndefined();
    });

    it('retains the deadline when another scope cannot acquire the reservation', async () => {
      await reserve();
      const reservation = await read();
      expect(reservation?.expiresAt).toBeInstanceOf(Date);
      expect(await peer.acquireFileProvision({ ...claim, tenantId: 'tenant-b' })).toBe(false);
      expect(await read()).toEqual(reservation);
    });

    it('clears the deadline atomically even when the acquisition acknowledgement is lost', async () => {
      await reserve();
      expect((await read())?.expiresAt).toBeInstanceOf(Date);
      jest.spyOn(peer, 'acquireFileProvision').mockImplementationOnce(async (data) => {
        expect(await methods.acquireFileProvision(data)).toBe(true);
        throw new Error('Acquisition acknowledgement lost');
      });
      await expect(peer.acquireFileProvision(claim)).rejects.toThrow(
        'Acquisition acknowledgement lost',
      );
      const acquired = await read();
      expect(acquired?.expiresAt).toBeUndefined();
      expect(acquired?.storageOperations?.provisioning).toEqual([claim.token]);
    });

    it('does not extend an existing reservation deadline', async () => {
      await reserve();
      const deadline = new Date(Date.now() + 60_000);
      await File.collection.updateOne(
        { file_id: claim.file_id },
        { $set: { expiresAt: deadline } },
      );
      const reservation = await read();
      await reserve();
      expect(await read()).toEqual(reservation);
    });

    it('does not add a deadline to an existing committed snapshot', async () => {
      await reserve();
      await methods.acquireFileProvision(claim);
      await File.collection.updateOne(
        { file_id: claim.file_id },
        { $set: { filepath: '/uploads/committed', bytes: 100 } },
      );
      await methods.releaseFileProvision(claim);
      const committed = await read();
      expect(committed?.expiresAt).toBeUndefined();
      await reserve();
      expect(await read()).toEqual(committed);
    });

    it('leaves legacy claims without a provisional deadline', async () => {
      const legacy = await createMethods(mongoose).claimCodeFile({
        filename: 'legacy.txt',
        conversationId: 'legacy-conversation',
        file_id: 'legacy-file',
        user: claim.userId,
        tenantId: claim.tenantId,
      });
      expect(legacy.context).toBe(FileContext.execute_code);
      expect(legacy.expiresAt).toBeUndefined();
    });

    it('deletes only the unfinished claim and accepts repeated releases', async () => {
      await reserve();
      expect((await read())?.object).toBe('file');
      expect(await methods.acquireFileProvision(claim)).toBe(true);
      expect(await methods.commitFileProvision({ claim, releaseOnly: true })).toBe(true);
      expect(await methods.releaseFileProvision(claim)).toBe(true);
      expect(await read()).toBeNull();
      expect(await peer.releaseFileProvision(claim)).toBe(true);
      expect(await methods.acquireFileProvision(claim)).toBe(false);
      expect(await methods.commitFileProvision({ claim, releaseOnly: true })).toBe(false);
    });

    it.each([
      { userId: new mongoose.Types.ObjectId().toString() },
      { tenantId: 'tenant-b' },
      { tenantId: null },
      { token: 'foreign' },
    ])('does not discard another scope or token: %j', async (overrides) => {
      await reserve();
      await methods.acquireFileProvision(claim);
      const before = await read();
      expect(await runAsSystem(() => peer.releaseFileProvision({ ...claim, ...overrides }))).toBe(
        true,
      );
      expect(await read()).toEqual(before);
      expect(await methods.releaseFileProvision(claim)).toBe(true);
      expect(await read()).toBeNull();
    });

    it('retains other claimants and deletes on the final concurrent release', async () => {
      for (let round = 0; round < 4; round++) {
        await reserve();
        const claims = Array.from({ length: 16 }, (_, i) => ({ ...claim, token: `token-${i}` }));
        expect(await Promise.all(claims.map(methods.acquireFileProvision))).toEqual(
          claims.map(() => true),
        );
        expect(await methods.releaseFileProvision(claims[0])).toBe(true);
        expect((await read())?.storageOperations?.provisioning).toHaveLength(15);
        expect(await Promise.all(claims.slice(1).map(peer.releaseFileProvision))).toEqual(
          claims.slice(1).map(() => true),
        );
        expect(await read()).toBeNull();
      }
    });

    it.each([
      { filepath: '/uploads/committed' },
      { bytes: 0 },
      { storageKey: 'primary-object' },
      { context: FileContext.execute_code },
      { context: FileContext.message_attachment },
      { 'storageOperations.deletionPending': true },
      { 'storageOperations.deleting': 'deletion-owner' },
    ])('preserves committed content, other contexts and deletion intent: %j', async (fields) => {
      await reserve();
      await methods.acquireFileProvision(claim);
      await File.collection.updateOne({ file_id: claim.file_id }, { $set: fields });
      const before = await read();
      expect(await methods.releaseFileProvision(claim)).toBe(true);
      expect(await read()).toEqual({
        ...before,
        storageOperations: { ...before?.storageOperations, provisioning: [] },
      });
    });

    it('retains committed snapshot metadata and primary content', async () => {
      await seed({ context: FileContext.execute_code_snapshot });
      const before = await read();
      await methods.acquireFileProvision(claim);
      expect(await methods.releaseFileProvision(claim)).toBe(true);
      expect(await read()).toEqual({ ...before, storageOperations: { provisioning: [] } });
    });
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
    expect(await methods.releaseFileProvision(claim)).toBe(true);
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
    expect(await runAsSystem(() => peer.releaseFileProvision(other))).toBe(true);
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
    expect(await tenantStorage.run(context, () => methods.releaseFileProvision(claim))).toBe(true);
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
