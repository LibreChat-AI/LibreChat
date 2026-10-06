const mockGetReasoningCapabilities = jest.fn();
jest.mock('@librechat/api', () => ({
  getReasoningCapabilities: (...args) => mockGetReasoningCapabilities(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const reasoningCapabilitiesController = require('./ReasoningCapabilitiesController');

const createRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('reasoningCapabilitiesController', () => {
  const req = { config: { endpoints: {} } };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the capabilities when every catalog was read', async () => {
    const capabilities = { OpenRouter: { 'a/b': { efforts: ['low'] } } };
    mockGetReasoningCapabilities.mockResolvedValue({ capabilities, unavailable: [] });
    const res = createRes();

    await reasoningCapabilitiesController(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(capabilities);
  });

  it('answers 503 with a stable code when a catalog is unavailable', async () => {
    mockGetReasoningCapabilities.mockResolvedValue({
      capabilities: {},
      unavailable: ['OpenRouter'],
    });
    const res = createRes();

    await reasoningCapabilitiesController(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'reasoning_catalog_unavailable' });
  });

  it('does not expose the unavailable endpoint names', async () => {
    mockGetReasoningCapabilities.mockResolvedValue({
      capabilities: {},
      unavailable: ['Internal Gateway'],
    });
    const res = createRes();

    await reasoningCapabilitiesController(req, res);

    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Internal Gateway');
  });

  it('answers 500 without the error text when resolution throws', async () => {
    mockGetReasoningCapabilities.mockRejectedValue(new Error('secret detail'));
    const res = createRes();

    await reasoningCapabilitiesController(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret detail');
  });
});
