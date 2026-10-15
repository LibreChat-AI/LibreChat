import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ResourceType, PrincipalType } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  tenantStorage,
  createSkillDeletionPersistenceAdapter,
} from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { CheckpointDeletion } from '~/agents/checkpoints/deletion';
import type { UserErasureDeps } from './erasure';
import { deleteAllSharedLinksWithCleanup } from '~/shared-links/service';
import { createSkillDeletionService } from '../skills/deletionService';
import { eraseUserData } from './erasure';

const OWNER_BITS = 15;

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  createModels(mongoose);
  await mongoose.connect(mongo.getUri());
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

const model = (name: string) => mongoose.models[name].collection;
const count = (name: string, filter: Record<string, unknown>) => model(name).countDocuments(filter);

async function seedUser(userId: mongoose.Types.ObjectId) {
  const user = userId.toString();
  const skillId = new mongoose.Types.ObjectId();
  const mcpServerId = new mongoose.Types.ObjectId();
  const legacyServerId = new mongoose.Types.ObjectId();

  await model('Skill').insertOne({ _id: skillId, name: `skill-${user}`, author: userId });
  await model('SkillFile').insertOne({
    skillId,
    relativePath: 'notes.md',
    file_id: `skill-file-${user}`,
    filepath: `/uploads/${user}/notes.md`,
    source: 'local',
    author: userId,
  });
  await methods.grantPermission(
    PrincipalType.USER,
    userId,
    ResourceType.SKILL,
    skillId,
    OWNER_BITS,
    userId,
  );
  await model('MCPServer').insertMany([
    { _id: mcpServerId, serverName: `acl-${user}`, author: userId },
    { _id: legacyServerId, serverName: `legacy-${user}`, author: userId },
  ]);
  await methods.grantPermission(
    PrincipalType.USER,
    userId,
    ResourceType.MCPSERVER,
    mcpServerId,
    OWNER_BITS,
    userId,
  );
  await model('SharedLink').insertOne({ user, conversationId: `convo-${user}`, shareId: user });
  await model('File').insertMany([
    { user: userId, file_id: `file-a-${user}`, filepath: '/uploads/a', source: 'local' },
    { user: userId, file_id: `file-b-${user}`, filepath: '/uploads/b', source: 's3' },
  ]);
  await model('Conversation').insertOne({ user, conversationId: `convo-${user}` });
  await model('Transaction').insertOne({ user: userId, tokenType: 'prompt', rawAmount: -1 });
  await model('ToolFavorite').insertOne({ user: userId, itemType: 'tool', itemId: 'web' });
  await model('ChatProject').insertOne({ user, name: `project-${user}` });
  await model('AgentQueuedTurn').insertOne({ user: userId, conversationId: `convo-${user}` });
  await model('AgentQueuedTurnSequence').insertOne({
    user: userId,
    conversationId: `convo-${user}`,
  });
  await model('RefreshTokenBridge').insertOne({
    userId: user,
    tenantId: 'tenant-1',
    oldRefreshTokenHash: `hash-${user}`,
    encryptedNewRefreshToken: 'encrypted',
  });
  return { skillId, mcpServerId, legacyServerId };
}

function createDeps() {
  const order: string[] = [];
  const checkpointDeletion: CheckpointDeletion = {
    conversationIds: () => [],
    remember: jest.fn(async () => {
      order.push('remember');
    }),
    cleanup: jest.fn(async () => {
      order.push('cleanup');
    }),
    acknowledge: jest.fn(async () => {
      order.push('acknowledge');
    }),
  };
  const deps: UserErasureDeps = {
    ...methods,
    openCheckpointDeletion: jest.fn(async () => checkpointDeletion),
    deleteSharedLinks: deleteAllSharedLinksWithCleanup,
    deleteStoredFiles: jest.fn(async () => {
      order.push('deleteStoredFiles');
    }),
    invalidateMCPServerTools: jest.fn(async () => undefined),
    disconnectMCPServer: jest.fn(async () => undefined),
  };
  return { deps, checkpointDeletion, order };
}

async function finishSkillCleanup(skillId: mongoose.Types.ObjectId) {
  const deleteFile = jest.fn(async () => undefined);
  const worker = createSkillDeletionService({
    persistence: { ...methods, ...createSkillDeletionPersistenceAdapter(methods) },
    loadConfig: async () =>
      ({ skillDeletion: { finalizationEnabled: true } }) as unknown as AppConfig,
    getStrategyFunctions: () => ({ deleteFile }),
    runAsSystem: async (callback) => callback(),
    logger: { error: jest.fn(), warn: jest.fn() },
  });
  const sweep = worker.startSkillDeletionSweep({ sweepIntervalMs: 1_000 });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await count('Skill', { _id: skillId })) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await count('Skill', { _id: skillId })).toBe(0);
    expect(await count('SkillFile', { skillId })).toBe(0);
    expect(deleteFile).toHaveBeenCalledTimes(1);
  } finally {
    sweep.stop();
  }
}

describe('eraseUserData', () => {
  it('clears skills, MCP servers, shared links, file objects and checkpoints', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const user = userId.toString();
    const { skillId } = await seedUser(userId);
    const other = await seedUser(otherId);
    const { deps, checkpointDeletion, order } = createDeps();

    await eraseUserData({ userId: user, tenantId: 'tenant-1', checkpointer: { ttl: 60 } }, deps);

    expect(deps.openCheckpointDeletion).toHaveBeenCalledWith(user, 'tenant-1', undefined, {
      ttl: 60,
    });
    expect(checkpointDeletion.remember).toHaveBeenCalledWith([`convo-${user}`]);
    expect(order.slice(0, 3)).toEqual(['remember', 'cleanup', 'acknowledge']);
    expect(await count('Conversation', { user })).toBe(0);

    expect(deps.deleteStoredFiles).toHaveBeenCalledTimes(1);
    const storedFiles = (deps.deleteStoredFiles as jest.Mock).mock.calls[0][0];
    expect(storedFiles.map((file: { file_id: string }) => file.file_id).sort()).toEqual([
      `file-a-${user}`,
      `file-b-${user}`,
    ]);
    expect(await count('File', { user: userId })).toBe(0);

    expect(await methods.getSkillById(skillId)).toBeNull();
    expect(await count('Skill', { _id: skillId, deletionNeedsJournal: true })).toBe(1);
    expect(await count('SkillFile', { skillId })).toBe(1);
    expect(await count('MCPServer', { author: userId })).toBe(0);
    expect(deps.invalidateMCPServerTools).toHaveBeenCalledWith(`acl-${user}`);
    expect(deps.invalidateMCPServerTools).toHaveBeenCalledWith(`legacy-${user}`);
    expect(deps.disconnectMCPServer).toHaveBeenCalledWith(`acl-${user}`);
    expect(deps.disconnectMCPServer).toHaveBeenCalledWith(`legacy-${user}`);
    expect(await count('SharedLink', { user })).toBe(0);
    expect(await count('AclEntry', { principalId: userId })).toBe(0);
    await finishSkillCleanup(skillId);
    expect(await count('Transaction', { user: userId })).toBe(0);
    expect(await count('ToolFavorite', { user: userId })).toBe(0);
    expect(await count('ChatProject', { user })).toBe(0);
    expect(await count('AgentQueuedTurn', { user: userId })).toBe(0);
    expect(await count('AgentQueuedTurnSequence', { user: userId })).toBe(0);
    expect(await count('RefreshTokenBridge', { userId: user })).toBe(0);

    expect(await count('Skill', { _id: other.skillId })).toBe(1);
    expect(await count('MCPServer', { author: otherId })).toBe(2);
    expect(await count('SharedLink', { user: otherId.toString() })).toBe(1);
    expect(await count('File', { user: otherId })).toBe(2);
    expect(await count('Conversation', { user: otherId.toString() })).toBe(1);
    expect(await count('ToolFavorite', { user: otherId })).toBe(1);
    expect(await count('ChatProject', { user: otherId.toString() })).toBe(1);
    expect(await count('AgentQueuedTurn', { user: otherId })).toBe(1);
    expect(await count('AgentQueuedTurnSequence', { user: otherId })).toBe(1);
    expect(await count('RefreshTokenBridge', { userId: otherId.toString() })).toBe(1);
  });

  it('keeps the transaction ledger when the operator retains it', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();

    await eraseUserData({ userId: userId.toString(), keepTransactions: true }, deps);

    expect(await count('Transaction', { user: userId })).toBe(1);
    expect(await count('Conversation', { user: userId.toString() })).toBe(0);
  });

  it('deletes pre-tenancy refresh bridges while running in the active tenant context', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    await model('RefreshTokenBridge').insertOne({
      userId: userId.toString(),
      oldRefreshTokenHash: 'legacy-hash',
      encryptedNewRefreshToken: 'encrypted',
    });
    const { deps } = createDeps();

    await tenantStorage.run({ tenantId: 'tenant-1' }, async () =>
      eraseUserData({ userId: userId.toString(), tenantId: 'tenant-1' }, deps),
    );

    expect(await count('RefreshTokenBridge', { userId: userId.toString() })).toBe(0);
  });

  it('removes refresh bridges written before tenancy for a tenant user', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();
    const calls: unknown[] = [];
    (deps as { deleteRefreshTokenBridges: unknown }).deleteRefreshTokenBridges = jest.fn(
      async (data: unknown) => {
        calls.push(data);
        return { acknowledged: true, deletedCount: 0 };
      },
    );

    await eraseUserData({ userId: userId.toString(), tenantId: 'tenant-1' }, deps);

    expect(calls).toEqual([
      { userId: userId.toString(), tenantId: 'tenant-1' },
      { userId: userId.toString() },
    ]);
  });

  it('cleans OAuth state of users a removed MCP server was shared with', async () => {
    const userId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(userId);
    await methods.grantPermission(
      PrincipalType.USER,
      viewerId,
      ResourceType.MCPSERVER,
      mcpServerId,
      1,
      userId,
    );
    const serverName = `acl-${userId}`;
    await model('Token').insertMany(
      [viewerId, strangerId].map((tokenUser) => ({
        userId: tokenUser,
        type: 'mcp_oauth',
        identifier: `mcp:${serverName}`,
        token: 'encrypted',
        expiresAt: new Date(Date.now() + 60_000),
      })),
    );
    const { deps } = createDeps();
    const fenced: string[] = [];
    const uninstalled: Array<[string, string]> = [];
    deps.mcpOAuth = {
      getServerConfig: jest.fn(async () => undefined),
      getUserPrincipals: jest.fn(async (candidate: string) =>
        candidate === viewerId.toString()
          ? [{ principalType: PrincipalType.USER, principalId: candidate }]
          : [],
      ),
      resolveAllowlists: jest.fn(async () => ({})),
      invalidateUserTools: jest.fn(async (candidate: string, fencedServer: string) => {
        if (fencedServer === serverName) {
          fenced.push(candidate);
        }
      }),
      uninstallOAuthMCP: jest.fn(async (candidate: string, pluginKey: string) => {
        if (pluginKey === `mcp_${serverName}`) {
          uninstalled.push([candidate, pluginKey]);
        }
      }),
    };

    await eraseUserData({ userId: userId.toString() }, deps);

    const expected = [userId.toString(), viewerId.toString()].sort();
    expect([...fenced].sort()).toEqual(expected);
    expect(uninstalled.map(([candidate]) => candidate).sort()).toEqual(expected);
    expect(uninstalled.every(([, key]) => key === `mcp_${serverName}`)).toBe(true);
    expect(await count('MCPServer', { author: userId })).toBe(0);
  });

  it('never treats token holders of a same-named server in another tenant as shared users', async () => {
    const userId = new mongoose.Types.ObjectId();
    const foreignId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const serverName = `acl-${userId}`;
    await model('Token').insertOne({
      userId: foreignId,
      tenantId: 'tenant-2',
      type: 'mcp_oauth',
      identifier: `mcp:${serverName}`,
      token: 'encrypted',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { deps } = createDeps();
    const touched: string[] = [];
    deps.mcpOAuth = {
      getUserPrincipals: jest.fn(async (candidate: string) => {
        touched.push(candidate);
        return [];
      }),
      resolveAllowlists: jest.fn(async () => ({})),
      uninstallOAuthMCP: jest.fn(async () => undefined),
    };

    await eraseUserData({ userId: userId.toString() }, deps);

    expect(touched).not.toContain(foreignId.toString());
    expect(await count('Token', { userId: foreignId })).toBe(1);
  });

  it('keeps the server and its ACLs when shared-user OAuth cleanup fails, so a retry finishes it', async () => {
    const userId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(userId);
    await methods.grantPermission(
      PrincipalType.USER,
      viewerId,
      ResourceType.MCPSERVER,
      mcpServerId,
      1,
      userId,
    );
    const serverName = `acl-${userId}`;
    await model('Token').insertOne({
      userId: viewerId,
      type: 'mcp_oauth',
      identifier: `mcp:${serverName}`,
      token: 'encrypted',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { deps } = createDeps();
    const uninstalled: string[] = [];
    let outage = true;
    deps.mcpOAuth = {
      getUserPrincipals: jest.fn(async (candidate: string) =>
        candidate === viewerId.toString()
          ? [{ principalType: PrincipalType.USER, principalId: candidate }]
          : [],
      ),
      resolveAllowlists: jest.fn(async () => ({})),
      uninstallOAuthMCP: jest.fn(async (candidate: string, pluginKey: string) => {
        if (outage) {
          throw new Error('redis down');
        }
        if (pluginKey === `mcp_${serverName}`) {
          uninstalled.push(candidate);
        }
      }),
    };

    await expect(eraseUserData({ userId: userId.toString() }, deps)).rejects.toThrow(
      'MCP OAuth cleanup failed',
    );
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(1);
    expect(await count('AclEntry', { resourceId: mcpServerId })).toBe(2);

    outage = false;
    await eraseUserData({ userId: userId.toString() }, deps);

    expect(uninstalled).toContain(viewerId.toString());
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(0);
  });

  it('signals session revocation even when a later step fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();
    const onSessionsDeleted = jest.fn();
    (deps.deletePresets as jest.Mock) = jest.fn().mockRejectedValue(new Error('presets down'));

    await expect(
      eraseUserData({ userId: userId.toString() }, { ...deps, onSessionsDeleted }),
    ).rejects.toThrow('presets down');

    expect(onSessionsDeleted).toHaveBeenCalledTimes(1);
  });

  it('erases nothing past conversations when checkpoint capture fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps, checkpointDeletion } = createDeps();
    (checkpointDeletion.cleanup as jest.Mock).mockRejectedValueOnce(new Error('store down'));

    await expect(eraseUserData({ userId: userId.toString() }, deps)).rejects.toThrow('store down');

    expect(checkpointDeletion.acknowledge).not.toHaveBeenCalled();
    expect(deps.deleteStoredFiles).not.toHaveBeenCalled();
    expect(await count('File', { user: userId })).toBe(2);
    expect(await count('Skill', { author: userId })).toBe(1);
  });

  it('stops before group and ACL cleanup when the MCP server lookup fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();
    const failingDeps: UserErasureDeps = {
      ...deps,
      findUserErasableMCPServers: jest.fn().mockRejectedValue(new Error('mongo down')),
    };

    await expect(eraseUserData({ userId: userId.toString() }, failingDeps)).rejects.toThrow(
      'mongo down',
    );

    expect(await count('MCPServer', { author: userId })).toBe(2);
    expect(await count('AclEntry', { principalId: userId })).toBeGreaterThan(0);
  });

  it('removes stored files while the user keys their provider clients need still exist', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps, order } = createDeps();
    const deleteUserKey = deps.deleteUserKey;
    const orderedDeps: UserErasureDeps = {
      ...deps,
      deleteUserKey: jest.fn(async (params) => {
        order.push('deleteUserKey');
        return deleteUserKey(params);
      }),
    };

    await eraseUserData({ userId: userId.toString() }, orderedDeps);

    expect(order.indexOf('deleteStoredFiles')).toBeLessThan(order.indexOf('deleteUserKey'));
  });

  it('still erases the account when the storage provider fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    const { skillId } = await seedUser(userId);
    const { deps } = createDeps();
    (deps.deleteStoredFiles as jest.Mock).mockRejectedValueOnce(new Error('provider down'));

    await eraseUserData({ userId: userId.toString() }, deps);

    expect(await count('File', { user: userId })).toBe(0);
    expect(await methods.getSkillById(skillId)).toBeNull();
    expect(await count('AclEntry', { principalId: userId })).toBe(0);
    await finishSkillCleanup(skillId);
  });

  it('calls deleteUserPrompts with the user id during erasure', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();
    const deleteUserPrompts = jest.fn(async () => undefined);

    await eraseUserData({ userId: userId.toString() }, { ...deps, deleteUserPrompts });

    expect(deleteUserPrompts).toHaveBeenCalledWith(userId.toString());
  });

  for (const modelName of ['Agent', 'PromptGroup']) {
    it(`keeps the account erasable when the ${modelName} lookup fails`, async () => {
      const userId = new mongoose.Types.ObjectId();
      await seedUser(userId);
      const { deps } = createDeps();
      const find = jest.spyOn(mongoose.models[modelName], 'find').mockImplementationOnce(() => {
        throw new Error(`${modelName} store down`);
      });

      try {
        await expect(eraseUserData({ userId: userId.toString() }, deps)).rejects.toThrow(
          `${modelName} store down`,
        );
      } finally {
        find.mockRestore();
      }

      expect(await count('MCPServer', { author: userId })).toBe(2);
    });
  }
});
