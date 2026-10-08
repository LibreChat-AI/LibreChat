import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  Permissions,
  PermissionBits,
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionTypes,
} from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { MCPAuthorityTargetInput } from '~/types';
import {
  MCPAuthorityProofError,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
  createMCPAuthorityMethods,
  createMCPAuthorityBootRevision,
} from './mcpAuthority';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';

jest.setTimeout(60_000);

const TENANT_ID = 'tenant-authority';
const USER_ROLE = 'MCP_USER';
const SERVER_NAME = 'selected-server';
const PLUGIN_KEY = `mcp_${SERVER_NAME}`;

let mongoServer: MongoMemoryReplSet;
let models: ReturnType<typeof createModels>;
let methods: ReturnType<typeof createMCPAuthorityMethods>;
let userId: mongoose.Types.ObjectId;
let groupId: mongoose.Types.ObjectId;
let serverId: mongoose.Types.ObjectId;
let serverSourceRevision: string;
let credentialSourceRevision: string;

const immutableConfig = {
  mcpServers: {
    'operator-server': { type: 'sse' as const, url: 'https://operator.example/mcp' },
  },
  mcpSettings: { allowedDomains: ['operator.example'] },
};
const boot = createMCPAuthorityBootRevision('boot-1', immutableConfig);
const EMPTY_CREDENTIAL_REVISION = createMCPAuthorityCredentialRevision([], []);

const target = (
  serverName = SERVER_NAME,
  databaseId = serverId.toHexString(),
  sourceRevision = serverSourceRevision,
  expectedOAuthGrantGeneration: string | null = 'oauth-generation-1',
  expectedCredentialRevision = credentialSourceRevision,
) => ({
  serverName,
  source: 'database' as const,
  databaseId,
  sourceRevision,
  expectedCredentialRevision,
  expectedOAuthGrantGeneration,
  resolvedConfig: {
    type: 'sse' as const,
    url: `https://${serverName}.example/mcp`,
    customUserVars: {
      API_KEY: { title: 'API key', description: 'Credential' },
    },
  },
  requiresOAuth: true,
});

const configAuthorityTarget = (
  serverName: string,
  sourceRevision: string,
  resolvedConfig: MCPOptions = { type: 'sse', url: `https://${serverName}.example/mcp` },
): MCPAuthorityTargetInput => ({
  serverName,
  source: 'config',
  sourceRevision,
  expectedCredentialRevision: EMPTY_CREDENTIAL_REVISION,
  expectedOAuthGrantGeneration: null,
  resolvedConfig,
});

function inTenant<Result>(fn: () => Promise<Result>): Promise<Result> {
  return tenantStorage.run({ tenantId: TENANT_ID, userId: userId?.toHexString() }, fn);
}

async function seedFixture(): Promise<void> {
  await mongoose.connection.dropDatabase();
  userId = new mongoose.Types.ObjectId();
  groupId = new mongoose.Types.ObjectId();
  serverId = new mongoose.Types.ObjectId();
  const now = new Date();
  await inTenant(async () => {
    await Promise.all([
      models.User.create({
        _id: userId,
        email: 'authority@example.com',
        emailVerified: true,
        provider: 'openid',
        role: USER_ROLE,
        idOnTheSource: 'source-user-1',
        openidId: 'openid-user-1',
        openidIssuer: 'https://issuer.example',
      }),
      models.Role.create({
        name: USER_ROLE,
        permissions: {
          [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
        },
      }),
      models.Group.create({
        _id: groupId,
        name: 'MCP group',
        source: 'entra',
        idOnTheSource: 'source-group-1',
        memberIds: ['source-user-1'],
      }),
      models.MCPServer.create({
        _id: serverId,
        serverName: SERVER_NAME,
        config: { type: 'sse', url: `https://${SERVER_NAME}.example/mcp` },
        author: userId,
      }),
      models.Config.create({
        principalType: PrincipalType.USER,
        principalId: userId.toHexString(),
        principalModel: PrincipalModel.USER,
        priority: 30,
        overrides: { mcpServers: { [SERVER_NAME]: { startup: false } } },
        tombstones: [],
        isActive: true,
        configVersion: 1,
      }),
      models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: serverId,
        permBits: PermissionBits.VIEW,
        grantedBy: userId,
      }),
      models.PluginAuth.create({
        userId: userId.toHexString(),
        pluginKey: PLUGIN_KEY,
        authField: 'API_KEY',
        value: 'secret-generation-1',
      }),
      models.Token.insertMany(
        [
          ['mcp_oauth', `mcp:${SERVER_NAME}`],
          ['mcp_oauth_refresh', `mcp:${SERVER_NAME}:refresh`],
          ['mcp_oauth_client', `mcp:${SERVER_NAME}:client`],
        ].map(([type, identifier]) => ({
          userId,
          type,
          identifier,
          token: `${type}-secret`,
          metadata: { credential_set_id: 'oauth-generation-1' },
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        })),
      ),
    ]);
    const [server, credential] = await Promise.all([
      models.MCPServer.findById(serverId).lean(),
      models.PluginAuth.findOne({ userId: userId.toHexString(), pluginKey: PLUGIN_KEY }).lean(),
    ]);
    if (!server || !credential) {
      throw new Error('MCP authority fixture source records were not created');
    }
    serverSourceRevision = createMCPAuthorityDatabaseSourceRevision({
      databaseId: server._id.toHexString(),
      serverName: server.serverName,
      author: server.author.toString(),
      config: server.config,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    });
    credentialSourceRevision = createMCPAuthorityCredentialRevision(['API_KEY'], [credential]);
  });
}

async function currentConfigSourceRevision(): Promise<string> {
  const configs = await inTenant(() =>
    models.Config.find({
      $or: [
        { principalType: PrincipalType.ROLE, principalId: BASE_CONFIG_PRINCIPAL_ID },
        { principalType: PrincipalType.ROLE, principalId: USER_ROLE },
        { principalType: PrincipalType.GROUP, principalId: groupId.toHexString() },
        { principalType: PrincipalType.USER, principalId: userId.toHexString() },
      ],
    }).lean(),
  );
  return createMCPAuthorityConfigSourceRevision(boot.digest, configs);
}

async function resolve(targets: readonly MCPAuthorityTargetInput[] = [target()]) {
  return await inTenant(() =>
    methods.resolveMCPAuthorityProof({
      userId: userId.toHexString(),
      tenantId: TENANT_ID,
      boot,
      targets,
    }),
  );
}

async function assertCurrent(proof: Awaited<ReturnType<typeof resolve>>): Promise<void> {
  await inTenant(() => methods.assertMCPAuthorityProofsCurrent({ proofs: proof, boot }));
}

function expectReason(reason: MCPAuthorityProofError['reason']) {
  return expect.objectContaining({ name: 'MCPAuthorityProofError', reason });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = new URL(mongoServer.getUri());
  uri.searchParams.set('readPreference', 'secondaryPreferred');
  await mongoose.connect(uri.href);
  models = createModels(mongoose);
  methods = createMCPAuthorityMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await seedFixture();
});

describe('MCP authority proofs', () => {
  test('materializes every snapshot namespace before opening the transaction', async () => {
    /** Amazon DocumentDB rejects in-transaction statements against collections
     * that do not exist, and `asMCPError` reports that as `proof_unavailable`
     * — so a deployment that has never written a PluginAuth or Token row
     * cannot resolve any authority proof. Dropping those namespaces here
     * reproduces that state; the resolve must recreate them and succeed. */
    const optionalNamespaces = ['PluginAuth', 'Token'] as const;
    for (const modelName of optionalNamespaces) {
      await models[modelName].collection.drop().catch(() => undefined);
    }
    const existing = await mongoose.connection.db!.listCollections().toArray();
    const names = new Set(existing.map((collection) => collection.name));
    for (const modelName of optionalNamespaces) {
      expect(names.has(models[modelName].collection.collectionName)).toBe(false);
    }

    /** Dropping the credential namespaces also empties the credential state,
     * so the target must expect the post-drop revision — the point under test
     * is that the transaction OPENS against missing namespaces, not that the
     * credential is unchanged. */
    const proof = await resolve([
      target(
        SERVER_NAME,
        serverId.toHexString(),
        serverSourceRevision,
        null,
        createMCPAuthorityCredentialRevision(['API_KEY'], []),
      ),
    ]);

    expect(proof.servers).toHaveLength(1);
    const after = await mongoose.connection.db!.listCollections().toArray();
    const afterNames = new Set(after.map((collection) => collection.name));
    for (const modelName of optionalNamespaces) {
      expect(afterNames.has(models[modelName].collection.collectionName)).toBe(true);
    }
  });

  test('retries namespace creation after a transient failure instead of caching it', async () => {
    /** A swallowed transient failure would settle the once-per-process memo,
     * skip creation for every later request, and strand authority proofs on
     * `proof_unavailable` long after the condition cleared. */
    /** Zero cooldown: this test covers the retry-after-transient-failure side
     * of the boundary; the storm-suppression side is covered below. */
    const retryMethods = createMCPAuthorityMethods(mongoose, {
      snapshotNamespaceRetryCooldownMs: 0,
    });
    const target = () => ({
      serverName: SERVER_NAME,
      source: 'database' as const,
      databaseId: serverId.toHexString(),
      sourceRevision: serverSourceRevision,
      expectedCredentialRevision: credentialSourceRevision,
      expectedOAuthGrantGeneration: 'oauth-generation-1',
      resolvedConfig: {
        type: 'sse' as const,
        url: `https://${SERVER_NAME}.example/mcp`,
        customUserVars: { API_KEY: { title: 'API key', description: 'Credential' } },
      },
      requiresOAuth: true,
    });
    const resolveWith = () =>
      inTenant(() =>
        retryMethods.resolveMCPAuthorityProof({
          userId: userId.toHexString(),
          tenantId: TENANT_ID,
          boot,
          targets: [target()],
        }),
      );

    const createSpy = jest
      .spyOn(models.PluginAuth, 'createCollection')
      .mockRejectedValueOnce(Object.assign(new Error('transient cluster failure'), { code: 91 }));
    try {
      await expect(resolveWith()).rejects.toBeInstanceOf(MCPAuthorityProofError);
    } finally {
      createSpy.mockRestore();
    }

    /** The memo must have been cleared: the next call retries creation and
     * succeeds now that the transient condition is gone. */
    await expect(resolveWith()).resolves.toEqual(
      expect.objectContaining({ servers: expect.any(Array) }),
    );
  });

  test('throttles namespace preflight retries while a failure persists', async () => {
    /** A persistent failure must not turn every authority request into another
     * serial DDL preflight — that is a retry storm precisely while the database
     * is unhealthy. */
    const throttledMethods = createMCPAuthorityMethods(mongoose, {
      snapshotNamespaceRetryCooldownMs: 60_000,
    });
    const resolveOnce = () =>
      inTenant(() =>
        throttledMethods.resolveMCPAuthorityProof({
          userId: userId.toHexString(),
          tenantId: TENANT_ID,
          boot,
          targets: [
            {
              serverName: SERVER_NAME,
              source: 'database' as const,
              databaseId: serverId.toHexString(),
              sourceRevision: serverSourceRevision,
              expectedCredentialRevision: credentialSourceRevision,
              expectedOAuthGrantGeneration: 'oauth-generation-1',
              resolvedConfig: {
                type: 'sse' as const,
                url: `https://${SERVER_NAME}.example/mcp`,
                customUserVars: { API_KEY: { title: 'API key', description: 'Credential' } },
              },
              requiresOAuth: true,
            },
          ],
        }),
      );

    const createSpy = jest
      .spyOn(models.PluginAuth, 'createCollection')
      .mockRejectedValue(Object.assign(new Error('not authorized'), { code: 13 }));
    try {
      await expect(resolveOnce()).rejects.toBeInstanceOf(MCPAuthorityProofError);
      const afterFirst = createSpy.mock.calls.length;
      await expect(resolveOnce()).rejects.toBeInstanceOf(MCPAuthorityProofError);
      await expect(resolveOnce()).rejects.toBeInstanceOf(MCPAuthorityProofError);
      /** The two requests inside the cooldown replayed the recorded failure
       * without issuing another creation. */
      expect(createSpy.mock.calls.length).toBe(afterFirst);
    } finally {
      createSpy.mockRestore();
    }
  });

  test('creates one immutable shared snapshot and current per-server revisions', async () => {
    const proof = await resolve();

    expect(proof.version).toBe(1);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.shared)).toBe(true);
    expect(Object.isFrozen(proof.servers)).toBe(true);
    expect(proof.shared.user).toMatchObject({
      userId: userId.toHexString(),
      tenantId: TENANT_ID,
      role: USER_ROLE,
      provider: 'openid',
    });
    expect(proof.shared.groups.map((group) => group.id)).toEqual([groupId.toHexString()]);
    expect(proof.shared.configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalType: PrincipalType.USER,
          principalId: userId.toHexString(),
          present: true,
          active: true,
          configVersion: 1,
        }),
      ]),
    );
    expect(proof.servers[0]).toMatchObject({
      serverName: SERVER_NAME,
      databaseId: serverId.toHexString(),
      directAccess: true,
      agentAccess: false,
      credentialFields: ['API_KEY'],
      oauthGrantGeneration: 'oauth-generation-1',
    });
    expect(proof.servers[0].resolvedConfigDigest).not.toContain('secret');
    await expect(assertCurrent(proof)).resolves.toBeUndefined();
  });

  test('pins every mutable collection read to one primary snapshot transaction', async () => {
    const session = await mongoose.startSession();
    const startTransactionSpy = jest.spyOn(session, 'startTransaction');
    const querySessionSpy = jest.spyOn(mongoose.Query.prototype, 'session');
    const aggregateSessionSpy = jest.spyOn(mongoose.Aggregate.prototype, 'session');
    const readSpy = jest.spyOn(mongoose.Query.prototype, 'read');
    const readConcernSpy = jest.spyOn(mongoose.Query.prototype, 'readConcern');
    const findSpy = jest.spyOn(mongoose.mongo.Collection.prototype, 'find');

    try {
      await inTenant(() =>
        methods.resolveMCPAuthorityProof({
          userId: userId.toHexString(),
          tenantId: TENANT_ID,
          boot,
          targets: [target()],
          session,
        }),
      );
    } finally {
      await session.endSession();
    }

    expect(startTransactionSpy).toHaveBeenCalledWith({
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    expect(querySessionSpy).toHaveBeenCalledTimes(12);
    expect(querySessionSpy.mock.calls.every(([attached]) => attached === session)).toBe(true);
    expect(aggregateSessionSpy).toHaveBeenCalledTimes(2);
    expect(aggregateSessionSpy.mock.calls.every(([attached]) => attached === session)).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();
    expect(readConcernSpy).not.toHaveBeenCalled();
    expect(findSpy).toHaveBeenCalledTimes(7);
    expect(findSpy.mock.calls.every(([, options]) => options?.singleBatch === true)).toBe(true);
  });

  test('commits an owned snapshot on a supplied non-transaction session', async () => {
    const session = await mongoose.startSession();
    const commitSpy = jest.spyOn(session, 'commitTransaction');

    try {
      await inTenant(() =>
        methods.resolveMCPAuthorityProof({
          userId: userId.toHexString(),
          tenantId: TENANT_ID,
          boot,
          targets: [target()],
          session,
        }),
      );
    } finally {
      await session.endSession();
    }

    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(session.inTransaction()).toBe(false);
  });

  test('fails closed without an exact active tenant context', async () => {
    const input = {
      userId: userId.toHexString(),
      tenantId: TENANT_ID,
      boot,
      targets: [target()],
    };

    await expect(methods.resolveMCPAuthorityProof(input)).rejects.toEqual(
      expectReason('proof_unavailable'),
    );
    await expect(
      tenantStorage.run({ tenantId: 'different-tenant' }, () =>
        methods.resolveMCPAuthorityProof(input),
      ),
    ).rejects.toEqual(expectReason('proof_unavailable'));
  });

  test('does not use a foreign tenant role for a tenantless principal', async () => {
    const tenantlessUserId = new mongoose.Types.ObjectId();
    const roleName = 'TENANTLESS_AUTHORITY_USER';
    await models.User.create({
      _id: tenantlessUserId,
      email: 'tenantless-authority@example.com',
      provider: 'local',
      role: roleName,
    });
    await tenantStorage.run({ tenantId: 'foreign-tenant' }, async () => {
      await models.Role.create({
        name: roleName,
        permissions: {
          [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
        },
      });
    });

    await expect(
      methods.resolveMCPAuthorityProof({
        userId: tenantlessUserId.toHexString(),
        boot,
        targets: [configAuthorityTarget('tenantless-config', 'tenantless-source-revision')],
      }),
    ).rejects.toEqual(expectReason('role_changed'));
  });

  test('rejects a previously pinned active transaction snapshot', async () => {
    const proof = await resolve();
    const session = await mongoose.startSession();
    session.startTransaction({
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
    });
    try {
      await inTenant(() =>
        models.AclEntry.findOne({ resourceId: serverId }).session(session).lean(),
      );
      await inTenant(() =>
        models.AclEntry.deleteMany({ resourceId: serverId }).then(() => undefined),
      );
      await expect(
        inTenant(() => models.AclEntry.findOne({ resourceId: serverId }).session(session).lean()),
      ).resolves.not.toBeNull();

      await expect(
        inTenant(() => methods.assertMCPAuthorityProofsCurrent({ proofs: proof, boot, session })),
      ).rejects.toEqual(expectReason('proof_unavailable'));
    } finally {
      await session.abortTransaction();
      await session.endSession();
    }
  });

  test('does not combine an early group snapshot with a later injected ACL grant', async () => {
    await inTenant(() =>
      models.AclEntry.deleteMany({ resourceId: serverId }).then(() => undefined),
    );
    const snapshotMethods = createMCPAuthorityMethods(mongoose, {
      afterPrincipalSnapshot: () =>
        inTenant(async () => {
          await models.Group.updateOne({ _id: groupId }, { $pull: { memberIds: 'source-user-1' } });
          await models.AclEntry.create({
            principalType: PrincipalType.GROUP,
            principalId: groupId,
            principalModel: PrincipalModel.GROUP,
            resourceType: ResourceType.MCPSERVER,
            resourceId: serverId,
            permBits: PermissionBits.VIEW,
            grantedBy: userId,
          });
        }),
    });

    await expect(
      inTenant(() =>
        snapshotMethods.resolveMCPAuthorityProof({
          userId: userId.toHexString(),
          tenantId: TENANT_ID,
          boot,
          targets: [target()],
        }),
      ),
    ).rejects.toEqual(expectReason('access_revoked'));
  });

  test('keeps query count bounded by collection for many selected servers', async () => {
    const extraServers = Array.from({ length: 24 }, (_, index) => {
      const id = new mongoose.Types.ObjectId();
      return { id, name: `selected-${index + 2}` };
    });
    const sourceRevisions = new Map<string, string>();
    await inTenant(async () => {
      await models.MCPServer.insertMany(
        extraServers.map(({ id, name }) => ({
          _id: id,
          serverName: name,
          config: { type: 'sse', url: `https://${name}.example/mcp` },
          author: userId,
        })),
      );
      await models.AclEntry.insertMany(
        extraServers.map(({ id }) => ({
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.MCPSERVER,
          resourceId: id,
          permBits: PermissionBits.VIEW,
          grantedBy: userId,
        })),
      );
      const insertedServers = await models.MCPServer.find({
        _id: { $in: extraServers.map(({ id }) => id) },
      }).lean();
      for (const server of insertedServers) {
        sourceRevisions.set(
          server.serverName,
          createMCPAuthorityDatabaseSourceRevision({
            databaseId: server._id.toHexString(),
            serverName: server.serverName,
            author: server.author.toString(),
            config: server.config,
            createdAt: server.createdAt,
            updatedAt: server.updatedAt,
          }),
        );
      }
    });
    const targets = [
      target(),
      ...extraServers.map(({ id, name }) => {
        const sourceRevision = sourceRevisions.get(name);
        if (!sourceRevision) {
          throw new Error(`Missing source revision for ${name}`);
        }
        return {
          ...target(name, id.toHexString(), sourceRevision, null, EMPTY_CREDENTIAL_REVISION),
          resolvedConfig: { type: 'sse' as const, url: `https://${name}.example/mcp` },
          requiresOAuth: false,
        };
      }),
    ];
    const operations: string[] = [];
    mongoose.set('debug', (collection, method) => {
      if (
        method === 'find' ||
        method === 'findOne' ||
        method === 'aggregate' ||
        method === 'countDocuments'
      ) {
        operations.push(`${collection}.${method}`);
      }
    });

    const proof = await resolve(targets);

    mongoose.set('debug', false);
    expect(proof.servers).toHaveLength(25);
    expect(operations).toHaveLength(14);
    expect(new Set(operations)).toEqual(
      new Set([
        'users.findOne',
        'groups.countDocuments',
        'groups.find',
        'roles.findOne',
        'configs.aggregate',
        'mcpservers.countDocuments',
        'mcpservers.find',
        'agents.aggregate',
        'pluginauths.countDocuments',
        'pluginauths.find',
        'tokens.countDocuments',
        'tokens.find',
        'aclentries.countDocuments',
        'aclentries.find',
      ]),
    );
  });

  test('reads selected server identities only and fails closed on normalized collisions', async () => {
    const unselectedId = new mongoose.Types.ObjectId();
    await inTenant(async () => {
      await models.MCPServer.create({
        _id: unselectedId,
        serverName: 'unselected-server',
        config: { type: 'sse', url: 'https://unselected.example/mcp' },
        author: userId,
      });
      await models.MCPServer.create({
        serverName: 'selected/server',
        config: { type: 'sse', url: 'https://collision.example/mcp' },
        author: userId,
      });
    });

    const configSourceRevision = await currentConfigSourceRevision();
    await expect(
      resolve([
        configAuthorityTarget('selected server', configSourceRevision, {
          type: 'sse',
          url: 'https://operator.example/mcp',
        }),
      ]),
    ).rejects.toEqual(expectReason('server_changed'));
  });

  test('rejects invalid target sources before resolving database authority', async () => {
    await expect(
      resolve([
        {
          ...target(),
          source: 'DATABASE' as 'database',
        },
      ]),
    ).rejects.toEqual(expectReason('malformed_input'));
  });

  test('rejects an authority selector larger than the bounded proof batch', async () => {
    await expect(
      resolve(
        Array.from({ length: 33 }, (_, index) => ({
          ...configAuthorityTarget(`config-${index}`, 'bounded-source-revision'),
        })),
      ),
    ).rejects.toEqual(expectReason('malformed_input'));
  });

  test('rejects mutated proof identities and sources before authoritative reads', async () => {
    const proof = await resolve();
    const server = proof.servers[0];
    const normalizedMutation: typeof proof = {
      ...proof,
      servers: [{ ...server, normalizedServerName: 'unrelated_identity' }],
    };
    const sourceMutation: typeof proof = {
      ...proof,
      servers: [{ ...server, source: 'config' }],
    };

    await expect(assertCurrent(normalizedMutation)).rejects.toEqual(
      expectReason('malformed_input'),
    );
    await expect(assertCurrent(sourceMutation)).rejects.toEqual(expectReason('malformed_input'));
  });

  test('rejects normalized identity collisions across separately resolved proofs', async () => {
    const sourceRevision = await currentConfigSourceRevision();
    const [spaceProof, slashProof] = await Promise.all([
      resolve([configAuthorityTarget('alias server', sourceRevision)]),
      resolve([configAuthorityTarget('alias/server', sourceRevision)]),
    ]);

    await expect(
      inTenant(() =>
        methods.assertMCPAuthorityProofsCurrent({
          proofs: [spaceProof, slashProof],
          boot,
        }),
      ),
    ).rejects.toEqual(expectReason('malformed_input'));
  });

  test('composes separately resolved config proofs with target-independent shared revisions', async () => {
    await inTenant(() =>
      models.Config.updateOne(
        { principalType: PrincipalType.USER, principalId: userId.toHexString() },
        {
          $set: {
            'overrides.mcpServers.config-a': { startup: false },
            'overrides.mcpServers.config-b': { startup: true },
          },
          $inc: { configVersion: 1 },
        },
      ).then(() => undefined),
    );
    const sourceRevision = await currentConfigSourceRevision();
    const [first, second] = await Promise.all([
      resolve([configAuthorityTarget('config-a', sourceRevision)]),
      resolve([configAuthorityTarget('config-b', sourceRevision)]),
    ]);

    expect(first.shared.revision).toBe(second.shared.revision);
    expect(first.shared.configs.every((config) => config.mcpOverrideDigest === null)).toBe(true);
    await expect(
      inTenant(() => methods.assertMCPAuthorityProofsCurrent({ proofs: [first, second], boot })),
    ).resolves.toBeUndefined();
  });

  test('rejects composed proofs over the selector bound before authoritative reads', async () => {
    const sourceRevision = await currentConfigSourceRevision();
    const configTargets = Array.from(
      { length: 34 },
      (_, index): MCPAuthorityTargetInput =>
        configAuthorityTarget(`composed-${index}`, sourceRevision),
    );
    const [first, second] = await Promise.all([
      resolve(configTargets.slice(0, 17)),
      resolve(configTargets.slice(17)),
    ]);
    const startSessionSpy = jest.spyOn(mongoose, 'startSession');

    await expect(
      inTenant(() => methods.assertMCPAuthorityProofsCurrent({ proofs: [first, second], boot })),
    ).rejects.toEqual(expectReason('malformed_input'));
    expect(startSessionSpy).not.toHaveBeenCalled();
  });

  test('fails closed when authority row cardinality exceeds a single proof batch', async () => {
    await inTenant(() =>
      models.Group.insertMany(
        Array.from({ length: 64 }, (_, index) => ({
          name: `extra-group-${index}`,
          source: 'local',
          memberIds: ['source-user-1'],
        })),
      ).then(() => undefined),
    );

    await expect(resolve()).rejects.toEqual(expectReason('proof_unavailable'));
  });

  test('fails closed when projected Config tombstones exceed the bounded proof shape', async () => {
    await inTenant(() =>
      models.Config.updateOne(
        { principalType: PrincipalType.USER, principalId: userId.toHexString() },
        {
          $set: {
            tombstones: Array.from({ length: 65 }, (_, index) => `mcpSettings.path-${index}`),
          },
        },
      ).then(() => undefined),
    );

    await expect(resolve()).rejects.toEqual(expectReason('proof_unavailable'));
  });

  test('rejects a database source mutation between parsing and proof resolution', async () => {
    const staleTarget = target();
    await inTenant(() =>
      models.MCPServer.updateOne(
        { _id: serverId },
        { $set: { 'config.url': 'https://changed-before-proof.example/mcp' } },
      ).then(() => undefined),
    );

    await expect(resolve([staleTarget])).rejects.toEqual(expectReason('server_changed'));
  });

  test('does not allow explicit credential or OAuth flags to suppress configured authority', async () => {
    const credentialProof = await resolve([{ ...target(), credentialFields: [] }]);
    expect(credentialProof.servers[0].credentialFields).toEqual(['API_KEY']);
    await inTenant(() =>
      models.PluginAuth.updateOne(
        { userId: userId.toHexString(), pluginKey: PLUGIN_KEY },
        { $set: { value: 'suppression-test-rotation' } },
      ).then(() => undefined),
    );
    await expect(assertCurrent(credentialProof)).rejects.toEqual(
      expectReason('credential_changed'),
    );

    await seedFixture();
    const baseTarget = target();
    const oauthProof = await resolve([
      {
        ...baseTarget,
        requiresOAuth: false,
        resolvedConfig: { ...baseTarget.resolvedConfig, oauth: {} },
      },
    ]);
    expect(oauthProof.servers[0].requiresOAuth).toBe(true);
    await inTenant(() =>
      models.Token.updateMany(
        { userId, identifier: { $regex: `^mcp:${SERVER_NAME}` } },
        { $set: { 'metadata.credential_set_id': 'suppression-test-oauth-rotation' } },
      ).then(() => undefined),
    );
    await expect(assertCurrent(oauthProof)).rejects.toEqual(expectReason('oauth_grant_changed'));
  });

  test('rejects credential and OAuth rotations between artifact creation and proof resolution', async () => {
    const staleTarget = target();
    await inTenant(async () => {
      await models.PluginAuth.updateOne(
        { userId: userId.toHexString(), pluginKey: PLUGIN_KEY },
        { $set: { value: 'rotated-before-proof' } },
      );
      await models.Token.updateMany(
        { userId, identifier: { $regex: `^mcp:${SERVER_NAME}` } },
        { $set: { 'metadata.credential_set_id': 'rotated-before-proof' } },
      );
    });

    await expect(resolve([staleTarget])).rejects.toEqual(expectReason('credential_changed'));

    const rotatedCredential = await inTenant(() =>
      models.PluginAuth.findOne({ userId: userId.toHexString(), pluginKey: PLUGIN_KEY }).lean(),
    );
    if (!rotatedCredential) {
      throw new Error('Rotated credential was not found');
    }
    const currentCredentialRevision = createMCPAuthorityCredentialRevision(
      ['API_KEY'],
      [rotatedCredential],
    );
    await expect(
      resolve([
        target(
          SERVER_NAME,
          serverId.toHexString(),
          serverSourceRevision,
          'oauth-generation-1',
          currentCredentialRevision,
        ),
      ]),
    ).rejects.toEqual(expectReason('oauth_grant_changed'));
  });

  test('rejects a Config mutation between parsing and proof resolution', async () => {
    const staleSourceRevision = await currentConfigSourceRevision();
    await inTenant(() =>
      models.Config.updateOne(
        { principalType: PrincipalType.USER, principalId: userId.toHexString() },
        { $inc: { configVersion: 1 } },
      ).then(() => undefined),
    );

    await expect(
      resolve([
        configAuthorityTarget(
          'operator-server',
          staleSourceRevision,
          immutableConfig.mcpServers['operator-server'],
        ),
      ]),
    ).rejects.toEqual(expectReason('config_changed'));
  });

  test('requires a new proof after first OAuth generation storage', async () => {
    await inTenant(() =>
      models.Token.deleteMany({ userId, identifier: { $regex: `^mcp:${SERVER_NAME}` } }).then(
        () => undefined,
      ),
    );
    const preStoreProof = await resolve([
      target(SERVER_NAME, serverId.toHexString(), serverSourceRevision, null),
    ]);
    expect(preStoreProof.servers[0].oauthGrantGeneration).toBeNull();

    const now = new Date();
    await inTenant(() =>
      models.Token.insertMany(
        [
          ['mcp_oauth', `mcp:${SERVER_NAME}`],
          ['mcp_oauth_refresh', `mcp:${SERVER_NAME}:refresh`],
          ['mcp_oauth_client', `mcp:${SERVER_NAME}:client`],
        ].map(([type, identifier]) => ({
          userId,
          type,
          identifier,
          token: `${type}-first-install-secret`,
          metadata: { credential_set_id: 'oauth-first-install' },
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        })),
      ).then(() => undefined),
    );

    await expect(assertCurrent(preStoreProof)).rejects.toEqual(expectReason('oauth_grant_changed'));
    const postStoreTarget = target(
      SERVER_NAME,
      serverId.toHexString(),
      serverSourceRevision,
      'oauth-first-install',
    );
    await inTenant(() =>
      models.Token.updateMany(
        { userId, identifier: { $regex: `^mcp:${SERVER_NAME}` } },
        { $set: { 'metadata.credential_set_id': 'concurrent-newer-generation' } },
      ).then(() => undefined),
    );
    await expect(resolve([postStoreTarget])).rejects.toEqual(expectReason('oauth_grant_changed'));
    await inTenant(() =>
      models.Token.updateMany(
        { userId, identifier: { $regex: `^mcp:${SERVER_NAME}` } },
        { $set: { 'metadata.credential_set_id': 'oauth-first-install' } },
      ).then(() => undefined),
    );
    const postStoreProof = await resolve([postStoreTarget]);
    expect(postStoreProof.servers[0].oauthGrantGeneration).toBe('oauth-first-install');
    await expect(assertCurrent(postStoreProof)).resolves.toBeUndefined();
  });

  test('keys OAuth grants by canonical token type and identifier', async () => {
    const sourceRevision = await currentConfigSourceRevision();
    const now = new Date();
    await inTenant(() =>
      models.Token.create({
        userId,
        type: 'mcp_oauth_refresh',
        identifier: 'mcp:foo:refresh',
        token: 'unselected-refresh-token',
        metadata: { credential_set_id: 'unselected-foo' },
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      }).then(() => undefined),
    );
    const selectedTarget = configAuthorityTarget('foo:refresh', sourceRevision, {
      type: 'sse',
      url: 'https://foo-refresh.example/mcp',
      oauth: {},
    });
    const proof = await resolve([selectedTarget]);
    expect(proof.servers[0].oauthGrantGeneration).toBeNull();

    await inTenant(() =>
      models.Token.updateOne(
        { type: 'mcp_oauth_refresh', identifier: 'mcp:foo:refresh' },
        { $set: { 'metadata.credential_set_id': 'unselected-foo-rotated' } },
      ).then(() => undefined),
    );
    await expect(assertCurrent(proof)).resolves.toBeUndefined();

    await inTenant(() =>
      models.Token.create({
        userId,
        type: 'mcp_oauth',
        identifier: 'mcp:foo:refresh',
        token: 'selected-access-token',
        metadata: { credential_set_id: 'selected-foo-refresh' },
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      }).then(() => undefined),
    );
    const selectedProof = await resolve([
      { ...selectedTarget, expectedOAuthGrantGeneration: 'selected-foo-refresh' },
    ]);
    expect(selectedProof.servers[0].oauthGrantGeneration).toBe('selected-foo-refresh');
  });

  test.each([
    {
      name: 'user deletion',
      reason: 'user_revoked' as const,
      mutate: () => inTenant(() => models.User.deleteOne({ _id: userId }).then(() => undefined)),
    },
    {
      name: 'tenant move',
      reason: 'user_revoked' as const,
      mutate: () =>
        models.User.collection
          .updateOne({ _id: userId }, { $set: { tenantId: 'different-tenant' } })
          .then(() => undefined),
    },
    {
      name: 'source identity change',
      reason: 'principal_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.User.updateOne({ _id: userId }, { $set: { idOnTheSource: 'source-user-2' } }).then(
            () => undefined,
          ),
        ),
    },
    {
      name: 'group revocation',
      reason: 'groups_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.Group.updateOne({ _id: groupId }, { $pull: { memberIds: 'source-user-1' } }).then(
            () => undefined,
          ),
        ),
    },
    {
      name: 'role USE revocation',
      reason: 'mcp_use_revoked' as const,
      mutate: () =>
        inTenant(() =>
          models.Role.updateOne(
            { name: USER_ROLE },
            { $set: { [`permissions.${PermissionTypes.MCP_SERVERS}.${Permissions.USE}`]: false } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'role reassignment',
      reason: 'role_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.User.updateOne({ _id: userId }, { $set: { role: 'REASSIGNED_ROLE' } }).then(
            () => undefined,
          ),
        ),
    },
    {
      name: 'Config toggle',
      reason: 'config_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.Config.updateOne(
            { principalType: PrincipalType.USER, principalId: userId.toHexString() },
            { $set: { isActive: false } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'Config deletion',
      reason: 'config_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.Config.deleteOne({
            principalType: PrincipalType.USER,
            principalId: userId.toHexString(),
          }).then(() => undefined),
        ),
    },
    {
      name: 'Config tombstone and version mutation',
      reason: 'config_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.Config.updateOne(
            { principalType: PrincipalType.USER, principalId: userId.toHexString() },
            { $addToSet: { tombstones: `mcpServers.${SERVER_NAME}` }, $inc: { configVersion: 1 } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'server deletion',
      reason: 'server_revoked' as const,
      mutate: () =>
        inTenant(() => models.MCPServer.deleteOne({ _id: serverId }).then(() => undefined)),
    },
    {
      name: 'server tenant move',
      reason: 'server_revoked' as const,
      mutate: () =>
        models.MCPServer.collection
          .updateOne({ _id: serverId }, { $set: { tenantId: 'different-tenant' } })
          .then(() => undefined),
    },
    {
      name: 'server configuration mutation',
      reason: 'server_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.MCPServer.updateOne(
            { _id: serverId },
            { $set: { 'config.url': 'https://changed.example/mcp' } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'direct ACL revocation',
      reason: 'access_revoked' as const,
      mutate: () =>
        inTenant(() =>
          models.AclEntry.deleteMany({
            resourceType: ResourceType.MCPSERVER,
            resourceId: serverId,
          }).then(() => undefined),
        ),
    },
    {
      name: 'ACL resource move',
      reason: 'access_revoked' as const,
      mutate: () =>
        inTenant(() =>
          models.AclEntry.updateMany(
            { resourceType: ResourceType.MCPSERVER, resourceId: serverId },
            { $set: { resourceId: new mongoose.Types.ObjectId() } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'new ACL grant',
      reason: 'authorization_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.AclEntry.create({
            principalType: PrincipalType.GROUP,
            principalId: groupId,
            principalModel: PrincipalModel.GROUP,
            resourceType: ResourceType.MCPSERVER,
            resourceId: serverId,
            permBits: PermissionBits.VIEW,
            grantedBy: userId,
          }).then(() => undefined),
        ),
    },
    {
      name: 'custom credential rotation',
      reason: 'credential_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.PluginAuth.updateOne(
            { userId: userId.toHexString(), pluginKey: PLUGIN_KEY },
            { $set: { value: 'secret-generation-2' } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'custom credential deletion',
      reason: 'credential_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.PluginAuth.deleteOne({
            userId: userId.toHexString(),
            pluginKey: PLUGIN_KEY,
          }).then(() => undefined),
        ),
    },
    {
      name: 'OAuth grant generation rotation',
      reason: 'oauth_grant_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.Token.updateMany(
            {
              userId,
              identifier: {
                $in: [
                  `mcp:${SERVER_NAME}`,
                  `mcp:${SERVER_NAME}:refresh`,
                  `mcp:${SERVER_NAME}:client`,
                ],
              },
            },
            { $set: { 'metadata.credential_set_id': 'oauth-generation-2' } },
          ).then(() => undefined),
        ),
    },
    {
      name: 'OAuth grant deletion',
      reason: 'oauth_grant_changed' as const,
      mutate: () =>
        inTenant(() =>
          models.Token.deleteOne({
            userId,
            type: 'mcp_oauth_refresh',
            identifier: `mcp:${SERVER_NAME}:refresh`,
          }).then(() => undefined),
        ),
    },
  ])('rejects $name after the primary-backed fence snapshot', async ({ reason, mutate }) => {
    const proof = await resolve();

    await mutate();

    await expect(assertCurrent(proof)).rejects.toEqual(expectReason(reason));
  });

  test('rejects targeted Agent linkage revocation when Agent access was the only path', async () => {
    const agentObjectId = new mongoose.Types.ObjectId();
    await inTenant(async () => {
      await models.AclEntry.deleteMany({
        resourceType: ResourceType.MCPSERVER,
        resourceId: serverId,
      });
      await models.Agent.create({
        _id: agentObjectId,
        id: 'agent-with-selected-server',
        name: 'MCP agent',
        provider: 'openAI',
        model: 'test-model',
        author: userId,
        mcpServerNames: [SERVER_NAME],
      });
      await models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agentObjectId,
        permBits: PermissionBits.VIEW,
        grantedBy: userId,
      });
    });
    const proof = await resolve();
    expect(proof.servers[0]).toMatchObject({ directAccess: false, agentAccess: true });

    await inTenant(() =>
      models.Agent.updateOne({ _id: agentObjectId }, { $set: { mcpServerNames: [] } }).then(
        () => undefined,
      ),
    );

    await expect(assertCurrent(proof)).rejects.toEqual(expectReason('access_revoked'));
  });

  test('treats a post-snapshot primary mutation as authoritative despite secondaryPreferred default', async () => {
    const proof = await resolve();
    await inTenant(() =>
      models.AclEntry.updateOne(
        { resourceType: ResourceType.MCPSERVER, resourceId: serverId },
        { $set: { permBits: 0 } },
      ).then(() => undefined),
    );

    await expect(assertCurrent(proof)).rejects.toEqual(expectReason('access_revoked'));
  });
});
