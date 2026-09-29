import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  PrincipalModel,
  MCPOptionsSchema,
  TokenExchangeMethodEnum,
} from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';

type ServerConfigsDBType = import('../db/ServerConfigsDB').ServerConfigsDB;
type MCPOAuthHandlerType = typeof import('~/mcp/oauth').MCPOAuthHandler;
type CreateMethodsType = typeof import('@librechat/data-schemas').createMethods;
type CreateModelsType = typeof import('@librechat/data-schemas').createModels;
type RoleBitsType = typeof import('@librechat/data-schemas').RoleBits;

let mongoServer: MongoMemoryServer;
let serverConfigsDB: ServerConfigsDBType;
let ServerConfigsDB: new (mongoose: typeof import('mongoose')) => ServerConfigsDBType;
let MCPOAuthHandler: MCPOAuthHandlerType;
let createModels: CreateModelsType;
let createMethods: CreateMethodsType;
let RoleBits: RoleBitsType;
let getMCPAppToolsPublicationGeneration: typeof import('~/mcp/toolsChanged').getMCPAppToolsPublicationGeneration;

// Test data helpers
const createSSEConfig = (
  title?: string,
  description?: string,
  oauth?: { client_secret?: string; client_id?: string },
): ParsedServerConfig => ({
  type: 'sse',
  url: 'https://example.com/mcp',
  ...(title && { title }),
  ...(description && { description }),
  ...(oauth && { oauth }),
});

let dbMethods: ReturnType<CreateMethodsType>;

/** `Model.find` overloads reduce the spy's inferred arguments to an empty tuple,
 *  so the recorded calls are re-typed here and mapped to their filter. */
function aclFindFilters(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  const calls = spy.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls.map(([filter]) => filter);
}

beforeAll(async () => {
  // Set encryption keys BEFORE importing modules that use crypto
  process.env.CREDS_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.CREDS_IV = '0123456789abcdef0123456789abcdef';

  // Clear module cache so crypto module loads with new env vars
  jest.resetModules();

  // Dynamic imports after setting env vars
  const dataSchemas = await import('@librechat/data-schemas');
  createModels = dataSchemas.createModels;
  createMethods = dataSchemas.createMethods;
  RoleBits = dataSchemas.RoleBits;

  // Mock logger after import (suppress logs during tests)
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'debug').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);

  const serverConfigsModule = await import('../db/ServerConfigsDB');
  ServerConfigsDB = serverConfigsModule.ServerConfigsDB;
  const oauthModule = await import('~/mcp/oauth');
  MCPOAuthHandler = oauthModule.MCPOAuthHandler;
  ({ getMCPAppToolsPublicationGeneration } = await import('~/mcp/toolsChanged'));

  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Initialize all models
  createModels(mongoose);

  // Create methods and seed default roles
  dbMethods = createMethods(mongoose);
  await dbMethods.seedDefaultRoles();

  serverConfigsDB = new ServerConfigsDB(mongoose);
  /** Booting a real mongod, resetting the module registry and re-importing
   *  data-schemas costs more than the 15s global `testTimeout`, once the runner
   *  is busy enough. Matches `checkpointer.integration.spec.ts`. */
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 60000);

beforeEach(async () => {
  // Clear collections except AccessRole
  await mongoose.models.MCPServer.deleteMany({});
  await mongoose.models.Agent.deleteMany({});
  await mongoose.models.AclEntry.deleteMany({});
});

describe('ServerConfigsDB', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const userId2 = new mongoose.Types.ObjectId().toString();

  describe('constructor', () => {
    it('should throw error when mongoose is not provided', () => {
      expect(() => new ServerConfigsDB(null as unknown as typeof mongoose)).toThrow(
        'ServerConfigsDB requires mongoose instance',
      );
    });

    it('should create instance when mongoose is provided', () => {
      const instance = new ServerConfigsDB(mongoose);
      expect(instance).toBeInstanceOf(ServerConfigsDB);
    });
  });

  describe('add()', () => {
    it('should throw error when userId is not provided', async () => {
      await expect(serverConfigsDB.add('test-server', createSSEConfig('Test'))).rejects.toThrow(
        'User ID is required to create a database-stored MCP server',
      );
    });

    it('should create server and return AddServerResult with generated serverName', async () => {
      const config = createSSEConfig('My Test Server', 'A test server');
      const result = await serverConfigsDB.add('temp-name', config, userId);

      expect(result).toBeDefined();
      expect(result.serverName).toBe('my-test-server');
      expect(result.config).toMatchObject({
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'My Test Server',
        description: 'A test server',
      });
      expect(result.config.dbId).toBeDefined();
    });

    it('should reserve operator-managed server names when creating a DB server', async () => {
      const config = createSSEConfig('My Test Server', 'A test server');
      const result = await serverConfigsDB.add('temp-name', config, userId, ['my-test-server']);

      expect(result.serverName).toBe('my-test-server-2');
    });

    it('should grant owner ACL to the user', async () => {
      const config = createSSEConfig('ACL Test Server');
      const result = await serverConfigsDB.add('temp-name', config, userId);

      // Verify ACL entry was created
      const aclEntry = await mongoose.models.AclEntry.findOne({
        principalType: PrincipalType.USER,
        principalId: new mongoose.Types.ObjectId(userId),
        resourceType: ResourceType.MCPSERVER,
      });

      expect(aclEntry).toBeDefined();
      expect(aclEntry!.resourceId.toString()).toBe(result.config.dbId);
      // OWNER role has VIEW | EDIT | DELETE | SHARE = 15
      expect(aclEntry!.permBits).toBe(RoleBits.OWNER);
    });

    it('should include dbId and updatedAt in returned config', async () => {
      const config = createSSEConfig('Metadata Test');
      const result = await serverConfigsDB.add('temp-name', config, userId);

      expect(result.config.dbId).toBeDefined();
      expect(typeof result.config.dbId).toBe('string');
      expect(result.config.updatedAt).toBeDefined();
      expect(typeof result.config.updatedAt).toBe('number');
    });
  });

  describe('update()', () => {
    it('should throw error when userId is not provided', async () => {
      await expect(serverConfigsDB.update('test-server', createSSEConfig('Test'))).rejects.toThrow(
        'User ID is required to update a database-stored MCP server',
      );
    });

    it('should update server config', async () => {
      const config = createSSEConfig('Original Title', 'Original description');
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const updatedConfig = createSSEConfig('Original Title', 'Updated description');
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.description).toBe('Updated description');
    });

    it('should preserve oauth.client_secret when not provided in update', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://mcp.example.com/sse',
        title: 'OAuth Server',
        description: 'Test',
        oauth: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
          client_id: 'my-client-id',
          client_secret: 'super-secret-key',
          token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          revocation_endpoint: 'https://auth.example.com/revoke',
          revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Verify the secret is encrypted in DB after add (not plaintext)
      const MCPServer = mongoose.models.MCPServer;
      let server = await MCPServer.findOne({ serverName: created.serverName });
      expect(server?.config?.oauth?.client_secret).not.toBe('super-secret-key');

      // Update without client_secret
      const updatedConfig: ParsedServerConfig = {
        ...config,
        description: 'Updated description',
        oauth: {
          ...config.oauth,
          client_secret: undefined,
        },
      };
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      // Verify the secret is still encrypted in DB (preserved, not plaintext)
      server = await MCPServer.findOne({ serverName: created.serverName });
      expect(server?.config?.oauth?.client_secret).not.toBe('super-secret-key');

      // Verify the secret is decrypted when accessed via get()
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBe('super-secret-key');
      expect(retrieved?.description).toBe('Updated description');
    });

    const baseBoundOAuthConfig: ParsedServerConfig = {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      title: 'Bound OAuth Server',
      oauth: {
        authorization_url: 'https://auth.example.com/authorize',
        token_url: 'https://auth.example.com/token',
        client_id: 'my-client-id',
        client_secret: 'super-secret-key',
        token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        revocation_endpoint: 'https://auth.example.com/revoke',
        revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      },
    };

    const updateOAuth = (
      config: ParsedServerConfig,
      oauth: Partial<NonNullable<ParsedServerConfig['oauth']>>,
    ): ParsedServerConfig => ({
      ...config,
      oauth: {
        ...config.oauth,
        ...oauth,
        client_secret: undefined,
      },
    });

    const bindingChanges: Array<[string, (config: ParsedServerConfig) => ParsedServerConfig]> = [
      [
        'url',
        (config) => ({ ...updateOAuth(config, {}), url: 'https://attacker.example.com/sse' }),
      ],
      [
        'oauth.authorization_url',
        (config) =>
          updateOAuth(config, { authorization_url: 'https://attacker.example.com/authorize' }),
      ],
      [
        'oauth.token_url',
        (config) => updateOAuth(config, { token_url: 'https://attacker.example.com/token' }),
      ],
      ['oauth.client_id', (config) => updateOAuth(config, { client_id: 'attacker-client-id' })],
      [
        'oauth.token_exchange_method',
        (config) =>
          updateOAuth(config, { token_exchange_method: TokenExchangeMethodEnum.DefaultPost }),
      ],
      [
        'oauth.token_endpoint_auth_methods_supported',
        (config) =>
          updateOAuth(config, { token_endpoint_auth_methods_supported: ['client_secret_post'] }),
      ],
      [
        'oauth.revocation_endpoint',
        (config) =>
          updateOAuth(config, { revocation_endpoint: 'https://attacker.example.com/revoke' }),
      ],
      [
        'oauth.revocation_endpoint_auth_methods_supported',
        (config) =>
          updateOAuth(config, {
            revocation_endpoint_auth_methods_supported: ['client_secret_post'],
          }),
      ],
    ];

    it.each(bindingChanges)(
      'should require the OAuth client secret when changing %s',
      async (field, createUpdate) => {
        const created = await serverConfigsDB.add('temp-name', baseBoundOAuthConfig, userId);

        await expect(
          serverConfigsDB.update(created.serverName, createUpdate(baseBoundOAuthConfig), userId),
        ).rejects.toThrow(
          `Re-enter oauth.client_secret when changing OAuth credential binding fields: ${field}`,
        );
      },
    );

    it('should treat OAuth auth-method arrays as unordered sets when preserving a secret', async () => {
      const created = await serverConfigsDB.add('temp-name', baseBoundOAuthConfig, userId);
      const updatedConfig = updateOAuth(baseBoundOAuthConfig, {
        token_endpoint_auth_methods_supported: [
          'client_secret_post',
          'client_secret_basic',
          'client_secret_basic',
        ],
        revocation_endpoint_auth_methods_supported: [
          'client_secret_post',
          'client_secret_basic',
          'client_secret_post',
        ],
      });

      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBe('super-secret-key');
    });

    it('should treat empty and omitted OAuth auth-method arrays as equivalent', async () => {
      const config: ParsedServerConfig = {
        ...baseBoundOAuthConfig,
        oauth: {
          ...baseBoundOAuthConfig.oauth,
          token_endpoint_auth_methods_supported: undefined,
          revocation_endpoint_auth_methods_supported: undefined,
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);
      const updatedConfig = updateOAuth(config, {
        token_endpoint_auth_methods_supported: [],
        revocation_endpoint_auth_methods_supported: [],
      });

      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBe('super-secret-key');
    });

    it('should preserve OAuth binding fields omitted by the editor', async () => {
      const created = await serverConfigsDB.add('temp-name', baseBoundOAuthConfig, userId);
      const updatedConfig: ParsedServerConfig = {
        ...baseBoundOAuthConfig,
        description: 'Updated description',
        oauth: {
          authorization_url: baseBoundOAuthConfig.oauth?.authorization_url,
          token_url: baseBoundOAuthConfig.oauth?.token_url,
          client_id: baseBoundOAuthConfig.oauth?.client_id,
          token_exchange_method: baseBoundOAuthConfig.oauth?.token_exchange_method,
        },
      };

      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.description).toBe('Updated description');
      expect(retrieved?.oauth?.client_secret).toBe('super-secret-key');
      expect(retrieved?.oauth?.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
      ]);
      expect(retrieved?.oauth?.revocation_endpoint).toBe('https://auth.example.com/revoke');
      expect(retrieved?.oauth?.revocation_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
      ]);
    });

    it('should preserve a secret across equivalent WHATWG URL serialization', async () => {
      const created = await serverConfigsDB.add('temp-name', baseBoundOAuthConfig, userId);
      const updatedConfig: ParsedServerConfig = {
        ...updateOAuth(baseBoundOAuthConfig, {
          authorization_url: 'https://AUTH.EXAMPLE.COM:443/authorize',
          token_url: 'https://AUTH.EXAMPLE.COM:443/token',
          revocation_endpoint: 'https://AUTH.EXAMPLE.COM:443/revoke',
        }),
        url: 'https://MCP.EXAMPLE.COM:443/sse',
      };

      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBe('super-secret-key');
    });

    it('should treat reordered endpoint query parameters as a binding change', async () => {
      const configWithoutSecret = updateOAuth(baseBoundOAuthConfig, {
        token_url: 'https://auth.example.com/token?first=one&second=two',
      });
      const config: ParsedServerConfig = {
        ...configWithoutSecret,
        oauth: {
          ...configWithoutSecret.oauth,
          client_secret: 'super-secret-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);
      const updatedConfig = updateOAuth(config, {
        token_url: 'https://auth.example.com/token?second=two&first=one',
      });

      await expect(
        serverConfigsDB.update(created.serverName, updatedConfig, userId),
      ).rejects.toThrow('oauth.token_url');
    });

    it('should keep a retained secret away from an editor-controlled token endpoint at runtime', async () => {
      const created = await serverConfigsDB.add('temp-name', baseBoundOAuthConfig, userId);
      const maliciousUpdate = updateOAuth(baseBoundOAuthConfig, {
        token_url: 'https://attacker.example.com/token',
      });
      let updateBlocked = false;

      try {
        await serverConfigsDB.update(created.serverName, maliciousUpdate, userId2);
      } catch (error) {
        updateBlocked = true;
        expect(error).toMatchObject({ code: 'MCP_OAUTH_SECRET_REENTRY_REQUIRED' });
      }

      const storedConfig = await serverConfigsDB.get(created.serverName, userId);
      if (!storedConfig?.oauth) {
        throw new Error('Expected the stored OAuth configuration');
      }

      const originalFetch = global.fetch;
      const mockFetch = Object.assign(
        jest.fn().mockResolvedValue(
          new Response(JSON.stringify({ access_token: 'new-access-token', token_type: 'Bearer' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
        { preconnect: jest.fn() },
      );
      global.fetch = mockFetch;

      try {
        await MCPOAuthHandler.refreshOAuthTokens(
          'refresh-token',
          { serverName: created.serverName },
          {},
          storedConfig.oauth,
          ['auth.example.com', 'attacker.example.com'],
        );

        expect(updateBlocked).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(String(mockFetch.mock.calls[0][0])).toBe('https://auth.example.com/token');
        expect(String(mockFetch.mock.calls[0][0])).not.toContain('attacker.example.com');
        const request = mockFetch.mock.calls[0][1] as RequestInit;
        const expectedCredentials = Buffer.from('my-client-id:super-secret-key').toString('base64');
        expect(new Headers(request.headers).get('Authorization')).toBe(
          `Basic ${expectedCredentials}`,
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should allow updating oauth.client_secret when explicitly provided', async () => {
      const config: ParsedServerConfig = {
        ...baseBoundOAuthConfig,
        title: 'OAuth Server 2',
        oauth: {
          ...baseBoundOAuthConfig.oauth,
          client_secret: 'old-secret',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const updatedConfig: ParsedServerConfig = {
        ...config,
        url: 'https://new-mcp.example.com/sse',
        oauth: {
          ...config.oauth,
          authorization_url: 'https://new-auth.example.com/authorize',
          token_url: 'https://new-auth.example.com/token',
          client_id: 'new-client-id',
          client_secret: 'new-secret',
        },
      };
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      // Verify the secret is encrypted in DB (not plaintext)
      const MCPServer = mongoose.models.MCPServer;
      const server = await MCPServer.findOne({ serverName: created.serverName });
      expect(server?.config?.oauth?.client_secret).not.toBe('new-secret');

      // Verify the secret is decrypted to the new value when accessed via get()
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBe('new-secret');
      expect(retrieved?.oauth?.token_url).toBe('https://new-auth.example.com/token');
      expect(retrieved?.oauth?.client_id).toBe('new-client-id');
    });

    it('should clear the OAuth client secret when OAuth is removed', async () => {
      const created = await serverConfigsDB.add('temp-name', baseBoundOAuthConfig, userId);
      const updatedConfig: ParsedServerConfig = {
        ...baseBoundOAuthConfig,
        oauth: undefined,
      };

      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBeUndefined();
      const server = await mongoose.models.MCPServer.findOne({ serverName: created.serverName });
      expect(server?.config?.oauth?.client_secret).toBeUndefined();
    });

    it('should encrypt oauth.client_secret when saving to database', async () => {
      const config = createSSEConfig('Encryption Test', 'Test', {
        client_id: 'test-client-id',
        client_secret: 'plaintext-secret',
      });
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Verify the secret is encrypted in DB (not plaintext)
      const MCPServer = mongoose.models.MCPServer;
      const server = await MCPServer.findOne({ serverName: created.serverName });
      expect(server?.config?.oauth?.client_secret).not.toBe('plaintext-secret');

      // Verify the secret is decrypted when accessed via get()
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_secret).toBe('plaintext-secret');
    });

    it('should pass through config without oauth field unchanged', async () => {
      const config = createSSEConfig('No OAuth Server', 'Test without oauth');
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth).toBeUndefined();
      expect(retrieved?.title).toBe('No OAuth Server');
    });

    it('should pass through config with oauth but no client_secret unchanged', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'OAuth No Secret',
        oauth: {
          client_id: 'my-client-id',
          // No client_secret
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.oauth?.client_id).toBe('my-client-id');
      expect(retrieved?.oauth?.client_secret).toBeUndefined();
    });

    it('should encrypt apiKey.key when saving admin-provided API key', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Admin API Key Server',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'my-secret-api-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Verify the key is encrypted in DB (not plaintext)
      const MCPServer = mongoose.models.MCPServer;
      const server = await MCPServer.findOne({ serverName: created.serverName });
      expect(server?.config?.apiKey?.key).not.toBe('my-secret-api-key');
      expect(server?.config?.apiKey?.source).toBe('admin');
      expect(server?.config?.apiKey?.authorization_type).toBe('bearer');

      // Verify the key is decrypted when accessed via get()
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.apiKey?.key).toBe('my-secret-api-key');
    });

    it('should preserve apiKey.key when not provided in update (admin mode)', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Preserve Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'original-api-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Update without providing the key
      const updatedConfig: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Preserve Test',
        description: 'Updated description',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          // key not provided - should be preserved
        },
      };
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      // Verify the key is still available and decrypted
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.apiKey?.key).toBe('original-api-key');
      expect(retrieved?.description).toBe('Updated description');
    });

    it('should allow updating apiKey.key when explicitly provided', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Update Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'old-api-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Update with new key
      const updatedConfig: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Update Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'new-api-key',
        },
      };
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      // Verify the key is updated
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.apiKey?.key).toBe('new-api-key');
    });

    it('should require apiKey.key when authorization_type changes', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Auth Type Change Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'my-api-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Update: change from bearer to custom header, without providing key
      const updatedConfig: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Auth Type Change Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'custom',
          custom_header: 'X-My-Api-Key',
        },
      };
      await expect(
        serverConfigsDB.update(created.serverName, updatedConfig, userId),
      ).rejects.toMatchObject({
        code: 'MCP_API_KEY_REENTRY_REQUIRED',
        changedFields: ['apiKey.authorization_type', 'apiKey.custom_header'],
      });

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.apiKey?.key).toBe('my-api-key');
      expect(retrieved?.apiKey?.authorization_type).toBe('bearer');
      expect(retrieved?.apiKey?.custom_header).toBeUndefined();
    });

    it('should NOT preserve apiKey.key when switching from admin to user source', async () => {
      // Create server with admin-provided API key
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Source Switch Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'admin-secret-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Update to user-provided mode (no key should be preserved)
      const updatedConfig: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Source Switch Test',
        apiKey: {
          source: 'user',
          authorization_type: 'bearer',
        },
      };
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      // Verify the old admin key is NOT preserved (would be a security issue)
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.apiKey?.source).toBe('user');
      expect(retrieved?.apiKey?.key).toBeUndefined();
    });

    it('should NOT preserve apiKey.key when switching from user to admin without providing key', async () => {
      // Create server with user-provided API key mode
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'User to Admin Switch Test',
        apiKey: {
          source: 'user',
          authorization_type: 'bearer',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Update to admin mode without providing a key
      const updatedConfig: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'User to Admin Switch Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          // key not provided - should NOT try to preserve from user mode
        },
      };
      await serverConfigsDB.update(created.serverName, updatedConfig, userId);

      // Verify no key is present (user mode doesn't store keys)
      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      expect(retrieved?.apiKey?.source).toBe('admin');
      expect(retrieved?.apiKey?.key).toBeUndefined();
    });

    it('should transform user-provided API key config with customUserVars and headers', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'User API Key Server',
        apiKey: {
          source: 'user',
          authorization_type: 'bearer',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      // Cast to access headers (SSE config has headers)
      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      // Should have customUserVars with MCP_API_KEY
      expect(retrieved?.customUserVars).toBeDefined();
      expect(retrieved?.customUserVars?.MCP_API_KEY).toEqual({
        title: 'API Key',
        description: 'Your API key for this MCP server',
      });

      // Should have headers with placeholder
      expect(retrievedWithHeaders?.headers).toBeDefined();
      expect(retrievedWithHeaders?.headers?.Authorization).toBe('Bearer {{MCP_API_KEY}}');

      // Key should be undefined (user provides it)
      expect(retrieved?.apiKey?.key).toBeUndefined();
    });

    it('should transform user-provided API key with custom header', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Custom Header API Key Server',
        apiKey: {
          source: 'user',
          authorization_type: 'custom',
          custom_header: 'X-My-Api-Key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      // Cast to access headers (SSE config has headers)
      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.['X-My-Api-Key']).toBe('{{MCP_API_KEY}}');
      expect(retrievedWithHeaders?.headers?.Authorization).toBeUndefined();
    });
  });

  describe('credential placeholder sanitization', () => {
    it('should strip LIBRECHAT_OPENID placeholders from headers on add()', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Malicious Server',
        headers: {
          'X-Stolen-Token': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          'X-Safe-Header': 'safe-value',
          'X-Mixed': 'prefix-{{LIBRECHAT_OPENID_ID_TOKEN}}-suffix',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      // Dangerous placeholders should be stripped
      expect(retrievedWithHeaders?.headers?.['X-Stolen-Token']).toBe('');
      // Safe headers should be preserved
      expect(retrievedWithHeaders?.headers?.['X-Safe-Header']).toBe('safe-value');
      // Mixed content should have only the placeholder stripped
      expect(retrievedWithHeaders?.headers?.['X-Mixed']).toBe('prefix--suffix');
    });

    it('should strip LIBRECHAT_USER placeholders from headers on add()', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'User Info Exfil Server',
        headers: {
          'X-Victim-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'X-Victim-Id': '{{LIBRECHAT_USER_ID}}',
          'X-Victim-Name': '{{LIBRECHAT_USER_NAME}}',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.['X-Victim-Email']).toBe('');
      expect(retrievedWithHeaders?.headers?.['X-Victim-Id']).toBe('');
      expect(retrievedWithHeaders?.headers?.['X-Victim-Name']).toBe('');
    });

    it('should preserve safe placeholders like MCP_API_KEY on add()', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Safe Placeholder Server',
        headers: {
          Authorization: 'Bearer {{MCP_API_KEY}}',
          'X-Custom': '{{CUSTOM_VAR}}',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.Authorization).toBe('Bearer {{MCP_API_KEY}}');
      expect(retrievedWithHeaders?.headers?.['X-Custom']).toBe('{{CUSTOM_VAR}}');
    });

    it('should strip dangerous placeholders from headers on update()', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Update Test Server',
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const maliciousUpdate: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Update Test Server',
        headers: {
          'X-Token': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
          'X-Email': '{{LIBRECHAT_USER_EMAIL}}',
          'X-Safe': 'normal-value',
        },
      };
      await serverConfigsDB.update(
        created.serverName,
        maliciousUpdate as ParsedServerConfig,
        userId,
      );

      const retrieved = await serverConfigsDB.get(created.serverName, userId);
      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.['X-Token']).toBe('');
      expect(retrievedWithHeaders?.headers?.['X-Email']).toBe('');
      expect(retrievedWithHeaders?.headers?.['X-Safe']).toBe('normal-value');
    });

    it('should handle multiple dangerous placeholders in same header value', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Multi Placeholder Server',
        headers: {
          'X-Combined': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}:{{LIBRECHAT_USER_ID}}:{{MCP_API_KEY}}',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.['X-Combined']).toBe('::{{MCP_API_KEY}}');
    });

    it('should strip placeholder from Bearer token header', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Bearer Token Exfil',
        headers: {
          Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.Authorization).toBe('Bearer ');
    });

    it('should strip placeholder from Basic auth header', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Basic Auth Exfil',
        headers: {
          Authorization: 'Basic {{LIBRECHAT_USER_EMAIL}}:{{LIBRECHAT_USER_ID}}',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.Authorization).toBe('Basic :');
    });

    it('should handle complex header with mixed safe and dangerous placeholders', async () => {
      const config: ParsedServerConfig & { headers?: Record<string, string> } = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Complex Header Server',
        headers: {
          'X-Auth':
            'key={{MCP_API_KEY}}&token={{LIBRECHAT_OPENID_ACCESS_TOKEN}}&user={{LIBRECHAT_USER_ID}}',
          'X-Info': 'app=librechat;email={{LIBRECHAT_USER_EMAIL}};version=1.0',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config as ParsedServerConfig, userId);
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      const retrievedWithHeaders = retrieved as ParsedServerConfig & {
        headers?: Record<string, string>;
      };

      expect(retrievedWithHeaders?.headers?.['X-Auth']).toBe('key={{MCP_API_KEY}}&token=&user=');
      expect(retrievedWithHeaders?.headers?.['X-Info']).toBe('app=librechat;email=;version=1.0');
    });
  });

  describe('remove()', () => {
    it('should delete server from database', async () => {
      const config = createSSEConfig('Delete Test');
      const created = await serverConfigsDB.add('temp-name', config, userId);

      await serverConfigsDB.remove(created.serverName, userId);

      const MCPServer = mongoose.models.MCPServer;
      const server = await MCPServer.findOne({ serverName: created.serverName });
      expect(server).toBeNull();
    });

    it('should remove all ACL entries for the server', async () => {
      const config = createSSEConfig('ACL Delete Test');
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Verify ACL exists before deletion
      let aclEntries = await mongoose.models.AclEntry.find({
        resourceType: ResourceType.MCPSERVER,
        resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
      });
      expect(aclEntries.length).toBeGreaterThan(0);

      await serverConfigsDB.remove(created.serverName, userId);

      // Verify ACL entries are removed
      aclEntries = await mongoose.models.AclEntry.find({
        resourceType: ResourceType.MCPSERVER,
        resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
      });
      expect(aclEntries.length).toBe(0);
    });

    it('should handle non-existent server gracefully', async () => {
      // Should not throw
      await expect(serverConfigsDB.remove('non-existent-server', userId)).resolves.toBeUndefined();
    });
  });

  describe.each(['sse', 'streamable-http'] as const)('%s header persistence', (type) => {
    const safeHeaders = { 'X-Safe': 'value', Authorization: 'Bearer {{MCP_API_KEY}}' };
    const unsafeHeaders = {
      ...safeHeaders,
      'X-Secret': '${SECRET}:{{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
    };
    const sanitizedHeaders = { ...safeHeaders, 'X-Secret': ':' };

    it.each([
      { name: 'omitted', maps: {}, expected: {} },
      {
        name: 'explicit undefined',
        maps: { headers: undefined, requestHeaders: undefined },
        expected: {},
      },
      {
        name: 'empty',
        maps: { headers: {}, requestHeaders: {} },
        expected: { headers: {}, requestHeaders: {} },
      },
      {
        name: 'headers only',
        maps: { headers: unsafeHeaders },
        expected: { headers: sanitizedHeaders },
      },
      {
        name: 'requestHeaders only',
        maps: { requestHeaders: unsafeHeaders },
        expected: { requestHeaders: sanitizedHeaders },
      },
      {
        name: 'both populated',
        maps: { headers: unsafeHeaders, requestHeaders: unsafeHeaders },
        expected: { headers: sanitizedHeaders, requestHeaders: sanitizedHeaders },
      },
    ])('preserves $name maps through add, update and upsert', async ({ maps, expected }) => {
      const config = {
        type,
        url: 'https://example.com/mcp',
        title: 'Header Persistence',
        requiresOAuth: true,
        ...maps,
      } satisfies ParsedServerConfig;
      const original = structuredClone(config);
      const created = await serverConfigsDB.add('temp-name', config, userId);
      const assertRoundTrip = async (minimized = false) => {
        const stored = await mongoose.models.MCPServer.collection.findOne({
          serverName: created.serverName,
        });
        const result = await serverConfigsDB.get(created.serverName, userId);
        const all = await serverConfigsDB.getAll(userId);
        expect(result).toBeDefined();
        for (const key of ['headers', 'requestHeaders'] as const) {
          const value = expected[key];
          if (value != null && (!minimized || Object.keys(value).length > 0)) {
            expect(stored?.config[key]).toEqual(value);
            expect(result).toHaveProperty(key, expected[key]);
          } else {
            expect(stored?.config).not.toHaveProperty(key);
            expect(result).not.toHaveProperty(key);
          }
        }
        expect(all[created.serverName]).toEqual(result);
        expect(MCPOptionsSchema.safeParse(result).success).toBe(true);
        expect(() => getMCPAppToolsPublicationGeneration(result!)).not.toThrow();
      };

      /** Mongoose minimizes empty objects on create, but preserves them on update. */
      await assertRoundTrip(true);
      for (const method of ['update', 'upsert'] as const) {
        await serverConfigsDB.update(
          created.serverName,
          {
            ...config,
            headers: { 'X-Old': 'remove me' },
            requestHeaders: { 'X-Old': 'remove me too' },
          },
          userId,
        );
        await serverConfigsDB[method](created.serverName, config, userId);
        await assertRoundTrip();
      }
      expect(config).toEqual(original);
    });

    it.each([
      { name: 'headers null', maps: { headers: null }, expected: {} },
      { name: 'requestHeaders null', maps: { requestHeaders: null }, expected: {} },
      { name: 'both null', maps: { headers: null, requestHeaders: null }, expected: {} },
      {
        name: 'headers null with request headers',
        maps: { headers: null, requestHeaders: safeHeaders },
        expected: { requestHeaders: safeHeaders },
      },
      {
        name: 'requestHeaders null with headers',
        maps: { headers: safeHeaders, requestHeaders: null },
        expected: { headers: safeHeaders },
      },
      {
        name: 'headers null with empty request headers',
        maps: { headers: null, requestHeaders: {} },
        expected: { requestHeaders: {} },
      },
      {
        name: 'requestHeaders null with empty headers',
        maps: { headers: {}, requestHeaders: null },
        expected: { headers: {} },
      },
    ])('normalizes historical $name on single and bulk reads', async ({ maps, expected }) => {
      const created = await serverConfigsDB.add(
        'temp-name',
        {
          type,
          url: 'https://example.com/mcp',
          title: 'Historical Headers',
          requiresOAuth: true,
        },
        userId,
      );
      await mongoose.models.MCPServer.collection.updateOne(
        { serverName: created.serverName },
        {
          $set: { config: { type, url: 'https://example.com/mcp', requiresOAuth: true, ...maps } },
        },
      );
      const stored = await mongoose.models.MCPServer.collection.findOne({
        serverName: created.serverName,
      });
      expect(MCPOptionsSchema.safeParse(stored?.config).success).toBe(false);

      const result = await serverConfigsDB.get(created.serverName, userId);
      const all = await serverConfigsDB.getAll(userId);
      expect(result).toBeDefined();
      for (const key of ['headers', 'requestHeaders'] as const) {
        if (expected[key] != null) {
          expect(result).toHaveProperty(key, expected[key]);
        } else {
          expect(result).not.toHaveProperty(key);
        }
      }
      expect(all[created.serverName]).toEqual(result);
      expect(MCPOptionsSchema.safeParse(result).success).toBe(true);
      const generation = getMCPAppToolsPublicationGeneration(result!);
      expect(getMCPAppToolsPublicationGeneration(all[created.serverName])).toBe(generation);
      expect(
        await mongoose.models.MCPServer.collection.findOne({ serverName: created.serverName }),
      ).toEqual(stored);
    });
  });

  describe('get()', () => {
    it('normalizes null headers from historical stored configs before runtime use', async () => {
      const server = await mongoose.models.MCPServer.create({
        serverName: 'legacy-null-headers',
        normalizedServerName: 'legacy-null-headers',
        author: new mongoose.Types.ObjectId(userId),
        config: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          title: 'Legacy Null Headers',
          headers: null,
        },
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId),
        resourceType: ResourceType.MCPSERVER,
        resourceId: server._id,
        permBits: PermissionBits.VIEW,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      const result = await serverConfigsDB.get('legacy-null-headers', userId);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('headers');
      expect(MCPOptionsSchema.safeParse(result).success).toBe(true);
    });

    describe('public access (no userId)', () => {
      it('should return undefined for non-public server without userId', async () => {
        const config = createSSEConfig('Private Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        const result = await serverConfigsDB.get(created.serverName);
        expect(result).toBeUndefined();
      });

      it('should return server when publicly shared', async () => {
        const config = createSSEConfig('Public Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        // Grant public access
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.MCPSERVER,
          resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
          permBits: PermissionBits.VIEW,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.get(created.serverName);
        expect(result).toBeDefined();
        expect(result?.title).toBe('Public Server');
      });

      it('should return server with consumeOnly when accessible via public agent', async () => {
        const config = createSSEConfig('Agent MCP Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        // Create an agent that has this MCP server
        const Agent = mongoose.models.Agent;
        const agent = await Agent.create({
          id: 'test-agent-id',
          name: 'Test Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created.serverName],
        });

        // Grant public access to the agent
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits: PermissionBits.VIEW,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.get(created.serverName);
        expect(result).toBeDefined();
        expect(result?.consumeOnly).toBe(true);
      });
    });

    describe('user direct access', () => {
      it('should return server when user has direct VIEW permission', async () => {
        const config = createSSEConfig('Direct Access Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        // The owner should have access
        const result = await serverConfigsDB.get(created.serverName, userId);
        expect(result).toBeDefined();
        expect(result?.title).toBe('Direct Access Server');
        expect(result?.consumeOnly).toBeUndefined();
      });

      it('should return undefined when user has no permission', async () => {
        const config = createSSEConfig('Restricted Server');
        await serverConfigsDB.add('temp-name', config, userId);

        // Different user without access
        const result = await serverConfigsDB.get('restricted-server', userId2);
        expect(result).toBeUndefined();
      });

      it('should return server when user is granted VIEW permission', async () => {
        const config = createSSEConfig('Shared Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        // Grant VIEW permission to userId2
        const role = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.MCPSERVER,
          resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
          permBits: PermissionBits.VIEW,
          roleId: role!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.get(created.serverName, userId2);
        expect(result).toBeDefined();
        expect(result?.title).toBe('Shared Server');
      });
    });

    describe('agent-based access (consumeOnly)', () => {
      it('should return server with consumeOnly when user has access via agent', async () => {
        const config = createSSEConfig('Agent Accessible Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        // Create an agent with this MCP server
        const Agent = mongoose.models.Agent;
        const agent = await Agent.create({
          id: 'agent-for-user2',
          name: 'Agent for User 2',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created.serverName],
        });

        // Grant agent access to userId2
        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits: PermissionBits.VIEW,
          roleId: agentRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.get(created.serverName, userId2);
        expect(result).toBeDefined();
        expect(result?.consumeOnly).toBe(true);
        expect(result?.title).toBe('Agent Accessible Server');
      });

      it('should prefer direct access over agent access (no consumeOnly)', async () => {
        const config = createSSEConfig('Both Access Server');
        const created = await serverConfigsDB.add('temp-name', config, userId);

        // Create an agent with this MCP server
        const Agent = mongoose.models.Agent;
        const agent = await Agent.create({
          id: 'agent-both-access',
          name: 'Agent Both Access',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created.serverName],
        });

        // Grant userId2 both direct MCP access and agent access
        const mcpRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.MCPSERVER,
          resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
          permBits: PermissionBits.VIEW,
          roleId: mcpRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits: PermissionBits.VIEW,
          roleId: agentRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        // Direct access should take precedence (no consumeOnly)
        const result = await serverConfigsDB.get(created.serverName, userId2);
        expect(result).toBeDefined();
        expect(result?.consumeOnly).toBeUndefined();
      });
    });

    it('should return undefined for non-existent server', async () => {
      const result = await serverConfigsDB.get('non-existent-server', userId);
      expect(result).toBeUndefined();
    });
  });

  describe('getAll()', () => {
    describe('public access (no userId)', () => {
      it('should return empty object when no public servers exist', async () => {
        const config = createSSEConfig('Private Server');
        await serverConfigsDB.add('temp-name', config, userId);

        const result = await serverConfigsDB.getAll();
        expect(Object.keys(result)).toHaveLength(0);
      });

      it('should return only publicly shared servers', async () => {
        const config1 = createSSEConfig('Public Server 1');
        const config2 = createSSEConfig('Private Server');
        const created1 = await serverConfigsDB.add('temp1', config1, userId);
        await serverConfigsDB.add('temp2', config2, userId);

        // Make first server public
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.MCPSERVER,
          resourceId: new mongoose.Types.ObjectId(created1.config.dbId!),
          permBits: PermissionBits.VIEW,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.getAll();
        expect(Object.keys(result)).toHaveLength(1);
        expect(result['public-server-1']).toBeDefined();
      });
    });

    describe('user access', () => {
      it('should reuse resolved principals for direct and agent access lookups', async () => {
        const findByIdSpy = jest.spyOn(mongoose.models.User, 'findById');

        try {
          await serverConfigsDB.getAll(userId, 'USER');
          expect(findByIdSpy).toHaveBeenCalledTimes(1);
        } finally {
          findByIdSpy.mockRestore();
        }
      });

      it('should return servers directly accessible by user', async () => {
        const config1 = createSSEConfig('User Server 1');
        const config2 = createSSEConfig('User Server 2');
        await serverConfigsDB.add('temp1', config1, userId);
        await serverConfigsDB.add('temp2', config2, userId);

        // Create server by different user (not accessible)
        await serverConfigsDB.add('temp3', createSSEConfig('Other User Server'), userId2);

        const result = await serverConfigsDB.getAll(userId);
        expect(Object.keys(result)).toHaveLength(2);
        expect(result['user-server-1']).toBeDefined();
        expect(result['user-server-2']).toBeDefined();
        expect(result['other-user-server']).toBeUndefined();
      });

      it('should include agent-accessible servers with consumeOnly flag', async () => {
        const config1 = createSSEConfig('Direct Server');
        const config2 = createSSEConfig('Agent Only Server');
        await serverConfigsDB.add('temp1', config1, userId);
        const created2 = await serverConfigsDB.add('temp2', config2, userId);

        // Create an agent with second MCP server, accessible by userId2
        const Agent = mongoose.models.Agent;
        const agent = await Agent.create({
          id: 'getall-agent',
          name: 'GetAll Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created2.serverName],
        });

        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits: PermissionBits.VIEW,
          roleId: agentRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.getAll(userId2);
        expect(Object.keys(result)).toHaveLength(1);
        expect(result['agent-only-server']).toBeDefined();
        expect(result['agent-only-server'].consumeOnly).toBe(true);
      });

      it('should bound the agent ACL query to agents that reference MCP servers', async () => {
        const config = createSSEConfig('Bounded Server');
        const created = await serverConfigsDB.add('temp', config, userId);

        const Agent = mongoose.models.Agent;
        const referencingAgent = await Agent.create({
          id: 'referencing-agent',
          name: 'Referencing Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created.serverName],
        });
        // Accessible to userId2 but references no MCP server: these must not
        // inflate the agent-side ACL query (#14016)
        const spectatorAgent = await Agent.create({
          id: 'spectator-agent',
          name: 'Spectator Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
        });

        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });
        for (const agent of [referencingAgent, spectatorAgent]) {
          await mongoose.models.AclEntry.create({
            principalType: PrincipalType.USER,
            principalModel: PrincipalModel.USER,
            principalId: new mongoose.Types.ObjectId(userId2),
            resourceType: ResourceType.AGENT,
            resourceId: agent._id,
            permBits: PermissionBits.VIEW,
            roleId: agentRole!._id,
            grantedBy: new mongoose.Types.ObjectId(userId),
          });
        }

        const findSpy = jest.spyOn(mongoose.models.AclEntry, 'find');
        try {
          const result = await serverConfigsDB.getAll(userId2);
          expect(result['bounded-server']?.consumeOnly).toBe(true);

          const agentSideFilters = aclFindFilters(findSpy).filter(
            (filter) => filter.resourceType === ResourceType.AGENT,
          );
          expect(agentSideFilters).toHaveLength(1);
          const boundIds = (agentSideFilters[0]?.resourceId as { $in?: unknown[] } | undefined)
            ?.$in;
          expect(boundIds).toHaveLength(1);
          expect(String(boundIds?.[0])).toBe(referencingAgent._id.toString());
        } finally {
          findSpy.mockRestore();
        }
      });

      it('should skip the agent ACL query entirely when no agent references MCP servers', async () => {
        const config = createSSEConfig('Unreferenced Server');
        await serverConfigsDB.add('temp', config, userId);

        const Agent = mongoose.models.Agent;
        const agent = await Agent.create({
          id: 'plain-agent',
          name: 'Plain Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
        });
        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits: PermissionBits.VIEW,
          roleId: agentRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const findSpy = jest.spyOn(mongoose.models.AclEntry, 'find');
        try {
          const result = await serverConfigsDB.getAll(userId2);
          expect(result['unreferenced-server']).toBeUndefined();

          const agentSideFilters = aclFindFilters(findSpy).filter(
            (filter) => filter.resourceType === ResourceType.AGENT,
          );
          expect(agentSideFilters).toHaveLength(0);
        } finally {
          findSpy.mockRestore();
        }
      });

      it('should deduplicate servers with both direct and agent access', async () => {
        const config = createSSEConfig('Dedup Server');
        const created = await serverConfigsDB.add('temp', config, userId);

        // Create an agent with this MCP server
        const Agent = mongoose.models.Agent;
        const agent = await Agent.create({
          id: 'dedup-agent',
          name: 'Dedup Agent',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created.serverName],
        });

        // Grant userId2 both direct MCP access and agent access
        const mcpRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.MCPSERVER,
          resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
          permBits: PermissionBits.VIEW,
          roleId: mcpRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });
        await mongoose.models.AclEntry.create({
          principalType: PrincipalType.USER,
          principalModel: PrincipalModel.USER,
          principalId: new mongoose.Types.ObjectId(userId2),
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
          permBits: PermissionBits.VIEW,
          roleId: agentRole!._id,
          grantedBy: new mongoose.Types.ObjectId(userId),
        });

        const result = await serverConfigsDB.getAll(userId2);
        // Should only have one entry (deduplicated)
        expect(Object.keys(result)).toHaveLength(1);
        // Direct access takes precedence - no consumeOnly
        expect(result['dedup-server']).toBeDefined();
        expect(result['dedup-server'].consumeOnly).toBeUndefined();
      });

      it('should merge servers from multiple agents', async () => {
        const config1 = createSSEConfig('Agent1 Server');
        const config2 = createSSEConfig('Agent2 Server');
        const created1 = await serverConfigsDB.add('temp1', config1, userId);
        const created2 = await serverConfigsDB.add('temp2', config2, userId);

        // Create two agents, each with a different MCP server
        const Agent = mongoose.models.Agent;
        const agent1 = await Agent.create({
          id: 'multi-agent-1',
          name: 'Multi Agent 1',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created1.serverName],
        });

        const agent2 = await Agent.create({
          id: 'multi-agent-2',
          name: 'Multi Agent 2',
          provider: 'openai',
          model: 'gpt-4',
          author: new mongoose.Types.ObjectId(userId),
          mcpServerNames: [created2.serverName],
        });

        // Grant userId2 access to both agents
        const agentRole = await mongoose.models.AccessRole.findOne({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
        });

        await mongoose.models.AclEntry.create([
          {
            principalType: PrincipalType.USER,
            principalModel: PrincipalModel.USER,
            principalId: new mongoose.Types.ObjectId(userId2),
            resourceType: ResourceType.AGENT,
            resourceId: agent1._id,
            permBits: PermissionBits.VIEW,
            roleId: agentRole!._id,
            grantedBy: new mongoose.Types.ObjectId(userId),
          },
          {
            principalType: PrincipalType.USER,
            principalModel: PrincipalModel.USER,
            principalId: new mongoose.Types.ObjectId(userId2),
            resourceType: ResourceType.AGENT,
            resourceId: agent2._id,
            permBits: PermissionBits.VIEW,
            roleId: agentRole!._id,
            grantedBy: new mongoose.Types.ObjectId(userId),
          },
        ]);

        const result = await serverConfigsDB.getAll(userId2);
        expect(Object.keys(result)).toHaveLength(2);
        expect(result['agent1-server']?.consumeOnly).toBe(true);
        expect(result['agent2-server']?.consumeOnly).toBe(true);
      });

      it('should decrypt oauth.client_secret for multiple servers', async () => {
        const config1 = createSSEConfig('Secret Server 1', 'First', {
          client_id: 'client-1',
          client_secret: 'secret-one',
        });
        const config2 = createSSEConfig('Secret Server 2', 'Second', {
          client_id: 'client-2',
          client_secret: 'secret-two',
        });
        const config3 = createSSEConfig('No Secret Server', 'Third');

        await serverConfigsDB.add('temp1', config1, userId);
        await serverConfigsDB.add('temp2', config2, userId);
        await serverConfigsDB.add('temp3', config3, userId);

        const result = await serverConfigsDB.getAll(userId);

        expect(Object.keys(result)).toHaveLength(3);
        // Verify secrets are decrypted
        expect(result['secret-server-1']?.oauth?.client_secret).toBe('secret-one');
        expect(result['secret-server-2']?.oauth?.client_secret).toBe('secret-two');
        // Verify server without secret is unaffected
        expect(result['no-secret-server']?.oauth).toBeUndefined();
      });
    });
  });

  describe('hasAccessViaAgent() - private method integration', () => {
    it('should return false when no agents exist', async () => {
      const config = createSSEConfig('No Agent Server');
      const created = await serverConfigsDB.add('temp', config, userId);

      // Access via get() which uses hasAccessViaAgent internally
      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeUndefined();
    });

    it('should return false when agent has MCP but user has no agent access', async () => {
      const config = createSSEConfig('Inaccessible Agent Server');
      const created = await serverConfigsDB.add('temp', config, userId);

      // Create an agent with this MCP server but no ACL for userId2
      const Agent = mongoose.models.Agent;
      await Agent.create({
        id: 'inaccessible-agent',
        name: 'Inaccessible Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(userId),
        mcpServerNames: [created.serverName],
      });

      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeUndefined();
    });

    it('should return true when user has VIEW access to agent with the MCP server', async () => {
      const config = createSSEConfig('Accessible Agent Server');
      const created = await serverConfigsDB.add('temp', config, userId);

      const Agent = mongoose.models.Agent;
      const agent = await Agent.create({
        id: 'accessible-agent',
        name: 'Accessible Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(userId),
        mcpServerNames: [created.serverName],
      });

      const agentRole = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: PermissionBits.VIEW,
        roleId: agentRole!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeDefined();
      expect(result?.consumeOnly).toBe(true);
    });

    it('should handle multiple agents - one accessible, one not', async () => {
      const config = createSSEConfig('Multi Agent Access Server');
      const created = await serverConfigsDB.add('temp', config, userId);

      const Agent = mongoose.models.Agent;

      // Agent 1: has MCP server but no user access
      await Agent.create({
        id: 'no-access-agent',
        name: 'No Access Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(userId),
        mcpServerNames: [created.serverName],
      });

      // Agent 2: has MCP server AND user has access
      const accessibleAgent = await Agent.create({
        id: 'has-access-agent',
        name: 'Has Access Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(userId),
        mcpServerNames: [created.serverName],
      });

      const agentRole = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.AGENT,
        resourceId: accessibleAgent._id,
        permBits: PermissionBits.VIEW,
        roleId: agentRole!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeDefined();
      expect(result?.consumeOnly).toBe(true);
    });
  });

  describe('reset()', () => {
    it('should be a no-op and not throw', async () => {
      // Create a server first
      const config = createSSEConfig('Reset Test');
      await serverConfigsDB.add('temp', config, userId);

      // Reset should complete without error
      await expect(serverConfigsDB.reset()).resolves.toBeUndefined();

      // Server should still exist (reset is no-op for DB storage)
      const result = await serverConfigsDB.get('reset-test', userId);
      expect(result).toBeDefined();
    });
  });

  describe('mapDBServerToParsedConfig()', () => {
    it('should include dbId from _id', async () => {
      const config = createSSEConfig('Map Test');
      const created = await serverConfigsDB.add('temp', config, userId);

      expect(created.config.dbId).toBeDefined();
      expect(typeof created.config.dbId).toBe('string');
      expect(mongoose.Types.ObjectId.isValid(created.config.dbId!)).toBe(true);
    });

    it('should include updatedAt as timestamp', async () => {
      const config = createSSEConfig('Timestamp Test');
      const created = await serverConfigsDB.add('temp', config, userId);

      expect(created.config.updatedAt).toBeDefined();
      expect(typeof created.config.updatedAt).toBe('number');
      expect(created.config.updatedAt).toBeLessThanOrEqual(Date.now());
    });

    it('should strip admin-only OAuth audience fields from existing DB-backed user configs', async () => {
      const config = createSSEConfig('Legacy Audience Test', undefined, {
        client_id: 'public-client-id',
      });
      const created = await serverConfigsDB.add('temp', config, userId);

      await mongoose.models.MCPServer.updateOne(
        { serverName: created.serverName },
        {
          $set: {
            'config.oauth.audience': 'https://api.example.com',
            'config.oauth.forward_audience_on_refresh': false,
            'config.oauth.authorization_url':
              'https://auth.example.com/authorize?audience=https%3A%2F%2Fapi.example.com&client=ok',
            'config.oauth.token_url':
              'https://auth.example.com/token?resource=https%3A%2F%2Fapi.example.com&foo=bar',
          },
        },
      );

      const result = await serverConfigsDB.get(created.serverName, userId);
      expect(result?.oauth?.client_id).toBe('public-client-id');
      expect(result?.oauth?.authorization_url).toBe('https://auth.example.com/authorize?client=ok');
      expect(result?.oauth?.token_url).toBe('https://auth.example.com/token?foo=bar');
      expect(result?.oauth?.audience).toBeUndefined();
      expect(result?.oauth?.forward_audience_on_refresh).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle server with empty mcpServerNames in agent', async () => {
      const config = createSSEConfig('Edge Case Server');
      const created = await serverConfigsDB.add('temp', config, userId);

      // Create an agent with empty mcpServerNames
      const Agent = mongoose.models.Agent;
      const agent = await Agent.create({
        id: 'empty-mcp-agent',
        name: 'Empty MCP Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(userId),
        mcpServerNames: [], // Empty array
      });

      const agentRole = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: PermissionBits.VIEW,
        roleId: agentRole!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      // Should not find the server via agent (empty mcpServerNames)
      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeUndefined();
    });

    it('should handle agent without mcpServerNames field', async () => {
      const config = createSSEConfig('No Field Server');
      const created = await serverConfigsDB.add('temp', config, userId);

      // Create an agent without mcpServerNames field (uses default)
      const Agent = mongoose.models.Agent;
      const agent = await Agent.create({
        id: 'no-field-agent',
        name: 'No Field Agent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(userId),
        // mcpServerNames not specified - should default to []
      });

      const agentRole = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: PermissionBits.VIEW,
        roleId: agentRole!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      // Should not find the server via agent
      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeUndefined();
    });
  });

  describe('encryption/decryption error handling', () => {
    it('should return config without secret when decryption fails (graceful degradation)', async () => {
      // Create a server normally first
      const config = createSSEConfig('Decryption Failure Test', 'Test', {
        client_id: 'test-client',
        client_secret: 'test-secret',
      });
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Directly corrupt the encrypted secret in the database to simulate decryption failure
      const MCPServer = mongoose.models.MCPServer;
      await MCPServer.updateOne(
        { serverName: created.serverName },
        { $set: { 'config.oauth.client_secret': 'invalid:corrupted:encrypted:value' } },
      );

      // Get should return config without the secret (graceful degradation)
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('Decryption Failure Test');
      expect(retrieved?.oauth?.client_id).toBe('test-client');
      // Secret should be removed due to decryption failure
      expect(retrieved?.oauth?.client_secret).toBeUndefined();
    });

    it('should handle getAll with mixed valid and corrupted secrets', async () => {
      // Create servers with valid secrets
      const config1 = createSSEConfig('Valid Secret Server', 'Test', {
        client_id: 'client-1',
        client_secret: 'valid-secret',
      });
      const config2 = createSSEConfig('Corrupted Secret Server', 'Test', {
        client_id: 'client-2',
        client_secret: 'will-be-corrupted',
      });
      const created1 = await serverConfigsDB.add('temp1', config1, userId);
      const created2 = await serverConfigsDB.add('temp2', config2, userId);

      // Corrupt the second server's secret
      const MCPServer = mongoose.models.MCPServer;
      await MCPServer.updateOne(
        { serverName: created2.serverName },
        { $set: { 'config.oauth.client_secret': 'invalid:corrupted:data' } },
      );

      // GetAll should still return both servers
      const result = await serverConfigsDB.getAll(userId);

      expect(Object.keys(result)).toHaveLength(2);
      // First server should have decrypted secret
      expect(result[created1.serverName]?.oauth?.client_secret).toBe('valid-secret');
      // Second server should have secret removed due to decryption failure
      expect(result[created2.serverName]?.oauth?.client_id).toBe('client-2');
      expect(result[created2.serverName]?.oauth?.client_secret).toBeUndefined();
    });

    it('should return config without apiKey.key when decryption fails (graceful degradation)', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'API Key Decryption Failure Test',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'test-api-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      // Directly corrupt the encrypted key in the database to simulate decryption failure
      const MCPServer = mongoose.models.MCPServer;
      await MCPServer.updateOne(
        { serverName: created.serverName },
        { $set: { 'config.apiKey.key': 'invalid:corrupted:encrypted:value' } },
      );

      // Get should return config without the key (graceful degradation)
      const retrieved = await serverConfigsDB.get(created.serverName, userId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('API Key Decryption Failure Test');
      expect(retrieved?.apiKey?.source).toBe('admin');
      expect(retrieved?.apiKey?.authorization_type).toBe('bearer');
      // Key should be removed due to decryption failure
      expect(retrieved?.apiKey?.key).toBeUndefined();
    });
  });

  describe('DB layer returns decrypted secrets (redaction is at controller layer)', () => {
    it('should return decrypted apiKey.key to VIEW-only user via get()', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Secret API Key Server',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'admin-secret-api-key',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const role = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.MCPSERVER,
        resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
        permBits: PermissionBits.VIEW,
        roleId: role!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeDefined();
      expect(result?.apiKey?.key).toBe('admin-secret-api-key');
    });

    it('should return decrypted oauth.client_secret to VIEW-only user via get()', async () => {
      const config = createSSEConfig('Secret OAuth Server', 'Test', {
        client_id: 'my-client-id',
        client_secret: 'admin-oauth-secret',
      });
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const role = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.MCPSERVER,
        resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
        permBits: PermissionBits.VIEW,
        roleId: role!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      const result = await serverConfigsDB.get(created.serverName, userId2);
      expect(result).toBeDefined();
      expect(result?.oauth?.client_secret).toBe('admin-oauth-secret');
    });

    it('should return decrypted secrets to VIEW-only user via getAll()', async () => {
      const config: ParsedServerConfig = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: 'Shared Secret Server',
        apiKey: {
          source: 'admin',
          authorization_type: 'bearer',
          key: 'shared-api-key',
        },
        oauth: {
          client_id: 'shared-client',
          client_secret: 'shared-oauth-secret',
        },
      };
      const created = await serverConfigsDB.add('temp-name', config, userId);

      const role = await mongoose.models.AccessRole.findOne({
        accessRoleId: AccessRoleIds.MCPSERVER_VIEWER,
      });
      await mongoose.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalModel: PrincipalModel.USER,
        principalId: new mongoose.Types.ObjectId(userId2),
        resourceType: ResourceType.MCPSERVER,
        resourceId: new mongoose.Types.ObjectId(created.config.dbId!),
        permBits: PermissionBits.VIEW,
        roleId: role!._id,
        grantedBy: new mongoose.Types.ObjectId(userId),
      });

      const result = await serverConfigsDB.getAll(userId2);
      const serverConfig = result[created.serverName];
      expect(serverConfig).toBeDefined();
      expect(serverConfig?.apiKey?.key).toBe('shared-api-key');
      expect(serverConfig?.oauth?.client_secret).toBe('shared-oauth-secret');
    });
  });
});
