import type { ConfigDraft, ConfigRecord } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ConfigReloadReport } from '~/app/invalidation';
import type { ServerRequest } from '~/types/http';

process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

jest.mock('@librechat/data-schemas', () => {
  process.env.CREDS_KEY =
    process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    encryptV3: jest.fn((value: string) => `v3:test:${value}`),
    /** Spies that keep the real validation, to see which document it was shown. */
    getConfigOverrideIssues: jest.fn(actual.getConfigOverrideIssues),
    getConfigFieldIssues: jest.fn(actual.getConfigFieldIssues),
  };
});

import { configSchema } from 'librechat-data-provider';
import {
  getConfigFieldIssues,
  getConfigOverrideIssues,
  ConfigRevisionConflictError,
} from '@librechat/data-schemas';
import { createAdminConfigHandlers } from './config';

function mockReq(overrides = {}) {
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
  body: undefined | { config?: unknown; error?: string; [key: string]: unknown };
  status: jest.Mock;
  json: jest.Mock;
}

function mockRes() {
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

/** The document a whole-document write stores: version 1 on create, else one past the revision. */
function writtenDocument(
  principalType: string,
  principalId: string,
  draft: ConfigDraft,
  expected: string,
): ConfigRecord {
  const configVersion = expected === 'absent' ? 1 : Number(expected.split(':')[1]) + 1;
  return {
    _id: 'c1',
    principalType: principalType as ConfigRecord['principalType'],
    principalId,
    ...draft,
    configVersion,
  };
}

/** The draft the handler wrote with its `n`-th whole-document write. */
function writtenDraft(deps: { writeConfigDocument: jest.Mock }, call = 0) {
  return deps.writeConfigDocument.mock.calls[call][2] as Record<string, unknown> & {
    overrides: Record<string, unknown>;
    tombstones: string[];
    priority: number;
    isActive: boolean;
  };
}

/** The value the handler's first whole-document write stored at a dotted path. */
function writtenField(deps: { writeConfigDocument: jest.Mock }, fieldPath: string): unknown {
  return fieldPath
    .split('.')
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      writtenDraft(deps).overrides,
    );
}

function createHandlers(overrides = {}) {
  const deps = {
    listAllConfigs: jest.fn().mockResolvedValue([]),
    findConfigByPrincipal: jest.fn().mockResolvedValue(null),
    writeConfigDocument: jest.fn(
      async (principalType: string, principalId: string, draft: ConfigDraft, expected: string) =>
        writtenDocument(principalType, principalId, draft, expected),
    ),
    unsetConfigField: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {} }),
    deleteConfig: jest.fn().mockResolvedValue({ _id: 'c1' }),
    toggleConfigActiveTracked: jest
      .fn()
      .mockResolvedValue({ config: { _id: 'c1', isActive: false }, changed: true }),
    hasConfigCapability: jest.fn().mockResolvedValue(true),
    hasAnyConfigReadAccess: jest.fn().mockResolvedValue(true),
    hasCapability: jest.fn().mockResolvedValue(true),

    getAppConfig: jest.fn().mockResolvedValue({ interface: { modelSelect: true } }),
    ...overrides,
  };
  const handlers = createAdminConfigHandlers(deps);
  return { handlers, deps };
}

describe('createAdminConfigHandlers', () => {
  describe('listConfigs', () => {
    it('redacts secret fields from config list responses', async () => {
      const { handlers } = createHandlers({
        listAllConfigs: jest.fn().mockResolvedValue([
          {
            _id: 'c1',
            principalType: 'role',
            principalId: 'admin',
            overrides: {
              langfuse: {
                publicKey: 'pk-lf-1',
                secretKey: 'v3:encrypted',
                secretKeyPreview: 'sk-lf-...cret',
              },
            },
          },
        ]),
      });
      const req = mockReq();
      const res = mockRes();

      await handlers.listConfigs(req, res);

      expect(res.statusCode).toBe(200);
      const configs = res.body!.configs as Array<{
        overrides: { langfuse: Record<string, string> };
      }>;
      expect(configs[0].overrides.langfuse).toEqual({
        publicKey: 'pk-lf-1',
        secretKeyPreview: '*************',
      });
    });
  });

  describe('getConfig', () => {
    it('returns 403 before DB lookup when user lacks READ_CONFIGS', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasAnyConfigReadAccess: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.getConfig(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });

    it('returns 404 when config does not exist', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({ params: { principalType: 'role', principalId: 'nonexistent' } });
      const res = mockRes();

      await handlers.getConfig(req, res);

      expect(res.statusCode).toBe(404);
    });

    it('returns config when authorized and exists', async () => {
      const config = {
        _id: 'c1',
        principalType: 'role',
        principalId: 'admin',
        overrides: { x: 1 },
      };
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(config),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.getConfig(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.config).toEqual({ ...config, revision: 'c1:0' });
    });

    it('returns 400 for invalid principalType', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({ params: { principalType: 'invalid', principalId: 'x' } });
      const res = mockRes();

      await handlers.getConfig(req, res);

      expect(res.statusCode).toBe(400);
    });

    it('rejects public principalType — not usable for config overrides', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({ params: { principalType: 'public', principalId: 'x' } });
      const res = mockRes();

      await handlers.getConfig(req, res);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('read handlers: section-scoped-only caller (no broad read:configs)', () => {
    function sectionOnlyDeps(section: string, overrides: Record<string, unknown> = {}) {
      return {
        hasConfigCapability: jest.fn(
          async (_user: unknown, s: string | null, verb = 'manage') =>
            verb === 'read' && s === section,
        ),
        hasAnyConfigReadAccess: jest.fn().mockResolvedValue(true),
        ...overrides,
      };
    }

    it('getConfig: returns 200 with only the held section, other sections stripped', async () => {
      const config = {
        _id: 'c1',
        principalType: 'role',
        principalId: 'admin',
        overrides: { memory: { charLimit: 500 }, endpoints: { allowedAddresses: ['10.0.0.1'] } },
        tombstones: ['memory.tokenLimit', 'endpoints.allowedAddresses'],
      };
      const { handlers } = createHandlers(
        sectionOnlyDeps('memory', { findConfigByPrincipal: jest.fn().mockResolvedValue(config) }),
      );
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.getConfig(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as { overrides: Record<string, unknown>; tombstones: string[] };
      expect(body.overrides.memory).toEqual({ charLimit: 500 });
      expect(body.overrides.endpoints).toBeUndefined();
      expect(body.tombstones).toEqual(['memory.tokenLimit']);
    });

    it('listConfigs: strips non-held sections from every listed config', async () => {
      const configs = [
        { _id: 'c1', principalType: 'role', principalId: 'admin', overrides: { memory: {} } },
        {
          _id: 'c2',
          principalType: 'user',
          principalId: 'u1',
          overrides: { endpoints: {}, memory: { charLimit: 10 } },
        },
      ];
      const { handlers } = createHandlers(
        sectionOnlyDeps('memory', { listAllConfigs: jest.fn().mockResolvedValue(configs) }),
      );
      const req = mockReq();
      const res = mockRes();

      await handlers.listConfigs(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!.configs as Array<{ overrides: Record<string, unknown> }>;
      expect(body[0].overrides).toEqual({ memory: {} });
      expect(body[1].overrides).toEqual({ memory: { charLimit: 10 } });
    });

    it('getBaseConfig: strips top-level sections and the nested config field to only the held section', async () => {
      const appConfig = {
        memory: { charLimit: 500 },
        endpoints: { allowedAddresses: ['10.0.0.1'] },
        fileStrategy: 's3',
        config: { memory: { charLimit: 500 }, endpoints: { allowedAddresses: ['10.0.0.1'] } },
        paths: { uploads: '/tmp' },
        availableTools: { foo: {} },
      };
      const { handlers } = createHandlers(
        sectionOnlyDeps('memory', { getAppConfig: jest.fn().mockResolvedValue(appConfig) }),
      );
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as Record<string, unknown>;
      expect(body.memory).toEqual({ charLimit: 500 });
      expect(body.endpoints).toBeUndefined();
      expect(body.fileStrategy).toBeUndefined();
      expect((body.config as Record<string, unknown>).memory).toEqual({ charLimit: 500 });
      expect((body.config as Record<string, unknown>).endpoints).toBeUndefined();
      expect(body.paths).toEqual({ uploads: '/tmp' });
      expect(body.availableTools).toBeUndefined();
    });

    it('getBaseConfig: strips availableTools when the caller holds neither of its source sections', async () => {
      const appConfig = {
        memory: { charLimit: 500 },
        filteredTools: ['dalle'],
        includedTools: ['google'],
        availableTools: { google: {} },
        paths: { uploads: '/tmp' },
      };
      const { handlers } = createHandlers(
        sectionOnlyDeps('memory', { getAppConfig: jest.fn().mockResolvedValue(appConfig) }),
      );
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as Record<string, unknown>;
      expect(body.availableTools).toBeUndefined();
      expect(body.filteredTools).toBeUndefined();
      expect(body.includedTools).toBeUndefined();
    });

    it.each(['filteredTools', 'includedTools'])(
      'getBaseConfig: returns availableTools to a caller holding read:configs:%s',
      async (section) => {
        const appConfig = {
          filteredTools: ['dalle'],
          includedTools: ['google'],
          availableTools: { google: {} },
          paths: { uploads: '/tmp' },
        };
        const { handlers } = createHandlers(
          sectionOnlyDeps(section, { getAppConfig: jest.fn().mockResolvedValue(appConfig) }),
        );
        const req = mockReq();
        const res = mockRes();

        await handlers.getBaseConfig(req, res);

        expect(res.statusCode).toBe(200);
        const body = res.body!.config as Record<string, unknown>;
        expect(body.availableTools).toEqual({ google: {} });
      },
    );

    it('getBaseConfig: returns fileStrategy only to a caller holding read:configs:fileStrategy', async () => {
      const appConfig = {
        fileStrategy: 's3',
        memory: { charLimit: 500 },
        paths: { uploads: '/tmp' },
        availableTools: {},
      };
      const { handlers } = createHandlers(
        sectionOnlyDeps('fileStrategy', { getAppConfig: jest.fn().mockResolvedValue(appConfig) }),
      );
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as Record<string, unknown>;
      expect(body.fileStrategy).toBe('s3');
      expect(body.memory).toBeUndefined();
    });

    it('getBaseConfig: normalizes renamed top-level fields to their canonical section before checking read access', async () => {
      // getAppConfig renames interface -> interfaceConfig, turnstile -> turnstileConfig,
      // and mcpServers -> mcpConfig in the resolved payload. A caller holding
      // read:configs:interface and read:configs:turnstile (but not mcpServers) must
      // still see interfaceConfig/turnstileConfig, since checking the raw field name
      // against a nonexistent "interfaceConfig"/"turnstileConfig" section would wrongly
      // strip them.
      const appConfig = {
        interfaceConfig: { modelSelect: true },
        turnstileConfig: { siteKey: 'abc' },
        mcpConfig: { docs: {} },
        paths: { uploads: '/tmp' },
        availableTools: {},
      };
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn(
          async (_user: unknown, s: string | null, verb = 'manage') =>
            verb === 'read' && (s === 'interface' || s === 'turnstile'),
        ),
        hasAnyConfigReadAccess: jest.fn().mockResolvedValue(true),
        getAppConfig: jest.fn().mockResolvedValue(appConfig),
      });
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as Record<string, unknown>;
      expect(body.interfaceConfig).toEqual({ modelSelect: true });
      expect(body.turnstileConfig).toEqual({ siteKey: 'abc' });
      expect(body.mcpConfig).toBeUndefined();
    });
  });

  describe('upsertConfigOverrides', () => {
    it('returns 201 when creating a new config (configVersion === 1)', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: { interface: { modelSelect: false } } },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
    });

    it('returns 200 when updating an existing config (configVersion > 1)', async () => {
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest
          .fn()
          .mockResolvedValue({ _id: 'c1', configVersion: 5, overrides: {}, tombstones: [] }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: { interface: { modelSelect: false } } },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when overrides is missing', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {},
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
    });

    it('rejects process-backed MCP servers in database overrides', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'user', principalId: 'u1' },
        body: {
          overrides: {
            mcpServers: {
              injected: { type: 'stdio', command: '/bin/sh', args: ['-c', 'id'] },
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Process-backed MCP servers can only be configured in librechat.yaml',
        code: 'PROCESS_MCP_CONFIG',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects Langfuse header overrides, which cannot be encrypted at rest', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'user', principalId: 'u1' },
        body: {
          overrides: {
            langfuse: { enabled: true, headers: { 'X-Proxy-Token': 'leaked' } },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Langfuse request headers can only be configured in librechat.yaml',
        code: 'LANGFUSE_HEADERS_CONFIG',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it.each([
      ['nested dotted key', { langfuse: { 'headers.X-Proxy-Token': 'credential' } }],
      ['root dotted path', { 'langfuse.headers': { 'X-Proxy-Token': 'credential' } }],
      ['root dotted header path', { 'langfuse.headers.X-Proxy-Token': 'credential' }],
    ])('rejects Langfuse headers supplied as a %s', async (_label, overrides) => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({ params: { principalType: 'user', principalId: 'u1' }, body: { overrides } }),
        res,
      );

      /** `overrides` is a Mixed document written wholesale, so a dotted key
       *  persists verbatim and the nested-map redactor never walks it — the
       *  credential would come back in plaintext on the next read. */
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Langfuse request headers can only be configured in librechat.yaml',
        code: 'LANGFUSE_HEADERS_CONFIG',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects process-backed MCP servers supplied through the runtime config alias', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'user', principalId: 'u1' },
        body: {
          overrides: {
            mcpConfig: {
              injected: { command: '/bin/sh', args: ['-c', 'id'] },
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid config override',
        code: 'CONFIG_OVERRIDE_INVALID',
        issues: [{ path: 'mcpConfig', segments: ['mcpConfig'], code: 'unknown_section' }],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('strips permission fields from interface overrides but keeps UI fields', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            interface: { modelSelect: false, prompts: false, agents: { use: false } },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      const savedOverrides = writtenDraft(deps).overrides;
      expect(savedOverrides.interface).toEqual({ modelSelect: false });
    });

    it('collapses an explicit schedules disable to the boolean form in overrides', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: { interface: { schedules: { use: false, maxPerUser: 2 } } },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      const savedOverrides = writtenDraft(deps).overrides;
      expect(savedOverrides.interface).toEqual({ schedules: false });
    });

    it('preserves skillSync sections in admin overrides', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            skillSync: { github: { enabled: true } },
            interface: { modelSelect: false },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      const savedOverrides = writtenDraft(deps).overrides;
      expect(savedOverrides.skillSync).toEqual({ github: { enabled: true } });
      expect(savedOverrides.interface).toEqual({ modelSelect: false });
    });

    it('does not allow tenant-wide Langfuse settings through the generic config API', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: {
          overrides: {
            langfuse: {
              enabled: false,
              publicKey: 'pk-role',
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        message: 'No actionable override sections provided',
        revision: null,
        config: null,
        applied: [],
        skipped: [{ path: 'langfuse', segments: ['langfuse'], reason: 'dedicated_section' }],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects a dotted section name instead of reading it as a path', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: {
          overrides: {
            langfuse: { enabled: false },
            'langfuse.secretKey': 'sk-role',
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid config override',
        code: 'CONFIG_OVERRIDE_INVALID',
        issues: [
          { path: 'langfuse.secretKey', segments: ['langfuse.secretKey'], code: 'dotted_key' },
        ],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it.each([
      ['no config capability', false],
      ['only assign:configs for the principal type', true],
    ])('answers 403 before judging a dotted section name with %s', async (_label, canAssign) => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(canAssign),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'editor' },
        body: { overrides: { 'webSearch.serperApiKey': 'sk-serper' } },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('preserves stored Langfuse settings during a full base-config replacement', async () => {
      const storedLangfuse = {
        enabled: true,
        destination: 'eu',
        publicKey: 'pk-stored',
        secretKey: 'v3:test:sk-stored',
        secretKeyPreview: 'sk-sto...ored',
        projectId: 'project-stored',
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          configVersion: 1,
          overrides: { langfuse: storedLangfuse },
        }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: {
          overrides: {
            interface: { modelSelect: false },
            langfuse: {
              enabled: false,
              publicKey: 'pk-caller',
              projectId: 'project-caller',
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      const savedOverrides = writtenDraft(deps).overrides;
      expect(savedOverrides).toEqual({
        interface: { modelSelect: false },
        langfuse: storedLangfuse,
      });
    });

    it('encrypts custom endpoint API keys on full override writes and redacts responses', async () => {
      const { handlers, deps } = createHandlers({ overrideEnvAllowlist: 'OPENROUTER_KEY' });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            endpoints: {
              custom: [
                {
                  name: 'OpenRouter',
                  apiKey: 'sk-or-secret-key',
                  baseURL: 'https://openrouter.ai/api/v1',
                },
                { name: 'EnvRef', apiKey: '${OPENROUTER_KEY}' },
              ],
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      const savedOverrides = writtenDraft(deps).overrides;
      const [saved, envRef] = (
        savedOverrides.endpoints as { custom: Array<Record<string, string>> }
      ).custom;
      expect(saved.apiKey).toBe('v3:test:sk-or-secret-key');
      expect(saved.apiKeyPreview).toBe('...-key');
      expect(envRef.apiKey).toBe('${OPENROUTER_KEY}');
      expect(envRef.apiKeyPreview).toBeUndefined();
      const responseConfig = res.body!.config as {
        overrides: { endpoints: { custom: Array<Record<string, string>> } };
      };
      expect(responseConfig.overrides.endpoints.custom[0].apiKey).toBeUndefined();
      expect(responseConfig.overrides.endpoints.custom[0].apiKeyPreview).toBe('...-key');
      expect(responseConfig.overrides.endpoints.custom[1].apiKey).toBe('${OPENROUTER_KEY}');
    });

    it('rejects encrypted custom endpoint API key submissions on full override writes', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            endpoints: {
              custom: [{ name: 'A', apiKey: 'v3:attacker-controlled' }],
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });
    it('preserves UI sub-keys in composite permission fields like mcpServers', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            interface: {
              mcpServers: {
                use: true,
                create: false,
                placeholder: 'Search MCP...',
                trustCheckbox: { label: 'Trust' },
              },
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      const savedOverrides = writtenDraft(deps).overrides;
      const mcp = (savedOverrides as Record<string, unknown>).interface as Record<string, unknown>;
      expect((mcp.mcpServers as Record<string, unknown>).placeholder).toBe('Search MCP...');
      expect((mcp.mcpServers as Record<string, unknown>).trustCheckbox).toEqual({ label: 'Trust' });
      expect((mcp.mcpServers as Record<string, unknown>).use).toBeUndefined();
      expect((mcp.mcpServers as Record<string, unknown>).create).toBeUndefined();
    });

    it('strips peoplePicker permission sub-keys in upsert', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            interface: { peoplePicker: { users: false, groups: true, roles: true } },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('returns 200 with message when only permission fields in interface', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: { interface: { prompts: false, agents: false } } },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe('deleteConfigField', () => {
    it('reads fieldPath from query parameter', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.modelSelect' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        'admin',
        [{ segments: ['interface', 'modelSelect'] }],
        undefined,
        {
          expectedRevision: undefined,
        },
      );
    });

    it('allows deleting mcpServers UI sub-key paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.mcpServers.placeholder' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        'admin',
        [{ segments: ['interface', 'mcpServers', 'placeholder'] }],
        undefined,
        {
          expectedRevision: undefined,
        },
      );
    });

    it('blocks deleting mcpServers permission sub-key paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.mcpServers.use' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('blocks deleting peoplePicker permission sub-key paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.peoplePicker.users' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('returns 200 no-op for interface permission field path', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.prompts' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('allows deleting skillSync field paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'skillSync.github.enabled' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        'admin',
        [{ segments: ['skillSync', 'github', 'enabled'] }],
        undefined,
        {
          expectedRevision: undefined,
        },
      );
    });

    it('allows deleting interface UI field paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.modelSelect' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        'admin',
        [{ segments: ['interface', 'modelSelect'] }],
        undefined,
        {
          expectedRevision: undefined,
        },
      );
    });

    it('ignores tenant-wide Langfuse deletes through the generic config API', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        query: { fieldPath: 'langfuse.enabled' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        message: 'No actionable field path provided',
        revision: null,
        config: null,
        applied: [],
        skipped: [
          {
            path: 'langfuse.enabled',
            segments: ['langfuse', 'enabled'],
            reason: 'dedicated_section',
          },
        ],
      });
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('rejects deletes of the displayed secret key', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'langfuse.secretKeyPreview' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('returns 400 when fieldPath query param is missing', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: {},
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body!.error).toContain('query parameter');
    });

    it('rejects unsafe field paths', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: '__proto__.polluted' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('tombstoneConfigField', () => {
    const storedAdmin = {
      _id: '64b000000000000000000001',
      principalType: 'role',
      principalId: 'admin',
      principalModel: 'Role',
      priority: 7,
      configVersion: 3,
      isActive: false,
      overrides: { mcpServers: { github: { url: 'https://example.com/mcp' } } },
      tombstones: ['memory'],
    };

    it('writes an explicit tombstone for a valid field path', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'mcpServers.github' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
      expect(deps.writeConfigDocument.mock.calls[0].slice(0, 2)).toEqual(['role', 'admin']);
      expect(deps.writeConfigDocument.mock.calls[0][3]).toBe('absent');
      expect(writtenDraft(deps)).toEqual({
        principalModel: 'Role',
        priority: 10,
        overrides: {},
        tombstones: ['mcpServers.github'],
        isActive: true,
      });
    });

    it('writes over the stored document, keeping its priority unless one is requested', async () => {
      const kept = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(storedAdmin),
      });
      await kept.handlers.tombstoneConfigField(
        mockReq({
          params: { principalType: 'role', principalId: 'admin' },
          body: { fieldPath: 'mcpServers.github' },
        }),
        mockRes(),
      );
      expect(kept.deps.writeConfigDocument.mock.calls[0][3]).toBe('64b000000000000000000001:3');
      expect(writtenDraft(kept.deps)).toEqual({
        principalModel: 'Role',
        priority: 7,
        overrides: {},
        tombstones: ['memory', 'mcpServers.github'],
        isActive: false,
      });

      const requested = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(storedAdmin),
      });
      await requested.handlers.tombstoneConfigField(
        mockReq({
          params: { principalType: 'role', principalId: 'admin' },
          body: { fieldPath: 'mcpServers.github', priority: 42 },
        }),
        mockRes(),
      );
      expect(writtenDraft(requested.deps).priority).toBe(42);
    });

    it('suppresses a secret and its preview companion in one write', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(storedAdmin),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'ocr.apiKey', expectedRevision: '64b000000000000000000001:3' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
      expect(deps.writeConfigDocument.mock.calls[0][3]).toBe('64b000000000000000000001:3');
      expect(writtenDraft(deps).tombstones).toEqual(['memory', 'ocr.apiKey', 'ocr.apiKeyPreview']);
    });

    it('ignores tenant-wide Langfuse tombstones through the generic config API', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { fieldPath: 'langfuse.enabled' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        message: 'No actionable field path provided',
        revision: null,
        config: null,
        applied: [],
        skipped: [
          {
            path: 'langfuse.enabled',
            segments: ['langfuse', 'enabled'],
            reason: 'dedicated_section',
          },
        ],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects tombstones of the displayed secret key', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'langfuse.secretKeyPreview' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('blocks interface permission paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'interface.mcpServers.use' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('ignores tombstones for base-only filter policy', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'filters.messages.pii' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects unsafe field paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: '__proto__.polluted' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe('patchConfigField', () => {
    it('returns 403 when user lacks capability for section', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'registration.enabled', value: false }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(403);
    });

    it('strips interface permission field entries but keeps UI field entries', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [
            { fieldPath: 'interface.modelSelect', value: false },
            { fieldPath: 'interface.prompts', value: false },
          ],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'interface.modelSelect')).toBe(false);
      expect(writtenField(deps, 'interface.prompts')).toBeUndefined();
    });

    /** `use` is both a permission bit and the runtime disable for dual-purpose fields.
     *  Stripping it alone leaves an object, which `getLimits` reads as ENABLED — so an
     *  override meant to stop scheduled billing would start it. */
    it('collapses an explicit schedules disable to the boolean form in patches', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'interface.schedules', value: { use: false, maxPerUser: 2 } }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'interface.schedules')).toBe(false);
    });

    it('keeps a schedules object that only narrows limits', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'interface.schedules', value: { maxPerUser: 2 } }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'interface.schedules')).toEqual({ maxPerUser: 2 });
    });

    it('preserves skillSync field entries in patches', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [
            { fieldPath: 'skillSync.github.enabled', value: true },
            { fieldPath: 'interface.modelSelect', value: false },
          ],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'skillSync.github.enabled')).toBe(true);
      expect(writtenField(deps, 'interface.modelSelect')).toBe(false);
    });

    it('rejects process-backed MCP server field patches', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'user', principalId: 'u1' },
        body: {
          entries: [{ fieldPath: 'mcpServers.injected.command', value: '/bin/sh' }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Process-backed MCP servers can only be configured in librechat.yaml',
        code: 'PROCESS_MCP_CONFIG',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects Langfuse header field patches, including a single header path', async () => {
      const { handlers, deps } = createHandlers();

      for (const fieldPath of ['langfuse.headers', 'langfuse.headers.X-Proxy-Token']) {
        const res = mockRes();
        await handlers.patchConfigField(
          mockReq({
            params: { principalType: 'user', principalId: 'u1' },
            body: { entries: [{ fieldPath, value: 'leaked' }] },
          }),
          res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
          error: 'Langfuse request headers can only be configured in librechat.yaml',
          code: 'LANGFUSE_HEADERS_CONFIG',
        });
      }
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects process-backed MCP field patches through the runtime config alias', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'user', principalId: 'u1' },
        body: {
          entries: [{ fieldPath: 'mcpConfig.injected.command', value: '/bin/sh' }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Unknown config section', code: 'UNKNOWN_SECTION' });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects array-valued Langfuse secret ancestors', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [
            {
              fieldPath: 'langfuse',
              value: [{ secretKey: 'sk-lf-secret' }],
            },
          ],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('does not allow tenant-wide Langfuse patches through the generic config API', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: {
          entries: [{ fieldPath: 'langfuse.enabled', value: false }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        message: 'No actionable field entries provided',
        revision: null,
        config: null,
        applied: [],
        skipped: [
          {
            path: 'langfuse.enabled',
            segments: ['langfuse', 'enabled'],
            reason: 'dedicated_section',
          },
        ],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects direct display secret key patch entries', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'langfuse.secretKeyPreview', value: 'spoofed' }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects encrypted Langfuse secret values on patch entries', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'langfuse.secretKey', value: 'v3:attacker-controlled' }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects patch entries below protected Langfuse secret paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'langfuse.secretKey.hidden', value: 'sk-lf-secret' }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects patch entries below protected Langfuse secretKeyPreview paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'langfuse.secretKeyPreview.hidden', value: 'spoofed' }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('blocks peoplePicker permission sub-key paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'interface.peoplePicker.users', value: false }],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('allows mcpServers UI sub-key paths but blocks permission sub-key paths', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [
            { fieldPath: 'interface.mcpServers.placeholder', value: 'Search...' },
            { fieldPath: 'interface.mcpServers.use', value: true },
          ],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'interface.mcpServers.placeholder')).toBe('Search...');
      expect(writtenField(deps, 'interface.mcpServers.use')).toBeUndefined();
    });

    it('returns 200 with message when all entries are permission fields', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'interface.prompts', value: false }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.message).toBeDefined();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated even if all entries are permission fields', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'interface.prompts', value: false }] },
        user: undefined,
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when unauthorized even if all entries are permission fields', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'interface.prompts', value: false }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(403);
    });

    it('rejects entries with unsafe field paths (prototype pollution)', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: '__proto__.polluted', value: true }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * A stored credential and its URL, and a patch that enters a decoy key at the credential's path
   * and then writes an ancestor without it: secret preservation fills the ancestor in from the
   * stored document, so the stored key, not the decoy, is what the document keeps.
   */
  describe('patchConfigField: a decoy key before an ancestor that keeps the stored one', () => {
    const GOOD = 'https://good.example.com/mcp';
    const EVIL = 'https://evil.example.com/mcp';
    /** `encryptV3` is mocked as `v3:test:<plaintext>` in this file. */
    const STORED_MCP_KEY = 'v3:test:sk-original-mcp-1111';
    const STORED_FIRECRAWL_KEY = 'v3:test:fc-original-key-2222';
    const DECOY = 'sk-decoy-key-0000';

    const stored: ConfigRecord = {
      _id: 'c1',
      principalType: 'role' as ConfigRecord['principalType'],
      principalId: 'admin',
      principalModel: 'Role' as ConfigRecord['principalModel'],
      priority: 10,
      isActive: true,
      configVersion: 1,
      tombstones: [],
      overrides: {
        mcpServers: {
          probe: {
            type: 'streamable-http',
            url: GOOD,
            apiKey: {
              source: 'admin',
              authorization_type: 'bearer',
              key: STORED_MCP_KEY,
              keyPreview: '...1111',
            },
          },
        },
        webSearch: {
          firecrawlApiUrl: 'https://fc-good.example.com',
          firecrawlApiKey: STORED_FIRECRAWL_KEY,
          firecrawlApiKeyPreview: '...2222',
        },
      } as ConfigRecord['overrides'],
    };
    const keyless = (url: string) => ({
      type: 'streamable-http',
      url,
      apiKey: { source: 'admin', authorization_type: 'bearer' },
    });

    async function patchStored(entries: Array<{ fieldPath: string; value: unknown }>) {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn(async (_type: string, principalId: string) =>
          principalId === 'admin' ? structuredClone(stored) : null,
        ),
      });
      const res = mockRes();
      await handlers.patchConfigField(
        mockReq({ params: { principalType: 'role', principalId: 'admin' }, body: { entries } }),
        res,
      );
      return { res, deps };
    }

    it('refuses moving a stored MCP key that a decoy entry did not replace', async () => {
      const { res, deps } = await patchStored([
        { fieldPath: 'mcpServers.probe.apiKey.key', value: DECOY },
        { fieldPath: 'mcpServers.probe', value: keyless(EVIL) },
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'MCP_API_KEY_REENTRY_REQUIRED',
        server: 'probe',
        fields: ['url'],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('refuses moving a stored web search key that a decoy entry did not replace', async () => {
      const { res, deps } = await patchStored([
        { fieldPath: 'webSearch.firecrawlApiKey', value: DECOY },
        { fieldPath: 'webSearch', value: { firecrawlApiUrl: 'https://fc-evil.example.com' } },
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        code: 'CONFIG_SECRET_REENTRY_REQUIRED',
        issues: [
          expect.objectContaining({
            path: 'webSearch.firecrawlApiUrl',
            secretPath: 'webSearch.firecrawlApiKey',
          }),
        ],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it("keeps the stored key's own preview when the decoy is overwritten in place", async () => {
      const { res, deps } = await patchStored([
        { fieldPath: 'mcpServers.probe.apiKey.key', value: DECOY },
        { fieldPath: 'mcpServers.probe', value: keyless(GOOD) },
        { fieldPath: 'webSearch.firecrawlApiKey', value: DECOY },
        { fieldPath: 'webSearch', value: { firecrawlApiUrl: 'https://fc-good.example.com' } },
      ]);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'mcpServers.probe.apiKey')).toEqual({
        source: 'admin',
        authorization_type: 'bearer',
        key: STORED_MCP_KEY,
        keyPreview: '...1111',
      });
      expect(writtenField(deps, 'webSearch.firecrawlApiKey')).toBe(STORED_FIRECRAWL_KEY);
      expect(writtenField(deps, 'webSearch.firecrawlApiKeyPreview')).toBe('...2222');
    });

    it('stores the decoy, with its preview, when it is written after the ancestor', async () => {
      const { res, deps } = await patchStored([
        { fieldPath: 'mcpServers.probe', value: keyless(EVIL) },
        { fieldPath: 'mcpServers.probe.apiKey.key', value: DECOY },
      ]);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'mcpServers.probe.apiKey.key')).toBe(`v3:test:${DECOY}`);
      expect(writtenField(deps, 'mcpServers.probe.apiKey.keyPreview')).toBe('...0000');
      expect(writtenField(deps, 'mcpServers.probe.url')).toBe(EVIL);
    });
  });

  describe('patchConfigField: section-scoped priority preservation', () => {
    it('ignores request-supplied priority when caller lacks broad manage:configs', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn(async (_user, section) => section === 'memory'),
        findConfigByPrincipal: jest
          .fn()
          .mockResolvedValue({ _id: 'c1', priority: 7, overrides: {} }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'memory.context', value: 'updated' }],
          priority: 999,
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      const priorityArg = writtenDraft(deps).priority;
      expect(priorityArg).toBe(7);
    });

    it('falls back to default priority when no existing doc and caller lacks broad manage', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn(async (_user, section) => section === 'memory'),
        findConfigByPrincipal: jest.fn().mockResolvedValue(null),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'memory.context', value: 'updated' }],
          priority: 999,
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      const priorityArg = writtenDraft(deps).priority;
      expect(priorityArg).toBe(10);
    });

    it('honors request-supplied priority when caller holds broad manage:configs', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'memory.context', value: 'updated' }],
          priority: 999,
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      const priorityArg = writtenDraft(deps).priority;
      expect(priorityArg).toBe(999);
      /**
       * The target is read once, to validate the write on top of its stored fields (not for its
       * priority); Base is read beside it (the store keeps role documents to the caller's
       * partition) as the floor the write lands on, and once more after the write, to see that
       * the floor did not move.
       */
      expect(deps.findConfigByPrincipal).toHaveBeenCalledTimes(3);
      expect(deps.findConfigByPrincipal).toHaveBeenCalledWith('role', 'admin', {
        includeInactive: true,
      });
      expect(deps.findConfigByPrincipal).toHaveBeenCalledWith('role', '__base__');
    });

    it('preserves priority 0 when broad caller supplies it', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'memory.context', value: 'updated' }],
          priority: 0,
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      const priorityArg = writtenDraft(deps).priority;
      expect(priorityArg).toBe(0);
    });

    it('preserves existing priority 0 for section-scoped callers', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn(async (_user, section) => section === 'memory'),
        findConfigByPrincipal: jest
          .fn()
          .mockResolvedValue({ _id: 'c1', priority: 0, overrides: {} }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [{ fieldPath: 'memory.context', value: 'updated' }],
          priority: 999,
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      const priorityArg = writtenDraft(deps).priority;
      expect(priorityArg).toBe(0);
    });
  });

  describe('tombstoneConfigField: section-scoped priority preservation', () => {
    const storedAt = (priority: number) =>
      jest.fn().mockResolvedValue({
        _id: 'c1',
        principalType: 'role',
        principalId: 'admin',
        priority,
        configVersion: 1,
        isActive: true,
        overrides: {},
        tombstones: [],
      });

    it('ignores request-supplied priority when caller lacks broad manage:configs', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn(async (_user, section) => section === 'memory'),
        findConfigByPrincipal: storedAt(15),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'memory.context', priority: 999 },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenDraft(deps).priority).toBe(15);
    });

    it('honors request-supplied priority when caller holds broad manage:configs', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(true),
        findConfigByPrincipal: storedAt(15),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'memory.context', priority: 999 },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenDraft(deps).priority).toBe(999);
    });
  });

  describe('upsertConfigOverrides — Bug 2 regression', () => {
    it('returns 403 for empty overrides when user lacks MANAGE_CONFIGS', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {} },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('upsertConfigOverrides — empty-overrides scope creation', () => {
    it('creates config document when overrides is empty but priority is provided', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.body?.config).toHaveProperty('_id', 'c1');
      expect(res.body?.config).toHaveProperty('revision', 'c1:1');
      expect(deps.writeConfigDocument).toHaveBeenCalledWith(
        'role',
        'admin',
        { principalModel: 'Role', priority: 5, overrides: {}, tombstones: [], isActive: true },
        'absent',
      );
    });

    it('returns no-op message when overrides is empty and no priority is provided', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {} },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('message', 'No actionable override sections provided');
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('calls general manage check exactly once when overrides is empty with priority', async () => {
      const hasConfigCapability = jest.fn().mockResolvedValue(true);
      const { handlers } = createHandlers({ hasConfigCapability });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 3 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(hasConfigCapability).toHaveBeenCalledTimes(1);
      expect(hasConfigCapability).toHaveBeenCalledWith(expect.anything(), null, 'manage');
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('config');
    });

    it('returns 403 for empty overrides with priority when user lacks MANAGE_CONFIGS', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 for empty overrides with priority when unauthenticated', async () => {
      const { handlers } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
        user: undefined,
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(401);
    });
  });

  // ── Invariant tests: rules that must hold across ALL handlers ──────

  const MUTATION_HANDLERS: Array<{
    name: string;
    reqOverrides: Record<string, unknown>;
  }> = [
    {
      name: 'upsertConfigOverrides',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: { interface: { modelSelect: false } } },
      },
    },
    {
      name: 'patchConfigField',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'interface.modelSelect', value: false }] },
      },
    },
    {
      name: 'deleteConfigField',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
        query: { fieldPath: 'interface.modelSelect' },
      },
    },
    {
      name: 'tombstoneConfigField',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
        body: { fieldPath: 'mcpServers.github' },
      },
    },
    {
      name: 'deleteConfigOverrides',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
      },
    },
    {
      name: 'toggleConfig',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
        body: { isActive: false },
      },
    },
    {
      name: 'applyConfigChanges',
      reqOverrides: {
        params: { principalType: 'role', principalId: 'admin' },
        body: { ops: [{ op: 'set', fieldPath: 'interface.modelSelect', value: false }] },
      },
    },
    { name: 'reloadConfig', reqOverrides: {} },
  ];

  describe('upsertConfigOverrides: scope-lifecycle auth (ASSIGN_CONFIGS)', () => {
    it('allows empty-overrides scope creation when caller has ASSIGN_CONFIGS only', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(deps.writeConfigDocument).toHaveBeenCalledWith(
        'role',
        'admin',
        { principalModel: 'Role', priority: 10, overrides: {}, tombstones: [], isActive: true },
        'absent',
      );
    });

    it('keeps the stored priority and reactivates an empty profile for an ASSIGN_CONFIGS-only caller', async () => {
      const findConfigByPrincipal = jest.fn().mockResolvedValue({
        _id: 'c1',
        priority: 7,
        configVersion: 2,
        isActive: false,
        overrides: { balance: {} },
        tombstones: [],
      });
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        findConfigByPrincipal,
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 999 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalledWith(
        'role',
        'admin',
        { principalModel: 'Role', priority: 7, overrides: {}, tombstones: [], isActive: true },
        'c1:2',
      );
    });

    it('rejects non-empty overrides for ASSIGN_CONFIGS-only caller', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: { memory: { enabled: true } } },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects empty-overrides scope creation when caller has neither grant', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe('deleteConfigOverrides: accepts ASSIGN_CONFIGS', () => {
    it('allows delete when caller has ASSIGN_CONFIGS only', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.deleteConfig).toHaveBeenCalled();
    });

    it('rejects delete when caller has neither broad manage nor ASSIGN_CONFIGS', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.deleteConfig).not.toHaveBeenCalled();
    });
  });

  describe('toggleConfig: accepts ASSIGN_CONFIGS', () => {
    it('allows toggle when caller has ASSIGN_CONFIGS only', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { isActive: false },
      });
      const res = mockRes();

      await handlers.toggleConfig(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.toggleConfigActiveTracked).toHaveBeenCalled();
    });

    it('rejects toggle when caller has neither broad manage nor ASSIGN_CONFIGS', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { isActive: false },
      });
      const res = mockRes();

      await handlers.toggleConfig(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.toggleConfigActiveTracked).not.toHaveBeenCalled();
    });
  });

  describe('scope-lifecycle: parameterized assign:configs check', () => {
    it('allows upsert when caller holds assign:configs:<principalType>', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn(async (_user, cap) => cap === 'assign:configs:role'),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(writtenDraft(deps)).toEqual(
        expect.objectContaining({ overrides: {}, priority: 10, isActive: true }),
      );
    });

    it('rejects upsert when parameterized grant targets a different principalType', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn(async (_user, cap) => cap === 'assign:configs:user'),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('queries hasCapability with the principalType-parameterized form', async () => {
      const hasCap = jest.fn().mockResolvedValue(true);
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: hasCap,
      });
      const req = mockReq({
        params: { principalType: 'group', principalId: 'engineers' },
        body: { isActive: false },
      });
      const res = mockRes();

      await handlers.toggleConfig(req, res);

      const queriedCapabilities = hasCap.mock.calls.map((call) => call[1]);
      expect(queriedCapabilities).toContain('assign:configs:group');
    });
  });

  describe('invariant: __base__ requires broad manage:configs', () => {
    it('upsert against __base__ returns 403 for assign-only caller', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('delete against __base__ returns 403 for assign-only caller', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
      });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.deleteConfig).not.toHaveBeenCalled();
    });

    it('toggle against __base__ returns 403 for assign-only caller', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { isActive: false },
      });
      const res = mockRes();

      await handlers.toggleConfig(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.toggleConfigActiveTracked).not.toHaveBeenCalled();
    });

    it('upsert against __base__ succeeds for broad-manage caller', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(deps.writeConfigDocument).toHaveBeenCalled();
    });

    it('patch against __base__ returns 403 for a section-scoped manager', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { entries: [{ fieldPath: 'memory.context', value: 'updated' }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('tombstone against __base__ returns 403 for a section-scoped manager', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { fieldPath: 'memory.context' },
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('field delete against __base__ returns 403 for a section-scoped manager', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        query: { fieldPath: 'memory.context' },
      });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('patch against __base__ succeeds for a broad-manage caller', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(true),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: '__base__' },
        body: { entries: [{ fieldPath: 'memory.context', value: 'updated' }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalled();
    });
  });

  describe('scope-lifecycle: atomic empty-state guard for assign-only callers', () => {
    it('empty-overrides upsert is rejected when the stored profile is not empty', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          configVersion: 3,
          overrides: { memory: { disabled: true } },
          tombstones: [],
        }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('empty-overrides upsert is rejected when the stored profile only holds tombstones', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          configVersion: 3,
          overrides: {},
          tombstones: ['mcpServers.github'],
        }),
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params: { principalType: 'role', principalId: 'admin' },
          body: { overrides: {}, priority: 5 },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('delete is rejected with 403 when atomic filter mismatches and doc still exists', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        deleteConfig: jest.fn(async (_pt, _pi, _session, opts) => {
          return opts?.expectEmpty ? null : { _id: 'c1' };
        }),
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          overrides: { endpoints: { custom: true } },
        }),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.deleteConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        { expectEmpty: true },
      );
    });

    it('toggle is rejected with 403 when atomic filter mismatches and doc still exists', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        toggleConfigActiveTracked: jest.fn(async (_pt, _pi, _isActive, opts) => {
          return opts?.expectEmpty
            ? null
            : { config: { _id: 'c1', isActive: false }, changed: true };
        }),
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          tombstones: ['endpoints.openai.apiKey'],
        }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { isActive: false },
      });
      const res = mockRes();

      await handlers.toggleConfig(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.toggleConfigActiveTracked).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { expectEmpty: true },
      );
    });

    it('delete returns 404 when atomic filter mismatches and doc does not exist', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        deleteConfig: jest.fn().mockResolvedValue(null),
        findConfigByPrincipal: jest.fn().mockResolvedValue(null),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(404);
      expect(deps.findConfigByPrincipal).toHaveBeenCalled();
    });

    it('delete succeeds for assign-only caller when atomic filter matches', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(true),
        deleteConfig: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {} }),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.deleteConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        { expectEmpty: true },
      );
    });

    it('broad-manage caller calls destructive op without expectEmpty option', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(true),
        deleteConfig: jest.fn().mockResolvedValue({
          _id: 'c1',
          overrides: { endpoints: { custom: true } },
        }),
      });
      const req = mockReq({ params: { principalType: 'role', principalId: 'admin' } });
      const res = mockRes();

      await handlers.deleteConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.deleteConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        undefined,
        { expectEmpty: false },
      );
    });
  });

  describe('AdminConfigDeps.hasCapability is optional', () => {
    it('factory accepts deps without hasCapability and falls back to broad-manage-only auth', async () => {
      const deps = {
        listAllConfigs: jest.fn().mockResolvedValue([]),
        findConfigByPrincipal: jest.fn().mockResolvedValue(null),
        writeConfigDocument: jest.fn(),
        unsetConfigField: jest.fn(),
        deleteConfig: jest.fn().mockResolvedValue({ _id: 'c1' }),
        /** The document as it was before the write. */
        toggleConfigActiveTracked: jest
          .fn()
          .mockResolvedValue({ config: { _id: 'c1', isActive: false }, changed: true }),
        hasConfigCapability: jest.fn().mockResolvedValue(false),
      };
      const handlers = createAdminConfigHandlers(deps);
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { overrides: {}, priority: 5 },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(403);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });
  });

  describe('invariant: all mutation handlers return 401 without auth', () => {
    for (const { name, reqOverrides } of MUTATION_HANDLERS) {
      it(`${name} returns 401 when user is missing`, async () => {
        const { handlers } = createHandlers();
        const req = mockReq({ ...reqOverrides, user: undefined });
        const res = mockRes();

        await (handlers as Record<string, (...args: unknown[]) => Promise<unknown>>)[name](
          req,
          res,
        );

        expect(res.statusCode).toBe(401);
      });
    }
  });

  describe('invariant: all mutation handlers return 403 without capability', () => {
    for (const { name, reqOverrides } of MUTATION_HANDLERS) {
      it(`${name} returns 403 when user lacks capability`, async () => {
        const { handlers } = createHandlers({
          hasConfigCapability: jest.fn().mockResolvedValue(false),
          hasCapability: jest.fn().mockResolvedValue(false),
        });
        const req = mockReq(reqOverrides);
        const res = mockRes();

        await (handlers as Record<string, (...args: unknown[]) => Promise<unknown>>)[name](
          req,
          res,
        );

        expect(res.statusCode).toBe(403);
      });
    }
  });

  describe('invariant: all read handlers return 403 without capability', () => {
    const READ_HANDLERS: Array<{ name: string; reqOverrides: Record<string, unknown> }> = [
      { name: 'listConfigs', reqOverrides: {} },
      { name: 'getBaseConfig', reqOverrides: {} },
      {
        name: 'getConfig',
        reqOverrides: { params: { principalType: 'role', principalId: 'admin' } },
      },
    ];

    for (const { name, reqOverrides } of READ_HANDLERS) {
      it(`${name} returns 403 when user lacks capability`, async () => {
        const { handlers } = createHandlers({
          hasConfigCapability: jest.fn().mockResolvedValue(false),
          hasAnyConfigReadAccess: jest.fn().mockResolvedValue(false),
        });
        const req = mockReq(reqOverrides);
        const res = mockRes();

        await (handlers as Record<string, (...args: unknown[]) => Promise<unknown>>)[name](
          req,
          res,
        );

        expect(res.statusCode).toBe(403);
      });
    }
  });

  describe('invariant: all read handlers return 401 without auth', () => {
    const READ_HANDLERS: Array<{ name: string; reqOverrides: Record<string, unknown> }> = [
      { name: 'listConfigs', reqOverrides: {} },
      { name: 'getBaseConfig', reqOverrides: {} },
      {
        name: 'getConfig',
        reqOverrides: { params: { principalType: 'role', principalId: 'admin' } },
      },
    ];

    for (const { name, reqOverrides } of READ_HANDLERS) {
      it(`${name} returns 401 when user is missing`, async () => {
        const { handlers } = createHandlers();
        const req = mockReq({ ...reqOverrides, user: undefined });
        const res = mockRes();

        await (handlers as Record<string, (...args: unknown[]) => Promise<unknown>>)[name](
          req,
          res,
        );

        expect(res.statusCode).toBe(401);
      });
    }
  });

  describe('getBaseConfig', () => {
    it('returns 403 when user lacks READ_CONFIGS', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasAnyConfigReadAccess: jest.fn().mockResolvedValue(false),
      });
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(403);
    });

    it('returns the full AppConfig', async () => {
      const { handlers } = createHandlers();
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body!.config).toEqual({ interface: { modelSelect: true } });
    });

    it('redacts Langfuse secrets from top-level and raw nested base config', async () => {
      const { handlers } = createHandlers({
        getAppConfig: jest.fn().mockResolvedValue({
          langfuse: {
            publicKey: 'pk-lf-1',
            secretKey: 'sk-lf-secret',
            secretKeyPreview: 'sk-lf-...cret',
          },
          config: {
            langfuse: {
              publicKey: 'pk-lf-1',
              secretKey: 'sk-lf-raw-secret',
              secretKeyPreview: 'sk-lf-...cret',
            },
          },
        }),
      });
      const req = mockReq();
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      const responseConfig = res.body!.config as {
        langfuse: Record<string, string>;
        config: { langfuse: Record<string, string> };
      };
      expect(responseConfig.langfuse).toEqual({
        publicKey: 'pk-lf-1',
        secretKeyPreview: '*************',
      });
      expect(responseConfig.config.langfuse).toEqual({
        publicKey: 'pk-lf-1',
        secretKeyPreview: '*************',
      });
    });

    it('forwards baseOnly=true to getAppConfig when query param is the literal string "true"', async () => {
      const getAppConfig = jest.fn().mockResolvedValue({ interface: { modelSelect: true } });
      const { handlers } = createHandlers({ getAppConfig });
      const req = mockReq({ query: { baseOnly: 'true' } });
      const res = mockRes();

      await handlers.getBaseConfig(req, res);

      expect(res.statusCode).toBe(200);
      expect(getAppConfig).toHaveBeenCalledTimes(1);
      expect(getAppConfig).toHaveBeenCalledWith(expect.objectContaining({ baseOnly: true }));
    });

    it('previews a plaintext secret an override stored by its value, and a librechat.yaml one only with the fixed mask', async () => {
      const yaml = {
        webSearch: {
          serperApiKey: 'serper-yaml-literal-0001',
          keenableApiKey: '${KEENABLE_API_KEY}',
        },
      };
      const merged = {
        webSearch: {
          serperApiKey: 'serper-yaml-literal-0001',
          keenableApiKey: 'kn-legacy-plain-0002',
        },
      };
      const getAppConfig = jest.fn(async ({ baseOnly }: { baseOnly?: boolean }) =>
        baseOnly ? yaml : merged,
      );
      const { handlers } = createHandlers({ getAppConfig });

      const res = mockRes();
      await handlers.getBaseConfig(mockReq(), res);
      const baseOnlyRes = mockRes();
      await handlers.getBaseConfig(mockReq({ query: { baseOnly: 'true' } }), baseOnlyRes);

      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('kn-legacy-plain-0002');
      expect(JSON.stringify(res.body)).not.toContain('0001');
      expect((res.body!.config as typeof merged).webSearch).toEqual({
        keenableApiKeyPreview: '...0002',
        serperApiKeyPreview: '********',
      });
      expect((baseOnlyRes.body!.config as typeof yaml).webSearch).toEqual({
        keenableApiKey: '${KEENABLE_API_KEY}',
        serperApiKeyPreview: '********',
      });
    });

    it('forwards baseOnly=false when the query param is missing, non-"true", or an array', async () => {
      const cases: Array<Record<string, unknown>> = [
        {},
        { baseOnly: 'false' },
        { baseOnly: '1' },
        { baseOnly: ['true'] },
        { baseOnly: ['true', 'true'] },
        { baseOnly: { nested: 'true' } },
      ];

      for (const query of cases) {
        const getAppConfig = jest.fn().mockResolvedValue({ interface: { modelSelect: true } });
        const { handlers } = createHandlers({ getAppConfig });
        const req = mockReq({ query });
        const res = mockRes();

        await handlers.getBaseConfig(req, res);

        expect(res.statusCode).toBe(200);
        expect(getAppConfig).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ baseOnly: false }),
        );
      }
    });
  });

  describe('override validation against configSchema', () => {
    it('rejects a whole-document write with an invalid field and stores nothing', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: { githubCompare: { timeoutMs: 0 }, interface: { modelSelect: false } },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid config override',
        code: 'CONFIG_OVERRIDE_INVALID',
        issues: [
          {
            path: 'githubCompare.timeoutMs',
            segments: ['githubCompare', 'timeoutMs'],
            code: 'too_small',
            params: { minimum: 1, inclusive: true, exact: false, type: 'number' },
          },
        ],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('validates a whole-document write on the base its retained tombstones leave', async () => {
      /** A reset refill needs a whole interval; only a stored tombstone of the mode lifts that. */
      const base = { config: { balance: { refillMode: 'reset' } } };
      const body = { overrides: { balance: { refillIntervalValue: 1.5 } } };
      const params = { principalType: 'role', principalId: 'admin' };

      const kept = createHandlers({ getAppConfig: jest.fn().mockResolvedValue(base) });
      const keptRes = mockRes();
      await kept.handlers.upsertConfigOverrides(mockReq({ params, body }), keptRes);
      expect(keptRes.statusCode).toBe(400);
      expect(keptRes.body?.issues).toEqual([
        expect.objectContaining({ path: 'balance.refillIntervalValue', code: 'custom' }),
      ]);
      expect(kept.deps.writeConfigDocument).not.toHaveBeenCalled();

      const tombstoned = createHandlers({
        getAppConfig: jest.fn().mockResolvedValue(base),
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          configVersion: 1,
          overrides: {},
          tombstones: ['balance.refillMode'],
        }),
      });
      const tombstonedRes = mockRes();
      await tombstoned.handlers.upsertConfigOverrides(mockReq({ params, body }), tombstonedRes);
      expect(tombstonedRes.statusCode).toBe(200);
      expect(tombstoned.deps.writeConfigDocument).toHaveBeenCalledTimes(1);
    });

    it('accepts a partial section whose provided fields are valid', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            registration: { allowedDomains: ['example.com'] },
            mcpServers: { github: { timeout: 5000 } },
            endpoints: { custom: [{ name: 'groq', apiKey: 'sk-test' }] },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
    });

    it('rejects one write that names a custom endpoint twice in spellings the runtime folds', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            endpoints: {
              custom: [
                { name: 'Ollama', baseURL: 'http://first:11434/v1' },
                { name: 'ollama', baseURL: 'http://second:11434/v1' },
              ],
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body?.issues).toEqual([
        {
          path: 'endpoints.custom.0',
          segments: ['endpoints', 'custom', '0'],
          code: 'duplicate_merge_key',
        },
      ]);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('accepts an override spelled `ollama` onto the YAML `Ollama` it merges into', async () => {
      const { handlers, deps } = createHandlers({
        getAppConfig: jest.fn().mockResolvedValue({
          config: {
            endpoints: {
              custom: [
                {
                  name: 'Ollama',
                  apiKey: 'ollama',
                  baseURL: 'http://yaml-host:11434/v1',
                  models: { default: ['llama3'] },
                },
              ],
            },
          },
        }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            endpoints: { custom: [{ name: 'ollama', modelDisplayLabel: 'Local' }] },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
    });

    it('keeps the key a stored two-spelling `Ollama` document applies when a write omits it', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          configVersion: 1,
          priority: 10,
          overrides: {
            endpoints: {
              custom: [
                {
                  name: 'Ollama',
                  baseURL: 'http://override-first:11434/v1',
                  apiKey: 'v3:test:sk-ollama-first-key',
                  apiKeyPreview: '...-key',
                },
                { name: 'ollama', modelDisplayLabel: 'legacy-second' },
              ],
            },
          },
        }),
      });
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          overrides: {
            endpoints: {
              custom: [{ name: 'ollama', baseURL: 'http://override-first:11434/v1' }],
            },
          },
        },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(200);
      expect(writtenField(deps, 'endpoints.custom')).toEqual([
        {
          name: 'ollama',
          baseURL: 'http://override-first:11434/v1',
          apiKey: 'v3:test:sk-ollama-first-key',
          apiKeyPreview: '...-key',
        },
      ]);
    });

    it('rejects a field patch with an invalid value and writes no entry', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: {
          entries: [
            { fieldPath: 'interface.customWelcome', value: 'hi' },
            { fieldPath: 'githubCompare.timeoutMs', value: 'soon' },
          ],
        },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body?.issues).toEqual([
        {
          path: 'githubCompare.timeoutMs',
          segments: ['githubCompare', 'timeoutMs'],
          code: 'invalid_type',
          params: { expected: 'number', received: 'string' },
        },
      ]);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('validates an object patch as a partial of the addressed section', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'interface.schedules', value: { maxPerUser: 'x' } }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body?.issues).toEqual([
        expect.objectContaining({ path: 'interface.schedules.maxPerUser' }),
      ]);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('rejects a Base policy link that would run script and stores nothing', async () => {
      const { handlers, deps } = createHandlers();
      const params = { principalType: 'role', principalId: '__base__' };
      const documentRes = mockRes();
      const fieldRes = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params,
          body: {
            overrides: {
              interface: {
                privacyPolicy: { externalUrl: 'javascript:alert(document.domain)' },
                termsOfService: { externalUrl: 'https://example.com/terms' },
              },
            },
          },
        }),
        documentRes,
      );
      await handlers.patchConfigField(
        mockReq({
          params,
          body: {
            entries: [
              {
                fieldPath: 'interface.termsOfService.externalUrl',
                value: '\u00a0JavaScript:alert(document.domain)',
              },
            ],
          },
        }),
        fieldRes,
      );

      expect(documentRes.statusCode).toBe(400);
      expect(documentRes.body?.issues).toEqual([
        {
          path: 'interface.privacyPolicy.externalUrl',
          segments: ['interface', 'privacyPolicy', 'externalUrl'],
          code: 'custom',
        },
      ]);
      expect(fieldRes.statusCode).toBe(400);
      expect(fieldRes.body?.issues).toEqual([
        {
          path: 'interface.termsOfService.externalUrl',
          segments: ['interface', 'termsOfService', 'externalUrl'],
          code: 'custom',
        },
      ]);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('keeps accepting http(s), relative and blank policy links', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params: { principalType: 'role', principalId: '__base__' },
          body: {
            overrides: {
              interface: {
                privacyPolicy: { externalUrl: 'https://example.com/privacy', openNewTab: true },
                termsOfService: { externalUrl: '/terms', modalAcceptance: true },
              },
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(writtenDraft(deps).overrides.interface).toEqual({
        privacyPolicy: { externalUrl: 'https://example.com/privacy', openNewTab: true },
        termsOfService: { externalUrl: '/terms', modalAcceptance: true },
      });
    });

    it('skips a Turnstile write to Base, which stays on librechat.yaml', async () => {
      const { handlers, deps } = createHandlers();
      const params = { principalType: 'role', principalId: '__base__' };
      const documentRes = mockRes();
      const fieldRes = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params,
          body: {
            overrides: { turnstile: { siteKey: 'stored-key' }, interface: { modelSelect: false } },
          },
        }),
        documentRes,
      );
      await handlers.patchConfigField(
        mockReq({ params, body: { entries: [{ fieldPath: 'turnstile.siteKey', value: 'k' }] } }),
        fieldRes,
      );
      const removals = [mockRes(), mockRes()];
      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'turnstile' } }),
        removals[0],
      );
      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'turnstile.siteKey' } }),
        removals[1],
      );

      expect(documentRes.statusCode).toBe(201);
      expect(writtenDraft(deps).overrides).toEqual({ interface: { modelSelect: false } });
      expect(fieldRes.statusCode).toBe(200);
      expect(removals.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });

    it('refuses a Turnstile tombstone under its AppConfig name and removes a stored one', async () => {
      const { handlers, deps } = createHandlers({
        unsetConfigField: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {}, tombstones: [] }),
      });
      const params = { principalType: 'role', principalId: '__base__' };
      const tombstoneRes = mockRes();
      const deleteRes = mockRes();

      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'turnstileConfig' } }),
        tombstoneRes,
      );
      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'turnstileConfig.siteKey' } }),
        deleteRes,
      );

      expect(tombstoneRes.statusCode).toBe(400);
      expect(tombstoneRes.body).toEqual({
        error: 'Unknown config section',
        code: 'UNKNOWN_SECTION',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
      expect(deleteRes.statusCode).toBe(200);
      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        '__base__',
        [{ segments: ['turnstileConfig', 'siteKey'] }],
        undefined,
        { expectedRevision: undefined },
      );
    });

    it('rejects a patch that addresses a custom endpoint by index', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'endpoints.custom.0.models', value: { default: ['m'] } }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body?.issues).toEqual([
        {
          path: 'endpoints.custom',
          segments: ['endpoints', 'custom'],
          code: 'indexed_merge_key_write',
        },
      ]);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('accepts a secret field cleared with a non-string value', async () => {
      const { handlers, deps } = createHandlers();
      const req = mockReq({
        params: { principalType: 'role', principalId: 'admin' },
        body: { entries: [{ fieldPath: 'ocr.apiKey', value: null }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('audit entries', () => {
    const target = { type: 'config', id: 'role:editor', name: 'role:editor' };
    const params = { principalType: 'role', principalId: 'editor' };

    it('removes a secret and its preview in one write and records one entry', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
      const { handlers, deps } = createHandlers({ recordAuditEntry, invalidateConfigCaches });
      const req = mockReq({ params, query: { fieldPath: 'ocr.apiKey' } });
      const res = mockRes();

      await handlers.deleteConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(deps.unsetConfigField).toHaveBeenCalledTimes(1);
      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        'editor',
        [{ segments: ['ocr', 'apiKey'] }, { segments: ['ocr', 'apiKeyPreview'] }],
        undefined,
        { expectedRevision: undefined },
      );
      expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config.updated',
          target,
          metadata: { operation: 'unset', fieldPath: 'ocr.apiKey' },
        }),
      );
    });

    it('records nothing and invalidates nothing when the write fails', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        recordAuditEntry,
        invalidateConfigCaches,
        unsetConfigField: jest.fn().mockRejectedValue(new Error('write failed')),
      });
      const res = mockRes();

      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'ocr.apiKey' } }),
        res,
      );

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to delete config field' });
      expect(invalidateConfigCaches).not.toHaveBeenCalled();
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('records config.created for a new override document', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({ recordAuditEntry });
      const req = mockReq({
        params,
        body: { overrides: { interface: { modelSelect: false } } },
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(req, res);

      expect(res.statusCode).toBe(201);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config.created',
          actor: expect.objectContaining({ type: 'user', id: 'u1' }),
          target,
          metadata: { operation: 'replace', sections: 'interface', priority: 10 },
        }),
      );
    });

    it('records config.updated for a patch with field paths but no values', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        recordAuditEntry,
        findConfigByPrincipal: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {} }),
      });
      const req = mockReq({
        params,
        body: { entries: [{ fieldPath: 'registration.enabled', value: false }] },
      });
      const res = mockRes();

      await handlers.patchConfigField(req, res);

      expect(res.statusCode).toBe(200);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config.updated',
          target,
          metadata: { operation: 'patch', fieldPaths: 'registration.enabled' },
        }),
      );
    });

    it('records config.created when the first tombstone creates the document', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({ recordAuditEntry });
      const res = mockRes();

      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'mcpServers.github' } }),
        res,
      );

      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'config.created' }),
      );
    });

    it('records tombstone and unset field operations', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        recordAuditEntry,
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: 'c1',
          principalType: 'role',
          principalId: 'editor',
          priority: 10,
          configVersion: 2,
          isActive: true,
          overrides: {},
          tombstones: [],
        }),
      });

      const tombstoneRes = mockRes();
      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'mcpServers.github' } }),
        tombstoneRes,
      );
      const unsetRes = mockRes();
      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'registration.enabled' } }),
        unsetRes,
      );

      expect(tombstoneRes.statusCode).toBe(200);
      expect(unsetRes.statusCode).toBe(200);
      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: 'config.updated',
          metadata: { operation: 'tombstone', fieldPath: 'mcpServers.github' },
        }),
      );
      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: 'config.updated',
          metadata: { operation: 'unset', fieldPath: 'registration.enabled' },
        }),
      );
    });

    it('records config.deleted and config.toggled', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({ recordAuditEntry });

      await handlers.deleteConfigOverrides(mockReq({ params }), mockRes());
      await handlers.toggleConfig(mockReq({ params, body: { isActive: false } }), mockRes());

      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ action: 'config.deleted', target }),
      );
      expect(recordAuditEntry).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: 'config.toggled',
          target,
          metadata: { isActive: false },
        }),
      );
    });

    it('does not record a toggle that leaves isActive unchanged', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        recordAuditEntry,
        toggleConfigActiveTracked: jest
          .fn()
          .mockResolvedValue({ config: { _id: 'c1', isActive: false }, changed: false }),
      });
      const res = mockRes();

      await handlers.toggleConfig(mockReq({ params, body: { isActive: false } }), res);

      expect(res.statusCode).toBe(200);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('does not record when the override document is missing', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        recordAuditEntry,
        deleteConfig: jest.fn().mockResolvedValue(null),
      });
      const res = mockRes();

      await handlers.deleteConfigOverrides(mockReq({ params }), res);

      expect(res.statusCode).toBe(404);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('does not record a denied mutation', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        recordAuditEntry,
        hasConfigCapability: jest.fn().mockResolvedValue(false),
        hasCapability: jest.fn().mockResolvedValue(false),
      });
      const res = mockRes();

      await handlers.toggleConfig(mockReq({ params, body: { isActive: true } }), res);

      expect(res.statusCode).toBe(403);
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });
  });

  describe('override sections outside configSchema', () => {
    /** Runtime state AppService builds that `configSchema` does not define, so no override may set it. */
    const RUNTIME_KEYS = [
      'paths',
      'config',
      'availableTools',
      'interfaceConfig',
      'turnstileConfig',
      'mcpConfig',
    ];
    const MARKER = '/tmp/attacker-controlled';
    const params = { principalType: 'role', principalId: 'admin' };
    const UNKNOWN_SECTION = { error: 'Unknown config section', code: 'UNKNOWN_SECTION' };

    it.each(RUNTIME_KEYS)('rejects a whole-document write holding `%s`', async (key) => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params,
          body: { overrides: { [key]: { uploads: MARKER }, registration: { enabled: false } } },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid config override',
        code: 'CONFIG_OVERRIDE_INVALID',
        issues: [{ path: key, segments: [key], code: 'unknown_section' }],
      });
      expect(JSON.stringify(res.body)).not.toContain(MARKER);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it.each([
      'paths.uploads',
      'config.permissions',
      'config',
      'interfaceConfig.prompts',
      'turnstileConfig.siteKey',
      'mcpConfig.remote.url',
      'availableTools.calculator',
    ])('rejects a field write to `%s` without echoing the path', async (fieldPath) => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({ params, body: { entries: [{ fieldPath, value: MARKER }] } }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(UNKNOWN_SECTION);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });

    it('rejects the whole batch when any entry addresses an unknown section', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: {
            entries: [
              { fieldPath: 'registration.enabled', value: false },
              { fieldPath: 'paths.uploads', value: MARKER },
            ],
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(UNKNOWN_SECTION);
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('still accepts keys the schema does not define inside a known section', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'registration.futureOption', value: 1 }] },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
      expect(writtenDraft(deps).overrides).toEqual({ registration: { futureOption: 1 } });
    });

    it.each(['paths', 'paths.uploads', 'config.permissions', 'interfaceConfig.prompts'])(
      'rejects a tombstone on `%s`',
      async (fieldPath) => {
        const { handlers, deps } = createHandlers();
        const res = mockRes();

        await handlers.tombstoneConfigField(mockReq({ params, body: { fieldPath } }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(UNKNOWN_SECTION);
        expect(deps.writeConfigDocument).not.toHaveBeenCalled();
        expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
      },
    );

    it('lets a broad manager remove a value stored under an unknown section', async () => {
      const { handlers, deps } = createHandlers({
        unsetConfigField: jest.fn().mockResolvedValue({ _id: 'c1', overrides: {}, tombstones: [] }),
      });
      const res = mockRes();

      await handlers.deleteConfigField(mockReq({ params, query: { fieldPath: 'paths' } }), res);

      expect(res.statusCode).toBe(200);
      expect(deps.unsetConfigField).toHaveBeenCalledWith(
        'role',
        'admin',
        [{ segments: ['paths'] }],
        undefined,
        {
          expectedRevision: undefined,
        },
      );
    });

    it('does not let a section-scoped manager remove a value under an unknown section', async () => {
      const { handlers, deps } = createHandlers({
        hasConfigCapability: jest.fn(async (_user, section) => section === 'memory'),
      });
      const res = mockRes();

      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'paths.uploads' } }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
    });
  });

  describe('write responses: filtered by read access', () => {
    const params = { principalType: 'role', principalId: 'editors' };

    function writtenDoc() {
      return {
        _id: 'c1',
        principalType: 'role',
        principalId: 'editors',
        priority: 10,
        configVersion: 2,
        isActive: true,
        overrides: {
          endpoints: {
            agents: { disableBuilder: true },
            custom: [{ name: 'groq', apiKey: 'v3:endpoint-cipher', apiKeyPreview: '...abcd' }],
          },
          memory: { charLimit: 500 },
          webSearch: {
            searchProvider: 'serper',
            serperApiKey: 'v3:serper-cipher',
            serperApiKeyPreview: '...wxyz',
          },
        },
        tombstones: ['endpoints.bedrock', 'memory.tokenLimit', 'webSearch.jinaApiUrl'],
      };
    }

    /** A caller holding only the listed `<verb>:configs:<section>` grants, never the broad ones. */
    function scopedCapability(grants: string[]) {
      return jest.fn(
        async (_user: unknown, section: string | null, verb = 'manage') =>
          section != null && grants.includes(`${verb}:${section}`),
      );
    }

    type WrittenBody = { overrides: Record<string, unknown>; tombstones: string[] };

    it('PATCH: a section manager sees only the sections it wrote', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:endpoints']),
        writeConfigDocument: jest.fn().mockResolvedValue(writtenDoc()),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as WrittenBody;
      expect(Object.keys(body.overrides)).toEqual(['endpoints']);
      expect(body.tombstones).toEqual(['endpoints.bedrock']);
      expect(body).toMatchObject({ principalId: 'editors', priority: 10, configVersion: 2 });
      expect(JSON.stringify(res.body)).not.toMatch(/charLimit|serper|cipher/);
    });

    it('PATCH: adds the other sections the caller can read', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:endpoints', 'read:memory']),
        writeConfigDocument: jest.fn().mockResolvedValue(writtenDoc()),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        res,
      );

      const body = res.body!.config as WrittenBody;
      expect(Object.keys(body.overrides).sort()).toEqual(['endpoints', 'memory']);
      expect(body.tombstones).toEqual(['endpoints.bedrock', 'memory.tokenLimit']);
    });

    it('PATCH: uses the batched read lookup, once and before the write', async () => {
      const getReadableConfigSections = jest
        .fn()
        .mockResolvedValue({ broad: false, sections: new Set(['webSearch']) });
      const writeConfigDocument = jest.fn().mockResolvedValue(writtenDoc());
      const { handlers } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:endpoints']),
        getReadableConfigSections,
        writeConfigDocument,
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        res,
      );

      expect(getReadableConfigSections).toHaveBeenCalledTimes(1);
      expect([...getReadableConfigSections.mock.calls[0][1]].sort()).toEqual(
        Object.keys(configSchema.shape).sort(),
      );
      expect(getReadableConfigSections.mock.invocationCallOrder[0]).toBeLessThan(
        writeConfigDocument.mock.invocationCallOrder[0],
      );
      const body = res.body!.config as WrittenBody;
      expect(Object.keys(body.overrides).sort()).toEqual(['endpoints', 'webSearch']);
      expect(body.overrides.webSearch).toEqual({
        searchProvider: 'serper',
        serperApiKeyPreview: '...wxyz',
      });
    });

    it('PATCH: resolves read access alongside the base config read, not after it', async () => {
      let releaseBase: (appConfig: { config: object }) => void = () => undefined;
      const getAppConfig = jest.fn(
        () => new Promise<{ config: object }>((resolve) => (releaseBase = resolve)),
      );
      const getReadableConfigSections = jest
        .fn()
        .mockResolvedValue({ broad: false, sections: new Set<string>() });
      const writeConfigDocument = jest.fn().mockResolvedValue(writtenDoc());
      const { handlers } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:endpoints']),
        getAppConfig,
        getReadableConfigSections,
        writeConfigDocument,
      });
      const res = mockRes();

      const pending = handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        res,
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(getAppConfig).toHaveBeenCalledTimes(1);
      expect(getReadableConfigSections).toHaveBeenCalledTimes(1);
      expect(writeConfigDocument).not.toHaveBeenCalled();
      releaseBase({ config: {} });
      await pending;
      expect(res.statusCode).toBe(200);
      expect(writeConfigDocument).toHaveBeenCalledTimes(1);
    });

    it('/changes: resolves read access with the base config read, then filters the reply', async () => {
      let releaseBase: (appConfig: { config: object }) => void = () => undefined;
      const getAppConfig = jest.fn(
        () => new Promise<{ config: object }>((resolve) => (releaseBase = resolve)),
      );
      const getReadableConfigSections = jest
        .fn()
        .mockResolvedValue({ broad: false, sections: new Set(['webSearch']) });
      const writeConfigDocument = jest.fn().mockResolvedValue(writtenDoc());
      const { handlers } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:endpoints']),
        getAppConfig,
        getReadableConfigSections,
        writeConfigDocument,
      });
      const res = mockRes();

      const pending = handlers.applyConfigChanges(
        mockReq({
          params,
          body: { ops: [{ op: 'set', fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        res,
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(getAppConfig).toHaveBeenCalledTimes(1);
      expect(getReadableConfigSections).toHaveBeenCalledTimes(1);
      expect([...getReadableConfigSections.mock.calls[0][1]].sort()).toEqual(
        Object.keys(configSchema.shape).sort(),
      );
      expect(writeConfigDocument).not.toHaveBeenCalled();
      releaseBase({ config: {} });
      await pending;

      expect(res.statusCode).toBe(200);
      expect(writeConfigDocument).toHaveBeenCalledTimes(1);
      expect(getReadableConfigSections).toHaveBeenCalledTimes(1);
      expect(res.body).toMatchObject({ written: true, revision: 'c1:2' });
      const body = res.body!.config as WrittenBody & { revision: string };
      expect(Object.keys(body.overrides).sort()).toEqual(['endpoints', 'webSearch']);
      expect(body.overrides.webSearch).toEqual({
        searchProvider: 'serper',
        serperApiKeyPreview: '...wxyz',
      });
      expect(body.tombstones).toEqual(['endpoints.bedrock', 'webSearch.jinaApiUrl']);
      expect(body.revision).toBe('c1:2');
      expect(JSON.stringify(res.body)).not.toMatch(/charLimit|cipher/);
    });

    it('/changes: a dry run returns no document and resolves no read access', async () => {
      const getReadableConfigSections = jest.fn();
      const { handlers, deps } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:endpoints']),
        getReadableConfigSections,
      });
      const res = mockRes();

      await handlers.applyConfigChanges(
        mockReq({
          params,
          body: {
            ops: [{ op: 'set', fieldPath: 'endpoints.agents.disableBuilder', value: true }],
            dryRun: true,
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ written: false, dryRun: true });
      expect(res.body).not.toHaveProperty('config');
      expect(getReadableConfigSections).not.toHaveBeenCalled();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it.each([
      [
        'PATCH',
        'writeConfigDocument',
        (h: ReturnType<typeof createHandlers>['handlers'], res: Response) =>
          h.patchConfigField(
            mockReq({
              params,
              body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
            }),
            res,
          ),
      ],
      [
        'tombstone',
        'writeConfigDocument',
        (h: ReturnType<typeof createHandlers>['handlers'], res: Response) =>
          h.tombstoneConfigField(
            mockReq({ params, body: { fieldPath: 'endpoints.bedrock' } }),
            res,
          ),
      ],
      [
        'field delete',
        'unsetConfigField',
        (h: ReturnType<typeof createHandlers>['handlers'], res: Response) =>
          h.deleteConfigField(mockReq({ params, query: { fieldPath: 'endpoints.bedrock' } }), res),
      ],
      [
        '/changes',
        'writeConfigDocument',
        (h: ReturnType<typeof createHandlers>['handlers'], res: Response) =>
          h.applyConfigChanges(
            mockReq({
              params,
              body: {
                ops: [{ op: 'set', fieldPath: 'endpoints.agents.disableBuilder', value: true }],
              },
            }),
            res,
          ),
      ],
    ] as const)(
      '%s: a failed read lookup fails the request before anything is written',
      async (_label, write, run) => {
        const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
        const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
        const { handlers, deps } = createHandlers({
          hasConfigCapability: scopedCapability(['manage:endpoints']),
          getReadableConfigSections: jest.fn().mockRejectedValue(new Error('grant lookup down')),
          writeConfigDocument: jest.fn().mockResolvedValue(writtenDoc()),
          unsetConfigField: jest.fn().mockResolvedValue(writtenDoc()),
          recordAuditEntry,
          invalidateConfigCaches,
        });
        const res = mockRes();

        await run(handlers, res);

        expect(res.statusCode).toBe(500);
        expect((deps as Record<string, jest.Mock>)[write]).not.toHaveBeenCalled();
        expect(deps.writeConfigDocument).not.toHaveBeenCalled();
        expect(recordAuditEntry).not.toHaveBeenCalled();
        expect(invalidateConfigCaches).not.toHaveBeenCalled();
      },
    );

    it('a broad manager gets the whole redacted document without a read lookup', async () => {
      const hasConfigCapability = jest.fn().mockResolvedValue(true);
      const getReadableConfigSections = jest.fn();
      const { handlers } = createHandlers({
        hasConfigCapability,
        getReadableConfigSections,
        writeConfigDocument: jest.fn().mockResolvedValue(writtenDoc()),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'endpoints.agents.disableBuilder', value: true }] },
        }),
        res,
      );

      const body = res.body!.config as WrittenBody;
      expect(Object.keys(body.overrides).sort()).toEqual(['endpoints', 'memory', 'webSearch']);
      expect(body.tombstones).toHaveLength(3);
      expect(JSON.stringify(res.body)).not.toContain('cipher');
      expect(getReadableConfigSections).not.toHaveBeenCalled();
      expect(hasConfigCapability.mock.calls.every(([, , verb]) => verb !== 'read')).toBe(true);
    });

    it('tombstone: a section manager sees only the tombstoned section', async () => {
      const { handlers } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:memory']),
        writeConfigDocument: jest.fn().mockResolvedValue(writtenDoc()),
      });
      const res = mockRes();

      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'memory.tokenLimit' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const body = res.body!.config as WrittenBody;
      expect(body.overrides).toEqual({ memory: { charLimit: 500 } });
      expect(body.tombstones).toEqual(['memory.tokenLimit']);
    });

    it('field delete: a section manager sees only that section, secrets redacted', async () => {
      const before = writtenDoc();
      const { handlers, deps } = createHandlers({
        hasConfigCapability: scopedCapability(['manage:webSearch']),
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          ...before,
          configVersion: 1,
          overrides: {
            ...before.overrides,
            webSearch: { ...before.overrides.webSearch, jinaApiUrl: 'https://jina.example.com' },
          },
        }),
        writeConfigDocument: jest.fn().mockResolvedValue(writtenDoc()),
      });
      const res = mockRes();

      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'webSearch.jinaApiUrl' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(deps.unsetConfigField).not.toHaveBeenCalled();
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
      expect(deps.writeConfigDocument.mock.calls[0][3]).toBe('c1:1');
      expect(writtenDraft(deps).overrides.webSearch).not.toHaveProperty('jinaApiUrl');
      const body = res.body!.config as WrittenBody;
      expect(body.overrides).toEqual({
        webSearch: { searchProvider: 'serper', serperApiKeyPreview: '...wxyz' },
      });
      expect(body.tombstones).toEqual(['webSearch.jinaApiUrl']);
    });

    it('toggle and scope creation: an assign-only caller sees no section it cannot read', async () => {
      const getReadableConfigSections = jest.fn();
      const deps = {
        hasConfigCapability: scopedCapability([]),
        getReadableConfigSections,
        hasCapability: jest.fn().mockResolvedValue(true),
        writeConfigDocument: jest.fn().mockResolvedValue({ ...writtenDoc(), configVersion: 1 }),
        toggleConfigActiveTracked: jest
          .fn()
          .mockResolvedValue({ config: writtenDoc(), changed: true }),
      };
      const { handlers } = createHandlers(deps);

      const toggled = mockRes();
      await handlers.toggleConfig(mockReq({ params, body: { isActive: false } }), toggled);
      const created = mockRes();
      await handlers.upsertConfigOverrides(
        mockReq({ params, body: { overrides: {}, priority: 5 } }),
        created,
      );

      expect(toggled.statusCode).toBe(200);
      expect(created.statusCode).toBe(201);
      for (const res of [toggled, created]) {
        const body = res.body!.config as WrittenBody;
        expect(body.overrides).toEqual({});
        expect(body.tombstones).toEqual([]);
        expect(body).toMatchObject({ principalId: 'editors', isActive: true });
      }
      expect(getReadableConfigSections).not.toHaveBeenCalled();
    });
  });

  describe('revision preconditions', () => {
    const params = { principalType: 'role', principalId: 'editor' };
    const stored = {
      _id: '64b000000000000000000001',
      principalType: 'role',
      principalId: 'editor',
      priority: 10,
      configVersion: 4,
      isActive: true,
      overrides: { interface: { customWelcome: 'stored' } },
      tombstones: [],
    };
    const storedRevision = '64b000000000000000000001:4';

    it.each([
      ['upsertConfigOverrides', { body: { overrides: {}, priority: 1, expectedRevision: 'v4' } }],
      [
        'patchConfigField',
        { body: { entries: [{ fieldPath: 'a.b', value: 1 }], expectedRevision: 4 } },
      ],
      ['tombstoneConfigField', { body: { fieldPath: 'memory', expectedRevision: 'abc:-1' } }],
      ['deleteConfigField', { query: { fieldPath: 'memory', expectedRevision: '' } }],
      ['deleteConfigOverrides', { query: { expectedRevision: 'abc' } }],
      ['toggleConfig', { body: { isActive: false, expectedRevision: { $ne: null } } }],
    ] as const)('%s rejects a malformed expectedRevision with 400', async (name, overrides) => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers[name](mockReq({ params, ...overrides }), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'expectedRevision must be "absent" or a revision returned by the config API',
        code: 'INVALID_EXPECTED_REVISION',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('returns 409 with the stored revision when the precondition does not match', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: {
            entries: [{ fieldPath: 'interface.customWelcome', value: 'mine' }],
            expectedRevision: '64b000000000000000000001:3',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        error: 'Config was modified by another request',
        code: 'CONFIG_VERSION_CONFLICT',
        currentRevision: storedRevision,
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('returns 409 with a null revision for a create-only write when the profile exists, and for a revision of a missing one', async () => {
      const exists = createHandlers({ findConfigByPrincipal: jest.fn().mockResolvedValue(stored) });
      const existsRes = mockRes();
      await exists.handlers.upsertConfigOverrides(
        mockReq({ params, body: { overrides: {}, priority: 5, expectedRevision: 'absent' } }),
        existsRes,
      );
      expect(existsRes.statusCode).toBe(409);
      expect(existsRes.body?.currentRevision).toBe(storedRevision);

      const missing = createHandlers();
      const missingRes = mockRes();
      await missing.handlers.upsertConfigOverrides(
        mockReq({ params, body: { overrides: {}, priority: 5, expectedRevision: storedRevision } }),
        missingRes,
      );
      expect(missingRes.statusCode).toBe(409);
      expect(missingRes.body?.currentRevision).toBeNull();
      expect(missing.deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('writes on the precondition the client sent and returns the new revision', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: {
            entries: [{ fieldPath: 'interface.customWelcome', value: 'mine' }],
            expectedRevision: storedRevision,
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(deps.writeConfigDocument).toHaveBeenCalledWith(
        'role',
        'editor',
        expect.objectContaining({ overrides: { interface: { customWelcome: 'mine' } } }),
        storedRevision,
      );
      expect((res.body?.config as { revision: string }).revision).toBe('c1:5');
    });

    it('re-reads and re-validates when a write without a precondition loses a race', async () => {
      const rotated = { ...stored, configVersion: 5, overrides: { interface: { a: 1 } } };
      const reads = [stored, rotated];
      /**
       * Base (the validation floor) has no document. Each attempt reads it beside the target,
       * and the committed write reads it once more.
       */
      const findConfigByPrincipal = jest.fn(async (_type: string, principalId: string) =>
        principalId === '__base__' ? null : reads.shift(),
      );
      const writeConfigDocument = jest
        .fn()
        .mockRejectedValueOnce(new ConfigRevisionConflictError())
        .mockImplementation(async (type, id, draft, expected) =>
          writtenDocument(type, id, draft, expected),
        );
      const { handlers } = createHandlers({ findConfigByPrincipal, writeConfigDocument });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'x' }] },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(reads).toHaveLength(0);
      expect(findConfigByPrincipal).toHaveBeenCalledTimes(5);
      expect(writeConfigDocument).toHaveBeenCalledTimes(2);
      expect(writeConfigDocument.mock.calls[1][2].overrides).toEqual({
        interface: { a: 1, customWelcome: 'x' },
      });
      expect(writeConfigDocument.mock.calls[1][3]).toBe('64b000000000000000000001:5');
    });

    it('keeps a committed write when Base cannot be read again to check it', async () => {
      let baseReads = 0;
      const findConfigByPrincipal = jest.fn(async (_type: string, principalId: string) => {
        if (principalId !== '__base__') {
          return stored;
        }
        baseReads += 1;
        if (baseReads > 1) {
          throw new Error('connection reset');
        }
        return null;
      });
      const { handlers, deps } = createHandlers({ findConfigByPrincipal });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'kept' }] },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(baseReads).toBe(2);
      expect(deps.writeConfigDocument).toHaveBeenCalledTimes(1);
    });

    it('answers 409 once the retry budget is spent', async () => {
      const findConfigByPrincipal = jest.fn().mockResolvedValue(stored);
      const writeConfigDocument = jest.fn().mockRejectedValue(new ConfigRevisionConflictError());
      const { handlers } = createHandlers({ findConfigByPrincipal, writeConfigDocument });
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({ params, body: { overrides: { interface: { customWelcome: 'x' } } } }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body?.code).toBe('CONFIG_VERSION_CONFLICT');
      expect(writeConfigDocument).toHaveBeenCalledTimes(3);
      expect(res.body?.currentRevision).toBe(storedRevision);
    });

    it('passes the precondition through to tombstone, field delete, delete and toggle', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });

      await handlers.tombstoneConfigField(
        mockReq({ params, body: { fieldPath: 'memory', expectedRevision: storedRevision } }),
        mockRes(),
      );
      await handlers.deleteConfigField(
        mockReq({ params, query: { fieldPath: 'memory', expectedRevision: storedRevision } }),
        mockRes(),
      );
      await handlers.deleteConfigOverrides(
        mockReq({ params, query: { expectedRevision: storedRevision } }),
        mockRes(),
      );
      await handlers.toggleConfig(
        mockReq({ params, body: { isActive: false, expectedRevision: storedRevision } }),
        mockRes(),
      );

      const options = { expectedRevision: storedRevision };
      expect(deps.writeConfigDocument.mock.calls[0][3]).toBe(storedRevision);
      expect(deps.unsetConfigField.mock.calls[0][4]).toEqual(options);
      expect(deps.deleteConfig.mock.calls[0][3]).toEqual({ expectEmpty: false, ...options });
      expect(deps.toggleConfigActiveTracked.mock.calls[0][3]).toEqual({
        expectEmpty: false,
        ...options,
      });
    });

    it.each([
      ['tombstoneConfigField', { body: { fieldPath: 'memory' } }, 'writeConfigDocument'],
      ['deleteConfigField', { query: { fieldPath: 'memory' } }, 'unsetConfigField'],
      ['deleteConfigOverrides', {}, 'deleteConfig'],
      ['toggleConfig', { body: { isActive: true } }, 'toggleConfigActiveTracked'],
    ] as const)('%s maps a store conflict to 409', async (name, overrides, method) => {
      const { handlers } = createHandlers({
        [method]: jest.fn().mockRejectedValue(new ConfigRevisionConflictError(storedRevision)),
      });
      const res = mockRes();

      await handlers[name](mockReq({ params, ...overrides }), res);

      expect(res.statusCode).toBe(409);
      expect(res.body?.currentRevision).toBe(storedRevision);
    });

    it('reports the stored revision on a write with nothing to apply', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({ params, body: { entries: [{ fieldPath: 'interface.prompts', value: false }] } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        message: 'No actionable field entries provided',
        revision: storedRevision,
        config: expect.objectContaining({ revision: storedRevision }),
        applied: [],
        skipped: [
          {
            path: 'interface.prompts',
            segments: ['interface', 'prompts'],
            reason: 'interface_permission',
          },
        ],
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    describe('on a write with nothing to apply', () => {
      const noops = [
        ['upsertConfigOverrides', 'body', { overrides: { filters: {} } }],
        [
          'patchConfigField',
          'body',
          { entries: [{ fieldPath: 'interface.prompts', value: false }] },
        ],
        ['tombstoneConfigField', 'body', { fieldPath: 'interface.prompts' }],
        ['deleteConfigField', 'query', { fieldPath: 'interface.prompts' }],
      ] as const;

      it.each(noops)(
        '%s answers 409 when the stored document is not at expectedRevision',
        async (name, location, input) => {
          const exists = createHandlers({
            findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
          });
          const createOnly = mockRes();
          await exists.handlers[name](
            mockReq({ params, [location]: { ...input, expectedRevision: 'absent' } }),
            createOnly,
          );
          expect(createOnly.statusCode).toBe(409);
          expect(createOnly.body).toEqual({
            error: 'Config was modified by another request',
            code: 'CONFIG_VERSION_CONFLICT',
            currentRevision: storedRevision,
          });

          const stale = mockRes();
          await exists.handlers[name](
            mockReq({
              params,
              [location]: { ...input, expectedRevision: '64b000000000000000000001:3' },
            }),
            stale,
          );
          expect(stale.statusCode).toBe(409);
          expect(stale.body?.currentRevision).toBe(storedRevision);

          const missing = createHandlers();
          const gone = mockRes();
          await missing.handlers[name](
            mockReq({ params, [location]: { ...input, expectedRevision: storedRevision } }),
            gone,
          );
          expect(gone.statusCode).toBe(409);
          expect(gone.body?.currentRevision).toBeNull();
          for (const deps of [exists.deps, missing.deps]) {
            expect(deps.writeConfigDocument).not.toHaveBeenCalled();
            expect(deps.writeConfigDocument).not.toHaveBeenCalled();
            expect(deps.unsetConfigField).not.toHaveBeenCalled();
          }
        },
      );

      it.each(noops)(
        '%s answers 200 with the revision when the precondition holds',
        async (name, location, input) => {
          const exists = createHandlers({
            findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
          });
          const matched = mockRes();
          await exists.handlers[name](
            mockReq({ params, [location]: { ...input, expectedRevision: storedRevision } }),
            matched,
          );
          expect(matched.statusCode).toBe(200);
          expect(matched.body?.revision).toBe(storedRevision);
        },
      );

      it.each(noops.filter(([name]) => name !== 'upsertConfigOverrides'))(
        '%s answers 200 with no revision under absent when there is no document',
        async (name, location, input) => {
          const missing = createHandlers();
          const absent = mockRes();
          await missing.handlers[name](
            mockReq({ params, [location]: { ...input, expectedRevision: 'absent' } }),
            absent,
          );
          expect(absent.statusCode).toBe(200);
          expect(absent.body?.revision).toBeNull();
        },
      );

      it('upsertConfigOverrides under absent creates the empty profile, as a create-only PUT does', async () => {
        const missing = createHandlers();
        const absent = mockRes();
        await missing.handlers.upsertConfigOverrides(
          mockReq({ params, body: { overrides: { filters: {} }, expectedRevision: 'absent' } }),
          absent,
        );
        expect(absent.statusCode).toBe(201);
        expect(missing.deps.writeConfigDocument).toHaveBeenCalledWith(
          params.principalType,
          params.principalId,
          expect.objectContaining({ overrides: {}, tombstones: [], isActive: true }),
          'absent',
        );
      });
    });

    it('returns revisions on reads', async () => {
      const { handlers } = createHandlers({
        listAllConfigs: jest.fn().mockResolvedValue([stored]),
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });
      const listRes = mockRes();
      const getRes = mockRes();

      await handlers.listConfigs(mockReq(), listRes);
      await handlers.getConfig(mockReq({ params }), getRes);

      expect((listRes.body?.configs as Array<{ revision: string }>)[0].revision).toBe(
        storedRevision,
      );
      expect((getRes.body?.config as { revision: string }).revision).toBe(storedRevision);
    });
  });

  describe('write pipeline', () => {
    const params = { principalType: 'role', principalId: 'editor' };

    it('keeps an omitted custom endpoint key before validating, so a required secret can be omitted', async () => {
      const stored = {
        _id: '64b000000000000000000002',
        configVersion: 2,
        overrides: {
          endpoints: {
            custom: [
              {
                name: 'Private',
                apiKey: 'v3:test:sk-stored',
                apiKeyPreview: '...ored',
                baseURL: 'https://private.example.com/v1',
                models: { default: ['m'] },
              },
            ],
          },
        },
        tombstones: [],
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params,
          body: {
            overrides: {
              endpoints: {
                custom: [
                  {
                    name: 'Private',
                    baseURL: 'https://private.example.com/v1',
                    models: { default: ['m', 'n'] },
                  },
                ],
              },
            },
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [entry] = (
        writtenDraft(deps).overrides.endpoints as {
          custom: Array<Record<string, string> & { models: { default: string[] } }>;
        }
      ).custom;
      expect(entry.apiKey).toBe('v3:test:sk-stored');
      expect(entry.models.default).toEqual(['m', 'n']);
      /** Validation saw the document the write stores, with the kept secret in place. */
      const overrideCalls = jest.mocked(getConfigOverrideIssues).mock.calls;
      const validated = overrideCalls[overrideCalls.length - 1][0] as {
        endpoints: { custom: Array<Record<string, string>> };
      };
      expect(validated.endpoints.custom[0].apiKey).toBe('v3:test:sk-stored');
    });

    it('validates a patch with the secrets it omits already restored', async () => {
      const stored = {
        _id: '64b000000000000000000004',
        configVersion: 1,
        overrides: {
          speech: { tts: { openai: { apiKey: 'v3:test:sk-tts', apiKeyPreview: '...-tts' } } },
        },
        tombstones: [],
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(stored),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: {
            entries: [
              { fieldPath: 'speech.tts.openai', value: { model: 'tts-1', voices: ['alloy'] } },
            ],
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const fieldCalls = jest.mocked(getConfigFieldIssues).mock.calls;
      const [validatedFields] = fieldCalls[fieldCalls.length - 1];
      expect(validatedFields).toEqual([
        {
          segments: ['speech', 'tts', 'openai'],
          value: {
            model: 'tts-1',
            voices: ['alloy'],
            apiKey: 'v3:test:sk-tts',
            apiKeyPreview: '...-tts',
          },
        },
      ]);
      expect(writtenField(deps, 'speech.tts.openai.apiKey')).toBe('v3:test:sk-tts');
    });

    it('rejects a patch the stored document cannot take with CONFIG_PATH_INVALID', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue({
          _id: '64b000000000000000000003',
          configVersion: 1,
          overrides: { interface: { customWelcome: 'hi' } },
          tombstones: [],
        }),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'interface.customWelcome.nested', value: 'x' }] },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Config path cannot be applied to the stored config',
        code: 'CONFIG_PATH_INVALID',
        reason: 'scalar_parent',
      });
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
    });

    it('waits for cache invalidation before responding', async () => {
      let release: () => void = () => undefined;
      const invalidateConfigCaches = jest.fn(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const { handlers } = createHandlers({ invalidateConfigCaches });
      const res = mockRes();

      const pending = handlers.patchConfigField(
        mockReq({
          params,
          body: { entries: [{ fieldPath: 'interface.customWelcome', value: 'x' }] },
        }),
        res,
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(invalidateConfigCaches).toHaveBeenCalledTimes(1);
      expect(res.json).not.toHaveBeenCalled();
      release();
      await pending;
      expect(res.statusCode).toBe(200);
    });

    it('still answers 200 when invalidation fails after the write committed', async () => {
      const { handlers } = createHandlers({
        invalidateConfigCaches: jest.fn().mockRejectedValue(new Error('cache down')),
      });
      const res = mockRes();

      await handlers.toggleConfig(mockReq({ params, body: { isActive: false } }), res);

      expect(res.statusCode).toBe(200);
    });

    it('reads GET /base around the merged-config cache', async () => {
      const getAppConfig = jest.fn().mockResolvedValue({ interface: { modelSelect: true } });
      const { handlers } = createHandlers({ getAppConfig });

      await handlers.getBaseConfig(mockReq(), mockRes());

      expect(getAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ bypassOverrideCache: true }),
      );
    });
  });

  describe('reloadConfig', () => {
    const admin = { id: 'u1', role: 'ADMIN', _id: { toString: () => 'u1' } };
    const target = { type: 'config', id: 'librechat.yaml', name: 'librechat.yaml' };

    it('clears the config caches before answering, writes nothing and audits the reload', async () => {
      let release: () => void = () => undefined;
      const reloadConfigCaches = jest.fn(
        () =>
          new Promise<ConfigReloadReport>(
            (resolve) => (release = () => resolve({ cleared: true, broadcast: 'sent' })),
          ),
      );
      const invalidateConfigCaches = jest.fn().mockResolvedValue(undefined);
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers, deps } = createHandlers({
        reloadConfigCaches,
        invalidateConfigCaches,
        recordAuditEntry,
      });
      const res = mockRes();

      const reloading = handlers.reloadConfig(mockReq({ user: admin }), res);
      await new Promise((resolve) => setImmediate(resolve));
      expect(reloadConfigCaches).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
      release();
      await reloading;

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, broadcast: true });
      expect(invalidateConfigCaches).not.toHaveBeenCalled();
      expect(deps.writeConfigDocument).not.toHaveBeenCalled();
      expect(deps.hasConfigCapability).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u1', tenantId: undefined }),
        null,
        'manage',
      );
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config.reloaded',
          target,
          metadata: { broadcast: 'sent' },
        }),
      );
      expect(recordAuditEntry.mock.calls[0][0].outcome).toBeUndefined();
    });

    it('refuses a tenant admin with broad manage, since the reload reaches every tenant', async () => {
      const reloadConfigCaches = jest.fn().mockResolvedValue({ cleared: true, broadcast: 'sent' });
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({ reloadConfigCaches, recordAuditEntry });
      const res = mockRes();

      await handlers.reloadConfig(mockReq({ user: { ...admin, tenantId: 'tenant-a' } }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: expect.any(String), code: 'FORBIDDEN' });
      expect(reloadConfigCaches).not.toHaveBeenCalled();
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });

    it('answers 422 CONFIG_RELOAD_INVALID with the issue locations when librechat.yaml is refused', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const issues = [
        { path: 'bogusTopLevelKey', segments: ['bogusTopLevelKey'], code: 'unrecognized_keys' },
      ];
      const report: ConfigReloadReport = {
        cleared: true,
        loaded: { ok: false, error: { code: 'CONFIG_INVALID', issues } },
        broadcast: 'skipped',
      };
      const { handlers } = createHandlers({
        reloadConfigCaches: jest.fn().mockResolvedValue(report),
        recordAuditEntry,
      });
      const res = mockRes();

      await handlers.reloadConfig(mockReq(), res);

      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({
        error: expect.any(String),
        code: 'CONFIG_RELOAD_INVALID',
        issues,
      });
      expect(recordAuditEntry).toHaveBeenCalledTimes(1);
      expect(recordAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'config.reloaded',
          outcome: 'failure',
          target,
          metadata: { code: 'CONFIG_RELOAD_INVALID', broadcast: 'skipped' },
        }),
      );
    });

    it('answers broadcast: false when there is no pub/sub to tell other instances', async () => {
      const { handlers } = createHandlers({
        reloadConfigCaches: jest.fn().mockResolvedValue({ cleared: true, broadcast: 'none' }),
      });
      const res = mockRes();

      await handlers.reloadConfig(mockReq(), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, broadcast: false });
    });

    it.each([
      {
        name: 'the publish to the other instances failed',
        report: { cleared: true, broadcast: 'failed' },
        status: 503,
        code: 'CONFIG_RELOAD_BROADCAST_FAILED',
      },
      {
        name: 'a clear on this instance failed',
        report: { cleared: false, broadcast: 'sent' },
        status: 500,
        code: 'CONFIG_RELOAD_FAILED',
      },
      {
        name: 'both failed',
        report: { cleared: false, broadcast: 'failed' },
        status: 500,
        code: 'CONFIG_RELOAD_FAILED',
      },
      {
        name: 'building the config from the loaded file failed',
        report: {
          cleared: true,
          loaded: { ok: false, error: { code: 'LOAD_FAILED' } },
          broadcast: 'skipped',
        },
        status: 500,
        code: 'CONFIG_RELOAD_FAILED',
      },
    ])(
      'answers $status $code and audits a failure when $name',
      async ({ report, status, code }) => {
        const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
        const { handlers } = createHandlers({
          reloadConfigCaches: jest.fn().mockResolvedValue(report),
          recordAuditEntry,
        });
        const res = mockRes();

        await handlers.reloadConfig(mockReq(), res);

        expect(res.statusCode).toBe(status);
        expect(res.body).toEqual({ error: expect.any(String), code });
        expect(res.body).not.toHaveProperty('success');
        expect(recordAuditEntry).toHaveBeenCalledTimes(1);
        expect(recordAuditEntry).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'config.reloaded',
            outcome: 'failure',
            target,
            metadata: { code, broadcast: report.broadcast },
          }),
        );
      },
    );

    it('refuses a section-scoped manager, and answers 501 without the reload dependency', async () => {
      const reloadConfigCaches = jest.fn().mockResolvedValue({ cleared: true, broadcast: 'sent' });
      const scoped = createHandlers({
        reloadConfigCaches,
        hasConfigCapability: jest.fn(
          async (_user: unknown, section: string | null) => section != null,
        ),
      });
      const forbidden = mockRes();
      await scoped.handlers.reloadConfig(mockReq(), forbidden);
      const unconfigured = mockRes();
      await createHandlers({
        invalidateConfigCaches: jest.fn().mockResolvedValue(undefined),
      }).handlers.reloadConfig(mockReq(), unconfigured);

      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body).toEqual({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
      expect(reloadConfigCaches).not.toHaveBeenCalled();
      expect(unconfigured.statusCode).toBe(501);
    });

    it('answers 500 without echoing the failure, and audits nothing, when the reload throws', async () => {
      const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
      const { handlers } = createHandlers({
        reloadConfigCaches: jest.fn().mockRejectedValue(new Error('redis://secret@host down')),
        recordAuditEntry,
      });
      const res = mockRes();

      await handlers.reloadConfig(mockReq(), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to reload config' });
      expect(recordAuditEntry).not.toHaveBeenCalled();
    });
  });

  describe('updateConfigPriority', () => {
    const params = { principalType: 'role', principalId: 'editor' };
    const document = {
      _id: '64b000000000000000000001',
      principalType: 'role',
      principalId: 'editor',
      priority: 30,
      overrides: { webSearch: { serperApiKey: 'v3:cipher', serperApiKeyPreview: 'sk-...1234' } },
      tombstones: [],
      isActive: true,
      configVersion: 4,
    };

    it('rejects a bad principal type, priority or revision before touching anything', async () => {
      const setConfigPriority = jest.fn();
      const { handlers } = createHandlers({ setConfigPriority });
      const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
        [{ principalType: 'public', principalId: 'x' }, { priority: 1 }, 'INVALID_PRINCIPAL_TYPE'],
        [params, {}, 'INVALID_PRIORITY'],
        [params, { priority: -1 }, 'INVALID_PRIORITY'],
        [params, { priority: '3' }, 'INVALID_PRIORITY'],
        [params, { priority: 1, expectedRevision: 'nope' }, 'INVALID_EXPECTED_REVISION'],
      ];

      for (const [reqParams, body, code] of cases) {
        const res = mockRes();
        await handlers.updateConfigPriority(mockReq({ params: reqParams, body }), res);
        expect(res.statusCode).toBe(400);
        expect(res.body?.code).toBe(code);
      }
      expect(setConfigPriority).not.toHaveBeenCalled();
    });

    it('requires an authenticated broad manager', async () => {
      const setConfigPriority = jest.fn();
      const unauthenticated = mockRes();
      const { handlers } = createHandlers({ setConfigPriority });
      await handlers.updateConfigPriority(
        mockReq({ params, body: { priority: 1 }, user: undefined }),
        unauthenticated,
      );

      const sectionScoped = createHandlers({
        setConfigPriority,
        hasConfigCapability: jest.fn(async (_user: unknown, section: string | null) => !!section),
      });
      const forbidden = mockRes();
      await sectionScoped.handlers.updateConfigPriority(
        mockReq({ params, body: { priority: 1 } }),
        forbidden,
      );

      expect(unauthenticated.statusCode).toBe(401);
      expect(forbidden.statusCode).toBe(403);
      expect(setConfigPriority).not.toHaveBeenCalled();
    });

    it('answers 501 when the server did not wire the priority write', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.updateConfigPriority(mockReq({ params, body: { priority: 1 } }), res);

      expect(res.statusCode).toBe(501);
    });

    it('passes the revision through and redacts the stored secrets in the response', async () => {
      const setConfigPriority = jest
        .fn()
        .mockResolvedValue({ config: { ...document, priority: 5 }, changed: true });
      const { handlers } = createHandlers({ setConfigPriority });
      const res = mockRes();

      await handlers.updateConfigPriority(
        mockReq({ params, body: { priority: 5, expectedRevision: '64b000000000000000000001:4' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(setConfigPriority).toHaveBeenCalledWith('role', 'editor', 5, {
        expectedRevision: '64b000000000000000000001:4',
      });
      const config = res.body?.config as { overrides: { webSearch: Record<string, unknown> } };
      expect(config.overrides.webSearch.serperApiKey).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('v3:cipher');
    });

    it('answers 409 with the current revision when the precondition is stale', async () => {
      const setConfigPriority = jest
        .fn()
        .mockRejectedValue(new ConfigRevisionConflictError('64b000000000000000000001:5'));
      const { handlers } = createHandlers({ setConfigPriority });
      const res = mockRes();

      await handlers.updateConfigPriority(
        mockReq({ params, body: { priority: 5, expectedRevision: '64b000000000000000000001:4' } }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        error: 'Config was modified by another request',
        code: 'CONFIG_VERSION_CONFLICT',
        currentRevision: '64b000000000000000000001:5',
      });
    });
  });

  describe('principal existence on create', () => {
    const entry = { entries: [{ fieldPath: 'interface.customWelcome', value: 'hi' }] };

    it('does not look the principal up when its document already exists', async () => {
      const principalExists = jest.fn().mockResolvedValue(false);
      const { handlers } = createHandlers({
        principalExists,
        findConfigByPrincipal: jest.fn(async (_type: string, principalId: string) =>
          principalId === '__base__'
            ? null
            : { _id: '64b000000000000000000001', priority: 10, overrides: {}, configVersion: 1 },
        ),
      });
      const res = mockRes();

      await handlers.patchConfigField(
        mockReq({ params: { principalType: 'role', principalId: 'retired' }, body: entry }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(principalExists).not.toHaveBeenCalled();
    });

    it('never looks Base up, and refuses a principal the lookup does not find', async () => {
      const principalExists = jest.fn().mockResolvedValue(false);
      const { handlers } = createHandlers({ principalExists });

      const base = mockRes();
      await handlers.patchConfigField(
        mockReq({ params: { principalType: 'role', principalId: '__base__' }, body: entry }),
        base,
      );
      const group = mockRes();
      await handlers.patchConfigField(
        mockReq({
          params: { principalType: 'group', principalId: 'grp_engineering' },
          body: entry,
        }),
        group,
      );

      expect(base.statusCode).toBe(200);
      expect(group.statusCode).toBe(404);
      expect(group.body?.code).toBe('PRINCIPAL_NOT_FOUND');
      expect(principalExists).toHaveBeenCalledTimes(1);
      expect(principalExists).toHaveBeenCalledWith('group', 'grp_engineering');
    });
  });

  describe('create-only PUT', () => {
    it('writes an empty create-only request instead of answering it as a no-op', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.upsertConfigOverrides(
        mockReq({
          params: { principalType: 'user', principalId: '64b000000000000000000009' },
          body: { overrides: {}, expectedRevision: 'absent' },
        }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(deps.writeConfigDocument).toHaveBeenCalledWith(
        'user',
        '64b000000000000000000009',
        { principalModel: 'User', priority: 100, overrides: {}, tombstones: [], isActive: true },
        'absent',
      );
    });
  });
});
