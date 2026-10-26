import mongoose, { Types } from 'mongoose';
import { ResourceType } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import type { CodeEnvironmentSetupInput } from './environments';
import { AccessControlService } from '~/acl/accessControlService';
import { createCodeEnvironmentRegistry } from './environments';

function input(id: string, ownerId: string): CodeEnvironmentSetupInput {
  return {
    actor: { userId: ownerId },
    setupAttemptId: `attempt-${id}`,
    requestHash: 'a'.repeat(64),
    maxOwned: 1,
    environment: {
      id,
      name: 'Setup Machine',
      type: 'attached',
      baseURL: 'https://code.example.com',
      controlPlaneId: 'setup-plane',
      workerId: `worker-${id}`,
      revocationTokenEnv: 'CODE_API_TOKEN',
      workerPrincipal: { type: 'user', id: ownerId },
    },
  };
}

describe('staged browser setup registry', () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    await mongoose.connection.db!.collection('code_environment_tombstones').deleteMany({});
    await createMethods(mongoose).seedDefaultRoles();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  test('explicitly enforces owner-slot uniqueness when automatic index creation is disabled', async () => {
    const model = mongoose.models.CodeEnvironment;
    await model.collection.dropIndex('createdBy_1_ownerSlot_1_tenantId_1');
    const previous = mongoose.get('autoIndex');
    mongoose.set('autoIndex', false);
    try {
      const ownerId = new Types.ObjectId().toHexString();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          createCodeEnvironmentRegistry(mongoose).reserveSetup(input(`no-auto-${index}`, ownerId)),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await model.countDocuments({ createdBy: ownerId })).toBe(1);
      const indexes = await model.collection.indexes();
      expect(
        indexes.some(
          (entry) => entry.unique && entry.key.createdBy === 1 && entry.key.ownerSlot === 1,
        ),
      ).toBe(true);
    } finally {
      mongoose.set('autoIndex', previous);
    }
  });

  test('reservation stays hidden and replays before owner capacity checks', async () => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const params = input('capacity', ownerId);
    const reserved = await registry.reserveSetup(params);
    await expect(createCodeEnvironmentRegistry(mongoose).reserveSetup(params)).resolves.toEqual(
      reserved,
    );
    await expect(registry.listAccessible({ userId: ownerId })).resolves.toEqual([]);
    await expect(registry.reserveSetup(input('second-machine', ownerId))).rejects.toThrow('limit');
    expect(await mongoose.models.CodeEnvironment.countDocuments({ createdBy: ownerId })).toBe(1);
    const completed = await registry.completeSetup(params);
    expect(completed).toEqual(reserved);
    await expect(registry.completeSetup(params)).resolves.toEqual(completed);
    await expect(registry.listAccessible({ userId: ownerId })).resolves.toEqual([completed]);
  });

  test('ACL failure persists the pending reservation and retry repairs the grant at full capacity', async () => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const params = input('acl-failure', ownerId);
    const reserved = await registry.reserveSetup(params);
    const grant = jest
      .spyOn(AccessControlService.prototype, 'grantPermission')
      .mockRejectedValueOnce(new Error('injected database outage'));
    await expect(registry.completeSetup(params)).rejects.toThrow('injected database outage');
    expect(
      await mongoose.models.CodeEnvironment.findById(reserved.resourceId).lean(),
    ).toMatchObject({
      setupAttemptId: params.setupAttemptId,
      setupRequestHash: params.requestHash,
      registrationPendingAt: expect.any(Date),
    });
    await expect(registry.listAccessible({ userId: ownerId })).resolves.toEqual([]);
    await expect(registry.reserveSetup(params)).resolves.toEqual(reserved);
    await expect(registry.completeSetup(params)).resolves.toEqual(reserved);
    expect(grant).toHaveBeenCalledTimes(2);
    expect(
      await mongoose.models.AclEntry.countDocuments({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: reserved.resourceId,
      }),
    ).toBe(1);
  });

  test('a grant followed by cache failure stays hidden and the retry does not duplicate ACLs', async () => {
    const ownerId = new Types.ObjectId().toString();
    const cache = {
      get: jest.fn(async () => undefined),
      set: jest.fn().mockRejectedValueOnce(new Error('cache outage')).mockResolvedValue(true),
    };
    const registry = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const params = input('cache-failure', ownerId);
    const reserved = await registry.reserveSetup(params);
    await expect(registry.completeSetup(params)).rejects.toThrow('cache outage');
    await expect(registry.listAccessible({ userId: ownerId })).resolves.toEqual([]);
    await registry.completeSetup(params);
    expect(await mongoose.models.AclEntry.countDocuments({ resourceId: reserved.resourceId })).toBe(
      1,
    );
  });

  test.each([
    'owner',
    'attempt',
    'hash',
    'plane',
    'url',
    'worker',
    'principal',
    'name',
    'token',
  ] as const)('replays and compensation require the complete %s binding', async (field) => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const params = input(`binding-${field}`, ownerId);
    const reserved = await registry.reserveSetup(params);
    const changed: CodeEnvironmentSetupInput = {
      ...params,
      actor: { ...params.actor },
      environment: { ...params.environment },
    };
    if (field === 'owner') changed.actor.userId = new Types.ObjectId().toString();
    if (field === 'attempt') changed.setupAttemptId = 'different-attempt';
    if (field === 'hash') changed.requestHash = 'b'.repeat(64);
    if (field === 'plane') changed.environment.controlPlaneId = 'another-plane';
    if (field === 'url') changed.environment.baseURL = 'https://another.example.com';
    if (field === 'worker') changed.environment.workerId = 'another-worker';
    if (field === 'principal')
      changed.environment.workerPrincipal = { type: 'user', id: new Types.ObjectId().toString() };
    if (field === 'name') changed.environment.name = 'Renamed Machine';
    if (field === 'token') changed.environment.revocationTokenEnv = 'ANOTHER_TOKEN';
    await expect(registry.reserveSetup(changed)).rejects.toThrow('binding');
    await expect(registry.completeSetup(changed)).rejects.toThrow('binding');
    await expect(registry.discardSetup(changed)).rejects.toThrow('binding');
    expect(await mongoose.models.CodeEnvironment.findById(reserved.resourceId)).not.toBeNull();
  });

  test('parallel setup attempts cannot exceed owner slots and a retired slot uses a fresh ACL resource', async () => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const first = input('parallel-one', ownerId);
    const second = input('parallel-two', ownerId);
    const results = await Promise.allSettled([
      registry.reserveSetup(first),
      registry.reserveSetup(second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await mongoose.models.CodeEnvironment.countDocuments({ createdBy: ownerId })).toBe(1);
    const winner = results[0].status === 'fulfilled' ? first : second;
    const old = await registry.completeSetup(winner);
    await registry.discardSetup(winner);
    const replacement = await registry.reserveSetup(input('replacement', ownerId));
    expect(replacement.resourceId).not.toBe(old.resourceId);
    await registry.discardSetup(winner);
    expect(await mongoose.models.CodeEnvironment.findById(replacement.resourceId)).not.toBeNull();
  });

  test('discard survives ACL failure, is idempotent, and never resurrects a retired worker', async () => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const params = input('discard', ownerId);
    const reserved = await registry.reserveSetup(params);
    await registry.completeSetup(params);
    const remove = jest
      .spyOn(AccessControlService.prototype, 'removeAllPermissions')
      .mockRejectedValueOnce(new Error('ACL cleanup outage'));
    await expect(registry.discardSetup(params)).rejects.toThrow('ACL cleanup outage');
    await expect(registry.listAccessible({ userId: ownerId })).resolves.toEqual([]);
    await expect(registry.completeSetup(params)).rejects.toThrow('binding');
    await registry.discardSetup(params);
    await registry.discardSetup(params);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(await mongoose.models.CodeEnvironment.findById(reserved.resourceId)).toBeNull();
    expect(await mongoose.models.AclEntry.countDocuments({ resourceId: reserved.resourceId })).toBe(
      0,
    );
    await expect(registry.reserveSetup(params)).rejects.toThrow('binding');
  });

  test('a completed replay does not restore a subsequently revoked ownership ACL', async () => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const params = input('revoked', ownerId);
    const reserved = await registry.reserveSetup(params);
    await registry.completeSetup(params);
    await mongoose.models.AclEntry.deleteMany({ resourceId: reserved.resourceId });
    await expect(registry.completeSetup(params)).rejects.toThrow('ownership');
    expect(await mongoose.models.AclEntry.countDocuments({ resourceId: reserved.resourceId })).toBe(
      0,
    );
  });

  test('tenant context is part of reservation and compensation identity', async () => {
    const ownerId = new Types.ObjectId().toString();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const params = input('tenant-scoped', ownerId);
    const reserved = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      registry.reserveSetup(params),
    );
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => registry.discardSetup(params));
    const found = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      registry.reserveSetup(params),
    );
    expect(found).toEqual(reserved);
  });
  test.each(['deleteCodeEnvironmentById', 'deleteUserCodeEnvironments'] as const)(
    'generic %s preserves exact identity for later browser compensation',
    async (method) => {
      const ownerId = new Types.ObjectId().toString();
      const registry = createCodeEnvironmentRegistry(mongoose);
      const params = input(`generic-${method}`, ownerId);
      const reserved = await registry.reserveSetup(params);
      await registry.completeSetup(params);
      const methods = createMethods(mongoose);
      if (method === 'deleteCodeEnvironmentById')
        await methods.deleteCodeEnvironmentById(reserved.resourceId);
      else await methods.deleteUserCodeEnvironments(ownerId);
      expect(await mongoose.models.CodeEnvironment.findById(reserved.resourceId)).toBeNull();
      await expect(registry.discardSetup(params)).resolves.toBeUndefined();
      expect(
        await mongoose.models.AclEntry.countDocuments({ resourceId: reserved.resourceId }),
      ).toBe(0);
      await expect(registry.reserveSetup(params)).rejects.toThrow('binding');
      const rebound = { ...params, environment: { ...params.environment, id: 'rebound-machine' } };
      await expect(registry.reserveSetup(rebound)).rejects.toThrow('binding');
      await expect(registry.discardSetup(rebound)).rejects.toThrow('binding');
    },
  );
});
