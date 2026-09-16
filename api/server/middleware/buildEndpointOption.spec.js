/**
 * Wrap parseCompactConvo: the REAL function runs, but jest can observe
 * calls and return values. Must be declared before require('./buildEndpointOption')
 * so the destructured reference in the middleware captures the wrapper.
 */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    parseCompactConvo: jest.fn((...args) => actual.parseCompactConvo(...args)),
  };
});

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  };
});

const {
  EModelEndpoint,
  ReasoningParameterFormat,
  parseCompactConvo,
} = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

const mockBuildOptions = jest.fn((_endpoint, parsedBody) => ({
  ...parsedBody,
  endpoint: _endpoint,
}));
const mockAgentBuildOptions = jest.fn((_req, endpoint, parsedBody) => ({
  ...parsedBody,
  endpoint,
}));

jest.mock('~/server/services/Endpoints/azureAssistants', () => ({
  buildOptions: mockBuildOptions,
}));
jest.mock('~/server/services/Endpoints/assistants', () => ({
  buildOptions: mockBuildOptions,
}));
jest.mock('~/server/services/Endpoints/agents', () => ({
  buildOptions: mockAgentBuildOptions,
}));

jest.mock('~/models', () => ({
  updateFilesUsage: jest.fn(),
}));
const { updateFilesUsage } = require('~/models');

const mockGetEndpointsConfig = jest.fn();
jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: (...args) => mockGetEndpointsConfig(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  handleError: jest.fn(),
}));

const buildEndpointOption = require('./buildEndpointOption');

const createReq = (body, config = {}) => ({
  body,
  config,
  baseUrl: '/api/chat',
});

const createRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('buildEndpointOption - defaultParamsEndpoint parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should pass defaultParamsEndpoint to parseCompactConvo and preserve maxOutputTokens', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      AnthropicClaude: {
        type: EModelEndpoint.custom,
        customParams: {
          defaultParamsEndpoint: EModelEndpoint.anthropic,
        },
      },
    });

    const req = createReq(
      {
        endpoint: 'AnthropicClaude',
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
        topP: 0.9,
        maxContextTokens: 50000,
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      }),
    );

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.maxOutputTokens).toBe(8192);
    expect(parsedResult.topP).toBe(0.9);
    expect(parsedResult.temperature).toBe(0.7);
    expect(parsedResult.maxContextTokens).toBe(50000);
  });

  it('should strip maxOutputTokens when no defaultParamsEndpoint is configured', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      MyOpenRouter: {
        type: EModelEndpoint.custom,
      },
    });

    const req = createReq(
      {
        endpoint: 'MyOpenRouter',
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        maxOutputTokens: 8192,
        max_tokens: 4096,
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultParamsEndpoint: undefined,
      }),
    );

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.maxOutputTokens).toBeUndefined();
    expect(parsedResult.max_tokens).toBe(4096);
    expect(parsedResult.temperature).toBe(0.7);
  });

  describe('request-scoped reasoning overrides', () => {
    it('applies a valid override at runtime and records the prior value for persistence', async () => {
      mockGetEndpointsConfig.mockResolvedValue({});
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-5.1', reasoning_effort: 'low' },
        agent: Promise.resolve({ provider: EModelEndpoint.openAI, model: 'gpt-5.1' }),
      });
      const req = createReq(
        {
          endpoint: EModelEndpoint.openAI,
          model: 'gpt-5.1',
          reasoning_effort: 'low',
          reasoningOverride: { key: 'reasoning_effort', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';

      await buildEndpointOption(req, createRes(), jest.fn());

      expect(req.body.endpointOption.model_parameters.reasoning_effort).toBe('high');
      expect(req.reasoningOverrideBase).toEqual({
        key: 'reasoning_effort',
        hadValue: true,
        value: 'low',
      });
    });

    it('rejects a valid but provider-mismatched override', async () => {
      mockGetEndpointsConfig.mockResolvedValue({});
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-5.1', reasoning_effort: 'low' },
        agent: Promise.resolve({ provider: EModelEndpoint.openAI, model: 'gpt-5.1' }),
      });
      const req = createReq(
        {
          endpoint: EModelEndpoint.openAI,
          model: 'gpt-5.1',
          reasoning_effort: 'low',
          reasoningOverride: { key: 'effort', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';
      const res = createRes();
      const next = jest.fn();
      const { handleError } = require('@librechat/api');

      await buildEndpointOption(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid reasoning override' });
      expect(req.body.endpointOption.model_parameters.effort).toBeUndefined();
      expect(req.reasoningOverrideBase).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
    });

    it.each([
      [EModelEndpoint.anthropic, 'claude-sonnet-4-6', 'effort', 'max'],
      [EModelEndpoint.google, 'gemini-3-pro', 'thinkingLevel', 'high'],
      [EModelEndpoint.google, 'gemini-2.5-pro', 'thinkingBudget', 32768],
    ])('applies the supported %s reasoning field', async (endpoint, model, key, value) => {
      mockGetEndpointsConfig.mockResolvedValue({});
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint,
        model_parameters: { model },
        agent: Promise.resolve({ provider: endpoint, model }),
      });
      const req = createReq(
        {
          endpoint,
          model,
          reasoningOverride: { key, value },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';

      await buildEndpointOption(req, createRes(), jest.fn());

      expect(req.body.endpointOption.model_parameters[key]).toBe(value);
      expect(req.body.endpointOption.model_parameters.thinking).toBe(true);
    });

    it('rejects the wrong Google reasoning field for Gemini 2.5', async () => {
      mockGetEndpointsConfig.mockResolvedValue({});
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: EModelEndpoint.google,
        model_parameters: { model: 'gemini-2.5-pro' },
        agent: Promise.resolve({ provider: EModelEndpoint.google, model: 'gemini-2.5-pro' }),
      });
      const req = createReq(
        {
          endpoint: EModelEndpoint.google,
          model: 'gemini-2.5-pro',
          reasoningOverride: { key: 'thinkingLevel', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';
      const res = createRes();
      const next = jest.fn();
      const { handleError } = require('@librechat/api');

      await buildEndpointOption(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid reasoning override' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects overrides for custom endpoints that disable reasoning parameters', async () => {
      mockGetEndpointsConfig.mockResolvedValue({
        QwenCompatible: {
          type: EModelEndpoint.custom,
          customParams: {
            reasoningFormat: ReasoningParameterFormat.disabled,
          },
        },
      });
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: 'QwenCompatible',
        endpointType: EModelEndpoint.custom,
        model_parameters: { model: 'qwen3-max' },
        agent: Promise.resolve({ provider: 'QwenCompatible', model: 'qwen3-max' }),
      });
      const req = createReq(
        {
          endpoint: 'QwenCompatible',
          endpointType: EModelEndpoint.custom,
          model: 'qwen3-max',
          reasoningOverride: { key: 'reasoning_effort', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';
      const res = createRes();
      const next = jest.fn();
      const { handleError } = require('@librechat/api');

      await buildEndpointOption(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid reasoning override' });
      expect(next).not.toHaveBeenCalled();
    });

    it.each([
      ['anthropic.claude-sonnet-4-6-v1:0', 'effort', 'high'],
      ['moonshot.kimi-k2.5', 'reasoning_effort', 'high'],
      ['zai.glm-4.7', 'reasoning_effort', 'high'],
    ])('applies the Bedrock model-family reasoning field for %s', async (model, key, value) => {
      mockGetEndpointsConfig.mockResolvedValue({});
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: EModelEndpoint.bedrock,
        model_parameters: { model },
        agent: Promise.resolve({ provider: EModelEndpoint.bedrock, model }),
      });
      const req = createReq(
        {
          endpoint: EModelEndpoint.bedrock,
          model,
          reasoningOverride: { key, value },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';

      await buildEndpointOption(req, createRes(), jest.fn());

      expect(req.body.endpointOption.model_parameters[key]).toBe(value);
    });

    it('applies an override to agent model parameters without mutating the saved base value', async () => {
      mockGetEndpointsConfig.mockResolvedValue({});
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-5.1', reasoning_effort: 'low' },
        agent: Promise.resolve({ provider: EModelEndpoint.openAI, model: 'gpt-5.1' }),
      });
      const req = createReq(
        {
          endpoint: EModelEndpoint.openAI,
          model: 'gpt-5.1',
          reasoning_effort: 'low',
          reasoningOverride: { key: 'reasoning_effort', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';

      await buildEndpointOption(req, createRes(), jest.fn());

      expect(req.body.endpointOption.model_parameters.reasoning_effort).toBe('high');
      expect(req.reasoningOverrideBase).toEqual({
        key: 'reasoning_effort',
        hadValue: true,
        value: 'low',
      });
    });

    it('uses a custom-backed agent provider default when validating its override', async () => {
      mockGetEndpointsConfig.mockResolvedValue({
        ClaudeProxy: {
          type: EModelEndpoint.custom,
          customParams: { defaultParamsEndpoint: EModelEndpoint.anthropic },
        },
      });
      mockAgentBuildOptions.mockReturnValueOnce({
        endpoint: EModelEndpoint.agents,
        model_parameters: { model: 'claude-sonnet-4-6', effort: 'low' },
        agent: Promise.resolve({ provider: 'ClaudeProxy', model: 'claude-sonnet-4-6' }),
      });
      const req = createReq(
        {
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent-custom',
          reasoningOverride: { key: 'effort', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';

      await buildEndpointOption(req, createRes(), jest.fn());

      expect(req.body.endpointOption.model_parameters.effort).toBe('high');
    });

    it('rejects an override for a reasoning field owned by an enforced model spec', async () => {
      mockGetEndpointsConfig.mockResolvedValue({});
      const req = createReq(
        {
          endpoint: EModelEndpoint.openAI,
          spec: 'locked-reasoning',
          model: 'gpt-5.1',
          reasoningOverride: { key: 'reasoning_effort', value: 'high' },
        },
        {
          modelSpecs: {
            enforce: true,
            list: [
              {
                name: 'locked-reasoning',
                preset: {
                  endpoint: EModelEndpoint.openAI,
                  model: 'gpt-5.1',
                  reasoning_effort: 'low',
                },
              },
            ],
          },
        },
      );
      req.baseUrl = '/api/agents/chat';
      const res = createRes();
      const next = jest.fn();
      const { handleError } = require('@librechat/api');

      await buildEndpointOption(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid reasoning override' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a malformed override before building endpoint options', async () => {
      mockGetEndpointsConfig.mockResolvedValue({});
      const req = createReq(
        {
          endpoint: EModelEndpoint.openAI,
          model: 'gpt-5.1',
          reasoningOverride: { key: 'reasoning_effort', value: 'unlimited' },
        },
        { modelSpecs: null },
      );
      const res = createRes();
      const next = jest.fn();
      const { handleError } = require('@librechat/api');

      await buildEndpointOption(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid reasoning override' });
      expect(mockBuildOptions).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
  });

  it('should strip bedrock region from custom endpoint without defaultParamsEndpoint', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      MyEndpoint: {
        type: EModelEndpoint.custom,
      },
    });

    const req = createReq(
      {
        endpoint: 'MyEndpoint',
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        region: 'us-east-1',
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.region).toBeUndefined();
    expect(parsedResult.temperature).toBe(0.7);
  });

  it('should pass defaultParamsEndpoint when re-parsing enforced model spec', async () => {
    mockGetEndpointsConfig.mockResolvedValue({
      AnthropicClaude: {
        type: EModelEndpoint.custom,
        customParams: {
          defaultParamsEndpoint: EModelEndpoint.anthropic,
        },
      },
    });

    const modelSpec = {
      name: 'claude-opus-4.5',
      preset: {
        endpoint: 'AnthropicClaude',
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
        maxContextTokens: 50000,
      },
    };

    const req = createReq(
      {
        endpoint: 'AnthropicClaude',
        endpointType: EModelEndpoint.custom,
        spec: 'claude-opus-4.5',
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.1,
        topP: 0.2,
        chatProjectId: 'project-1',
      },
      {
        modelSpecs: {
          enforce: true,
          list: [modelSpec],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    const enforcedCall = parseCompactConvo.mock.calls[1];
    expect(enforcedCall[0]).toEqual(
      expect.objectContaining({
        defaultParamsEndpoint: EModelEndpoint.anthropic,
      }),
    );

    const enforcedResult = parseCompactConvo.mock.results[1].value;
    expect(enforcedResult.maxOutputTokens).toBe(8192);
    expect(enforcedResult.temperature).toBe(0.7);
    expect(enforcedResult.topP).toBeUndefined();
    expect(enforcedResult.maxContextTokens).toBe(50000);
    expect(enforcedResult.chatProjectId).toBe('project-1');
    expect(req.body.endpointOption.chatProjectId).toBe('project-1');
  });

  it('should rebuild enforced custom specs from the backend preset when compact parsing drops raw fields', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const modelSpec = {
      name: 'approved-custom',
      preset: {
        endpoint: 'Mock Provider A',
        endpointType: EModelEndpoint.custom,
        model: 'mock-model-a',
        promptPrefix: 'Use the approved custom model spec.',
      },
    };

    const req = createReq(
      {
        endpoint: 'Mock Provider A',
        endpointType: EModelEndpoint.custom,
        spec: 'approved-custom',
        model: { stale: 'cached-client-value' },
        agent_id: 'agent_from_cached_client_state',
        chatProjectId: 'project-1',
      },
      {
        modelSpecs: {
          enforce: true,
          list: [modelSpec],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo.mock.results[0].value).toEqual({});
    expect(req.body.endpointOption.spec).toBe('approved-custom');
    expect(req.body.endpointOption.model).toBe('mock-model-a');
    expect(req.body.endpointOption.promptPrefix).toBe('Use the approved custom model spec.');
    expect(req.body.endpointOption.chatProjectId).toBe('project-1');
  });

  it('should restore private model spec preset fields in non-enforced mode', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const modelSpec = {
      name: 'guarded-openai',
      iconURL: 'openAI',
      preset: {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4o',
        promptPrefix: 'private prompt prefix',
        instructions: 'private instructions',
        additional_instructions: 'private additional instructions',
        temperature: 0.2,
        maxContextTokens: 10000,
      },
    };

    const req = createReq(
      {
        endpoint: EModelEndpoint.openAI,
        spec: 'guarded-openai',
        model: 'gpt-4o',
        temperature: 0.8,
      },
      {
        modelSpecs: {
          enforce: false,
          list: [modelSpec],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.promptPrefix).toBe('private prompt prefix');
    expect(req.body.endpointOption.instructions).toBeUndefined();
    expect(req.body.endpointOption.additional_instructions).toBeUndefined();
    expect(req.body.endpointOption.temperature).toBe(0.8);
    expect(req.body.endpointOption.maxContextTokens).toBeUndefined();
    expect(req.body.endpointOption.iconURL).toBe('openAI');
  });

  it('should reject non-enforced model specs for a different endpoint', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.openAI,
        spec: 'guarded-google',
        model: 'gpt-4o',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-google',
              preset: {
                endpoint: EModelEndpoint.google,
                model: 'gemini-pro',
                promptPrefix: 'private google prompt',
              },
            },
          ],
        },
      },
    );
    const res = createRes();
    const next = jest.fn();
    const { handleError } = require('@librechat/api');

    await buildEndpointOption(req, res, next);

    expect(handleError).toHaveBeenCalledWith(res, { text: 'Model spec mismatch' });
    expect(mockAgentBuildOptions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should restore private model spec examples when the parser supplies an empty default', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const examples = [{ input: { content: 'hello' }, output: { content: 'world' } }];
    const req = createReq(
      {
        endpoint: EModelEndpoint.google,
        spec: 'guarded-google',
        model: 'gemini-pro',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-google',
              preset: {
                endpoint: EModelEndpoint.google,
                model: 'gemini-pro',
                examples,
              },
            },
          ],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.examples).toEqual(examples);
  });

  it('should resolve special variables for restored non-agent promptPrefix', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.assistants,
        spec: 'guarded-assistant',
        assistant_id: 'asst_123',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-assistant',
              preset: {
                endpoint: EModelEndpoint.assistants,
                assistant_id: 'asst_123',
                promptPrefix: 'Help {{current_user}}.',
              },
            },
          ],
        },
      },
    );
    req.user = { name: 'Ada' };

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.promptPrefix).toBe('Help Ada.');
  });

  it('blocks a filtered profile name before a non-agent endpoint is built', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.assistants,
        spec: 'guarded-assistant',
        assistant_id: 'asst_123',
      },
      {
        filters: {
          prompts: {
            pii: {
              fields: ['preset_text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-assistant',
              preset: {
                endpoint: EModelEndpoint.assistants,
                assistant_id: 'asst_123',
                promptPrefix: 'Help {{current_user}}.',
              },
            },
          ],
        },
      },
    );
    req.user = { name: 'BLOCK-NAME' };
    const res = createRes();
    const next = jest.fn();

    await buildEndpointOption(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'prompt',
        field: 'preset_text',
      }),
    );
    expect(mockBuildOptions).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('applies agent-instruction policy to the profile name substituted into a prompt prefix', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.assistants,
        spec: 'guarded-assistant',
        assistant_id: 'asst_123',
      },
      {
        filters: {
          agentInstructions: {
            pii: {
              fields: ['instructions'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-assistant',
              preset: {
                endpoint: EModelEndpoint.assistants,
                assistant_id: 'asst_123',
                promptPrefix: 'Help {{current_user}}.',
              },
            },
          ],
        },
      },
    );
    req.user = { name: 'BLOCK-NAME' };
    const res = createRes();

    await buildEndpointOption(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'agent_instruction',
        field: 'instructions',
      }),
    );
    expect(mockBuildOptions).not.toHaveBeenCalled();
  });

  it('does not assign user provenance to static model-spec prompt text', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.assistants,
        spec: 'guarded-assistant',
        assistant_id: 'asst_123',
      },
      {
        filters: {
          prompts: {
            pii: {
              fields: ['preset_text'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'submitted-content',
                  label: 'submitted content',
                  regex: 'BLOCK-[A-Z]+',
                },
              ],
            },
          },
        },
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-assistant',
              preset: {
                endpoint: EModelEndpoint.assistants,
                assistant_id: 'asst_123',
                promptPrefix: 'Administrator text BLOCK-STATIC. Help {{current_user}}.',
              },
            },
          ],
        },
      },
    );
    req.user = { name: 'Ada' };
    const res = createRes();
    const next = jest.fn();

    await buildEndpointOption(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.endpointOption.promptPrefix).toBe('Administrator text BLOCK-STATIC. Help Ada.');
    expect(mockBuildOptions).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should leave restored agent promptPrefix variables for agent initialization', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.openAI,
        spec: 'guarded-openai',
        model: 'gpt-4o',
      },
      {
        modelSpecs: {
          enforce: false,
          list: [
            {
              name: 'guarded-openai',
              preset: {
                endpoint: EModelEndpoint.openAI,
                model: 'gpt-4o',
                promptPrefix: 'Help {{current_user}}.',
              },
            },
          ],
        },
      },
    );
    req.baseUrl = '/api/agents/chat';
    req.user = { name: 'Ada' };

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(req.body.endpointOption.promptPrefix).toBe('Help {{current_user}}.');
  });

  it('should fall back to OpenAI schema when getEndpointsConfig fails', async () => {
    mockGetEndpointsConfig.mockRejectedValue(new Error('Config unavailable'));

    const req = createReq(
      {
        endpoint: 'AnthropicClaude',
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
        max_tokens: 4096,
      },
      { modelSpecs: null },
    );

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(parseCompactConvo).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultParamsEndpoint: undefined,
      }),
    );

    const parsedResult = parseCompactConvo.mock.results[0].value;
    expect(parsedResult.maxOutputTokens).toBeUndefined();
    expect(parsedResult.max_tokens).toBe(4096);
  });

  it('does not log submitted content when compact conversation parsing fails', async () => {
    const secret = 'PRIVATE-SUBMITTED-CONTENT';
    const parseError = new Error('Invalid compact conversation');
    parseCompactConvo.mockImplementationOnce(() => {
      throw parseError;
    });
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: secret,
        endpointType: EModelEndpoint.custom,
        text: secret,
      },
      { modelSpecs: null },
    );
    const res = createRes();
    const { handleError } = require('@librechat/api');

    await buildEndpointOption(req, res, jest.fn());

    expect(logger.error).toHaveBeenCalledWith('Error parsing compact conversation', parseError);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(JSON.stringify([...logger.error.mock.calls, ...logger.debug.mock.calls])).not.toContain(
      secret,
    );
    expect(handleError).toHaveBeenCalledWith(res, { text: 'Error parsing conversation' });
  });

  it('should scope non-agent chat attachment usage updates to the authenticated user', async () => {
    const attachments = Promise.resolve([]);
    updateFilesUsage.mockReturnValueOnce(attachments);
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.assistants,
        assistant_id: 'asst_123',
        files: [{ file_id: 'forged-file-id' }],
      },
      { modelSpecs: null },
    );
    req.user = { id: 'user-1' };

    await buildEndpointOption(req, createRes(), jest.fn());

    expect(updateFilesUsage).toHaveBeenCalledWith(req.body.files, undefined, {
      user: 'user-1',
      tenantId: undefined,
    });
    expect(req.body.endpointOption.attachments).toBe(attachments);
  });

  it('should not enter the enforce branch when modelSpecs.list is empty', async () => {
    mockGetEndpointsConfig.mockResolvedValue({});

    const req = createReq(
      {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4',
      },
      {
        modelSpecs: {
          enforce: true,
          list: [],
        },
      },
    );
    const res = createRes();
    const { handleError } = require('@librechat/api');

    await buildEndpointOption(req, res, jest.fn());

    expect(handleError).not.toHaveBeenCalledWith(
      res,
      expect.objectContaining({ text: 'No model spec selected' }),
    );
    expect(handleError).not.toHaveBeenCalledWith(
      res,
      expect.objectContaining({ text: 'Invalid model spec' }),
    );
  });
});
