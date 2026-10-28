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

const { EModelEndpoint, parseCompactConvo } = require('librechat-data-provider');
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

  describe('request-scoped reasoning override wiring', () => {
    it('passes an accepted override through to model_parameters', async () => {
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
          reasoningOverride: { key: 'reasoning_effort', value: 'high' },
        },
        { modelSpecs: null },
      );
      req.baseUrl = '/api/agents/chat';
      const next = jest.fn();

      await buildEndpointOption(req, createRes(), next);

      expect(req.body.endpointOption.model_parameters.reasoning_effort).toBe('high');
      expect(next).toHaveBeenCalled();
    });

    it('turns a rejected override into an error response without calling next', async () => {
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

describe('buildEndpointOption - enforced server continuations', () => {
  const {
    createAgentTriggerExecutionHost,
    createAgentTriggerEnvelope,
    createSubagentThreadTurnGuard,
    generateAgentTriggerToken,
    isAgentTriggerRequest,
    handleError,
  } = require('@librechat/api');
  const savedSpec = {
    name: 'saved-agent',
    label: 'Saved Agent',
    preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' },
  };
  const config = { modelSpecs: { enforce: true, list: [savedSpec] } };
  const conversation = {
    user: 'user-1',
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    agent_id: 'agent-1',
    spec: savedSpec.name,
  };
  let originalSecret;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEndpointsConfig.mockResolvedValue({});
    originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'continuation-test-signing-key';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it.each([
    ['agent-queued-turn', 'agent.queued-turn'],
    ['subagent-completion', 'subagent.completion'],
    ['background-tool-completion', 'background-tool.completion'],
    ['schedule', 'schedule.occurrence'],
    ['api', 'remote.event'],
    ['webhook', 'resource.ready'],
    ['queue', 'message.ready'],
  ])(
    'admits a signed %s through the normal enforced endpoint builder',
    async (source, eventType) => {
      const getConvo = jest.fn(async () => conversation);
      const guard = createSubagentThreadTurnGuard({
        getConvo,
        store: { isThreadActiveForOwner: () => false },
      });
      const scheduled = ['schedule', 'api', 'webhook', 'queue'].includes(source);
      let admitted;
      const host = createAgentTriggerExecutionHost({
        getBaseUrl: () => 'http://localhost:3080',
        mintToken: () => generateAgentTriggerToken('user-1'),
        fetch: async (_url, init) => {
          const req = createReq(JSON.parse(init.body), config);
          req.baseUrl = '/api/agents/chat';
          req.user = { id: 'user-1', tenantId: 'tenant-1' };
          req._isAgentTrigger = isAgentTriggerRequest({
            headers: Object.fromEntries(
              Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]),
            ),
          });
          expect(req._isAgentTrigger).toBe(true);
          expect(req.body).not.toHaveProperty('spec');
          const next = jest.fn();
          // A cached authorization marker supplies no conversation document.
          await guard(req, createRes(), next);
          expect(next).toHaveBeenCalledWith();
          next.mockClear();
          await buildEndpointOption(req, createRes(), next);
          expect(handleError).not.toHaveBeenCalled();
          expect(next).toHaveBeenCalledWith();
          admitted = req.body.endpointOption;
          return new Response(
            JSON.stringify({
              status: 'started',
              streamId: 'stream-1',
              conversationId: 'conversation-1',
            }),
            { status: 200 },
          );
        },
      });
      const envelope = createAgentTriggerEnvelope({
        mode: scheduled ? 'fire' : 'continue',
        requestId: 'request-1',
        deliveryId: 'delivery-1',
        receivedAt: 1_000,
        principal: { id: 'user-1', tenantId: 'tenant-1' },
        target: {
          agentId: 'agent-1',
          ...(!scheduled && {
            conversationId: 'conversation-1',
            parentMessageId: 'assistant-1',
          }),
        },
        event: {
          id: 'event-1',
          type: eventType,
          occurredAt: 1_000,
          source: { id: source, type: scheduled ? source : 'internal' },
          payload: { spec: 'forged-spec' },
        },
        input: 'Continue the turn',
      });

      await expect(host.dispatch(envelope)).resolves.toMatchObject({ status: 'started' });
      expect(admitted).toMatchObject({ spec: savedSpec.name, agent_id: 'agent-1' });
      expect(getConvo).toHaveBeenCalledTimes(scheduled ? 0 : 1);
    },
  );

  it.each([undefined, 'saved-agent', 'removed-spec'])(
    'runs the real guard for a signed binding with persisted spec %s',
    async (storedSpec) => {
      const bindingId = 'evtbind_test';
      const lineage = { parentConversationId: 'parent-1', parentAgentId: 'parent-agent' };
      const child = {
        user: 'user-1',
        tenantId: 'tenant-1',
        conversationId: 'actor-1',
        agent_id: 'agent-1',
        agentEventBinding: { bindingId, sourceKeyId: 'key-1', actorId: 'actor' },
        subagentThread: lineage,
        ...(storedSpec != null && { spec: storedSpec }),
      };
      const getConvo = jest.fn(async (_user, id) =>
        id === 'parent-1'
          ? { user: 'user-1', tenantId: 'tenant-1', conversationId: id, agent_id: 'parent-agent' }
          : child,
      );
      const getEventBinding = jest.fn(async () => ({
        conversationId: 'actor-1',
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        binding: child.agentEventBinding,
        lineage,
      }));
      const guard = createSubagentThreadTurnGuard({
        getConvo,
        getEventBinding,
        store: { isThreadActiveForOwner: () => false },
      });
      const host = createAgentTriggerExecutionHost({
        getBaseUrl: () => 'http://localhost:3080',
        mintToken: () => generateAgentTriggerToken('user-1'),
        fetch: async (_url, init) => {
          const req = createReq(JSON.parse(init.body), config);
          req.baseUrl = '/api/agents/chat';
          req.user = { id: 'user-1', tenantId: 'tenant-1' };
          const headers = Object.fromEntries(
            Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]),
          );
          req._isAgentTrigger = isAgentTriggerRequest({ headers });
          req.get = (name) => headers[name.toLowerCase()];
          const next = jest.fn();
          await guard(req, createRes(), next);
          expect(next).toHaveBeenCalledWith();
          expect(req._agentEventBindingId).toBe(bindingId);
          expect(req.resolvedConversation.user).toBe('user-1');
          expect(req.resolvedConversation.spec).toBe(storedSpec);
          next.mockClear();
          await buildEndpointOption(req, createRes(), next);
          if (storedSpec === 'removed-spec') {
            expect(next).not.toHaveBeenCalled();
            expect(handleError).toHaveBeenCalledWith(expect.anything(), {
              text: 'No model spec selected',
            });
          } else {
            expect(handleError).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledWith();
            expect(req.body.endpointOption).toMatchObject({
              spec: savedSpec.name,
              agent_id: 'agent-1',
            });
          }
          expect(getConvo).toHaveBeenCalledTimes(2);
          expect(getEventBinding).toHaveBeenCalledWith({
            user: 'user-1',
            tenantId: 'tenant-1',
            bindingId,
            sourceKeyId: 'key-1',
          });
          return new Response(
            JSON.stringify({ status: 'started', streamId: 'actor-1', conversationId: 'actor-1' }),
          );
        },
      });
      await host.dispatch(
        createAgentTriggerEnvelope({
          mode: 'continue',
          requestId: 'request-1',
          deliveryId: 'delivery-1',
          receivedAt: 1_000,
          principal: { id: 'user-1', tenantId: 'tenant-1' },
          target: {
            agentId: 'agent-1',
            conversationId: 'actor-1',
            parentMessageId: 'root',
            bindingId,
            sourceKeyId: 'key-1',
          },
          event: {
            id: 'event-1',
            type: 'remote.event',
            occurredAt: 1_000,
            source: { id: 'remote', type: 'api' },
          },
          input: 'Handle this event',
        }),
      );
    },
  );

  it('still refuses an ordinary request carrying forged continuation metadata and a trigger marker', async () => {
    const req = createReq(
      {
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
        conversationId: 'conversation-1',
        _isAgentTrigger: true,
        agentContinuationAdmission: { source: 'agent-queued-turn', spec: savedSpec.name },
        agentCompletion: { version: 1, sourceId: 'subagent-completion' },
        agentTrigger: {
          version: 1,
          event: {
            type: 'schedule.occurrence',
            occurredAt: 1_000,
            source: { type: 'schedule', id: 'schedule-1' },
          },
        },
      },
      config,
    );
    req.baseUrl = '/api/agents/chat';
    req.user = { id: 'user-1', tenantId: 'tenant-1' };
    req.resolvedConversation = conversation;
    req._isAgentTrigger = isAgentTriggerRequest({
      headers: { 'x-lc-agent-trigger': '1', authorization: 'Bearer forged' },
    });
    const res = createRes();
    const next = jest.fn();

    await buildEndpointOption(req, res, next);

    expect(handleError).toHaveBeenCalledWith(res, { text: 'No model spec selected' });
    expect(next).not.toHaveBeenCalled();
    expect(mockAgentBuildOptions).not.toHaveBeenCalled();
  });

  it.each(['explicit-invalid', 'wrong-endpoint'])(
    'does not replace a supplied %s spec on a signed continuation',
    async (selected) => {
      const req = createReq(
        { endpoint: EModelEndpoint.agents, agent_id: 'agent-1', spec: selected },
        {
          modelSpecs: {
            enforce: true,
            list: [
              savedSpec,
              { name: 'wrong-endpoint', preset: { endpoint: EModelEndpoint.openAI } },
            ],
          },
        },
      );
      req._isAgentTrigger = true;
      req.resolvedConversation = conversation;
      const res = createRes();
      const next = jest.fn();

      await buildEndpointOption(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, {
        text: selected === 'explicit-invalid' ? 'Invalid model spec' : 'Model spec mismatch',
      });
      expect(next).not.toHaveBeenCalled();
    },
  );
});
