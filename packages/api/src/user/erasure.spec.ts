import { Keyv } from 'keyv';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ResourceType, PrincipalType } from 'librechat-data-provider';
import {
  createPostgresFavoriteBackend,
  createPostgresDatabase,
  migratePostgres,
  importFavorites,
  createModels,
  createMethods,
  tenantStorage,
  createSkillDeletionPersistenceAdapter,
  logger,
} from '@librechat/data-schemas';
import type { PostgresDatabase } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { CheckpointDeletion } from '~/agents/checkpoints/deletion';
import type { UserErasureDeps, MCPOAuthErasureHooks } from './erasure';
import type { MCPOAuthTokens } from '~/mcp/oauth/types';
import {
  deleteUserMCPServers,
  eraseUserData,
  cancelUserDataDeletion,
  createUserDeletionAttempt,
} from './erasure';
import { MCPOAuthHandler, MCPTokenStorage, getMCPOAuthLeaseId } from '~/mcp/oauth';
import { deleteAllSharedLinksWithCleanup } from '~/shared-links/service';
import { createSkillDeletionService } from '../skills/deletionService';
import { cleanupMCPServerOAuth } from '~/mcp/oauth/cleanup';
import { createFavoriteRuntime } from '~/app/persistence';
import { FlowStateManager } from '~/flow/manager';

/** Stored OAuth credentials are encrypted with a key read when the module loads. */
jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY = process.env.CREDS_KEY || 'a'.repeat(64);
  return jest.requireActual('@librechat/data-schemas');
});

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
  await mongo?.stop();
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
    deleteStoredFiles: jest.fn(async (files) => {
      order.push('deleteStoredFiles');
      return { deletedFileIds: files.map((file) => file.file_id), failedFileIds: [] };
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

  it('keeps new file retry anchors and provider credentials after concurrent provisioning', async () => {
    const userId = new mongoose.Types.ObjectId();
    const user = userId.toString();
    await seedUser(userId);
    const { deps } = createDeps();
    deps.deleteStoredFiles = jest.fn(async (files) => {
      await model('File').insertOne({
        user: userId,
        file_id: 'newly-provisioned',
        metadata: { codeEnvRefs: { default: { file_id: 'remote-copy' } } },
      });
      return { deletedFileIds: files.map((file) => file.file_id), failedFileIds: [] };
    });
    const deleteKeys = jest.spyOn(deps, 'deleteUserKey');
    const getFiles = jest.spyOn(deps, 'getFiles');
    await expect(eraseUserData({ userId: user }, deps)).rejects.toThrow(
      'Stored file deletion incomplete',
    );
    expect(await count('File', { user: userId, file_id: 'newly-provisioned' })).toBe(1);
    expect(deleteKeys).not.toHaveBeenCalled();
    expect(getFiles).toHaveBeenNthCalledWith(2, { user }, undefined, { _id: 1 }, 1);
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

  it('surfaces a failed leaf delete and stops before the steps after it', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();
    const presetsError = new Error('presets down');
    const failingDeps: UserErasureDeps = {
      ...deps,
      deletePresets: jest.fn().mockRejectedValue(presetsError),
      deleteAllUserMemories: jest.fn().mockRejectedValue(new Error('memories down')),
      deleteSharedLinks: jest.fn(async () => undefined),
    };
    const deleteToolCalls = jest.spyOn(failingDeps, 'deleteToolCalls');

    await expect(eraseUserData({ userId: userId.toString() }, failingDeps)).rejects.toBe(
      presetsError,
    );

    expect(deleteToolCalls).toHaveBeenCalledTimes(1);
    expect(failingDeps.deleteSharedLinks).not.toHaveBeenCalled();
    expect(await count('MCPServer', { author: userId })).toBe(2);
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

  it.each(['reported', 'thrown', 'unreported'])('keeps anchors on %s failure', async (failure) => {
    const userId = new mongoose.Types.ObjectId();
    await seedUser(userId);
    const { deps } = createDeps();
    const removeKeys = jest.spyOn(deps, 'deleteUserKey');
    if (failure === 'thrown') {
      (deps.deleteStoredFiles as jest.Mock).mockRejectedValueOnce(new Error('provider down'));
    } else {
      (deps.deleteStoredFiles as jest.Mock).mockResolvedValueOnce({
        deletedFileIds: [],
        failedFileIds: failure === 'reported' ? [`file-a-${userId}`] : [],
      });
    }

    await expect(eraseUserData({ userId: userId.toString() }, deps)).rejects.toThrow();
    expect(await count('File', { user: userId })).toBe(2);
    expect(removeKeys).not.toHaveBeenCalled();
    expect(await count('MCPServer', { author: userId })).toBe(2);

    await eraseUserData({ userId: userId.toString() }, deps);
    expect(await count('File', { user: userId })).toBe(0);
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

describe('removing a shared MCP server with its owner', () => {
  const SERVER_URL = 'https://mcp.example.com/mcp';
  const serverConfig = { type: 'streamable-http' as const, url: SERVER_URL, oauth: {} };

  /** The host teardown the CLI wires, with only the provider's revocation endpoint replaced. */
  function createOAuthHost(
    revokeOAuthToken: jest.Mock,
    deleteTokens: typeof methods.deleteTokens = methods.deleteTokens,
  ) {
    const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), { ttl: 60_000 });
    const uninstallOAuthMCP: MCPOAuthErasureHooks['uninstallOAuthMCP'] = (
      userId,
      pluginKey,
      appConfig,
      config,
      teardown,
    ) =>
      cleanupMCPServerOAuth({
        userId,
        pluginKey,
        appConfig,
        serverConfigOverride: config,
        teardown,
        dependencies: {
          flowManager,
          oauthHandler: {
            generateFlowId: MCPOAuthHandler.generateFlowId.bind(MCPOAuthHandler),
            generateTokenFlowId: MCPOAuthHandler.generateTokenFlowId.bind(MCPOAuthHandler),
            deleteFlowAndStateMapping:
              MCPOAuthHandler.deleteFlowAndStateMapping.bind(MCPOAuthHandler),
            revokeOAuthToken,
          },
          tokenStorage: MCPTokenStorage,
          findToken: methods.findToken,
          deleteTokens,
          getServerConfig: async () => undefined,
          isRegisteredOAuthServer: async () => false,
        },
      });
    return { flowManager, uninstallOAuthMCP };
  }

  async function authorize(userId: mongoose.Types.ObjectId, serverName: string) {
    await MCPTokenStorage.storeTokens({
      userId: userId.toString(),
      serverName,
      tokens: {
        access_token: `access-${userId}`,
        refresh_token: `refresh-${userId}`,
        token_type: 'Bearer',
        expires_in: 3600,
      },
      createToken: methods.createToken,
      updateToken: methods.updateToken,
      findToken: methods.findToken,
      deleteTokens: methods.deleteTokens,
      clientInfo: { client_id: 'shared-client', client_secret: 'shared-secret' },
      metadata: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        revocation_endpoint: 'https://auth.example.com/revoke',
        response_types_supported: ['code'],
        server_url: SERVER_URL,
        client_source: 'dynamic',
      },
    });
  }

  async function share(
    serverId: mongoose.Types.ObjectId,
    ownerId: mongoose.Types.ObjectId,
    principalType: PrincipalType,
    principalId: mongoose.Types.ObjectId,
  ) {
    await methods.grantPermission(
      principalType,
      principalId,
      ResourceType.MCPSERVER,
      serverId,
      1,
      ownerId,
    );
  }

  function createServerDeps(oauth: MCPOAuthErasureHooks) {
    const { deps } = createDeps();
    return { ...deps, mcpOAuth: oauth };
  }

  it('fences viewers who reach the server through its ACL without an OAuth token', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const directViewerId = new mongoose.Types.ObjectId();
    const groupViewerId = new mongoose.Types.ObjectId();
    const externalViewerId = new mongoose.Types.ObjectId();
    const outsiderId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(ownerId);
    const serverName = `acl-${ownerId}`;
    await model('User').insertMany([
      { _id: groupViewerId, email: `group-${groupViewerId}@example.com` },
      {
        _id: externalViewerId,
        email: `ext-${externalViewerId}@example.com`,
        idOnTheSource: 'entra-1',
      },
      { _id: outsiderId, email: `out-${outsiderId}@example.com` },
    ]);
    const groupId = new mongoose.Types.ObjectId();
    await model('Group').insertOne({
      _id: groupId,
      name: 'Viewers',
      source: 'local',
      memberIds: [groupViewerId.toString(), 'entra-1'],
    });
    await share(mcpServerId, ownerId, PrincipalType.USER, directViewerId);
    await share(mcpServerId, ownerId, PrincipalType.GROUP, groupId);
    const fenced: string[] = [];
    const disconnected: string[] = [];
    const uninstalled: string[] = [];
    const deps = createServerDeps({
      getServerConfig: async () => ({ type: 'streamable-http', url: SERVER_URL }),
      getUserPrincipals: (candidate) => methods.getUserPrincipals({ userId: candidate }),
      resolveAllowlists: async () => ({}),
      invalidateUserTools: async (candidate, fencedServer) => {
        if (fencedServer === serverName) fenced.push(candidate);
      },
      disconnectUser: async (candidate, fencedServer) => {
        if (fencedServer === serverName) disconnected.push(candidate);
      },
      uninstallOAuthMCP: async (candidate, pluginKey) => {
        if (pluginKey === `mcp_${serverName}`) uninstalled.push(candidate);
      },
    });

    await deleteUserMCPServers(ownerId.toString(), deps);

    const expected = [ownerId, directViewerId, groupViewerId, externalViewerId].map(String).sort();
    expect([...new Set(fenced)].sort()).toEqual(expected);
    expect([...new Set(disconnected)].sort()).toEqual(expected);
    expect([...new Set(uninstalled)].sort()).toEqual(expected);
    expect(fenced).not.toContain(outsiderId.toString());
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(0);
  });

  it('removes the server and reports the grant when the provider refuses a revocation', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(ownerId);
    const serverName = `acl-${ownerId}`;
    await share(mcpServerId, ownerId, PrincipalType.USER, viewerId);
    await authorize(viewerId, serverName);
    const revokeOAuthToken = jest.fn().mockRejectedValue(new Error('provider returned 503'));
    const { uninstallOAuthMCP } = createOAuthHost(revokeOAuthToken);
    const deps = createServerDeps({
      getServerConfig: async () => serverConfig,
      getUserPrincipals: (candidate) => methods.getUserPrincipals({ userId: candidate }),
      resolveAllowlists: async () => ({}),
      uninstallOAuthMCP,
    });
    const reported = jest.spyOn(logger, 'error');

    await deleteUserMCPServers(ownerId.toString(), deps);

    expect(revokeOAuthToken.mock.calls.map(([, token, type]) => [token, type])).toEqual([
      [`access-${viewerId}`, 'access'],
      [`refresh-${viewerId}`, 'refresh'],
    ]);
    expect(await count('Token', { userId: viewerId })).toBe(0);
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(0);
    expect(reported).toHaveBeenCalledWith(
      expect.stringContaining(
        `${serverName} did not revoke the access and refresh token of user ${viewerId}`,
      ),
    );
  });

  it('fails closed, keeping the server, when a local token delete fails', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(ownerId);
    const serverName = `acl-${ownerId}`;
    await share(mcpServerId, ownerId, PrincipalType.USER, viewerId);
    await authorize(viewerId, serverName);
    let outage = true;
    const { uninstallOAuthMCP } = createOAuthHost(
      jest.fn().mockResolvedValue(undefined),
      async (query) => {
        if (outage) {
          throw new Error('mongo down');
        }
        return methods.deleteTokens(query);
      },
    );
    const deps = createServerDeps({
      getServerConfig: async () => serverConfig,
      getUserPrincipals: (candidate) => methods.getUserPrincipals({ userId: candidate }),
      resolveAllowlists: async () => ({}),
      uninstallOAuthMCP,
    });

    await expect(deleteUserMCPServers(ownerId.toString(), deps)).rejects.toThrow(
      'MCP OAuth cleanup failed',
    );
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(1);
    expect(await count('AclEntry', { resourceId: mcpServerId })).toBe(2);
    expect(await count('Token', { userId: viewerId })).toBeGreaterThan(0);

    outage = false;
    await deleteUserMCPServers(ownerId.toString(), deps);
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(0);
    expect(await count('Token', { userId: viewerId })).toBe(0);
  });

  it('holds every OAuth teardown fence until the server delete commits', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(ownerId);
    const serverName = `acl-${ownerId}`;
    await share(mcpServerId, ownerId, PrincipalType.USER, viewerId);
    await authorize(viewerId, serverName);
    const revokeOAuthToken = jest.fn().mockResolvedValue(undefined);
    const { flowManager, uninstallOAuthMCP } = createOAuthHost(revokeOAuthToken);
    const leaseIds = [ownerId, viewerId].map((id) => getMCPOAuthLeaseId(id.toString(), serverName));
    const { deps } = createDeps();
    const duringDelete: Array<number | null> = [];
    const persistedDuringDelete: Array<boolean> = [];
    const deleteMCPServersWithAcl = deps.deleteMCPServersWithAcl;

    await deleteUserMCPServers(ownerId.toString(), {
      ...deps,
      deleteMCPServersWithAcl: async (ids) => {
        for (const leaseId of leaseIds) {
          duringDelete.push(await flowManager.getLeaseGeneration(leaseId));
        }
        /** A callback persisting a new authorization takes the same fence and must not get it. */
        const lease = await flowManager.acquireLease(leaseIds[1], { waitMs: 0 });
        persistedDuringDelete.push(lease != null);
        await lease?.release();
        return deleteMCPServersWithAcl(ids);
      },
      mcpOAuth: {
        getServerConfig: async () => serverConfig,
        getUserPrincipals: (candidate) => methods.getUserPrincipals({ userId: candidate }),
        resolveAllowlists: async () => ({}),
        uninstallOAuthMCP,
      },
    });

    expect(duringDelete).toEqual([null, null]);
    expect(persistedDuringDelete).toEqual([false]);
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(0);
    for (const leaseId of leaseIds) {
      expect(await flowManager.getLeaseGeneration(leaseId)).toEqual(expect.any(Number));
    }
    expect(MCPTokenStorage.isRefreshTeardownActive(viewerId.toString(), serverName)).toBe(false);
  });

  it('keeps the server when a held fence lapsed and another writer took it before the delete', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(ownerId);
    const serverName = `acl-${ownerId}`;
    await share(mcpServerId, ownerId, PrincipalType.USER, viewerId);
    await authorize(viewerId, serverName);
    const { flowManager, uninstallOAuthMCP } = createOAuthHost(
      jest.fn().mockResolvedValue(undefined),
    );
    const viewerLeaseId = getMCPOAuthLeaseId(viewerId.toString(), serverName);
    const deleteMCPServersWithAcl = jest.fn();
    const { deps } = createDeps();
    let lapsed = false;

    await expect(
      deleteUserMCPServers(ownerId.toString(), {
        ...deps,
        deleteMCPServersWithAcl,
        mcpOAuth: {
          getServerConfig: async () => serverConfig,
          getUserPrincipals: (candidate) => methods.getUserPrincipals({ userId: candidate }),
          resolveAllowlists: async () => ({}),
          uninstallOAuthMCP: async (candidate, pluginKey, appConfig, config, teardown) => {
            await uninstallOAuthMCP(candidate, pluginKey, appConfig, config, teardown);
            if (candidate !== viewerId.toString() || lapsed) {
              return;
            }
            /** The viewer's lease outlived its 15 minutes; a callback on another replica took it. */
            lapsed = true;
            const realNow = Date.now();
            const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow + 16 * 60_000);
            try {
              const writer = await flowManager.acquireLease(viewerLeaseId, { waitMs: 0 });
              expect(writer).not.toBeNull();
              await writer?.release();
            } finally {
              clock.mockRestore();
            }
          },
        },
      }),
    ).rejects.toThrow('fence lapsed');

    expect(lapsed).toBe(true);
    expect(deleteMCPServersWithAcl).not.toHaveBeenCalled();
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(1);
    expect(MCPTokenStorage.isRefreshTeardownActive(viewerId.toString(), serverName)).toBe(false);
  });

  it('releases every held fence when a teardown fails locally', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId();
    const { mcpServerId } = await seedUser(ownerId);
    const serverName = `acl-${ownerId}`;
    await share(mcpServerId, ownerId, PrincipalType.USER, viewerId);
    await authorize(viewerId, serverName);
    const { flowManager, uninstallOAuthMCP } = createOAuthHost(
      jest.fn().mockResolvedValue(undefined),
      async () => {
        throw new Error('mongo down');
      },
    );
    const deps = createServerDeps({
      getServerConfig: async () => serverConfig,
      getUserPrincipals: (candidate) => methods.getUserPrincipals({ userId: candidate }),
      resolveAllowlists: async () => ({}),
      uninstallOAuthMCP,
    });

    await expect(deleteUserMCPServers(ownerId.toString(), deps)).rejects.toThrow();

    for (const id of [ownerId, viewerId]) {
      const leaseId = getMCPOAuthLeaseId(id.toString(), serverName);
      expect(await flowManager.getLeaseGeneration(leaseId)).toEqual(expect.any(Number));
      expect(MCPTokenStorage.isRefreshTeardownActive(id.toString(), serverName)).toBe(false);
    }
    expect(await count('MCPServer', { _id: mcpServerId })).toBe(1);
  });
});

const realPostgres = process.env.PG_TEST_URL ? describe : describe.skip;
realPostgres('attempt-scoped PostgreSQL account erasure', () => {
  const schema = `erasure_${randomUUID().replace(/-/g, '')}`;
  const config = { favorites: 'postgres', postgres: { connectionStringEnv: 'PG_TEST_URL' } };
  const options = {
    connectionString: process.env.PG_TEST_URL ?? '',
    max: 2,
    maxWaiting: 10,
    acquireTimeoutMs: 1000,
    queryTimeoutMs: 5000,
    idleTimeoutMs: 1000,
  };
  let admin: PostgresDatabase;
  let db: PostgresDatabase;
  beforeAll(async () => {
    admin = createPostgresDatabase(options);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(options.connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    options.connectionString = url.toString();
    db = createPostgresDatabase(options);
    await migratePostgres(db);
    await importFavorites(db, async function* () {}, {
      offline: true,
      verifiedEmpty: true,
      batchSize: 10,
    });
  });
  afterAll(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  async function setup() {
    const userId = new mongoose.Types.ObjectId().toString();
    const startedAt = new Date();
    const deletionAttemptId = randomUUID();
    await model('User').insertOne({
      _id: new mongoose.Types.ObjectId(userId),
      agentTriggerDeletionStartedAt: startedAt,
      agentTriggerDeletionAttemptId: deletionAttemptId,
    });
    const runtime = createFavoriteRuntime(
      methods,
      { PG_TEST_URL: options.connectionString },
      createPostgresFavoriteBackend,
    );
    await runtime.initialize(config);
    const { deps } = createDeps();
    const erasure = { ...deps, ...runtime.methods };
    const cancel = { ...methods, ...runtime.methods };
    const params = { userId, startedAt, deletionAttemptId };
    const favorite = { userId, itemType: 'tool', itemId: 'saved' } as const;
    await runtime.methods.addToolFavorite(favorite);
    return { runtime, erasure, cancel, params, favorite };
  }
  it('unfences a retained account after a later cascade failure, including after restart', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    erasure.deleteSharedLinks = jest.fn().mockRejectedValue(new Error('shared links unavailable'));
    try {
      await expect(eraseUserData(params, erasure)).rejects.toThrow('shared links unavailable');
      expect(await count('User', { _id: new mongoose.Types.ObjectId(params.userId) })).toBe(1);
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
      await cancelUserDataDeletion(params, cancel);
      await runtime.close();
      const restarted = createFavoriteRuntime(
        methods,
        { PG_TEST_URL: options.connectionString },
        createPostgresFavoriteBackend,
      );
      try {
        await restarted.initialize(config);
        await expect(restarted.methods.addToolFavorite(favorite)).resolves.toEqual({
          ok: true,
          added: true,
        });
        expect(await restarted.methods.getToolFavorites(params.userId)).toEqual([
          { itemType: 'tool', itemId: 'saved' },
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await runtime.close();
    }
  });
  it.each(['deleted', 'other-attempt', 'mongo-error'] as const)(
    'keeps the marker when cancellation cannot prove ownership: %s',
    async (reason) => {
      const { runtime, erasure, cancel, params, favorite } = await setup();
      try {
        await eraseUserData(params, erasure);
        if (reason === 'deleted') await methods.deleteUserById(params.userId);
        if (reason === 'other-attempt')
          await model('User').updateOne(
            { _id: new mongoose.Types.ObjectId(params.userId) },
            { $set: { agentTriggerDeletionStartedAt: new Date(params.startedAt.getTime() + 1) } },
          );
        if (reason === 'mongo-error')
          jest
            .spyOn(mongoose.models.User.collection, 'findOne')
            .mockRejectedValueOnce(new Error('Mongo unavailable'));
        if (reason === 'mongo-error')
          await expect(cancelUserDataDeletion(params, cancel)).rejects.toThrow('Mongo unavailable');
        else await cancelUserDataDeletion(params, cancel);
        if (reason === 'mongo-error')
          expect(
            await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt),
          ).toBe(true);
        await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
        await runtime.close();
        const restarted = createFavoriteRuntime(
          methods,
          { PG_TEST_URL: options.connectionString },
          createPostgresFavoriteBackend,
        );
        try {
          await restarted.initialize(config);
          await expect(restarted.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
        } finally {
          await restarted.close();
        }
      } finally {
        await runtime.close();
      }
    },
  );
  it('retains Mongo ownership through a PostgreSQL cancellation fault, then retries after restart', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    try {
      await eraseUserData(params, erasure);
      await db.query(
        `CREATE FUNCTION reject_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cancel unavailable'; END $$`,
      );
      await db.query(
        'CREATE TRIGGER reject_cancel BEFORE DELETE ON tool_favorite_erasure FOR EACH ROW EXECUTE FUNCTION reject_cancel()',
      );
      try {
        await expect(cancelUserDataDeletion(params, cancel)).rejects.toThrow('cancel unavailable');
      } finally {
        await db.query('DROP TRIGGER reject_cancel ON tool_favorite_erasure');
        await db.query('DROP FUNCTION reject_cancel()');
      }
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
      expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt)).toBe(
        true,
      );
      await runtime.close();
      const restarted = createFavoriteRuntime(
        methods,
        { PG_TEST_URL: options.connectionString },
        createPostgresFavoriteBackend,
      );
      try {
        await restarted.initialize(config);
        await cancelUserDataDeletion(params, { ...methods, ...restarted.methods });
        expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt)).toBe(
          false,
        );
        await expect(restarted.methods.addToolFavorite(favorite)).resolves.toEqual({
          ok: true,
          added: true,
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await runtime.close();
    }
  });
  it('retries Mongo release after PostgreSQL cleanup without losing the durable owner', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    try {
      await eraseUserData(params, erasure);
      // Fail the real release write after the ownership read and PostgreSQL cancellation.
      jest
        .spyOn(mongoose.models.User.collection, 'updateOne')
        .mockRejectedValueOnce(new Error('Mongo release unavailable'));
      await expect(cancelUserDataDeletion(params, cancel)).rejects.toThrow(
        'Mongo release unavailable',
      );
      expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt)).toBe(
        true,
      );
      await expect(runtime.methods.addToolFavorite(favorite)).resolves.toEqual({
        ok: true,
        added: true,
      });
      await cancelUserDataDeletion(params, cancel);
      expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt)).toBe(
        false,
      );
    } finally {
      await runtime.close();
    }
  });
  it('tolerates a lost Mongo release acknowledgement after PostgreSQL cleanup', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    try {
      await eraseUserData(params, erasure);
      cancel.cancelAgentTriggerUserDeletion = async (userId, startedAt) => {
        await methods.cancelAgentTriggerUserDeletion(userId, startedAt, params.deletionAttemptId);
        throw new Error('release acknowledgement lost');
      };
      await expect(cancelUserDataDeletion(params, cancel)).rejects.toThrow(
        'release acknowledgement lost',
      );
      await cancelUserDataDeletion(params, { ...methods, ...runtime.methods });
      await expect(runtime.methods.addToolFavorite(favorite)).resolves.toEqual({
        ok: true,
        added: true,
      });
    } finally {
      await runtime.close();
    }
  });
  it('makes concurrent cancellation idempotent without releasing a successor UUID', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    try {
      await eraseUserData(params, erasure);
      const successor = randomUUID();
      await runtime.methods.deleteUserToolFavorites(params.userId, successor);
      await Promise.all([
        cancelUserDataDeletion(params, cancel),
        cancelUserDataDeletion(params, cancel),
      ]);
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
      expect(
        (
          await db.query('SELECT attempt_id FROM tool_favorite_erasure WHERE user_id=$1', [
            params.userId,
          ])
        ).rows,
      ).toEqual([{ attempt_id: successor }]);
    } finally {
      await runtime.close();
    }
  });
  it('preserves a successor owner and UUID acquired after the ownership proof', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    const successor = randomUUID();
    const nextStartedAt = new Date(params.startedAt.getTime() + 1);
    try {
      await eraseUserData(params, erasure);
      cancel.isAgentTriggerUserDeletionOwner = async (userId, startedAt) => {
        const owned = await methods.isAgentTriggerUserDeletionOwner(userId, startedAt);
        await methods.cancelAgentTriggerUserDeletion(userId, startedAt, params.deletionAttemptId);
        await methods.beginAgentTriggerUserDeletion(userId, nextStartedAt, successor);
        await runtime.methods.deleteUserToolFavorites(userId, successor);
        return owned;
      };
      await cancelUserDataDeletion(params, cancel);
      expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, nextStartedAt)).toBe(
        true,
      );
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
      expect(
        (
          await db.query('SELECT attempt_id FROM tool_favorite_erasure WHERE user_id=$1', [
            params.userId,
          ])
        ).rows,
      ).toEqual([{ attempt_id: successor }]);
    } finally {
      await runtime.close();
    }
  });
  it('keeps both fences when a final delete is pending or loses its acknowledgement', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    const attempt = createUserDeletionAttempt();
    let releaseCommit!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    try {
      await eraseUserData(params, erasure);
      const committing = attempt.commit(async () => {
        await gate;
        await methods.deleteUserById(params.userId, {
          startedAt: params.startedAt,
          attemptId: params.deletionAttemptId,
        });
        throw new Error('delete acknowledgement lost');
      });
      await attempt.cancel(params, cancel);
      expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt)).toBe(
        true,
      );
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
      releaseCommit();
      await expect(committing).rejects.toThrow('delete acknowledgement lost');
      await attempt.cancel(params, cancel);
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
    } finally {
      releaseCommit();
      await runtime.close();
    }
  });
  it('keeps both fences after a final delete throws without a known outcome', async () => {
    const { runtime, erasure, cancel, params, favorite } = await setup();
    const attempt = createUserDeletionAttempt();
    try {
      await eraseUserData(params, erasure);
      await expect(
        attempt.commit(async () => {
          throw new Error('delete outcome unknown');
        }),
      ).rejects.toThrow('delete outcome unknown');
      await attempt.cancel(params, cancel);
      expect(await methods.isAgentTriggerUserDeletionOwner(params.userId, params.startedAt)).toBe(
        true,
      );
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
    } finally {
      await runtime.close();
    }
  });
  it('never cancels a permanent marker when no UUID was supplied', async () => {
    const { runtime, cancel, params, favorite } = await setup();
    try {
      await runtime.methods.deleteUserToolFavorites(params.userId);
      await cancelUserDataDeletion({ userId: params.userId, startedAt: params.startedAt }, cancel);
      await expect(runtime.methods.addToolFavorite(favorite)).rejects.toThrow('erasure');
    } finally {
      await runtime.close();
    }
  });
});
