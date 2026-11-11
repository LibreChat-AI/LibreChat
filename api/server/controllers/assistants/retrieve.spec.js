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
  assistantModels: ['public-first', 'public-second', 'public-second-extra'],
  assistantGroups: ['first', 'second'],
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
    expect(getOpenAIClient).toHaveBeenCalledWith({ req: { ...req, body: {} }, res });
    expect(req.body).toBeUndefined();
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

  it.each(['assistants', 'azureAssistants'])(
    'preserves the non-enumerable Express query when retrieving %s',
    async (endpoint) => {
      const req =
        endpoint === 'azureAssistants' ? makeAzureRequest('public-second') : makeRequest();
      req.baseUrl = `/api/${endpoint}/v2`;
      const query = { ...req.query, version: 'test-version' };
      Object.defineProperty(req, 'query', { value: query, writable: true, enumerable: false });
      const { getOpenAIClient: routeClient } = require('./helpers');
      const { initializeClient } = require(`~/server/services/Endpoints/${endpoint}`);
      initializeClient.mockResolvedValue({ openai: { beta: { assistants: { retrieve } } } });
      getOpenAIClient.mockImplementation(routeClient);

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: assistant.id }));
      expect(initializeClient).toHaveBeenCalledWith(
        expect.objectContaining({
          req: expect.objectContaining({ query }),
          res,
        }),
      );
      expect(Object.getOwnPropertyDescriptor(req, 'query').enumerable).toBe(false);
      expect(req.body).toBeUndefined();
    },
  );

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
  ])('maps requested model %s and deployment %s to %s', async (model, deployment, expected) => {
    const req = makeAzureRequest(model);
    retrieve.mockResolvedValue({ ...assistant, model: deployment });
    await handler(req, res);
    expect(getOpenAIClient).toHaveBeenCalledTimes(1);
    expect(getOpenAIClient).toHaveBeenCalledWith({ req: { ...req, body: { model } }, res });
    expect(res.json).toHaveBeenCalledWith({ ...assistant, model: expected });
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('Azure selection without a model', () => {
    const missing = () => Object.assign(new Error('PRIVATE-UPSTREAM-CONTENT'), { status: 404 });
    const firstRetrieve = jest.fn();
    const secondRetrieve = jest.fn();

    beforeEach(() => {
      firstRetrieve.mockReset().mockRejectedValue(missing());
      secondRetrieve.mockReset().mockResolvedValue({ ...assistant, model: 'deployment-second' });
      getOpenAIClient.mockImplementation(async ({ req }) => {
        await Promise.resolve();
        const retrieve = req.body.model === 'public-first' ? firstRetrieve : secondRetrieve;
        return { openai: { beta: { assistants: { retrieve } } } };
      });
    });

    it('finds an ID in the later group with isolated request-local routing', async () => {
      const req = makeAzureRequest();
      req.body = { endpoint: 'azureAssistants' };
      Object.freeze(req.body);
      await handler(req, res);
      expect(firstRetrieve).toHaveBeenCalledWith(assistant.id);
      expect(secondRetrieve).toHaveBeenCalledWith(assistant.id);
      expect(getOpenAIClient.mock.calls.map(([{ req }]) => req.body.model)).toEqual([
        'public-first',
        'public-second',
      ]);
      for (const [{ req: clientReq }] of getOpenAIClient.mock.calls) {
        expect(clientReq).not.toBe(req);
        expect(clientReq.body).not.toBe(req.body);
        expect(clientReq.config).toBe(req.config);
        expect(clientReq.user).toBe(req.user);
      }
      expect(getOpenAIClient.mock.calls[0][0].req.body).not.toBe(
        getOpenAIClient.mock.calls[1][0].req.body,
      );
      expect(req.body).toEqual({ endpoint: 'azureAssistants' });
      expect(res.json).toHaveBeenCalledWith({ ...assistant, model: 'public-second' });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('starts independent group lookups before either provider finishes', async () => {
      let finishFirst;
      secondRetrieve.mockImplementation(async () => {
        finishFirst();
        return { ...assistant, model: 'deployment-second' };
      });
      // A missing first group must finish only after the second lookup has started.
      firstRetrieve.mockImplementation(
        () =>
          new Promise((_, reject) => {
            finishFirst = () => reject(missing());
          }),
      );
      await handler(makeAzureRequest(), res);
      expect(firstRetrieve).toHaveBeenCalledTimes(1);
      expect(secondRetrieve).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ ...assistant, model: 'public-second' });
    });

    it('responds with an authorized later-group assistant while the first lookup is unsettled', async () => {
      let rejectFirst;
      firstRetrieve.mockReturnValue(
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
      );
      await handler(makeAzureRequest(), res);
      expect(firstRetrieve).toHaveBeenCalledTimes(1);
      expect(secondRetrieve).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ ...assistant, model: 'public-second' });
      expect(res.status).not.toHaveBeenCalled();

      rejectFirst(Object.assign(new Error('PRIVATE-UPSTREAM-CONTENT'), { status: 503 }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it.each(['first', 'second'])(
      'returns an authorized assistant despite a 503 in the unrelated %s group',
      async (failedGroup) => {
        const failed = failedGroup === 'first' ? firstRetrieve : secondRetrieve;
        const allowed = failedGroup === 'first' ? secondRetrieve : firstRetrieve;
        const allowedGroup = failedGroup === 'first' ? 'second' : 'first';
        failed.mockRejectedValue(
          Object.assign(new Error('PRIVATE-UPSTREAM-CONTENT'), { status: 503 }),
        );
        allowed.mockResolvedValue({ ...assistant, model: `deployment-${allowedGroup}` });
        await handler(makeAzureRequest(), res);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith({ ...assistant, model: `public-${allowedGroup}` });
        expect(res.status).not.toHaveBeenCalled();
      },
    );

    it('returns a safe 500 when the only retrieved assistant is denied and another group fails', async () => {
      const req = makeAzureRequest();
      req.config.endpoints.azureAssistants = { privateAssistants: true };
      firstRetrieve.mockRejectedValue(
        Object.assign(new Error('PRIVATE-UPSTREAM-CONTENT'), { status: 503 }),
      );
      await handler(req, res);
      expect(filter).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to load assistant' });
    });

    it('maps a later group’s alternate deployment to its public alias once per group', async () => {
      secondRetrieve.mockResolvedValue({ ...assistant, model: 'deployment-second-extra' });
      await handler(makeAzureRequest(), res);
      expect(getOpenAIClient).toHaveBeenCalledTimes(2);
      expect(secondRetrieve).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ ...assistant, model: 'public-second-extra' });
    });

    it.each([403, 404])(
      'returns an opaque 404 when every group is missing or denied (%s)',
      async (status) => {
        secondRetrieve.mockRejectedValue(Object.assign(missing(), { status }));
        await handler(makeAzureRequest(), res);
        expect(getOpenAIClient).toHaveBeenCalledTimes(2);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith(denial);
      },
    );

    it.each(['client', 'provider'])(
      'returns safe 500, not 404, for a transient %s error in one group',
      async (source) => {
        const error = Object.assign(new Error('PRIVATE-UPSTREAM-CONTENT'), { status: 500 });
        secondRetrieve.mockRejectedValue(missing());
        if (source === 'client') {
          getOpenAIClient.mockImplementation(async ({ req }) => {
            if (req.body.model === 'public-first') {
              throw error;
            }
            return { openai: { beta: { assistants: { retrieve: secondRetrieve } } } };
          });
        } else {
          firstRetrieve.mockRejectedValue(error);
        }
        await handler(makeAzureRequest(), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith({ error: 'Failed to load assistant' });
      },
    );

    it.each([
      { privateAssistants: true },
      { supportedIds: ['asst-other'] },
      { excludedIds: [assistant.id] },
    ])('does not disclose a later group’s assistant denied by %j', async (policy) => {
      const req = makeAzureRequest();
      req.config.endpoints.azureAssistants = policy;
      await handler(req, res);
      expect(hasCapability).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(denial);
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('PRIVATE-UPSTREAM-CONTENT');
    });

    it('preserves the management bypass for a private later-group assistant', async () => {
      const req = makeAzureRequest();
      req.config.endpoints.azureAssistants = { privateAssistants: true };
      hasCapability.mockResolvedValue(true);
      await handler(req, res);
      expect(hasCapability).toHaveBeenCalledTimes(1);
      expect(filter).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ ...assistant, model: 'public-second' });
    });

    it('keeps an explicit model pinned to its group even when the ID exists elsewhere', async () => {
      await handler(makeAzureRequest('public-first'), res);
      expect(getOpenAIClient).toHaveBeenCalledTimes(1);
      expect(firstRetrieve).toHaveBeenCalledWith(assistant.id);
      expect(secondRetrieve).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(denial);
    });

    it('searches only configured assistant groups', async () => {
      const req = makeAzureRequest();
      req.config.endpoints.azureOpenAI = { ...azureConfig, assistantGroups: ['first'] };
      await handler(req, res);
      expect(getOpenAIClient).toHaveBeenCalledTimes(1);
      expect(secondRetrieve).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
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
