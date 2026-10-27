import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { Config } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV = process.env.CREDS_IV ?? '0123456789abcdef0123456789abcdef';
/** An Azure group a write stores must resolve, its `${AZURE_API_KEY}` included. */
process.env.AZURE_API_KEY = process.env.AZURE_API_KEY ?? 'test-azure-key';

type DataSchemas = typeof import('@librechat/data-schemas');
type ConfigMethods = ReturnType<DataSchemas['createMethods']>;
type AdminConfigHandlers = ReturnType<typeof import('./config').createAdminConfigHandlers>;

let mongoServer: MongoMemoryServer;
let handlers: AdminConfigHandlers;
let basePrincipalId: string;
let decryptV3: DataSchemas['decryptV3'];
let loadOCRConfig: DataSchemas['loadOCRConfig'];
let loadWebSearchConfig: DataSchemas['loadWebSearchConfig'];
let patchConfigFields: ConfigMethods['patchConfigFields'];
let getSecretPreview: typeof import('./secrets').getSecretPreview;
let encryptConfigSecretFields: typeof import('./secrets').encryptConfigSecretFields;
let UNPREVIEWED_SECRET_MASK: string;
let createAdminConfigHandlers: typeof import('./config').createAdminConfigHandlers;
let configMethods: ConfigMethods;

/** Env names the generic config API may reference in these tests, as an operator would list them. */
const ENV_ALLOWLIST = [
  'OCR_API_KEY TTS_API_KEY SERPER_API_KEY MCP_KEY KEENABLE_API_KEY',
  'SEARXNG_INSTANCE_URL SEARXNG_API_KEY OTHER_SERVICE_URL',
].join(' ');

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
    siblingPath: 'speech.tts.azureOpenAI.apiVersion',
    siblingValue: '2024-10-21',
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
    siblingPath: 'speech.tts.localai.backend',
    siblingValue: 'coqui',
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
    siblingPath: 'speech.stt.azureOpenAI.apiVersion',
    siblingValue: '2024-10-21',
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
    siblingPath: 'webSearch.safeSearch',
    siblingValue: 2,
  },
  {
    path: 'webSearch.firecrawlApiKey',
    previewPath: 'webSearch.firecrawlApiKeyPreview',
    section: 'webSearch',
    object: { firecrawlApiKey: SECRET, firecrawlApiUrl: 'https://api.firecrawl.dev' },
    siblingPath: 'webSearch.firecrawlVersion',
    siblingValue: 'v2',
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
    path: 'webSearch.keenableApiKey',
    previewPath: 'webSearch.keenableApiKeyPreview',
    section: 'webSearch',
    object: { keenableApiKey: SECRET, keenableApiUrl: 'https://api.keenable.ai' },
    siblingPath: 'webSearch.scraperTimeout',
    siblingValue: 9000,
  },
  {
    path: 'webSearch.jinaApiKey',
    previewPath: 'webSearch.jinaApiKeyPreview',
    section: 'webSearch',
    object: { jinaApiKey: SECRET, jinaApiUrl: 'https://r.jina.ai' },
    siblingPath: 'webSearch.rerankerType',
    siblingValue: 'jina',
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
  { path: 'webSearch.keenableApiKey', placeholder: '${KEENABLE_API_KEY}' },
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

/** The parts of a served config these tests read. */
type AppConfigShape = {
  endpoints?: { custom?: Array<Record<string, unknown> & { name: string }> };
};

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
  ({
    decryptV3,
    loadOCRConfig,
    loadWebSearchConfig,
    BASE_CONFIG_PRINCIPAL_ID: basePrincipalId,
  } = dataSchemas);
  jest.spyOn(dataSchemas.logger, 'error').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'warn').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'info').mockReturnValue(dataSchemas.logger);
  jest.spyOn(dataSchemas.logger, 'debug').mockReturnValue(dataSchemas.logger);

  ({ createAdminConfigHandlers } = await import('./config'));
  ({ getSecretPreview, encryptConfigSecretFields, UNPREVIEWED_SECRET_MASK } = await import(
    './secrets'
  ));

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  configMethods = dataSchemas.createMethods(mongoose);
  ({ patchConfigFields } = configMethods);

  handlers = createRealHandlers();
});

/** Handlers over the real Config collection; `getAppConfig` supplies a librechat.yaml base. */
function createRealHandlers(
  overrides: Partial<Parameters<typeof createAdminConfigHandlers>[0]> = {},
): AdminConfigHandlers {
  return createAdminConfigHandlers({
    listAllConfigs: configMethods.listAllConfigs,
    findConfigByPrincipal: configMethods.findConfigByPrincipal,
    writeConfigDocument: configMethods.writeConfigDocument,
    unsetConfigField: configMethods.unsetConfigField,
    deleteConfig: configMethods.deleteConfig,
    toggleConfigActiveTracked: configMethods.toggleConfigActiveTracked,
    hasConfigCapability: async () => true,
    hasAnyConfigReadAccess: async () => true,
    hasCapability: async () => true,
    overrideEnvAllowlist: ENV_ALLOWLIST,
    ...overrides,
  });
}

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
    const LEGACY_KEENABLE_KEY = 'kn-legacy-plain-0002';

    async function createLegacyConfig(principalId: string): Promise<void> {
      await mongoose.models.Config.create({
        principalType: 'role',
        principalId,
        principalModel: 'Role',
        priority: 10,
        overrides: {
          speech: { tts: { openai: { apiKey: SECRET, model: 'tts-1' } } },
          ocr: { apiKey: SECRET },
          webSearch: {
            serperApiKey: SECRET,
            searchProvider: 'serper',
            keenableApiKey: LEGACY_KEENABLE_KEY,
            keenableApiUrl: 'https://keenable.example.com',
          },
        },
      });
    }

    async function readOverrides(principalId: string): Promise<Record<string, unknown>> {
      const getRes = mockRes();
      await handlers.getConfig(mockReq({ params: { principalType: 'role', principalId } }), getRes);
      expect(getRes.statusCode).toBe(200);
      expect(JSON.stringify(getRes.body)).not.toContain(SECRET);
      expect(JSON.stringify(getRes.body)).not.toContain(LEGACY_KEENABLE_KEY);
      return (getRes.body!.config as { overrides: Record<string, unknown> }).overrides;
    }

    it('shows a plaintext literal stored on the config document as set, never its value', async () => {
      const principalId = nextPrincipalId();
      await createLegacyConfig(principalId);

      const overrides = await readOverrides(principalId);
      expect(getAtPath(overrides, 'speech.tts.openai.model')).toBe('tts-1');
      expect(getAtPath(overrides, 'webSearch.searchProvider')).toBe('serper');
      // The runtime still reads these values, so the read shows the preview their next save writes.
      expect(getAtPath(overrides, 'speech.tts.openai.apiKeyPreview')).toBe(
        getSecretPreview(SECRET),
      );
      expect(getAtPath(overrides, 'ocr.apiKeyPreview')).toBe(getSecretPreview(SECRET));
      expect(getAtPath(overrides, 'webSearch.serperApiKeyPreview')).toBe(getSecretPreview(SECRET));
      expect(getAtPath(overrides, 'webSearch.keenableApiKey')).toBeUndefined();
      expect(getAtPath(overrides, 'webSearch.keenableApiKeyPreview')).toBe('...0002');

      const listRes = mockRes();
      await handlers.listConfigs(mockReq(), listRes);
      expect(JSON.stringify(listRes.body)).not.toContain(SECRET);
      expect(JSON.stringify(listRes.body)).not.toContain(LEGACY_KEENABLE_KEY);
    });

    it('keeps showing a legacy Keenable key after an unrelated patch, and encrypts it on a section save', async () => {
      const principalId = nextPrincipalId();
      await createLegacyConfig(principalId);

      const patchRes = mockRes();
      await handlers.patchConfigField(
        mockReq({
          params: { principalType: 'role', principalId },
          body: { entries: [{ fieldPath: 'webSearch.scraperTimeout', value: 9000 }] },
        }),
        patchRes,
      );
      expect(patchRes.statusCode).toBe(200);
      expect(JSON.stringify(patchRes.body)).not.toContain(LEGACY_KEENABLE_KEY);
      expect(
        getAtPath(
          (patchRes.body!.config as { overrides: Record<string, unknown> }).overrides,
          'webSearch.keenableApiKeyPreview',
        ),
      ).toBe('...0002');
      expect(getAtPath(await readOverrides(principalId), 'webSearch.keenableApiKeyPreview')).toBe(
        '...0002',
      );

      const webSearch = getAtPath(await readOverrides(principalId), 'webSearch');
      const saveRes = mockRes();
      await handlers.patchConfigField(
        mockReq({
          params: { principalType: 'role', principalId },
          body: { entries: [{ fieldPath: 'webSearch', value: webSearch }] },
        }),
        saveRes,
      );
      expect(saveRes.statusCode).toBe(200);

      const raw = await readRawOverrides(principalId);
      expect(getAtPath(raw, 'webSearch.keenableApiKey')).toMatch(/^v3:/);
      expect(decryptV3(getAtPath(raw, 'webSearch.keenableApiKey') as string)).toBe(
        LEGACY_KEENABLE_KEY,
      );
      expect(getAtPath(raw, 'webSearch.keenableApiKeyPreview')).toBe('...0002');
    });
  });

  describe('a write that sends a stored web search key to a new URL', () => {
    const STORED_KEY = 'sx-stored-secret-0001';
    const STORED_URL = 'https://searx.example.com/base';
    const NEW_URL = 'https://collector.example.com';
    const SEARXNG_REENTRY = {
      path: 'webSearch.searxngInstanceUrl',
      segments: ['webSearch', 'searxngInstanceUrl'],
      code: 'secret_reentry_required',
      secretPath: 'webSearch.searxngApiKey',
    };

    type Entry = { value: unknown } & ({ fieldPath: string } | { segments: string[] });

    async function patch(principalId: string, entries: Entry[]): Promise<MockRes> {
      const res = mockRes();
      await handlers.patchConfigField(
        mockReq({ params: { principalType: 'role', principalId }, body: { entries } }),
        res,
      );
      return res;
    }

    async function replace(principalId: string, overrides: Record<string, unknown>) {
      const res = mockRes();
      await handlers.upsertConfigOverrides(
        mockReq({ params: { principalType: 'role', principalId }, body: { overrides } }),
        res,
      );
      return res;
    }

    async function storeSearxng(principalId: string): Promise<RawConfig> {
      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: STORED_URL },
        { fieldPath: 'webSearch.searxngApiKey', value: STORED_KEY },
      ]);
      expect(res.statusCode).toBe(200);
      return readRawConfig(principalId);
    }

    /** The response a rejected write must give: paths and a stable code, never the key or the new URL. */
    function reentryRequired(issues: Array<typeof SEARXNG_REENTRY>) {
      return {
        statusCode: 400,
        body: { error: expect.any(String), code: 'CONFIG_SECRET_REENTRY_REQUIRED', issues },
        payload: expect.not.stringMatching(new RegExp(`${STORED_KEY}|${NEW_URL}`)),
      };
    }

    function response(res: MockRes) {
      return { statusCode: res.statusCode, body: res.body, payload: JSON.stringify(res.body) };
    }

    it('rejects a dotted patch that changes only the URL and writes nothing', async () => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
      ]);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('judges a patch by the URL it stores when a later entry replaces an earlier one', async () => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: STORED_URL },
        { fieldPath: 'webSearch', value: { searxngInstanceUrl: NEW_URL } },
      ]);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    describe.each([
      { name: 'dotted paths', segmentedKey: false, segmentedSection: false },
      { name: 'segment paths', segmentedKey: true, segmentedSection: true },
      { name: 'segmented key and dotted section', segmentedKey: true, segmentedSection: false },
      { name: 'dotted key and segmented section', segmentedKey: false, segmentedSection: true },
    ])('overlapping writes with $name', ({ segmentedKey, segmentedSection }) => {
      const REENTERED_KEY = 'sx-reentered-0002';
      const keyTarget = segmentedKey
        ? { segments: ['webSearch', 'searxngApiKey'] }
        : { fieldPath: 'webSearch.searxngApiKey' };
      const sectionTarget = segmentedSection
        ? { segments: ['webSearch'] }
        : { fieldPath: 'webSearch' };
      const replacement = (url: string): Entry => ({
        ...sectionTarget,
        value: {
          searxngInstanceUrl: url,
          searchProvider: 'searxng',
          scraperProvider: 'keenable',
          rerankerType: 'none',
        },
      });
      const key: Entry = { ...keyTarget, value: REENTERED_KEY };

      it('rejects a key entry overwritten by a section that restores the stored key', async () => {
        const principalId = nextPrincipalId();
        const before = await storeSearxng(principalId);

        const res = await patch(principalId, [key, replacement(NEW_URL)]);

        expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
        expect(await readRawConfig(principalId)).toEqual(before);
      });

      it('accepts a key entered after the section and stores only that key', async () => {
        const principalId = nextPrincipalId();
        const before = await storeSearxng(principalId);

        const res = await patch(principalId, [replacement(NEW_URL), key]);

        expect(res.statusCode).toBe(200);
        const after = await readRawOverrides(principalId);
        const ciphertext = getAtPath(after, 'webSearch.searxngApiKey');
        expect(getAtPath(after, 'webSearch.searxngInstanceUrl')).toBe(NEW_URL);
        expect(ciphertext).not.toBe(getAtPath(before.overrides, 'webSearch.searxngApiKey'));
        expect(decryptV3(ciphertext as string)).toBe(REENTERED_KEY);
        expect(getAtPath(after, 'webSearch.searxngApiKeyPreview')).toBe(
          getSecretPreview(REENTERED_KEY),
        );
        expect(JSON.stringify(res.body)).not.toContain(REENTERED_KEY);
      });

      it('preserves the stored ciphertext and preview when the destination stays', async () => {
        const principalId = nextPrincipalId();
        const before = await storeSearxng(principalId);

        const res = await patch(principalId, [key, replacement(STORED_URL)]);

        expect(res.statusCode).toBe(200);
        const after = await readRawOverrides(principalId);
        for (const field of ['searxngInstanceUrl', 'searxngApiKey', 'searxngApiKeyPreview']) {
          expect(getAtPath(after, `webSearch.${field}`)).toBe(
            getAtPath(before.overrides, `webSearch.${field}`),
          );
        }
      });

      it('rechecks a restored key after a revision conflict', async () => {
        const principalId = nextPrincipalId();
        const before = await storeSearxng(principalId);
        const concurrentFields = encryptConfigSecretFields({
          'webSearch.searxngInstanceUrl': 'https://searx.example.com/concurrent',
          'webSearch.searxngApiKey': 'sx-concurrent-0003',
        });
        const write = jest.fn<
          ReturnType<ConfigMethods['writeConfigDocument']>,
          Parameters<ConfigMethods['writeConfigDocument']>
        >(async (...args) => {
          await patchConfigFields(
            PrincipalType.ROLE,
            principalId,
            PrincipalModel.ROLE,
            concurrentFields,
          );
          return configMethods.writeConfigDocument(...args);
        });
        const racing = createRealHandlers({ writeConfigDocument: write });
        const res = mockRes();

        await racing.patchConfigField(
          mockReq({
            params: { principalType: 'role', principalId },
            body: { entries: [key, replacement(STORED_URL)] },
          }),
          res,
        );

        expect(write).toHaveBeenCalledTimes(1);
        expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
        const after = await readRawOverrides(principalId);
        expect(getAtPath(after, 'webSearch.searxngInstanceUrl')).toBe(
          concurrentFields['webSearch.searxngInstanceUrl'],
        );
        expect(getAtPath(after, 'webSearch.searxngApiKey')).toBe(
          concurrentFields['webSearch.searxngApiKey'],
        );
        expect(decryptV3(getAtPath(after, 'webSearch.searxngApiKey') as string)).toBe(
          'sx-concurrent-0003',
        );
        expect(getAtPath(after, 'webSearch.searxngApiKey')).not.toBe(
          getAtPath(before.overrides, 'webSearch.searxngApiKey'),
        );
      });
    });

    it('rejects a section patch that changes the URL and omits the key', async () => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch', value: { searxngInstanceUrl: NEW_URL, safeSearch: 2 } },
      ]);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('rejects a full replace that changes the URL and omits the key', async () => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await replace(principalId, { webSearch: { searxngInstanceUrl: NEW_URL } });

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('rejects adding a URL beside a key the document already stores', async () => {
      const principalId = nextPrincipalId();
      expect(
        (await patch(principalId, [{ fieldPath: 'webSearch.searxngApiKey', value: STORED_KEY }]))
          .statusCode,
      ).toBe(200);
      const before = await readRawConfig(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
      ]);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('names the shared Tavily key once for each URL that changed', async () => {
      const principalId = nextPrincipalId();
      const stored = await patch(principalId, [
        { fieldPath: 'webSearch.tavilySearchUrl', value: 'https://tavily.example.com/search' },
        { fieldPath: 'webSearch.tavilyExtractUrl', value: 'https://tavily.example.com/extract' },
        { fieldPath: 'webSearch.tavilyApiKey', value: STORED_KEY },
      ]);
      expect(stored.statusCode).toBe(200);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.tavilySearchUrl', value: `${NEW_URL}/search` },
        { fieldPath: 'webSearch.tavilyExtractUrl', value: `${NEW_URL}/extract` },
      ]);

      expect(response(res)).toEqual(
        reentryRequired([
          {
            path: 'webSearch.tavilySearchUrl',
            segments: ['webSearch', 'tavilySearchUrl'],
            code: 'secret_reentry_required',
            secretPath: 'webSearch.tavilyApiKey',
          },
          {
            path: 'webSearch.tavilyExtractUrl',
            segments: ['webSearch', 'tavilyExtractUrl'],
            code: 'secret_reentry_required',
            secretPath: 'webSearch.tavilyApiKey',
          },
        ]),
      );
    });

    it('rejects a URL change beside a plaintext key stored before encryption existed', async () => {
      const principalId = nextPrincipalId();
      await mongoose.models.Config.create({
        principalType: 'role',
        principalId,
        principalModel: 'Role',
        priority: 10,
        overrides: {
          webSearch: {
            keenableApiKey: 'kn-legacy-plain-0003',
            keenableApiUrl: 'https://keenable.example.com',
          },
        },
      });
      const before = await readRawConfig(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.keenableApiUrl', value: NEW_URL },
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.body!.issues).toEqual([
        {
          path: 'webSearch.keenableApiUrl',
          segments: ['webSearch', 'keenableApiUrl'],
          code: 'secret_reentry_required',
          secretPath: 'webSearch.keenableApiKey',
        },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('kn-legacy-plain-0003');
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('stores a new URL with the key entered again in the same write', async () => {
      const principalId = nextPrincipalId();
      await storeSearxng(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
        { fieldPath: 'webSearch.searxngApiKey', value: 'sx-reentered-0002' },
      ]);

      expect(res.statusCode).toBe(200);
      const overrides = await readRawOverrides(principalId);
      expect(getAtPath(overrides, 'webSearch.searxngInstanceUrl')).toBe(NEW_URL);
      expect(decryptV3(getAtPath(overrides, 'webSearch.searxngApiKey') as string)).toBe(
        'sx-reentered-0002',
      );
    });

    it('stores a new URL in a full replace that enters the key again', async () => {
      const principalId = nextPrincipalId();
      await storeSearxng(principalId);

      const res = await replace(principalId, {
        webSearch: { searxngInstanceUrl: NEW_URL, searxngApiKey: 'sx-reentered-0003' },
      });

      expect(res.statusCode).toBe(200);
      const overrides = await readRawOverrides(principalId);
      expect(decryptV3(getAtPath(overrides, 'webSearch.searxngApiKey') as string)).toBe(
        'sx-reentered-0003',
      );
    });

    it.each([
      {
        name: 'points the URL at the environment',
        entries: [{ fieldPath: 'webSearch.searxngInstanceUrl', value: '${SEARXNG_INSTANCE_URL}' }],
      },
      {
        name: 'blanks the URL',
        entries: [{ fieldPath: 'webSearch.searxngInstanceUrl', value: '' }],
      },
      {
        name: 'replaces the section without the URL',
        entries: [{ fieldPath: 'webSearch', value: { safeSearch: 2 } }],
      },
    ])('rejects a write that $name while the key stays', async ({ entries }) => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await patch(principalId, entries);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('rejects a full replace whose section drops the URL while the key stays', async () => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await replace(principalId, { webSearch: { safeSearch: 2 } });

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('rejects pointing an environment URL at another variable beside a stored key', async () => {
      const principalId = nextPrincipalId();
      await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: '${SEARXNG_INSTANCE_URL}' },
        { fieldPath: 'webSearch.searxngApiKey', value: STORED_KEY },
      ]);
      const before = await readRawConfig(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: '${OTHER_SERVICE_URL}' },
      ]);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it.each([
      {
        name: 'clears the key',
        entries: [
          { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
          { fieldPath: 'webSearch.searxngApiKey', value: '' },
        ],
      },
      {
        name: 'turns the key into an environment reference',
        entries: [
          { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
          { fieldPath: 'webSearch.searxngApiKey', value: '${SEARXNG_API_KEY}' },
        ],
      },
      {
        name: 'points the URL at the environment and enters the key again',
        entries: [
          { fieldPath: 'webSearch.searxngInstanceUrl', value: '${SEARXNG_INSTANCE_URL}' },
          { fieldPath: 'webSearch.searxngApiKey', value: 'sx-reentered-0004' },
        ],
      },
      {
        name: 'writes the same URL again',
        entries: [{ fieldPath: 'webSearch.searxngInstanceUrl', value: STORED_URL }],
      },
      {
        name: 'replaces the section with the URL and without the key',
        entries: [
          { fieldPath: 'webSearch', value: { searxngInstanceUrl: STORED_URL, safeSearch: 2 } },
        ],
      },
    ])('accepts a write that $name', async ({ entries }) => {
      const principalId = nextPrincipalId();
      await storeSearxng(principalId);

      const res = await patch(principalId, entries);

      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(STORED_KEY);
    });

    async function removeField(
      principalId: string,
      fieldPath: string,
      tombstone: boolean,
    ): Promise<MockRes> {
      const res = mockRes();
      const params = { principalType: 'role', principalId };
      if (tombstone) {
        await handlers.tombstoneConfigField(mockReq({ params, body: { fieldPath } }), res);
      } else {
        await handlers.deleteConfigField(mockReq({ params, query: { fieldPath } }), res);
      }
      return res;
    }

    it.each([
      { name: 'deleting', tombstone: false },
      { name: 'tombstoning', tombstone: true },
    ])('rejects $name the URL beside a stored key and writes nothing', async ({ tombstone }) => {
      const principalId = nextPrincipalId();
      const before = await storeSearxng(principalId);

      const res = await removeField(principalId, 'webSearch.searxngInstanceUrl', tombstone);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('rejects deleting a URL tombstone, which restores the inherited URL, beside a stored key', async () => {
      const principalId = nextPrincipalId();
      await patch(principalId, [{ fieldPath: 'webSearch.searxngApiKey', value: STORED_KEY }]);
      await configMethods.tombstoneConfigField(
        PrincipalType.ROLE,
        principalId,
        PrincipalModel.ROLE,
        'webSearch.searxngInstanceUrl',
        10,
      );
      const before = await readRawConfig(principalId);

      const res = await removeField(principalId, 'webSearch.searxngInstanceUrl', false);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it('rejects setting a URL the document tombstones beside a stored key', async () => {
      const principalId = nextPrincipalId();
      await configMethods.tombstoneConfigField(
        PrincipalType.ROLE,
        principalId,
        PrincipalModel.ROLE,
        'webSearch.searxngInstanceUrl',
        10,
      );
      expect(
        (await patch(principalId, [{ fieldPath: 'webSearch.searxngApiKey', value: STORED_KEY }]))
          .statusCode,
      ).toBe(200);
      const before = await readRawConfig(principalId);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
      ]);

      expect(response(res)).toEqual(reentryRequired([SEARXNG_REENTRY]));
      expect(await readRawConfig(principalId)).toEqual(before);
    });

    it.each([
      { name: 'deletes', tombstone: false },
      { name: 'tombstones', tombstone: true },
    ])('$name the URL once the key is removed first', async ({ tombstone }) => {
      const principalId = nextPrincipalId();
      await storeSearxng(principalId);

      expect((await removeField(principalId, 'webSearch.searxngApiKey', false)).statusCode).toBe(
        200,
      );
      const res = await removeField(principalId, 'webSearch.searxngInstanceUrl', tombstone);

      expect(res.statusCode).toBe(200);
      const overrides = await readRawOverrides(principalId);
      expect(getAtPath(overrides, 'webSearch.searxngInstanceUrl')).toBeUndefined();
      expect(getAtPath(overrides, 'webSearch.searxngApiKey')).toBeUndefined();
    });

    it('removes the whole section with its key', async () => {
      const principalId = nextPrincipalId();
      await storeSearxng(principalId);

      const res = await removeField(principalId, 'webSearch', false);

      expect(res.statusCode).toBe(200);
      expect(getAtPath(await readRawOverrides(principalId), 'webSearch')).toBeUndefined();
    });

    it('accepts a URL change where no key is stored beside it', async () => {
      const principalId = nextPrincipalId();
      await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: STORED_URL },
        { fieldPath: 'webSearch.searxngApiKey', value: '${SEARXNG_API_KEY}' },
      ]);

      const res = await patch(principalId, [
        { fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL },
      ]);

      expect(res.statusCode).toBe(200);
      expect(getAtPath(await readRawOverrides(principalId), 'webSearch.searxngInstanceUrl')).toBe(
        NEW_URL,
      );
    });

    describe('when another admin stores a key between the check and the write', () => {
      const VICTIM_URL = 'https://searx.example.com/victim';
      const VICTIM_KEY = 'sx-victim-key-0005';

      /** Handlers whose next config read is followed by another admin's URL-and-key write. */
      function racedHandlers(principalId: string): AdminConfigHandlers {
        let raced = false;
        return createRealHandlers({
          findConfigByPrincipal: async (...args) => {
            const config = await configMethods.findConfigByPrincipal(...args);
            if (!raced) {
              raced = true;
              await configMethods.patchConfigFields(
                PrincipalType.ROLE,
                principalId,
                PrincipalModel.ROLE,
                encryptConfigSecretFields({
                  'webSearch.searxngInstanceUrl': VICTIM_URL,
                  'webSearch.searxngApiKey': VICTIM_KEY,
                }),
                10,
              );
            }
            return config;
          },
        });
      }

      /** The response and the stored URL and key once the raced write returned. */
      async function outcome(principalId: string, res: MockRes) {
        const overrides = await readRawOverrides(principalId);
        const key = getAtPath(overrides, 'webSearch.searxngApiKey');
        return {
          statusCode: res.statusCode,
          body: res.body,
          url: getAtPath(overrides, 'webSearch.searxngInstanceUrl'),
          key: typeof key === 'string' ? decryptV3(key) : key,
        };
      }

      /**
       * The write lost the compare-and-swap, re-read the document and re-ran the check, which
       * now sees the other admin's key beside the URL this write changes.
       */
      const VICTIM_KEPT = {
        statusCode: 400,
        body: expect.objectContaining({ code: 'CONFIG_SECRET_REENTRY_REQUIRED' }),
        url: VICTIM_URL,
        key: VICTIM_KEY,
      };

      /** A write pinned to the revision it read answers 409 instead of re-checking. */
      const VICTIM_KEPT_PINNED = {
        statusCode: 409,
        body: expect.objectContaining({ code: 'CONFIG_VERSION_CONFLICT' }),
        url: VICTIM_URL,
        key: VICTIM_KEY,
      };

      const params = (principalId: string) => ({ principalType: 'role', principalId });

      /** The revision the next write is pinned to: the document as stored now. */
      async function currentRevision(principalId: string): Promise<string> {
        const stored = await configMethods.findConfigByPrincipal(PrincipalType.ROLE, principalId, {
          includeInactive: true,
        });
        return stored ? `${stored._id}:${stored.configVersion}` : 'absent';
      }

      it.each([
        { name: 'on an existing document', existing: true },
        { name: 'on a document created meanwhile', existing: false },
      ])('rejects a URL-only patch $name', async ({ existing }) => {
        const principalId = nextPrincipalId();
        if (existing) {
          await patch(principalId, [{ fieldPath: 'webSearch.safeSearch', value: 1 }]);
        }
        const res = mockRes();

        await racedHandlers(principalId).patchConfigField(
          mockReq({
            params: params(principalId),
            body: { entries: [{ fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL }] },
          }),
          res,
        );

        expect(await outcome(principalId, res)).toEqual(VICTIM_KEPT);
      });

      it('rejects a full replace that sets only the URL', async () => {
        const principalId = nextPrincipalId();
        await patch(principalId, [{ fieldPath: 'webSearch.safeSearch', value: 1 }]);
        const res = mockRes();

        await racedHandlers(principalId).upsertConfigOverrides(
          mockReq({
            params: params(principalId),
            body: { overrides: { webSearch: { searxngInstanceUrl: NEW_URL } } },
          }),
          res,
        );

        expect(await outcome(principalId, res)).toEqual(VICTIM_KEPT);
      });

      it.each([
        { name: 'deleting', handler: 'deleteConfigField' as const },
        { name: 'tombstoning', handler: 'tombstoneConfigField' as const },
      ])('rejects $name the URL', async ({ handler }) => {
        const principalId = nextPrincipalId();
        await patch(principalId, [{ fieldPath: 'webSearch.safeSearch', value: 1 }]);
        const res = mockRes();
        const fieldPath = 'webSearch.searxngInstanceUrl';

        await racedHandlers(principalId)[handler](
          mockReq({ params: params(principalId), query: { fieldPath }, body: { fieldPath } }),
          res,
        );

        expect(await outcome(principalId, res)).toEqual(VICTIM_KEPT);
      });

      it.each([
        { name: 'on an existing document', existing: true },
        { name: 'on a document created meanwhile', existing: false },
      ])(
        'answers 409 to a URL-only patch pinned to the revision it read $name',
        async ({ existing }) => {
          const principalId = nextPrincipalId();
          if (existing) {
            await patch(principalId, [{ fieldPath: 'webSearch.safeSearch', value: 1 }]);
          }
          const expectedRevision = await currentRevision(principalId);
          const res = mockRes();

          await racedHandlers(principalId).patchConfigField(
            mockReq({
              params: params(principalId),
              body: {
                entries: [{ fieldPath: 'webSearch.searxngInstanceUrl', value: NEW_URL }],
                expectedRevision,
              },
            }),
            res,
          );

          expect(await outcome(principalId, res)).toEqual(VICTIM_KEPT_PINNED);
        },
      );

      it.each([
        { name: 'deleting', handler: 'deleteConfigField' as const },
        { name: 'tombstoning', handler: 'tombstoneConfigField' as const },
      ])('answers 409 to $name the URL pinned to the revision it read', async ({ handler }) => {
        const principalId = nextPrincipalId();
        await patch(principalId, [{ fieldPath: 'webSearch.safeSearch', value: 1 }]);
        const expectedRevision = await currentRevision(principalId);
        const res = mockRes();
        const fieldPath = 'webSearch.searxngInstanceUrl';

        await racedHandlers(principalId)[handler](
          mockReq({
            params: params(principalId),
            query: { fieldPath, expectedRevision },
            body: { fieldPath, expectedRevision },
          }),
          res,
        );

        expect(await outcome(principalId, res)).toEqual(VICTIM_KEPT_PINNED);
      });

      it('lets a write to another section proceed', async () => {
        const principalId = nextPrincipalId();
        await patch(principalId, [{ fieldPath: 'webSearch.safeSearch', value: 1 }]);
        const res = mockRes();

        await racedHandlers(principalId).patchConfigField(
          mockReq({
            params: params(principalId),
            body: { entries: [{ fieldPath: 'webSearch.safeSearch', value: 2 }] },
          }),
          res,
        );

        expect(res.statusCode).toBe(200);
        expect(getAtPath(await readRawOverrides(principalId), 'webSearch.safeSearch')).toBe(2);
      });
    });
  });

  describe('getBaseConfig', () => {
    afterEach(() => {
      delete process.env.WEST_AZURE_API_KEY;
    });

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
        writeConfigDocument: async () => {
          throw new Error('not written in this test');
        },
        unsetConfigField: async () => null,
        deleteConfig: async () => null,
        toggleConfigActiveTracked: async () => null,
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
      /** A literal librechat.yaml supplies reads as set, with a mask derived from nothing. */
      expect(getAtPath(config, 'webSearch.serperApiKeyPreview')).toBe(UNPREVIEWED_SECRET_MASK);
      expect(getAtPath(config, 'langfuse.secretKeyPreview')).toBe('*********');
      expect(getAtPath(config, 'config.speech.tts.openai.apiKey')).toBeUndefined();
    });

    it('redacts literal Azure group keys and the Vertex service key from what AppService builds', async () => {
      const AZURE_KEY = 'azure-literal-group-key-0123456789';
      const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----vertex-test-key';
      const { AppService } = await import('@librechat/data-schemas');
      /** `azureConfigSetup` resolves each group's key reference at load, as a deployment would. */
      process.env.WEST_AZURE_API_KEY = 'west-env-value';
      const appConfig = await AppService({
        config: {
          endpoints: {
            azureOpenAI: {
              groups: [
                {
                  group: 'east',
                  apiKey: AZURE_KEY,
                  instanceName: 'east-instance',
                  version: '2024-02-01',
                  models: { 'gpt-4o': { deploymentName: 'gpt-4o' } },
                },
                {
                  group: 'west',
                  apiKey: '${WEST_AZURE_API_KEY}',
                  instanceName: 'west-instance',
                  version: '2024-02-01',
                  models: { 'gpt-4o-mini': { deploymentName: 'gpt-4o-mini' } },
                },
              ],
            },
            anthropic: {
              vertex: {
                region: 'us-east5',
                serviceKeyFile: JSON.stringify({
                  type: 'service_account',
                  private_key: PRIVATE_KEY,
                }),
                models: ['claude-sonnet-4'],
              },
            },
          },
        },
      });
      expect(JSON.stringify(appConfig)).toContain(AZURE_KEY);
      expect(JSON.stringify(appConfig)).toContain(PRIVATE_KEY);

      const { createAdminConfigHandlers } = await import('./config');
      const getAppConfig = jest.fn(async (_options?: { baseOnly?: boolean }) => appConfig);
      const baseHandlers = createAdminConfigHandlers({
        listAllConfigs: async () => [],
        findConfigByPrincipal: async () => null,
        writeConfigDocument: async () => {
          throw new Error('not written in this test');
        },
        unsetConfigField: async () => null,
        deleteConfig: async () => null,
        toggleConfigActiveTracked: async () => null,
        hasConfigCapability: async () => true,
        hasAnyConfigReadAccess: async () => true,
        hasCapability: async () => true,
        getAppConfig,
      });

      for (const query of [{}, { baseOnly: 'true' }]) {
        const res = mockRes();
        await baseHandlers.getBaseConfig(mockReq({ query }), res);
        expect(res.statusCode).toBe(200);
        const payload = JSON.stringify(res.body);
        expect(payload).not.toContain(AZURE_KEY);
        expect(payload).not.toContain(PRIVATE_KEY);

        const config = res.body!.config as Record<string, unknown>;
        expect(getAtPath(config, 'endpoints.azureOpenAI.groupMap.east.instanceName')).toBe(
          'east-instance',
        );
        expect(getAtPath(config, 'endpoints.azureOpenAI.groupMap.east.apiKey')).toBeUndefined();
        expect(getAtPath(config, 'endpoints.azureOpenAI.groupMap.west.apiKey')).toBe(
          '${WEST_AZURE_API_KEY}',
        );
        const yamlGroups = getAtPath(config, 'config.endpoints.azureOpenAI.groups') as Array<
          Record<string, unknown>
        >;
        expect(yamlGroups.map((group) => group.apiKey)).toEqual([
          undefined,
          '${WEST_AZURE_API_KEY}',
        ]);
        expect(getAtPath(config, 'endpoints.anthropic.vertexConfig.region')).toBe('us-east5');
        expect(
          getAtPath(config, 'endpoints.anthropic.vertexConfig.serviceKeyFile'),
        ).toBeUndefined();
        expect(getAtPath(config, 'endpoints.anthropic.vertex.serviceKeyFile')).toBeUndefined();
        expect(
          getAtPath(config, 'config.endpoints.anthropic.vertex.serviceKeyFile'),
        ).toBeUndefined();
      }
      expect(getAppConfig.mock.calls.map(([options]) => options?.baseOnly)).toEqual([
        false,
        true,
        true,
      ]);
      expect(JSON.stringify(appConfig)).toContain(AZURE_KEY);
    });

    it("never returns the value a Base profile's Vertex AI settings would reference", async () => {
      const DEPLOYMENT_KEY = 'sk-deployment-openai-key-0123456789';
      const saved = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        GCP_PROJECT: process.env.GCP_PROJECT,
      };
      process.env.OPENAI_API_KEY = DEPLOYMENT_KEY;
      process.env.GCP_PROJECT = 'yaml-gcp-project';
      try {
        const { AppService } = await import('@librechat/data-schemas');
        const { createAppConfigService } = await import('~/app/service');
        const { expandCustomEndpoint } = await import('~/app/params');
        const yaml = {
          endpoints: {
            anthropic: { vertex: { projectId: '${GCP_PROJECT}', models: ['claude-sonnet-4-6'] } },
          },
        };
        const vertex = {
          projectId: '${OPENAI_API_KEY}',
          deploymentName: '${OPENAI_API_KEY}',
          models: ['claude-opus-4-6'],
        };
        const entries = new Map<string, unknown>();
        const service = createAppConfigService({
          loadBaseConfig: () =>
            AppService({ config: structuredClone(yaml) as never, expandCustomEndpoint }),
          setCachedTools: async () => undefined,
          getCache: () => ({
            get: async (key: string) => entries.get(key),
            set: async (key: string, value: unknown) => entries.set(key, value),
            delete: async (key: string) => entries.delete(key),
          }),
          cacheKeys: { APP_CONFIG: 'app_config' },
          getApplicableConfigs: async () => [
            {
              principalType: PrincipalType.ROLE,
              principalId: basePrincipalId,
              principalModel: PrincipalModel.ROLE,
              priority: 0,
              isActive: true,
              overrides: { endpoints: { anthropic: { vertex } } },
            } as never,
          ],
          getUserPrincipals: async () => [],
          rederiveEndpoints: true,
        });
        const baseHandlers = createAdminConfigHandlers({
          listAllConfigs: async () => [],
          findConfigByPrincipal: async () => null,
          writeConfigDocument: async () => {
            throw new Error('not written in this test');
          },
          unsetConfigField: async () => null,
          deleteConfig: async () => null,
          toggleConfigActiveTracked: async () => null,
          hasConfigCapability: async () => true,
          hasAnyConfigReadAccess: async () => true,
          hasCapability: async () => true,
          getAppConfig: (options) => service.getAppConfig(options),
        });

        const res = mockRes();
        await baseHandlers.getBaseConfig(mockReq(), res);

        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(DEPLOYMENT_KEY);
        const vertexConfig = getAtPath(res.body!.config, 'endpoints.anthropic.vertexConfig');
        expect(vertexConfig).toMatchObject({
          projectId: 'yaml-gcp-project',
          modelNames: ['claude-opus-4-6'],
          modelDeploymentMap: { 'claude-opus-4-6': 'claude-opus-4-6' },
        });
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    });
  });
});

type MockResponse = ReturnType<typeof mockRes>;

async function send(
  handler: (req: ServerRequest, res: Response) => Promise<Response>,
  request: Record<string, unknown>,
): Promise<MockResponse> {
  const res = mockRes();
  await handler(mockReq(request), res);
  return res;
}

function patch(
  principalId: string,
  entries: Array<{ fieldPath: string; value: unknown }>,
  extra: Record<string, unknown> = {},
  target: AdminConfigHandlers = handlers,
): Promise<MockResponse> {
  return send(target.patchConfigField, {
    params: { principalType: 'role', principalId },
    body: { entries, ...extra },
  });
}

const API_KEY = 'sk-mcp-integration-secret-key';
const CLIENT_SECRET = 'oauth-integration-client-secret';

function mcpServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    apiKey: { source: 'admin', authorization_type: 'bearer', key: API_KEY },
    oauth: {
      client_id: 'client',
      client_secret: CLIENT_SECRET,
      authorization_url: 'https://auth.example.com/authorize',
      token_url: 'https://auth.example.com/token',
    },
    ...overrides,
  };
}

async function storedServer(principalId: string, name: string) {
  const overrides = await readRawOverrides(principalId);
  return getAtPath(overrides, `mcpServers.${name}`) as {
    url?: string;
    apiKey: Record<string, string>;
    oauth: Record<string, string>;
  };
}

describe('MCP server credentials — real handlers against a real Config collection', () => {
  async function seed(name = 'github'): Promise<string> {
    const principalId = nextPrincipalId();
    const res = await patch(principalId, [{ fieldPath: `mcpServers.${name}`, value: mcpServer() }]);
    expect(res.statusCode).toBe(200);
    return principalId;
  }

  it('stores both credentials encrypted, returns only previews, and keeps them across edits', async () => {
    const principalId = await seed();

    const stored = await storedServer(principalId, 'github');
    expect(decryptV3(stored.apiKey.key)).toBe(API_KEY);
    expect(stored.apiKey.keyPreview).toBe(getSecretPreview(API_KEY));
    expect(decryptV3(stored.oauth.client_secret)).toBe(CLIENT_SECRET);

    const read = await send(handlers.getConfig, { params: { principalType: 'role', principalId } });
    const payload = JSON.stringify(read.body);
    expect(payload).not.toContain(API_KEY);
    expect(payload).not.toContain(CLIENT_SECRET);
    expect(payload).not.toContain(stored.apiKey.key);
    const readServer = getAtPath(read.body!.config, 'overrides.mcpServers.github') as {
      apiKey: Record<string, string>;
      oauth: Record<string, string>;
    };
    expect(readServer.apiKey).toEqual({
      source: 'admin',
      authorization_type: 'bearer',
      keyPreview: getSecretPreview(API_KEY),
    });
    expect(readServer.oauth.client_secretPreview).toBe(getSecretPreview(CLIENT_SECRET));

    const titled = await patch(principalId, [
      { fieldPath: 'mcpServers.github.title', value: 'GitHub' },
    ]);
    expect(titled.statusCode).toBe(200);
    expect((await storedServer(principalId, 'github')).apiKey.key).toBe(stored.apiKey.key);

    /** A whole replace from the redacted read, previews and all, keeps both secrets. */
    const overrides = (read.body!.config as { overrides: Record<string, unknown> }).overrides;
    const replaced = await send(handlers.upsertConfigOverrides, {
      params: { principalType: 'role', principalId },
      body: { overrides },
    });
    expect(replaced.statusCode).toBe(200);
    const after = await storedServer(principalId, 'github');
    expect(decryptV3(after.apiKey.key)).toBe(API_KEY);
    expect(decryptV3(after.oauth.client_secret)).toBe(CLIENT_SECRET);
  });

  it('refuses ciphertext and preview writes', async () => {
    const principalId = await seed();
    const stored = await storedServer(principalId, 'github');

    const ciphertext = await patch(principalId, [
      { fieldPath: 'mcpServers.github.apiKey.key', value: stored.apiKey.key },
    ]);
    expect(ciphertext.statusCode).toBe(400);

    const preview = await patch(principalId, [
      { fieldPath: 'mcpServers.github.apiKey.keyPreview', value: '...fake' },
    ]);
    expect(preview.statusCode).toBe(400);
  });

  describe('re-entry when a stored credential would be sent somewhere new', () => {
    it('refuses a dotted URL change that keeps the stored key', async () => {
      const principalId = await seed();

      const res = await patch(principalId, [
        { fieldPath: 'mcpServers.github.url', value: 'https://evil.example/mcp' },
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringContaining('Re-enter apiKey.key'),
        code: 'MCP_API_KEY_REENTRY_REQUIRED',
        server: 'github',
        fields: ['url'],
      });
      expect((await storedServer(principalId, 'github')).url).toBe('https://mcp.example.com/mcp');
    });

    it('accepts the change once the credentials are entered again', async () => {
      const principalId = await seed();

      const res = await patch(principalId, [
        { fieldPath: 'mcpServers.github.url', value: 'https://moved.example/mcp' },
        { fieldPath: 'mcpServers.github.apiKey.key', value: 'sk-new-key-for-the-new-host' },
        { fieldPath: 'mcpServers.github.oauth.client_secret', value: 'new-client-secret' },
      ]);

      expect(res.statusCode).toBe(200);
      const stored = await storedServer(principalId, 'github');
      expect(decryptV3(stored.apiKey.key)).toBe('sk-new-key-for-the-new-host');
      expect(decryptV3(stored.oauth.client_secret)).toBe('new-client-secret');
    });

    it('refuses an OAuth endpoint change that keeps the stored client secret', async () => {
      const principalId = await seed();

      const res = await patch(principalId, [
        {
          fieldPath: 'mcpServers.github.oauth',
          value: {
            client_id: 'client',
            authorization_url: 'https://auth.example.com/authorize',
            token_url: 'https://evil.example/token',
          },
        },
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'MCP_OAUTH_SECRET_REENTRY_REQUIRED',
        fields: ['oauth.token_url'],
      });
    });

    it('refuses removing or tombstoning a binding field the stored key depends on', async () => {
      const principalId = await seed();

      const removed = await send(handlers.deleteConfigField, {
        params: { principalType: 'role', principalId },
        query: { fieldPath: 'mcpServers.github.url' },
      });
      expect(removed.statusCode).toBe(400);
      expect(removed.body).toMatchObject({ code: 'MCP_API_KEY_REENTRY_REQUIRED' });

      const tombstoned = await send(handlers.tombstoneConfigField, {
        params: { principalType: 'role', principalId },
        body: { fieldPath: 'mcpServers.github.url' },
      });
      expect(tombstoned.statusCode).toBe(400);

      const unrelated = await send(handlers.deleteConfigField, {
        params: { principalType: 'role', principalId },
        query: { fieldPath: 'mcpServers.github.oauth.client_secret' },
      });
      expect(unrelated.statusCode).toBe(200);
    });

    /**
     * Handlers over which `concurrent`, a write from another request, lands right after the
     * first time the handler reads `principalId`'s document.
     */
    function racingHandlers(
      principalId: string,
      concurrent: () => Promise<unknown>,
    ): AdminConfigHandlers {
      let raced = false;
      return createRealHandlers({
        findConfigByPrincipal: async (...args) => {
          const found = await configMethods.findConfigByPrincipal(...args);
          if (!raced && args[1] === principalId) {
            raced = true;
            await concurrent();
          }
          return found;
        },
      });
    }

    it('absorbs a concurrent write to an MCP server instead of answering 409', async () => {
      const principalId = await seed();
      const racing = racingHandlers(principalId, () =>
        patchConfigFields(PrincipalType.ROLE, principalId, PrincipalModel.ROLE, {
          'mcpServers.github.title': 'GitHub',
        }),
      );

      const removed = await send(racing.deleteConfigField, {
        params: { principalType: 'role', principalId },
        query: { fieldPath: 'mcpServers.github.oauth.client_secret' },
      });
      expect(removed.statusCode).toBe(200);

      const tombstoned = await send(
        racingHandlers(principalId, () =>
          patchConfigFields(PrincipalType.ROLE, principalId, PrincipalModel.ROLE, {
            'mcpServers.github.description': 'Code hosting',
          }),
        ).tombstoneConfigField,
        {
          params: { principalType: 'role', principalId },
          body: { fieldPath: 'mcpServers.github.iconPath' },
        },
      );
      expect(tombstoned.statusCode).toBe(200);

      const server = await storedServer(principalId, 'github');
      expect(server).toMatchObject({ title: 'GitHub', description: 'Code hosting' });
      expect(server.oauth.client_secret).toBeUndefined();
      expect(decryptV3(server.apiKey.key)).toBe(API_KEY);
    });

    it('judges the document the removal replaces, not the one it first read', async () => {
      const principalId = nextPrincipalId();
      const seeded = await patch(principalId, [
        {
          fieldPath: 'mcpServers.fresh',
          value: mcpServer({ apiKey: undefined, oauth: undefined }),
        },
      ]);
      expect(seeded.statusCode).toBe(200);
      const racing = racingHandlers(principalId, () =>
        patchConfigFields(
          PrincipalType.ROLE,
          principalId,
          PrincipalModel.ROLE,
          encryptConfigSecretFields({
            'mcpServers.fresh.apiKey': {
              source: 'admin',
              authorization_type: 'bearer',
              key: 'sk-landed-meanwhile',
            },
          }),
        ),
      );

      const removed = await send(racing.deleteConfigField, {
        params: { principalType: 'role', principalId },
        query: { fieldPath: 'mcpServers.fresh.url' },
      });

      expect(removed.statusCode).toBe(400);
      expect(removed.body).toMatchObject({
        code: 'MCP_API_KEY_REENTRY_REQUIRED',
        server: 'fresh',
        fields: ['url'],
      });
      const server = await storedServer(principalId, 'fresh');
      expect(server.url).toBe('https://mcp.example.com/mcp');
      expect(decryptV3(server.apiKey.key)).toBe('sk-landed-meanwhile');
    });

    it('still refuses a stale expectedRevision', async () => {
      const principalId = await seed();
      const { revision } = (
        await send(handlers.getConfig, {
          params: { principalType: 'role', principalId },
        })
      ).body!.config as { revision: string };
      await patch(principalId, [{ fieldPath: 'mcpServers.github.title', value: 'GitHub' }]);

      const removed = await send(handlers.deleteConfigField, {
        params: { principalType: 'role', principalId },
        query: { fieldPath: 'mcpServers.github.oauth.client_secret', expectedRevision: revision },
      });

      expect(removed.statusCode).toBe(409);
    });

    it('refuses writes under the mcpConfig alias, and withholds a legacy document key there', async () => {
      const principalId = nextPrincipalId();
      const patched = await patch(principalId, [
        { fieldPath: 'mcpConfig.aliasA', value: mcpServer({ oauth: undefined }) },
      ]);
      expect(patched.statusCode).toBe(400);
      expect(patched.body).toMatchObject({ code: 'UNKNOWN_SECTION' });

      const replaced = await send(handlers.upsertConfigOverrides, {
        params: { principalType: 'role', principalId },
        body: { overrides: { mcpConfig: { aliasA: mcpServer({ oauth: undefined }) } } },
      });
      expect(replaced.statusCode).toBe(400);
      expect(replaced.body).toMatchObject({ code: 'CONFIG_OVERRIDE_INVALID' });
      expect(await mongoose.models.Config.countDocuments({ principalId })).toBe(0);

      /** Stored before the section allowlist: the merge ignores it, and reads still withhold its key. */
      await mongoose.models.Config.create({
        principalType: 'role',
        principalId,
        principalModel: 'Role',
        priority: 10,
        overrides: { mcpConfig: { aliasA: mcpServer({ oauth: undefined }) } },
      });
      const read = await send(handlers.getConfig, {
        params: { principalType: 'role', principalId },
      });
      expect(read.statusCode).toBe(200);
      expect(JSON.stringify(read.body)).not.toContain(API_KEY);
      expect(getAtPath(read.body!.config, 'overrides.mcpConfig.aliasA.apiKey.key')).toBeUndefined();

      const removed = await send(handlers.deleteConfigField, {
        params: { principalType: 'role', principalId },
        query: { fieldPath: 'mcpConfig.aliasA' },
      });
      expect(removed.statusCode).toBe(200);
      expect(getAtPath(await readRawOverrides(principalId), 'mcpConfig.aliasA')).toBeUndefined();
    });

    it('does not ask again for a visible `${ENV}` reference', async () => {
      const principalId = nextPrincipalId();
      await patch(principalId, [
        {
          fieldPath: 'mcpServers.ref',
          value: mcpServer({
            apiKey: { source: 'admin', authorization_type: 'bearer', key: '${MCP_KEY}' },
            oauth: undefined,
          }),
        },
      ]);

      const res = await patch(principalId, [
        { fieldPath: 'mcpServers.ref.url', value: 'https://moved.example/mcp' },
      ]);
      expect(res.statusCode).toBe(200);
    });
  });

  it('validates after preservation: dropping client_id while the secret is kept is refused', async () => {
    const principalId = await seed();

    const res = await patch(principalId, [
      {
        fieldPath: 'mcpServers.github.oauth',
        value: {
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
        },
      },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONFIG_OVERRIDE_INVALID' });
    expect((res.body as { issues: Array<{ path: string }> }).issues).toEqual([
      expect.objectContaining({ path: 'mcpServers.github.oauth.client_secret' }),
    ]);
  });

  describe('rename hints', () => {
    const renamed = () =>
      mcpServer({
        apiKey: { source: 'admin', authorization_type: 'bearer' },
        oauth: {
          client_id: 'client',
          authorization_url: 'https://auth.example.com/authorize',
          token_url: 'https://auth.example.com/token',
        },
      });

    it('carries both stored credentials to the new name and leaves the old server alone', async () => {
      const principalId = await seed();
      const source = await storedServer(principalId, 'github');

      const res = await patch(principalId, [{ fieldPath: 'mcpServers.code', value: renamed() }], {
        renames: [{ path: 'mcpServers', previousName: 'github', name: 'code' }],
      });

      expect(res.statusCode).toBe(200);
      const copy = await storedServer(principalId, 'code');
      expect(copy.apiKey.key).toBe(source.apiKey.key);
      expect(copy.oauth.client_secret).toBe(source.oauth.client_secret);
      expect(copy.apiKey.keyPreview).toBe(getSecretPreview(API_KEY));
      expect((await storedServer(principalId, 'github')).apiKey.key).toBe(source.apiKey.key);
    });

    it('requires re-entry when the renamed server points somewhere else', async () => {
      const principalId = await seed();

      const res = await patch(
        principalId,
        [
          {
            fieldPath: 'mcpServers.code',
            value: { ...renamed(), url: 'https://evil.example/mcp' },
          },
        ],
        { renames: [{ path: 'mcpServers', previousName: 'github', name: 'code' }] },
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'MCP_API_KEY_REENTRY_REQUIRED', server: 'code' });
    });

    it('duplicates a server to two names from one stored source', async () => {
      const principalId = await seed();
      const source = await storedServer(principalId, 'github');

      const res = await patch(
        principalId,
        [
          { fieldPath: 'mcpServers.code', value: renamed() },
          { fieldPath: 'mcpServers.copy', value: renamed() },
        ],
        {
          renames: [
            { path: 'mcpServers', previousName: 'github', name: 'code' },
            { path: 'mcpServers', previousName: 'github', name: 'copy' },
          ],
        },
      );

      expect(res.statusCode).toBe(200);
      for (const name of ['code', 'copy']) {
        expect((await storedServer(principalId, name)).apiKey.key).toBe(source.apiKey.key);
      }
    });

    it('without a hint, a renamed server keeps no credential', async () => {
      const principalId = await seed();

      const res = await patch(principalId, [{ fieldPath: 'mcpServers.code', value: renamed() }]);

      expect(res.statusCode).toBe(200);
      const copy = await storedServer(principalId, 'code');
      expect(copy.apiKey.key).toBeUndefined();
    });

    it('rejects hints it cannot apply', async () => {
      const principalId = await seed();
      const write = [{ fieldPath: 'mcpServers.code', value: renamed() }];

      const cases: Array<[unknown, string]> = [
        [
          [{ path: 'endpoints.azureOpenAI.groups', previousName: 'github', name: 'code' }],
          'unsupported_path',
        ],
        [[{ path: 'endpoints.custom', previousName: 'github', name: 'code' }], 'source_not_found'],
        [[{ path: 'mcpServers', previousName: 'github', name: 'github' }], 'invalid_name'],
        [[{ path: 'mcpServers', previousName: '__proto__', name: 'code' }], 'invalid_name'],
        [[{ path: 'mcpServers', previousName: 'missing', name: 'code' }], 'source_not_found'],
        [[{ path: 'mcpServers', previousName: 'github', name: 'other' }], 'target_not_written'],
        ['not-an-array', 'invalid_renames'],
      ];
      for (const [renames, reason] of cases) {
        const res = await patch(principalId, write, { renames });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
          error: 'Invalid rename hint',
          code: 'CONFIG_RENAME_INVALID',
          reason,
        });
      }
    });
  });
});

describe('env reference allowlist on admin writes', () => {
  it('refuses a reference to a name outside the allowlist, by path, on PATCH and PUT', async () => {
    const principalId = nextPrincipalId();

    const patched = await patch(principalId, [
      { fieldPath: 'mcpServers.x', value: mcpServer({ url: 'https://h.example/${HOME}' }) },
    ]);
    expect(patched.statusCode).toBe(400);
    expect(patched.body).toEqual({
      error: 'Invalid config override',
      code: 'CONFIG_OVERRIDE_INVALID',
      issues: [
        {
          path: 'mcpServers.x.url',
          segments: ['mcpServers', 'x', 'url'],
          code: 'env_reference_not_allowed',
        },
      ],
    });

    const replaced = await send(handlers.upsertConfigOverrides, {
      params: { principalType: 'role', principalId },
      body: {
        overrides: {
          endpoints: {
            custom: [
              {
                name: 'Exfil',
                apiKey: '${CREDS_KEY}',
                baseURL: 'https://evil.example/v1',
                models: { default: ['m'] },
              },
            ],
          },
        },
      },
    });
    expect(replaced.statusCode).toBe(400);
    expect(replaced.body).toMatchObject({
      issues: [
        {
          path: 'endpoints.custom.0.apiKey',
          segments: ['endpoints', 'custom', '0', 'apiKey'],
          code: 'env_reference_not_allowed',
        },
      ],
    });
    expect(await mongoose.models.Config.findOne({ principalId })).toBeNull();
  });

  it('accepts names librechat.yaml references and names the operator lists', async () => {
    const yamlHandlers = createRealHandlers({
      overrideEnvAllowlist: 'EXTRA_GATEWAY_KEY',
      getAppConfig: async () => ({ config: { ocr: { baseURL: '${YAML_OCR_URL}' } } }) as never,
    });
    const principalId = nextPrincipalId();

    const res = await patch(
      principalId,
      [
        { fieldPath: 'ocr.baseURL', value: '${YAML_OCR_URL}' },
        { fieldPath: 'ocr.apiKey', value: '${EXTRA_GATEWAY_KEY}' },
        { fieldPath: 'webSearch.serperApiKey', value: '${OPENAI_API_KEY}' },
      ],
      {},
      yamlHandlers,
    );
    expect(res.statusCode).toBe(200);
  });

  it('accepts the OCR key reference GET /base returns when librechat.yaml sets no OCR key', async () => {
    const yamlOCR = { baseURL: 'https://ocr.yaml.example/v1', mistralModel: 'mistral-ocr-latest' };
    const yamlHandlers = createRealHandlers({
      overrideEnvAllowlist: '',
      getAppConfig: async () =>
        ({ config: { ocr: yamlOCR }, ocr: loadOCRConfig(yamlOCR) }) as never,
    });
    const base = await send(yamlHandlers.getBaseConfig, {});
    const ocr = (base.body!.config as { ocr: Record<string, unknown> }).ocr;
    expect(ocr.apiKey).toBe('${OCR_API_KEY}');

    const principalId = nextPrincipalId();
    const res = await patch(principalId, [{ fieldPath: 'ocr', value: ocr }], {}, yamlHandlers);
    expect(res.statusCode).toBe(200);
    expect(getAtPath(await readRawOverrides(principalId), 'ocr.apiKey')).toBe('${OCR_API_KEY}');

    const unconfigured = createRealHandlers({
      overrideEnvAllowlist: '',
      getAppConfig: async () => ({ config: {} }) as never,
    });
    const refused = await patch(
      nextPrincipalId(),
      [{ fieldPath: 'ocr', value: ocr }],
      {},
      unconfigured,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatchObject({
      issues: [{ path: 'ocr.apiKey', code: 'env_reference_not_allowed' }],
    });
  });

  it('accepts the web search section GET /base returns, with the defaults loading fills in', async () => {
    const yamlHandlers = createRealHandlers({
      overrideEnvAllowlist: '',
      getAppConfig: async () =>
        ({ config: {}, webSearch: loadWebSearchConfig(undefined) }) as never,
    });
    const base = await send(yamlHandlers.getBaseConfig, {});
    const webSearch = (base.body!.config as { webSearch: Record<string, unknown> }).webSearch;
    expect(webSearch.searxngInstanceUrl).toBe('${SEARXNG_INSTANCE_URL}');

    const principalId = nextPrincipalId();
    const patched = await patch(
      principalId,
      [{ fieldPath: 'webSearch', value: webSearch }],
      {},
      yamlHandlers,
    );
    expect(patched.statusCode).toBe(200);
    const batch = await send(yamlHandlers.applyConfigChanges, {
      params: { principalType: 'role', principalId },
      body: { ops: [{ op: 'set', fieldPath: 'webSearch', value: webSearch }] },
    });
    expect(batch.statusCode).toBe(200);
    expect(getAtPath(await readRawOverrides(principalId), 'webSearch.searxngInstanceUrl')).toBe(
      '${SEARXNG_INSTANCE_URL}',
    );

    const elsewhere = await patch(
      nextPrincipalId(),
      [{ fieldPath: 'webSearch.firecrawlApiUrl', value: '${SEARXNG_INSTANCE_URL}' }],
      {},
      yamlHandlers,
    );
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.body).toMatchObject({
      issues: [{ path: 'webSearch.firecrawlApiUrl', code: 'env_reference_not_allowed' }],
    });
  });

  it('accepts `${...}` inside a key read as is, and refuses it inside one a client expands', async () => {
    const principalId = nextPrincipalId();
    const credential = 'pa${LC8_UNLISTED_NAME}ss';

    const opaque = await patch(principalId, [
      { fieldPath: 'ocr.apiKey', value: credential },
      { fieldPath: 'speech.tts.openai', value: { apiKey: credential, voices: ['alloy'] } },
    ]);
    expect(opaque.statusCode).toBe(200);
    const batch = await send(handlers.applyConfigChanges, {
      params: { principalType: 'role', principalId },
      body: { ops: [{ op: 'set', fieldPath: 'webSearch.serperApiKey', value: credential }] },
    });
    expect(batch.statusCode).toBe(200);
    const stored = await readRawOverrides(principalId);
    for (const path of ['ocr.apiKey', 'speech.tts.openai.apiKey', 'webSearch.serperApiKey']) {
      expect(decryptV3(getAtPath(stored, path) as string)).toBe(credential);
    }

    const reference = await patch(principalId, [
      { fieldPath: 'ocr.apiKey', value: '${LC8_UNLISTED_NAME}' },
    ]);
    expect(reference.statusCode).toBe(400);
    expect(reference.body).toMatchObject({
      issues: [{ path: 'ocr.apiKey', code: 'env_reference_not_allowed' }],
    });

    const expanded = await patch(principalId, [
      {
        fieldPath: 'endpoints.custom',
        value: [
          {
            name: 'Gateway',
            apiKey: credential,
            baseURL: 'https://gateway.example/v1',
            models: { default: ['m'] },
          },
        ],
      },
      {
        fieldPath: 'mcpServers.tools',
        value: mcpServer({
          apiKey: { source: 'admin', authorization_type: 'bearer', key: credential },
        }),
      },
    ]);
    expect(expanded.statusCode).toBe(400);
    expect(expanded.body).toMatchObject({
      issues: [
        { path: 'endpoints.custom.0.apiKey', code: 'env_reference_not_allowed' },
        { path: 'mcpServers.tools.apiKey.key', code: 'env_reference_not_allowed' },
      ],
    });
    expect(getAtPath(await readRawOverrides(principalId), 'endpoints')).toBeUndefined();
  });

  it('accepts the Azure base URL templates in a group, on PATCH and change batches', async () => {
    const principalId = nextPrincipalId();
    const baseURL =
      'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}';
    const group = {
      group: 'east',
      apiKey: '${AZURE_API_KEY}',
      instanceName: 'east-instance',
      version: '2024-10-21',
      deploymentName: 'gpt-4o',
      baseURL,
      models: { 'gpt-4o': true },
    };

    const patched = await patch(principalId, [
      { fieldPath: 'endpoints.azureOpenAI', value: { groups: [group] } },
    ]);
    expect(patched.statusCode).toBe(200);
    const batch = await send(handlers.applyConfigChanges, {
      params: { principalType: 'role', principalId },
      body: {
        ops: [
          {
            op: 'set',
            fieldPath: 'endpoints.azureOpenAI.groups',
            value: [
              group,
              {
                ...group,
                group: 'west',
                instanceName: 'west-instance',
                models: { 'gpt-4o-west': true },
              },
            ],
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);
    expect(
      getAtPath(await readRawOverrides(principalId), 'endpoints.azureOpenAI.groups'),
    ).toMatchObject([{ baseURL }, { baseURL }]);

    const elsewhere = await patch(principalId, [
      { fieldPath: 'ocr.baseURL', value: 'https://${INSTANCE_NAME}.example.com' },
    ]);
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.body).toMatchObject({
      issues: [{ path: 'ocr.baseURL', code: 'env_reference_not_allowed' }],
    });
  });

  it('checks prompt-named keys in maps a reader expands; only prompt fields are text', async () => {
    const principalId = nextPrincipalId();

    const headers = await patch(principalId, [
      {
        fieldPath: 'mcpServers.envleak',
        value: mcpServer({
          oauth: undefined,
          headers: { 'X-Prompt': '${HOME}', instructions: 'Bearer ${HOME}' },
          oauth_headers: { 'X-System-Prompt': '${HOME}' },
        }),
      },
    ]);
    expect(headers.statusCode).toBe(400);
    expect(headers.body).toEqual({
      error: 'Invalid config override',
      code: 'CONFIG_OVERRIDE_INVALID',
      issues: [
        {
          path: 'mcpServers.envleak.headers.X-Prompt',
          segments: ['mcpServers', 'envleak', 'headers', 'X-Prompt'],
          code: 'env_reference_not_allowed',
        },
        {
          path: 'mcpServers.envleak.headers.instructions',
          segments: ['mcpServers', 'envleak', 'headers', 'instructions'],
          code: 'env_reference_not_allowed',
        },
        {
          path: 'mcpServers.envleak.oauth_headers.X-System-Prompt',
          segments: ['mcpServers', 'envleak', 'oauth_headers', 'X-System-Prompt'],
          code: 'env_reference_not_allowed',
        },
      ],
    });

    const endpoint = (extra: Record<string, unknown>) => ({
      overrides: {
        endpoints: {
          custom: [
            {
              name: 'Leak',
              apiKey: 'sk-own-gateway-key',
              baseURL: 'https://evil.example/v1',
              models: { default: ['m'] },
              titlePrompt: 'Title for ${convo}',
              ...extra,
            },
          ],
        },
      },
    });
    const custom = await send(handlers.upsertConfigOverrides, {
      params: { principalType: 'role', principalId },
      body: endpoint({
        headers: { 'X-System-Prompt': '${HOME}' },
        addParams: { instructions: '${HOME}' },
      }),
    });
    expect(custom.statusCode).toBe(400);
    expect(custom.body).toMatchObject({
      issues: [
        {
          path: 'endpoints.custom.0.headers.X-System-Prompt',
          segments: ['endpoints', 'custom', '0', 'headers', 'X-System-Prompt'],
          code: 'env_reference_not_allowed',
        },
        {
          path: 'endpoints.custom.0.addParams.instructions',
          segments: ['endpoints', 'custom', '0', 'addParams', 'instructions'],
          code: 'env_reference_not_allowed',
        },
      ],
    });
    expect(await mongoose.models.Config.findOne({ principalId })).toBeNull();

    const prose = await send(handlers.upsertConfigOverrides, {
      params: { principalType: 'role', principalId },
      body: endpoint({}),
    });
    expect(prose.statusCode).toBe(201);
  });
});

describe('Azure OpenAI group keys — real handlers against a real Config collection', () => {
  const group = (apiKey?: string) => ({
    group: 'east',
    instanceName: 'east-instance',
    version: '2024-10-21',
    deploymentName: 'gpt-4o',
    models: { 'gpt-4o': true },
    ...(apiKey !== undefined && { apiKey }),
  });

  it('encrypts group keys written through the endpoint object and keeps them when omitted', async () => {
    const principalId = nextPrincipalId();

    const written = await patch(principalId, [
      { fieldPath: 'endpoints.azureOpenAI', value: { groups: [group('azure-east-key-00001234')] } },
    ]);
    expect(written.statusCode).toBe(200);
    const stored = getAtPath(
      await readRawOverrides(principalId),
      'endpoints.azureOpenAI.groups',
    ) as Array<Record<string, string>> | undefined;
    expect(decryptV3(stored![0].apiKey)).toBe('azure-east-key-00001234');
    expect(JSON.stringify(written.body)).not.toContain('azure-east-key-00001234');

    /** `apiKey` is required on a group: validation runs after the omitted key is kept. */
    const kept = await patch(principalId, [
      { fieldPath: 'endpoints.azureOpenAI.groups', value: [group()] },
    ]);
    expect(kept.statusCode).toBe(200);
    const after = getAtPath(await readRawOverrides(principalId), 'endpoints.azureOpenAI.groups') as
      | Array<Record<string, string>>
      | undefined;
    expect(after![0].apiKey).toBe(stored![0].apiKey);
  });

  it('binds a key a profile enters for a group only Base defines, so CONFIG_REDERIVE_ENDPOINTS keeps it', async () => {
    const { resolveConfigOverrides } = await import('~/app/overrides');
    const { createEnvReferencePolicy } = await import('~/app/allowlist');
    const principalId = nextPrincipalId();
    const west = { ...group('azure-base-west-key-0001'), group: 'west', instanceName: 'west' };
    try {
      expect(
        (
          await patch(basePrincipalId, [
            { fieldPath: 'endpoints.azureOpenAI.groups', value: [west] },
          ])
        ).statusCode,
      ).toBe(200);
      /** Written while the deployment leaves the switch off: the groups do not apply yet. */
      const entered = await patch(principalId, [
        {
          fieldPath: 'endpoints.azureOpenAI.groups',
          value: [{ group: 'west', apiKey: 'azure-role-west-key-0002' }],
        },
      ]);
      expect(entered.statusCode).toBe(200);
      expect(entered.body!.ignored).toBeUndefined();

      const serveWest = async () => {
        const layers = await Promise.all([
          configMethods.findConfigByPrincipal(PrincipalType.ROLE, basePrincipalId),
          configMethods.findConfigByPrincipal(PrincipalType.ROLE, principalId),
        ]);
        const served = resolveConfigOverrides(
          { config: {} } as never,
          layers.filter((layer) => layer != null),
          { envPolicy: createEnvReferencePolicy({ config: {} }), rederiveEndpoints: true },
        ) as unknown as {
          endpoints?: { azureOpenAI?: { groupMap?: Record<string, Record<string, unknown>> } };
        };
        return served.endpoints?.azureOpenAI?.groupMap?.west;
      };

      expect(await serveWest()).toMatchObject({
        apiKey: 'azure-role-west-key-0002',
        instanceName: 'west',
      });

      /** The key stays bound to where it was entered: Base moving the group drops it. */
      const moved = { ...west, instanceName: 'elsewhere', apiKey: 'azure-base-west-key-0003' };
      expect(
        (
          await patch(basePrincipalId, [
            { fieldPath: 'endpoints.azureOpenAI.groups', value: [moved] },
          ])
        ).statusCode,
      ).toBe(200);
      expect(await serveWest()).toMatchObject({ apiKey: '', instanceName: 'elsewhere' });
    } finally {
      await mongoose.models.Config.deleteOne({ principalId: basePrincipalId });
    }
  });

  describe('a stored group key kept beside a destination the write changes', () => {
    const KEY = 'azure-east-admin-key-00009876';
    /** A group the merge resolves: each model has a deployment and a version. */
    const servable = (apiKey?: string) => ({ ...group(apiKey), deploymentName: 'gpt-4o' });
    const reentryIssue = (field: string, secret = 'endpoints.azureOpenAI.groups.0.apiKey') => ({
      code: 'CONFIG_SECRET_REENTRY_REQUIRED',
      issues: [
        {
          path: `endpoints.azureOpenAI.groups.0.${field}`,
          segments: ['endpoints', 'azureOpenAI', 'groups', '0', field],
          code: 'secret_reentry_required',
          secretPath: secret,
        },
      ],
    });

    async function storeGroup(): Promise<{ principalId: string; stored: unknown }> {
      const principalId = nextPrincipalId();
      const written = await patch(principalId, [
        { fieldPath: 'endpoints.azureOpenAI.groups', value: [servable(KEY)] },
      ]);
      expect(written.statusCode).toBe(200);
      return { principalId, stored: await readRawOverrides(principalId) };
    }

    it('must be entered again on PATCH, PUT and change batches (dry runs included)', async () => {
      const { principalId, stored } = await storeGroup();
      const moved = [{ ...servable(), instanceName: 'attacker-instance' }];
      const params = { principalType: 'role', principalId };

      const patched = await patch(principalId, [
        { fieldPath: 'endpoints.azureOpenAI.groups', value: moved },
      ]);
      const replaced = await send(handlers.upsertConfigOverrides, {
        params,
        body: { overrides: { endpoints: { azureOpenAI: { groups: moved } } } },
      });
      const batch = (dryRun: boolean) =>
        send(handlers.applyConfigChanges, {
          params,
          body: {
            dryRun,
            ops: [{ op: 'set', fieldPath: 'endpoints.azureOpenAI.groups', value: moved }],
          },
        });
      for (const res of [patched, replaced, await batch(true), await batch(false)]) {
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject(reentryIssue('instanceName'));
      }
      expect(await readRawOverrides(principalId)).toEqual(stored);

      const entered = await patch(principalId, [
        {
          fieldPath: 'endpoints.azureOpenAI.groups',
          value: [{ ...servable('azure-new-instance-key-0001'), instanceName: 'new-instance' }],
        },
      ]);
      expect(entered.statusCode).toBe(200);
    });

    it('stays with edits that leave its destination alone', async () => {
      const { principalId } = await storeGroup();

      const res = await patch(principalId, [
        {
          fieldPath: 'endpoints.azureOpenAI.groups',
          value: [{ ...servable(), version: '2025-01-01', models: { 'gpt-4o': true, o3: true } }],
        },
      ]);
      expect(res.statusCode).toBe(200);
    });

    it('must be entered again when a groupMap entry, a field delete or a tombstone moves it', async () => {
      const { principalId, stored } = await storeGroup();
      const groupMapBaseURL = 'endpoints.azureOpenAI.groupMap.east.baseURL';

      const mapped = await patch(principalId, [
        { fieldPath: groupMapBaseURL, value: 'https://attacker.example/openai' },
      ]);
      expect(mapped.statusCode).toBe(400);
      expect(mapped.body).toMatchObject({
        code: 'CONFIG_SECRET_REENTRY_REQUIRED',
        issues: [{ path: groupMapBaseURL, secretPath: 'endpoints.azureOpenAI.groups.0.apiKey' }],
      });
      expect(await readRawOverrides(principalId)).toEqual(stored);

      const mapPrincipalId = nextPrincipalId();
      const withMap = await patch(mapPrincipalId, [
        {
          fieldPath: 'endpoints.azureOpenAI.groupMap.east',
          value: { apiKey: KEY, instanceName: 'east-instance', baseURL: 'https://own.example' },
        },
      ]);
      expect(withMap.statusCode).toBe(200);
      const mapStored = await readRawOverrides(mapPrincipalId);
      const mapParams = { principalType: 'role', principalId: mapPrincipalId };
      const removed = await send(handlers.deleteConfigField, {
        params: mapParams,
        query: { fieldPath: 'endpoints.azureOpenAI.groupMap.east.baseURL' },
      });
      const tombstoned = await send(handlers.tombstoneConfigField, {
        params: mapParams,
        body: { fieldPath: 'endpoints.azureOpenAI.groupMap.east.instanceName' },
      });
      for (const res of [removed, tombstoned]) {
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ code: 'CONFIG_SECRET_REENTRY_REQUIRED' });
      }
      expect(await readRawOverrides(mapPrincipalId)).toEqual(mapStored);
    });
  });

  it('encrypts a groupMap key, which the Azure clients read, and never returns it', async () => {
    const principalId = nextPrincipalId();
    const key = 'azure-groupmap-plaintext-key-5678';
    const params = { principalType: 'role', principalId };

    const written = await patch(principalId, [
      {
        fieldPath: 'endpoints.azureOpenAI.groupMap',
        value: { g1: { apiKey: key, instanceName: 'g1-instance' } },
      },
    ]);
    expect(written.statusCode).toBe(200);
    const stored = getAtPath(
      await readRawOverrides(principalId),
      'endpoints.azureOpenAI.groupMap.g1',
    ) as Record<string, string>;
    expect(decryptV3(stored.apiKey)).toBe(key);
    expect(stored.apiKeyPreview).toBe('...5678');

    const read = await send(handlers.getConfig, { params });
    for (const res of [written, read]) {
      expect(JSON.stringify(res.body)).not.toContain(key);
      expect(JSON.stringify(res.body)).not.toContain(stored.apiKey);
      expect(getAtPath(res.body!.config, 'overrides.endpoints.azureOpenAI.groupMap.g1')).toEqual({
        apiKeyPreview: '...5678',
        instanceName: 'g1-instance',
      });
    }

    const kept = await patch(principalId, [
      { fieldPath: 'endpoints.azureOpenAI.groupMap.g1', value: { instanceName: 'g1-instance' } },
    ]);
    const replace = (g1: Record<string, string>) =>
      send(handlers.upsertConfigOverrides, {
        params,
        body: { overrides: { endpoints: { azureOpenAI: { groupMap: { g1 } } } } },
      });
    /** A replace that leaves the instance out sends the kept key to another host. */
    const moved = await replace({ version: 'v' });
    const replaced = await replace({ instanceName: 'g1-instance', version: 'v' });
    expect(kept.statusCode).toBe(200);
    expect(moved.statusCode).toBe(400);
    expect(moved.body).toMatchObject({
      code: 'CONFIG_SECRET_REENTRY_REQUIRED',
      issues: [
        {
          path: 'endpoints.azureOpenAI.groupMap.g1.instanceName',
          secretPath: 'endpoints.azureOpenAI.groupMap.g1.apiKey',
        },
      ],
    });
    expect(replaced.statusCode).toBe(200);
    expect(
      getAtPath(await readRawOverrides(principalId), 'endpoints.azureOpenAI.groupMap.g1'),
    ).toEqual({
      apiKey: stored.apiKey,
      apiKeyPreview: '...5678',
      instanceName: 'g1-instance',
      version: 'v',
    });
  });
});

describe('inherited secrets a profile rebinds (`ignored` in write responses)', () => {
  const yaml = {
    endpoints: {
      custom: [
        {
          name: 'Gateway',
          apiKey: '${GATEWAY_KEY}',
          baseURL: 'https://gateway.example.com/v1',
          models: { default: ['gpt-4o'] },
        },
      ],
    },
    mcpServers: {
      tools: {
        type: 'streamable-http',
        url: 'https://tools.example.com/mcp',
        apiKey: { source: 'admin', authorization_type: 'bearer', key: '${TOOLS_KEY}' },
      },
    },
  };
  const baseAppConfig = {
    config: yaml,
    endpoints: { custom: structuredClone(yaml.endpoints.custom) },
    mcpConfig: structuredClone(yaml.mcpServers),
  };

  it('reports the inherited key a profile URL change drops, and nothing for other edits', async () => {
    const yamlHandlers = createRealHandlers({ getAppConfig: async () => baseAppConfig as never });
    const principalId = nextPrincipalId();

    const moved = await patch(
      principalId,
      [
        { fieldPath: 'mcpServers.tools.url', value: 'https://moved.example/mcp' },
        {
          fieldPath: 'endpoints.custom',
          value: [{ name: 'Gateway', baseURL: 'https://moved.example/v1' }],
        },
      ],
      {},
      yamlHandlers,
    );

    expect(moved.statusCode).toBe(200);
    expect(moved.body!.ignored).toEqual([
      {
        path: 'endpoints.custom["Gateway"].apiKey',
        segments: ['endpoints', 'custom', 'Gateway', 'apiKey'],
        reason: 'secret_rebinding',
      },
      {
        path: 'mcpServers.tools.apiKey.key',
        segments: ['mcpServers', 'tools', 'apiKey', 'key'],
        reason: 'secret_rebinding',
      },
    ]);

    const other = nextPrincipalId();
    const titled = await patch(
      other,
      [{ fieldPath: 'mcpServers.tools.title', value: 'Tools' }],
      {},
      yamlHandlers,
    );
    expect(titled.statusCode).toBe(200);
    expect(titled.body!.ignored).toBeUndefined();
  });

  it("reports a key moved by the native client's own URL option or under a folded name", async () => {
    const custom = [
      {
        name: 'Claude',
        provider: 'anthropic',
        apiKey: 'yaml-literal-claude-key',
        baseURL: 'https://gateway.example.com/anthropic',
        models: { default: ['claude-x'] },
      },
      {
        name: 'Ollama',
        apiKey: 'yaml-literal-ollama-key',
        baseURL: 'http://ollama.internal:11434/v1',
        models: { default: ['llama3'] },
      },
    ];
    const endpointHandlers = createRealHandlers({
      getAppConfig: async () =>
        ({
          config: { endpoints: { custom } },
          endpoints: { custom: structuredClone(custom) },
        }) as never,
    });
    const ignoredKey = (name: string) => ({
      path: `endpoints.custom[${JSON.stringify(name)}].apiKey`,
      segments: ['endpoints', 'custom', name, 'apiKey'],
      reason: 'secret_rebinding',
    });
    const redirected = {
      name: 'Claude',
      addParams: { anthropicApiUrl: 'https://attacker.example' },
    };
    const respelled = { name: 'ollama', baseURL: 'https://attacker.example/v1' };

    const patched = await patch(
      nextPrincipalId(),
      [{ fieldPath: 'endpoints.custom', value: [redirected, respelled] }],
      {},
      endpointHandlers,
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.body!.ignored).toEqual([ignoredKey('Claude'), ignoredKey('Ollama')]);

    const params = { principalType: 'role', principalId: nextPrincipalId() };
    for (const [entry, name] of [
      [redirected, 'Claude'],
      [respelled, 'Ollama'],
    ] as const) {
      const batch = await send(endpointHandlers.applyConfigChanges, {
        params,
        body: { dryRun: true, ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry }] },
      });
      expect(batch.statusCode).toBe(200);
      expect(batch.body!.ignored).toEqual([ignoredKey(name)]);
    }

    const shaped = await patch(
      nextPrincipalId(),
      [
        {
          fieldPath: 'endpoints.custom',
          value: [
            { name: 'Claude', addParams: { promptCache: true } },
            { name: 'ollama', models: { default: ['llama3.1'] } },
          ],
        },
      ],
      {},
      endpointHandlers,
    );
    expect(shaped.statusCode).toBe(200);
    expect(shaped.body!.ignored).toBeUndefined();
  });

  it('lists only the sections a section manager can read, on every write route', async () => {
    const broad = createRealHandlers({ getAppConfig: async () => baseAppConfig as never });
    const principalId = nextPrincipalId();
    const params = { principalType: 'role', principalId };
    const mcpIgnored = {
      path: 'mcpServers.tools.apiKey.key',
      segments: ['mcpServers', 'tools', 'apiKey', 'key'],
      reason: 'secret_rebinding',
    };
    const endpointIgnored = {
      path: 'endpoints.custom["Gateway"].apiKey',
      segments: ['endpoints', 'custom', 'Gateway', 'apiKey'],
      reason: 'secret_rebinding',
    };
    /** A broad manager moves the MCP server: the document drops its inherited key from then on. */
    const moved = await patch(
      principalId,
      [{ fieldPath: 'mcpServers.tools.url', value: 'https://moved.example/mcp' }],
      {},
      broad,
    );
    expect(moved.body!.ignored).toEqual([mcpIgnored]);

    const scoped = createRealHandlers({
      getAppConfig: async () => baseAppConfig as never,
      hasConfigCapability: async (_user, section) => section === 'endpoints',
    });
    const movedEndpoint = [{ name: 'Gateway', baseURL: 'https://moved.example/v1' }];
    const patched = await patch(
      principalId,
      [{ fieldPath: 'endpoints.custom', value: movedEndpoint }],
      {},
      scoped,
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.body!.ignored).toEqual([endpointIgnored]);
    expect(Object.keys((patched.body!.config as { overrides: object }).overrides)).toEqual([
      'endpoints',
    ]);

    const tombstoned = await send(scoped.tombstoneConfigField, {
      params,
      body: { fieldPath: 'endpoints.custom' },
    });
    expect(tombstoned.statusCode).toBe(200);
    expect(tombstoned.body!.ignored).toBeUndefined();

    for (const dryRun of [true, false]) {
      const batch = await send(scoped.applyConfigChanges, {
        params,
        body: {
          dryRun,
          ops: [{ op: 'set', fieldPath: 'endpoints.custom', value: movedEndpoint }],
        },
      });
      expect(batch.statusCode).toBe(200);
      expect(batch.body!.ignored).toEqual([endpointIgnored]);
    }

    const all = await send(broad.applyConfigChanges, {
      params,
      body: { dryRun: true, ops: [{ op: 'unset', fieldPath: 'endpoints.custom' }] },
    });
    expect(all.body!.ignored).toEqual([mcpIgnored]);
  });
});

describe('destinations with a deployment credential (`ignored` in write responses)', () => {
  it('reports a summarization URL a profile sets without its own key', async () => {
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () => ({ config: {} }) as never,
    });
    const principalId = nextPrincipalId();

    const moved = await patch(
      principalId,
      [
        { fieldPath: 'summarization.provider', value: 'openAI' },
        { fieldPath: 'summarization.parameters.baseURL', value: 'https://evil.example/v1' },
      ],
      {},
      yamlHandlers,
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.body!.ignored).toEqual([
      {
        path: 'summarization.parameters.baseURL',
        segments: ['summarization', 'parameters', 'baseURL'],
        reason: 'secret_rebinding',
      },
    ]);

    const keyed = await patch(
      principalId,
      [{ fieldPath: 'summarization.parameters.apiKey', value: 'sk-profile-summary-key' }],
      {},
      yamlHandlers,
    );
    expect(keyed.statusCode).toBe(200);
    expect(keyed.body!.ignored).toBeUndefined();
  });

  it('reports nothing for firstPartyEndpoint, which is not a destination', async () => {
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () => ({ config: {} }) as never,
    });

    const res = await patch(
      nextPrincipalId(),
      [
        { fieldPath: 'summarization.provider', value: 'openAI' },
        { fieldPath: 'summarization.parameters.firstPartyEndpoint', value: false },
      ],
      {},
      yamlHandlers,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body!.ignored).toBeUndefined();
  });

  const summarizationIgnored = (...keys: string[]) =>
    keys.map((key) => ({
      path: `summarization.parameters.${key}`,
      segments: ['summarization', 'parameters', key],
      reason: 'secret_rebinding',
    }));

  it.each([1, 0, true, false])(
    'reports a summarization URL a profile sets with a key of %p, which no client sends',
    async (apiKey) => {
      const yamlHandlers = createRealHandlers({
        getAppConfig: async () => ({ config: {} }) as never,
      });

      const res = await patch(
        nextPrincipalId(),
        [
          { fieldPath: 'summarization.provider', value: 'azureOpenAI' },
          { fieldPath: 'summarization.model', value: 'gpt-4o' },
          { fieldPath: 'summarization.parameters.baseURL', value: 'https://evil.example/openai' },
          { fieldPath: 'summarization.parameters.apiKey', value: apiKey },
        ],
        {},
        yamlHandlers,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body!.ignored).toEqual(summarizationIgnored('baseURL'));
    },
  );

  it('reports a summarization destination set with a key its provider does not send', async () => {
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () => ({ config: {} }) as never,
    });

    const bedrock = await patch(
      nextPrincipalId(),
      [
        { fieldPath: 'summarization.provider', value: 'bedrock' },
        { fieldPath: 'summarization.parameters.endpointHost', value: 'evil.example' },
        { fieldPath: 'summarization.parameters.apiKey', value: 'sk-profile-summary-key' },
      ],
      {},
      yamlHandlers,
    );
    expect(bedrock.statusCode).toBe(200);
    expect(bedrock.body!.ignored).toEqual(summarizationIgnored('endpointHost'));

    const providerless = await patch(
      nextPrincipalId(),
      [
        { fieldPath: 'summarization.parameters.baseURL', value: 'https://evil.example/v1' },
        { fieldPath: 'summarization.parameters.apiKey', value: 'sk-profile-summary-key' },
      ],
      {},
      yamlHandlers,
    );
    expect(providerless.statusCode).toBe(200);
    expect(providerless.body!.ignored).toEqual(summarizationIgnored('baseURL'));
  });

  it("reports librechat.yaml's summarization gateway once a profile changes the credential it receives", async () => {
    const summarization = {
      provider: 'azureOpenAI',
      model: 'gpt-4o',
      parameters: { baseURL: 'https://yaml-gateway.example/openai', apiKey: 'yaml-gateway-key' },
    };
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () =>
        ({
          config: { summarization },
          summarization: structuredClone(summarization),
        }) as never,
    });

    const tombstoned = await send(yamlHandlers.tombstoneConfigField, {
      params: { principalType: 'role', principalId: nextPrincipalId() },
      body: { fieldPath: 'summarization.parameters.apiKey' },
    });
    expect(tombstoned.statusCode).toBe(200);
    expect(tombstoned.body!.ignored).toEqual(summarizationIgnored('baseURL'));

    const unkeyed = { provider: 'openAI', parameters: { baseURL: 'https://yaml-gateway.example' } };
    const unkeyedHandlers = createRealHandlers({
      getAppConfig: async () =>
        ({ config: { summarization: unkeyed }, summarization: structuredClone(unkeyed) }) as never,
    });
    const switched = await patch(
      nextPrincipalId(),
      [{ fieldPath: 'summarization.provider', value: 'azureOpenAI' }],
      {},
      unkeyedHandlers,
    );
    expect(switched.statusCode).toBe(200);
    expect(switched.body!.ignored).toEqual(summarizationIgnored('baseURL'));

    const tuned = await patch(
      nextPrincipalId(),
      [{ fieldPath: 'summarization.parameters.temperature', value: 0.2 }],
      {},
      unkeyedHandlers,
    );
    expect(tuned.statusCode).toBe(200);
    expect(tuned.body!.ignored).toBeUndefined();
  });

  it('reports the key of a resolved Azure group an override points elsewhere', async () => {
    const yaml = {
      endpoints: {
        azureOpenAI: {
          groups: [
            {
              group: 'east',
              apiKey: '${AZURE_EAST_KEY}',
              instanceName: 'east',
              version: '2024-10-21',
              models: { 'gpt-4o': true },
            },
          ],
        },
      },
    };
    const baseAppConfig = {
      config: yaml,
      endpoints: {
        azureOpenAI: {
          groupMap: { east: { apiKey: '${AZURE_EAST_KEY}', instanceName: 'east' } },
          modelGroupMap: { 'gpt-4o': { group: 'east' } },
        },
      },
    };
    const yamlHandlers = createRealHandlers({ getAppConfig: async () => baseAppConfig as never });

    const res = await patch(
      nextPrincipalId(),
      [
        {
          fieldPath: 'endpoints.azureOpenAI.groupMap.east.baseURL',
          value: 'https://evil.example/openai',
        },
      ],
      {},
      yamlHandlers,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body!.ignored).toEqual([
      {
        path: 'endpoints.azureOpenAI.groupMap.east.apiKey',
        segments: ['endpoints', 'azureOpenAI', 'groupMap', 'east', 'apiKey'],
        reason: 'secret_rebinding',
      },
    ]);
  });
});

describe('secrets a layer below moved (`ignored` in write responses)', () => {
  const yaml = {
    mcpServers: {
      tools: {
        type: 'streamable-http',
        url: 'https://tools.example.com/mcp',
        proxy: 'http://proxy.corp.example:8080',
        apiKey: { source: 'admin', authorization_type: 'bearer', key: '${TOOLS_KEY}' },
      },
    },
  };
  const baseAppConfig = { config: yaml, mcpConfig: structuredClone(yaml.mcpServers) };
  const ownKey = {
    fieldPath: 'mcpServers.tools.apiKey',
    value: { source: 'admin', authorization_type: 'bearer', key: 'sk-profile-own-key' },
  };

  afterEach(async () => {
    await mongoose.models.Config.deleteOne({ principalId: basePrincipalId });
  });

  it("binds a profile's own key to the server Base points it at, and reports it once Base moves it", async () => {
    const yamlHandlers = createRealHandlers({ getAppConfig: async () => baseAppConfig as never });
    const baseMoved = await patch(
      basePrincipalId,
      [{ fieldPath: 'mcpServers.tools.url', value: 'https://base.example/mcp' }],
      {},
      yamlHandlers,
    );
    expect(baseMoved.statusCode).toBe(200);

    /** Entered over the server as Base defines it, the key is bound there. */
    const principalId = nextPrincipalId();
    const keyed = await patch(principalId, [ownKey], {}, yamlHandlers);
    expect(keyed.statusCode).toBe(200);
    expect(keyed.body!.ignored).toBeUndefined();
    const stored = await readRawOverrides(principalId);
    expect(getAtPath(stored, 'mcpServers.tools.apiKey.keyBinding')).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(keyed.body)).not.toContain('keyBinding');

    const baseMovedAgain = await patch(
      basePrincipalId,
      [{ fieldPath: 'mcpServers.tools.url', value: 'https://attacker.example/mcp' }],
      {},
      yamlHandlers,
    );
    expect(baseMovedAgain.statusCode).toBe(200);
    const retitled = await patch(
      principalId,
      [{ fieldPath: 'mcpServers.tools.title', value: 'Tools' }],
      {},
      yamlHandlers,
    );
    expect(retitled.statusCode).toBe(200);
    expect(retitled.body!.ignored).toEqual([
      {
        path: 'mcpServers.tools.apiKey.key',
        segments: ['mcpServers', 'tools', 'apiKey', 'key'],
        reason: 'secret_rebinding',
      },
    ]);
    expect(
      getAtPath(await readRawOverrides(principalId), 'mcpServers.tools.apiKey.keyBinding'),
    ).toBe(getAtPath(stored, 'mcpServers.tools.apiKey.keyBinding'));

    /** Pinning the destination in the same profile keeps the key, with nothing to bind. */
    const pinnedId = nextPrincipalId();
    const pinned = await patch(
      pinnedId,
      [ownKey, { fieldPath: 'mcpServers.tools.url', value: 'https://tools.example.com/mcp' }],
      {},
      yamlHandlers,
    );
    expect(pinned.statusCode).toBe(200);
    expect(pinned.body!.ignored).toBeUndefined();
    expect(
      getAtPath(await readRawOverrides(pinnedId), 'mcpServers.tools.apiKey.keyBinding'),
    ).toBeUndefined();
  });

  it('drops the key Base stores for an endpoint a profile moves, whatever their priorities', async () => {
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () => ({ config: {} }) as never,
    });
    const baseKeyed = await patch(
      basePrincipalId,
      [
        {
          fieldPath: 'endpoints.custom',
          value: [
            {
              name: 'Gateway',
              apiKey: 'sk-base-gateway-key',
              baseURL: 'https://gateway.example.com/v1',
              models: { default: ['gpt-4o'] },
            },
          ],
        },
      ],
      { priority: 99 },
      yamlHandlers,
    );
    expect(baseKeyed.statusCode).toBe(200);

    /** Base merges first, so a profile below its priority still lands over it. */
    const moved = await patch(
      nextPrincipalId(),
      [
        {
          fieldPath: 'endpoints.custom',
          value: [{ name: 'Gateway', baseURL: 'https://attacker.example/v1' }],
        },
      ],
      { priority: 1 },
      yamlHandlers,
    );

    expect(moved.statusCode).toBe(200);
    expect(moved.body!.ignored).toEqual([
      {
        path: 'endpoints.custom["Gateway"].apiKey',
        segments: ['endpoints', 'custom', 'Gateway', 'apiKey'],
        reason: 'secret_rebinding',
      },
    ]);
  });

  it('reports `ignored` over the Base the write was judged on, without reading Base again', async () => {
    let baseReads = 0;
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () => baseAppConfig as never,
      findConfigByPrincipal: (principalType, principalId, options) => {
        if (principalId === basePrincipalId) {
          baseReads += 1;
        }
        return configMethods.findConfigByPrincipal(principalType, principalId, options);
      },
    });
    const baseKeyed = await patch(
      basePrincipalId,
      [
        {
          fieldPath: 'mcpServers.based',
          value: {
            type: 'streamable-http',
            url: 'https://based.example/mcp',
            apiKey: { source: 'admin', authorization_type: 'bearer', key: 'sk-base-own-key' },
          },
        },
      ],
      {},
      yamlHandlers,
    );
    expect(baseKeyed.statusCode).toBe(200);
    const move = { fieldPath: 'mcpServers.based.url', value: 'https://attacker.example/mcp' };
    const batch = (dryRun: boolean) =>
      send(yamlHandlers.applyConfigChanges, {
        params: { principalType: 'role', principalId: nextPrincipalId() },
        body: { ops: [{ op: 'set', ...move }], dryRun },
      });

    /** Each attempt reads Base beside the profile, and a written profile reads it once more. */
    const requests: Array<[string, () => Promise<MockResponse>, number]> = [
      ['PATCH', () => patch(nextPrincipalId(), [move], {}, yamlHandlers), 2],
      ['a written batch', () => batch(false), 2],
      ['a dry run', () => batch(true), 1],
    ];
    for (const [, request, reads] of requests) {
      baseReads = 0;
      const res = await request();
      expect(res.statusCode).toBe(200);
      expect(res.body!.ignored).toContainEqual({
        path: 'mcpServers.based.apiKey.key',
        segments: ['mcpServers', 'based', 'apiKey', 'key'],
        reason: 'secret_rebinding',
      });
      expect(baseReads).toBe(reads);
    }
  });

  it('reports the summarization key the Base profile entered once a profile switches provider', async () => {
    const yamlHandlers = createRealHandlers({
      getAppConfig: async () => ({ config: {} }) as never,
    });
    const baseKeyed = await patch(
      basePrincipalId,
      [
        { fieldPath: 'summarization.provider', value: 'openAI' },
        { fieldPath: 'summarization.parameters.baseURL', value: 'https://gateway.example/v1' },
        { fieldPath: 'summarization.parameters.apiKey', value: 'sk-base-gateway-key' },
      ],
      {},
      yamlHandlers,
    );
    expect(baseKeyed.statusCode).toBe(200);
    expect(baseKeyed.body!.ignored).toBeUndefined();

    const switched = await patch(
      nextPrincipalId(),
      [{ fieldPath: 'summarization.provider', value: 'anthropic' }],
      {},
      yamlHandlers,
    );
    expect(switched.statusCode).toBe(200);
    expect(switched.body!.ignored).toEqual(
      ['apiKey', 'baseURL'].map((key) => ({
        path: `summarization.parameters.${key}`,
        segments: ['summarization', 'parameters', key],
        reason: 'secret_rebinding',
      })),
    );
  });

  it('reports what a field removal or a tombstone drops', async () => {
    const yamlHandlers = createRealHandlers({ getAppConfig: async () => baseAppConfig as never });
    const principalId = nextPrincipalId();
    const seeded = await patch(
      principalId,
      [ownKey, { fieldPath: 'mcpServers.tools.url', value: 'https://profile.example/mcp' }],
      {},
      yamlHandlers,
    );
    expect(seeded.statusCode).toBe(200);
    expect(seeded.body!.ignored).toBeUndefined();

    /** Without its own key, the profile's URL would carry the librechat.yaml key. */
    const removed = await send(yamlHandlers.deleteConfigField, {
      params: { principalType: 'role', principalId },
      query: { fieldPath: 'mcpServers.tools.apiKey.key' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.body!.ignored).toEqual([
      expect.objectContaining({ path: 'mcpServers.tools.apiKey.key' }),
    ]);

    /** Removing the proxy changes the route the librechat.yaml key takes. */
    const tombstoned = await send(yamlHandlers.tombstoneConfigField, {
      params: { principalType: 'role', principalId: nextPrincipalId() },
      body: { fieldPath: 'mcpServers.tools.proxy' },
    });
    expect(tombstoned.statusCode).toBe(200);
    expect(tombstoned.body!.ignored).toEqual([
      expect.objectContaining({ path: 'mcpServers.tools.apiKey.key' }),
    ]);
  });
});

describe('keys bound to the destination beside them (custom endpoints, OCR, speech)', () => {
  const yaml = {
    endpoints: {
      custom: [
        {
          name: 'Regional',
          apiKey: 'user_provided',
          baseURL: 'https://regional.example.com/v1',
          models: { default: ['m'] },
        },
      ],
    },
  };
  const baseAppConfig = { config: yaml, endpoints: structuredClone(yaml.endpoints) };
  const yamlHandlers = () =>
    createRealHandlers({ getAppConfig: async () => structuredClone(baseAppConfig) as never });
  const shared = (extra: Record<string, unknown> = {}) => ({
    name: 'Shared',
    baseURL: 'https://shared.example.com/v1',
    models: { default: ['m'] },
    ...extra,
  });
  const reentryIssue = (path: string, secretPath: string) => ({
    path,
    segments: path.split('.'),
    code: 'secret_reentry_required',
    secretPath,
  });

  /** What the merge serves a profile over Base, decrypted, as `getAppConfig` would. */
  async function serve(principalId: string): Promise<AppConfigShape> {
    const { resolveConfigOverrides } = await import('~/app/overrides');
    const { createEnvReferencePolicy } = await import('~/app/allowlist');
    const [base, profile] = await Promise.all([
      configMethods.findConfigByPrincipal(PrincipalType.ROLE, basePrincipalId),
      configMethods.findConfigByPrincipal(PrincipalType.ROLE, principalId),
    ]);
    return resolveConfigOverrides(
      structuredClone(baseAppConfig) as never,
      [base, profile].filter((layer) => layer != null),
      { envPolicy: createEnvReferencePolicy({ config: yaml }) },
    ) as unknown as AppConfigShape;
  }

  afterEach(async () => {
    await mongoose.models.Config.deleteOne({ principalId: basePrincipalId });
  });

  it('needs a stored endpoint key again when the document that stores it moves it', async () => {
    const target = yamlHandlers();
    const keyed = await patch(
      basePrincipalId,
      [{ fieldPath: 'endpoints.custom', value: [shared({ apiKey: 'sk-shared-entered' })] }],
      {},
      target,
    );
    expect(keyed.statusCode).toBe(200);
    const before = await readRawOverrides(basePrincipalId);
    const moved = shared({ baseURL: 'https://attacker.example/v1' });

    const attempts: Array<[string, () => Promise<MockResponse>]> = [
      [
        'PATCH',
        () =>
          patch(basePrincipalId, [{ fieldPath: 'endpoints.custom', value: [moved] }], {}, target),
      ],
      [
        'PUT',
        () =>
          send(target.upsertConfigOverrides, {
            params: { principalType: 'role', principalId: basePrincipalId },
            body: { overrides: { endpoints: { custom: [moved] } } },
          }),
      ],
      ...[true, false].map((dryRun): [string, () => Promise<MockResponse>] => [
        `/changes${dryRun ? ' (dry run)' : ''}`,
        () =>
          send(target.applyConfigChanges, {
            params: { principalType: 'role', principalId: basePrincipalId },
            body: {
              ops: [{ op: 'upsertEntry', fieldPath: 'endpoints.custom', entry: moved }],
              dryRun,
            },
          }),
      ]),
    ];
    for (const [, attempt] of attempts) {
      const res = await attempt();
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'CONFIG_SECRET_REENTRY_REQUIRED',
        issues: [reentryIssue('endpoints.custom.0.baseURL', 'endpoints.custom.0.apiKey')],
      });
    }
    expect(await readRawOverrides(basePrincipalId)).toEqual(before);

    const provider = await patch(
      basePrincipalId,
      [{ fieldPath: 'endpoints.custom', value: [shared({ provider: 'anthropic' })] }],
      {},
      target,
    );
    expect(provider.statusCode).toBe(400);
    expect(provider.body!.issues).toEqual([
      reentryIssue('endpoints.custom.0.provider', 'endpoints.custom.0.apiKey'),
    ]);

    const edited = await patch(
      basePrincipalId,
      [{ fieldPath: 'endpoints.custom', value: [shared({ models: { default: ['m', 'n'] } })] }],
      {},
      target,
    );
    expect(edited.statusCode).toBe(200);
    const entry = (await readRawOverrides(basePrincipalId)) as {
      endpoints: { custom: Array<Record<string, unknown>> };
    };
    expect(entry.endpoints.custom[0].apiKey).toBe(
      (before as { endpoints: { custom: Array<Record<string, unknown>> } }).endpoints.custom[0]
        .apiKey,
    );

    const reentered = await patch(
      basePrincipalId,
      [{ fieldPath: 'endpoints.custom', value: [{ ...moved, apiKey: 'sk-shared-again' }] }],
      {},
      target,
    );
    expect(reentered.statusCode).toBe(200);
  });

  it('needs a stored OCR or speech key again when the document moves it, by any route', async () => {
    const target = yamlHandlers();
    const principalId = nextPrincipalId();
    const keyed = await patch(
      principalId,
      [
        {
          fieldPath: 'ocr',
          value: { apiKey: 'sk-ocr-entered', baseURL: 'https://ocr.example.com/v1' },
        },
        {
          fieldPath: 'speech.tts.openai',
          value: {
            apiKey: 'sk-tts-entered',
            url: 'https://tts.example.com/v1',
            model: 'tts-1',
            voices: ['alloy'],
          },
        },
      ],
      {},
      target,
    );
    expect(keyed.statusCode).toBe(200);
    const before = await readRawOverrides(principalId);
    const params = { principalType: 'role', principalId };

    const attempts: Array<[() => Promise<MockResponse>, string, string]> = [
      [
        () =>
          patch(
            principalId,
            [{ fieldPath: 'ocr.baseURL', value: 'https://attacker.example/v1' }],
            {},
            target,
          ),
        'ocr.baseURL',
        'ocr.apiKey',
      ],
      [
        () => send(target.deleteConfigField, { params, query: { fieldPath: 'ocr.baseURL' } }),
        'ocr.baseURL',
        'ocr.apiKey',
      ],
      [
        () => send(target.tombstoneConfigField, { params, body: { fieldPath: 'ocr.baseURL' } }),
        'ocr.baseURL',
        'ocr.apiKey',
      ],
      [
        () =>
          patch(
            principalId,
            [{ fieldPath: 'speech.tts.openai.url', value: 'https://attacker.example/v1' }],
            {},
            target,
          ),
        'speech.tts.openai.url',
        'speech.tts.openai.apiKey',
      ],
    ];
    for (const [attempt, path, secretPath] of attempts) {
      const res = await attempt();
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'CONFIG_SECRET_REENTRY_REQUIRED',
        issues: [reentryIssue(path, secretPath)],
      });
    }
    expect(await readRawOverrides(principalId)).toEqual(before);

    const removed = await send(target.deleteConfigField, {
      params,
      query: { fieldPath: 'ocr.apiKey' },
    });
    expect(removed.statusCode).toBe(200);
    const moved = await patch(
      principalId,
      [{ fieldPath: 'ocr.baseURL', value: 'https://elsewhere.example/v1' }],
      {},
      target,
    );
    expect(moved.statusCode).toBe(200);
  });

  it("binds a profile's own endpoint key to the endpoint Base defines, until Base moves it", async () => {
    const target = yamlHandlers();
    const baseKeyed = await patch(
      basePrincipalId,
      [{ fieldPath: 'endpoints.custom', value: [shared({ apiKey: 'sk-base-shared' })] }],
      {},
      target,
    );
    expect(baseKeyed.statusCode).toBe(200);

    const principalId = nextPrincipalId();
    const keyed = await patch(
      principalId,
      [
        {
          fieldPath: 'endpoints.custom',
          value: [{ name: 'Shared', apiKey: 'sk-role-shared', apiKeyBinding: 'f'.repeat(64) }],
        },
      ],
      {},
      target,
    );
    expect(keyed.statusCode).toBe(200);
    expect(keyed.body!.ignored).toBeUndefined();
    const stored = (await readRawOverrides(principalId)) as {
      endpoints: { custom: Array<Record<string, unknown>> };
    };
    const [entry] = stored.endpoints.custom;
    expect(entry.apiKeyBinding).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.apiKeyBinding).not.toBe('f'.repeat(64));
    expect(JSON.stringify(keyed.body)).not.toContain('apiKeyBinding');

    const read = await send(target.getConfig, { params: { principalType: 'role', principalId } });
    expect(JSON.stringify(read.body)).not.toContain('apiKeyBinding');
    const servedEntry = (await serve(principalId)).endpoints?.custom?.find(
      ({ name }) => name === 'Shared',
    );
    expect(servedEntry).toMatchObject({ baseURL: 'https://shared.example.com/v1' });
    expect(decryptV3(servedEntry!.apiKey as string)).toBe('sk-role-shared');

    /** A write that keeps the key, a round trip of what a read returns included, keeps its binding. */
    const roundTrip = await send(target.upsertConfigOverrides, {
      params: { principalType: 'role', principalId },
      body: { overrides: (read.body!.config as { overrides: Record<string, unknown> }).overrides },
    });
    expect(roundTrip.statusCode).toBe(200);
    expect(roundTrip.body!.ignored).toBeUndefined();
    const kept = (await readRawOverrides(principalId)) as typeof stored;
    expect(kept.endpoints.custom[0]).toMatchObject({
      apiKey: entry.apiKey,
      apiKeyBinding: entry.apiKeyBinding,
    });

    const baseMoved = await patch(
      basePrincipalId,
      [
        {
          fieldPath: 'endpoints.custom',
          value: [shared({ baseURL: 'https://attacker.example/v1', apiKey: 'sk-base-again' })],
        },
      ],
      {},
      target,
    );
    expect(baseMoved.statusCode).toBe(200);
    const dropped = (await serve(principalId)).endpoints?.custom?.find(
      ({ name }) => name === 'Shared',
    );
    expect(dropped).toMatchObject({ apiKey: '', baseURL: 'https://attacker.example/v1' });
    const reported = await send(target.applyConfigChanges, {
      params: { principalType: 'role', principalId },
      body: {
        ops: [{ op: 'set', fieldPath: 'interface.customWelcome', value: 'hi' }],
        dryRun: true,
      },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.body!.ignored).toEqual([
      {
        path: 'endpoints.custom["Shared"].apiKey',
        segments: ['endpoints', 'custom', 'Shared', 'apiKey'],
        reason: 'secret_rebinding',
      },
    ]);

    /** Entering the key again over the moved endpoint binds it there. */
    const rekeyed = await patch(
      principalId,
      [{ fieldPath: 'endpoints.custom', value: [{ name: 'Shared', apiKey: 'sk-role-again' }] }],
      {},
      target,
    );
    expect(rekeyed.statusCode).toBe(200);
    expect(rekeyed.body!.ignored).toBeUndefined();
    const rebound = (await serve(principalId)).endpoints?.custom?.find(
      ({ name }) => name === 'Shared',
    );
    expect(rebound).toMatchObject({ baseURL: 'https://attacker.example/v1' });
    expect(decryptV3(rebound!.apiKey as string)).toBe('sk-role-again');
    expect(JSON.stringify(await readRawOverrides(basePrincipalId))).not.toContain('apiKeyBinding');
  });

  it("sets back the destination of a user_provided endpoint a profile moves, so users' keys stay", async () => {
    const target = yamlHandlers();
    const principalId = nextPrincipalId();
    const moved = await patch(
      principalId,
      [
        {
          fieldPath: 'endpoints.custom',
          value: [{ name: 'Regional', baseURL: 'https://attacker.example/v1' }],
        },
      ],
      {},
      target,
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.body!.ignored).toEqual([
      {
        path: 'endpoints.custom["Regional"].baseURL',
        segments: ['endpoints', 'custom', 'Regional', 'baseURL'],
        reason: 'secret_rebinding',
      },
    ]);
    const served = (await serve(principalId)).endpoints?.custom?.find(
      ({ name }) => name === 'Regional',
    );
    expect(served).toMatchObject({
      apiKey: 'user_provided',
      baseURL: 'https://regional.example.com/v1',
    });
  });
});

/**
 * Every handler `createAdminConfigHandlers` returns, by what it can write. A handler that changes
 * what a document holds must run the guards PUT and PATCH run: the MCP re-entry rule, the env
 * reference allowlist on every value it takes, and the `ignored` report. A handler added later (a
 * batch route, a keyed collection op) fails the first test until it is listed here with the
 * requests that attempt each.
 */
describe('write guards on every handler that changes a document', () => {
  const STORED_URL = 'https://mcp.example.com/mcp';
  const EVIL_URL = 'https://evil.example/mcp';
  const UNLISTED_URL = 'https://h.example/${LC8_UNLISTED_NAME}';
  const yaml = {
    mcpServers: {
      tools: {
        type: 'streamable-http',
        url: 'https://tools.example.com/mcp',
        proxy: 'http://proxy.corp.example:8080',
        apiKey: { source: 'admin', authorization_type: 'bearer', key: '${TOOLS_KEY}' },
      },
    },
  };
  const yamlHandlers = (): AdminConfigHandlers =>
    createRealHandlers({
      getAppConfig: async () =>
        ({ config: yaml, mcpConfig: structuredClone(yaml.mcpServers) }) as never,
    });

  /** The seeded server as a read returns it: without the credentials. */
  const redactedServer = (url: string) => ({
    type: 'streamable-http',
    url,
    apiKey: { source: 'admin', authorization_type: 'bearer' },
    oauth: {
      client_id: 'client',
      authorization_url: 'https://auth.example.com/authorize',
      token_url: 'https://auth.example.com/token',
    },
  });
  const at = (principalId: string) => ({ principalType: 'role', principalId });

  type Attempt = (target: AdminConfigHandlers, principalId: string) => Promise<MockResponse>;

  interface ContentWriter {
    /** Points the seeded server `github`, whose credentials are stored, at `EVIL_URL`. */
    move: Attempt;
    /** Writes `UNLISTED_URL` as `github`'s URL; `null` for a handler that takes no values. */
    envReference: Attempt | null;
    /**
     * Leaves librechat.yaml's `tools` sending its `${TOOLS_KEY}` somewhere librechat.yaml did not
     * choose, without a key of its own (seeding what it removes first).
     */
    rebind: Attempt;
  }

  const CONTENT_WRITERS: Record<string, ContentWriter> = {
    upsertConfigOverrides: {
      move: (target, principalId) =>
        send(target.upsertConfigOverrides, {
          params: at(principalId),
          body: { overrides: { mcpServers: { github: redactedServer(EVIL_URL) } } },
        }),
      envReference: (target, principalId) =>
        send(target.upsertConfigOverrides, {
          params: at(principalId),
          body: { overrides: { mcpServers: { github: redactedServer(UNLISTED_URL) } } },
        }),
      rebind: (target, principalId) =>
        send(target.upsertConfigOverrides, {
          params: at(principalId),
          body: { overrides: { mcpServers: { tools: { url: EVIL_URL } } } },
        }),
    },
    patchConfigField: {
      move: (target, principalId) =>
        patch(principalId, [{ fieldPath: 'mcpServers.github.url', value: EVIL_URL }], {}, target),
      envReference: (target, principalId) =>
        patch(
          principalId,
          [{ fieldPath: 'mcpServers.github.url', value: UNLISTED_URL }],
          {},
          target,
        ),
      rebind: (target, principalId) =>
        patch(principalId, [{ fieldPath: 'mcpServers.tools.url', value: EVIL_URL }], {}, target),
    },
    deleteConfigField: {
      move: (target, principalId) =>
        send(target.deleteConfigField, {
          params: at(principalId),
          query: { fieldPath: 'mcpServers.github.url' },
        }),
      envReference: null,
      rebind: async (target, principalId) => {
        const keyed = await patch(
          principalId,
          [
            {
              fieldPath: 'mcpServers.tools.apiKey',
              value: { source: 'admin', authorization_type: 'bearer', key: 'sk-profile-own-key' },
            },
            { fieldPath: 'mcpServers.tools.url', value: EVIL_URL },
          ],
          {},
          target,
        );
        expect(keyed.statusCode).toBe(200);
        expect(keyed.body!.ignored).toBeUndefined();
        return send(target.deleteConfigField, {
          params: at(principalId),
          query: { fieldPath: 'mcpServers.tools.apiKey.key' },
        });
      },
    },
    tombstoneConfigField: {
      move: (target, principalId) =>
        send(target.tombstoneConfigField, {
          params: at(principalId),
          body: { fieldPath: 'mcpServers.github.url' },
        }),
      envReference: null,
      rebind: (target, principalId) =>
        send(target.tombstoneConfigField, {
          params: at(principalId),
          body: { fieldPath: 'mcpServers.tools.proxy' },
        }),
    },
    applyConfigChanges: {
      move: (target, principalId) =>
        send(target.applyConfigChanges, {
          params: at(principalId),
          body: { ops: [{ op: 'set', fieldPath: 'mcpServers.github.url', value: EVIL_URL }] },
        }),
      envReference: (target, principalId) =>
        send(target.applyConfigChanges, {
          params: at(principalId),
          body: {
            ops: [
              { op: 'set', fieldPath: 'mcpServers.github', value: redactedServer(UNLISTED_URL) },
            ],
          },
        }),
      rebind: (target, principalId) =>
        send(target.applyConfigChanges, {
          params: at(principalId),
          body: { ops: [{ op: 'tombstone', fieldPath: 'mcpServers.tools.proxy' }] },
        }),
    },
  };

  /** Handlers that never change what a document holds, and why the guards do not apply. */
  const OTHER_HANDLERS: Record<string, string> = {
    getConfigMeta: 'reads the API contract',
    listConfigs: 'reads',
    getBaseConfig: 'reads',
    getConfig: 'reads',
    deleteConfigOverrides: 'removes the whole document, credentials and all',
    toggleConfig: 'switches the document on or off; the merge judges the layers it brings in',
    updateConfigPriority:
      'sets only the priority, keeping overrides and tombstones; the merge judges the order it brings in',
    reloadConfig: 'clears the config caches; no document is read or written',
  };

  it('lists every handler', () => {
    const listed = new Set([...Object.keys(CONTENT_WRITERS), ...Object.keys(OTHER_HANDLERS)]);
    expect(Object.keys(handlers).filter((name) => !listed.has(name))).toEqual([]);
  });

  it('keeps stored credentials through a priority change and answers with their previews only', async () => {
    const principalId = nextPrincipalId();
    const seeded = await patch(principalId, [
      { fieldPath: 'mcpServers.github', value: mcpServer() },
    ]);
    expect(seeded.statusCode).toBe(200);
    const before = await configMethods.findConfigByPrincipal(PrincipalType.ROLE, principalId);
    const stored = await storedServer(principalId, 'github');

    const res = await send(
      createRealHandlers({ setConfigPriority: configMethods.setConfigPriority })
        .updateConfigPriority,
      { params: at(principalId), body: { priority: 42 } },
    );

    expect(res.statusCode).toBe(200);
    const after = await configMethods.findConfigByPrincipal(PrincipalType.ROLE, principalId);
    expect(after?.priority).toBe(42);
    expect(after?.overrides).toEqual(before?.overrides);
    const body = JSON.stringify(res.body);
    for (const value of [API_KEY, CLIENT_SECRET, stored.apiKey.key, stored.oauth.client_secret]) {
      expect(body).not.toContain(value);
    }
    expect(getAtPath(res.body, 'config.overrides.mcpServers.github.apiKey')).toEqual({
      source: 'admin',
      authorization_type: 'bearer',
      keyPreview: stored.apiKey.keyPreview,
    });
  });

  describe.each(Object.entries(CONTENT_WRITERS))('%s', (_name, { move, envReference, rebind }) => {
    it('refuses sending a stored MCP credential to a new URL without entering it again', async () => {
      const principalId = nextPrincipalId();
      const seeded = await patch(principalId, [
        { fieldPath: 'mcpServers.github', value: mcpServer() },
      ]);
      expect(seeded.statusCode).toBe(200);

      const res = await move(handlers, principalId);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'MCP_API_KEY_REENTRY_REQUIRED',
        server: 'github',
        fields: ['url'],
      });
      expect((await storedServer(principalId, 'github')).url).toBe(STORED_URL);
    });

    if (envReference) {
      it('refuses an env reference outside the allowlist', async () => {
        const principalId = nextPrincipalId();

        const res = await envReference(handlers, principalId);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({
          code: 'CONFIG_OVERRIDE_INVALID',
          issues: [
            {
              path: 'mcpServers.github.url',
              segments: ['mcpServers', 'github', 'url'],
              code: 'env_reference_not_allowed',
            },
          ],
        });
        expect(await mongoose.models.Config.findOne({ principalId })).toBeNull();
      });
    }

    it('reports the inherited key it leaves on another destination in `ignored`', async () => {
      const res = await rebind(yamlHandlers(), nextPrincipalId());

      expect([200, 201]).toContain(res.statusCode);
      expect(res.body!.ignored).toEqual([
        {
          path: 'mcpServers.tools.apiKey.key',
          segments: ['mcpServers', 'tools', 'apiKey', 'key'],
          reason: 'secret_rebinding',
        },
      ]);
    });
  });
});

describe('a document an MCP removal creates', () => {
  it.each([PrincipalType.ROLE, PrincipalType.GROUP, PrincipalType.USER])(
    'gets, for a %s, the priority and state the store gives any other tombstone',
    async (principalType) => {
      const tombstone = async (fieldPath: string) => {
        const principalId = new mongoose.Types.ObjectId().toString();
        const res = await send(handlers.tombstoneConfigField, {
          params: { principalType, principalId },
          body: { fieldPath },
        });
        expect(res.statusCode).toBe(200);
        const created = await configMethods.findConfigByPrincipal(principalType, principalId);
        return {
          principalModel: created?.principalModel,
          priority: created?.priority,
          isActive: created?.isActive,
        };
      };

      const mcp = await tombstone('mcpServers.github.url');

      expect(mcp.priority).toEqual(expect.any(Number));
      expect(mcp).toEqual(await tombstone('ocr.baseURL'));
    },
  );

  it.each([PrincipalType.GROUP, PrincipalType.USER])(
    'is refused for a %s that does not exist, and an unset finds no document',
    async (principalType) => {
      const guarded = createRealHandlers({ principalExists: configMethods.principalExists });
      const principalId = new mongoose.Types.ObjectId().toString();
      const params = { principalType, principalId };

      const tombstoned = await send(guarded.tombstoneConfigField, {
        params,
        body: { fieldPath: 'mcpServers.github.url' },
      });
      const unset = await send(guarded.deleteConfigField, {
        params,
        query: { fieldPath: 'mcpServers.github.url' },
      });

      expect(tombstoned.statusCode).toBe(404);
      expect(tombstoned.body).toMatchObject({ code: 'PRINCIPAL_NOT_FOUND' });
      expect(unset.statusCode).toBe(404);
      expect(unset.body).toEqual({ error: 'Config not found', code: 'CONFIG_NOT_FOUND' });
      expect(await mongoose.models.Config.findOne({ principalId })).toBeNull();
    },
  );
});

describe('getBaseConfig with MCP and Azure credentials', () => {
  it('never returns a YAML literal or a decrypted override credential', async () => {
    const appConfig = {
      mcpConfig: {
        yaml: { url: 'https://y', apiKey: { key: 'yaml-literal-mcp-key' } },
        stored: {
          url: 'https://s',
          apiKey: { key: 'decrypted-at-merge-key', keyPreview: '...-key' },
          oauth: { client_secret: '${OAUTH_SECRET}' },
        },
      },
      endpoints: {
        azureOpenAI: {
          groups: [{ group: 'east', apiKey: 'yaml-literal-azure-key' }],
          groupMap: {
            east: { apiKey: 'yaml-literal-azure-groupmap-key', instanceName: 'east' },
            env: { apiKey: '${AZURE_ENV_KEY}', instanceName: 'env' },
          },
        },
      },
      config: {
        mcpServers: { yaml: { url: 'https://y', apiKey: { key: 'yaml-literal-mcp-key' } } },
      },
    };
    const baseHandlers = createRealHandlers({ getAppConfig: async () => appConfig as never });

    const res = await send(baseHandlers.getBaseConfig, { query: { baseOnly: 'true' } });

    expect(res.statusCode).toBe(200);
    const payload = JSON.stringify(res.body);
    for (const secret of ['yaml-literal-mcp-key', 'decrypted-at-merge-key', 'yaml-literal-azure']) {
      expect(payload).not.toContain(secret);
    }
    const config = res.body!.config as Record<string, unknown>;
    expect(getAtPath(config, 'mcpConfig.yaml.apiKey.keyPreview')).toBe(UNPREVIEWED_SECRET_MASK);
    expect(getAtPath(config, 'mcpConfig.stored.apiKey.keyPreview')).toBe('...-key');
    expect(getAtPath(config, 'mcpConfig.stored.oauth.client_secret')).toBe('${OAUTH_SECRET}');
    expect(getAtPath(config, 'config.mcpServers.yaml.apiKey.keyPreview')).toBe(
      UNPREVIEWED_SECRET_MASK,
    );
    expect(getAtPath(config, 'endpoints.azureOpenAI.groupMap')).toEqual({
      east: { apiKeyPreview: UNPREVIEWED_SECRET_MASK, instanceName: 'east' },
      env: { apiKey: '${AZURE_ENV_KEY}', instanceName: 'env' },
    });
  });
});
