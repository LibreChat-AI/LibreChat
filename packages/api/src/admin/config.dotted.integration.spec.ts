import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import mongoSanitize from 'express-mongo-sanitize';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AppConfig, IConfig } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';
/** An Azure group a write stores must resolve, its `${AZURE_API_KEY}` included. */
process.env.AZURE_API_KEY = process.env.AZURE_API_KEY ?? 'test-azure-key';

type DataSchemas = typeof import('@librechat/data-schemas');
type Doc = Record<string, unknown>;
type Handler = (req: ServerRequest, res: Response) => Promise<Response>;

let mongoServer: MongoMemoryServer;
let app: express.Express;
let logger: DataSchemas['logger'];
let decryptV3: DataSchemas['decryptV3'];
let mergeConfigOverrides: DataSchemas['mergeConfigOverrides'];

const PROFILE = 'us.anthropic.claude-sonnet-4-6';
const ARN =
  'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const API_KEY = 'sk-gateway-literal-0123456789';

/**
 * The request path of `api/server/index.js` and `routes/admin/config.js`: app-level sanitizer,
 * authentication, the unsafe-key guard, then the real handlers over the real config methods.
 */
beforeAll(async () => {
  jest.resetModules();
  const dataSchemas = await import('@librechat/data-schemas');
  ({ decryptV3, mergeConfigOverrides, logger } = dataSchemas);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  const { createAdminConfigHandlers } = await import('./config');
  const { createRequestSanitizer, rejectUnsafeConfigKeys } = await import('~/middleware/sanitize');

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  const methods = dataSchemas.createMethods(mongoose);
  const handlers = createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    writeConfigDocument: methods.writeConfigDocument,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActiveTracked: methods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    getAppConfig: async () => ({ config: {} }) as AppConfig,
  });

  const route = (handler: Handler) => async (req: Request, res: Response) => {
    await handler(req as ServerRequest, res);
  };
  const router = express.Router();
  router.use((req: Request, _res: Response, next: NextFunction) => {
    (req as ServerRequest).user = { id: 'u1', role: 'ADMIN' } as ServerRequest['user'];
    next();
  }, rejectUnsafeConfigKeys);
  router.get('/:principalType/:principalId', route(handlers.getConfig));
  router.put('/:principalType/:principalId', route(handlers.upsertConfigOverrides));
  router.patch('/:principalType/:principalId/fields', route(handlers.patchConfigField));
  router.delete('/:principalType/:principalId/fields', route(handlers.deleteConfigField));

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });
  app.use(createRequestSanitizer(mongoSanitize));
  app.use('/api/admin/config', router);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

let principalCounter = 0;
function nextRole(): string {
  principalCounter += 1;
  return `DOTTED_${principalCounter}`;
}

/** The stored document as the driver returns it, without schema hydration. */
async function readRaw(principalId: string): Promise<{ overrides: Doc } | null> {
  return mongoose.models.Config.collection.findOne<{ overrides: Doc }>({ principalId });
}

function getIn(target: unknown, segments: string[]): unknown {
  return segments.reduce<unknown>(
    (node, segment) =>
      node != null && typeof node === 'object' ? (node as Doc)[segment] : undefined,
    target,
  );
}

function patchFields(role: string, entries: Array<{ fieldPath: string; value: unknown }>) {
  return request(app).patch(`/api/admin/config/role/${role}/fields`).send({ entries });
}

function putOverrides(role: string, overrides: unknown) {
  return request(app).put(`/api/admin/config/role/${role}`).send({ overrides });
}

async function getOverrides(role: string): Promise<Doc> {
  const response = await request(app).get(`/api/admin/config/role/${role}`).expect(200);
  return response.body.config.overrides as Doc;
}

function merge(stored: Doc): AppConfig {
  const config = { principalType: 'role', principalId: 'r', priority: 10, isActive: true };
  return mergeConfigOverrides({ config: {} } as AppConfig, [
    { ...config, overrides: stored } as Partial<IConfig> as IConfig,
  ]);
}

describe('admin config writes keep dotted record keys (real sanitizer, handlers and Mongo)', () => {
  it('round-trips Bedrock inference profiles through PATCH, storage, GET and merge', async () => {
    const role = nextRole();
    const profiles = { [PROFILE]: ARN, 'eu.amazon.nova-pro-v1:0': 'arn:aws:bedrock:eu:1:x' };
    await patchFields(role, [
      { fieldPath: 'endpoints.bedrock.inferenceProfiles', value: profiles },
    ]).expect(200);

    /** Stored raw where the engine accepts dotted names, as servers before the key encoding read them. */
    expect(
      getIn((await readRaw(role))?.overrides, ['endpoints', 'bedrock', 'inferenceProfiles']),
    ).toEqual(profiles);
    const read = await getOverrides(role);
    expect(getIn(read, ['endpoints', 'bedrock', 'inferenceProfiles'])).toEqual(profiles);
    expect(getIn(merge(read), ['endpoints', 'bedrock', 'inferenceProfiles'])).toEqual(profiles);
  });

  it('round-trips Azure group model names through PUT, storage and GET', async () => {
    const role = nextRole();
    const models = { 'gpt-4.1': true, 'gpt-4.1-mini': { deploymentName: 'mini' } };
    await putOverrides(role, {
      endpoints: {
        azureOpenAI: {
          groups: [
            {
              group: 'eastus',
              apiKey: '${AZURE_API_KEY}',
              instanceName: 'east',
              deploymentName: 'gpt-41',
              version: '2024-10-21',
              models,
            },
          ],
        },
      },
    }).expect(201);

    const path = ['endpoints', 'azureOpenAI', 'groups', '0', 'models'];
    expect(getIn((await readRaw(role))?.overrides, path)).toEqual(models);
    expect(getIn(await getOverrides(role), path)).toEqual(models);
  });

  it('round-trips MIME-type delivery overrides and dotted header names', async () => {
    const role = nextRole();
    await patchFields(role, [
      { fieldPath: 'fileConfig.defaultLLMDeliveryPath.overrides', value: { [DOCX]: 'text' } },
      {
        fieldPath: 'mcpServers.docs',
        value: {
          type: 'streamable-http',
          url: 'https://mcp.example.com',
          headers: { 'X-Org.Id': 'o' },
        },
      },
    ]).expect(200);

    const read = await getOverrides(role);
    expect(getIn(read, ['fileConfig', 'defaultLLMDeliveryPath', 'overrides'])).toEqual({
      [DOCX]: 'text',
    });
    expect(getIn(read, ['mcpServers', 'docs', 'headers'])).toEqual({ 'X-Org.Id': 'o' });
  });

  it('still encrypts a secret that sits beside dotted record keys', async () => {
    const role = nextRole();
    const response = await patchFields(role, [
      {
        fieldPath: 'endpoints.custom',
        value: [
          {
            name: 'gateway',
            apiKey: API_KEY,
            baseURL: 'https://gateway.example.com/v1',
            models: { default: ['gpt-4.1'] },
            headers: { 'x-portkey.config': 'cfg' },
          },
        ],
      },
    ]).expect(200);
    expect(JSON.stringify(response.body)).not.toContain(API_KEY);

    const [stored] = getIn((await readRaw(role))?.overrides, ['endpoints', 'custom']) as Doc[];
    expect(stored.headers).toEqual({ 'x-portkey.config': 'cfg' });
    expect(stored.apiKey).toMatch(/^v3:/);
    expect(decryptV3(stored.apiKey as string)).toBe(API_KEY);
    const [read] = getIn(await getOverrides(role), ['endpoints', 'custom']) as Doc[];
    expect(read.headers).toEqual({ 'x-portkey.config': 'cfg' });
  });

  it('removes a dotted record whole through its own field path', async () => {
    const role = nextRole();
    await patchFields(role, [
      { fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { [PROFILE]: ARN } },
      { fieldPath: 'endpoints.bedrock.models', value: ['anthropic.claude-sonnet-4-6'] },
    ]).expect(200);

    await request(app)
      .delete(`/api/admin/config/role/${role}/fields`)
      .query({ fieldPath: 'endpoints.bedrock.inferenceProfiles' })
      .expect(200);
    expect(getIn((await readRaw(role))?.overrides, ['endpoints', 'bedrock'])).toEqual({
      models: ['anthropic.claude-sonnet-4-6'],
    });
  });
});

describe('admin config writes refuse keys that cannot be config', () => {
  it.each([
    [
      'a `$` operator in a PATCH value',
      { entries: [{ fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { $gt: '' } }] },
    ],
    ['a `$` key in a PUT section', { overrides: { registration: { $set: { enabled: false } } } }],
    [
      'a `__proto__` key',
      JSON.parse('{"overrides":{"registration":{"__proto__":{"admin":true}}}}'),
    ],
  ])('answers 400 CONFIG_UNSAFE_KEY for %s and stores nothing', async (_label, body) => {
    const role = nextRole();
    const method = 'entries' in body ? 'patch' : 'put';
    const path = `/api/admin/config/role/${role}${method === 'patch' ? '/fields' : ''}`;
    const response = await request(app)[method](path).send(body).expect(400);

    expect(response.body.code).toBe('CONFIG_UNSAFE_KEY');
    expect(await readRaw(role)).toBeNull();
  });

  it.each([
    ['a dotted section name', { 'webSearch.serperApiKey': 'sk-serper-plaintext-0123' }],
    ['a dotted base-only section', { 'filters.x': { allow: true } }],
    ['a dotted key in a fixed-shape object', { registration: { 'allowedDomains.0': 'x.com' } }],
  ])('answers 400 dotted_key for %s instead of storing an inert key', async (_label, overrides) => {
    const role = nextRole();
    const response = await putOverrides(role, overrides).expect(400);

    expect(response.body.code).toBe('CONFIG_OVERRIDE_INVALID');
    expect(response.body.issues).toEqual([expect.objectContaining({ code: 'dotted_key' })]);
    expect(await readRaw(role)).toBeNull();
  });

  it('answers 400 dotted_key for a fixed-shape dotted key in a PATCH value', async () => {
    const role = nextRole();
    const response = await patchFields(role, [
      { fieldPath: 'webSearch', value: { 'serperApiKey.x': 'sk-serper-plaintext-0123' } },
    ]).expect(400);

    expect(response.body.issues).toEqual([
      {
        path: 'webSearch.serperApiKey.x',
        segments: ['webSearch', 'serperApiKey.x'],
        code: 'dotted_key',
      },
    ]);
    expect(await readRaw(role)).toBeNull();
  });

  it('names an invalid dotted record key by its segments', async () => {
    const role = nextRole();
    const response = await patchFields(role, [
      { fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { [PROFILE]: 123 } },
    ]).expect(400);

    expect(response.body.issues).toEqual([
      {
        path: `endpoints.bedrock.inferenceProfiles.${PROFILE}`,
        segments: ['endpoints', 'bedrock', 'inferenceProfiles', PROFILE],
        code: 'invalid_type',
        params: { expected: 'string', received: 'number' },
      },
    ]);
    expect(await readRaw(role)).toBeNull();
  });
});

/** The first key holding a dot anywhere inside a stored value. */
function findDottedKey(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const found = key.includes('.') ? key : findDottedKey(child);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Turns the in-memory MongoDB into an engine that refuses dotted field names inside stored
 * documents, the way MongoDB before 3.6 did, instead of storing them. `$set` and `$setOnInsert`
 * paths stay dotted; only keys inside the values are judged.
 */
function refuseDottedFieldNames(): () => void {
  const collection = mongoose.models.Config.collection;
  const findOneAndUpdate = collection.findOneAndUpdate.bind(collection);
  collection.findOneAndUpdate = (async (
    filter: Doc,
    update: { $set?: Doc; $setOnInsert?: Doc },
    options: Doc,
  ) => {
    const key = [...Object.values(update.$set ?? {}), ...Object.values(update.$setOnInsert ?? {})]
      .map(findDottedKey)
      .find((found) => found != null);
    if (key) {
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 57,
        errmsg: `The dotted field '${key}' in 'overrides' is not valid for storage.`,
      });
    }
    return findOneAndUpdate(filter, update, options);
  }) as unknown as typeof collection.findOneAndUpdate;
  return () => {
    Reflect.deleteProperty(collection, 'findOneAndUpdate');
  };
}

describe('admin config writes on an engine that cannot store dotted keys', () => {
  let restore: () => void;

  beforeAll(() => {
    restore = refuseDottedFieldNames();
  });

  afterAll(() => {
    restore();
  });

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
  });

  it.each([
    [
      'PATCH',
      (role: string) =>
        patchFields(role, [
          { fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { [PROFILE]: ARN } },
        ]),
      200,
      ['endpoints', 'bedrock', 'inferenceProfiles'],
      { [PROFILE]: ARN },
    ],
    [
      'PUT',
      (role: string) =>
        putOverrides(role, {
          endpoints: {
            azureOpenAI: {
              groups: [
                {
                  group: 'eastus',
                  apiKey: '${AZURE_API_KEY}',
                  instanceName: 'east',
                  deploymentName: 'gpt-41',
                  version: '2024-10-21',
                  models: { 'gpt-4.1': true },
                },
              ],
            },
          },
        }),
      201,
      ['endpoints', 'azureOpenAI', 'groups', '0', 'models'],
      { 'gpt-4.1': true },
    ],
    [
      'a PATCH that also moves a web search URL',
      (role: string) =>
        patchFields(role, [
          { fieldPath: 'webSearch.searxngInstanceUrl', value: 'https://searx.example.com' },
          { fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { [PROFILE]: ARN } },
        ]),
      200,
      ['endpoints', 'bedrock', 'inferenceProfiles'],
      { [PROFILE]: ARN },
    ],
    [
      'a PUT that also writes the web search section',
      (role: string) =>
        putOverrides(role, {
          webSearch: { safeSearch: 2 },
          endpoints: { bedrock: { inferenceProfiles: { [PROFILE]: ARN } } },
        }),
      201,
      ['endpoints', 'bedrock', 'inferenceProfiles'],
      { [PROFILE]: ARN },
    ],
  ])(
    'stores a %s whose record keys hold dots, encoded so the engine sees none',
    async (_label, write, status, path, expected) => {
      const role = nextRole();
      await write(role).expect(status);

      expect(findDottedKey((await readRaw(role))?.overrides)).toBeUndefined();
      expect(getIn(await getOverrides(role), path)).toEqual(expected);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('rejected a key name');
    },
  );

  it('still stores writes without dotted keys', async () => {
    const role = nextRole();
    await patchFields(role, [
      { fieldPath: 'endpoints.bedrock.models', value: ['anthropic.claude-sonnet-4-6'] },
    ]).expect(200);

    expect(getIn((await readRaw(role))?.overrides, ['endpoints', 'bedrock'])).toEqual({
      models: ['anthropic.claude-sonnet-4-6'],
    });
  });
});
