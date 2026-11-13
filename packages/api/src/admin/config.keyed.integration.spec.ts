import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { AppConfig, ConfigDraft } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type Methods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigDeps = Parameters<typeof import('./config').createAdminConfigHandlers>[0];
type Handlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;
type Doc = Record<string, unknown>;
type Endpoint = Record<string, unknown> & { name: string };

interface MockRes {
  statusCode: number;
  body: undefined | Doc;
  status: jest.Mock;
  json: jest.Mock;
}

let mongoServer: MongoMemoryServer;
let methods: Methods;
let dataSchemas: DataSchemas;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;
let createAppConfigService: typeof import('~/app/service').createAppConfigService;
let resolveCustomEndpointSecrets: typeof import('./secrets').resolveCustomEndpointSecrets;

const YAML_LITERAL_KEY = 'sk-yaml-literal-key-0123456789';

/** The deployment's librechat.yaml: two custom endpoints, each selected by a model spec. */
const YAML = {
  endpoints: {
    custom: [
      {
        name: 'My Endpoint',
        apiKey: '${MY_ENDPOINT_KEY}',
        baseURL: 'https://my.example.com/v1',
        models: { default: ['m'] },
        headers: { 'X-Team': 'yaml', 'X-Trace': 'on' },
      },
      {
        name: 'Literal',
        apiKey: YAML_LITERAL_KEY,
        baseURL: 'https://literal.example.com/v1',
        models: { default: ['m'] },
      },
      {
        name: 'Own Keys',
        apiKey: 'user_provided',
        baseURL: 'https://own-keys.example.com/v1',
        models: { default: ['m'] },
      },
    ],
  },
  modelSpecs: {
    list: [
      { name: 'mine', label: 'Mine', preset: { endpoint: 'My Endpoint', model: 'm' } },
      { name: 'literal', label: 'Literal', preset: { endpoint: 'Literal', model: 'm' } },
    ],
  },
};

const baseAppConfig = {
  config: YAML,
  endpoints: { custom: structuredClone(YAML.endpoints.custom) },
  modelSpecs: structuredClone(YAML.modelSpecs),
} as unknown as AppConfig;

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

function createDeps(overrides: Partial<AdminConfigDeps> = {}): AdminConfigDeps {
  return {
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: async () => baseAppConfig,
    invalidateConfigCaches: jest.fn(async () => undefined),
    recordAuditEntry: jest.fn(async () => undefined),
    overrideEnvAllowlist: 'MY_ENDPOINT_KEY',
    ...overrides,
  };
}

let handlers: Handlers;
let counter = 0;
function nextRole(): string {
  counter += 1;
  return `keyed-${counter}`;
}

const params = (principalId: string) => ({ principalType: 'role', principalId });

async function call(
  handler: keyof Handlers,
  principalId: string,
  init: { body?: Doc; query?: Doc },
  using: Handlers = handlers,
): Promise<MockRes> {
  const res = mockRes();
  await using[handler](mockReq({ params: params(principalId), ...init }), res);
  return res;
}

const tombstone = (principalId: string, fieldPath: string, using?: Handlers) =>
  call('tombstoneConfigField', principalId, { body: { fieldPath } }, using);
const remove = (principalId: string, fieldPath: string, using?: Handlers) =>
  call('deleteConfigField', principalId, { query: { fieldPath } }, using);
const patch = (principalId: string, body: Doc, using?: Handlers) =>
  call('patchConfigField', principalId, { body }, using);
const put = (principalId: string, body: Doc, using?: Handlers) =>
  call('upsertConfigOverrides', principalId, { body }, using);
const changes = (principalId: string, body: Doc, using?: Handlers) =>
  call('applyConfigChanges', principalId, { body }, using);

const raw = () => mongoose.connection.db!.collection('configs');
const storedDocument = (principalId: string) => raw().findOne({ principalId });

async function storedEndpoint(principalId: string, name: string): Promise<Endpoint | undefined> {
  const document = await storedDocument(principalId);
  return (document?.overrides?.endpoints?.custom as Endpoint[] | undefined)?.find(
    (entry) => entry.name === name,
  );
}

/** Stores a role document as is, past every API guard. */
async function seed(principalId: string, overrides: Doc, tombstones: string[] = []) {
  const draft: ConfigDraft = {
    principalModel: PrincipalModel.ROLE,
    priority: 10,
    isActive: true,
    overrides: overrides as ConfigDraft['overrides'],
    tombstones,
  };
  await methods.writeConfigDocument(PrincipalType.ROLE, principalId, draft, 'absent');
}

/** The effective config a principal of `role` is served, through the real config service. */
async function servedConfig(role: string, base: AppConfig = baseAppConfig): Promise<AppConfig> {
  const entries = new Map<string, unknown>();
  const { getAppConfig } = createAppConfigService({
    loadBaseConfig: async () => structuredClone(base),
    setCachedTools: async () => undefined,
    getCache: () => ({
      get: async (key: string) => entries.get(key),
      set: async (key: string, value: unknown) => entries.set(key, value),
      delete: async (key: string) => entries.delete(key),
    }),
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs: (principals) => methods.getApplicableConfigs(principals),
    getUserPrincipals: async () => [],
    overrideEnvAllowlist: 'MY_ENDPOINT_KEY',
  });
  return getAppConfig({ role });
}

const servedNames = (config: AppConfig) =>
  (config.endpoints?.custom ?? []).map((entry) => (entry as Endpoint).name);
const specNames = (config: AppConfig) => (config.modelSpecs?.list ?? []).map((spec) => spec.name);

const endpoint = (name: string, extra: Doc = {}): Endpoint => ({
  name,
  baseURL: `https://${name.replace(/[^a-z0-9]/gi, '-')}.example.com/v1`,
  models: { default: ['m'] },
  ...extra,
});

const LIFECYCLE_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  const [schemas, handlersModule, serviceModule, secretsModule, server] = await Promise.all([
    import('@librechat/data-schemas'),
    import('./config'),
    import('~/app/service'),
    import('./secrets'),
    MongoMemoryServer.create(),
  ]);
  dataSchemas = schemas;
  mongoServer = server;
  ({ createAdminConfigHandlers } = handlersModule);
  ({ createAppConfigService } = serviceModule);
  ({ resolveCustomEndpointSecrets } = secretsModule);
  jest.spyOn(schemas.logger, 'error').mockReturnValue(schemas.logger);
  jest.spyOn(schemas.logger, 'warn').mockReturnValue(schemas.logger);
  jest.spyOn(schemas.logger, 'info').mockReturnValue(schemas.logger);

  await mongoose.connect(mongoServer.getUri());
  schemas.createModels(mongoose);
  await mongoose.models.Config.init();
  methods = schemas.createMethods(mongoose);
  handlers = createAdminConfigHandlers(createDeps());
}, LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, LIFECYCLE_TIMEOUT_MS);

describe('hiding librechat.yaml custom endpoints by key', () => {
  it('a tombstone hides the endpoint and the model specs that select it, for that profile only', async () => {
    const hidden = nextRole();
    const other = nextRole();
    await seed(other, { interface: { customWelcome: 'hi' } });

    const res = await tombstone(hidden, 'endpoints.custom["My Endpoint"]');

    expect(res.statusCode).toBe(200);
    expect((await storedDocument(hidden))?.tombstones).toEqual(['endpoints.custom["My Endpoint"]']);
    const served = await servedConfig(hidden);
    expect(servedNames(served)).toEqual(['Literal', 'Own Keys']);
    expect(specNames(served)).toEqual(['literal']);
    const unaffected = await servedConfig(other);
    expect(servedNames(unaffected)).toEqual(['My Endpoint', 'Literal', 'Own Keys']);
    expect(specNames(unaffected)).toEqual(['mine', 'literal']);
  });

  it('a profile that adds a hidden endpoint back keeps its model specs', async () => {
    const role = nextRole();
    await seed(role, {}, ['endpoints.custom["My Endpoint"]']);
    expect(specNames(await servedConfig(role))).toEqual(['literal']);

    const readd = await changes(role, {
      ops: [
        {
          op: 'upsertEntry',
          fieldPath: 'endpoints.custom',
          entry: endpoint('My Endpoint', { apiKey: '${MY_ENDPOINT_KEY}' }),
        },
      ],
    });

    expect(readd.statusCode).toBe(200);
    expect((await storedDocument(role))?.tombstones).toEqual([]);
    expect(specNames(await servedConfig(role))).toEqual(['mine', 'literal']);
  });

  it('hides the model specs of an endpoint a Base profile defines, as of a librechat.yaml one', async () => {
    const role = nextRole();
    const base = dataSchemas.BASE_CONFIG_PRINCIPAL_ID;
    const spec = (name: string, endpointName: string) => ({
      name,
      label: name,
      preset: { endpoint: endpointName, model: 'm' },
    });
    const written = await changes(base, {
      ops: [
        { op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: endpoint('Team') },
        {
          op: 'set',
          fieldPath: 'modelSpecs.list',
          value: [spec('team', 'Team'), spec('mine', 'My Endpoint'), spec('literal', 'Literal')],
        },
      ],
    });
    expect(written.statusCode).toBe(200);
    try {
      for (const path of ['endpoints.custom["Team"]', 'endpoints.custom["My Endpoint"]']) {
        expect((await tombstone(role, path)).statusCode).toBe(200);
      }

      const served = await servedConfig(role);
      expect(servedNames(served)).toEqual(['Literal', 'Own Keys']);
      expect(specNames(served)).toEqual(['literal']);
      expect(specNames(await servedConfig(nextRole()))).toEqual(['team', 'mine', 'literal']);
    } finally {
      await methods.deleteConfig(PrincipalType.ROLE, base);
    }
  });

  it('a stored bracket tombstone, a silent no-op before, now takes effect at merge', async () => {
    const role = nextRole();
    await seed(role, {}, ['endpoints.custom["Literal"]']);

    expect(servedNames(await servedConfig(role))).toEqual(['My Endpoint', 'Own Keys']);
  });

  describe('the endpoint lists a hidden endpoint is named in', () => {
    const spec = (name: string, endpointName: string) => ({
      name,
      label: name,
      preset: { endpoint: endpointName, model: 'm' },
    });
    /** The base config with these model specs and agent providers, as librechat.yaml loads them. */
    const baseWith = (
      modelSpecs: { list: ReturnType<typeof spec>[]; addedEndpoints?: string[] },
      allowedProviders?: string[],
    ) =>
      ({
        ...structuredClone(baseAppConfig),
        endpoints: {
          custom: structuredClone(YAML.endpoints.custom),
          ...(allowedProviders && { agents: { allowedProviders } }),
        },
        modelSpecs,
      }) as unknown as AppConfig;

    it('keeps the unrelated added endpoints when the hidden endpoint owned every spec', async () => {
      const role = nextRole();
      await seed(role, {}, ['endpoints.custom["My Endpoint"]']);
      const base = baseWith({
        list: [spec('mine', 'My Endpoint')],
        addedEndpoints: ['agents', 'My Endpoint', 'Literal'],
      });

      const served = await servedConfig(role, base);

      expect(served.modelSpecs?.list).toEqual([]);
      expect(served.modelSpecs?.addedEndpoints).toEqual(['agents', 'Literal']);
      expect((await servedConfig(nextRole(), base)).modelSpecs).toEqual(base.modelSpecs);
    });

    it('takes the hidden endpoint out of the agent provider allow-list', async () => {
      const role = nextRole();
      await seed(role, {}, ['endpoints.custom["My Endpoint"]']);
      const base = baseWith({ list: [] }, ['My Endpoint', 'openAI', 'Literal']);

      const served = await servedConfig(role, base);

      expect(served.endpoints?.agents?.allowedProviders).toEqual(['openAI', 'Literal']);
      expect((await servedConfig(nextRole(), base)).endpoints?.agents?.allowedProviders).toEqual([
        'My Endpoint',
        'openAI',
        'Literal',
      ]);
    });

    it('never empties an allow-list, which would allow every endpoint', async () => {
      const role = nextRole();
      await seed(role, {}, ['endpoints.custom["My Endpoint"]']);
      const base = baseWith(
        { list: [spec('literal', 'Literal')], addedEndpoints: ['My Endpoint'] },
        ['My Endpoint'],
      );

      const served = await servedConfig(role, base);

      expect(servedNames(served)).toEqual(['Literal', 'Own Keys']);
      expect(specNames(served)).toEqual(['literal']);
      expect(served.modelSpecs?.addedEndpoints).toEqual(['My Endpoint']);
      expect(served.endpoints?.agents?.allowedProviders).toEqual(['My Endpoint']);
    });
  });

  it('DELETE of the keyed path shows the endpoint again', async () => {
    const role = nextRole();
    await tombstone(role, 'endpoints.custom["My Endpoint"]');

    const res = await remove(role, 'endpoints.custom["My Endpoint"]');

    expect(res.statusCode).toBe(200);
    expect(res.body?.applied).toEqual([
      {
        path: 'endpoints.custom["My Endpoint"]',
        segments: ['endpoints', 'custom'],
        key: 'My Endpoint',
      },
    ]);
    expect((await storedDocument(role))?.tombstones).toEqual([]);
    expect(servedNames(await servedConfig(role))).toEqual(['My Endpoint', 'Literal', 'Own Keys']);
  });
});

describe('writes by segments that spell a keyed path', () => {
  it('a PATCH or set by such segments keeps the hide of the entry and the hides inside it', async () => {
    const role = nextRole();
    const hides = ['endpoints.custom["Literal"]', 'endpoints.custom["My Endpoint"].headers.X-Team'];
    for (const path of hides) {
      expect((await tombstone(role, path)).statusCode).toBe(200);
    }

    const responses = [
      await patch(role, {
        entries: [{ segments: ['endpoints', 'custom["Literal"]'], value: { titleModel: 'x' } }],
      }),
      await changes(role, {
        ops: [
          {
            op: 'set',
            segments: ['endpoints', 'custom["My Endpoint"]', 'headers', 'X-Team'],
            value: 'role',
          },
        ],
      }),
    ];

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }
    expect((await storedDocument(role))?.tombstones).toEqual(hides);
    const served = await servedConfig(role);
    expect(servedNames(served)).toEqual(['My Endpoint', 'Own Keys']);
    const mine = (served.endpoints?.custom ?? []).find(
      (entry) => (entry as Endpoint).name === 'My Endpoint',
    );
    expect(mine?.headers).toEqual({ 'X-Trace': 'on' });
  });
});

describe('removing an inherited key of a custom endpoint record', () => {
  const headersOf = async (role: string) =>
    ((await servedConfig(role)).endpoints?.custom ?? []).find(
      (entry) => (entry as Endpoint).name === 'My Endpoint',
    )?.headers;

  it('hides one header, keeps its siblings and the profile own edits, and DELETE restores it', async () => {
    const role = nextRole();
    const hidden = await tombstone(role, 'endpoints.custom["My Endpoint"].headers.X-Team');
    expect(hidden.statusCode).toBe(200);
    expect(hidden.body?.applied).toEqual([
      {
        path: 'endpoints.custom["My Endpoint"].headers.X-Team',
        segments: ['endpoints', 'custom'],
        key: 'My Endpoint',
        entryPath: ['headers', 'X-Team'],
      },
    ]);
    expect(hidden.body?.skipped).toEqual([]);
    expect(await headersOf(role)).toEqual({ 'X-Trace': 'on' });

    const edited = await changes(role, {
      ops: [
        {
          op: 'upsertEntry',
          fieldPath: 'endpoints.custom',
          entry: { name: 'My Endpoint', headers: { 'X-Own': 'role' } },
        },
      ],
    });
    expect(edited.statusCode).toBe(200);
    expect((await storedDocument(role))?.tombstones).toEqual([
      'endpoints.custom["My Endpoint"].headers.X-Team',
    ]);
    expect(await headersOf(role)).toEqual({ 'X-Trace': 'on', 'X-Own': 'role' });

    const restored = await remove(role, 'endpoints.custom["My Endpoint"].headers.X-Team');
    expect(restored.statusCode).toBe(200);
    expect(await headersOf(role)).toEqual({ 'X-Team': 'yaml', 'X-Trace': 'on', 'X-Own': 'role' });
  });

  it('DELETE of the whole record resets the profile keys and the key tombstones under it', async () => {
    const role = nextRole();
    await seed(
      role,
      { endpoints: { custom: [{ name: 'My Endpoint', headers: { 'X-Own': 'r' } }] } },
      [
        'endpoints.custom["My Endpoint"].headers.X-Team',
        'endpoints.custom["My Endpoint"].headers.X-Trace',
        'endpoints.custom["Literal"]',
      ],
    );

    const res = await remove(role, 'endpoints.custom["My Endpoint"].headers');

    expect(res.statusCode).toBe(200);
    const document = await storedDocument(role);
    expect(document?.overrides).toEqual({});
    expect(document?.tombstones).toEqual(['endpoints.custom["Literal"]']);
    expect(await headersOf(role)).toEqual({ 'X-Team': 'yaml', 'X-Trace': 'on' });

    const collection = await remove(role, 'endpoints.custom');
    expect(collection.statusCode).toBe(200);
    expect((await storedDocument(role))?.tombstones).toEqual([]);
  });
});

describe('keyed paths the API refuses', () => {
  const refusals: Array<[string, Doc]> = [
    ['endpoints.custom["My Endpoint"', { code: 'CONFIG_PATH_INVALID', reason: 'keyed_path' }],
    ['modelSpecs.list["mine"]', { code: 'CONFIG_PATH_INVALID', reason: 'keyed_path' }],
    ['endpoints.custom["__proto__"]', { code: 'CONFIG_PATH_INVALID', reason: 'keyed_path' }],
    ['endpoints.custom["My Endpoint"].name', { code: 'CONFIG_PATH_INVALID', reason: 'merge_key' }],
    ['endpoints.custom["My Endpoint"].apiKey', { code: 'SECRET_PATH' }],
    ['endpoints.custom["My Endpoint"].apiKeyPreview', { code: 'SECRET_PATH' }],
    ['endpoints.custom["My Endpoint"].apiKeyBinding', { code: 'SECRET_PATH' }],
  ];

  it.each(refusals)(
    'refuses %s on every route that hides or resets, storing nothing',
    async (path, expected) => {
      const role = nextRole();
      const responses = [
        await tombstone(role, path),
        await remove(role, path),
        await changes(role, { ops: [{ op: 'tombstone', fieldPath: path }] }),
        await changes(role, { ops: [{ op: 'unset', fieldPath: path }] }),
      ];
      for (const res of responses) {
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject(expected);
        expect(JSON.stringify(res.body)).not.toContain('My Endpoint');
      }
      expect(await storedDocument(role)).toBeNull();
    },
  );

  it('refuses a tombstone into an array of the entry, or into a collection by position', async () => {
    const role = nextRole();
    for (const path of [
      'endpoints.custom["My Endpoint"].models.default.0',
      'endpoints.custom.0.headers',
      'endpoints.custom.1',
    ]) {
      for (const res of [
        await tombstone(role, path),
        await changes(role, { ops: [{ op: 'tombstone', fieldPath: path }] }),
      ]) {
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ code: 'CONFIG_PATH_INVALID', reason: 'inside_array' });
      }
    }
    expect(await storedDocument(role)).toBeNull();
  });

  it('refuses a tombstone whose segments a later read would take for a keyed path', async () => {
    const role = nextRole();
    const segments = ['endpoints', 'custom["Literal"]'];
    for (const res of [
      await call('tombstoneConfigField', role, { body: { segments } }),
      await changes(role, { ops: [{ op: 'tombstone', segments }] }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'CONFIG_PATH_INVALID', reason: 'keyed_path' });
    }
    expect(await storedDocument(role)).toBeNull();
  });

  it('refuses a keyed path in a write: PATCH, set, and the collection of an entry op', async () => {
    const role = nextRole();
    const path = 'endpoints.custom["My Endpoint"].titleModel';
    const responses = [
      await patch(role, { entries: [{ fieldPath: path, value: 'x' }] }),
      await changes(role, { ops: [{ op: 'set', fieldPath: path, value: 'x' }] }),
      await changes(role, {
        ops: [{ op: 'upsertEntry', fieldPath: path, entry: endpoint('x') }],
      }),
      await changes(role, { ops: [{ op: 'removeEntry', fieldPath: path, key: 'x' }] }),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'CONFIG_PATH_INVALID', reason: 'keyed_path' });
    }
    expect(await storedDocument(role)).toBeNull();
  });
});

describe('keyed changes in a batch', () => {
  it('hides an endpoint and removes a header of another in one write, named by key', async () => {
    const role = nextRole();
    const recordAuditEntry = jest.fn(async () => undefined);
    const audited = createAdminConfigHandlers(createDeps({ recordAuditEntry }));

    const res = await changes(
      role,
      {
        ops: [
          { op: 'tombstone', fieldPath: 'endpoints.custom["Literal"]' },
          {
            op: 'upsertEntry',
            fieldPath: 'endpoints.custom',
            entry: endpoint('gw', { headers: { A: 'a' } }),
          },
          { op: 'tombstone', fieldPath: 'endpoints.custom["gw"].headers.A' },
          { op: 'unset', fieldPath: 'endpoints.custom["absent"]' },
        ],
      },
      audited,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      written: true,
      applied: [
        { opIndex: 0, op: 'tombstone', segments: ['endpoints', 'custom'], key: 'Literal' },
        { opIndex: 1, op: 'upsertEntry', segments: ['endpoints', 'custom'], key: 'gw' },
        {
          opIndex: 2,
          op: 'tombstone',
          segments: ['endpoints', 'custom'],
          key: 'gw',
          entryPath: ['headers', 'A'],
        },
      ],
      unchanged: [{ opIndex: 3, op: 'unset', segments: ['endpoints', 'custom'], key: 'absent' }],
    });
    const document = await storedDocument(role);
    expect(document?.overrides).toEqual({ endpoints: { custom: [endpoint('gw')] } });
    expect(document?.tombstones).toEqual([
      'endpoints.custom["Literal"]',
      'endpoints.custom["gw"].headers.A',
    ]);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          tombstone: 'endpoints.custom["Literal"],endpoints.custom["gw"].headers.A',
        }),
      }),
    );
  });

  it('refuses two changes of one whole entry, by the key the merge folds it to', async () => {
    const role = nextRole();
    const res = await changes(role, {
      ops: [
        { op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: endpoint('Ollama') },
        { op: 'tombstone', fieldPath: 'endpoints.custom["ollama"]' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'DUPLICATE_FIELD_PATH', opIndex: 1 });
  });

  it('a dry run reports a keyed hide without writing it', async () => {
    const role = nextRole();
    const res = await changes(role, {
      dryRun: true,
      ops: [{ op: 'tombstone', fieldPath: 'endpoints.custom["Literal"].headers' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ written: false, dryRun: true });
    expect(await storedDocument(role)).toBeNull();
  });
});

describe('stored keys of entries a profile hides or renames', () => {
  async function storeOwnKey(role: string, name: string, extra: Doc = {}): Promise<Endpoint> {
    const res = await changes(role, {
      ops: [
        {
          op: 'upsertEntry',
          fieldPath: 'endpoints.custom',
          entry: endpoint(name, { apiKey: 'sk-profile-own-key-0123456789', ...extra }),
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const stored = await storedEndpoint(role, name);
    expect(String(stored?.apiKey)).toMatch(/^v3:/);
    return stored as Endpoint;
  }

  it('hiding a profile own endpoint removes its stored key; showing it again does not bring it back', async () => {
    const role = nextRole();
    await storeOwnKey(role, 'gw');

    expect((await tombstone(role, 'endpoints.custom["gw"]')).statusCode).toBe(200);
    expect(await storedEndpoint(role, 'gw')).toBeUndefined();

    expect((await remove(role, 'endpoints.custom["gw"]')).statusCode).toBe(200);
    const readded = await changes(role, {
      ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: endpoint('gw') }],
    });
    expect(readded.statusCode).toBe(200);
    expect((await storedEndpoint(role, 'gw'))?.apiKey).toBeUndefined();
  });

  it('a keyed reset or hide of the base URL beside a stored key needs the key entered again', async () => {
    const role = nextRole();
    const before = await storeOwnKey(role, 'gw');

    for (const res of [
      await remove(role, 'endpoints.custom["gw"].baseURL'),
      await tombstone(role, 'endpoints.custom["gw"].baseURL'),
      await changes(role, { ops: [{ op: 'unset', fieldPath: 'endpoints.custom["gw"].baseURL' }] }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'CONFIG_SECRET_REENTRY_REQUIRED',
        issues: [expect.objectContaining({ secretPath: 'endpoints.custom.0.apiKey' })],
      });
    }
    expect(await storedEndpoint(role, 'gw')).toEqual(before);

    const header = await remove(role, 'endpoints.custom["gw"].headers');
    expect(header.statusCode).toBe(200);
  });

  it('a DELETE by segments removes the key a segment holds as written, never a field of an entry', async () => {
    const role = nextRole();
    const base = dataSchemas.BASE_CONFIG_PRINCIPAL_ID;
    const team = endpoint('Team', { apiKey: 'sk-base-team-key-0123456789' });
    const inherited = await changes(base, {
      ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: team }],
    });
    expect(inherited.statusCode).toBe(200);
    try {
      const own = await storeOwnKey(role, 'gw');
      const entered = await changes(role, {
        ops: [
          {
            op: 'upsertEntry',
            fieldPath: 'endpoints.custom',
            entry: { name: 'Team', apiKey: 'sk-role-own-team-key-0123456789' },
          },
        ],
      });
      expect(entered.statusCode).toBe(200);
      const bound = await storedEndpoint(role, 'Team');
      expect(bound?.apiKeyBinding).toEqual(expect.any(String));
      await raw().updateOne(
        { principalId: role },
        { $set: { 'overrides.endpoints.custom["gw"]': { baseURL: 'https://junk.example.com' } } },
      );

      for (const [name, field] of [
        ['gw', 'baseURL'],
        ['gw', 'name'],
        ['Team', 'apiKeyBinding'],
      ]) {
        const segment = `custom[${JSON.stringify(name)}]`;
        const res = await call('deleteConfigField', role, {
          query: { segments: JSON.stringify(['endpoints', segment, field]) },
        });
        expect(res.statusCode).toBe(200);
        expect(await storedEndpoint(role, 'gw')).toEqual(own);
        expect(await storedEndpoint(role, 'Team')).toEqual(bound);
      }
      const endpoints = (await storedDocument(role))?.overrides?.endpoints as Doc;
      expect(Object.keys(endpoints)).toEqual(['custom']);
    } finally {
      await methods.deleteConfig(PrincipalType.ROLE, base);
    }
  });

  it('a keyed hide of an inherited destination drops the inherited key and reports it', async () => {
    const role = nextRole();

    const res = await tombstone(role, 'endpoints.custom["Literal"].baseURL');

    expect(res.statusCode).toBe(200);
    expect(res.body?.ignored).toEqual([
      {
        path: 'endpoints.custom["Literal"].apiKey',
        segments: ['endpoints', 'custom', 'Literal', 'apiKey'],
        reason: 'secret_rebinding',
      },
    ]);
    const literal = ((await servedConfig(role)).endpoints?.custom ?? []).find(
      (entry) => (entry as Endpoint).name === 'Literal',
    );
    expect(literal?.apiKey ?? '').toBe('');
  });

  it('a keyed hide of the destination users send their own keys to is set back and reported', async () => {
    const role = nextRole();

    const res = await tombstone(role, 'endpoints.custom["Own Keys"].baseURL');

    expect(res.statusCode).toBe(200);
    expect(res.body?.ignored).toEqual([
      {
        path: 'endpoints.custom["Own Keys"].baseURL',
        segments: ['endpoints', 'custom', 'Own Keys', 'baseURL'],
        reason: 'secret_rebinding',
      },
    ]);
    const ownKeys = ((await servedConfig(role)).endpoints?.custom ?? []).find(
      (entry) => (entry as Endpoint).name === 'Own Keys',
    );
    expect(ownKeys?.baseURL).toBe('https://own-keys.example.com/v1');
  });

  describe('a rename hint', () => {
    async function seedDraft(role: string): Promise<Endpoint> {
      const draft = await storeOwnKey(role, 'draft');
      expect((await tombstone(role, 'endpoints.custom["draft"].headers.X-Legacy')).statusCode).toBe(
        200,
      );
      return draft;
    }
    const renamed = (draft: Endpoint, extra: Doc = {}) => ({
      ...endpoint('final'),
      baseURL: draft.baseURL,
      ...extra,
    });
    const hint = [{ path: 'endpoints.custom', previousName: 'draft', name: 'final' }];

    it('on PATCH carries the stored key to the renamed entry and moves its keyed tombstones', async () => {
      const role = nextRole();
      const draft = await seedDraft(role);

      const res = await patch(role, {
        entries: [{ fieldPath: 'endpoints.custom', value: [renamed(draft)] }],
        renames: hint,
      });

      expect(res.statusCode).toBe(200);
      const final = await storedEndpoint(role, 'final');
      expect(final?.apiKey).toBe(draft.apiKey);
      expect(final?.apiKeyPreview).toBe(draft.apiKeyPreview);
      expect(await storedEndpoint(role, 'draft')).toBeUndefined();
      expect((await storedDocument(role))?.tombstones).toEqual([
        'endpoints.custom["final"].headers.X-Legacy',
      ]);
      const served = ((await servedConfig(role)).endpoints?.custom ?? []).find(
        (entry) => (entry as Endpoint).name === 'final',
      );
      expect(served && resolveCustomEndpointSecrets(served).apiKey).toBe(
        'sk-profile-own-key-0123456789',
      );
    });

    it('on a PATCH that also resets a path, does the same', async () => {
      const role = nextRole();
      const draft = await seedDraft(role);

      const res = await patch(role, {
        entries: [
          { fieldPath: 'interface', value: { prompts: false } },
          { fieldPath: 'endpoints.custom', value: [renamed(draft)] },
        ],
        renames: hint,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body?.skipped).toEqual([
        {
          path: 'interface.prompts',
          segments: ['interface', 'prompts'],
          reason: 'interface_permission',
        },
      ]);
      expect((await storedEndpoint(role, 'final'))?.apiKey).toBe(draft.apiKey);
      expect((await storedDocument(role))?.tombstones).toEqual([
        'endpoints.custom["final"].headers.X-Legacy',
      ]);
    });

    it('on PUT does the same for a whole replace', async () => {
      const role = nextRole();
      const draft = await seedDraft(role);

      const res = await put(role, {
        overrides: { endpoints: { custom: [renamed(draft)] } },
        renames: hint,
      });

      expect(res.statusCode).toBe(200);
      expect((await storedEndpoint(role, 'final'))?.apiKey).toBe(draft.apiKey);
      expect((await storedDocument(role))?.tombstones).toEqual([
        'endpoints.custom["final"].headers.X-Legacy',
      ]);
    });

    it('without a hint, the renamed entry keeps no key and the tombstones stay on the old name', async () => {
      const role = nextRole();
      const draft = await seedDraft(role);

      const res = await patch(role, {
        entries: [{ fieldPath: 'endpoints.custom', value: [renamed(draft)] }],
      });

      expect(res.statusCode).toBe(200);
      expect((await storedEndpoint(role, 'final'))?.apiKey).toBeUndefined();
      expect((await storedDocument(role))?.tombstones).toEqual([
        'endpoints.custom["draft"].headers.X-Legacy',
      ]);
    });

    it('that sends the carried key somewhere else needs it entered again', async () => {
      const role = nextRole();
      const draft = await seedDraft(role);

      const res = await patch(role, {
        entries: [
          {
            fieldPath: 'endpoints.custom',
            value: [renamed(draft, { baseURL: 'https://collector.example.com/v1' })],
          },
        ],
        renames: hint,
      });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'CONFIG_SECRET_REENTRY_REQUIRED',
        issues: [expect.objectContaining({ path: 'endpoints.custom.0.baseURL' })],
      });
      expect(await storedEndpoint(role, 'draft')).toEqual(draft);
    });

    it('is refused when it cannot apply, storing nothing', async () => {
      const role = nextRole();
      const draft = await seedDraft(role);
      await changes(role, {
        ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: endpoint('taken') }],
      });
      const before = await storedDocument(role);
      const write = (custom: Endpoint[], renames: unknown) =>
        patch(role, { entries: [{ fieldPath: 'endpoints.custom', value: custom }], renames });
      const final = renamed(draft);

      const cases: Array<[Endpoint[], unknown, string]> = [
        [
          [final],
          [{ path: 'endpoints.custom', previousName: 'Literal', name: 'final' }],
          'inherited_entry',
        ],
        [
          [endpoint('Literal')],
          [{ path: 'endpoints.custom', previousName: 'draft', name: 'Literal' }],
          'inherited_entry',
        ],
        [
          [final],
          [{ path: 'endpoints.custom', previousName: 'missing', name: 'final' }],
          'source_not_found',
        ],
        [
          [endpoint('taken')],
          [{ path: 'endpoints.custom', previousName: 'draft', name: 'taken' }],
          'target_exists',
        ],
        [[endpoint('other')], hint, 'target_not_written'],
        [[final, { ...draft, apiKey: undefined }], hint, 'source_still_written'],
        [
          [final],
          [{ path: 'endpoints.custom', previousName: 'Ollama', name: 'ollama' }],
          'invalid_name',
        ],
        [
          [final],
          [{ path: 'endpoints.custom', previousName: 'draft', name: '$final' }],
          'invalid_name',
        ],
        [
          [final, renamed(draft, { name: 'copy' })],
          [...hint, { path: 'endpoints.custom', previousName: 'draft', name: 'copy' }],
          'duplicate_source',
        ],
      ];
      for (const [custom, renames, reason] of cases) {
        const res = await write(custom, renames);
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
          error: 'Invalid rename hint',
          code: 'CONFIG_RENAME_INVALID',
          reason,
        });
      }
      expect(await storedDocument(role)).toEqual(before);
    });
  });

  it('a batch rename moves the keyed tombstones and keeps the key', async () => {
    const role = nextRole();
    const draft = await storeOwnKey(role, 'draft');
    await tombstone(role, 'endpoints.custom["draft"].headers.X-Legacy');

    const res = await changes(role, {
      ops: [{ op: 'rename', fieldPath: 'endpoints.custom', from: 'draft', to: 'final' }],
    });

    expect(res.statusCode).toBe(200);
    expect((await storedEndpoint(role, 'final'))?.apiKey).toBe(draft.apiKey);
    expect((await storedDocument(role))?.tombstones).toEqual([
      'endpoints.custom["final"].headers.X-Legacy',
    ]);
    const refused = await changes(role, {
      ops: [{ op: 'rename', fieldPath: 'endpoints.custom', from: 'final', to: '$final' }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatchObject({ code: 'CONFIG_ENTRY_INVALID', reason: 'invalid_entry' });
  });

  it('a rename keeps the destination fingerprint of a key entered over a Base endpoint', async () => {
    const role = nextRole();
    const base = dataSchemas.BASE_CONFIG_PRINCIPAL_ID;
    const team = endpoint('Team', { apiKey: 'sk-base-team-key-0123456789' });
    expect(
      (
        await changes(base, {
          ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: team }],
        })
      ).statusCode,
    ).toBe(200);
    try {
      const entered = await changes(role, {
        ops: [
          {
            op: 'upsertEntry',
            fieldPath: 'endpoints.custom',
            entry: { name: 'Team', apiKey: 'sk-role-own-team-key-0123456789' },
          },
        ],
      });
      expect(entered.statusCode).toBe(200);
      expect(entered.body?.ignored).toEqual([]);
      const own = await storedEndpoint(role, 'Team');
      expect(own?.apiKeyBinding).toEqual(expect.any(String));

      const res = await patch(role, {
        entries: [
          {
            fieldPath: 'endpoints.custom',
            value: [{ name: 'Team 2', baseURL: team.baseURL, models: team.models }],
          },
        ],
        renames: [{ path: 'endpoints.custom', previousName: 'Team', name: 'Team 2' }],
      });

      expect(res.statusCode).toBe(200);
      const moved = await storedEndpoint(role, 'Team 2');
      expect(moved?.apiKey).toBe(own?.apiKey);
      expect(moved?.apiKeyBinding).toBe(own?.apiKeyBinding);
    } finally {
      await methods.deleteConfig(PrincipalType.ROLE, base);
    }
  });
});
