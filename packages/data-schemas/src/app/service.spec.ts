import {
  EModelEndpoint,
  AgentCapabilities,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type { DeepPartial, TCustomConfig } from 'librechat-data-provider';
import { AppService, loadFiltersConfig, loadSummarizationConfig } from './service';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('loadSummarizationConfig', () => {
  const warnSpy = logger.warn as jest.Mock;

  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('returns undefined when no summarization config is provided', () => {
    expect(loadSummarizationConfig({} as DeepPartial<TCustomConfig>)).toBeUndefined();
  });

  it('accepts a valid token_ratio trigger', () => {
    const result = loadSummarizationConfig({
      summarization: {
        enabled: true,
        trigger: { type: 'token_ratio', value: 0.8 },
      },
    } as DeepPartial<TCustomConfig>);

    expect(result).toBeDefined();
    expect(result?.enabled).toBe(true);
    expect(result?.trigger).toEqual({ type: 'token_ratio', value: 0.8 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits a targeted migration warning when trigger.type is the legacy "token_count"', () => {
    const result = loadSummarizationConfig({
      summarization: {
        trigger: { type: 'token_count', value: 8000 },
      },
    } as unknown as DeepPartial<TCustomConfig>);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain('token_count');
    expect(message).toContain('token_ratio');
    expect(message).toContain('remaining_tokens');
    expect(message).toContain('messages_to_refine');
    expect(message).toContain('fall back');
  });

  it('falls back to the generic warning when trigger is a bare string (not an object)', () => {
    const result = loadSummarizationConfig({
      summarization: {
        trigger: 'token_count',
      },
    } as unknown as DeepPartial<TCustomConfig>);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Invalid summarization config');
  });

  it('falls back to the generic warning for other schema violations', () => {
    const result = loadSummarizationConfig({
      summarization: {
        trigger: { type: 'token_ratio', value: 80 },
      },
    } as unknown as DeepPartial<TCustomConfig>);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Invalid summarization config');
  });
});

describe('loadFiltersConfig', () => {
  it('treats omission and zero-rule source configs as disabled', () => {
    expect(loadFiltersConfig({})).toBeUndefined();
    expect(loadFiltersConfig({ filters: {} })).toBeUndefined();
    expect(loadFiltersConfig({ filters: { messages: {} } })).toBeUndefined();
    expect(
      loadFiltersConfig({
        filters: {
          skills: {
            pii: {
              fields: ['file_text'],
              starterPatterns: [],
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it('retains strict legacy attribution without source-aware PII patterns', () => {
    expect(
      loadFiltersConfig({
        filters: {
          messages: { unattributedAssistantContent: 'inspect' },
        },
      }),
    ).toEqual({ messages: { unattributedAssistantContent: 'inspect' } });
    expect(
      loadFiltersConfig({
        filters: {
          messages: { unattributedAssistantContent: 'model_output' },
        },
      }),
    ).toBeUndefined();
  });

  it('returns a validated source-aware filter config', () => {
    const result = loadFiltersConfig({
      filters: {
        agentInstructions: {
          pii: {
            fields: ['instructions'],
            customPatterns: [
              {
                id: 'organization-identifier',
                label: 'Organization identifier',
                regex: 'ORG-[A-Z0-9]+',
              },
            ],
          },
        },
      },
    });

    expect(result).toEqual({
      agentInstructions: {
        pii: {
          fields: ['instructions'],
          customPatterns: [
            {
              id: 'organization-identifier',
              label: 'Organization identifier',
              regex: 'ORG-[A-Z0-9]+',
            },
          ],
        },
      },
    });
  });

  it('retains an explicit file fail-close policy without text matchers', () => {
    expect(
      loadFiltersConfig({
        filters: {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
      }),
    ).toEqual({
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    });
  });

  it('rejects structurally partial filter patterns instead of disabling policy', () => {
    expect(() =>
      loadFiltersConfig({
        filters: {
          messages: {
            pii: {
              customPatterns: [{ regex: 'ORG-[A-Z0-9]+' }],
            },
          },
        },
      }),
    ).toThrow('Invalid filters config');
  });

  it.each([null, false, 0, 'messages'])(
    'rejects a configured non-object value (%p) instead of disabling policy',
    (filters) => {
      expect(() =>
        loadFiltersConfig({
          filters,
        } as unknown as DeepPartial<TCustomConfig>),
      ).toThrow('Invalid filters config');
    },
  );

  it('rejects app config construction when configured filters are invalid', async () => {
    await expect(
      AppService({
        config: {
          filters: {
            messages: {
              pii: {
                customPatterns: [{ regex: '(' }],
              },
            },
          },
        } as DeepPartial<TCustomConfig>,
      }),
    ).rejects.toThrow('Invalid filters config');
  });
});

describe('AppService assistants config', () => {
  it('preserves configured Assistants API versions', async () => {
    const config = {
      endpoints: {
        [EModelEndpoint.assistants]: {
          version: 'v3',
        },
        [EModelEndpoint.azureOpenAI]: {
          assistants: true,
          groups: [
            {
              group: 'azure-assistants-test',
              apiKey: 'test-key',
              instanceName: 'azure-assistants-test',
              assistants: true,
              version: '2024-02-15-preview',
              models: {
                'gpt-4': {
                  deploymentName: 'gpt-4',
                },
              },
            },
          ],
        },
        [EModelEndpoint.azureAssistants]: {
          version: 4,
        },
      },
    } as DeepPartial<TCustomConfig>;

    const result = await AppService({ config });

    expect(result.endpoints?.[EModelEndpoint.assistants]?.version).toBe('v3');
    expect(result.endpoints?.[EModelEndpoint.azureAssistants]?.version).toBe(4);
  });

  it('keeps Azure Assistants default version when only Azure OpenAI enables assistants', async () => {
    const config = {
      endpoints: {
        [EModelEndpoint.azureOpenAI]: {
          assistants: true,
          groups: [
            {
              group: 'azure-assistants-test',
              apiKey: 'test-key',
              instanceName: 'azure-assistants-test',
              assistants: true,
              version: '2024-02-15-preview',
              models: {
                'gpt-4': {
                  deploymentName: 'gpt-4',
                },
              },
            },
          ],
        },
      },
    } as DeepPartial<TCustomConfig>;

    const result = await AppService({ config });

    expect(result.endpoints?.[EModelEndpoint.azureAssistants]?.version).toBe(
      defaultAssistantsVersion.azureAssistants,
    );
  });
});

describe('AppService MCP App sandbox configuration', () => {
  it('preserves deployment-owned MCP App sandbox limits', async () => {
    const result = await AppService({
      config: {
        mcpAppSandbox: {
          url: 'https://mcp-sandbox.example.com/api/mcp/sandbox',
          maxSourcesPerDirective: 64,
          maxSerializedLength: 8192,
          maxAdmissionRequestsPerMinute: 480,
        },
      } as DeepPartial<TCustomConfig>,
    });

    expect(result.mcpAppSandbox).toEqual({
      url: 'https://mcp-sandbox.example.com/api/mcp/sandbox',
      maxSourcesPerDirective: 64,
      maxSerializedLength: 8192,
      maxAdmissionRequestsPerMinute: 480,
    });
  });
});

describe('AppService conversation list limits', () => {
  it('carries the configured filter limits onto the app config', async () => {
    const result = await AppService({
      config: {
        conversationList: { maxEndpointFilters: 200, maxEndpointNameLength: 256 },
      } as DeepPartial<TCustomConfig>,
    });

    expect(result.conversationList).toEqual({
      maxEndpointFilters: 200,
      maxEndpointNameLength: 256,
    });
  });

  it('fills the schema defaults when the deployment configures none', async () => {
    const result = await AppService({ config: {} as DeepPartial<TCustomConfig> });
    expect(result.conversationList).toEqual({ maxEndpointFilters: 50, maxEndpointNameLength: 128 });
  });

  it('keeps the defaults when the configured block is invalid', async () => {
    const result = await AppService({
      config: { conversationList: { maxEndpointFilters: 0 } } as DeepPartial<TCustomConfig>,
    });
    expect(result.conversationList).toEqual({ maxEndpointFilters: 50, maxEndpointNameLength: 128 });
  });

  it('keeps the default for a limit the deployment leaves out', async () => {
    const result = await AppService({
      config: { conversationList: { maxEndpointFilters: 10 } } as DeepPartial<TCustomConfig>,
    });
    expect(result.conversationList).toEqual({ maxEndpointFilters: 10, maxEndpointNameLength: 128 });
  });
});

describe('AppService memory capability', () => {
  it('strips the memory capability when no memory config is present', async () => {
    const result = await AppService({ config: {} as DeepPartial<TCustomConfig> });
    expect(result.endpoints?.[EModelEndpoint.agents]?.capabilities).not.toContain(
      AgentCapabilities.memory,
    );
  });

  it('keeps the memory capability when memory is configured and enabled', async () => {
    const config = { memory: { tokenLimit: 10000 } } as DeepPartial<TCustomConfig>;
    const result = await AppService({ config });
    expect(result.endpoints?.[EModelEndpoint.agents]?.capabilities).toContain(
      AgentCapabilities.memory,
    );
  });

  it('strips the memory capability when memory is explicitly disabled', async () => {
    const config = { memory: { disabled: true } } as DeepPartial<TCustomConfig>;
    const result = await AppService({ config });
    expect(result.endpoints?.[EModelEndpoint.agents]?.capabilities).not.toContain(
      AgentCapabilities.memory,
    );
  });

  it('strips the memory capability even when an agents endpoint block is configured', async () => {
    const config = {
      endpoints: { [EModelEndpoint.agents]: { disableBuilder: true } },
    } as DeepPartial<TCustomConfig>;
    const result = await AppService({ config });
    expect(result.endpoints?.[EModelEndpoint.agents]?.capabilities).not.toContain(
      AgentCapabilities.memory,
    );
  });
});
