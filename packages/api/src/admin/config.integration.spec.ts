import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { SystemCapability } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type ConfigMethods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigHandlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;
type AdminConfigDeps = Parameters<typeof import('./config').createAdminConfigHandlers>[0];
type CapabilityCheck = AdminConfigDeps['hasConfigCapability'];

interface MockRes {
  statusCode: number;
  body: undefined | { config?: StoredConfig; error?: string; [key: string]: unknown };
  status: jest.Mock;
  json: jest.Mock;
}

interface StoredConfig {
  overrides: Record<string, unknown>;
  tombstones?: string[];
}

const ROLE = PrincipalType.ROLE;
const MARKER = '/tmp/attacker-controlled';

let mongoServer: MongoMemoryServer;
let methods: ConfigMethods;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;
let generateCapabilityCheck: typeof import('~/middleware/capabilities').generateCapabilityCheck;
let mergeConfigOverrides: DataSchemas['mergeConfigOverrides'];

function mockReq(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    productTracking: { enabled: true },
    user: { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

function mockRes(): Response & MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: MockRes['body']) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

/** Real handlers over the real Config collection, with the caller's capabilities decided by `hasConfigCapability`. */
function handlersFor(
  hasConfigCapability: CapabilityCheck,
  extra: Partial<AdminConfigDeps> = {},
): AdminConfigHandlers {
  return createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    ...extra,
  });
}

/** A caller holding only the listed `<verb>:configs:<section>` grants, never the broad ones. */
function scoped(grants: string[]): CapabilityCheck {
  return async (_user, section, verb = 'manage') =>
    section != null && grants.includes(`${verb}:${section}`);
}

async function readStored(principalId: string): Promise<StoredConfig | null> {
  const doc = await mongoose.models.Config.findOne({ principalType: ROLE, principalId }).lean();
  return doc as StoredConfig | null;
}

const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [dataSchemas, handlersModule, capabilitiesModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    import('~/middleware/capabilities'),
    MongoMemoryServer.create(),
  ]);
  mongoServer = server;
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  ({ mergeConfigOverrides } = dataSchemas);
  ({ createAdminConfigHandlers } = handlersModule);
  ({ generateCapabilityCheck } = capabilitiesModule);

  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = dataSchemas.createMethods(mongoose);
}, LIFECYCLE_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all([
    mongoose.models.Config.deleteMany({}),
    mongoose.models.SystemGrant.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

describe('admin config writes against a real Config collection', () => {
  describe('Langfuse state changed by the Base document lifecycle', () => {
    const connection = {
      enabled: true,
      publicKey: 'private-public-key',
      secretKey: 'private-secret-key',
      destination: 'private-destination',
      promptSync: { enabled: true },
    };
    const params = { principalType: ROLE, principalId: '__base__' };
    const disabledFacts = [
      [{ name: 'librechat.langfuse.connection.changed', configured: false, enabled: false }],
      [{ name: 'librechat.langfuse.promptSync.changed', enabled: false }],
    ];

    async function storeConnection(principalId = '__base__', isActive = true) {
      await mongoose.models.Config.create({
        principalType: ROLE,
        principalId,
        principalModel: PrincipalModel.ROLE,
        priority: 0,
        isActive,
        overrides: { langfuse: connection },
      });
    }

    it('records Base deactivation and reactivation once without exposing connection values', async () => {
      await storeConnection();
      const productTracker = jest.fn();
      const handlers = handlersFor(async () => true, { isLangfusePromptSyncAvailable: () => true });
      const res = mockRes();
      await handlers.toggleConfig(
        mockReq({ params, body: { isActive: false }, productTracker }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(await methods.findConfigByPrincipal(ROLE, '__base__')).toBeNull();
      expect(productTracker.mock.calls).toEqual(disabledFacts);

      await handlers.toggleConfig(
        mockReq({ params, body: { isActive: false }, productTracker }),
        mockRes(),
      );
      expect(productTracker).toHaveBeenCalledTimes(2);
      productTracker.mockClear();
      await handlers.toggleConfig(
        mockReq({ params, body: { isActive: true }, productTracker }),
        mockRes(),
      );
      expect(productTracker.mock.calls).toEqual([
        [{ name: 'librechat.langfuse.connection.changed', configured: true, enabled: true }],
        [{ name: 'librechat.langfuse.promptSync.changed', enabled: true }],
      ]);
      expect(JSON.stringify(productTracker.mock.calls)).not.toContain('private-');
    });

    it.each([true, false])('records only active Base deletion (active: %s)', async (isActive) => {
      await storeConnection('__base__', isActive);
      const productTracker = jest.fn();
      const res = mockRes();
      await handlersFor(async () => true, {
        isLangfusePromptSyncAvailable: () => true,
      }).deleteConfigOverrides(mockReq({ params, productTracker }), res);
      expect(res.statusCode).toBe(200);
      expect(
        await methods.findConfigByPrincipal(ROLE, '__base__', { includeInactive: true }),
      ).toBeNull();
      expect(productTracker.mock.calls).toEqual(isActive ? disabledFacts : []);
    });

    it.each([false, undefined])(
      'does not report prompt-sync transitions with availability %s',
      async (available) => {
        await storeConnection();
        const productTracker = jest.fn();
        const handlers = handlersFor(async () => true, {
          isLangfusePromptSyncAvailable: available === undefined ? undefined : () => available,
        });
        await handlers.toggleConfig(
          mockReq({ params, body: { isActive: false }, productTracker }),
          mockRes(),
        );
        await handlers.toggleConfig(
          mockReq({ params, body: { isActive: true }, productTracker }),
          mockRes(),
        );
        await handlers.deleteConfigOverrides(mockReq({ params, productTracker }), mockRes());
        expect(productTracker.mock.calls).toEqual([
          [{ name: 'librechat.langfuse.connection.changed', configured: false, enabled: false }],
          [{ name: 'librechat.langfuse.connection.changed', configured: true, enabled: true }],
          [{ name: 'librechat.langfuse.connection.changed', configured: false, enabled: false }],
        ]);
      },
    );

    it('reads availability when the request changes Base', async () => {
      await storeConnection();
      const productTracker = jest.fn();
      const isLangfusePromptSyncAvailable = jest.fn(() => false);
      const handlers = handlersFor(async () => true, { isLangfusePromptSyncAvailable });
      expect(isLangfusePromptSyncAvailable).not.toHaveBeenCalled();
      await handlers.toggleConfig(
        mockReq({ params, body: { isActive: false }, productTracker }),
        mockRes(),
      );
      expect(productTracker.mock.calls).toEqual([disabledFacts[0]]);
      productTracker.mockClear();
      isLangfusePromptSyncAvailable.mockReturnValue(true);
      await handlers.toggleConfig(
        mockReq({ params, body: { isActive: true }, productTracker }),
        mockRes(),
      );
      expect(productTracker.mock.calls).toEqual([
        [{ name: 'librechat.langfuse.connection.changed', configured: true, enabled: true }],
        [{ name: 'librechat.langfuse.promptSync.changed', enabled: true }],
      ]);
      expect(isLangfusePromptSyncAvailable).toHaveBeenCalledTimes(2);
    });

    it('does not report unrelated profiles, rejected requests, or missing Base documents', async () => {
      await storeConnection('editors');
      const productTracker = jest.fn();
      const handlers = handlersFor(async () => true, { isLangfusePromptSyncAvailable: () => true });
      const unrelated = { principalType: ROLE, principalId: 'editors' };
      await handlers.toggleConfig(
        mockReq({ params: unrelated, body: { isActive: false }, productTracker }),
        mockRes(),
      );
      await handlers.deleteConfigOverrides(
        mockReq({ params: unrelated, productTracker }),
        mockRes(),
      );
      const missing = mockRes();
      await handlers.deleteConfigOverrides(mockReq({ params, productTracker }), missing);
      expect(missing.statusCode).toBe(404);
      await storeConnection();
      const denied = mockRes();
      await handlersFor(async () => false, {
        isLangfusePromptSyncAvailable: () => true,
      }).toggleConfig(mockReq({ params, body: { isActive: false }, productTracker }), denied);
      expect(denied.statusCode).toBe(403);
      expect(productTracker).not.toHaveBeenCalled();
    });
  });

  describe('top-level sections outside configSchema', () => {
    it('stores nothing from a whole-document write that holds runtime state', async () => {
      const handlers = handlersFor(async () => true);
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params: { principalType: ROLE, principalId: 'editors' },
          body: { overrides: { paths: { uploads: MARKER }, registration: { enabled: false } } },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body?.issues).toEqual([
        { path: 'paths', segments: ['paths'], code: 'unknown_section' },
      ]);
      expect(await readStored('editors')).toBeNull();
    });

    it('stores nothing from a field write or tombstone under runtime state', async () => {
      const handlers = handlersFor(async () => true);
      const params = { principalType: ROLE, principalId: 'editors' };
      const patched = mockRes();
      const tombstoned = mockRes();

      await handlers.patchConfigField(
        mockReq({ params, body: { entries: [{ fieldPath: 'config.permissions', value: {} }] } }),
        patched,
      );
      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'paths' } }),
        tombstoned,
      );

      expect(patched.statusCode).toBe(400);
      expect(tombstoned.statusCode).toBe(400);
      expect(await readStored('editors')).toBeNull();
    });

    it('lets a document that already holds runtime state take unrelated writes, then removes it', async () => {
      /** Written straight through the data layer, as a server without the section check could. */
      await methods.patchConfigFields(
        ROLE,
        'legacy',
        PrincipalModel.ROLE,
        { 'paths.uploads': MARKER, 'registration.enabled': true },
        10,
      );
      await methods.tombstoneConfigField(ROLE, 'legacy', PrincipalModel.ROLE, 'config', 10);
      const stored = await readStored('legacy');
      expect(stored?.overrides.paths).toEqual({ uploads: MARKER });

      const merged = mergeConfigOverrides(
        { paths: { uploads: '/srv/uploads' }, config: { version: '1.3.0' } } as never,
        [stored as never],
      ) as unknown as Record<string, unknown>;
      expect(merged.paths).toEqual({ uploads: '/srv/uploads' });
      expect(merged.config).toEqual({ version: '1.3.0' });
      expect(merged.registration).toEqual({ enabled: true });

      const handlers = handlersFor(async () => true);
      const params = { principalType: ROLE, principalId: 'legacy' };
      const patched = mockRes();
      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'registration.enabled', value: false }] },
        }),
        patched,
      );
      expect(patched.statusCode).toBe(200);

      for (const fieldPath of ['paths', 'config']) {
        const removed = mockRes();
        await handlers.deleteConfigField(mockReq({ params, query: { fieldPath } }), removed);
        expect(removed.statusCode).toBe(200);
      }
      expect(await readStored('legacy')).toMatchObject({
        overrides: { registration: { enabled: false } },
        tombstones: [],
      });
      expect((await readStored('legacy'))?.overrides).not.toHaveProperty('paths');
    });
  });

  describe('fields the server derives', () => {
    const stale = { projectId: 'x', serviceKeyFile: 'http://169.254.169.254/latest' };
    const params = { principalType: ROLE, principalId: 'derived' };

    it('leaves them out of a whole-document write, a field write and a tombstone', async () => {
      const handlers = handlersFor(async () => true);
      const put = mockRes();
      await handlers.upsertConfigOverrides(
        mockReq({
          params,
          body: {
            overrides: {
              endpoints: { anthropic: { titleModel: 'claude-haiku-4-5', vertexConfig: stale } },
            },
          },
        }),
        put,
      );
      expect(put.statusCode).toBe(201);
      expect((await readStored('derived'))?.overrides).toEqual({
        endpoints: { anthropic: { titleModel: 'claude-haiku-4-5' } },
      });

      const patched = mockRes();
      await handlers.patchConfigField(
        mockReq({
          params,
          body: {
            entries: [
              { fieldPath: 'endpoints.anthropic.vertexConfig', value: stale },
              {
                fieldPath: 'endpoints.anthropic',
                value: { titleModel: 'claude-sonnet-4-6', vertexConfig: stale },
              },
              { fieldPath: 'endpoints.google', value: { vertexConfig: stale } },
            ],
          },
        }),
        patched,
      );
      expect(patched.statusCode).toBe(200);
      expect((await readStored('derived'))?.overrides).toEqual({
        endpoints: {
          anthropic: { titleModel: 'claude-sonnet-4-6' },
          google: { vertexConfig: stale },
        },
      });

      const tombstoned = mockRes();
      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'endpoints.anthropic.vertexConfig' } }),
        tombstoned,
      );
      expect(tombstoned.statusCode).toBe(200);
      expect((await readStored('derived'))?.tombstones ?? []).toEqual([]);
    });

    it('stores nothing from a whole-document write that holds only a derived field', async () => {
      const handlers = handlersFor(async () => true);
      const put = mockRes();
      await handlers.upsertConfigOverrides(
        mockReq({
          params,
          body: { overrides: { endpoints: { anthropic: { vertexConfig: stale } } } },
        }),
        put,
      );

      expect(put.statusCode).toBe(200);
      expect(put.body?.message).toBe('No actionable override sections provided');
      expect(await readStored('derived')).toBeNull();
    });
  });

  describe('write responses', () => {
    const params = { principalType: ROLE, principalId: 'editors' };

    /** A broad manager writes three sections (one with a secret) and a tombstone. */
    async function seed(): Promise<void> {
      const seeded = mockRes();
      await handlersFor(async () => true).upsertConfigOverrides(
        mockReq({
          params,
          body: {
            overrides: {
              endpoints: { agents: { disableBuilder: false } },
              memory: { charLimit: 500 },
              webSearch: { searchProvider: 'serper', serperApiKey: 'sk-serper-secret-value' },
            },
          },
        }),
        seeded,
      );
      expect(seeded.statusCode).toBe(201);
      const tombstoned = mockRes();
      await handlersFor(async () => true).tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'memory.tokenLimit' } }),
        tombstoned,
      );
      expect(tombstoned.statusCode).toBe(200);
    }

    it('show a section manager only the sections it wrote or can read', async () => {
      await seed();
      const writer = mockRes();
      await handlersFor(scoped(['manage:endpoints'])).patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        writer,
      );
      expect(writer.statusCode).toBe(200);
      expect(writer.body?.config?.overrides).toEqual({
        endpoints: { agents: { disableBuilder: true } },
      });
      expect(writer.body?.config?.tombstones).toEqual([]);

      const reader = mockRes();
      await handlersFor(scoped(['manage:endpoints', 'read:memory'])).tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'endpoints.bedrock' } }),
        reader,
      );
      expect(reader.statusCode).toBe(200);
      expect(Object.keys(reader.body?.config?.overrides ?? {}).sort()).toEqual([
        'endpoints',
        'memory',
      ]);
      expect(reader.body?.config?.tombstones).toEqual(['memory.tokenLimit', 'endpoints.bedrock']);
      expect(JSON.stringify([writer.body, reader.body])).not.toContain('serper');

      const remover = mockRes();
      await handlersFor(scoped(['manage:webSearch'])).deleteConfigField(
        mockReq({ params, query: { fieldPath: 'webSearch.searchProvider' } }),
        remover,
      );
      expect(remover.statusCode).toBe(200);
      expect(remover.body?.config?.overrides).toEqual({
        webSearch: { serperApiKeyPreview: '...alue' },
      });
      expect(remover.body?.config?.tombstones).toEqual([]);
      expect(JSON.stringify(remover.body)).not.toContain('v3:');
    });

    it('show a section manager holding real grants no more than a read shows it', async () => {
      await seed();
      const admin = handlersFor(async () => true);
      const otherField = mockRes();
      await admin.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.recursionLimit', value: 30 }] },
        }),
        otherField,
      );
      const otherTombstone = mockRes();
      await admin.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'endpoints.bedrock' } }),
        otherTombstone,
      );
      expect([otherField.statusCode, otherTombstone.statusCode]).toEqual([200, 200]);

      const userId = new mongoose.Types.ObjectId().toString();
      await methods.grantCapability({
        principalType: PrincipalType.USER,
        principalId: userId,
        capability: 'manage:configs:endpoints' as SystemCapability,
      });
      const grants = generateCapabilityCheck({
        getUserPrincipals: methods.getUserPrincipals,
        hasCapabilityForPrincipals: methods.hasCapabilityForPrincipals,
        hasAnyConfigReadAccess: methods.hasAnyConfigReadAccess,
        getHeldCapabilities: methods.getHeldCapabilities,
      });
      const manager = handlersFor(grants.hasConfigCapability, {
        hasCapability: grants.hasCapability,
        hasAnyConfigReadAccess: grants.hasAnyConfigReadAccess,
        getReadableConfigSections: grants.getReadableConfigSections,
      });
      const user = { id: userId, role: 'USER', _id: { toString: () => userId } };

      const written = mockRes();
      await manager.patchConfigField(
        mockReq({
          user,
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        written,
      );
      const read = mockRes();
      await manager.getConfig(mockReq({ user, params }), read);

      expect([written.statusCode, read.statusCode]).toEqual([200, 200]);
      expect(read.body?.config?.overrides).toEqual({
        endpoints: { agents: { disableBuilder: true, recursionLimit: 30 } },
      });
      expect(read.body?.config?.tombstones).toEqual(['endpoints.bedrock']);
      expect(written.body?.config?.overrides).toEqual(read.body?.config?.overrides);
      expect(written.body?.config?.tombstones).toEqual(read.body?.config?.tombstones);
    });

    it('store nothing when the read lookup fails, so a retry is never a second write', async () => {
      await seed();
      const before = await readStored('editors');
      const failing = handlersFor(scoped(['manage:endpoints', 'manage:memory']), {
        getReadableConfigSections: async () => {
          throw new Error('grant lookup down');
        },
      });

      const patched = mockRes();
      await failing.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        patched,
      );
      const tombstoned = mockRes();
      await failing.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'endpoints.bedrock' } }),
        tombstoned,
      );
      const removed = mockRes();
      await failing.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'memory.charLimit' } }),
        removed,
      );

      expect([patched.statusCode, tombstoned.statusCode, removed.statusCode]).toEqual([
        500, 500, 500,
      ]);
      expect(await readStored('editors')).toEqual(before);
    });

    it('show a broad manager the whole document with secrets redacted', async () => {
      await seed();
      const res = mockRes();
      await handlersFor(async () => true).patchConfigField(
        mockReq({ params, body: { entries: [{ fieldPath: 'memory.charLimit', value: 600 }] } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.body?.config?.overrides ?? {}).sort()).toEqual([
        'endpoints',
        'memory',
        'webSearch',
      ]);
      expect(res.body?.config?.overrides.webSearch).toEqual({
        searchProvider: 'serper',
        serperApiKeyPreview: '...alue',
      });
      expect(JSON.stringify(res.body)).not.toContain('sk-serper-secret-value');
    });
  });
});
