import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigHandlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;
type AdminConfigDeps = Parameters<typeof import('./config').createAdminConfigHandlers>[0];

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

let mongoServer: MongoMemoryServer;
let methods: Methods;
let decryptV3: DataSchemas['decryptV3'];
let maxPathDepth: DataSchemas['MAX_CONFIG_PATH_DEPTH'];
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;

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

function createHandlers(overrides: Partial<AdminConfigDeps> = {}): AdminConfigHandlers {
  return createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    ...overrides,
  });
}

const raw = () => mongoose.connection.db!.collection('configs');

let counter = 0;
function nextParams(): { principalType: string; principalId: string } {
  counter += 1;
  return { principalType: 'role', principalId: `store-${counter}` };
}

async function call(
  handler: (req: ServerRequest, res: Response) => Promise<Response>,
  request: Record<string, unknown>,
): Promise<MockRes> {
  const res = mockRes();
  await handler(mockReq(request), res);
  return res;
}

const configOf = (res: MockRes) =>
  res.body?.config as {
    overrides: Record<string, unknown>;
    revision: string;
    tombstones: string[];
  };

/**
 * Booting mongod and importing data-schemas and the handlers (after `CREDS_KEY` is set) run in
 * parallel, and get a budget well past the 60s other suites use: on a saturated runner the
 * imports alone have exceeded it.
 */
const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [dataSchemas, handlersModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    MongoMemoryServer.create(),
  ]);
  mongoServer = server;
  ({ decryptV3, MAX_CONFIG_PATH_DEPTH: maxPathDepth } = dataSchemas);
  ({ createAdminConfigHandlers } = handlersModule);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);

  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = dataSchemas.createMethods(mongoose);
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, LIFECYCLE_TIMEOUT_MS);

describe('admin config handlers on the portable store (real Config collection)', () => {
  it('round-trips dotted record keys through PATCH and GET, stored raw where the engine accepts them', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    const profiles = {
      'us.anthropic.claude-sonnet-4-5': 'arn:aws:bedrock:us-east-1:1:inference-profile/x',
      'eu.meta.llama3-70b': 'arn:aws:bedrock:eu-west-1:1:inference-profile/y',
    };

    const patched = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'endpoints.bedrock.inferenceProfiles', value: profiles }] },
    });
    expect(patched.statusCode).toBe(200);

    const read = await call(handlers.getConfig, { params });
    expect(configOf(read).overrides).toEqual({
      endpoints: { bedrock: { inferenceProfiles: profiles } },
    });
    const stored = await raw().findOne({ principalId: params.principalId });
    expect(Object.keys(stored!.overrides.endpoints.bedrock.inferenceProfiles)).toEqual([
      'us.anthropic.claude-sonnet-4-5',
      'eu.meta.llama3-70b',
    ]);
    expect(stored!.keyEncoding).toBeUndefined();

    const [applied] = await methods.getApplicableConfigs([
      { principalType: 'role', principalId: params.principalId },
    ]);
    expect(applied.overrides).toEqual({ endpoints: { bedrock: { inferenceProfiles: profiles } } });
  });

  it('does not let a write planned on a stale read copy old ciphertext over a rotated secret', async () => {
    const params = nextParams();
    const handlers = createHandlers();
    await call(handlers.patchConfigField, {
      params,
      body: {
        entries: [
          {
            fieldPath: 'webSearch',
            value: { serperApiKey: 'sk-old-secret', searchProvider: 'serper' },
          },
        ],
      },
    });
    const beforeRotation = await methods.findConfigByPrincipal(
      'role' as never,
      params.principalId,
      {
        includeInactive: true,
      },
    );
    await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'webSearch.serperApiKey', value: 'sk-rotated-secret' }] },
    });

    /**
     * The stale admin's read of the profile happens before the rotation; its write lands after
     * it. Other reads (Base, the validation floor) go to the store.
     */
    let staleReads = 1;
    const findConfigByPrincipal = jest.fn<
      ReturnType<Methods['findConfigByPrincipal']>,
      Parameters<Methods['findConfigByPrincipal']>
    >(async (principalType, principalId, options) => {
      if (principalId === params.principalId && staleReads > 0) {
        staleReads -= 1;
        return beforeRotation;
      }
      return methods.findConfigByPrincipal(principalType, principalId, options);
    });
    const stale = createHandlers({ findConfigByPrincipal });
    const echoed = await call(stale.patchConfigField, {
      params,
      body: {
        entries: [
          { fieldPath: 'webSearch', value: { searchProvider: 'serper', scraperTimeout: 9000 } },
        ],
      },
    });

    expect(echoed.statusCode).toBe(200);
    expect(staleReads).toBe(0);
    expect(
      findConfigByPrincipal.mock.calls.filter(
        ([, principalId]) => principalId === params.principalId,
      ),
    ).toHaveLength(2);
    const stored = await raw().findOne({ principalId: params.principalId });
    expect(decryptV3(stored!.overrides.webSearch.serperApiKey)).toBe('sk-rotated-secret');
    expect(stored!.overrides.webSearch.scraperTimeout).toBe(9000);
  });

  it('honors a client revision, answering 409 with the current revision once it is stale', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    const created = await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: { interface: { customWelcome: 'v1' } }, expectedRevision: 'absent' },
    });
    expect(created.statusCode).toBe(201);
    const firstRevision = configOf(created).revision;

    const updated = await call(handlers.patchConfigField, {
      params,
      body: {
        entries: [{ fieldPath: 'interface.customWelcome', value: 'v2' }],
        expectedRevision: firstRevision,
      },
    });
    expect(updated.statusCode).toBe(200);
    const secondRevision = configOf(updated).revision;
    expect(secondRevision).not.toBe(firstRevision);

    const stale = await call(handlers.deleteConfigField, {
      params,
      query: { fieldPath: 'interface.customWelcome', expectedRevision: firstRevision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toEqual({
      error: 'Config was modified by another request',
      code: 'CONFIG_VERSION_CONFLICT',
      currentRevision: secondRevision,
    });

    const again = await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: {}, priority: 3, expectedRevision: 'absent' },
    });
    expect(again.statusCode).toBe(409);
    expect((await call(handlers.getConfig, { params })).body).toEqual(
      expect.objectContaining({ config: expect.objectContaining({ revision: secondRevision }) }),
    );
  });

  it('refuses a revision of a profile that was deleted and recreated (ABA)', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    const created = await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: { interface: { customWelcome: 'old' } } },
    });
    const oldRevision = configOf(created).revision;
    await call(handlers.deleteConfigOverrides, { params });
    await call(handlers.upsertConfigOverrides, {
      params,
      body: { overrides: { interface: { customWelcome: 'new' } } },
    });

    const res = await call(handlers.patchConfigField, {
      params,
      body: {
        entries: [{ fieldPath: 'interface.customWelcome', value: 'stale' }],
        expectedRevision: oldRevision,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(configOf(await call(handlers.getConfig, { params })).overrides).toEqual({
      interface: { customWelcome: 'new' },
    });
  });

  it('loses no update when unconditioned patches race', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'seed' }] },
    });

    /** Three attempts absorb two competing writers: each round, one of them commits. */
    const results = await Promise.all(
      ['modelSelect', 'parameters', 'presets'].map((field) =>
        call(handlers.patchConfigField, {
          params,
          body: { entries: [{ fieldPath: `interface.${field}`, value: false }] },
        }),
      ),
    );

    expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(configOf(await call(handlers.getConfig, { params })).overrides).toEqual({
      interface: { customWelcome: 'seed', modelSelect: false, parameters: false, presets: false },
    });
  });

  it('refuses an index past the end of a stored array instead of growing it', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    const capabilities = ['endpoints', 'agents', 'capabilities'];
    const seeded = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: capabilities.join('.'), value: ['tools'] }] },
    });
    expect(seeded.statusCode).toBe(200);

    const refused = await Promise.all([
      call(handlers.patchConfigField, {
        params,
        body: { entries: [{ fieldPath: `${capabilities.join('.')}.10000000`, value: 'tools' }] },
      }),
      call(handlers.patchConfigField, {
        params,
        body: { entries: [{ segments: [...capabilities, '4294967296'], value: 'tools' }] },
      }),
    ]);

    for (const res of refused) {
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Config path cannot be applied to the stored config',
        code: 'CONFIG_PATH_INVALID',
        reason: 'array_index',
      });
    }
    const appended = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: `${capabilities.join('.')}.1`, value: 'actions' }] },
    });
    expect(appended.statusCode).toBe(200);
    expect(configOf(appended).overrides).toEqual({
      endpoints: { agents: { capabilities: ['tools', 'actions'] } },
    });
    expect(configOf(appended).revision).toMatch(/:2$/);
  });

  it('prunes parents a reset empties and keeps tombstones beside them', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'mcpServers.docs.title', value: 'Docs' }] },
    });
    await call(handlers.tombstoneConfigField, { params, body: { fieldPath: 'mcpServers.github' } });

    const reset = await call(handlers.deleteConfigField, {
      params,
      query: { fieldPath: 'mcpServers.docs.title' },
    });

    expect(reset.statusCode).toBe(200);
    expect(configOf(reset).overrides).toEqual({});
    expect(configOf(reset).tombstones).toEqual(['mcpServers.github']);
  });

  it('clears a secret and its preview together in one version', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    const set = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'ocr.apiKey', value: 'sk-ocr-secret-value-123' }] },
    });
    const [, before] = configOf(set).revision.split(':');

    const cleared = await call(handlers.tombstoneConfigField, {
      params,
      body: { fieldPath: 'ocr.apiKey' },
    });

    const [, after] = configOf(cleared).revision.split(':');
    expect(Number(after)).toBe(Number(before) + 1);
    expect(configOf(cleared).overrides).toEqual({});
    expect(configOf(cleared).tombstones).toEqual(['ocr.apiKey', 'ocr.apiKeyPreview']);
  });

  it('lets an assign-only caller delete a legacy profile that holds only empty shells', async () => {
    const params = nextParams();
    await raw().insertOne({
      principalType: 'role',
      principalId: params.principalId,
      principalModel: 'Role',
      priority: 10,
      isActive: true,
      configVersion: 4,
      tombstones: [],
      overrides: { balance: {}, interface: {} },
    });
    const assignOnly = createHandlers({ hasConfigCapability: async () => false });

    const res = await call(assignOnly.deleteConfigOverrides, { params });

    expect(res.statusCode).toBe(200);
    expect(await raw().countDocuments({ principalId: params.principalId })).toBe(0);
  });

  it('reads a legacy document verbatim and keeps its keys raw on the next write', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    await raw().insertOne({
      principalType: 'role',
      principalId: params.principalId,
      principalModel: 'Role',
      priority: 10,
      isActive: true,
      tombstones: [],
      overrides: {
        endpoints: { azureOpenAI: { titleModel: 'gpt-4.1' } },
        fileConfig: { 'a.b': 1 },
      },
    });

    const read = await call(handlers.getConfig, { params });
    expect(configOf(read).overrides).toEqual({
      endpoints: { azureOpenAI: { titleModel: 'gpt-4.1' } },
      fileConfig: { 'a.b': 1 },
    });
    expect(configOf(read).revision).toMatch(/:0$/);

    await call(handlers.patchConfigField, {
      params,
      body: {
        entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }],
        expectedRevision: configOf(read).revision,
      },
    });

    const stored = await raw().findOne({ principalId: params.principalId });
    expect(stored!.keyEncoding).toBeUndefined();
    expect(stored!.overrides.fileConfig).toEqual({ 'a.b': 1 });
    expect(configOf(await call(handlers.getConfig, { params })).overrides).toEqual({
      endpoints: { azureOpenAI: { titleModel: 'gpt-4.1' } },
      fileConfig: { 'a.b': 1 },
      interface: { customWelcome: 'hi' },
    });
  });
});

describe('segment addressing on the field routes', () => {
  const profiles = ['endpoints', 'bedrock', 'inferenceProfiles'];
  const usProfile = [...profiles, 'us.anthropic.claude-sonnet-4-5'];

  it('sets and removes one dotted record key by its segments, keeping its siblings', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: profiles.join('.'), value: { 'eu.meta.llama': 'arn:eu' } }] },
    });

    const set = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ segments: usProfile, value: 'arn:us' }] },
    });

    expect(set.statusCode).toBe(200);
    expect(configOf(set).overrides).toEqual({
      endpoints: {
        bedrock: { inferenceProfiles: { 'eu.meta.llama': 'arn:eu', [usProfile[3]]: 'arn:us' } },
      },
    });
    const stored = await raw().findOne({ principalId: params.principalId });
    expect(Object.keys(stored!.overrides.endpoints.bedrock.inferenceProfiles)).toEqual([
      'eu.meta.llama',
      'us.anthropic.claude-sonnet-4-5',
    ]);

    const removed = await call(handlers.deleteConfigField, {
      params,
      query: {
        segments: JSON.stringify([...profiles, 'eu.meta.llama']),
        expectedRevision: configOf(set).revision,
      },
    });

    expect(removed.statusCode).toBe(200);
    expect(configOf(removed).overrides).toEqual({
      endpoints: { bedrock: { inferenceProfiles: { [usProfile[3]]: 'arn:us' } } },
    });
  });

  it('applies segment and fieldPath entries in request order', async () => {
    const handlers = createHandlers();
    const parentThenKey = nextParams();
    const keyThenParent = nextParams();
    const parent = { fieldPath: profiles.join('.'), value: { 'eu.x': 'a' } };
    const key = { segments: usProfile, value: 'b' };

    await call(handlers.patchConfigField, {
      params: parentThenKey,
      body: { entries: [parent, key] },
    });
    await call(handlers.patchConfigField, {
      params: keyThenParent,
      body: { entries: [key, parent] },
    });

    const profilesOf = async (params: { principalType: string; principalId: string }) =>
      (
        configOf(await call(handlers.getConfig, { params })).overrides as {
          endpoints: { bedrock: { inferenceProfiles: Record<string, string> } };
        }
      ).endpoints.bedrock.inferenceProfiles;
    expect(await profilesOf(parentThenKey)).toEqual({ 'eu.x': 'a', [usProfile[3]]: 'b' });
    expect(await profilesOf(keyThenParent)).toEqual({ 'eu.x': 'a' });
  });

  it('sends dot-free segments through the same secret pipeline as a fieldPath', async () => {
    const handlers = createHandlers();
    const params = nextParams();

    const res = await call(handlers.patchConfigField, {
      params,
      body: {
        entries: [{ segments: ['webSearch', 'serperApiKey'], value: 'sk-serper-0123456789' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const stored = await raw().findOne({ principalId: params.principalId });
    expect(decryptV3(stored!.overrides.webSearch.serperApiKey)).toBe('sk-serper-0123456789');
    expect(stored!.overrides.webSearch.serperApiKeyPreview).toBe('...6789');
    expect(JSON.stringify(res.body)).not.toContain('sk-serper-0123456789');

    const tombstoned = await call(handlers.tombstoneConfigField, {
      params,
      body: { segments: ['webSearch', 'serperApiKey'] },
    });
    expect(configOf(tombstoned).tombstones).toEqual([
      'webSearch.serperApiKey',
      'webSearch.serperApiKeyPreview',
    ]);
  });

  it.each([
    [
      'a tombstone naming a dotted key',
      'tombstoneConfigField',
      { body: { segments: usProfile } },
      'dotted_segment',
    ],
    [
      'a dotted key inside an MCP server',
      'patchConfigField',
      { body: { entries: [{ segments: ['mcpServers', 'docs', 'headers', 'X.Id'], value: 'v' }] } },
      'dotted_segment',
    ],
    [
      'a dotted key where a secret-bearing array item sits',
      'patchConfigField',
      { body: { entries: [{ segments: ['endpoints', 'custom', 'a.b'], value: { apiKey: 'k' } }] } },
      'dotted_segment',
    ],
    [
      'a dotted section',
      'patchConfigField',
      { body: { entries: [{ segments: ['interface.customWelcome'], value: 'x' }] } },
      'dotted_segment',
    ],
    [
      'a `$` key',
      'patchConfigField',
      { body: { entries: [{ segments: ['interface', '$set'], value: 'x' }] } },
      'unsafe_segment',
    ],
    [
      'segments that are not JSON in a query',
      'deleteConfigField',
      { query: { segments: 'interface.customWelcome' } },
      'empty_path',
    ],
  ] as const)('refuses %s and writes nothing', async (_label, handler, request, reason) => {
    const handlers = createHandlers();
    const params = nextParams();

    const res = await call(handlers[handler], { params, ...request });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: 'CONFIG_PATH_INVALID', reason }));
    expect(await raw().countDocuments({ principalId: params.principalId })).toBe(0);
  });

  it('caps a dotted fieldPath at the depth segments are capped at, on every field route', async () => {
    const handlers = createHandlers();
    const params = nextParams();
    const atLimit = ['interface', ...Array<string>(maxPathDepth - 1).fill('a')].join('.');
    const deep = ['interface', ...Array<string>(20_000).fill('a')].join('.');

    const refused = await Promise.all([
      call(handlers.patchConfigField, {
        params,
        body: { entries: [{ fieldPath: `${atLimit}.a`, value: 1 }] },
      }),
      call(handlers.patchConfigField, {
        params,
        body: { entries: [{ fieldPath: deep, value: 1 }] },
      }),
      call(handlers.tombstoneConfigField, { params, body: { fieldPath: deep } }),
      call(handlers.deleteConfigField, { params, query: { fieldPath: deep } }),
    ]);

    for (const res of refused) {
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Field path is too deep',
        code: 'CONFIG_PATH_INVALID',
        reason: 'too_deep',
      });
    }
    expect(await raw().countDocuments({ principalId: params.principalId })).toBe(0);

    const accepted = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: atLimit, value: 1 }] },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('refuses an entry naming both a fieldPath and segments, and duplicate segments', async () => {
    const handlers = createHandlers();
    const params = nextParams();

    const both = await call(handlers.patchConfigField, {
      params,
      body: { entries: [{ fieldPath: 'interface.customWelcome', segments: ['a'], value: 'x' }] },
    });
    const duplicate = await call(handlers.patchConfigField, {
      params,
      body: {
        entries: [
          { segments: usProfile, value: 'a' },
          { segments: usProfile, value: 'b' },
        ],
      },
    });

    expect(both.statusCode).toBe(400);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toEqual({
      error: 'Duplicate field path segments',
      code: 'DUPLICATE_FIELD_PATH',
    });
    expect(await raw().countDocuments({ principalId: params.principalId })).toBe(0);
  });

  it('checks section grants on the first segment', async () => {
    const endpointsOnly = createHandlers({
      hasConfigCapability: async (_user, section) => section === 'endpoints',
    });
    const params = nextParams();

    const allowed = await call(endpointsOnly.patchConfigField, {
      params,
      body: { entries: [{ segments: usProfile, value: 'arn:us' }] },
    });
    const denied = await call(endpointsOnly.patchConfigField, {
      params,
      body: {
        entries: [{ segments: ['fileConfig', 'endpoints', 'agents.v2', 'fileLimit'], value: 1 }],
      },
    });

    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
  });
});
