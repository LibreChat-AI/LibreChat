const mockDataProvider = {
  Capabilities: {
    actions: 'actions',
    code_interpreter: 'code_interpreter',
    image_vision: 'image_vision',
    retrieval: 'retrieval',
    tools: 'tools',
  },
  EModelEndpoint: {
    agents: 'agents',
    anthropic: 'anthropic',
    assistants: 'assistants',
    azureAssistants: 'azureAssistants',
    azureOpenAI: 'azureOpenAI',
    bedrock: 'bedrock',
    google: 'google',
    openAI: 'openAI',
  },
  defaultAgentCapabilities: [],
  defaultRetrievalModels: [],
  defaultAssistantsVersion: {
    assistants: 1,
    azureAssistants: 2,
  },
  isAgentsEndpoint: (endpoint) => endpoint === 'agents',
  isAssistantsEndpoint: (endpoint) => endpoint === 'assistants' || endpoint === 'azureAssistants',
};

jest.mock(
  '@librechat/api',
  () => ({
    sendEvent: jest.fn(),
    isEnabled: (value) => value === true || value === 'true' || value === '1',
    isUserProvided: (value) => value === 'user_provided',
  }),
  { virtual: true },
);

jest.mock('librechat-data-provider', () => mockDataProvider, { virtual: true });

jest.mock('~/server/utils/handleText', () => ({
  generateConfig: (key) => (key ? { userProvide: key === 'user_provided' } : false),
}));

describe('EndpointService', () => {
  let originalEnv;
  const { EModelEndpoint } = mockDataProvider;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  function loadConfig(env) {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_USE_VERTEX;
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    delete process.env.BEDROCK_AWS_SESSION_TOKEN;
    delete process.env.BEDROCK_AWS_BEARER_TOKEN;
    delete process.env.BEDROCK_AWS_PROFILE;
    delete process.env.BEDROCK_AWS_DEFAULT_REGION;
    Object.assign(process.env, env);
    return require('../EndpointService').config;
  }

  it('does not require a user Anthropic API key when Vertex AI is enabled by env', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'user_provided',
      ANTHROPIC_USE_VERTEX: 'true',
    });

    expect(config[EModelEndpoint.anthropic]).toEqual({ userProvide: false });
  });

  it('requires a user Anthropic API key when user_provided is set without Vertex AI', () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: 'user_provided',
    });

    expect(config[EModelEndpoint.anthropic]).toEqual({ userProvide: true });
  });

  it('requires a user Bedrock key when bearer token user_provided is set with a legacy static secret', () => {
    const config = loadConfig({
      BEDROCK_AWS_SECRET_ACCESS_KEY: 'legacy-secret',
      BEDROCK_AWS_BEARER_TOKEN: 'user_provided',
      BEDROCK_AWS_DEFAULT_REGION: 'us-east-1',
    });

    expect(config[EModelEndpoint.bedrock]).toEqual({ userProvide: true });
  });

  it('enables Bedrock with static bearer token before static secret credentials', () => {
    const config = loadConfig({
      BEDROCK_AWS_SECRET_ACCESS_KEY: 'legacy-secret',
      BEDROCK_AWS_BEARER_TOKEN: 'bedrock-api-key',
      BEDROCK_AWS_DEFAULT_REGION: 'us-east-1',
    });

    expect(config[EModelEndpoint.bedrock]).toEqual({ userProvide: false });
  });

  it('skips blank optional Bedrock env vars before falling back to region', () => {
    const config = loadConfig({
      BEDROCK_AWS_BEARER_TOKEN: '',
      BEDROCK_AWS_PROFILE: '',
      BEDROCK_AWS_DEFAULT_REGION: 'us-east-1',
    });

    expect(config[EModelEndpoint.bedrock]).toEqual({ userProvide: false });
  });
});
