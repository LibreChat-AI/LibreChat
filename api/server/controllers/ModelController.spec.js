const mockGetModelsConfig = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('~/server/services/Config', () => ({
  getModelsConfig: (...args) => mockGetModelsConfig(...args),
}));

const { modelController } = require('./ModelController');

describe('ModelController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /* The merge, its concurrency and the per-request memo are covered where they
     live: services/Config/__tests__/getModelsConfig.spec.js. */
  it('sends the resolved config and does not resolve it twice', async () => {
    const req = { user: { id: 'user-1' } };
    const res = { send: jest.fn() };
    mockGetModelsConfig.mockResolvedValue({ openAI: ['gpt-4o'] });

    await modelController(req, res);

    expect(res.send).toHaveBeenCalledWith({ openAI: ['gpt-4o'] });
    expect(mockGetModelsConfig).toHaveBeenCalledTimes(1);
  });
});
