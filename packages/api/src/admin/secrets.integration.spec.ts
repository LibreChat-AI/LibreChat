import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { Config } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';

type DataSchemas = typeof import('@librechat/data-schemas');
type ConfigMethods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigHandlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;

let mongoServer: MongoMemoryServer;
let handlers: AdminConfigHandlers;
let basePrincipalId: string;
let decryptV3: DataSchemas['decryptV3'];
let patchConfigFields: ConfigMethods['patchConfigFields'];
let getSecretPreview: typeof import('./secrets').getSecretPreview;
let encryptConfigSecretFields: typeof import('./secrets').encryptConfigSecretFields;

interface SecretFieldCase {
  /** Dot-path of the secret field */
  path: string;
  /** Dot-path of the non-secret masked preview companion for `path` */
  previewPath: string;
  /** Section object containing the secret plus a non-secret sibling */
  section: string;
  object: Record<string, unknown>;
  /** Dot-path of a non-secret sibling used for unrelated writes */
  siblingPath: string;
  siblingValue: unknown;
}

const SECRET = 'sk-super-secret-literal';

/**
 * Secrets written through the generic config API. `langfuse.secretKey` is absent because only the
 * dedicated Langfuse connection API writes that section; the generic API strips it.
 */
const SECRET_FIELD_CASES: SecretFieldCase[] = [
  {
    path: 'ocr.apiKey',
    previewPath: 'ocr.apiKeyPreview',
    section: 'ocr',
    object: { apiKey: SECRET, mistralModel: 'mistral-ocr-latest' },
    siblingPath: 'ocr.mistralModel',
    siblingValue: 'mistral-ocr-next',
  },
  {
    path: 'speech.tts.openai.apiKey',
    previewPath: 'speech.tts.openai.apiKeyPreview',
    section: 'speech',
    object: { tts: { openai: { apiKey: SECRET, model: 'tts-1', voices: ['alloy'] } } },
    siblingPath: 'speech.tts.openai.model',
    siblingValue: 'tts-2',
  },
  {
    path: 'speech.tts.azureOpenAI.apiKey',
    previewPath: 'speech.tts.azureOpenAI.apiKeyPreview',
    section: 'speech',
    object: { tts: { azureOpenAI: { apiKey: SECRET, instanceName: 'inst' } } },
    siblingPath: 'speech.tts.azureOpenAI.instanceName',
    siblingValue: 'inst-2',
  },
  {
    path: 'speech.tts.elevenlabs.apiKey',
    previewPath: 'speech.tts.elevenlabs.apiKeyPreview',
    section: 'speech',
    object: { tts: { elevenlabs: { apiKey: SECRET, model: 'eleven_multilingual_v2' } } },
    siblingPath: 'speech.tts.elevenlabs.model',
    siblingValue: 'eleven_turbo_v2',
  },
  {
    path: 'speech.tts.localai.apiKey',
    previewPath: 'speech.tts.localai.apiKeyPreview',
    section: 'speech',
    object: { tts: { localai: { apiKey: SECRET, url: 'http://localai:8080' } } },
    siblingPath: 'speech.tts.localai.url',
    siblingValue: 'http://localai:8081',
  },
  {
    path: 'speech.stt.openai.apiKey',
    previewPath: 'speech.stt.openai.apiKeyPreview',
    section: 'speech',
    object: { stt: { openai: { apiKey: SECRET, model: 'whisper-1' } } },
    siblingPath: 'speech.stt.openai.model',
    siblingValue: 'whisper-2',
  },
  {
    path: 'speech.stt.azureOpenAI.apiKey',
    previewPath: 'speech.stt.azureOpenAI.apiKeyPreview',
    section: 'speech',
    object: { stt: { azureOpenAI: { apiKey: SECRET, instanceName: 'inst' } } },
    siblingPath: 'speech.stt.azureOpenAI.instanceName',
    siblingValue: 'inst-2',
  },
  {
    path: 'webSearch.serperApiKey',
    previewPath: 'webSearch.serperApiKeyPreview',
    section: 'webSearch',
    object: { serperApiKey: SECRET, searchProvider: 'serper' },
    siblingPath: 'webSearch.searchProvider',
    siblingValue: 'serper',
  },
  {
    path: 'webSearch.searxngApiKey',
    previewPath: 'webSearch.searxngApiKeyPreview',
    section: 'webSearch',
    object: { searxngApiKey: SECRET, searxngInstanceUrl: 'https://searx.example.com' },
    siblingPath: 'webSearch.searxngInstanceUrl',
    siblingValue: 'https://searx2.example.com',
  },
  {
    path: 'webSearch.firecrawlApiKey',
    previewPath: 'webSearch.firecrawlApiKeyPreview',
    section: 'webSearch',
    object: { firecrawlApiKey: SECRET, firecrawlApiUrl: 'https://api.firecrawl.dev' },
    siblingPath: 'webSearch.firecrawlApiUrl',
    siblingValue: 'https://api2.firecrawl.dev',
  },
  {
    path: 'webSearch.tavilyApiKey',
    previewPath: 'webSearch.tavilyApiKeyPreview',
    section: 'webSearch',
    object: { tavilyApiKey: SECRET, scraperTimeout: 7500 },
    siblingPath: 'webSearch.scraperTimeout',
    siblingValue: 8000,
  },
  {
    path: 'webSearch.jinaApiKey',
    previewPath: 'webSearch.jinaApiKeyPreview',
    section: 'webSearch',
    object: { jinaApiKey: SECRET, jinaApiUrl: 'https://r.jina.ai' },
    siblingPath: 'webSearch.jinaApiUrl',
    siblingValue: 'https://r2.jina.ai',
  },
  {
    path: 'webSearch.cohereApiKey',
    previewPath: 'webSearch.cohereApiKeyPreview',
    section: 'webSearch',
    object: { cohereApiKey: SECRET, rerankerType: 'cohere' },
    siblingPath: 'webSearch.rerankerType',
    siblingValue: 'cohere',
  },
  {
    path: 'endpoints.assistants.apiKey',
    previewPath: 'endpoints.assistants.apiKeyPreview',
    section: 'endpoints',
    object: { assistants: { apiKey: SECRET, disableBuilder: true } },
    siblingPath: 'endpoints.assistants.disableBuilder',
    siblingValue: false,
  },
  {
    path: 'endpoints.azureAssistants.apiKey',
    previewPath: 'endpoints.azureAssistants.apiKeyPreview',
    section: 'endpoints',
    object: { azureAssistants: { apiKey: SECRET, disableBuilder: true } },
    siblingPath: 'endpoints.azureAssistants.disableBuilder',
    siblingValue: false,
  },
];

/** Fields whose values conventionally hold `${ENV_VAR}` placeholder references. */
const PLACEHOLDER_CASES = [
  { path: 'ocr.apiKey', placeholder: '${OCR_API_KEY}' },
  { path: 'speech.tts.openai.apiKey', placeholder: '${TTS_API_KEY}' },
  { path: 'webSearch.serperApiKey', placeholder: '${SERPER_API_KEY}' },
  { path: 'endpoints.assistants.apiKey', placeholder: '${ASSISTANTS_API_KEY}' },
];

function mockReq(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    user: { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

interface MockRes {
  statusCode: number;
  body: undefined | { config?: Record<string, unknown>; error?: string; [key: string]: unknown };
  status: jest.Mock;
  json: jest.Mock;
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

function getAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

type RawConfig = Pick<Config, 'configVersion'> & { overrides: Record<string, unknown> };

async function readRawConfig(principalId: string): Promise<RawConfig> {
  const doc = await mongoose.models.Config.findOne({ principalId });
  expect(doc).not.toBeNull();
  expect(doc!.$isNew).toBe(false);
  return doc!.toObject() as RawConfig;
}

async function readRawOverrides(principalId: string): Promise<Record<string, unknown>> {
  return (await readRawConfig(principalId)).overrides;
}

let principalCounter = 0;
function nextPrincipalId(): string {
  principalCounter += 1;
  return `admin-${principalCounter}`;
}

beforeAll(async () => {
  jest.resetModules();
  const dataSchemas = await import('@librechat/data-schemas');
  ({ decryptV3, BASE_CONFIG_PRINCIPAL_ID: basePrincipalId } = dataSchemas);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'debug').mockReturnValue(dataSchemas.logger);

  const { createAdminConfigHandlers } = await import('./config');
  ({ getSecretPreview, encryptConfigSecretFields } = await import('./secrets'));

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  const methods = dataSchemas.createMethods(mongoose);
  ({ patchConfigFields } = methods);

  handlers = createAdminConfigHandlers({
    listAllConfigs: methods.listAllConfigs,
    findConfigByPrincipal: methods.findConfigByPrincipal,
    upsertConfig: methods.upsertConfig,
    patchConfigFields: methods.patchConfigFields,
    tombstoneConfigField: methods.tombstoneConfigField,
    unsetConfigField: methods.unsetConfigField,
    deleteConfig: methods.deleteConfig,
    toggleConfigActive: methods.toggleConfigActive,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('config secret registry — real handlers against a real Config collection', () => {
  describe.each(SECRET_FIELD_CASES)(
    '$path',
    ({ path, previewPath, section, object, siblingPath, siblingValue }) => {
      it('encrypts dotted patch writes at rest, sets the masked preview companion, and redacts the secret from the response', async () => {
        const principalId = nextPrincipalId();
        const res = mockRes();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: path, value: SECRET }] },
          }),
          res,
        );
        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(SECRET);

        const overrides = await readRawOverrides(principalId);
        const stored = getAtPath(overrides, path);
        expect(typeof stored).toBe('string');
        expect(stored).toMatch(/^v3:/);
        expect(decryptV3(stored as string)).toBe(SECRET);
        expect(getAtPath(overrides, previewPath)).toBe(getSecretPreview(SECRET));

        const responseOverrides = (res.body!.config as { overrides: Record<string, unknown> })
          .overrides;
        expect(getAtPath(responseOverrides, path)).toBeUndefined();
        expect(getAtPath(responseOverrides, previewPath)).toBe(getSecretPreview(SECRET));
      });

      it('encrypts object-valued upsert writes at rest, sets the masked preview companion, and redacts reads', async () => {
        const principalId = nextPrincipalId();
        const upsertRes = mockRes();
        await handlers.upsertConfigOverrides(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { overrides: { [section]: object } },
          }),
          upsertRes,
        );
        expect(upsertRes.statusCode).toBe(201);
        expect(JSON.stringify(upsertRes.body)).not.toContain(SECRET);

        const overrides = await readRawOverrides(principalId);
        expect(decryptV3(getAtPath(overrides, path) as string)).toBe(SECRET);
        expect(getAtPath(overrides, previewPath)).toBe(getSecretPreview(SECRET));

        const getRes = mockRes();
        await handlers.getConfig(
          mockReq({ params: { principalType: 'role', principalId } }),
          getRes,
        );
        expect(getRes.statusCode).toBe(200);
        expect(JSON.stringify(getRes.body)).not.toContain(SECRET);
        expect(JSON.stringify(getRes.body)).not.toContain('v3:');
        const getOverrides = (getRes.body!.config as { overrides: Record<string, unknown> })
          .overrides;
        expect(getAtPath(getOverrides, path)).toBeUndefined();
        expect(getAtPath(getOverrides, previewPath)).toBe(getSecretPreview(SECRET));

        const listRes = mockRes();
        await handlers.listConfigs(mockReq(), listRes);
        expect(listRes.statusCode).toBe(200);
        expect(JSON.stringify(listRes.body)).not.toContain(SECRET);
        expect(JSON.stringify(listRes.body)).not.toContain('v3:');
      });

      it('preserves the stored secret and its preview companion across an unrelated dotted patch', async () => {
        const principalId = nextPrincipalId();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: path, value: SECRET }] },
          }),
          mockRes(),
        );
        const rawBefore = await readRawOverrides(principalId);
        const before = getAtPath(rawBefore, path);
        const displayBefore = getAtPath(rawBefore, previewPath);
        expect(displayBefore).toBe(getSecretPreview(SECRET));

        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: siblingPath, value: siblingValue }] },
          }),
          mockRes(),
        );

        const overrides = await readRawOverrides(principalId);
        expect(getAtPath(overrides, path)).toBe(before);
        expect(decryptV3(getAtPath(overrides, path) as string)).toBe(SECRET);
        expect(getAtPath(overrides, previewPath)).toBe(displayBefore);
        expect(getAtPath(overrides, siblingPath)).toEqual(siblingValue);
      });

      it('round-trips a redacted read (including the visible preview companion) back through a full upsert without clobbering the secret', async () => {
        const principalId = nextPrincipalId();
        await handlers.upsertConfigOverrides(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { overrides: { [section]: object } },
          }),
          mockRes(),
        );
        const rawBefore = await readRawOverrides(principalId);
        const before = getAtPath(rawBefore, path);
        const displayBefore = getAtPath(rawBefore, previewPath);

        const getRes = mockRes();
        await handlers.getConfig(
          mockReq({ params: { principalType: 'role', principalId } }),
          getRes,
        );
        const redactedOverrides = (getRes.body!.config as { overrides: Record<string, unknown> })
          .overrides;
        expect(getAtPath(redactedOverrides, path)).toBeUndefined();
        expect(getAtPath(redactedOverrides, previewPath)).toBe(displayBefore);

        const clientEdited = JSON.parse(JSON.stringify(redactedOverrides)) as Record<
          string,
          unknown
        >;
        const upsertRes = mockRes();
        await handlers.upsertConfigOverrides(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { overrides: clientEdited },
          }),
          upsertRes,
        );
        expect(upsertRes.statusCode).toBe(200);
        expect(JSON.stringify(upsertRes.body)).not.toContain(SECRET);

        const overrides = await readRawOverrides(principalId);
        expect(getAtPath(overrides, path)).toBe(before);
        expect(decryptV3(getAtPath(overrides, path) as string)).toBe(SECRET);
        expect(getAtPath(overrides, previewPath)).toBe(displayBefore);
      });

      it('clears the secret and its preview companion when explicitly set to an empty value', async () => {
        const principalId = nextPrincipalId();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: path, value: SECRET }] },
          }),
          mockRes(),
        );
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: path, value: '' }] },
          }),
          mockRes(),
        );
        const overrides = await readRawOverrides(principalId);
        expect(getAtPath(overrides, path)).toBe('');
        expect(getAtPath(overrides, previewPath)).toBe('');
      });

      it('rejects encrypted value submissions', async () => {
        const res = mockRes();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId: nextPrincipalId() },
            body: { entries: [{ fieldPath: path, value: 'v3:attacker-controlled' }] },
          }),
          res,
        );
        expect(res.statusCode).toBe(400);
      });

      it('rejects a direct dotted-patch write to the preview companion path itself', async () => {
        const principalId = nextPrincipalId();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: path, value: SECRET }] },
          }),
          mockRes(),
        );

        const res = mockRes();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [{ fieldPath: previewPath, value: 'attacker-supplied-display' }] },
          }),
          res,
        );
        expect(res.statusCode).toBe(400);

        const overrides = await readRawOverrides(principalId);
        expect(decryptV3(getAtPath(overrides, path) as string)).toBe(SECRET);
        expect(getAtPath(overrides, previewPath)).toBe(getSecretPreview(SECRET));
      });

      it('never persists a client-supplied display value as the real secret via an object-valued upsert', async () => {
        const principalId = nextPrincipalId();
        const spoofedObject = JSON.parse(JSON.stringify(object)) as Record<string, unknown>;
        const objectPathSegments = path.slice(section.length + 1).split('.');
        let cursor = spoofedObject;
        for (let i = 0; i < objectPathSegments.length - 1; i++) {
          cursor = cursor[objectPathSegments[i]] as Record<string, unknown>;
        }
        const secretKey = objectPathSegments[objectPathSegments.length - 1];
        const previewKey = previewPath.split('.').slice(-1)[0];
        delete cursor[secretKey];
        cursor[previewKey] = 'v3:attacker-supplied-looks-encrypted';

        const res = mockRes();
        await handlers.upsertConfigOverrides(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { overrides: { [section]: spoofedObject } },
          }),
          res,
        );
        expect(res.statusCode).toBe(201);

        const overrides = await readRawOverrides(principalId);
        expect(getAtPath(overrides, path)).toBeUndefined();
        expect(getAtPath(overrides, previewPath)).toBeUndefined();
      });
    },
  );

  describe('langfuse.secretKey (dedicated Langfuse connection API)', () => {
    type RefusedWrite = [
      string,
      'patchConfigField' | 'tombstoneConfigField' | 'deleteConfigField',
      Record<string, unknown>,
    ];

    const secretPath = 'langfuse.secretKey';
    const previewPath = 'langfuse.secretKeyPreview';

    function baseReq(overrides: Record<string, unknown> = {}): ServerRequest {
      return mockReq({
        params: { principalType: 'role', principalId: basePrincipalId },
        ...overrides,
      });
    }

    /** Persists what the dedicated connection API writes, through the same shared secret helper. */
    async function seedLangfuseConnection(): Promise<RawConfig> {
      await mongoose.models.Config.deleteOne({ principalId: basePrincipalId });
      await patchConfigFields(
        PrincipalType.ROLE,
        basePrincipalId,
        PrincipalModel.ROLE,
        encryptConfigSecretFields({
          'langfuse.enabled': true,
          'langfuse.destination': 'eu',
          'langfuse.publicKey': 'pk-lf-1',
          [secretPath]: SECRET,
        }),
        10,
      );
      return readRawConfig(basePrincipalId);
    }

    it('keeps the stored secret encrypted at rest and redacts it from generic reads', async () => {
      const { overrides: stored } = await seedLangfuseConnection();
      expect(getAtPath(stored, secretPath)).toMatch(/^v3:/);
      expect(decryptV3(getAtPath(stored, secretPath) as string)).toBe(SECRET);
      expect(getAtPath(stored, previewPath)).toBe(getSecretPreview(SECRET));

      const getRes = mockRes();
      await handlers.getConfig(baseReq(), getRes);
      expect(getRes.statusCode).toBe(200);
      expect(JSON.stringify(getRes.body)).not.toContain(SECRET);
      expect(JSON.stringify(getRes.body)).not.toContain('v3:');
      const overrides = (getRes.body!.config as { overrides: Record<string, unknown> }).overrides;
      expect(getAtPath(overrides, secretPath)).toBeUndefined();
      expect(getAtPath(overrides, previewPath)).toBe(getSecretPreview(SECRET));
      expect(getAtPath(overrides, 'langfuse.publicKey')).toBe('pk-lf-1');

      const listRes = mockRes();
      await handlers.listConfigs(mockReq(), listRes);
      expect(listRes.statusCode).toBe(200);
      expect(JSON.stringify(listRes.body)).not.toContain(SECRET);
      expect(JSON.stringify(listRes.body)).not.toContain('v3:');
    });

    it.each<RefusedWrite>([
      [
        'a dotted patch that replaces it',
        'patchConfigField',
        { body: { entries: [{ fieldPath: secretPath, value: 'sk-lf-replacement' }] } },
      ],
      [
        'a dotted patch that clears it',
        'patchConfigField',
        { body: { entries: [{ fieldPath: secretPath, value: '' }] } },
      ],
      ['a field tombstone', 'tombstoneConfigField', { body: { fieldPath: secretPath } }],
      ['a field delete', 'deleteConfigField', { query: { fieldPath: secretPath } }],
    ])('ignores %s without writing the base config', async (_label, handler, request) => {
      const before = await seedLangfuseConnection();
      const res = mockRes();
      await handlers[handler](baseReq(request), res);
      expect(res.statusCode).toBe(200);

      const after = await readRawConfig(basePrincipalId);
      expect(after.configVersion).toBe(before.configVersion);
      expect(after.overrides).toEqual(before.overrides);
    });

    it('carries the stored secret through a full base-config replacement', async () => {
      const before = await seedLangfuseConnection();
      const res = mockRes();
      await handlers.upsertConfigOverrides(
        baseReq({
          body: {
            overrides: {
              interface: { modelSelect: false },
              langfuse: {
                enabled: false,
                publicKey: 'pk-lf-caller',
                secretKey: 'sk-lf-replacement',
              },
            },
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);

      const after = await readRawConfig(basePrincipalId);
      expect(after.configVersion).toBe(before.configVersion + 1);
      expect(getAtPath(after.overrides, 'interface.modelSelect')).toBe(false);
      expect(after.overrides.langfuse).toEqual(before.overrides.langfuse);
    });

    it('creates no role config from a Langfuse-only generic write', async () => {
      const principalId = nextPrincipalId();
      const patchRes = mockRes();
      await handlers.patchConfigField(
        mockReq({
          params: { principalType: 'role', principalId },
          body: { entries: [{ fieldPath: secretPath, value: SECRET }] },
        }),
        patchRes,
      );
      const upsertRes = mockRes();
      await handlers.upsertConfigOverrides(
        mockReq({
          params: { principalType: 'role', principalId },
          body: { overrides: { langfuse: { publicKey: 'pk-lf-1', secretKey: SECRET } } },
        }),
        upsertRes,
      );

      expect(patchRes.statusCode).toBe(200);
      expect(upsertRes.statusCode).toBe(200);
      expect(await mongoose.models.Config.exists({ principalId })).toBeNull();
    });
  });

  describe.each(PLACEHOLDER_CASES)('$path env placeholder', ({ path, placeholder }) => {
    it('stores and returns `${ENV_VAR}` references without encryption or redaction', async () => {
      const principalId = nextPrincipalId();
      await handlers.patchConfigField(
        mockReq({
          params: { principalType: 'role', principalId },
          body: { entries: [{ fieldPath: path, value: placeholder }] },
        }),
        mockRes(),
      );

      const overrides = await readRawOverrides(principalId);
      expect(getAtPath(overrides, path)).toBe(placeholder);

      const getRes = mockRes();
      await handlers.getConfig(mockReq({ params: { principalType: 'role', principalId } }), getRes);
      const responseOverrides = (getRes.body!.config as { overrides: Record<string, unknown> })
        .overrides;
      expect(getAtPath(responseOverrides, path)).toBe(placeholder);
    });
  });

  describe('legacy plaintext literals stored before encryption existed', () => {
    it('never returns a plaintext literal stored directly on the config document', async () => {
      const principalId = nextPrincipalId();
      await mongoose.models.Config.create({
        principalType: 'role',
        principalId,
        principalModel: 'Role',
        priority: 10,
        overrides: {
          speech: { tts: { openai: { apiKey: SECRET, model: 'tts-1' } } },
          ocr: { apiKey: SECRET },
          webSearch: { serperApiKey: SECRET, searchProvider: 'serper' },
        },
      });

      const getRes = mockRes();
      await handlers.getConfig(mockReq({ params: { principalType: 'role', principalId } }), getRes);
      expect(getRes.statusCode).toBe(200);
      expect(JSON.stringify(getRes.body)).not.toContain(SECRET);
      const overrides = (getRes.body!.config as { overrides: Record<string, unknown> }).overrides;
      expect(getAtPath(overrides, 'speech.tts.openai.model')).toBe('tts-1');
      expect(getAtPath(overrides, 'webSearch.searchProvider')).toBe('serper');
      // Documents written before this field existed have no preview companion at all.
      // Redaction must not fabricate one — it only ever copies forward a companion
      // that a prior encrypt actually wrote.
      expect(getAtPath(overrides, 'speech.tts.openai.apiKeyPreview')).toBeUndefined();
      expect(getAtPath(overrides, 'ocr.apiKeyPreview')).toBeUndefined();
      expect(getAtPath(overrides, 'webSearch.serperApiKeyPreview')).toBeUndefined();

      const listRes = mockRes();
      await handlers.listConfigs(mockReq(), listRes);
      expect(JSON.stringify(listRes.body)).not.toContain(SECRET);
    });
  });

  describe('getBaseConfig', () => {
    it('redacts literal secrets sourced from the resolved AppConfig (e.g. YAML literals)', async () => {
      const appConfig = {
        speech: {
          tts: {
            openai: { apiKey: SECRET, apiKeyPreview: getSecretPreview(SECRET), model: 'tts-1' },
          },
        },
        ocr: { apiKey: '${OCR_API_KEY}' },
        webSearch: { serperApiKey: SECRET, searchProvider: 'serper' },
        langfuse: { publicKey: 'pk-lf-1', secretKey: 'v3:stored', secretKeyPreview: 'sk-...ret' },
        paths: { uploads: '/tmp' },
        config: {
          speech: { tts: { openai: { apiKey: SECRET, model: 'tts-1' } } },
        },
      };
      const { createAdminConfigHandlers } = await import('./config');
      const baseHandlers = createAdminConfigHandlers({
        listAllConfigs: async () => [],
        findConfigByPrincipal: async () => null,
        upsertConfig: async () => null,
        patchConfigFields: async () => null,
        tombstoneConfigField: async () => null,
        unsetConfigField: async () => null,
        deleteConfig: async () => null,
        toggleConfigActive: async () => null,
        hasConfigCapability: async () => true,
        hasAnyConfigReadAccess: async () => true,
        hasCapability: async () => true,
        getAppConfig: async () => appConfig as never,
      });

      const res = mockRes();
      await baseHandlers.getBaseConfig(mockReq(), res);
      expect(res.statusCode).toBe(200);
      const payload = JSON.stringify(res.body);
      expect(payload).not.toContain(SECRET);
      expect(payload).not.toContain('v3:stored');
      const config = res.body!.config as Record<string, unknown>;
      expect(getAtPath(config, 'ocr.apiKey')).toBe('${OCR_API_KEY}');
      expect(getAtPath(config, 'speech.tts.openai.model')).toBe('tts-1');
      expect(getAtPath(config, 'speech.tts.openai.apiKey')).toBeUndefined();
      expect(getAtPath(config, 'speech.tts.openai.apiKeyPreview')).toBe(getSecretPreview(SECRET));
      expect(getAtPath(config, 'langfuse.secretKeyPreview')).toBe('sk-...ret');
      expect(getAtPath(config, 'config.speech.tts.openai.apiKey')).toBeUndefined();
    });
  });
});
