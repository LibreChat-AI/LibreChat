const mockPause = jest.fn();

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: new Proxy(actual.GenerationJobManager, {
      get: (target, key) =>
        key === 'approvals' ? { pause: (...args) => mockPause(...args) } : target[key],
    }),
  };
});

const { EModelEndpoint } = require('librechat-data-provider');
const AgentClient = require('~/server/controllers/agents/client');

const modelSpecs = {
  list: [
    {
      name: 'litellm-model-router',
      label: 'Claude Auto',
      litellmRoutedModel: { showOnResponses: true },
      preset: { endpoint: 'AnthropicClaude', model: 'litellm-model-router' },
    },
    {
      name: 'claude-sonnet',
      label: 'Claude Sonnet',
      preset: { endpoint: 'AnthropicClaude', model: 'claude-sonnet-5-5' },
    },
  ],
};

const ADDED_ID = 'AnthropicClaude__litellm-model-router___Claude____1';

const makeAgent = (id, model) => ({
  id,
  endpoint: 'AnthropicClaude',
  provider: EModelEndpoint.openAI,
  model_parameters: { model },
  tools: [],
});

const createClient = (spec, model = 'claude-sonnet-5-5', addedSpec) => {
  const agent = makeAgent('ephemeral', model);
  const client = new AgentClient({
    req: {
      user: { id: 'user-123' },
      body: { endpoint: EModelEndpoint.agents },
      config: { modelSpecs },
    },
    res: {},
    spec,
    addedSpec,
    agent,
    endpoint: EModelEndpoint.agents,
    endpointTokenConfig: {},
    eventHandlers: {},
    contentParts: [],
    collectedUsage: [],
    artifactPromises: [],
  });
  /** The sink `createRun` receives for the primary agent. */
  client.primarySink = () => client.litellmModelCapture.getSink(agent);
  return client;
};

describe('AgentClient LiteLLM model label', () => {
  it('captures for a spec that sets litellmRoutedModel.showOnResponses', () => {
    expect(createClient('litellm-model-router').primarySink()).toEqual({});
  });

  it("captures for a specless chat on the flagged spec's endpoint and model", () => {
    expect(createClient(undefined, 'litellm-model-router').primarySink()).toEqual({});
  });

  it('does not capture for a spec without the flag or an unflagged model', () => {
    expect(createClient('claude-sonnet').primarySink()).toBeUndefined();
    expect(createClient(undefined).primarySink()).toBeUndefined();
  });

  it('persists the captured model with the spec that enabled it', () => {
    const client = createClient('litellm-model-router');
    client.primarySink().modelName = 'bedrock/claude-sonnet-5-5';

    expect(client.buildResponseMetadata()).toEqual(
      expect.objectContaining({
        litellmModelName: 'bedrock/claude-sonnet-5-5',
        litellmRoutedModelSpec: 'litellm-model-router',
      }),
    );
  });

  it("persists the matched spec's name for a specless chat", () => {
    const client = createClient(undefined, 'litellm-model-router');
    client.primarySink().modelName = 'bedrock/claude-sonnet-5-5';

    expect(client.buildResponseMetadata()?.litellmRoutedModelSpec).toBe('litellm-model-router');
  });

  it('persists an added router agent under its id when the primary is not the router', () => {
    const client = createClient('claude-sonnet');
    client.litellmModelCapture.getSink(makeAgent(ADDED_ID, 'litellm-model-router')).modelName =
      'bedrock/claude-haiku-5-5';

    const metadata = client.buildResponseMetadata();
    expect(metadata?.litellmModelName).toBeUndefined();
    expect(metadata?.litellmAgentModels).toEqual([
      {
        agentId: ADDED_ID,
        modelName: 'bedrock/claude-haiku-5-5',
        spec: 'litellm-model-router',
      },
    ]);
  });

  it("resolves an added agent by the added conversation's spec", () => {
    const client = createClient('claude-sonnet', 'claude-sonnet-5-5', 'claude-sonnet');

    expect(
      client.litellmModelCapture.getSink(makeAgent(ADDED_ID, 'litellm-model-router')),
    ).toBeUndefined();
  });

  it('omits both fields when nothing was captured', () => {
    expect(createClient('claude-sonnet').buildResponseMetadata()?.litellmModelName).toBeUndefined();
    const enabled = createClient('litellm-model-router');
    enabled.primarySink();
    expect(enabled.buildResponseMetadata()?.litellmModelName).toBeUndefined();
    expect(enabled.buildResponseMetadata()?.litellmRoutedModelSpec).toBeUndefined();
  });

  it('omits both fields when the final call carried no header', () => {
    const client = createClient('litellm-model-router');
    client.primarySink().modelName = undefined;

    const metadata = client.buildResponseMetadata();
    expect(metadata?.litellmModelName).toBeUndefined();
    expect(metadata?.litellmRoutedModelSpec).toBeUndefined();
  });
});

describe('AgentClient LiteLLM models across a HITL pause', () => {
  it('persists the staged served models with the pause projection', async () => {
    mockPause.mockResolvedValue(false);
    const litellmModels = [{ agentId: ADDED_ID, modelName: 'bedrock/claude-haiku-5-5' }];
    const self = {
      stagedApproval: {
        streamId: 'conversation-1',
        pendingAction: { actionId: 'action-1', expiresAt: Date.now() + 60_000 },
        discoveredTools: [],
        litellmModels,
      },
      pendingApproval: null,
      jobCreatedAt: 123,
    };

    await AgentClient.prototype.publishStagedApproval.call(self);

    expect(mockPause).toHaveBeenCalledWith(
      'conversation-1',
      self.stagedApproval.pendingAction,
      expect.objectContaining({ litellmModels }),
    );
  });
});
