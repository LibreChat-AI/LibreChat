jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  fetchModels: jest.fn(),
}));
jest.mock('./app');
jest.mock('~/models', () => ({
  getUserKeyValues: jest.fn(),
  initializeMessageBudget: jest.fn(),
  initializeChannelStorageConfig: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { resolveModelCatalogKey } = require('librechat-data-provider');
const { createModelsService, fetchModels } = require('@librechat/api');
const { getUserKeyValues } = require('~/models');
const loadDefaultModels = require('./loadDefaultModels');
const loadConfigModels = require('./loadConfigModels');

/**
 * The per-endpoint catalog agents are validated against, compared with the full catalog through
 * the loaders the app wires: the aggregate default loader, `loadConfigModels` and the service. Only
 * what leaves the process is replaced: the provider model request (`fetchModels`), the user key
 * store and the config service. `getEndpointModelsConfig` must read the entry the full catalog holds.
 */

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_MODELS',
  'OPENAI_REVERSE_PROXY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODELS',
  'ANTHROPIC_REVERSE_PROXY',
  'GOOGLE_MODELS',
  'BEDROCK_AWS_MODELS',
  'AZURE_OPENAI_MODELS',
  'ASSISTANTS_MODELS',
  'ASSISTANTS_BASE_URL',
  'ENDPOINTS',
];

const customEndpoints = [
  {
    name: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    models: { default: ['llama3.2'], fetch: false },
  },
  {
    name: 'My Proxy',
    baseURL: 'https://proxy.example/v1',
    apiKey: 'proxy-key',
    models: { default: ['proxy-model'], fetch: false },
  },
  {
    name: 'Fetching',
    baseURL: 'https://fetch.example/v1',
    apiKey: 'fetch-key',
    headers: { 'X-Team': 'ml' },
    models: { default: ['fallback'], fetch: true },
  },
  {
    name: 'Personal',
    baseURL: 'https://personal.example/v1',
    apiKey: 'user_provided',
    models: { default: ['personal-fallback'], fetch: true },
  },
  { name: 'Unserved', baseURL: 'https://unserved.example/v1', apiKey: 'unserved-key' },
];

/** Every provider an agent can be saved with, in the spellings the catalog lookup resolves. */
const providers = [
  'openAI',
  'anthropic',
  'google',
  'vertexai',
  'azureOpenAI',
  'assistants',
  'bedrock',
  'Ollama',
  'ollama',
  'OLLAMA',
  'My Proxy',
  'my proxy',
  'Fetching',
  'Personal',
  'Unserved',
  'Unknown',
];

const variants = [
  ['built-in defaults', {}, {}, { Ollama: ['llama3.2'], 'My Proxy': ['proxy-model'] }],
  [
    'environment lists',
    {},
    {
      OPENAI_MODELS: 'env-gpt',
      ANTHROPIC_MODELS: 'env-claude',
      GOOGLE_MODELS: 'env-gemini',
      BEDROCK_AWS_MODELS: 'env-bedrock',
      AZURE_OPENAI_MODELS: 'env-azure',
      ASSISTANTS_MODELS: 'env-assistant',
    },
    {
      openAI: ['env-gpt'],
      anthropic: ['env-claude'],
      google: ['env-gemini'],
      bedrock: ['env-bedrock'],
      azureOpenAI: ['env-azure'],
      assistants: ['env-assistant'],
    },
  ],
  [
    'configured lists',
    {
      openAI: { models: ['cfg-gpt'] },
      anthropic: { models: ['cfg-claude'] },
      google: { models: ['cfg-gemini'] },
      bedrock: { models: ['cfg-bedrock'] },
    },
    { OPENAI_MODELS: 'env-gpt' },
    {
      openAI: ['cfg-gpt'],
      anthropic: ['cfg-claude'],
      google: ['cfg-gemini'],
      bedrock: ['cfg-bedrock'],
    },
  ],
  [
    'Vertex model names',
    { anthropic: { vertexConfig: { modelNames: ['vertex-claude'] } } },
    {},
    { anthropic: ['vertex-claude'] },
  ],
  [
    'Azure model names',
    { azureOpenAI: { modelNames: ['azure-deployment'] } },
    {},
    { azureOpenAI: ['azure-deployment'] },
  ],
  [
    'user provided keys',
    {},
    { OPENAI_API_KEY: 'user_provided', ANTHROPIC_API_KEY: 'user_provided' },
  ],
  ['built-ins that ENDPOINTS does not enable', {}, { ENDPOINTS: 'agents' }],
];

const lookup = (catalog, provider) => catalog[resolveModelCatalogKey(provider, catalog)];

describe('per-endpoint model catalog against the full catalog, with the real loaders', () => {
  const saved = {};
  const service = createModelsService({
    getAppConfig: async () => {
      throw new Error('the config is on the request');
    },
    loadDefaultModels,
    loadConfigModels,
    loadAsyncEndpoints: async () => ({}),
    defaultEndpointsConfig: {},
  });
  const requestFor = (endpoints) => ({
    user: { id: 'user-1' },
    config: { endpoints: { custom: customEndpoints, ...endpoints } },
    query: {},
    body: {},
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    fetchModels.mockResolvedValue(['fetched-a', 'fetched-b']);
    getUserKeyValues.mockResolvedValue({ apiKey: 'personal-key' });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it.each(variants)(
    'reads the entry the full catalog holds with %s',
    async (_label, endpoints, env, anchors = {}) => {
      Object.assign(process.env, env);
      const full = await service.loadModels(requestFor(endpoints));
      const read = {};
      const expected = {};
      for (const provider of providers) {
        read[provider] = lookup(
          await service.getEndpointModelsConfig(requestFor(endpoints), provider),
          provider,
        );
        expected[provider] = lookup(full, provider);
      }

      expect(read).toEqual(expected);
      expect(read).toMatchObject({ ...anchors, Fetching: ['fetched-a', 'fetched-b'] });
      expect(read.openAI).toEqual(expect.any(Array));
      expect(read.Unknown).toBeUndefined();
      expect(read.Unserved).toBeUndefined();
    },
  );

  it.each(['Fetching', 'Personal'])(
    'asks the provider for %s exactly as the full catalog does',
    async (name) => {
      await service.loadModels(requestFor({}));
      const full = fetchModels.mock.calls.map(([params]) => params).filter((p) => p.name === name);
      fetchModels.mockClear();

      await service.getEndpointModelsConfig(requestFor({}), name);
      const scoped = fetchModels.mock.calls.map(([params]) => params);

      expect(full).toHaveLength(1);
      expect(scoped).toEqual(full);
    },
  );

  it('is not reproduced for Azure Assistants without assistantModels, which keeps the Assistants middleware on the full catalog', async () => {
    const full = await service.loadModels(requestFor({}));
    const entry = await service.getEndpointModelsConfig(requestFor({}), 'azureAssistants');

    expect(lookup(entry, 'azureAssistants')).not.toEqual(lookup(full, 'azureAssistants'));
  });
});
