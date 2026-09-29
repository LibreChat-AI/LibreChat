import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels, tenantStorage } from '@librechat/data-schemas';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import { reconcileCodeEnvironmentLifecycle, revokeUserCodeEnvironmentWorkers } from './lifecycle';
import { AccessControlService } from '~/acl/accessControlService';
import { createCodeEnvironmentRegistry } from './environments';

function createSharedCache() {
  const values = new Map<string, unknown>();
  return {
    get: jest.fn(async (key: string) => values.get(key)),
    set: jest.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    }),
  };
}

describe('code environment registry', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    await createMethods(mongoose).seedDefaultRoles();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await createMethods(mongoose).seedDefaultRoles();
  });

  test('discovers a registered environment only for its owner principal', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const ownerId = new Types.ObjectId();
    const strangerId = new Types.ObjectId();

    const created = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'danny-vm',
        name: "Danny's VM",
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        workerId: 'danny-worker',
      },
    });

    expect(mongoose.models.CodeEnvironment.schema.path('controlPlaneId')).toBeDefined();
    expect(created).toEqual({
      resourceId: expect.any(String),
      id: 'danny-vm',
      name: "Danny's VM",
      type: 'attached',
      canEdit: true,
      canDelete: true,
    });
    await expect(registry.listRegisteredIds()).resolves.toEqual(['danny-vm']);
    await expect(
      registry.listAccessible({ userId: ownerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toEqual([created]);
    await expect(
      registry.listAccessible({ userId: strangerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toEqual([]);
    await expect(
      registry.listAccessibleConfigurations({
        userId: ownerId,
        role: 'USER',
        idOnTheSource: null,
      }),
    ).resolves.toEqual([
      {
        id: 'danny-vm',
        name: "Danny's VM",
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        owner: 'principal',
        workerId: 'danny-worker',
      },
    ]);
  });

  test('persists owner settings and includes them in execution configuration', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const ownerId = new Types.ObjectId();
    await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'settings-vm',
        name: 'Settings VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'self-service',
      },
    });

    await expect(
      registry.updateSettings({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environmentId: 'settings-vm',
        settings: { permissions: { fileWrite: 'allow', commandExecution: 'deny' } },
      }),
    ).resolves.toMatchObject({
      id: 'settings-vm',
      canEdit: true,
      canDelete: true,
    });

    await expect(
      registry.updateSettings({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environmentId: 'settings-vm',
        settings: { permissions: { fileWrite: 'ask' } },
      }),
    ).resolves.toMatchObject({
      settings: { permissions: { fileWrite: 'ask', commandExecution: 'deny' } },
    });

    await expect(
      registry.listAccessibleConfigurations({
        userId: ownerId,
        role: 'USER',
        idOnTheSource: null,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'settings-vm',
        settings: { permissions: { fileWrite: 'ask', commandExecution: 'deny' } },
      }),
    ]);

    await expect(
      createMethods(mongoose).updateCodeEnvironmentSettings('settings-vm', {
        permissions: { fileWrite: 'invalid' },
      } as never),
    ).rejects.toThrow();
  });

  test('discovers environments granted through role and group principals', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const methods = createMethods(mongoose);
    const access = new AccessControlService(mongoose);
    const ownerId = new Types.ObjectId();
    const teammateId = new Types.ObjectId();
    const group = await methods.createGroup({
      name: 'Code Team',
      source: 'local',
      memberIds: [teammateId.toString()],
    });
    const roleEnvironment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'role-vm',
        name: 'Role VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    const groupEnvironment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'group-vm',
        name: 'Group VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });

    await access.grantPermission({
      principalType: PrincipalType.ROLE,
      principalId: 'CODE_USER',
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: roleEnvironment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
      grantedBy: ownerId,
    });
    await access.grantPermission({
      principalType: PrincipalType.GROUP,
      principalId: group._id,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: groupEnvironment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
      grantedBy: ownerId,
    });

    await expect(
      registry.listAccessible({
        userId: teammateId,
        role: 'CODE_USER',
        idOnTheSource: null,
      }),
    ).resolves.toEqual([
      { ...roleEnvironment, canEdit: false, canDelete: false },
      { ...groupEnvironment, canEdit: false, canDelete: false },
    ]);
  });

  test('reports edit and delete capabilities independently for shared editors', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const access = new AccessControlService(mongoose);
    const ownerId = new Types.ObjectId();
    const editorId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'editor-vm',
        name: 'Editor VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    await access.grantPermission({
      principalType: PrincipalType.USER,
      principalId: editorId,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_EDITOR,
      grantedBy: ownerId,
    });
    const actor = { userId: editorId, role: 'USER', idOnTheSource: null };

    await expect(registry.listAccessible(actor)).resolves.toEqual([
      expect.objectContaining({ id: 'editor-vm', canEdit: true, canDelete: false }),
    ]);
    await expect(
      registry.updateSettings({
        actor,
        environmentId: 'editor-vm',
        settings: { permissions: { fileWrite: 'deny' } },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'editor-vm', canEdit: true, canDelete: false }),
    );
  });

  test('computes delete permissions for an environment list in one batch', async () => {
    const batchSpy = jest.spyOn(AccessControlService.prototype, 'getResourcePermissionsMap');
    const principalBatchSpy = jest.spyOn(
      AccessControlService.prototype,
      'getResourcePermissionsMapForPrincipals',
    );
    const singleSpy = jest.spyOn(AccessControlService.prototype, 'checkPermission');
    const registry = createCodeEnvironmentRegistry(mongoose);
    const ownerId = new Types.ObjectId();
    for (const id of ['batch-one', 'batch-two']) {
      await registry.register({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environment: {
          id,
          name: id,
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
        },
      });
    }

    await expect(
      registry.listAccessible({ userId: ownerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toHaveLength(2);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(principalBatchSpy).toHaveBeenCalledTimes(1);
    expect(singleSpy).not.toHaveBeenCalled();

    batchSpy.mockRestore();
    principalBatchSpy.mockRestore();
    singleSpy.mockRestore();
  });

  test.each([2, 12])(
    'atomically limits concurrent registrations to %i across replicas',
    async (maxOwned) => {
      await mongoose.models.CodeEnvironment.createCollection();
      await expect(mongoose.models.CodeEnvironment.collection.indexes()).resolves.toEqual([
        expect.objectContaining({ name: '_id_' }),
      ]);
      const registries = [
        createCodeEnvironmentRegistry(mongoose),
        createCodeEnvironmentRegistry(mongoose),
      ];
      const ownerId = new Types.ObjectId();

      const results = await Promise.allSettled(
        Array.from({ length: maxOwned + 4 }, (_, index) =>
          registries[index % registries.length].register({
            actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
            environment: {
              id: `quota-${index}`,
              name: `quota-${index}`,
              type: 'attached',
              baseURL: 'https://code.example.com',
              controlPlaneId: 'shared-code-api',
            },
            maxOwned,
          } as never),
        ),
      );

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(maxOwned);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(4);
      expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
        reason: { name: 'CodeEnvironmentLimitError' },
      });
      await expect(
        mongoose.models.CodeEnvironment.countDocuments({ createdBy: ownerId }),
      ).resolves.toBe(maxOwned);
    },
  );

  test('keeps a user-bound worker private even if its ACL is granted to a role', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const access = new AccessControlService(mongoose);
    const ownerId = new Types.ObjectId();
    const teammateId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'owner-worker',
        name: 'Owner worker',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        workerId: 'owner-worker',
        workerPrincipal: { type: 'user', id: ownerId.toString() },
      },
    });
    await access.grantPermission({
      principalType: PrincipalType.ROLE,
      principalId: 'CODE_USER',
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
      grantedBy: ownerId,
    });

    await expect(
      registry.listAccessible({ userId: teammateId, role: 'CODE_USER', idOnTheSource: null }),
    ).resolves.toEqual([]);
    await expect(
      registry.listAccessible({ userId: ownerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toEqual([environment]);
  });

  test('deletes an owner environment and its ACL after lifecycle cleanup succeeds', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const ownerId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'remove-me',
        name: 'Remove me',
        type: 'attached',
        baseURL: 'https://code.example.com',
        workerId: 'remove-me',
        controlPlaneId: 'self-service',
        workerPrincipal: { type: 'user', id: ownerId.toString() },
      },
    });
    const beforeDelete = jest.fn().mockResolvedValue(undefined);

    await expect(
      registry.remove({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environmentId: 'remove-me',
        beforeDelete,
      }),
    ).resolves.toEqual(environment);
    expect(beforeDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remove-me',
        workerId: 'remove-me',
        controlPlaneId: 'self-service',
      }),
    );
    await expect(
      mongoose.models.AclEntry.countDocuments({ resourceId: environment.resourceId }),
    ).resolves.toBe(0);
    await expect(
      registry.listAccessible({ userId: ownerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toEqual([]);
  });

  test('reconciles an interrupted removal after the remote lifecycle has started', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const ownerId = new Types.ObjectId();
    await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'interrupted-removal',
        name: 'Interrupted removal',
        type: 'attached',
        baseURL: 'https://code.example.com/v1',
        workerId: 'interrupted-removal',
        controlPlaneId: 'self-service',
        revocationTokenEnv: 'CODE_ADMIN_TOKEN',
        workerPrincipal: { type: 'user', id: ownerId.toString() },
      },
    });
    const beforeDelete = jest.fn().mockResolvedValue(undefined);
    const commit = jest
      .spyOn(mongoose.models.CodeEnvironment, 'updateOne')
      .mockRejectedValueOnce(new Error('mongo unavailable after revoke'));

    await expect(
      registry.remove({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environmentId: 'interrupted-removal',
        beforeDelete,
      }),
    ).rejects.toThrow('mongo unavailable after revoke');
    expect(beforeDelete).toHaveBeenCalledTimes(1);
    await expect(
      registry.listAccessible({ userId: ownerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toEqual([]);

    commit.mockRestore();
    await mongoose.models.CodeEnvironment.updateOne(
      { environmentId: 'interrupted-removal' },
      { $set: { deletionLeaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ protocolVersion: 1, revoked: true }),
    });
    await reconcileCodeEnvironmentLifecycle({
      mongoose,
      readSecret: () => 'administrator-token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/bridge/workers/interrupted-removal/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'interrupted-removal' }),
    ).resolves.toBeNull();
  });

  test('fences removal while an agent write is reserving the environment', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'agent-write-race',
        name: 'Agent write race',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    const Agent = mongoose.models.Agent;
    const createAgent = Agent.create.bind(Agent);
    let enteredCreate!: () => void;
    let releaseCreate!: () => void;
    const entered = new Promise<void>((resolve) => (enteredCreate = resolve));
    const release = new Promise<void>((resolve) => (releaseCreate = resolve));
    const createSpy = jest.spyOn(Agent, 'create').mockImplementationOnce(async (input) => {
      enteredCreate();
      await release;
      return await createAgent(input);
    });

    const pendingAgent = methods.createAgent({
      id: 'agent_write_race',
      name: 'Agent write race',
      author: ownerId,
      model: 'test-model',
      provider: 'test-provider',
      code_environment_id: 'agent-write-race',
    });
    await entered;

    await expect(
      registry.remove({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environmentId: 'agent-write-race',
      }),
    ).rejects.toMatchObject({ name: 'CodeEnvironmentInUseError' });

    releaseCreate();
    await expect(pendingAgent).resolves.toMatchObject({
      code_environment_id: 'agent-write-race',
    });
    createSpy.mockRestore();
  });

  test('revokes every user-bound worker before account deletion', async () => {
    const ownerId = new Types.ObjectId();
    await createCodeEnvironmentRegistry(mongoose).register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'account-worker',
        name: 'Account worker',
        type: 'attached',
        baseURL: 'https://code.example.com/v1',
        workerId: 'account-worker',
        controlPlaneId: 'self-service',
        revocationTokenEnv: 'CODE_ADMIN_TOKEN',
        workerPrincipal: { type: 'user', id: ownerId.toString() },
      },
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ protocolVersion: 1, revoked: true }),
    });

    await expect(
      revokeUserCodeEnvironmentWorkers({
        mongoose,
        userId: ownerId.toString(),
        appConfig: {
          endpoints: {
            agents: {
              statefulCodeSessions: {
                allowedEnvironments: ['user'],
                environments: [],
              },
            },
          },
        } as never,
        readSecret: () => 'administrator-token',
        fetchImpl,
      }),
    ).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/bridge/workers/account-worker/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('reports successful revocations without aborting after another worker fails', async () => {
    const ownerId = new Types.ObjectId();
    const registry = createCodeEnvironmentRegistry(mongoose);
    for (const id of ['worker-ok', 'worker-unreachable']) {
      await registry.register({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environment: {
          id,
          name: id,
          type: 'attached',
          baseURL: `https://${id}.example.com/v1`,
          controlPlaneId: 'shared-code-api',
          workerId: id,
          revocationTokenEnv: 'CODE_ADMIN_TOKEN',
          workerPrincipal: { type: 'user', id: ownerId.toString() },
        },
      });
    }
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('unreachable')) {
        throw new Error('control plane unavailable');
      }
      return {
        ok: true,
        json: async () => ({ protocolVersion: 1, revoked: true }),
      } as Response;
    });

    await expect(
      revokeUserCodeEnvironmentWorkers({
        mongoose,
        userId: ownerId.toString(),
        appConfig: {} as never,
        readSecret: () => 'administrator-token',
        fetchImpl,
      }),
    ).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(createMethods(mongoose).deleteUserCodeEnvironments(ownerId)).resolves.toBe(0);
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'worker-ok' }).lean(),
    ).resolves.toMatchObject({ deletionCommittedAt: expect.any(Date) });
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'worker-unreachable' }).lean(),
    ).resolves.toMatchObject({
      revocationPendingAt: expect.any(Date),
      revocationAttempts: 1,
      revocationLastError: 'Code bridge lifecycle request failed',
    });

    const reconcileFailure = jest.fn().mockRejectedValue(new Error('control plane still down'));
    await reconcileCodeEnvironmentLifecycle({
      mongoose,
      readSecret: () => 'administrator-token',
      fetchImpl: reconcileFailure,
    });
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'worker-unreachable' }).lean(),
    ).resolves.toMatchObject({ revocationReconcileAfter: expect.any(Date) });

    await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'worker-later',
        name: 'worker-later',
        type: 'attached',
        baseURL: 'https://worker-later.example.com/v1',
        controlPlaneId: 'shared-code-api',
        workerId: 'worker-later',
        revocationTokenEnv: 'CODE_ADMIN_TOKEN',
        workerPrincipal: { type: 'user', id: ownerId.toString() },
      },
    });
    await mongoose.models.CodeEnvironment.updateOne(
      { environmentId: 'worker-later' },
      { $set: { revocationPendingAt: new Date() } },
    );

    const retryFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ protocolVersion: 1, revoked: true }),
    });
    await reconcileCodeEnvironmentLifecycle({
      mongoose,
      readSecret: () => 'administrator-token',
      fetchImpl: retryFetch,
      limit: 1,
    });
    expect(retryFetch).toHaveBeenCalledWith(
      'https://worker-later.example.com/v1/bridge/workers/worker-later/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'worker-later' }),
    ).resolves.toBeNull();
    retryFetch.mockClear();
    await mongoose.models.CodeEnvironment.updateOne(
      { environmentId: 'worker-unreachable' },
      { $set: { revocationReconcileAfter: new Date(Date.now() - 1_000) } },
    );
    await reconcileCodeEnvironmentLifecycle({
      mongoose,
      readSecret: () => 'administrator-token',
      fetchImpl: retryFetch,
    });
    expect(retryFetch).toHaveBeenCalledWith(
      'https://worker-unreachable.example.com/v1/bridge/workers/worker-unreachable/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'worker-unreachable' }),
    ).resolves.toBeNull();
  });

  test('reconciles an unmarked user worker after its owner document is deleted', async () => {
    const ownerId = new Types.ObjectId();
    await mongoose.models.User.collection.insertOne({
      _id: ownerId,
      email: 'departed-worker-owner@example.com',
    });
    await createCodeEnvironmentRegistry(mongoose).register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'unmarked-orphan-worker',
        name: 'Unmarked orphan worker',
        type: 'attached',
        baseURL: 'https://code.example.com/v1',
        controlPlaneId: 'shared-code-api',
        workerId: 'unmarked-orphan-worker',
        revocationTokenEnv: 'CODE_ADMIN_TOKEN',
        workerPrincipal: { type: 'user', id: ownerId.toString() },
      },
    });
    await createCodeEnvironmentRegistry(mongoose).register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'unmarked-local-environment',
        name: 'Unmarked local environment',
        type: 'attached',
        baseURL: 'https://local.example.com/v1',
        controlPlaneId: 'deployment-code-api',
      },
    });
    await mongoose.models.User.deleteOne({ _id: ownerId });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ protocolVersion: 1, revoked: true }),
    });

    await reconcileCodeEnvironmentLifecycle({
      mongoose,
      readSecret: () => 'administrator-token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://code.example.com/v1/bridge/workers/unmarked-orphan-worker/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'unmarked-orphan-worker' }),
    ).resolves.toBeNull();
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'unmarked-local-environment' }),
    ).resolves.toBeNull();
  });

  test('removes creator-owned environment records and grants when the user is deleted', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'departing-user-vm',
        name: 'Departing user VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });

    await expect(methods.deleteUserCodeEnvironments(ownerId)).resolves.toBe(1);
    await expect(
      registry.listAccessible({ userId: ownerId, role: 'USER', idOnTheSource: null }),
    ).resolves.toEqual([]);
    await expect(
      mongoose.models.AclEntry.countDocuments({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: environment.resourceId,
      }),
    ).resolves.toBe(0);
  });

  test('invalidates shared configuration caches after registration', async () => {
    const cache = createSharedCache();
    const firstWorker = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const secondWorker = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const ownerId = new Types.ObjectId();
    const actor = { userId: ownerId, role: 'USER', idOnTheSource: null };

    await expect(firstWorker.listAccessibleConfigurations(actor)).resolves.toEqual([]);
    await secondWorker.register({
      actor,
      environment: {
        id: 'shared-cache-vm',
        name: 'Shared cache VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });

    await expect(firstWorker.listAccessibleConfigurations(actor)).resolves.toEqual([
      expect.objectContaining({ id: 'shared-cache-vm' }),
    ]);
  });

  test('does not reuse a cached configuration after removal is fenced', async () => {
    const cache = createSharedCache();
    const registry = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const ownerId = new Types.ObjectId();
    const actor = { userId: ownerId, role: 'USER', idOnTheSource: null };
    const environment = await registry.register({
      actor,
      environment: {
        id: 'cached-removal-vm',
        name: 'Cached removal VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    await expect(registry.listAccessibleConfigurations(actor)).resolves.toHaveLength(1);

    await mongoose.models.CodeEnvironment.updateOne(
      { _id: environment.resourceId },
      {
        $set: {
          deletionStartedAt: new Date(),
          deletionLeaseId: 'in-flight-removal',
          deletionLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      },
    );

    await expect(registry.listAccessibleConfigurations(actor)).resolves.toEqual([]);
  });

  test('refreshes mutable settings when a cached configuration revision is stale', async () => {
    const cache = createSharedCache();
    const registry = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const ownerId = new Types.ObjectId();
    const actor = { userId: ownerId, role: 'USER', idOnTheSource: null };
    await registry.register({
      actor,
      environment: {
        id: 'cached-settings-vm',
        name: 'Cached settings VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    await registry.updateSettings({
      actor,
      environmentId: 'cached-settings-vm',
      settings: { permissions: { commandExecution: 'allow' } },
    });
    await expect(registry.listAccessibleConfigurations(actor)).resolves.toEqual([
      expect.objectContaining({
        settings: { permissions: { commandExecution: 'allow' } },
      }),
    ]);

    await mongoose.models.CodeEnvironment.updateOne(
      { environmentId: 'cached-settings-vm' },
      { $set: { 'settings.permissions.commandExecution': 'deny' } },
    );

    await expect(registry.listAccessibleConfigurations(actor)).resolves.toEqual([
      expect.objectContaining({
        settings: { permissions: { commandExecution: 'deny' } },
      }),
    ]);
  });

  test('caches registered environment ids behind the shared tenant revision', async () => {
    const cache = createSharedCache();
    const firstWorker = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const secondWorker = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const distinct = jest.spyOn(mongoose.models.CodeEnvironment, 'distinct');
    const ownerId = new Types.ObjectId();

    await expect(firstWorker.listRegisteredIds()).resolves.toEqual([]);
    await expect(firstWorker.listRegisteredIds()).resolves.toEqual([]);
    expect(distinct).toHaveBeenCalledTimes(1);

    await secondWorker.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'revision-cached-vm',
        name: 'Revision Cached VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });

    await expect(firstWorker.listRegisteredIds()).resolves.toEqual(['revision-cached-vm']);
    expect(distinct).toHaveBeenCalledTimes(2);
    distinct.mockRestore();
  });

  test('invalidates shared configuration caches after ACL revocation', async () => {
    const cache = createSharedCache();
    const registry = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const ownerId = new Types.ObjectId();
    const teammateId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'revoked-vm',
        name: 'Revoked VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    const access = new AccessControlService(mongoose);
    await access.grantPermission({
      principalType: PrincipalType.USER,
      principalId: teammateId,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
      grantedBy: ownerId,
    });
    const teammate = { userId: teammateId, role: 'USER', idOnTheSource: null };
    await expect(registry.listAccessibleConfigurations(teammate)).resolves.toHaveLength(1);

    await mongoose.models.AclEntry.deleteMany({
      principalType: PrincipalType.USER,
      principalId: teammateId,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
    });
    await registry.invalidateAccessibleConfigurations();

    await expect(registry.listAccessibleConfigurations(teammate)).resolves.toEqual([]);
  });

  test('does not reuse revoked access when cache invalidation fails', async () => {
    const cache = createSharedCache();
    const registry = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const ownerId = new Types.ObjectId();
    const teammateId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'fail-closed-vm',
        name: 'Fail Closed VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    const access = new AccessControlService(mongoose);
    await access.grantPermission({
      principalType: PrincipalType.USER,
      principalId: teammateId,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
      grantedBy: ownerId,
    });
    const teammate = { userId: teammateId, role: 'USER', idOnTheSource: null };
    await expect(registry.listAccessibleConfigurations(teammate)).resolves.toHaveLength(1);

    await mongoose.models.AclEntry.deleteMany({
      principalType: PrincipalType.USER,
      principalId: teammateId,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
    });
    cache.set.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(registry.invalidateAccessibleConfigurations()).rejects.toThrow(
      'redis unavailable',
    );

    await expect(registry.listAccessibleConfigurations(teammate)).resolves.toEqual([]);
  });

  test('does not reuse cached access after group membership changes', async () => {
    const cache = createSharedCache();
    const registry = createCodeEnvironmentRegistry(mongoose, { configurationCache: cache });
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    const teammateId = new Types.ObjectId();
    const group = await methods.createGroup({
      name: 'Temporary Code Team',
      source: 'local',
      memberIds: [teammateId.toString()],
    });
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'temporary-group-vm',
        name: 'Temporary Group VM',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    const access = new AccessControlService(mongoose);
    await access.grantPermission({
      principalType: PrincipalType.GROUP,
      principalId: group._id,
      resourceType: ResourceType.CODE_ENVIRONMENT,
      resourceId: environment.resourceId,
      accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
      grantedBy: ownerId,
    });
    const teammate = { userId: teammateId, role: 'USER', idOnTheSource: null };

    await expect(registry.listAccessibleConfigurations(teammate)).resolves.toHaveLength(1);
    await methods.updateGroupById(group._id, { memberIds: [] });
    await expect(registry.listAccessibleConfigurations(teammate)).resolves.toEqual([]);
  });

  test('rolls registration back when shared cache invalidation fails', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose, {
      configurationCache: {
        get: jest.fn(),
        set: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      },
    });
    const ownerId = new Types.ObjectId();

    await expect(
      registry.register({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environment: {
          id: 'rolled-back-vm',
          name: 'Rolled Back VM',
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
        },
      }),
    ).rejects.toThrow('redis unavailable');

    await expect(
      mongoose.models.CodeEnvironment.countDocuments({ environmentId: 'rolled-back-vm' }),
    ).resolves.toBe(0);
    await expect(
      mongoose.models.AclEntry.countDocuments({ resourceType: ResourceType.CODE_ENVIRONMENT }),
    ).resolves.toBe(0);
  });

  test('reconciles a pending registration when ACL rollback fails', async () => {
    const rollback = jest
      .spyOn(AccessControlService.prototype, 'removeAllPermissions')
      .mockRejectedValueOnce(new Error('acl store unavailable'));
    const registry = createCodeEnvironmentRegistry(mongoose, {
      configurationCache: {
        get: jest.fn(),
        set: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      },
    });
    const ownerId = new Types.ObjectId();

    await expect(
      registry.register({
        actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
        environment: {
          id: 'pending-rollback-vm',
          name: 'Pending rollback VM',
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
          workerId: 'shared-deployment-worker',
          workerPrincipal: { type: 'deployment', id: 'shared-code-api' },
        },
      }),
    ).rejects.toThrow('redis unavailable');
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: 'pending-rollback-vm' }).lean(),
    ).resolves.toMatchObject({ registrationPendingAt: expect.any(Date) });

    rollback.mockRestore();
    await mongoose.models.CodeEnvironment.updateOne(
      { environmentId: 'pending-rollback-vm' },
      { $set: { registrationPendingAt: new Date(Date.now() - 10 * 60_000) } },
    );
    await reconcileCodeEnvironmentLifecycle({ mongoose });

    await expect(
      mongoose.models.CodeEnvironment.countDocuments({ environmentId: 'pending-rollback-vm' }),
    ).resolves.toBe(0);
    await expect(
      mongoose.models.AclEntry.countDocuments({ resourceType: ResourceType.CODE_ENVIRONMENT }),
    ).resolves.toBe(0);
  });

  test('claims a stale registration before compensating its worker', async () => {
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    const environment = await methods.createCodeEnvironment({
      environmentId: 'stale-registration-race',
      name: 'Stale registration race',
      type: 'attached',
      baseURL: 'https://code.example.com/v1',
      controlPlaneId: 'shared-code-api',
      createdBy: ownerId,
      workerId: 'stale-registration-race',
      revocationTokenEnv: 'CODE_ADMIN_TOKEN',
      workerPrincipal: { type: 'user', id: ownerId.toString() },
    });
    await mongoose.models.CodeEnvironment.updateOne(
      { _id: environment._id },
      { $set: { registrationPendingAt: new Date(Date.now() - 10 * 60_000) } },
    );
    let enteredRevoke!: () => void;
    let releaseRevoke!: () => void;
    const entered = new Promise<void>((resolve) => (enteredRevoke = resolve));
    const release = new Promise<void>((resolve) => (releaseRevoke = resolve));
    const fetchImpl = jest.fn(async () => {
      enteredRevoke();
      await release;
      return {
        ok: true,
        json: async () => ({ protocolVersion: 1, revoked: true }),
      } as Response;
    });

    const reconciliation = reconcileCodeEnvironmentLifecycle({
      mongoose,
      readSecret: () => 'administrator-token',
      fetchImpl,
    });
    await entered;
    await expect(methods.completeCodeEnvironmentRegistration(environment._id)).rejects.toThrow(
      'registration could not be committed',
    );
    releaseRevoke();
    await reconciliation;

    await expect(mongoose.models.CodeEnvironment.findById(environment._id)).resolves.toBeNull();
  });

  test('preserves a creator-owned environment referenced by another surviving agent', async () => {
    const registry = createCodeEnvironmentRegistry(mongoose);
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    const teammateId = new Types.ObjectId();
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'shared-deployment-worker',
        name: 'Shared deployment worker',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        workerPrincipal: { type: 'deployment', id: 'shared-control-plane' },
      },
    });
    await mongoose.models.Agent.create({
      id: 'agent_survives_owner',
      name: 'Surviving agent',
      author: teammateId,
      model: 'test-model',
      provider: 'test-provider',
      code_environment_id: environment.id,
    });

    await expect(methods.deleteUserCodeEnvironments(ownerId)).resolves.toBe(0);
    await expect(
      mongoose.models.CodeEnvironment.findOne({ environmentId: environment.id }),
    ).resolves.not.toBeNull();
    await expect(
      mongoose.models.AclEntry.countDocuments({ resourceId: environment.resourceId }),
    ).resolves.toBeGreaterThan(0);
  });

  test('recovers expired agent reservations and removal leases', async () => {
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    const environment = await createCodeEnvironmentRegistry(mongoose).register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'expired-lifecycle-leases',
        name: 'Expired lifecycle leases',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    const expiredAt = new Date(Date.now() - 1_000);
    await mongoose.models.CodeEnvironment.updateOne(
      { _id: environment.resourceId },
      {
        $set: {
          deletionStartedAt: expiredAt,
          deletionLeaseId: 'abandoned-removal',
          deletionLeaseExpiresAt: expiredAt,
          pendingAgentReferences: [{ reservationId: 'abandoned-reference', expiresAt: expiredAt }],
        },
      },
    );

    const claimed = await methods.beginCodeEnvironmentRemoval(environment.resourceId);

    expect(claimed).toMatchObject({
      deletionLeaseId: expect.any(String),
      pendingAgentReferences: [],
    });
    expect(claimed?.deletionLeaseId).not.toBe('abandoned-removal');
  });

  test('bounds expired agent reservation cleanup per reconciliation tick', async () => {
    const methods = createMethods(mongoose);
    const ownerId = new Types.ObjectId();
    const expiredAt = new Date(Date.now() - 1_000);
    await mongoose.models.User.create({
      _id: ownerId,
      email: 'reservation-owner@example.com',
      provider: 'local',
    });
    const environments = await Promise.all(
      ['first', 'second'].map((suffix) =>
        methods.createCodeEnvironment({
          environmentId: `expired-reservation-${suffix}`,
          name: `Expired reservation ${suffix}`,
          type: 'attached',
          baseURL: 'https://code.example.com',
          controlPlaneId: 'shared-code-api',
          createdBy: ownerId,
        }),
      ),
    );
    await Promise.all(
      environments.map((environment, index) =>
        mongoose.models.CodeEnvironment.updateOne(
          { _id: environment._id },
          {
            $set: {
              pendingAgentReferences: Array.from(
                { length: index === 0 ? 100 : 1 },
                (_, offset) => ({
                  reservationId: `reservation-${index}-${offset}`,
                  expiresAt: expiredAt,
                }),
              ),
            },
          },
        ),
      ),
    );

    const cleanupPlan = await mongoose.models.CodeEnvironment.collection
      .find({})
      .sort({ _id: 1 })
      .hint('_id_')
      .limit(1)
      .explain('executionStats');
    expect(JSON.stringify(cleanupPlan.queryPlanner.winningPlan)).not.toContain('"stage":"SORT"');
    expect(cleanupPlan.executionStats.totalDocsExamined).toBeLessThanOrEqual(1);
    expect(cleanupPlan.executionStats.totalKeysExamined).toBeLessThanOrEqual(1);

    await reconcileCodeEnvironmentLifecycle({ mongoose, limit: 1 });

    const afterFirstTick = await mongoose.models.CodeEnvironment.countDocuments({
      _id: { $in: environments.map(({ _id }) => _id) },
      'pendingAgentReferences.0': { $exists: true },
    });
    expect(afterFirstTick).toBe(1);

    await reconcileCodeEnvironmentLifecycle({ mongoose, limit: 1 });

    await expect(
      mongoose.models.CodeEnvironment.countDocuments({
        _id: { $in: environments.map(({ _id }) => _id) },
        'pendingAgentReferences.0': { $exists: true },
      }),
    ).resolves.toBe(0);
  });

  test('revisits legacy writes behind the durable cleanup cursor and preserves live leases', async () => {
    const model = mongoose.models.CodeEnvironment;
    const owner = await mongoose.models.User.create({
      email: 'legacy-reference-owner@example.com',
      provider: 'local',
    });
    const environment = await createMethods(mongoose).createCodeEnvironment({
      environmentId: 'legacy-reference',
      name: 'Legacy reference',
      type: 'attached',
      baseURL: 'https://code.example.com',
      controlPlaneId: 'shared-code-api',
      createdBy: owner._id,
    });
    await reconcileCodeEnvironmentLifecycle({ mongoose, limit: 1 });
    const checkpoints = mongoose.connection.db!.collection<{
      _id: string;
      lastId: Types.ObjectId | null;
    }>('code_environment_reconciliation');
    expect((await checkpoints.findOne({ _id: 'agent-reference-cleanup' }))?.lastId).toBeNull();
    const live = { reservationId: 'live', expiresAt: new Date(Date.now() + 60_000) };
    await model.updateOne(
      { _id: environment._id },
      {
        $push: {
          pendingAgentReferences: {
            $each: [{ reservationId: 'abandoned', expiresAt: new Date(0) }, live],
          },
        },
      },
    );
    for (let index = 0; index < 3; index++) {
      await createMethods(mongoose).createCodeEnvironment({
        environmentId: `new-tail-${index}`,
        name: 'New tail',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        createdBy: owner._id,
      });
      await reconcileCodeEnvironmentLifecycle({ mongoose, limit: 1 });
    }
    const result = await model
      .findById(environment._id)
      .lean<{ pendingAgentReferences: (typeof live)[] }>();
    expect(result?.pendingAgentReferences).toEqual([expect.objectContaining(live)]);
  });

  test('preserves persisted agent references during interrupted-removal recovery', async () => {
    const ownerId = new Types.ObjectId();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'referenced-interrupted-removal',
        name: 'Referenced interrupted removal',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
      },
    });
    await mongoose.models.Agent.create({
      id: 'agent_references_interrupted_removal',
      name: 'Referenced environment agent',
      author: ownerId,
      model: 'test-model',
      provider: 'test-provider',
      code_environment_id: environment.id,
    });
    const expiredAt = new Date(Date.now() - 1_000);
    await mongoose.models.CodeEnvironment.updateOne(
      { _id: environment.resourceId },
      {
        $set: {
          deletionStartedAt: expiredAt,
          deletionLeaseId: 'abandoned-removal',
          deletionLeaseExpiresAt: expiredAt,
        },
      },
    );

    await reconcileCodeEnvironmentLifecycle({ mongoose });

    await expect(
      mongoose.models.CodeEnvironment.findById(environment.resourceId).lean(),
    ).resolves.toMatchObject({ environmentId: environment.id });
    await expect(
      mongoose.models.CodeEnvironment.findById(environment.resourceId).lean(),
    ).resolves.not.toHaveProperty('deletionStartedAt');
  });

  test('finishes an interrupted local-only removal', async () => {
    const ownerId = new Types.ObjectId();
    const registry = createCodeEnvironmentRegistry(mongoose);
    const environment = await registry.register({
      actor: { userId: ownerId, role: 'USER', idOnTheSource: null },
      environment: {
        id: 'local-interrupted-removal',
        name: 'Local interrupted removal',
        type: 'attached',
        baseURL: 'https://code.example.com',
        controlPlaneId: 'shared-code-api',
        workerPrincipal: { type: 'deployment', id: 'shared-code-api' },
      },
    });
    const expiredAt = new Date(Date.now() - 1_000);
    await mongoose.models.CodeEnvironment.updateOne(
      { _id: environment.resourceId },
      {
        $set: {
          deletionStartedAt: expiredAt,
          deletionLeaseId: 'abandoned-local-removal',
          deletionLeaseExpiresAt: expiredAt,
        },
      },
    );

    await reconcileCodeEnvironmentLifecycle({ mongoose });

    await expect(
      mongoose.models.CodeEnvironment.findById(environment.resourceId),
    ).resolves.toBeNull();
    await expect(
      mongoose.models.AclEntry.countDocuments({ resourceId: environment.resourceId }),
    ).resolves.toBe(0);
  });

  test('scopes retired environment ids to their tenant', async () => {
    const ownerId = new Types.ObjectId();
    const input = {
      environmentId: 'tenant-reusable-id',
      name: 'Tenant VM',
      type: 'attached' as const,
      baseURL: 'https://code.example.com',
      controlPlaneId: 'shared-code-api',
      createdBy: ownerId,
    };

    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      const methods = createMethods(mongoose);
      const created = await methods.createCodeEnvironment(input);
      await methods.deleteCodeEnvironmentById(created._id);
      await expect(methods.createCodeEnvironment(input)).rejects.toThrow(
        'Code environment id was previously retired',
      );
    });

    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      await expect(createMethods(mongoose).createCodeEnvironment(input)).resolves.toMatchObject({
        environmentId: 'tenant-reusable-id',
        tenantId: 'tenant-b',
      });
    });
  });

  test('scopes recovered agent references to the environment tenant', async () => {
    const ownerId = new Types.ObjectId();
    let tenantAEnvironmentId!: Types.ObjectId;
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      const environment = await createMethods(mongoose).createCodeEnvironment({
        environmentId: 'shared-tenant-environment-id',
        name: 'Tenant A environment',
        type: 'attached',
        baseURL: 'https://tenant-a.example.com',
        controlPlaneId: 'shared-code-api',
        createdBy: ownerId,
      });
      tenantAEnvironmentId = environment._id;
      await mongoose.models.CodeEnvironment.updateOne(
        { _id: environment._id },
        {
          $unset: { registrationPendingAt: 1 },
          $set: {
            deletionStartedAt: new Date(Date.now() - 10_000),
            deletionLeaseId: 'expired-tenant-a-removal',
            deletionLeaseExpiresAt: new Date(Date.now() - 1_000),
          },
        },
      );
    });
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      await createMethods(mongoose).createAgent({
        id: 'agent_tenant_b_shared_environment_id',
        name: 'Tenant B agent',
        author: ownerId,
        model: 'test-model',
        provider: 'test-provider',
        code_environment_id: 'shared-tenant-environment-id',
      });
    });

    await reconcileCodeEnvironmentLifecycle({ mongoose });

    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await expect(
        mongoose.models.CodeEnvironment.findById(tenantAEnvironmentId),
      ).resolves.toBeNull();
    });
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      await expect(
        mongoose.models.Agent.findOne({ id: 'agent_tenant_b_shared_environment_id' }),
      ).resolves.not.toBeNull();
    });
  });
});
