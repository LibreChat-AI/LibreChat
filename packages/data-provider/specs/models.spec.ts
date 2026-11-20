import axios from 'axios';
import { getModels, getTokenConfig } from '../src/data-service';
import { models, tokenConfig } from '../src/api-endpoints';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

describe('model discovery transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('keeps the aggregate URL for old callers', async () => {
    const catalog = { openAI: ['gpt'], anthropic: ['claude'] };
    jest.mocked(axios.get).mockResolvedValueOnce({ data: catalog });
    await expect(getModels()).resolves.toEqual(catalog);
    expect(models()).toBe('/api/models');
    expect(axios.get).toHaveBeenLastCalledWith('/api/models', {});
  });

  it('encodes the exact endpoint identity once and retains the config response shape', async () => {
    const endpoint = 'My Proxy / A&B%';
    const catalog = { [endpoint]: ['model'] };
    jest.mocked(axios.get).mockResolvedValueOnce({ data: catalog });
    await expect(getModels(endpoint)).resolves.toEqual(catalog);
    expect(axios.get).toHaveBeenLastCalledWith(
      '/api/models?endpoint=My%20Proxy%20%2F%20A%26B%25',
      {},
    );
  });

  it('narrows an old server aggregate response to the requested endpoint', async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({
      data: { openAI: ['gpt'], anthropic: ['claude'] },
    });
    await expect(getModels('anthropic')).resolves.toEqual({ anthropic: ['claude'] });
  });

  it('keeps a missing endpoint empty without falling back to unrelated models', async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({ data: { openAI: ['gpt'] } });
    await expect(getModels('Unknown')).resolves.toEqual({ Unknown: [] });
  });

  it('does not turn an empty scoped endpoint into an aggregate request', () => {
    expect(models('')).toBe('/api/models?endpoint=');
  });

  it('propagates failures without presenting a fake catalog', async () => {
    jest.mocked(axios.get).mockRejectedValueOnce(new Error('unavailable'));
    await expect(getModels('openAI')).rejects.toThrow('unavailable');
  });
});

describe('token config transport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the aggregate token config for legacy callers', async () => {
    const config = { openAI: { model: { context: 32000 } }, Other: {} };
    jest.mocked(axios.get).mockResolvedValueOnce({ data: config });
    await expect(getTokenConfig()).resolves.toEqual(config);
    expect(axios.get).toHaveBeenLastCalledWith('/api/endpoints/token-config', {});
  });

  it('encodes the selector and narrows an old-server aggregate response', async () => {
    const endpoint = 'My Proxy / A&B%';
    const config = { [endpoint]: { model: { context: 32000 } }, Other: {} };
    jest.mocked(axios.get).mockResolvedValueOnce({ data: config });
    await expect(getTokenConfig(endpoint)).resolves.toEqual({ [endpoint]: config[endpoint] });
    expect(axios.get).toHaveBeenLastCalledWith(
      '/api/endpoints/token-config?endpoint=My%20Proxy%20%2F%20A%26B%25',
      {},
    );
  });

  it('does not widen an empty scoped selector to the aggregate', () => {
    expect(tokenConfig('')).toBe('/api/endpoints/token-config?endpoint=');
  });

  it('keeps missing token config endpoint-scoped', async () => {
    jest.mocked(axios.get).mockResolvedValueOnce({ data: { Other: {} } });
    await expect(getTokenConfig('Selected')).resolves.toEqual({ Selected: {} });
  });
});
