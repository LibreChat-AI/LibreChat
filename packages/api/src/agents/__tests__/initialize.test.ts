/**
 * Stub `buildBashExecutionToolDescription` since the installed SDK version
 * may pre-date the export. Kept as a partial mock so `Providers` and the
 * rest of the namespace come through `jest.requireActual`.
 */
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  ReadFileToolDefinition: {
    name: 'read_file',
    description: 'read skill files using {skillName}/{filePath} and SKILL.md',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'For skill files: "{skillName}/{path}".',
        },
      },
    },
    responseFormat: 'content',
  },
  BashExecutionToolDefinition: {
    name: 'bash_tool',
    description: 'bash',
    schema: { type: 'object', properties: {} },
  },
  buildBashExecutionToolDescription: ({
    enableToolOutputReferences,
  }: {
    enableToolOutputReferences?: boolean;
  } = {}): string =>
    enableToolOutputReferences === true ? 'bash {{tool<idx>turn<turn>}}' : 'bash',
}));

import { Providers } from '@librechat/agents';
import { createHash } from 'node:crypto';
import { createRepositoryInstructionLoader } from '../../code/instructions';
import {
  Tools,
  Constants,
  ErrorTypes,
  Permissions,
  EModelEndpoint,
  EToolResources,
  FileContext,
  FileSources,
  PermissionTypes,
  AgentCapabilities,
  configSchema,
} from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { Agent, TFile } from 'librechat-data-provider';
import type { ServerRequest, InitializeResultBase, EndpointTokenConfig } from '~/types';
import type { InitializeAgentDbMethods } from '../initialize';
import type { CodeExecutionContext } from '../execution';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../initialize';

// Mock logger — `format` must be a callable factory so @librechat/data-schemas
// dist module-load completes cleanly; see api/test/__mocks__/logger.js.
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

const mockExtractLibreChatParams = jest.fn();
const mockGetModelMaxTokens = jest.fn();
const mockOptionalChainWithEmptyCheck = jest.fn();
const mockGetThreadData = jest.fn();

jest.mock('~/utils', () => ({
  extractLibreChatParams: (...args: unknown[]) => mockExtractLibreChatParams(...args),
  getModelMaxTokens: (...args: unknown[]) => mockGetModelMaxTokens(...args),
  optionalChainWithEmptyCheck: (...args: unknown[]) => mockOptionalChainWithEmptyCheck(...args),
  getThreadData: (...args: unknown[]) => mockGetThreadData(...args),
}));

const mockGetProviderConfig = jest.fn();
jest.mock('~/endpoints', () => ({
  getProviderConfig: (...args: unknown[]) => mockGetProviderConfig(...args),
}));

jest.mock('~/files', () => ({
  filterFilesByEndpointConfig: jest.fn(() => []),
  filterFilesByEndpointRuntimeConfig: jest.fn(() => []),
  isLegacyFileUploadUX: jest.fn(() => false),
}));

jest.mock('~/prompts', () => ({
  generateArtifactsPrompt: jest.fn(() => null),
}));

jest.mock('../resources', () => ({
  primeResources: jest.fn().mockResolvedValue({
    attachments: [],
    tool_resources: undefined,
  }),
}));

jest.mock('../../middleware/modelBoundContent', () => {
  const actual = jest.requireActual('../../middleware/modelBoundContent');
  /* Real by default; a single test overrides it to stand in for a policy that started
   * refusing a file after it was attached. */
  return {
    ...actual,
    assertModelBoundContent: jest.fn((...args: unknown[]) =>
      (actual as { assertModelBoundContent: (...a: unknown[]) => void }).assertModelBoundContent(
        ...args,
      ),
    ),
  };
});

import { initializeAgent } from '../initialize';
import { primeResources } from '../resources';
import { isFatalAgentInitializationError } from '../errors';

const realUtils = jest.requireActual<typeof import('~/utils')>('~/utils');

/**
 * Creates minimal mock objects for initializeAgent tests.
 *
 * @param overrides.overrideProvider - Simulates the value returned by `getProviderConfig`.
 *   Defaults to `provider` (native endpoint where no remapping occurs). Set to a different
 *   value (e.g. `Providers.OPENAI`) alongside a custom `provider` to simulate a custom
 *   endpoint whose provider is resolved to a built-in.
 * @param overrides.useRealTokenLookup - When true, `getModelMaxTokens` delegates to the real
 *   implementation so tests exercise actual token-map resolution. Otherwise a controlled
 *   `modelDefault` is returned.
 */
function createMocks(overrides?: {
  provider?: string;
  overrideProvider?: string;
  model?: string;
  maxContextTokens?: number;
  modelDefault?: number;
  maxOutputTokens?: number;
  endpointTokenConfig?: EndpointTokenConfig;
  useRealTokenLookup?: boolean;
  providerTools?: unknown[];
  loadedToolDefinitions?: Array<{
    name: string;
    description?: string;
    parameters?: object;
  }>;
  structuredTools?: unknown[];
}) {
  const {
    provider = Providers.OPENAI,
    overrideProvider,
    model = 'test-model',
    maxContextTokens,
    modelDefault = 200000,
    maxOutputTokens = 4096,
    endpointTokenConfig,
    useRealTokenLookup = false,
    providerTools,
    loadedToolDefinitions = [],
    structuredTools = [],
  } = overrides ?? {};

  const resolvedOverrideProvider = overrideProvider ?? provider;

  const agent = {
    id: 'agent-1',
    model,
    provider,
    tools: [],
    model_parameters: { model },
  } as unknown as Agent;

  const req = {
    user: { id: 'user-1' },
    config: {},
  } as unknown as ServerRequest;

  const res = {} as unknown as import('express').Response;

  const mockGetOptions = jest.fn().mockResolvedValue({
    llmConfig: { model, maxTokens: maxOutputTokens },
    endpointTokenConfig,
    ...(providerTools !== undefined ? { tools: providerTools } : {}),
  } satisfies InitializeResultBase);

  mockGetProviderConfig.mockReturnValue({
    getOptions: mockGetOptions,
    overrideProvider: resolvedOverrideProvider,
  });

  mockExtractLibreChatParams.mockReturnValue({
    resendFiles: false,
    maxContextTokens,
    modelOptions: { model },
  });

  if (useRealTokenLookup) {
    mockGetModelMaxTokens.mockImplementation(realUtils.getModelMaxTokens);
  } else {
    mockGetModelMaxTokens.mockReturnValue(modelDefault);
  }

  // Real implementation: treats 0 as a valid (non-empty) value — load-bearing for the maxContextTokens=0 test
  mockOptionalChainWithEmptyCheck.mockImplementation(realUtils.optionalChainWithEmptyCheck);

  const loadTools = jest.fn().mockResolvedValue({
    tools: structuredTools,
    toolContextMap: {},
    dynamicToolContextMap: {},
    userMCPAuthMap: undefined,
    toolRegistry: undefined,
    toolDefinitions: loadedToolDefinitions,
    hasDeferredTools: false,
  });

  const db: InitializeAgentDbMethods = {
    getFiles: jest.fn().mockResolvedValue([]),
    getConvoFiles: jest.fn().mockResolvedValue([]),
    updateFilesUsage: jest.fn().mockResolvedValue([]),
    getUserKey: jest.fn().mockResolvedValue('user-1'),
    getUserKeyValues: jest.fn().mockResolvedValue([]),
    getToolFilesByIds: jest.fn().mockResolvedValue([]),
  };

  return { agent, req, res, loadTools, db };
}

function countNamedWebSearchTools(tools: unknown[] | undefined): number {
  return (
    tools?.filter((tool) => {
      if (tool == null || typeof tool !== 'object') {
        return false;
      }
      const { name } = tool as { name?: unknown };
      return name === Tools.web_search;
    }).length ?? 0
  );
}

function countGoogleSearchTools(tools: unknown[] | undefined): number {
  return (
    tools?.filter((tool) => {
      if (tool == null || typeof tool !== 'object') {
        return false;
      }
      return 'googleSearch' in tool || 'googleSearchRetrieval' in tool;
    }).length ?? 0
  );
}

function countWebSearchDefinitions(toolDefinitions: Array<{ name: string }> | undefined): number {
  return (
    toolDefinitions?.filter((toolDefinition) => toolDefinition.name === Tools.web_search).length ??
    0
  );
}

function countUrlContextTools(tools: unknown[] | undefined): number {
  return (
    tools?.filter((tool) => tool != null && typeof tool === 'object' && 'urlContext' in tool)
      .length ?? 0
  );
}

describe('initializeAgent — execution context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['prefer', 'defer', 'off'] as const)(
    'uses saved repository instruction mode %s in definitions-only initialization',
    async (mode) => {
      const { agent, req, res, loadTools, db } = createMocks();
      agent.instructions = 'Agent conventions';
      agent.repositoryInstructions = mode;
      const content = 'Repository conventions';
      const authHeaders = jest.fn(async () => ({}));
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            operation: 'read_file',
            workspaceId: 'primary',
            path: 'AGENTS.md',
            content,
            startLine: 1,
            endLine: 1,
            truncated: false,
          }),
        ),
      );
      loadTools.mockResolvedValue({
        toolDefinitions: [],
        repositoryInstructionSource: {
          load: createRepositoryInstructionLoader(),
          enabled: true,
          principalId: `test-${mode}`,
          context: {
            environmentType: 'attached',
            baseUrl: 'https://code.example/v1',
            codeWorkspace: {
              workspaceId: 'primary',
              operations: ['read_file'],
              instructions: [
                {
                  path: 'AGENTS.md',
                  bytes: Buffer.byteLength(content),
                  sha256: createHash('sha256').update(content).digest('hex'),
                  truncated: false,
                },
              ],
            },
          },
          authHeaders,
        },
      });
      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([agent.provider]),
          isInitialAgent: true,
        },
        db,
      );
      if (mode === 'off') {
        expect(result.instructions).toBe('Agent conventions');
        expect(authHeaders).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } else {
        expect(result.instructions).toContain('Repository conventions');
        expect(result.instructions).toMatch(/^Agent conventions\n\nRepository-provided/);
        expect(result.instructions).toContain(
          mode === 'defer' ? 'unless they conflict' : 'prefer these instructions',
        );
      }
      expect(result.additional_instructions ?? '').not.toContain('Repository conventions');
      fetchSpy.mockRestore();
    },
  );

  it('carries request-resolved Azure identity to the run without changing persisted agent fields', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: EModelEndpoint.azureOpenAI,
      model: 'gpt-6-astra',
    });
    const azureOptions = {
      azureOpenAIApiKey: 'request-key',
      azureOpenAIApiInstanceName: 'request-instance',
      azureOpenAIApiDeploymentName: 'deployment',
      azureOpenAIApiVersion: '2024-10-21',
    };
    mockGetProviderConfig.mockReturnValue({
      overrideProvider: Providers.AZURE,
      getOptions: jest.fn().mockResolvedValue({
        azureOptions,
        llmConfig: {
          model: 'gpt-6-astra',
          useResponsesApi: true,
          apiKey: 'request-key',
          modelKwargs: { model: 'deployment' },
        },
      }),
    });
    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([EModelEndpoint.azureOpenAI]),
        isInitialAgent: true,
      },
      db,
    );
    expect(result.azureOptions).toEqual(azureOptions);
    expect(result.model_parameters).not.toHaveProperty('azureOpenAIApiInstanceName');
    expect(agent).not.toHaveProperty('azureOptions');
  });

  it('initializes without Express request or response objects', async () => {
    const { agent, loadTools, db } = createMocks();
    const previousReqDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'req');
    Object.defineProperty(globalThis, 'req', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const appConfig = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'request-free-stateful',
                name: 'Request-free stateful',
                type: 'attached',
                baseURL: 'https://stateful.example.com/v1',
              },
            ],
          },
        },
      },
    };

    try {
      await expect(
        initializeAgent(
          {
            runtime: {
              user: { id: 'user-1' } as never,
              appConfig: appConfig as never,
              requestBody: { timezone: 'America/New_York' },
              turnStartedAt: 1000,
            },
            agent,
            loadTools,
            endpointOption: { endpoint: EModelEndpoint.agents },
            allowedProviders: new Set([Providers.OPENAI]),
            isInitialAgent: true,
          },
          db,
        ),
      ).resolves.toBeDefined();
    } finally {
      if (previousReqDescriptor == null) {
        delete (globalThis as typeof globalThis & { req?: unknown }).req;
      } else {
        Object.defineProperty(globalThis, 'req', previousReqDescriptor);
      }
    }

    expect(loadTools).toHaveBeenCalledWith(expect.not.objectContaining({ req: expect.anything() }));
    expect(loadTools).toHaveBeenCalledWith(expect.not.objectContaining({ res: expect.anything() }));
  });
});

describe('initializeAgent — current content policy preflight', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a blocked stored definition before file, resource, tool, or provider side effects', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { primeResources } = jest.requireMock('../resources') as {
      primeResources: jest.Mock;
    };
    agent.instructions = 'Use PRIVATE-INSTRUCTIONS for every response';
    req.config = {
      filters: {
        agentInstructions: {
          pii: {
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      },
    } as unknown as ServerRequest['config'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestFiles: [{ file_id: 'file-1' } as IMongoFile],
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        error: 'content_filter_block',
        source: 'agent_instruction',
        field: 'instructions',
      },
    });

    expect(db.updateFilesUsage).not.toHaveBeenCalled();
    expect(primeResources).not.toHaveBeenCalled();
    expect(loadTools).not.toHaveBeenCalled();
    expect(mockGetProviderConfig).not.toHaveBeenCalled();
  });

  it('does not treat unresolved canonical file IDs as agent-definition text', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tool_resources = {
      [EToolResources.context]: {
        file_ids: ['canonical-file-1'],
      },
    };
    req.config = {
      filters: {
        files: {
          pii: {
            starterPatterns: ['sk_prefix'],
            uninspectable: 'block',
          },
        },
      },
    } as unknown as ServerRequest['config'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a blocked resolved skill before resource or provider side effects', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { primeResources } = jest.requireMock('../resources') as {
      primeResources: jest.Mock;
    };
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest.fn().mockResolvedValue({
      _id: skillId,
      name: 'private-skill',
      body: 'Follow PRIVATE-SKILL before answering',
      author: {
        toString: () => req.user?.id,
      } as unknown as import('mongoose').Types.ObjectId,
    });
    req.config = {
      filters: {
        skills: {
          pii: {
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      },
    } as unknown as ServerRequest['config'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestFiles: [{ file_id: 'file-1' } as IMongoFile],
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          accessibleSkillIds: [skillId],
          manualSkills: ['private-skill'],
        },
        { ...db, getSkillByName },
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        error: 'content_filter_block',
        source: 'skill',
        field: 'instructions',
      },
    });

    expect(getSkillByName).toHaveBeenCalled();
    expect(db.updateFilesUsage).not.toHaveBeenCalled();
    expect(primeResources).not.toHaveBeenCalled();
    expect(loadTools).not.toHaveBeenCalled();
    expect(mockGetProviderConfig).not.toHaveBeenCalled();
  });

  it('inspects only the deduped model-bound skill definition when manual invocation wins', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const author = {
      toString: () => req.user?.id,
    } as unknown as import('mongoose').Types.ObjectId;
    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest.fn().mockResolvedValue({
      _id: skillId,
      name: 'shared-skill',
      body: 'Safe manually selected instructions',
      author,
    });
    const listAlwaysApplySkills: InitializeAgentDbMethods['listAlwaysApplySkills'] = jest
      .fn()
      .mockResolvedValue({
        skills: [
          {
            _id: skillId,
            name: 'shared-skill',
            body: 'Discarded PRIVATE-SKILL definition',
            author,
          },
        ],
        has_more: false,
        after: null,
      });
    req.config = {
      filters: {
        skills: {
          pii: {
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      },
    } as unknown as ServerRequest['config'];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['shared-skill'],
      },
      {
        ...db,
        getSkillByName,
        listAlwaysApplySkills,
        listSkillsByAccess: async () => ({ skills: [], has_more: false, after: null }),
      },
    );

    expect(result.manualSkillPrimes).toEqual([
      expect.objectContaining({
        name: 'shared-skill',
        body: 'Safe manually selected instructions',
      }),
    ]);
    expect(result.alwaysApplySkillPrimes).toEqual([]);
  });

  it('does not traverse resolved skill metadata when skill policy is inactive', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const broadFrontmatter = Object.fromEntries(
      Array.from({ length: 4_200 }, (_, index) => [`field-${index}`, `value-${index}`]),
    );
    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest.fn().mockResolvedValue({
      _id: skillId,
      name: 'broad-skill',
      body: 'Safe instructions',
      frontmatter: broadFrontmatter,
      author: { toString: () => req.user?.id } as unknown as import('mongoose').Types.ObjectId,
    });
    req.config = {
      filters: {
        messages: { pii: { starterPatterns: ['sk_prefix'] } },
      },
    } as unknown as ServerRequest['config'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          accessibleSkillIds: [skillId],
          manualSkills: ['broad-skill'],
        },
        { ...db, getSkillByName },
      ),
    ).resolves.toBeDefined();
  });

  it('fails closed on traversal only when the affected skill field is selected', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest.fn().mockResolvedValue({
      _id: skillId,
      name: 'broad-skill',
      body: 'Safe instructions',
      frontmatter: Object.fromEntries(
        Array.from({ length: 4_200 }, (_, index) => [`field-${index}`, `value-${index}`]),
      ),
      author: { toString: () => req.user?.id } as unknown as import('mongoose').Types.ObjectId,
    });
    req.config = {
      filters: {
        skills: {
          pii: {
            fields: ['frontmatter'],
            starterPatterns: ['sk_prefix'],
          },
        },
      },
    } as unknown as ServerRequest['config'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          accessibleSkillIds: [skillId],
          manualSkills: ['broad-skill'],
        },
        { ...db, getSkillByName },
      ),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
  });

  it('rejects blocked active skill-catalog metadata before resource or provider side effects', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { primeResources } = jest.requireMock('../resources') as {
      primeResources: jest.Mock;
    };
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const listSkillsByAccess: InitializeAgentDbMethods['listSkillsByAccess'] = jest
      .fn()
      .mockResolvedValue({
        skills: [
          {
            _id: skillId,
            name: 'catalog-skill',
            description: 'Use PRIVATE-CATALOG data',
            author: {
              toString: () => req.user?.id,
            } as unknown as import('mongoose').Types.ObjectId,
          },
        ],
        has_more: false,
        after: null,
      });
    req.config = {
      filters: {
        skills: {
          pii: {
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      },
    } as unknown as ServerRequest['config'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestFiles: [{ file_id: 'file-1' } as IMongoFile],
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          accessibleSkillIds: [skillId],
        },
        { ...db, listSkillsByAccess },
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        error: 'content_filter_block',
        source: 'skill',
        field: 'description',
      },
    });

    expect(listSkillsByAccess).toHaveBeenCalledTimes(1);
    expect(db.updateFilesUsage).not.toHaveBeenCalled();
    expect(primeResources).not.toHaveBeenCalled();
    expect(loadTools).not.toHaveBeenCalled();
    expect(mockGetProviderConfig).not.toHaveBeenCalled();
  });

  it('reuses a safe inspected skill-catalog snapshot during initialization', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const listSkillsByAccess: InitializeAgentDbMethods['listSkillsByAccess'] = jest
      .fn()
      .mockResolvedValue({
        skills: [
          {
            _id: skillId,
            name: 'safe-skill',
            description: 'Safe catalog description',
            author: {
              toString: () => req.user?.id,
            } as unknown as import('mongoose').Types.ObjectId,
          },
        ],
        has_more: false,
        after: null,
      });
    req.config = {
      filters: {
        skills: {
          pii: {
            starterPatterns: ['sk_prefix'],
          },
        },
      },
    } as unknown as ServerRequest['config'];

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
      },
      { ...db, listSkillsByAccess },
    );

    expect(listSkillsByAccess).toHaveBeenCalledTimes(1);
  });
});

describe('initializeAgent — custom provider token lookup', () => {
  const CUSTOM_PROVIDER = 'EduGPT';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the resolved provider endpoint to getModelMaxTokens, not the custom name', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: CUSTOM_PROVIDER,
      overrideProvider: Providers.OPENAI,
      model: 'qwen3-235b-a22b',
      useRealTokenLookup: true,
    });

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([CUSTOM_PROVIDER]),
        isInitialAgent: true,
      },
      db,
    );

    // providerEndpointMap["openAI"] = "openAI" (valid), not providerEndpointMap["EduGPT"] = undefined
    expect(mockGetModelMaxTokens).toHaveBeenCalledWith(
      'qwen3-235b-a22b',
      EModelEndpoint.openAI,
      undefined,
    );
  });

  it('uses endpointTokenConfig from the custom endpoint for unrecognized models', async () => {
    const customTokenConfig: EndpointTokenConfig = {
      'my-custom-model-v1': { context: 65536, prompt: 1, completion: 1 },
    };
    const { agent, req, res, loadTools, db } = createMocks({
      provider: CUSTOM_PROVIDER,
      overrideProvider: Providers.OPENAI,
      model: 'my-custom-model-v1',
      endpointTokenConfig: customTokenConfig,
      useRealTokenLookup: true,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([CUSTOM_PROVIDER]),
        isInitialAgent: true,
      },
      db,
    );

    expect(mockGetModelMaxTokens).toHaveBeenCalledWith(
      'my-custom-model-v1',
      EModelEndpoint.openAI,
      customTokenConfig,
    );

    // Pipeline check: verifies endpointTokenConfig.context flows through the full
    // optionalChainWithEmptyCheck → Math.max formula. The toHaveBeenCalledWith
    // assertion above catches the actual provider-resolution regression.
    expect(result.maxContextTokens).toBe(Math.round((65536 - 4096) * 0.95));
  });
});

describe('initializeAgent — provider web_search precedence', () => {
  const nativeWebSearchTool = {
    type: 'web_search_20250305',
    name: Tools.web_search,
  };
  const nativeGoogleSearchTool = { googleSearch: {} };
  const libreChatWebSearchDefinition = {
    name: Tools.web_search,
    description: 'Search the web',
    parameters: { type: 'object', properties: {} },
  };
  const mcpToolDefinition = {
    name: 'mcp_lookup',
    description: 'Lookup context',
    parameters: { type: 'object', properties: {} },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function initializeGoogleMixedToolAgent(model: string, provider = Providers.GOOGLE) {
    const { agent, req, res, loadTools, db } = createMocks({
      provider,
      model,
      providerTools: [nativeGoogleSearchTool],
      loadedToolDefinitions: [mcpToolDefinition],
    });
    agent.tools = ['mcp_lookup'];

    return initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([provider]),
        isInitialAgent: true,
      },
      db,
    );
  }

  it('keeps Anthropic native web_search when LibreChat search is not selected', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.ANTHROPIC,
      providerTools: [nativeWebSearchTool],
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.ANTHROPIC]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([nativeWebSearchTool]);
    expect(countNamedWebSearchTools(result.tools)).toBe(1);
    expect(countWebSearchDefinitions(result.toolDefinitions)).toBe(0);
  });

  it('keeps LibreChat web_search definitions when native Anthropic search is not enabled', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.ANTHROPIC,
      loadedToolDefinitions: [libreChatWebSearchDefinition],
    });
    agent.tools = [Tools.web_search];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.ANTHROPIC]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([]);
    expect(countNamedWebSearchTools(result.tools)).toBe(0);
    expect(countWebSearchDefinitions(result.toolDefinitions)).toBe(1);
  });

  it('prefers LibreChat web_search when Anthropic native search is also enabled', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.ANTHROPIC,
      providerTools: [nativeWebSearchTool],
      loadedToolDefinitions: [libreChatWebSearchDefinition],
    });
    agent.tools = [Tools.web_search];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.ANTHROPIC]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([]);
    expect(countNamedWebSearchTools(result.tools)).toBe(0);
    expect(countWebSearchDefinitions(result.toolDefinitions)).toBe(1);
  });

  it('keeps Google native search when LibreChat web_search is not selected', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      model: 'gemini-3.5-flash',
      providerTools: [nativeGoogleSearchTool],
      loadedToolDefinitions: [mcpToolDefinition],
    });
    agent.tools = ['mcp_lookup'];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.GOOGLE]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([nativeGoogleSearchTool]);
    expect(countGoogleSearchTools(result.tools)).toBe(1);
    expect(result.toolDefinitions).toContain(mcpToolDefinition);
    expect(result.model_parameters).toEqual(
      expect.objectContaining({
        includeServerSideToolInvocations: true,
      }),
    );
  });

  it('includes the mixed-tool flag for Vertex AI native search with external tools', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.VERTEXAI,
      model: 'gemini-3.5-flash',
      providerTools: [nativeGoogleSearchTool],
      loadedToolDefinitions: [mcpToolDefinition],
    });
    agent.tools = ['mcp_lookup'];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.VERTEXAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([nativeGoogleSearchTool]);
    expect(result.toolDefinitions).toContain(mcpToolDefinition);
    expect(result.model_parameters).toEqual(
      expect.objectContaining({
        includeServerSideToolInvocations: true,
      }),
    );
  });

  it.each([
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
    'gemini-3.5-flash',
    'google/gemini-3.5-flash-latest',
    'models/gemini-3.10-pro-preview',
    'gemini-4-pro-preview',
  ])('allows Google mixed tools for supported Gemini text model %s', async (model) => {
    const result = await initializeGoogleMixedToolAgent(model);

    expect(result.tools).toEqual([nativeGoogleSearchTool]);
    expect(result.toolDefinitions).toContain(mcpToolDefinition);
    expect(result.model_parameters).toEqual(
      expect.objectContaining({
        includeServerSideToolInvocations: true,
      }),
    );
  });

  it('sets the mixed-tool flag when the skill catalog adds the external tool', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      model: 'gemini-3.5-flash',
      providerTools: [nativeGoogleSearchTool],
    });
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const author = {
      toString: () => req.user?.id,
    } as unknown as import('mongoose').Types.ObjectId;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.GOOGLE]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
      },
      {
        ...db,
        listSkillsByAccess: jest.fn().mockResolvedValue({
          skills: [
            {
              _id: skillId,
              name: 'research-helper',
              description: 'Research current information.',
              author,
            },
          ],
          has_more: false,
          after: null,
        }),
      },
    );

    expect(result.tools).toEqual([nativeGoogleSearchTool]);
    expect(result.toolDefinitions?.map((toolDefinition) => toolDefinition.name)).toContain('skill');
    expect(result.model_parameters).toEqual(
      expect.objectContaining({
        includeServerSideToolInvocations: true,
      }),
    );
  });

  it.each([
    'gemini-2.5-flash',
    'gemini-3',
    'gemini-3.1',
    'gemini-3-pro-image-preview',
    'gemini-3.1-flash-image',
    'gemini-3.5-flash-live',
    'gemini-4-pro-tts',
  ])('rejects Google mixed tools for unsupported Gemini model %s', async (model) => {
    await expect(initializeGoogleMixedToolAgent(model)).rejects.toThrow(/google_tool_conflict/);
  });

  it('prefers LibreChat web_search when Google native search is also enabled', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      providerTools: [nativeGoogleSearchTool],
      loadedToolDefinitions: [libreChatWebSearchDefinition],
    });
    agent.tools = [Tools.web_search];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.GOOGLE]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([]);
    expect(countGoogleSearchTools(result.tools)).toBe(0);
    expect(countWebSearchDefinitions(result.toolDefinitions)).toBe(1);
  });

  it('leaves providers without a native web search conflict unchanged', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.OPENAI,
      providerTools: [nativeWebSearchTool],
      loadedToolDefinitions: [libreChatWebSearchDefinition],
    });
    agent.tools = [Tools.web_search];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([nativeWebSearchTool]);
    expect(countNamedWebSearchTools(result.tools)).toBe(1);
    expect(countWebSearchDefinitions(result.toolDefinitions)).toBe(1);
  });

  it('treats the Google urlContext tool as a native provider tool', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      model: 'gemini-1.5-flash',
      providerTools: [{ urlContext: {} }],
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.GOOGLE]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([{ urlContext: {} }]);
    expect(countUrlContextTools(result.tools)).toBe(1);
  });

  it('preserves the Google urlContext tool when LibreChat web_search is also enabled', async () => {
    /**
     * url_context is unrelated to web search, so the LibreChat web_search conflict
     * resolver must not strip the native urlContext tool. The combination of a
     * provider tool with an agent tool requires a combination-capable Gemini model.
     */
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      model: 'gemini-3.5-flash',
      providerTools: [{ urlContext: {} }],
      loadedToolDefinitions: [libreChatWebSearchDefinition],
    });
    agent.tools = [Tools.web_search];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.GOOGLE]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.tools).toEqual([{ urlContext: {} }]);
    expect(countUrlContextTools(result.tools)).toBe(1);
    expect(countWebSearchDefinitions(result.toolDefinitions)).toBe(1);
  });
});

describe('initializeAgent — stable and dynamic instruction fields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('moves instructions with temporal special vars into the dynamic tail using the turn start', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.instructions =
      'Today is {{current_date}}. The turn began at {{current_datetime}} ({{iso_datetime}}).';
    req.conversationCreatedAt = '2026-08-25T10:00:00.000Z';
    req.turnStartedAt = new Date('2026-08-31T06:20:00.000Z').getTime();
    req.body = { timezone: 'UTC' };

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.instructions).toBeUndefined();
    expect(result.additional_instructions).toBe(
      'Today is 2026-08-31 (Monday). The turn began at 2026-08-31 06:20:00 +00:00 (Monday) (2026-08-31T06:20:00.000Z).',
    );
  });

  it('resolves temporal special vars in the request timezone', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.instructions = 'It is currently {{current_datetime}}.';
    req.turnStartedAt = new Date('2024-01-15T18:30:00.000Z').getTime();
    req.body = { timezone: 'America/New_York' };

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.instructions).toBeUndefined();
    expect(result.additional_instructions).toBe(
      'It is currently 2024-01-15 13:30:00 -05:00 (Monday).',
    );
  });

  it('keeps non-temporal special vars in stable instructions', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.instructions = 'You are helping {{current_user}}.';
    req.user = { id: 'user-1', name: 'Test User' } as never;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.instructions).toBe('You are helping Test User.');
    expect(result.additional_instructions).toBeUndefined();
  });

  it('appends generated artifact guidance without replacing existing dynamic instructions', async () => {
    const { generateArtifactsPrompt } = jest.requireMock('~/prompts') as {
      generateArtifactsPrompt: jest.Mock;
    };
    generateArtifactsPrompt.mockReturnValue('Artifact guidance');

    const { agent, req, res, loadTools, db } = createMocks();
    agent.additional_instructions = 'Existing dynamic';
    agent.artifacts = 'enabled' as never;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.additional_instructions).toBe('Existing dynamic\n\nArtifact guidance');
  });
});

describe('initializeAgent — attachment scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps request attachments separate from agent context attachments', async () => {
    const { primeResources } = jest.requireMock('../resources') as {
      primeResources: jest.Mock;
    };
    const requestFile = { file_id: 'request-file', filename: 'request.txt' };
    const agentContextFile = { file_id: 'agent-context-file', filename: 'agent-context.txt' };
    primeResources.mockResolvedValueOnce({
      attachments: [agentContextFile, requestFile],
      requestAttachments: [requestFile],
      agentContextAttachments: [agentContextFile],
      tool_resources: undefined,
    });

    const { agent, req, res, loadTools, db } = createMocks();

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.attachments).toEqual([agentContextFile, requestFile]);
    expect(result.requestAttachments).toEqual([requestFile]);
    expect(result.agentContextAttachments).toEqual([agentContextFile]);
  });

  it('applies aggregate limits only to endpoint-compatible file survivors', async () => {
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const incompatibleFiles = Array.from({ length: 11 }, (_, index) => ({
      file_id: `incompatible-${index}`,
      filename: `incompatible-${index}.bin`,
      type: 'application/x-incompatible',
      bytes: 1024,
    })) as IMongoFile[];
    const { agent, req, res, loadTools, db } = createMocks();
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: true,
      maxContextTokens: undefined,
      modelOptions: { model: agent.model },
    });
    (db.getFiles as jest.Mock).mockResolvedValueOnce(incompatibleFiles);
    filterFilesByEndpointRuntimeConfig.mockReturnValueOnce([]);

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestFiles: incompatibleFiles,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      ),
    ).resolves.toBeDefined();
    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      req.config,
      expect.objectContaining({ files: incompatibleFiles }),
    );
  });

  it('does not apply model attachment limits to tool-only workspace files', async () => {
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const toolFiles = Array.from({ length: 11 }, (_, index) => ({
      file_id: `tool-${index}`,
      filename: `tool-${index}.txt`,
      type: 'text/plain',
      bytes: 1024,
    })) as IMongoFile[];
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [EToolResources.file_search];
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: true,
      maxContextTokens: undefined,
      modelOptions: { model: agent.model },
    });
    (db.getConvoFiles as jest.Mock).mockResolvedValueOnce(toolFiles.map((file) => file.file_id));
    (db.getToolFilesByIds as jest.Mock).mockResolvedValueOnce(toolFiles);
    (db.getFiles as jest.Mock).mockResolvedValueOnce(toolFiles);
    filterFilesByEndpointRuntimeConfig.mockImplementationOnce(
      (_config: ServerRequest['config'], { files }: { files: IMongoFile[] }) => files,
    );

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          conversationId: 'conversation-1',
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      ),
    ).resolves.toBeDefined();
  });

  it('does not apply model attachment limits to a tool-only current request file', async () => {
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const toolOnlyRequestFile = {
      file_id: 'request-tool-only',
      filename: 'workspace.bin',
      type: 'application/octet-stream',
      bytes: 200 * 1024 * 1024,
      embedded: true,
    } as IMongoFile;
    const { agent, req, res, loadTools, db } = createMocks();
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: true,
      maxContextTokens: undefined,
      modelOptions: { model: agent.model },
    });
    (db.getFiles as jest.Mock).mockResolvedValueOnce([toolOnlyRequestFile]);
    filterFilesByEndpointRuntimeConfig.mockImplementationOnce(
      (_config: ServerRequest['config'], { files }: { files: IMongoFile[] }) => files,
    );

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestFiles: [toolOnlyRequestFile],
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      ),
    ).resolves.toBeDefined();
  });

  it('owner-scopes request file usage updates while preserving trusted tool files', async () => {
    const { primeResources } = jest.requireMock('../resources') as {
      primeResources: jest.Mock;
    };
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const requestFile = { file_id: 'request-file', filename: 'request.txt' } as IMongoFile;
    const toolFile = { file_id: 'tool-file', filename: 'tool.txt' } as IMongoFile;
    const { agent, req, res, loadTools, db } = createMocks();

    agent.tools = [EToolResources.file_search];
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: true,
      maxContextTokens: undefined,
      modelOptions: { model: agent.model },
    });
    (db.getFiles as jest.Mock).mockResolvedValueOnce([requestFile, toolFile]);
    (db.getConvoFiles as jest.Mock).mockResolvedValueOnce([toolFile.file_id]);
    (db.getToolFilesByIds as jest.Mock).mockResolvedValueOnce([toolFile]);
    (db.updateFilesUsage as jest.Mock)
      .mockResolvedValueOnce([{ ...requestFile, filename: 'post-mutation-request.txt' }])
      .mockResolvedValueOnce([{ ...toolFile, filename: 'post-mutation-tool.txt' }]);
    filterFilesByEndpointRuntimeConfig.mockImplementationOnce(
      (_req: ServerRequest, { files }: { files: IMongoFile[] }) => files,
    );

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestFiles: [requestFile],
        conversationId: 'conversation-1',
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(db.getToolFilesByIds).toHaveBeenCalledWith(
      [toolFile.file_id],
      new Set([EToolResources.file_search]),
      { userId: 'user-1', tenantId: undefined },
    );
    expect(db.getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: [requestFile.file_id, toolFile.file_id] },
        user: 'user-1',
      },
      {},
      {},
    );
    expect(db.updateFilesUsage).toHaveBeenNthCalledWith(1, [requestFile], undefined, {
      user: 'user-1',
      tenantId: undefined,
    });
    expect(db.updateFilesUsage).toHaveBeenNthCalledWith(2, [toolFile], undefined, {
      user: 'user-1',
      tenantId: undefined,
    });
    await expect(primeResources.mock.calls[0][0].attachments).resolves.toEqual([
      requestFile,
      toolFile,
    ]);
  });

  it('rejects blocked resent file content before usage mutation or resource priming', async () => {
    const { primeResources } = jest.requireMock('../resources') as {
      primeResources: jest.Mock;
    };
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const blockedFile = {
      file_id: 'blocked-file',
      filename: 'stored.txt',
      text: 'PRIVATE-FILE',
    } as IMongoFile;
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [EToolResources.file_search];
    req.config = {
      filters: {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private',
                label: 'private value',
                regex: 'PRIVATE-[A-Z]+',
              },
            ],
          },
        },
      },
    } as unknown as ServerRequest['config'];
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: true,
      maxContextTokens: undefined,
      modelOptions: { model: agent.model },
    });
    (db.getConvoFiles as jest.Mock).mockResolvedValueOnce([blockedFile.file_id]);
    (db.getToolFilesByIds as jest.Mock).mockResolvedValueOnce([blockedFile]);
    (db.getFiles as jest.Mock).mockResolvedValueOnce([blockedFile]);
    filterFilesByEndpointRuntimeConfig.mockImplementationOnce(
      (_req: ServerRequest, { files }: { files: IMongoFile[] }) => files,
    );

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          conversationId: 'conversation-1',
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: {
        error: 'content_filter_block',
        source: 'file',
        field: 'extracted_text',
      },
    });

    expect(db.updateFilesUsage).not.toHaveBeenCalled();
    expect(primeResources).not.toHaveBeenCalled();
    expect(loadTools).not.toHaveBeenCalled();
    expect(mockGetProviderConfig).toHaveBeenCalledTimes(1);
  });
});

describe('initializeAgent — maxContextTokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(['us.openai.gpt-6-sol', 'global.openai.gpt-6-astra', 'us.openai.gpt-5.6-terra'])(
    'budgets %s using the Bedrock context window',
    async (model) => {
      const { agent, req, res, loadTools, db } = createMocks({
        provider: Providers.BEDROCK,
        model,
        maxOutputTokens: 4096,
        useRealTokenLookup: true,
      });

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.BEDROCK]),
          isInitialAgent: true,
        },
        db,
      );

      expect(mockGetModelMaxTokens).toHaveBeenCalledWith(model, EModelEndpoint.bedrock, undefined);
      expect(result.maxContextTokens).toBe(Math.round((950000 - 4096) * 0.95));
      expect(result.maxContextTokens).toBeGreaterThan(38079);
    },
  );

  it('uses user-configured maxContextTokens when provided via model_parameters', async () => {
    const userValue = 50000;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: userValue,
      modelDefault: 200000,
      maxOutputTokens: 4096,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: userValue },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.maxContextTokens).toBe(userValue);
  });

  it('falls back to formula when maxContextTokens is NOT provided', async () => {
    const modelDefault = 200000;
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: undefined,
      modelDefault,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    const expected = Math.round((modelDefault - maxOutputTokens) * 0.95);
    expect(result.maxContextTokens).toBe(expected);
  });

  it('falls back to formula when maxContextTokens is 0', async () => {
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: 0,
      modelDefault: 200000,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: 0 },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.maxContextTokens).not.toBe(0);
    const expected = Math.round((DEFAULT_MAX_CONTEXT_TOKENS - maxOutputTokens) * 0.95);
    expect(result.maxContextTokens).toBe(expected);
  });

  it('falls back to formula when maxContextTokens is negative', async () => {
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: -1,
      modelDefault: 200000,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: -1 },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    // -1 is not used as-is; the formula kicks in
    expect(result.maxContextTokens).not.toBe(-1);
  });

  it('preserves small user-configured value (e.g. 1000 from modelSpec)', async () => {
    const userValue = 1000;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: userValue,
      modelDefault: 128000,
      maxOutputTokens: 4096,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: {
          endpoint: EModelEndpoint.agents,
          model_parameters: { maxContextTokens: userValue },
        },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    // Should NOT be overridden to Math.round((128000 - 4096) * 0.95) = 117,709
    expect(result.maxContextTokens).toBe(userValue);
  });

  it('sets baseContextTokens to agentMaxContextNum minus maxOutputTokensNum', async () => {
    const modelDefault = 200000;
    const maxOutputTokens = 4096;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: undefined,
      modelDefault,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.baseContextTokens).toBe(modelDefault - maxOutputTokens);
  });

  it('clamps maxContextTokens to at least 1024 for tiny models', async () => {
    const modelDefault = 1100;
    const maxOutputTokens = 1050;
    const { agent, req, res, loadTools, db } = createMocks({
      maxContextTokens: undefined,
      modelDefault,
      maxOutputTokens,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    // baseContextTokens = 1100 - 1050 = 50, formula would give ~47.5 rounded
    // but Math.max(1024, ...) clamps it
    expect(result.maxContextTokens).toBe(1024);
  });
});

describe('initializeAgent — manual skill priming (Phase 3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Minimal listSkillsByAccess that satisfies `injectSkillCatalog` so the
   * manualSkills resolver branch runs. Returns an empty page — we don't care
   * about the catalog here, only that `accessibleSkillIds` is non-empty so
   * the manual-invocation block gets reached.
   */
  const emptyListSkillsByAccess: InitializeAgentDbMethods['listSkillsByAccess'] = async () => ({
    skills: [],
    has_more: false,
    after: null,
  });

  it('attaches resolved manual skill primes to the initialized agent', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    /**
     * Ownership-based active-state default only kicks in when
     * `skill.author.toString() === userId`. The default mock user id is a
     * literal string, not an ObjectId, so align the skill author with it so
     * `resolveSkillActive` treats the skill as owned and active.
     */
    const ownerAuthor = {
      toString: () => req.user?.id,
    } as unknown as import('mongoose').Types.ObjectId;

    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest.fn().mockResolvedValue({
      _id: skillId,
      name: 'brand-guidelines',
      body: '# Brand guidelines\nUse blue.',
      author: ownerAuthor,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['brand-guidelines'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    expect(result.manualSkillPrimes).toEqual([
      { _id: skillId, name: 'brand-guidelines', body: '# Brand guidelines\nUse blue.' },
    ]);
    /* `preferUserInvocable` keeps name-collision lookups consistent with
       the popover for manual paths — model-only (`userInvocable: false`)
       duplicates can't shadow the user-invocable doc the user picked. */
    expect(getSkillByName).toHaveBeenCalledWith('brand-guidelines', [skillId], {
      preferUserInvocable: true,
    });
  });

  it('leaves manualSkillPrimes undefined when no manualSkills are provided', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess },
    );

    expect(result.manualSkillPrimes).toBeUndefined();
  });

  it('returns empty array when every manual skill is unresolvable (no primes, no throw)', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest
      .fn()
      .mockResolvedValue(null);

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['does-not-exist'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    expect(result.manualSkillPrimes).toEqual([]);
  });

  it('skips resolution entirely when accessibleSkillIds is empty (user has no skill access)', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const getSkillByName: InitializeAgentDbMethods['getSkillByName'] = jest.fn();

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [],
        manualSkills: ['anything'],
      },
      { ...db, getSkillByName },
    );

    expect(result.manualSkillPrimes).toBeUndefined();
    expect(getSkillByName).not.toHaveBeenCalled();
  });

  it('silently no-ops when getSkillByName is not provided in db methods', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['foo'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess },
    );

    expect(result.manualSkillPrimes).toBeUndefined();
  });
});

describe('initializeAgent — skill `allowed-tools` union (Phase 6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Same minimal pager used in the Phase 3 suite — the catalog isn't what
   * we're exercising; we just need accessibleSkillIds to be non-empty so the
   * resolver path runs.
   */
  const emptyListSkillsByAccess: InitializeAgentDbMethods['listSkillsByAccess'] = async () => ({
    skills: [],
    has_more: false,
    after: null,
  });

  /** Helper: build a getSkillByName that returns a single skill with allowedTools. */
  const buildGetSkillByName = (
    name: string,
    allowedTools: string[] | undefined,
    skillId: import('mongoose').Types.ObjectId,
    userId: string,
  ): InitializeAgentDbMethods['getSkillByName'] =>
    jest.fn().mockResolvedValue({
      _id: skillId,
      name,
      body: `body of ${name}`,
      author: { toString: () => userId } as unknown as import('mongoose').Types.ObjectId,
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    });

  it('passes the union of agent.tools + allowed-tools to loadTools and merges resulting toolDefinitions', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    /* Mock loadTools to echo back what was requested as toolDefinitions —
       lets the test assert both the input list and the output merge. */
    loadTools.mockImplementation(async ({ tools }: { tools: string[] }) => ({
      tools: [],
      toolContextMap: {},
      userMCPAuthMap: undefined,
      toolRegistry: undefined,
      toolDefinitions: tools.map((name: string) => ({ name, description: '', parameters: {} })),
      hasDeferredTools: false,
      actionsEnabled: undefined,
    }));

    const getSkillByName = buildGetSkillByName(
      'tool-skill',
      ['execute_code', 'read_file'],
      skillId,
      req.user!.id,
    );

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['tool-skill'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    /* Single loadTools call with the union — agent.tools + extras, dedup
       not needed because unionPrimeAllowedTools already excluded
       agent-baseline names. Order: agent first, then extras. */
    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search', 'execute_code', 'read_file']);

    /* All three tools should appear in the merged toolDefinitions. */
    const definedNames = result.toolDefinitions?.map((d) => d.name) ?? [];
    expect(definedNames).toEqual(
      expect.arrayContaining(['web_search', 'execute_code', 'read_file']),
    );
  });

  it('does not call loadTools twice when the skill declares no allowed-tools', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    const getSkillByName = buildGetSkillByName('plain', undefined, skillId, req.user!.id);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['plain'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search']);
  });

  it('skips extras already on the agent (agent baseline wins; no double-loading)', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search', 'execute_code'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    const getSkillByName = buildGetSkillByName(
      'overlap',
      ['web_search', 'read_file'], // web_search overlaps; read_file is new
      skillId,
      req.user!.id,
    );

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['overlap'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    /* web_search is on the agent — not duplicated; only read_file is "extra". */
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search', 'execute_code', 'read_file']);
  });

  it('retries loadTools without extras when the union call returns undefined (production loaders swallow errors)', async () => {
    /* Production loaders (`createToolLoader` in `initialize.js`,
       `openai.js`, `responses.js`) wrap `loadAgentTools` in try/catch
       and return `undefined` on failure. Without explicit handling we'd
       fall through to the empty fallback and silently drop the agent's
       baseline tools. This test pins the retry-on-undefined behavior. */
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    let call = 0;
    loadTools.mockImplementation(async ({ tools }: { tools: string[] }) => {
      call += 1;
      if (call === 1) {
        return undefined; // simulate swallowed error in createToolLoader
      }
      return {
        tools: [],
        toolContextMap: {},
        userMCPAuthMap: undefined,
        toolRegistry: undefined,
        toolDefinitions: tools.map((name) => ({ name, description: '', parameters: {} })),
        hasDeferredTools: false,
        actionsEnabled: undefined,
      };
    });

    const getSkillByName = buildGetSkillByName(
      'silent-fail-skill',
      ['mcp__broken__tool'],
      skillId,
      req.user!.id,
    );

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['silent-fail-skill'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    /* Two calls: union first (returned undefined → silent fail), then
       base-only retry (succeeded). Agent's web_search survives. */
    expect(loadTools).toHaveBeenCalledTimes(2);
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search', 'mcp__broken__tool']);
    expect(loadTools.mock.calls[1][0].tools).toEqual(['web_search']);

    const definedNames = result.toolDefinitions?.map((d) => d.name) ?? [];
    expect(definedNames).toContain('web_search');
    expect(definedNames).not.toContain('mcp__broken__tool');
  });

  it('retries loadTools without extras when the union call throws (agent tools must still load)', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    /* First call (with extras) fails; second call (without extras) succeeds. */
    let call = 0;
    loadTools.mockImplementation(async ({ tools }: { tools: string[] }) => {
      call += 1;
      if (call === 1) {
        throw new Error('MCP connection failed for skill-added tool');
      }
      return {
        tools: [],
        toolContextMap: {},
        userMCPAuthMap: undefined,
        toolRegistry: undefined,
        toolDefinitions: tools.map((name) => ({ name, description: '', parameters: {} })),
        hasDeferredTools: false,
        actionsEnabled: undefined,
      };
    });

    const getSkillByName = buildGetSkillByName(
      'bad-tool-skill',
      ['mcp__broken__tool'],
      skillId,
      req.user!.id,
    );

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['bad-tool-skill'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    /* Two calls: union first (threw), then base-only retry (succeeded). */
    expect(loadTools).toHaveBeenCalledTimes(2);
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search', 'mcp__broken__tool']);
    expect(loadTools.mock.calls[1][0].tools).toEqual(['web_search']);

    /* Agent's own tool survives; the broken extra is silently dropped. */
    const definedNames = result.toolDefinitions?.map((d) => d.name) ?? [];
    expect(definedNames).toContain('web_search');
    expect(definedNames).not.toContain('mcp__broken__tool');
  });

  it.each([
    ['Error', new Error('run cancelled')],
    ['string', 'run cancelled'],
  ])(
    'does not retry skill-added tools when the owning signal aborts with an %s reason',
    async (_, reason) => {
      const { agent, req, res, loadTools, db } = createMocks();
      agent.tools = ['web_search'];
      const { Types } = await import('mongoose');
      const skillId = new Types.ObjectId();
      const controller = new AbortController();
      controller.abort(reason);
      loadTools.mockRejectedValue(reason);

      const getSkillByName = buildGetSkillByName(
        'cancelled-tool-skill',
        ['mcp__warehouse__query'],
        skillId,
        req.user!.id,
      );

      await expect(
        initializeAgent(
          {
            req,
            res,
            agent,
            loadTools,
            signal: controller.signal,
            endpointOption: { endpoint: EModelEndpoint.agents },
            allowedProviders: new Set([Providers.OPENAI]),
            isInitialAgent: true,
            accessibleSkillIds: [skillId],
            manualSkills: ['cancelled-tool-skill'],
          },
          { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
        ),
      ).rejects.toBe(reason);

      expect(loadTools).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a resource recovery failure when execute_code is skill-added', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const resourceRecoveryError = Object.assign(new Error('resource recovery required'), {
      code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
      status: 409,
      statusCode: 409,
    });
    loadTools.mockRejectedValue(resourceRecoveryError);

    const getSkillByName = buildGetSkillByName(
      'code-skill',
      [Tools.execute_code],
      skillId,
      req.user!.id,
    );

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          accessibleSkillIds: [skillId],
          manualSkills: ['code-skill'],
        },
        { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
      ),
    ).rejects.toBe(resourceRecoveryError);

    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search', Tools.execute_code]);
  });

  it('still retries when only skill-added tools expect unavailable MCP tools', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const expectedMCPError = Object.assign(new Error('expected MCP tools are unavailable'), {
      code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
      statusCode: 503,
    });
    loadTools.mockRejectedValueOnce(expectedMCPError).mockResolvedValueOnce({
      tools: [],
      toolContextMap: {},
      userMCPAuthMap: undefined,
      toolRegistry: undefined,
      toolDefinitions: [{ name: 'web_search', description: '', parameters: {} }],
      hasDeferredTools: false,
      actionsEnabled: undefined,
    });

    const getSkillByName = buildGetSkillByName(
      'mcp-skill',
      ['mcp__warehouse__query'],
      skillId,
      req.user!.id,
    );

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['mcp-skill'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    expect(loadTools).toHaveBeenCalledTimes(2);
    expect(loadTools.mock.calls[0][0].tools).toEqual(['web_search', 'mcp__warehouse__query']);
    expect(loadTools.mock.calls[1][0].tools).toEqual(['web_search']);
    expect(result.toolDefinitions?.map((definition) => definition.name)).toContain('web_search');
  });

  it('falls back to host-provided skill authoring tools when BOTH loadTools calls return undefined', async () => {
    /* Worst-case silent-failure path: production loaders catch errors
       and return undefined. If the agent's own tools fail to load AND
       the retry without extras also fails, loaded registry tools drop out,
       but host-provided file authoring remains available for skill access. */
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    /* Both calls (with extras + without extras) silently return undefined. */
    loadTools.mockResolvedValue(undefined);

    const getSkillByName = buildGetSkillByName(
      'broken-skill',
      ['some-tool'],
      skillId,
      req.user!.id,
    );

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        skillAuthoringAvailable: true,
        manualSkills: ['broken-skill'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    /* Two attempts (initial + retry), both undefined. Registry-backed tools
       fall away, but read/create/edit_file are registered by the initializer
       so skill authoring still works — and `skill` comes with them, so a
       skill authored in this run can still be invoked despite the empty
       catalog. */
    expect(loadTools).toHaveBeenCalledTimes(2);
    const definedNames = result.toolDefinitions?.map((d) => d.name) ?? [];
    expect(definedNames).toEqual(['read_file', 'create_file', 'edit_file', 'skill']);
  });

  it('propagates the error when loadTools fails AND there are no skill-added extras to drop', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];
    /* No skills, no extras — a thrown loadTools is the agent's own problem,
       not ours to absorb. */
    loadTools.mockRejectedValueOnce(new Error('agent tool registry corrupted'));

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          accessibleSkillIds: undefined,
        },
        db,
      ),
    ).rejects.toThrow('agent tool registry corrupted');
    expect(loadTools).toHaveBeenCalledTimes(1);
  });

  it('does not invoke loadTools twice when the agent has no tools and the skill adds none', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();

    const getSkillByName = buildGetSkillByName('plain', [], skillId, req.user!.id);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['plain'],
      },
      { ...db, listSkillsByAccess: emptyListSkillsByAccess, getSkillByName },
    );

    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadTools.mock.calls[0][0].tools).toEqual([]);
  });
});

describe('initializeAgent — execute_code capability expansion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('expands execute_code into bash_tool + read_file when codeEnvAvailable=true', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['execute_code'];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      db,
    );

    const names = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(names).toContain('bash_tool');
    expect(names).toContain('read_file');
    expect(names).toContain('create_file');
    expect(names).toContain('edit_file');
    /* The legacy `execute_code` tool def is no longer registered by this
       path — the string stays in `agent.tools` as the capability trigger
       but never appears in the tool definitions the LLM sees. */
    expect(names).not.toContain('execute_code');
    const readFile = result.toolDefinitions?.find((d) => d.name === 'read_file');
    expect(readFile?.description).toContain('code-sandbox');
    expect(readFile?.description).not.toContain('{skillName}');
    expect(readFile?.description).not.toContain('SKILL.md');
    const createFile = result.toolDefinitions?.find((d) => d.name === 'create_file');
    expect(createFile?.description).toContain('code-execution sandbox');
    expect(createFile?.description).toContain('/mnt/data/');
    expect(createFile?.description).not.toContain('skills/');
    expect(result.skillAuthoringAvailable).toBe(false);
    expect(result.fileAuthoringToolNames).toEqual(new Set(['create_file', 'edit_file']));
  });

  it('withholds attached code tools when the conversation works without an environment', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [Tools.execute_code];
    agent.tool_resources = {
      [EToolResources.execute_code]: { file_ids: ['attached-code-file'] },
    };
    agent.stateful_code_sessions = true;
    agent.code_environment_id = 'personal-vm';
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'personal-vm',
                name: 'Personal VM',
                type: 'attached',
                baseURL: 'https://code.example.com/v1',
              },
            ],
          },
        },
      },
    } as unknown as NonNullable<typeof req.config>;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestBody: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
        statefulSessionsAvailable: true,
      },
      db,
    );

    expect(result.codeEnvAvailable).toBe(false);
    expect(result.codeExecutionContext).toEqual(
      expect.objectContaining({ executionProfile: 'default', statefulSessions: false }),
    );
    expect(result.toolDefinitions?.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['bash_tool', 'read_file', 'create_file', 'edit_file']),
    );
    const { primeResources } = jest.requireMock('../resources') as { primeResources: jest.Mock };
    const primeCall = primeResources.mock.calls[primeResources.mock.calls.length - 1][0];
    expect(primeCall.enabledToolResources.has(EToolResources.execute_code)).toBe(false);
    expect(primeCall.tool_resources).not.toHaveProperty(EToolResources.execute_code);
  });

  it('does not disable managed code tools for the without-attached decision', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [Tools.execute_code];
    agent.stateful_code_sessions = true;
    agent.code_environment_id = 'managed-code';
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: {
            environments: [
              {
                id: 'managed-code',
                name: 'Managed code',
                type: 'managed',
                baseURL: 'https://code.example.com/v1',
              },
            ],
          },
        },
      },
    } as NonNullable<typeof req.config>;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestBody: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
        statefulSessionsAvailable: true,
      },
      db,
    );

    expect(result.codeEnvAvailable).toBe(true);
    expect(result.toolDefinitions?.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['bash_tool', 'read_file']),
    );
  });

  it('honors without-attached when the configured environment is no longer visible', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [Tools.execute_code];
    agent.stateful_code_sessions = true;
    agent.code_environment_id = 'revoked-vm';
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { environments: [] },
        },
      },
    } as unknown as NonNullable<typeof req.config>;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestBody: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
        statefulSessionsAvailable: true,
      },
      db,
    );

    expect(result.codeEnvAvailable).toBe(false);
    expect(result.toolDefinitions?.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['bash_tool', 'read_file', 'create_file', 'edit_file']),
    );
  });

  it('keeps an implicit managed stateful route enabled during attached opt-out', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [Tools.execute_code];
    agent.stateful_code_sessions = true;
    delete agent.code_environment_id;
    process.env.CODE_ENVIRONMENT_DECISION_VERSION = '1';
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful-code.example.com/v1/';
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { environments: [] },
        },
      },
    } as unknown as NonNullable<typeof req.config>;

    try {
      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestBody: {
            conversationId: 'conversation-1',
            codeEnvironmentMode: 'without_attached',
          },
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: false,
          codeEnvAvailable: true,
          statefulSessionsAvailable: true,
        },
        db,
      );

      expect(result.codeEnvAvailable).toBe(true);
      expect(result.statefulCodeSessions).toBe(true);
      expect(result.toolDefinitions?.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['bash_tool', 'read_file']),
      );
    } finally {
      delete process.env.CODE_ENVIRONMENT_DECISION_VERSION;
      delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    }
  });

  it('honors attached opt-out when no implicit managed route is deployed', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [Tools.execute_code];
    agent.stateful_code_sessions = true;
    delete agent.code_environment_id;
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { environments: [] },
        },
      },
    } as unknown as NonNullable<typeof req.config>;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestBody: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: false,
        codeEnvAvailable: true,
        statefulSessionsAvailable: true,
      },
      db,
    );

    expect(result.codeEnvAvailable).toBe(false);
    expect(result.statefulCodeSessions).toBe(false);
    expect(result.toolDefinitions?.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['bash_tool', 'read_file']),
    );
  });

  it('keeps legacy opt-out classification until the deployment protocol is enabled', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [Tools.execute_code];
    agent.stateful_code_sessions = true;
    delete agent.code_environment_id;
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful-code.example.com/v1/';
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { environments: [] },
        },
      },
    } as unknown as NonNullable<typeof req.config>;

    try {
      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          requestBody: {
            conversationId: 'conversation-1',
            codeEnvironmentMode: 'without_attached',
          },
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: false,
          codeEnvAvailable: true,
          statefulSessionsAvailable: true,
        },
        db,
      );

      expect(result.codeEnvAvailable).toBe(false);
      expect(result.statefulCodeSessions).toBe(false);
    } finally {
      delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    }
  });

  it('routes code-file priming through the stateful profile before tools load', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['execute_code'];
    agent.stateful_code_sessions = true;
    agent.stateful_code_environment = 'agent-user';
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful-code.example.com/v1/';

    try {
      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          codeEnvAvailable: true,
          statefulSessionsAvailable: true,
        },
        db,
      );

      expect(loadTools).toHaveBeenCalledWith(
        expect.objectContaining({
          codeExecutionContext: expect.objectContaining({
            baseUrl: 'https://stateful-code.example.com/v1',
            executionProfile: 'stateful',
            statefulSessions: true,
          }),
        }),
      );
      expect(result.codeExecutionContext).toEqual(
        expect.objectContaining({
          baseUrl: 'https://stateful-code.example.com/v1',
          executionProfile: 'stateful',
        }),
      );
    } finally {
      delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    }
  });

  it.each([false, true])(
    'uses the validated attached workspace operation ceiling: protectedEdit=%s',
    async (protectedEdit) => {
      const { agent, req, res, loadTools, db } = createMocks();
      agent.tools = ['execute_code'];
      agent.stateful_code_sessions = true;
      agent.code_environment_id = 'personal-vm';
      req.config = {
        endpoints: {
          [EModelEndpoint.agents]: {
            statefulCodeSessions: {
              environments: [
                {
                  id: 'personal-vm',
                  name: 'Personal VM',
                  type: 'attached',
                  baseURL: 'https://code.example.com/v1',
                  owner: 'deployment',
                  workerId: 'worker-a',
                  configSchema: {
                    limits: { maxCommandTimeoutMs: 120_000 },
                  },
                },
              ],
            },
          },
        },
      } as NonNullable<typeof req.config>;
      if (protectedEdit)
        req.config.filters = {
          files: {
            pii: {
              customPatterns: [{ id: 'test', label: 'test', regex: 'secret' }],
              fields: ['content'],
            },
          },
        };
      const codeExecutionContext: CodeExecutionContext = {
        baseUrl: 'https://code.example.com/v1',
        codeSessionKey: 'execute_code:stateful:route:session',
        executionProfile: 'stateful',
        statefulSessions: true,
        environmentId: 'personal-vm',
        environmentType: 'attached',
        bridgeWorkerId: 'worker-a',
        codeEnvironmentConfigSchema: {
          limits: { maxCommandTimeoutMs: 120_000 },
        },
        codeWorkspace: {
          environmentId: 'personal-vm',
          workspaceId: 'project-a',
          operations: ['read_file', 'list_files', 'execute_command'],
          environment: { fingerprint: 'a'.repeat(64), repo: 'owner/project', actions: ['check'] },
        },
      };
      if (protectedEdit) codeExecutionContext.codeWorkspace!.operations.push('edit_file');
      loadTools.mockResolvedValue({
        tools: [],
        toolContextMap: {},
        dynamicToolContextMap: {},
        toolDefinitions: [],
        hasDeferredTools: false,
        codeExecutionContext,
      });

      const result = await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          codeEnvAvailable: true,
          statefulSessionsAvailable: true,
        },
        db,
      );

      expect(result.codeExecutionContext).toBe(codeExecutionContext);
      expect(result.toolDefinitions?.map(({ name }) => name).sort()).toEqual([
        'bash_tool',
        'list_workspace_files',
        'read_file',
      ]);
      const bashTool = result.toolDefinitions?.find(({ name }) => name === 'bash_tool');
      expect(bashTool?.parameters).toMatchObject({
        properties: { environmentAction: { enum: ['check'] } },
        required: [],
      });
      expect(bashTool?.description).toContain('owner/project');
      expect(
        (bashTool?.parameters as { properties?: { timeoutMs?: { maximum?: number } } })?.properties
          ?.timeoutMs?.maximum,
      ).toBe(120_000);
    },
  );

  it('rejects a stateful environment excluded by deployment policy', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['execute_code'];
    agent.stateful_code_sessions = true;
    agent.stateful_code_environment = 'conversation';
    req.config = {
      endpoints: {
        [EModelEndpoint.agents]: {
          statefulCodeSessions: { allowedEnvironments: ['user'] },
        },
      },
    } as NonNullable<typeof req.config>;

    let error;
    try {
      await initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          codeEnvAvailable: true,
          statefulSessionsAvailable: true,
        },
        db,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
      message: 'Stateful code environment is not allowed by this deployment: conversation',
    });
    expect(isFatalAgentInitializationError(error)).toBe(true);
    expect(loadTools).not.toHaveBeenCalled();
  });

  it('uses an explicit stateful environment allowlist when req.config is unavailable', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['execute_code'];
    agent.stateful_code_sessions = true;
    agent.stateful_code_environment = 'conversation';
    req.config = undefined;

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.OPENAI]),
          isInitialAgent: true,
          codeEnvAvailable: true,
          statefulSessionsAvailable: true,
          allowedStatefulCodeEnvironments: ['user'],
        },
        db,
      ),
    ).rejects.toMatchObject({ code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED });
    expect(loadTools).not.toHaveBeenCalled();
  });

  it('upgrades read_file to the skill-aware description when active skills are in scope', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['execute_code'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const author = { toString: () => req.user?.id } as unknown as import('mongoose').Types.ObjectId;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
        accessibleSkillIds: [skillId],
      },
      {
        ...db,
        listSkillsByAccess: jest.fn().mockResolvedValue({
          skills: [
            {
              _id: skillId,
              name: 'data-cleaner',
              description: 'Clean tabular data.',
              author,
            },
          ],
          has_more: false,
          after: null,
        }),
      },
    );

    const readFile = result.toolDefinitions?.find((d) => d.name === 'read_file');
    expect(readFile?.description).toContain('{skillName}/{filePath}');
    expect(readFile?.description).toContain('skills/{skillName}/');
    expect(readFile?.description).toContain('SKILL.md');
    const names = result.toolDefinitions?.map((d) => d.name) ?? [];
    expect(names).toContain('skill');
    expect(names).toContain('create_file');
    expect(names).toContain('edit_file');
  });

  it('keeps skill authoring tools hidden for read-only skill access', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const author = { toString: () => req.user?.id } as unknown as import('mongoose').Types.ObjectId;

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: false,
        accessibleSkillIds: [skillId],
        skillAuthoringAvailable: false,
      },
      {
        ...db,
        listSkillsByAccess: jest.fn().mockResolvedValue({
          skills: [
            {
              _id: skillId,
              name: 'read-only-skill',
              description: 'Read-only skill.',
              author,
            },
          ],
          has_more: false,
          after: null,
        }),
      },
    );

    const names = result.toolDefinitions?.map((d) => d.name) ?? [];
    expect(names).toContain('skill');
    expect(names).toContain('read_file');
    expect(names).not.toContain('create_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('bash_tool');
    expect(result.skillAuthoringAvailable).toBe(false);
  });

  it('registers skill authoring tools for first-time skill creators', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = [];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        accessibleSkillIds: [],
        skillAuthoringAvailable: true,
        codeEnvAvailable: false,
      },
      db,
    );

    const names = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(names).toContain('create_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('read_file');
    expect(names).not.toContain('bash_tool');
    const readFile = result.toolDefinitions?.find((d) => d.name === 'read_file');
    expect(readFile?.description).toContain('skills/{skillName}/');
    expect(readFile?.description).toContain('SKILL.md');
    const createFile = result.toolDefinitions?.find((d) => d.name === 'create_file');
    expect(createFile?.description).toContain('skills/');
    expect(result.skillAuthoringAvailable).toBe(true);
    expect(result.fileAuthoringToolNames).toEqual(new Set(['create_file', 'edit_file']));
  });

  it('does not register bash_tool + read_file when codeEnvAvailable=false', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['execute_code'];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: false,
      },
      db,
    );

    const names = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(names).not.toContain('bash_tool');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('create_file');
    expect(names).not.toContain('edit_file');
  });

  it('does not register bash_tool + read_file when agent does not request execute_code', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['web_search'];

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      db,
    );

    const names = (result.toolDefinitions ?? []).map((d) => d.name);
    expect(names).not.toContain('bash_tool');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('create_file');
    expect(names).not.toContain('edit_file');
  });

  it('narrows codeEnvAvailable on InitializedAgent to the per-agent effective value', async () => {
    /* The admin-level `params.codeEnvAvailable` is AND-ed with
       `agent.tools.includes('execute_code')` and stored on the returned
       agent. Downstream runtime code (JS controllers, `primeInvokedSkills`)
       reads the narrowed value from the stored context so skills-only
       agents never accidentally trip sandbox-side logic. */
    const { agent, req, res, loadTools, db } = createMocks();

    // Admin cap on, agent asks for execute_code → effective true.
    agent.tools = ['execute_code'];
    const execAgent = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      db,
    );
    expect(execAgent.codeEnvAvailable).toBe(true);

    // Admin cap on, agent does NOT ask for execute_code → effective false.
    agent.tools = ['web_search'];
    const skillsOnlyAgent = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      db,
    );
    expect(skillsOnlyAgent.codeEnvAvailable).toBe(false);

    // Admin cap off, agent asks for execute_code → still effective false.
    agent.tools = ['execute_code'];
    const capOffAgent = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: false,
      },
      db,
    );
    expect(capOffAgent.codeEnvAvailable).toBe(false);

    // Neither → effective false.
    agent.tools = ['web_search'];
    const neitherAgent = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: false,
      },
      db,
    );
    expect(neitherAgent.codeEnvAvailable).toBe(false);
  });

  it('allows Google provider tools alongside execute_code definitions', async () => {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      overrideProvider: Providers.GOOGLE,
      model: 'gemini-3.5-flash',
    });
    agent.tools = ['execute_code'];

    /* Surface an options.tools array from the provider config — this is
       the `googleSearch` / `urlContext` built-in LLM tooling that
       Google/Vertex exposes via provider options. */
    mockGetProviderConfig.mockReturnValue({
      getOptions: jest.fn().mockResolvedValue({
        llmConfig: { model: 'gemini-3.5-flash', maxTokens: 4096 },
        tools: [{ googleSearch: {} }],
      } satisfies InitializeResultBase),
      overrideProvider: Providers.GOOGLE,
    });

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.GOOGLE]),
          isInitialAgent: true,
          codeEnvAvailable: true,
        },
        db,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        tools: [{ googleSearch: {} }],
        model_parameters: expect.objectContaining({
          includeServerSideToolInvocations: true,
        }),
        toolDefinitions: expect.arrayContaining([
          expect.objectContaining({ name: 'bash_tool' }),
          expect.objectContaining({ name: 'read_file' }),
        ]),
      }),
    );
  });

  it('combines Google provider tools with structured external tools', async () => {
    const structuredTool = {
      name: 'weather',
      description: 'Get weather',
      schema: { type: 'object', properties: {} },
    };
    const providerTool = { googleSearch: {} };
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.GOOGLE,
      overrideProvider: Providers.GOOGLE,
      model: 'gemini-3.5-flash',
      providerTools: [providerTool],
      structuredTools: [structuredTool],
    });
    agent.tools = ['weather'];

    await expect(
      initializeAgent(
        {
          req,
          res,
          agent,
          loadTools,
          endpointOption: { endpoint: EModelEndpoint.agents },
          allowedProviders: new Set([Providers.GOOGLE]),
          isInitialAgent: true,
          codeEnvAvailable: false,
        },
        db,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        tools: [structuredTool, providerTool],
        model_parameters: expect.objectContaining({
          includeServerSideToolInvocations: true,
        }),
      }),
    );
  });
});

describe('initializeAgent — code-generated file thread filter (regression)', () => {
  /* Sibling-branched conversation regression. Pre-fix the priming chain
   * filtered code-generated files by `messageId IN threadMessageIds`,
   * which excluded files whose creator messageId lived on a sibling
   * branch (preserved on the File record by `processCodeOutput` for
   * provenance). The fix anchors `getCodeGeneratedFiles` on
   * `threadFileIds` instead — file_ids referenced by the thread's
   * `messages.files[]` arrays. This block locks the new contract at
   * the integration boundary: assert the right call shape, not the
   * underlying Mongo query (covered separately by
   * `data-schemas/methods/file.spec`). */

  beforeEach(() => {
    jest.clearAllMocks();
    mockExtractLibreChatParams.mockReset();
    mockGetThreadData.mockReset();
  });

  function setupExecuteCodeAgent() {
    const { agent, req, res, loadTools, db } = createMocks({
      provider: Providers.OPENAI,
    });
    agent.tools = ['execute_code'];

    /* `resendFiles: true` is the gate that opens the thread-file
     * priming block in initialize.ts. Without it the whole
     * codeGeneratedFiles fetch is skipped. */
    mockExtractLibreChatParams.mockReturnValue({
      resendFiles: true,
      maxContextTokens: undefined,
      modelOptions: { model: 'test-model' },
    });

    return { agent, req, res, loadTools, db };
  }

  it('provisions code files for a skill tool that never names execute_code', async () => {
    /**
     * `bash_tool` reads the code environment but is not an `EToolResources` key, so an
     * agent that gets it only through a skill built no provisioning state and invoked
     * the tool against an empty sandbox. Execution-time eligibility already counted it.
     */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();
    agent.tools = ['web_search'];
    const { Types } = await import('mongoose');
    const skillId = new Types.ObjectId();
    const getSkillByName = jest.fn().mockResolvedValue({
      _id: skillId,
      name: 'sandbox-skill',
      body: 'body of sandbox-skill',
      author: { toString: () => req.user!.id } as unknown as import('mongoose').Types.ObjectId,
      allowedTools: ['bash_tool'],
    });
    mockGetThreadData.mockReturnValue({ messageIds: ['msgN'], fileIds: ['file-1'] });
    const getCodeGeneratedFiles = jest.fn().mockResolvedValue([]);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'msgN',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
        accessibleSkillIds: [skillId],
        manualSkills: ['sandbox-skill'],
      },
      {
        ...db,
        getCodeGeneratedFiles,
        getSkillByName,
        listSkillsByAccess: async () => ({ skills: [], has_more: false, after: null }),
      },
    );

    expect(getCodeGeneratedFiles).toHaveBeenCalledTimes(1);
  });

  it('passes threadFileIds (not threadMessageIds) to getCodeGeneratedFiles', async () => {
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    /* Simulate the branched scenario: parent message N is a sibling
     * regeneration. `getThreadData` walks back from N and collects
     * messageIds [N, root] plus fileIds referenced by N.files[]. */
    mockGetThreadData.mockReturnValue({
      messageIds: ['msgN', 'msgRoot'],
      fileIds: ['file-pptx-skill', 'file-output-csv'],
    });

    const getCodeGeneratedFiles = jest.fn().mockResolvedValue([]);
    const getUserCodeFiles = jest.fn().mockResolvedValue([]);
    const getMessages = jest
      .fn()
      .mockResolvedValue([{ messageId: 'msgN', parentMessageId: 'msgRoot', files: [] }]);

    const dbWithThreadCalls: InitializeAgentDbMethods = {
      ...db,
      getMessages,
      getCodeGeneratedFiles,
      getUserCodeFiles,
    };

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'msgN',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      dbWithThreadCalls,
    );

    expect(getCodeGeneratedFiles).toHaveBeenCalledTimes(1);
    expect(getCodeGeneratedFiles).toHaveBeenCalledWith(
      'conv-1',
      ['file-pptx-skill', 'file-output-csv'],
      { userId: 'user-1', tenantId: undefined },
    );
    /* Both functions now share the same primary anchor — symmetric
     * design that closes the sibling-branch hole. */
    expect(getUserCodeFiles).toHaveBeenCalledWith(['file-pptx-skill', 'file-output-csv'], {
      userId: 'user-1',
      tenantId: undefined,
    });
  });

  it('selects messages.attachments alongside messages.files (regression)', async () => {
    /* Code-execution outputs land on `messages.attachments` via
     * `processCodeOutput`; user uploads land on `messages.files`.
     * Selecting only `files` silently dropped every code-output
     * file_id from the thread walk, so the next turn's
     * `tool_resources.execute_code.file_ids` came up empty and the
     * sandbox saw `_injected_files: []`. The visible symptom: "the
     * previous file isn't persisted between executions" on a single
     * linear thread. Lock the select string so a future field
     * trim doesn't silently re-introduce the bug. */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    mockGetThreadData.mockReturnValue({ messageIds: [], fileIds: [] });

    const getCodeGeneratedFiles = jest.fn().mockResolvedValue([]);
    const getUserCodeFiles = jest.fn().mockResolvedValue([]);
    const getMessages = jest.fn().mockResolvedValue([]);

    const dbWithThreadCalls: InitializeAgentDbMethods = {
      ...db,
      getMessages,
      getCodeGeneratedFiles,
      getUserCodeFiles,
    };

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'msgN',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      dbWithThreadCalls,
    );

    expect(getMessages).toHaveBeenCalledTimes(1);
    const [, selectFields] = getMessages.mock.calls[0];
    /* Asserting on a substring instead of exact equality keeps the
     * test resilient to future ordering / new fields, while still
     * catching a regression where `attachments` is dropped. */
    expect(selectFields).toMatch(/\battachments\b/);
    expect(selectFields).toMatch(/\bfiles\b/);
    expect(selectFields).toMatch(/\bmessageId\b/);
    expect(selectFields).toMatch(/\bparentMessageId\b/);
  });

  it('skips the code-generated fetch entirely when threadFileIds is empty', async () => {
    /* Empty `messages.files[]` across the thread — nothing to look up.
     * The function returns early without hitting Mongo, mirroring the
     * pre-fix behavior for empty-thread cases. */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    mockGetThreadData.mockReturnValue({
      messageIds: ['msgN', 'msgRoot'],
      fileIds: [],
    });

    const getCodeGeneratedFiles = jest.fn().mockResolvedValue([]);
    const getUserCodeFiles = jest.fn().mockResolvedValue([]);
    const getMessages = jest
      .fn()
      .mockResolvedValue([{ messageId: 'msgN', parentMessageId: 'msgRoot', files: [] }]);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'msgN',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      { ...db, getMessages, getCodeGeneratedFiles, getUserCodeFiles },
    );

    expect(getCodeGeneratedFiles).toHaveBeenCalledWith('conv-1', [], {
      userId: 'user-1',
      tenantId: undefined,
    });
    /* `getUserCodeFiles` is gated on a non-empty array at the call site,
     * so it shouldn't be invoked at all. `getCodeGeneratedFiles`'s own
     * empty-guard is exercised by data-schemas tests. */
    expect(getUserCodeFiles).not.toHaveBeenCalled();
  });

  it('charges a file appearing in both sets against the allowance once', async () => {
    /* An embedded attachment still missing the active code route is hydrated for delivery
     * and returned as a provisioning candidate. Charging its bytes twice would spend an
     * allowance the request never uses and drop a different candidate that fits. */
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const shared = { file_id: 'shared', filename: 'a.csv', bytes: 400 };
    const deferredOnly = { file_id: 'deferred', filename: 'b.csv', bytes: 100 };
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    /* Delivery keeps the shared file; the deferred pass keeps both. */
    filterFilesByEndpointRuntimeConfig
      .mockReturnValueOnce([shared])
      .mockReturnValueOnce([shared, deferredOnly]);
    const getDeferredProvisionFiles = jest.fn().mockResolvedValue([shared, deferredOnly]);
    const getConvoFiles = jest.fn().mockResolvedValue(['shared', 'deferred']);
    const getToolFilesByIds = jest.fn().mockResolvedValue([shared]);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      {
        ...db,
        getDeferredProvisionFiles,
        getConvoFiles,
        getToolFilesByIds,
        getFiles: jest.fn().mockResolvedValue([shared, deferredOnly]),
      },
    );

    const chargedToDeferred = filterFilesByEndpointRuntimeConfig.mock.calls
      .map(([, params]) => (params as { consumedBytes?: number }).consumedBytes)
      .find((bytes) => bytes !== undefined);
    /* The only delivered file is also the shared one, and the deferred pass charges its
     * own list as it walks it, so nothing is carried in. */
    expect(chargedToDeferred).toBe(0);

    /* The persistent screening runs inside the callback, and must see the two unique
     * files rather than three. */
    const { primeResources } = jest.requireMock('../resources') as { primeResources: jest.Mock };
    const lastCall = primeResources.mock.calls[primeResources.mock.calls.length - 1];
    const screen = lastCall?.[0].screenPersistentFiles as (files: unknown[]) => unknown[];
    filterFilesByEndpointRuntimeConfig.mockClear();
    filterFilesByEndpointRuntimeConfig.mockReturnValueOnce([]);
    screen([]);
    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ consumedBytes: 500 }),
    );
  });

  it('screens persistent agent files under the remaining size allowance and content policy', async () => {
    /* These are read inside primeResources, so the caller never sees them. Both checks it
     * applied to this turn's other files have to reach them through the callback. */
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const { primeResources } = jest.requireMock('../resources') as { primeResources: jest.Mock };
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      db,
    );

    const screen = primeResources.mock.calls[0][0].screenPersistentFiles as (
      files: unknown[],
    ) => unknown[];
    expect(typeof screen).toBe('function');

    filterFilesByEndpointRuntimeConfig.mockClear();
    const persistent = [{ file_id: 'persistent-1', filename: 'notes.csv', bytes: 10 }];
    filterFilesByEndpointRuntimeConfig.mockReturnValueOnce(persistent);

    expect(screen(persistent)).toEqual(persistent);
    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ consumedBytes: expect.any(Number) }),
    );
  });

  it('drops a persistent agent file the content policy now refuses', async () => {
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const { primeResources } = jest.requireMock('../resources') as { primeResources: jest.Mock };
    const { assertModelBoundContent } = jest.requireMock('../../middleware/modelBoundContent') as {
      assertModelBoundContent: jest.Mock;
    };
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      db,
    );

    const screen = primeResources.mock.calls[0][0].screenPersistentFiles as (
      files: unknown[],
    ) => unknown[];
    const persistent = [
      {
        file_id: 'blocked-1',
        filename: 'secrets.bin',
        bytes: 10,
        type: 'application/octet-stream',
      },
    ];
    filterFilesByEndpointRuntimeConfig.mockReturnValueOnce(persistent);
    assertModelBoundContent.mockImplementationOnce(() => {
      throw new Error('content policy');
    });

    expect(screen(persistent)).toEqual([]);
  });

  it('finds deferred files from the conversation when no anchor is supplied', async () => {
    /* The Responses API always continues via `previous_response_id` and passes a null
     * parentMessageId, and chat completions may omit it. Without an anchor there is no
     * thread walk, so the conversation's own file refs are the only available scope. */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    const getMessages = jest.fn().mockResolvedValue([]);
    const getConvoFiles = jest.fn().mockResolvedValue(['convo-file-1']);
    const getDeferredProvisionFiles = jest.fn().mockResolvedValue([]);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: null,
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      { ...db, getMessages, getConvoFiles, getDeferredProvisionFiles },
    );

    expect(getMessages).not.toHaveBeenCalled();
    expect(getDeferredProvisionFiles).toHaveBeenCalledWith(
      ['convo-file-1'],
      expect.anything(),
      expect.objectContaining({ code: true }),
    );
  });

  it('keeps an anchored branch scoped to itself when it references no files', async () => {
    /* Widening an empty branch to the conversation would provision a sibling branch's
     * attachments, sending files this branch never mentioned to the Code API or RAG. */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    const getMessages = jest.fn().mockResolvedValue([{ messageId: 'm1' }]);
    const getConvoFiles = jest.fn().mockResolvedValue(['sibling-branch-file']);
    const getDeferredProvisionFiles = jest.fn().mockResolvedValue([]);
    mockGetThreadData.mockReturnValueOnce({ fileIds: [] });

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'parent-1',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      { ...db, getMessages, getConvoFiles, getDeferredProvisionFiles },
    );

    expect(getDeferredProvisionFiles).not.toHaveBeenCalled();
  });

  it('prefers the thread scope for deferred files when an anchor is supplied', async () => {
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    const getMessages = jest.fn().mockResolvedValue([{ messageId: 'm1' }]);
    const getConvoFiles = jest.fn().mockResolvedValue(['convo-file-1']);
    const getDeferredProvisionFiles = jest.fn().mockResolvedValue([]);
    mockGetThreadData.mockReturnValueOnce({ fileIds: ['thread-file-1'] });

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'parent-1',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      { ...db, getMessages, getConvoFiles, getDeferredProvisionFiles },
    );

    expect(getDeferredProvisionFiles).toHaveBeenCalledWith(
      ['thread-file-1'],
      expect.anything(),
      expect.objectContaining({ code: true }),
    );
  });

  it('skips the thread walk when parentMessageId is an empty string', async () => {
    /* An empty anchor can never match a parent chain, so walking the
     * conversation only buys an unbounded read whose result is discarded.
     * `req.body.parentMessageId` reaches this layer unnormalized. */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    const getMessages = jest.fn().mockResolvedValue([]);
    const getConvoFiles = jest.fn().mockResolvedValue([]);

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: '',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      { ...db, getMessages, getConvoFiles },
    );

    expect(getMessages).not.toHaveBeenCalled();
    expect(mockGetThreadData).not.toHaveBeenCalled();
    /* The conversation read is unconditional and must survive the guard. */
    expect(getConvoFiles).toHaveBeenCalledTimes(1);
  });

  it('dispatches the convo-file read and the thread walk concurrently', async () => {
    /* Both reads gate the model call, so serializing them costs
     * time-to-first-token on every turn. Holding BOTH unresolved is what
     * makes this fail under either ordering: whichever runs first blocks,
     * and the second is never dispatched.
     *
     * DELETE this test, do not repair it, if the thread walk ever gains a
     * data dependency on the convo file ids — serializing becomes correct. */
    const { agent, req, res, loadTools, db } = setupExecuteCodeAgent();

    let releaseConvoFiles!: (fileIds: string[]) => void;
    let releaseMessages!: (messages: Array<{ messageId: string }>) => void;
    const getConvoFiles = jest
      .fn()
      .mockReturnValue(new Promise<string[]>((resolve) => (releaseConvoFiles = resolve)));
    const getMessages = jest
      .fn()
      .mockReturnValue(
        new Promise<Array<{ messageId: string }>>((resolve) => (releaseMessages = resolve)),
      );

    const initialized = initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        conversationId: 'conv-1',
        parentMessageId: 'msgN',
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        codeEnvAvailable: true,
      },
      { ...db, getConvoFiles, getMessages },
    );

    /* Drain pending microtasks so the mocked chain runs up to the first
     * genuinely-pending await. */
    await new Promise((resolve) => setImmediate(resolve));

    expect(getConvoFiles).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledTimes(1);

    releaseConvoFiles([]);
    releaseMessages([]);
    await initialized;
  });
});

describe('initializeAgent — run-scoped MCP tool definitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('carries mcpAvailableTools from the loadTools result onto the initialized agent', async () => {
    /** Regression guard for the request-scoped MCP/PTC handoff: dropping this
     *  field at the destructure boundary forces per-call reinitialization
     *  downstream and can storm the MCP circuit breaker. */
    const { agent, req, res, loadTools, db } = createMocks();
    const mcpTool = 'list_tables_mcp_ClickHouse';
    const mcpAvailableTools = {
      ClickHouse: {
        [mcpTool]: {
          type: 'function' as const,
          function: {
            name: mcpTool,
            description: 'List tables',
            parameters: { type: 'object' as const, properties: {} },
          },
        },
      },
    };
    loadTools.mockResolvedValue({
      tools: [],
      toolContextMap: {},
      dynamicToolContextMap: {},
      userMCPAuthMap: undefined,
      toolRegistry: undefined,
      toolDefinitions: [],
      hasDeferredTools: false,
      mcpAvailableTools,
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.mcpAvailableTools).toEqual(mcpAvailableTools);
  });

  it('retains the resolved collision audit on the initialized agent', async () => {
    /** Deferred/event-driven execution reuses this snapshot instead of
     *  repeating the merged-registry read — a transient failure there
     *  would fail-closed a tool the turn already advertised. */
    const { agent, req, res, loadTools, db } = createMocks();
    const rawServerName = 'Connector: Company';
    const accessibleNames = [rawServerName, 'plain_server'];
    (req as { config: { mcpConfig?: Record<string, unknown> } }).config = {
      mcpConfig: { [rawServerName]: {} },
    };
    agent.tools = [`search${Constants.mcp_delimiter}${rawServerName}`];
    const getAccessibleMcpServerNames = jest.fn(async () => accessibleNames);

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      { ...db, getAccessibleMcpServerNames },
    );

    expect(result.accessibleMcpServerNames).toEqual(accessibleNames);
    expect(loadTools).toHaveBeenCalledWith(
      expect.objectContaining({ accessibleMcpServerNames: accessibleNames }),
    );
  });

  it('threads the normalized MCP request body into tool discovery', async () => {
    const { agent, req, res, loadTools, db } = createMocks();
    agent.tools = ['custom_tool'];
    const requestBody = {
      messageId: 'message-1',
      conversationId: 'conversation-1',
      parentMessageId: 'parent-1',
    };

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestBody,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    expect(loadTools).toHaveBeenCalledWith(expect.objectContaining({ requestBody }));
  });

  it('unions snapshot config names into the audit when the merged read omits them', async () => {
    /** The registry's merged read tolerates config-server init failures and
     *  can silently drop config-only servers — the heal audit must restore
     *  them from the request's config snapshot or a collision goes unseen
     *  while the audit still claims completeness. */
    const { agent, req, res, loadTools, db } = createMocks();
    const rawServerName = 'Connector: Company';
    (req as { config: { mcpConfig?: Record<string, unknown> } }).config = {
      mcpConfig: { [rawServerName]: {} },
    };
    agent.tools = [`search${Constants.mcp_delimiter}${rawServerName}`];
    const getAccessibleMcpServerNames = jest.fn(async () => ['db_only_server']);

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      { ...db, getAccessibleMcpServerNames },
    );

    expect(result.accessibleMcpServerNames).toEqual(['db_only_server', rawServerName]);
  });
});

describe('initializeAgent — authorized run file snapshots', () => {
  const resourceMock = jest.requireMock('../resources') as { primeResources: jest.Mock };
  const filterMock = jest.requireMock('~/files') as {
    filterFilesByEndpointRuntimeConfig: jest.Mock;
  };
  const realResources = jest.requireActual<typeof import('../resources')>('../resources');
  const realFilters = jest.requireActual<typeof import('~/files/filter')>('~/files/filter');

  const inputFile = (overrides: Partial<TFile> = {}): TFile => ({
    file_id: 'current-pdf',
    user: 'user-1',
    filename: 'current.pdf',
    filepath: '/uploads/current.pdf',
    type: 'application/pdf',
    source: FileSources.local,
    bytes: 20,
    usage: 1,
    embedded: false,
    object: 'file',
    llmDeliveryPath: 'provider',
    metadata: { destinationChosen: false },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resourceMock.primeResources.mockReset().mockImplementation(realResources.primeResources);
    filterMock.filterFilesByEndpointRuntimeConfig
      .mockReset()
      .mockImplementation(realFilters.filterFilesByEndpointRuntimeConfig);
  });

  afterEach(() => {
    resourceMock.primeResources
      .mockReset()
      .mockResolvedValue({ attachments: [], tool_resources: undefined });
    filterMock.filterFilesByEndpointRuntimeConfig.mockReset().mockReturnValue([]);
  });

  function setup() {
    const result = createMocks();
    result.agent.tools = [Tools.execute_code, Tools.file_search];
    result.agent.endpoint = EModelEndpoint.openAI;
    return result;
  }

  it('reuses current inputs without reading parent history or counting their usage again', async () => {
    const { agent, req, loadTools, db } = setup();
    const file = inputFile();
    const getMessages = jest.fn();
    const getDeferredProvisionFiles = jest.fn();
    const result = await initializeAgent(
      {
        req,
        agent,
        loadTools,
        conversationId: 'parent-conversation',
        parentMessageId: 'previous-parent-message',
        authorizedRunFiles: [file],
        allowedProviders: new Set([Providers.OPENAI]),
        codeEnvAvailable: true,
        fileSearchAvailable: true,
      },
      { ...db, getMessages, getDeferredProvisionFiles },
    );
    expect(result.requestAttachments.map((entry) => entry.file_id)).toEqual([file.file_id]);
    expect(result.provisionState?.codeEnvFiles.map((entry) => entry.file_id)).toEqual([
      file.file_id,
    ]);
    expect(result.provisionState?.vectorDBFiles.map((entry) => entry.file_id)).toEqual([
      file.file_id,
    ]);
    expect(result.requestAttachments[0]).not.toBe(file);
    expect(result.provisionState?.agentScopedFileIds.size).toBe(0);
    expect(getMessages).not.toHaveBeenCalled();
    expect(getDeferredProvisionFiles).not.toHaveBeenCalled();
    expect(db.getConvoFiles).not.toHaveBeenCalled();
    expect(db.getToolFilesByIds).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
    expect(db.updateFilesUsage).not.toHaveBeenCalled();
  });

  it('still authorizes and primes the child agent own setup files separately', async () => {
    const { agent, req, loadTools, db } = setup();
    const shared = inputFile();
    const setupFile = inputFile({
      file_id: 'child-setup',
      filename: 'setup.txt',
      type: 'text/plain',
      text: 'child setup instructions',
      llmDeliveryPath: 'text',
      context: FileContext.agents,
    });
    if (req.config == null) throw new Error('Missing test configuration');
    req.config.endpoints = { ...req.config.endpoints };
    req.config.endpoints.agents = configSchema.parse({
      version: '1.3.9',
      endpoints: { agents: { capabilities: [AgentCapabilities.context] } },
    }).endpoints?.agents;
    agent.tools?.push(EToolResources.context);
    agent.tool_resources = { context: { file_ids: [setupFile.file_id] } };
    (db.getFiles as jest.Mock).mockResolvedValue([setupFile]);
    const filterFilesByAgentAccess = jest.fn(async ({ files }: { files: TFile[] }) => files);
    const result = await initializeAgent(
      {
        req,
        agent,
        loadTools,
        conversationId: 'parent-conversation',
        authorizedRunFiles: [shared],
        allowedProviders: new Set([Providers.OPENAI]),
        codeEnvAvailable: true,
        fileSearchAvailable: true,
      },
      { ...db, filterFilesByAgentAccess },
    );
    expect(result.requestAttachments.map((entry) => entry.file_id)).toEqual([shared.file_id]);
    expect(result.agentContextAttachments.map((entry) => entry.file_id)).toEqual([
      setupFile.file_id,
    ]);
    expect(result.provisionState?.agentScopedFileIds).toEqual(new Set([setupFile.file_id]));
    expect(filterFilesByAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: agent.id, userId: 'user-1', files: [setupFile] }),
    );
    expect(db.getFiles).toHaveBeenCalledTimes(1);
    expect(db.getConvoFiles).not.toHaveBeenCalled();
  });

  it('treats an empty authorized snapshot as no shared inputs', async () => {
    const { agent, req, loadTools, db } = setup();
    (db.getConvoFiles as jest.Mock).mockResolvedValue(['unrelated-history']);
    const result = await initializeAgent(
      {
        req,
        agent,
        loadTools,
        conversationId: 'parent-conversation',
        authorizedRunFiles: [],
        allowedProviders: new Set([Providers.OPENAI]),
        codeEnvAvailable: true,
      },
      db,
    );
    expect(result.requestAttachments).toEqual([]);
    expect(result.provisionState).toBeUndefined();
    expect(db.getConvoFiles).not.toHaveBeenCalled();
  });

  it.each([{ user: 'foreign-user' }, { tenantId: 'foreign-tenant' }])(
    'rejects an incorrectly scoped snapshot before priming: %o',
    async (difference) => {
      const { agent, req, loadTools, db } = setup();
      await expect(
        initializeAgent(
          {
            req,
            agent,
            loadTools,
            authorizedRunFiles: [inputFile(difference)],
            allowedProviders: new Set([Providers.OPENAI]),
            codeEnvAvailable: true,
          },
          db,
        ),
      ).rejects.toThrow('authenticated owner');
      expect(resourceMock.primeResources).not.toHaveBeenCalled();
    },
  );

  it('applies the child endpoint policy to the supplied snapshot', async () => {
    const { agent, req, loadTools, db } = setup();
    if (req.config == null) throw new Error('Missing test configuration');
    req.config.fileConfig = { endpoints: { [EModelEndpoint.openAI]: { disabled: true } } };
    const result = await initializeAgent(
      {
        req,
        agent,
        loadTools,
        authorizedRunFiles: [inputFile()],
        allowedProviders: new Set([Providers.OPENAI]),
        codeEnvAvailable: true,
      },
      db,
    );
    expect(result.requestAttachments).toEqual([]);
    expect(result.provisionState).toBeUndefined();
  });

  it('checks current content policy before a shared text file reaches a child', async () => {
    const { agent, req, loadTools, db } = setup();
    if (req.config == null) throw new Error('Missing test configuration');
    req.config.filters = {
      files: {
        pii: {
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };
    await expect(
      initializeAgent(
        {
          req,
          agent,
          loadTools,
          authorizedRunFiles: [inputFile({ llmDeliveryPath: 'text', text: 'PRIVATE-SECRET' })],
          allowedProviders: new Set([Providers.OPENAI]),
          codeEnvAvailable: true,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'content_filter_block' });
    expect(resourceMock.primeResources).not.toHaveBeenCalled();
  });

  it('returns only exact current request IDs for seeding a shared-file manifest', async () => {
    const { agent, req, loadTools, db } = setup();
    const current = inputFile();
    const historical = inputFile({ file_id: 'history-file', embedded: true });
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: true,
      modelOptions: { model: agent.model },
    });
    (db.getFiles as jest.Mock).mockResolvedValue([current, historical]);
    (db.getConvoFiles as jest.Mock).mockResolvedValue([historical.file_id]);
    (db.getToolFilesByIds as jest.Mock).mockResolvedValue([historical]);
    const result = await initializeAgent(
      {
        req,
        agent,
        loadTools,
        conversationId: 'parent-conversation',
        requestFiles: [{ file_id: current.file_id } as IMongoFile],
        allowedProviders: new Set([Providers.OPENAI]),
        codeEnvAvailable: true,
        fileSearchAvailable: true,
      },
      db,
    );
    expect(result.requestAttachments.map((entry) => entry.file_id)).toEqual([
      current.file_id,
      historical.file_id,
    ]);
    expect(result.currentRequestAttachments.map((entry) => entry.file_id)).toEqual([
      current.file_id,
    ]);
    expect(result.currentRequestAttachments[0].user).toBe('user-1');
  });
});

/**
 * Provider-native web search is gated on what the provider builder produced, not
 * on `model_parameters.web_search`: an endpoint's `defaultParams`, `customParams`
 * defaults and `addParams` reach the same switch, and `addParams` is applied last.
 */
describe('initializeAgent — provider-native web search role gate', () => {
  const OPENAI_SEARCH = { type: 'web_search' };

  const roleWithWebSearch = (use: boolean) =>
    jest.fn().mockResolvedValue({
      name: 'USER',
      permissions: { [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: use } },
    });

  const roleGatedReq = () =>
    ({ user: { id: 'user-1', role: 'USER' }, config: {} }) as unknown as ServerRequest;

  const run = async ({
    provider = Providers.OPENAI,
    providerTools = [OPENAI_SEARCH],
    getRoleByName,
    params = {},
  }: {
    provider?: Providers;
    providerTools?: unknown[];
    getRoleByName?: jest.Mock;
    params?: Partial<Parameters<typeof initializeAgent>[0]>;
  }) => {
    const { agent, res, loadTools, db } = createMocks({ provider, providerTools });
    return initializeAgent(
      {
        req: roleGatedReq(),
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([provider]),
        isInitialAgent: true,
        ...params,
      },
      { ...db, getRoleByName },
    );
  };

  it.each([
    ['OpenAI', Providers.OPENAI, OPENAI_SEARCH],
    ['Anthropic', Providers.ANTHROPIC, { type: 'web_search_20250305', name: 'web_search' }],
    ['Google', Providers.GOOGLE, { googleSearch: {} }],
  ])(
    'strips the %s native search tool when the role denies WEB_SEARCH',
    async (_label, provider, nativeTool) => {
      const result = await run({
        provider: provider as Providers,
        providerTools: [nativeTool],
        getRoleByName: roleWithWebSearch(false),
      });
      expect(result.tools).not.toContainEqual(nativeTool);
    },
  );

  it.each([
    ['OpenAI', Providers.OPENAI, OPENAI_SEARCH],
    ['Anthropic', Providers.ANTHROPIC, { type: 'web_search_20250305', name: 'web_search' }],
    ['Google', Providers.GOOGLE, { googleSearch: {} }],
  ])(
    'keeps the %s native search tool when the role grants WEB_SEARCH',
    async (_label, provider, nativeTool) => {
      const result = await run({
        provider: provider as Providers,
        providerTools: [nativeTool],
        getRoleByName: roleWithWebSearch(true),
      });
      expect(result.tools).toContainEqual(nativeTool);
    },
  );

  /** An agent that stores `web_search: false` still gets native search when its
   *  endpoint's `addParams` turns it on, so the stored value cannot short-circuit
   *  the gate. */
  it('strips endpoint-enabled search for a denied role even when the agent stores false', async () => {
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: false,
      maxContextTokens: undefined,
      modelOptions: { model: 'test-model', web_search: false },
    });

    const result = await run({ getRoleByName: roleWithWebSearch(false) });

    expect(result.tools).not.toContainEqual(OPENAI_SEARCH);
  });

  it('reads no role when the built config turns no native search on', async () => {
    const getRoleByName = roleWithWebSearch(false);
    const resolveWebSearchGrant = jest.fn().mockResolvedValue(false);
    mockExtractLibreChatParams.mockReturnValueOnce({
      resendFiles: false,
      maxContextTokens: undefined,
      modelOptions: { model: 'test-model', web_search: true },
    });

    await run({ providerTools: [], getRoleByName, params: { resolveWebSearchGrant } });

    expect(getRoleByName).not.toHaveBeenCalled();
    expect(resolveWebSearchGrant).not.toHaveBeenCalled();
  });

  /** OpenRouter receives web search as `modelKwargs.plugins`, not as a tool, so
   *  the plugin alone has to trigger the gate. */
  it('strips the OpenRouter web search plugin when the role denies WEB_SEARCH', async () => {
    const { agent, res, loadTools, db } = createMocks({ provider: Providers.OPENAI });
    const llmConfig = {
      model: agent.model,
      modelKwargs: { plugins: [{ id: 'web' }, { id: 'file-parser' }] },
    };
    mockGetProviderConfig.mockReturnValue({
      getOptions: jest.fn().mockResolvedValue({ llmConfig }),
      overrideProvider: Providers.OPENAI,
    });
    const getRoleByName = roleWithWebSearch(false);

    await initializeAgent(
      {
        req: roleGatedReq(),
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      { ...db, getRoleByName },
    );

    expect(getRoleByName).toHaveBeenCalledTimes(1);
    expect(llmConfig.modelKwargs.plugins).toEqual([{ id: 'file-parser' }]);
  });

  /** The OpenAI-compatible and Responses routes reach the initializer with
   *  `runtime` and no `req`; their resolver joins the grants memoized on their
   *  own request, so the initializer must not read the role itself. */
  it('uses the caller resolver instead of reading the role', async () => {
    const getRoleByName = roleWithWebSearch(true);
    const resolveWebSearchGrant = jest.fn().mockResolvedValue(false);

    const result = await run({ getRoleByName, params: { resolveWebSearchGrant } });

    expect(resolveWebSearchGrant).toHaveBeenCalledTimes(1);
    expect(getRoleByName).not.toHaveBeenCalled();
    expect(result.tools).not.toContainEqual(OPENAI_SEARCH);
  });

  it('keeps native search when the caller resolver grants it', async () => {
    const resolveWebSearchGrant = jest.fn().mockResolvedValue(true);

    const result = await run({ params: { resolveWebSearchGrant } });

    expect(result.tools).toContainEqual(OPENAI_SEARCH);
  });

  it('denies native search when the caller resolver throws', async () => {
    const resolveWebSearchGrant = jest.fn().mockRejectedValue(new Error('role store down'));

    const result = await run({ params: { resolveWebSearchGrant } });

    expect(result.tools).not.toContainEqual(OPENAI_SEARCH);
  });

  it('authorizes the runtime user when the caller passes runtime and no req', async () => {
    const getRoleByName = roleWithWebSearch(false);

    const result = await run({
      getRoleByName,
      params: {
        req: undefined,
        runtime: {
          user: { id: 'user-1', role: 'USER' } as never,
          appConfig: {} as never,
          requestBody: {},
          turnStartedAt: 1000,
        },
      },
    });

    expect(getRoleByName).toHaveBeenCalledWith('USER', undefined);
    /** One read, not one per grant: without a `req` there is no per-request
     *  cache to dedupe the three permission checks. */
    expect(getRoleByName).toHaveBeenCalledTimes(1);
    expect(result.tools).not.toContainEqual(OPENAI_SEARCH);
  });

  it('applies no role gate when neither a resolver nor a role lookup is wired', async () => {
    const result = await run({});

    expect(result.tools).toContainEqual(OPENAI_SEARCH);
  });
});

describe('initializeAgent tool-routed text fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const routedCsv = () =>
    ({
      file_id: 'csv-file',
      filename: 'sales.csv',
      type: 'text/csv',
      text: 'region,total',
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false },
    }) as IMongoFile;

  /** A tool serves a file only once it holds it, so these carry the evidence provisioning
   *  writes: vectors for file search, a sandbox pointer for code execution. */
  const embeddedCsv = () => ({ ...routedCsv(), embedded: true }) as IMongoFile;
  const sandboxCsv = () =>
    ({
      ...routedCsv(),
      metadata: {
        destinationChosen: false,
        codeEnvRef: {
          kind: 'user',
          id: 'user_1',
          storage_session_id: 'session_1',
          file_id: 'sandbox_file_1',
        },
      },
    }) as IMongoFile;

  async function initializeWith({
    tools,
    csv,
    textFallbackWithoutTools = true,
    provider = Providers.OPENAI,
    overrideProvider,
    supportedMimeTypes,
    softFailure = false,
    fileSearchAvailable = true,
    fileContextCharLimit,
    useResponsesApi,
  }: {
    tools: string[];
    csv: IMongoFile;
    textFallbackWithoutTools?: boolean;
    provider?: string;
    overrideProvider?: string;
    supportedMimeTypes?: string[];
    softFailure?: boolean;
    fileSearchAvailable?: boolean;
    fileContextCharLimit?: number;
    useResponsesApi?: boolean;
  }) {
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const { agent, req, res, loadTools, db } = createMocks({
      provider,
      overrideProvider,
      loadedToolDefinitions: tools.includes(EToolResources.file_search)
        ? [{ name: EToolResources.file_search }]
        : [],
    });
    if (useResponsesApi != null) {
      mockGetProviderConfig.mockReturnValue({
        overrideProvider: overrideProvider ?? provider,
        getOptions: jest
          .fn()
          .mockResolvedValue({ llmConfig: { model: agent.model, useResponsesApi } }),
      });
    }
    (primeResources as jest.Mock).mockImplementationOnce(async ({ attachments }) => {
      const files = await attachments;
      return {
        attachments: files,
        requestAttachments: files,
        agentContextAttachments: [],
        tool_resources: {},
      };
    });
    agent.tools = tools;
    if (softFailure) loadTools.mockResolvedValue(undefined);
    req.config = {
      fileConfig: {
        fileContextCharLimit,
        endpoints: {
          [provider]: {
            defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
            textFallbackWithoutTools,
            ...(supportedMimeTypes != null && { supportedMimeTypes }),
          },
        },
      },
    } as unknown as ServerRequest['config'];
    (db.getFiles as jest.Mock).mockResolvedValueOnce([csv]);
    filterFilesByEndpointRuntimeConfig.mockImplementationOnce(
      (_config: ServerRequest['config'], { files }: { files: IMongoFile[] }) => files,
    );

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestFiles: [csv],
        codeEnvAvailable: true,
        fileSearchAvailable,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([provider]),
        isInitialAgent: true,
      },
      db,
    );
    return { result, filterFilesByEndpointRuntimeConfig };
  }

  it.each([true, false])(
    'admits Azure PDFs with the final Responses mode %s',
    async (useResponsesApi) => {
      const pdf = { ...routedCsv(), type: 'application/pdf', text: undefined };
      const { result, filterFilesByEndpointRuntimeConfig } = await initializeWith({
        tools: [],
        csv: pdf,
        provider: EModelEndpoint.azureOpenAI,
        overrideProvider: Providers.OPENAI,
        useResponsesApi,
      });
      expect(result.deliveryRouting.useResponsesApi).toBe(useResponsesApi);
      expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          files: [{ ...pdf, llmDeliveryPath: useResponsesApi ? 'provider' : 'text' }],
        }),
      );
    },
  );

  it('keeps fallback out of the prompt when file search loads and holds the file', async () => {
    const csv = embeddedCsv();
    const { result } = await initializeWith({ tools: [EToolResources.file_search], csv });
    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: true });
    expect(result.requestAttachments).toEqual([csv]);
  });

  it('delivers fallback text when file search runs but never received the file', async () => {
    /* The plain-chat File Search toggle: the upload names no destination, so nothing files it
     * under a tool resource and the vector store stays empty. Withholding the text for the
     * toggle alone left the attachment readable by neither the model nor the tool. */
    const csv = routedCsv();
    const { result } = await initializeWith({ tools: [EToolResources.file_search], csv });
    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: true });
    expect(result.requestAttachments).toEqual([{ ...csv, llmDeliveryPath: 'text' }]);
    expect(csv.llmDeliveryPath).toBe('none');
  });

  it('falls back after file search soft-fails and admits the returned text copy', async () => {
    const csv = routedCsv();
    const { result } = await initializeWith({
      tools: [EToolResources.file_search],
      csv,
      softFailure: true,
    });
    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: false });
    expect(result.requestAttachments).toEqual([{ ...csv, llmDeliveryPath: 'text' }]);
    expect(csv.llmDeliveryPath).toBe('none');
  });

  it('rejects fallback text that exceeds admission after a reader soft-fails', async () => {
    await expect(
      initializeWith({
        tools: [EToolResources.file_search],
        csv: routedCsv(),
        softFailure: true,
        fileContextCharLimit: 3,
      }),
    ).rejects.toMatchObject({ name: 'AgentAttachmentLimitError' });
  });

  it('hands endpoint filtering a text copy when the agent runs no tool that can read the file', async () => {
    const csv = routedCsv();

    const { result, filterFilesByEndpointRuntimeConfig } = await initializeWith({ tools: [], csv });

    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: [{ ...csv, llmDeliveryPath: 'text' }] }),
    );
    expect(result.fileConsumers).toEqual({ executeCode: false, fileSearch: false });
    expect(csv.llmDeliveryPath).toBe('none');
  });

  it('hands endpoint filtering the provider route a tool-routed file takes on this turn', async () => {
    /* Admission reads the route, so a record left for tools that this endpoint sends to the
     * provider must reach filtering, limits and inspection as a provider file. */
    const image = {
      file_id: 'image-file',
      filename: 'chart.png',
      type: 'image/png',
      llmDeliveryPath: 'none',
      metadata: { destinationChosen: false },
    } as IMongoFile;

    const { filterFilesByEndpointRuntimeConfig } = await initializeWith({
      tools: [],
      csv: image,
    });

    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: [{ ...image, llmDeliveryPath: 'provider' }] }),
    );
    expect(image.llmDeliveryPath).toBe('none');
  });

  it('keeps media a custom endpoint opted into on its provider route before the provider swap', async () => {
    /* The encoders send OpenAI-format media to a custom endpoint that lists the type, so the
     * route has to read that endpoint's dialect from config, not the name still in `provider`. */
    const video = {
      file_id: 'video-file',
      filename: 'clip.mp4',
      type: 'video/mp4',
      llmDeliveryPath: 'provider',
      metadata: { destinationChosen: false },
    } as IMongoFile;

    const { filterFilesByEndpointRuntimeConfig } = await initializeWith({
      tools: [],
      csv: video,
      provider: 'MyGateway',
      overrideProvider: Providers.OPENAI,
      supportedMimeTypes: ['video/mp4'],
    });

    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: [video] }),
    );
  });

  it('resolves a custom endpoint agent under the endpoint its upload was routed by', async () => {
    /* Uploads resolve the agent's saved provider, which for a custom endpoint is its name.
     * Initialization later swaps the provider for the backing client, so an opt-in set only
     * on the custom endpoint must still be read under that name, here and after the swap. */
    const csv = routedCsv();

    const { result, filterFilesByEndpointRuntimeConfig } = await initializeWith({
      tools: [],
      csv,
      provider: 'MyGateway',
      overrideProvider: Providers.OPENAI,
    });

    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: [{ ...csv, llmDeliveryPath: 'text' }] }),
    );
    expect(result.provider).toBe(Providers.OPENAI);
    expect(result.endpoint).toBe('MyGateway');
  });

  it('leaves the file on its tool route where the endpoint has not enabled the fallback', async () => {
    const csv = routedCsv();

    const { filterFilesByEndpointRuntimeConfig } = await initializeWith({
      tools: [],
      csv,
      textFallbackWithoutTools: false,
    });

    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: [csv] }),
    );
  });

  it('leaves the file to Run Code when the sandbox already holds it', async () => {
    const csv = sandboxCsv();

    const { result, filterFilesByEndpointRuntimeConfig } = await initializeWith({
      tools: [EToolResources.execute_code],
      csv,
    });

    expect(filterFilesByEndpointRuntimeConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: [csv] }),
    );
    expect(result.fileConsumers).toEqual({ executeCode: true, fileSearch: false });
  });
});

describe('initializeAgent turn delivery routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('settles the routing once, after the provider swap and the Responses API decision', async () => {
    const { agent, req, res, loadTools, db } = createMocks({ provider: 'MyClaude' });
    req.config = {
      fileConfig: { endpoints: { MyClaude: { supportedMimeTypes: ['video/mp4'] } } },
      endpoints: { custom: [{ name: 'MyClaude', provider: 'anthropic' }] },
    } as unknown as ServerRequest['config'];
    mockGetProviderConfig.mockReturnValue({
      overrideProvider: Providers.ANTHROPIC,
      getOptions: jest
        .fn()
        .mockResolvedValue({ llmConfig: { model: 'test-model', useResponsesApi: true } }),
    });

    const result = await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set(['MyClaude']),
        isInitialAgent: true,
      },
      db,
    );

    expect(result.provider).toBe(Providers.ANTHROPIC);
    expect(result.deliveryRouting).toMatchObject({
      endpoint: 'MyClaude',
      endpointProvider: 'anthropic',
      useResponsesApi: true,
      sttConfigured: false,
    });
    expect(result.deliveryRouting.endpointConfig.supportedMimeTypes).toEqual([/video\/mp4/]);
  });

  it('resolves the provider and its options before any attachment is loaded', async () => {
    const { filterFilesByEndpointRuntimeConfig } = jest.requireMock('~/files') as {
      filterFilesByEndpointRuntimeConfig: jest.Mock;
    };
    const { agent, req, res, loadTools, db } = createMocks();
    const getOptions = jest.fn().mockResolvedValue({ llmConfig: { model: 'test-model' } });
    mockGetProviderConfig.mockReturnValue({ overrideProvider: Providers.OPENAI, getOptions });
    const file = {
      file_id: 'file-1',
      filename: 'notes.txt',
      type: 'text/plain',
      bytes: 10,
      text: 'notes',
      llmDeliveryPath: 'text',
    } as IMongoFile;
    (db.getFiles as jest.Mock).mockResolvedValueOnce([file]);
    filterFilesByEndpointRuntimeConfig.mockImplementationOnce(
      (_config: ServerRequest['config'], { files }: { files: IMongoFile[] }) => files,
    );

    await initializeAgent(
      {
        req,
        res,
        agent,
        loadTools,
        requestFiles: [file],
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
      },
      db,
    );

    const [optionsOrder] = getOptions.mock.invocationCallOrder;
    const [filesOrder] = (db.getFiles as jest.Mock).mock.invocationCallOrder;
    const [toolsOrder] = loadTools.mock.invocationCallOrder;
    expect(optionsOrder).toBeLessThan(filesOrder);
    expect(filesOrder).toBeLessThan(toolsOrder);
  });
});
