jest.mock('~/server/services/Endpoints/azureAssistants', () => ({ initializeClient: jest.fn() }));
jest.mock('~/server/services/Endpoints/assistants', () => ({ initializeClient: jest.fn() }));
jest.mock('~/server/middleware/roles/capabilities', () => ({ hasCapability: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getEndpointsConfig: jest.fn() }));

const { SystemCapabilities } = require('@librechat/data-schemas');
const { createAssistantRetriever } = require('../../../../packages/api/src/assistants/retrieve');
const { filterAssistants } = require('./helpers');

const denial = { error: 'Assistant not found' };
const assistant = {
  id: 'asst-selected',
  model: 'gpt-4o',
  metadata: { author: 'user-other' },
  instructions: 'PRIVATE-UPSTREAM-CONTENT',
};

const azureConfig = {
  assistants: true,
  assistantModels: ['public-first'],
  modelGroupMap: {
    'public-first': { group: 'first' },
    'public-second': { group: 'second' },
    'public-second-extra': { group: 'second' },
  },
  groupMap: {
    first: { models: { 'public-first': { deploymentName: 'deployment-first' } } },
    second: {
      models: {
        'public-second': { deploymentName: 'deployment-second' },
        'public-second-extra': { deploymentName: 'deployment-second-extra' },
      },
    },
  },
};

const makeRequest = (assistantsConfig = {}) => ({
  params: { id: assistant.id },
  query: { endpoint: 'assistants' },
  user: { id: 'user-current', role: 'USER', tenantId: 'tenant-current' },
  config: { endpoints: { assistants: assistantsConfig } },
});

const makeAzureRequest = (model) => ({
  ...makeRequest(),
  query: { endpoint: 'azureAssistants', ...(model === undefined ? {} : { model }) },
  config: { endpoints: { azureAssistants: {}, azureOpenAI: azureConfig } },
});

describe('selected assistant retrieval', () => {
  const retrieve = jest.fn();
  const getOpenAIClient = jest.fn();
  const hasCapability = jest.fn();
  const filter = jest.fn(filterAssistants);
  const handler = createAssistantRetriever({
    getOpenAIClient,
    filterAssistants: filter,
    hasCapability,
  });
  let res;

  beforeEach(() => {
    retrieve.mockReset().mockResolvedValue(assistant);
    getOpenAIClient
      .mockReset()
      .mockResolvedValue({ openai: { beta: { assistants: { retrieve } } } });
    hasCapability.mockReset().mockResolvedValue(false);
    filter.mockClear();
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  });

  it('returns an allowed assistant using the request configuration and authenticated user', async () => {
    const req = makeRequest({ supportedIds: [assistant.id] });
    await handler(req, res);
    expect(getOpenAIClient).toHaveBeenCalledWith({ req, res });
    expect(req.body).toEqual({});
    expect(retrieve).toHaveBeenCalledWith(assistant.id);
    expect(hasCapability).toHaveBeenCalledWith(req.user, SystemCapabilities.MANAGE_ASSISTANTS);
    expect(filter).toHaveBeenCalledWith({
      assistants: [assistant],
      userId: req.user.id,
      assistantsConfig: req.config.endpoints.assistants,
    });
    expect(res.json).toHaveBeenCalledWith(assistant);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    { privateAssistants: true },
    { supportedIds: ['asst-other'] },
    { excludedIds: [assistant.id] },
  ])('safely denies an assistant filtered by %j', async (policy) => {
    await handler(makeRequest(policy), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(denial);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('PRIVATE-UPSTREAM-CONTENT');
  });

  it('returns a private assistant authored by the authenticated user', async () => {
    const req = makeRequest({ privateAssistants: true });
    const owned = { ...assistant, metadata: { author: req.user.id } };
    retrieve.mockResolvedValue(owned);
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith(owned);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    { privateAssistants: true },
    { supportedIds: ['asst-other'] },
    { excludedIds: [assistant.id] },
  ])('preserves the management capability bypass for %j', async (policy) => {
    const req = makeRequest(policy);
    hasCapability.mockResolvedValue(true);
    await handler(req, res);
    expect(hasCapability).toHaveBeenCalledWith(req.user, SystemCapabilities.MANAGE_ASSISTANTS);
    expect(filter).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(assistant);
  });

  it.each([
    { privateAssistants: true },
    { supportedIds: ['asst-other'] },
    { excludedIds: [assistant.id] },
  ])('does not bypass %j during a transient capability failure', async (policy) => {
    hasCapability.mockRejectedValue(new Error('PRIVATE-CAPABILITY-ERROR'));
    await handler(makeRequest(policy), res);
    expect(filter).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(denial);
  });

  it('still allows normal filtered access when the capability service fails', async () => {
    hasCapability.mockRejectedValue(new Error('PRIVATE-CAPABILITY-ERROR'));
    await handler(makeRequest({ supportedIds: [assistant.id] }), res);
    expect(filter).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(assistant);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([{}, { endpoints: {} }])(
    'matches listing when the endpoint config is absent: %j',
    async (config) => {
      await handler({ ...makeRequest(), config }, res);
      expect(res.json).toHaveBeenCalledWith(assistant);
      expect(hasCapability).not.toHaveBeenCalled();
      expect(filter).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['public-second', 'deployment-second', 'public-second'],
    ['public-second', 'deployment-second-extra', 'public-second-extra'],
    ['public-second-extra', 'deployment-second', 'public-second'],
    ['public-second', 'unknown-deployment', 'public-second'],
    [undefined, 'deployment-first', 'public-first'],
  ])('maps requested model %s and deployment %s to %s', async (model, deployment, expected) => {
    const req = makeAzureRequest(model);
    retrieve.mockResolvedValue({ ...assistant, model: deployment });
    await handler(req, res);
    expect(getOpenAIClient).toHaveBeenCalledWith({ req, res });
    expect(res.json).toHaveBeenCalledWith({ ...assistant, model: expected });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('maps a group-wide deployment to that configured group’s first public model', async () => {
    const req = makeAzureRequest('public-second-extra');
    req.config.endpoints.azureOpenAI = {
      ...azureConfig,
      groupMap: {
        ...azureConfig.groupMap,
        second: { ...azureConfig.groupMap.second, deploymentName: 'group-deployment' },
      },
    };
    retrieve.mockResolvedValue({ ...assistant, model: 'group-deployment' });
    await handler(req, res);
    expect(res.json).toHaveBeenCalledWith({ ...assistant, model: 'public-second' });
  });

  it.each(['unknown-model', '', 'https://untrusted.example/private'])(
    'does not default an explicit unconfigured model: %s',
    async (model) => {
      await handler(makeAzureRequest(model), res);
      expect(getOpenAIClient).not.toHaveBeenCalled();
      expect(retrieve).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(denial);
    },
  );

  it.each(['client', 'provider'])(
    'returns only a safe 500 for an unexpected private %s error',
    async (source) => {
      const error = new Error('PRIVATE-UPSTREAM-CONTENT https://private.example/secret');
      if (source === 'client') {
        getOpenAIClient.mockRejectedValue(error);
      } else {
        retrieve.mockRejectedValue(error);
      }
      await handler(makeRequest(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to load assistant' });
    },
  );
});

it('keeps an actual provider 404 opaque', async () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const handler = createAssistantRetriever({
    getOpenAIClient: jest.fn(async () => {
      throw Object.assign(new Error('private'), { status: 404 });
    }),
    filterAssistants,
    hasCapability: jest.fn(async () => false),
  });
  await handler(makeRequest(), res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith(denial);
});
