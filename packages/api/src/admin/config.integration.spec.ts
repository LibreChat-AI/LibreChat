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

beforeAll(async () => {
  jest.resetModules();
  const dataSchemas = await import('@librechat/data-schemas');
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  ({ mergeConfigOverrides } = dataSchemas);
  ({ createAdminConfigHandlers } = await import('./config'));
  ({ generateCapabilityCheck } = await import('~/middleware/capabilities'));

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  methods = dataSchemas.createMethods(mongoose);
});

afterEach(async () => {
  await Promise.all([
    mongoose.models.Config.deleteMany({}),
    mongoose.models.SystemGrant.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('admin config writes against a real Config collection', () => {
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
