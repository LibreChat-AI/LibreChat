import './helpers/setupCredsEnv';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CacheKeys, PrincipalType } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { MCPOAuthFlowServer } from '~/mcp/oauth/target';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import type * as t from '~/mcp/types';

/**
 * librechat.yaml MCP servers and fields removed by config profiles, end to end: tombstones are
 * written through the admin config handlers into a real Config collection, merged by the real
 * config service for each principal (user, role and group memberships), and read back through
 * the registry with the production policy resolver. Only server inspection is stubbed, so no
 * MCP server is contacted.
 */

type DataSchemas = typeof import('@librechat/data-schemas');
type Registry = import('~/mcp/registry/MCPServersRegistry').MCPServersRegistry;
type AdminConfigHandlers = ReturnType<typeof import('~/admin/config').createAdminConfigHandlers>;

const GITHUB_URL = 'https://github.example.com/mcp';
const DOCS_HEADERS = { Authorization: 'Bearer {{DOCS_TOKEN}}', 'X-Team': 'core' };
const DOCS_OAUTH_HEADERS = { 'X-Client-Key': 'docs-client', 'X-Team': 'core' };
const YAML_SERVERS: t.MCPServers = {
  github: { type: 'streamable-http', url: GITHUB_URL },
  docs: {
    type: 'streamable-http',
    url: 'https://docs.example.com/mcp',
    timeout: 30000,
    headers: DOCS_HEADERS,
    oauth_headers: DOCS_OAUTH_HEADERS,
  },
  local: { type: 'stdio', command: 'node', args: ['tools.js'] },
};

let mongoServer: MongoMemoryServer;
let registry: Registry;
let handlers: AdminConfigHandlers;
let getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
let clearOverrideCache: () => Promise<void>;
/** The last cache invalidation; handlers answer once it settles, and helpers await it too. */
let invalidation: Promise<void> = Promise.resolve();
/** Override queries the config service has made, across principals. */
let applicableConfigReads = 0;
let memberId: string;
let outsiderId: string;
let groupId: string;

interface AdminRes {
  statusCode: number;
  status: jest.Mock;
  json: jest.Mock;
}

function adminReq(overrides: object): ServerRequest {
  return {
    user: { id: 'admin', role: 'ADMIN', _id: { toString: () => 'admin' } },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

function adminRes(): Response & { statusCode: number } {
  const res: AdminRes = {
    statusCode: 200,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(() => res),
  };
  return res as unknown as Response & { statusCode: number };
}

async function tombstone(principalType: string, principalId: string, fieldPath: string) {
  const res = adminRes();
  await handlers.tombstoneConfigField(
    adminReq({ params: { principalType, principalId }, body: { fieldPath } }),
    res,
  );
  expect(res.statusCode).toBe(200);
  await invalidation;
}

async function patch(
  principalType: string,
  principalId: string,
  entries: Array<{ fieldPath: string; value: unknown }>,
  priority?: number,
) {
  const res = adminRes();
  await handlers.patchConfigField(
    adminReq({ params: { principalType, principalId }, body: { entries, priority } }),
    res,
  );
  expect(res.statusCode).toBe(200);
  await invalidation;
}

async function restore(principalType: string, principalId: string, fieldPath: string) {
  const res = adminRes();
  await handlers.deleteConfigField(
    adminReq({ params: { principalType, principalId }, query: { fieldPath } }),
    res,
  );
  expect(res.statusCode).toBe(200);
  await invalidation;
}

/** What a request handler does: resolve the principal's config, then its config-tier servers. */
async function catalogFor(userId: string): Promise<Record<string, t.ParsedServerConfig>> {
  const appConfig = await getAppConfig({ userId });
  const configServers = await registry.ensureConfigServers(
    (appConfig.mcpConfig ?? {}) as t.MCPServers,
  );
  return registry.getAllServerConfigs(userId, configServers);
}

/** The in-memory APP_CONFIG store shape the config service enumerates to clear overrides. */
function memoryCache(namespace: string) {
  const entries = new Map<string, unknown>();
  const scoped = (key: string): string => `${namespace}:${key}`;
  return {
    get: async (key: string): Promise<unknown> => entries.get(scoped(key)),
    set: async (key: string, value: unknown): Promise<boolean> => {
      entries.set(scoped(key), value);
      return true;
    },
    delete: async (key: string): Promise<boolean> => entries.delete(scoped(key)),
    opts: { store: { keys: () => entries.keys() } },
  };
}

/** Spies are restored after every test (`restoreMocks`), so each test installs its own. */
async function stubInspectionAndLogs(): Promise<void> {
  const { logger } = await import('@librechat/data-schemas');
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    jest.spyOn(logger, level).mockReturnValue(logger);
  }
  const { MCPServerInspector } = await import('~/mcp/registry/MCPServerInspector');
  jest
    .spyOn(MCPServerInspector, 'inspect')
    .mockImplementation(async (_name: string, config: t.MCPOptions) => ({
      ...(config as t.ParsedServerConfig),
      requiresOAuth: false,
    }));
}

beforeEach(stubInspectionAndLogs);

beforeAll(async () => {
  await stubInspectionAndLogs();
  const dataSchemas: DataSchemas = await import('@librechat/data-schemas');

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  const methods = dataSchemas.createMethods(mongoose);

  const [member, outsider] = await mongoose.models.User.create([
    { email: 'member@example.com', provider: 'local' },
    { email: 'outsider@example.com', provider: 'local' },
  ]);
  memberId = member._id.toString();
  outsiderId = outsider._id.toString();
  const group = await mongoose.models.Group.create({
    name: 'Contractors',
    source: 'local',
    memberIds: [memberId],
  });
  groupId = group._id.toString();

  const { createAppConfigService } = await import('~/app/service');
  const overrideCache = memoryCache(CacheKeys.APP_CONFIG);
  const configService = createAppConfigService({
    loadBaseConfig: () => dataSchemas.AppService({ config: { mcpServers: YAML_SERVERS } }),
    setCachedTools: async () => undefined,
    getCache: () => overrideCache,
    cacheKeys: CacheKeys,
    getApplicableConfigs: (principals) => {
      applicableConfigReads += 1;
      return methods.getApplicableConfigs(principals);
    },
    getUserPrincipals: methods.getUserPrincipals,
  });
  getAppConfig = configService.getAppConfig;
  clearOverrideCache = () => configService.clearOverrideCache();

  const { MCPServersRegistry } = await import('~/mcp/registry/MCPServersRegistry');
  const { MCPServersInitializer } = await import('~/mcp/registry/MCPServersInitializer');
  const { createMCPPolicyResolver } = await import('~/mcp/registry/policy');
  registry = MCPServersRegistry.createInstance(
    mongoose,
    null,
    null,
    createMCPPolicyResolver(configService.getAppConfig),
  );
  const baseConfig = await configService.getAppConfig({ baseOnly: true });
  await MCPServersInitializer.initialize((baseConfig.mcpConfig ?? {}) as t.MCPServers);

  const { createAdminConfigHandlers } = await import('~/admin/config');
  handlers = createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    /** As the host wires it: drop merged overrides and the registry's config-derived caches. */
    invalidateConfigCaches: () => {
      invalidation = (async () => {
        await configService.clearOverrideCache();
        await registry.invalidateConfigCache();
      })();
      return invalidation;
    },
  });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('a group profile hides a librechat.yaml MCP server', () => {
  beforeAll(async () => {
    await tombstone(PrincipalType.GROUP, groupId, 'mcpServers.github');
    await tombstone(PrincipalType.GROUP, groupId, 'mcpServers.local');
  });

  afterAll(async () => {
    await restore(PrincipalType.GROUP, groupId, 'mcpServers.local');
  });

  it('withholds it from group members only', async () => {
    expect(Object.keys(await catalogFor(memberId)).sort()).toEqual(['docs', 'local']);
    expect(Object.keys(await catalogFor(outsiderId)).sort()).toEqual(['docs', 'github', 'local']);
  });

  it('withholds it by name, so neither a lookup nor checkout can resolve it', async () => {
    await expect(registry.getServerConfig('github', memberId)).resolves.toBeUndefined();
    const config = await registry.getServerConfig('github', outsiderId);
    expect(config).toEqual(expect.objectContaining({ url: GITHUB_URL }));
    await expect(
      registry.isHiddenFromPrincipal('github', config as t.ParsedServerConfig, { id: memberId }),
    ).resolves.toBe(true);
    await expect(
      registry.isHiddenFromPrincipal('github', config as t.ParsedServerConfig, { id: outsiderId }),
    ).resolves.toBe(false);
  });

  it('never hides a process-backed server, whose tombstone the merge ignores', async () => {
    await expect(registry.getServerConfig('local', memberId)).resolves.toEqual(
      expect.objectContaining({ command: 'node' }),
    );
  });

  it('shows it again once the tombstone is removed', async () => {
    await restore(PrincipalType.GROUP, groupId, 'mcpServers.github');
    try {
      expect(Object.keys(await catalogFor(memberId))).toContain('github');
    } finally {
      await tombstone(PrincipalType.GROUP, groupId, 'mcpServers.github');
    }
    await expect(registry.getServerConfig('github', memberId)).resolves.toBeUndefined();
  });

  it('withholds every hideable server, rather than the base config, when the principal cannot be resolved', async () => {
    const unresolvable = 'not-an-object-id';

    expect([...(await registry.resolveHiddenServerNames({ userId: unresolvable }))].sort()).toEqual(
      ['docs', 'github'],
    );
  });
});

describe('a user profile removes inherited librechat.yaml values', () => {
  afterEach(async () => {
    await restore(PrincipalType.USER, memberId, 'mcpServers.docs.headers.Authorization');
    await restore(PrincipalType.USER, memberId, 'mcpServers.docs.timeout');
  });

  it('removes one header key and keeps its siblings, for that user only', async () => {
    await tombstone(PrincipalType.USER, memberId, 'mcpServers.docs.headers.Authorization');

    const member = (await catalogFor(memberId)).docs;
    const outsider = (await catalogFor(outsiderId)).docs;

    expect(member).toEqual(
      expect.objectContaining({ headers: { 'X-Team': 'core' }, source: 'yaml' }),
    );
    expect(outsider).toEqual(expect.objectContaining({ headers: DOCS_HEADERS }));
  });

  it('keeps the header removed when the server rejects inspection without it', async () => {
    const { MCPServerInspector } = await import('~/mcp/registry/MCPServerInspector');
    jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(async (_name: string, config: t.MCPOptions) => {
        if (!('headers' in config) || !config.headers?.Authorization) {
          throw new Error('401 Unauthorized');
        }
        return { ...(config as t.ParsedServerConfig), requiresOAuth: false };
      });
    await tombstone(PrincipalType.USER, memberId, 'mcpServers.docs.headers.Authorization');

    expect((await catalogFor(memberId)).docs).toEqual(
      expect.objectContaining({
        headers: { 'X-Team': 'core' },
        inspectionFailed: true,
        source: 'config',
      }),
    );
    expect((await catalogFor(outsiderId)).docs).toEqual(
      expect.objectContaining({ headers: DOCS_HEADERS, source: 'yaml' }),
    );
  });

  it('removes a whole field librechat.yaml set', async () => {
    await tombstone(PrincipalType.USER, memberId, 'mcpServers.docs.timeout');

    expect((await catalogFor(memberId)).docs).not.toHaveProperty('timeout');
    expect((await catalogFor(outsiderId)).docs.timeout).toBe(30000);
  });

  it('restores the inherited key when the tombstone is deleted', async () => {
    await tombstone(PrincipalType.USER, memberId, 'mcpServers.docs.headers.Authorization');
    await restore(PrincipalType.USER, memberId, 'mcpServers.docs.headers.Authorization');

    expect((await catalogFor(memberId)).docs).toEqual(
      expect.objectContaining({ headers: DOCS_HEADERS }),
    );
  });
});

describe('broader tombstones', () => {
  it('a whole-section tombstone leaves only process-backed servers', async () => {
    await tombstone(PrincipalType.USER, outsiderId, 'mcpServers');
    try {
      expect(Object.keys(await catalogFor(outsiderId))).toEqual(['local']);
    } finally {
      await restore(PrincipalType.USER, outsiderId, 'mcpServers');
    }
    expect(Object.keys(await catalogFor(outsiderId)).sort()).toEqual(['docs', 'github', 'local']);
  });
});

describe('a higher-priority profile writes fields of a server a lower one hides', () => {
  /** The group profile from the first block still hides github from its member. */
  afterEach(async () => {
    await restore(PrincipalType.USER, memberId, 'mcpServers.github');
  });

  it('brings back the librechat.yaml definition, without the fields, when it writes only some', async () => {
    const { MCPServerInspector } = await import('~/mcp/registry/MCPServerInspector');
    const inspect = jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(async (_name: string, config: t.MCPOptions) => {
        if (!('url' in config) && !('command' in config)) {
          throw new Error('Failed to construct transport');
        }
        return { ...(config as t.ParsedServerConfig), requiresOAuth: false };
      });

    await patch(
      PrincipalType.USER,
      memberId,
      [{ fieldPath: 'mcpServers.github.title', value: 'GitHub Member' }],
      100,
    );
    const github = (await catalogFor(memberId)).github;

    expect(github).toEqual(expect.objectContaining({ url: GITHUB_URL, source: 'yaml' }));
    expect(github).not.toHaveProperty('title');
    /** The incomplete entry was tried as its own server and failed, so it never overlays. */
    expect(inspect.mock.calls.map(([name, config]) => [name, config])).toEqual([
      ['github', { title: 'GitHub Member', source: 'config' }],
    ]);
  });

  it('serves the written definition when it writes a complete one', async () => {
    await patch(
      PrincipalType.USER,
      memberId,
      [
        {
          fieldPath: 'mcpServers.github',
          value: { type: 'streamable-http', url: GITHUB_URL, title: 'GitHub Member' },
        },
      ],
      100,
    );

    expect((await catalogFor(memberId)).github).toEqual(
      expect.objectContaining({ url: GITHUB_URL, title: 'GitHub Member' }),
    );
  });
});

describe('the principal config read behind a hiding decision', () => {
  beforeEach(async () => {
    await clearOverrideCache();
    await registry.invalidateConfigCache();
  });

  it('reuses the identity and merged config the request already loaded', async () => {
    const findUser = jest.spyOn(mongoose.models.User, 'findById');
    /** What the config middleware reads for the request. */
    await getAppConfig({ userId: outsiderId, role: 'USER', idOnTheSource: null });
    const readsBefore = applicableConfigReads;
    findUser.mockClear();

    await registry.resolveHiddenServerNames({
      userId: outsiderId,
      role: 'USER',
      idOnTheSource: null,
    });

    expect(findUser).not.toHaveBeenCalled();
    expect(applicableConfigReads).toBe(readsBefore);
  });

  it('looks the user up when the caller does not supply the identity', async () => {
    const findUser = jest.spyOn(mongoose.models.User, 'findById');

    await registry.resolveHiddenServerNames({ userId: outsiderId, role: 'USER' });

    expect(findUser).toHaveBeenCalledTimes(1);
  });
});

describe('an MCP OAuth flow step resolves its server in the principal config', () => {
  type OAuthTarget = typeof import('~/mcp/oauth/target');
  type OAuthCleanup = typeof import('~/mcp/oauth/cleanup');
  let resolveMCPOAuthTarget: OAuthTarget['resolveMCPOAuthTarget'];
  let getMCPServerGeneration: OAuthCleanup['getMCPServerGeneration'];

  beforeAll(async () => {
    ({ resolveMCPOAuthTarget } = await import('~/mcp/oauth/target'));
    ({ getMCPServerGeneration } = await import('~/mcp/oauth/cleanup'));
  });

  /** As the OAuth initiation and callback routes wire it. */
  function resolveDocsFor(userId: string, flow: MCPOAuthFlowServer) {
    return resolveMCPOAuthTarget(
      { serverName: 'docs', flow, principal: { userId } },
      { getAppConfig, getServerConfigs: (principal) => catalogFor(principal.userId), registry },
    );
  }

  async function admittedFlow(userId: string): Promise<MCPOAuthFlowServer> {
    const admitted = (await catalogFor(userId)).docs;
    return {
      serverName: 'docs',
      serverUrl: admitted.url,
      serverGeneration: getMCPServerGeneration(admitted),
    };
  }

  it('ends a flow admitted before a profile hid the server, for that principal only', async () => {
    const flow = await admittedFlow(memberId);
    await expect(resolveDocsFor(memberId, flow)).resolves.toMatchObject({ ok: true });

    await tombstone(PrincipalType.USER, memberId, 'mcpServers.docs');
    try {
      await expect(resolveDocsFor(memberId, flow)).resolves.toEqual({
        ok: false,
        error: { code: 'server_not_found' },
      });
      await expect(resolveDocsFor(outsiderId, flow)).resolves.toMatchObject({ ok: true });
    } finally {
      await restore(PrincipalType.USER, memberId, 'mcpServers.docs');
    }
  });

  it("sends the principal's OAuth headers, never librechat.yaml's, once a profile removed one", async () => {
    const flow = await admittedFlow(memberId);
    /** A flow started before flows recorded a generation or a header snapshot. */
    const legacyFlow = { serverName: 'docs', serverUrl: flow.serverUrl };

    await tombstone(PrincipalType.USER, memberId, 'mcpServers.docs.oauth_headers.X-Client-Key');
    try {
      const member = await resolveDocsFor(memberId, legacyFlow);
      const outsider = await resolveDocsFor(outsiderId, legacyFlow);

      expect(member.ok && member.value.oauthHeaders).toEqual({ 'X-Team': 'core' });
      expect(outsider.ok && outsider.value.oauthHeaders).toEqual(DOCS_OAUTH_HEADERS);
      /** A flow admitted with the header belongs to a definition the member no longer has. */
      await expect(resolveDocsFor(memberId, flow)).resolves.toEqual({
        ok: false,
        error: { code: 'server_changed' },
      });
    } finally {
      await restore(PrincipalType.USER, memberId, 'mcpServers.docs.oauth_headers.X-Client-Key');
    }
  });
});
