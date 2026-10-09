const { EModelEndpoint } = require('librechat-data-provider');

jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: jest.fn(),
  getModelsConfig: jest.fn(),
}));

const { getEndpointsConfig, getModelsConfig } = require('~/server/services/Config');
const endpointController = require('~/server/controllers/EndpointController');

const custom = (extra = {}) => ({ order: 0, type: EModelEndpoint.custom, ...extra });

/** A request whose app config declares `name` as a filter-managed endpoint. */
const filtering = (...names) => ({
  config: {
    endpoints: {
      [EModelEndpoint.custom]: names.map((name) => ({
        name,
        models: { default: ['claude-sonnet-5'], fetch: true, filter: true },
      })),
    },
  },
});

const respond = async (req = filtering('Anthropic', 'Google')) => {
  const res = { send: jest.fn() };
  await endpointController(req, res);
  return JSON.parse(res.send.mock.calls[0][0]);
};

describe('endpointController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('withholds a filter-managed endpoint with no models available to the request', async () => {
    getEndpointsConfig.mockResolvedValue({ Anthropic: custom(), Google: custom() });
    getModelsConfig.mockResolvedValue({ Anthropic: ['claude-sonnet-5'], Google: [] });

    const body = await respond();

    expect(body.Anthropic).toBeDefined();
    expect(body).not.toHaveProperty('Google');
  });

  it('serves every endpoint when the models config cannot be resolved', async () => {
    getEndpointsConfig.mockResolvedValue({ Anthropic: custom(), Google: custom() });
    getModelsConfig.mockRejectedValue(new Error('gateway unreachable'));

    const body = await respond();

    expect(body.Anthropic).toBeDefined();
    expect(body.Google).toBeDefined();
  });

  /* The route is on the first-page-load path. A deployment that does not use
     `models.filter` must not start paying for a models resolution here. */
  it('never resolves the models config when no endpoint filters', async () => {
    getEndpointsConfig.mockResolvedValue({ Anthropic: custom(), Google: custom() });
    getModelsConfig.mockResolvedValue({ Anthropic: ['claude-sonnet-5'], Google: [] });

    const body = await respond({ config: { endpoints: { [EModelEndpoint.custom]: [] } } });

    expect(getModelsConfig).not.toHaveBeenCalled();
    expect(body.Anthropic).toBeDefined();
    expect(body.Google).toBeDefined();
  });
});
