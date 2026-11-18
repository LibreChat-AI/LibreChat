import jwksRsa from 'jwks-rsa';
import type { Agent } from 'http';
import { createLogoutJwksKeyResolver } from './jwks';

const mockGetSigningKey = jest.fn();

jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: mockGetSigningKey })));

const mockJwksRsa = jwksRsa as unknown as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

it('builds the client once with caching and a rate limit, and reuses it across calls', async () => {
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  const getJwksUri = jest.fn(() => 'https://idp.example.com/jwks');
  const getCacheMaxAgeMs = jest.fn(() => 60000);

  const resolveSigningKey = createLogoutJwksKeyResolver({ getJwksUri, getCacheMaxAgeMs });
  const first = await resolveSigningKey('kid-1');
  const second = await resolveSigningKey('kid-2');

  expect(first).toBe('public-key');
  expect(second).toBe('public-key');
  expect(getJwksUri).toHaveBeenCalledTimes(1);
  expect(mockJwksRsa).toHaveBeenCalledTimes(1);
  expect(mockJwksRsa).toHaveBeenCalledWith(
    expect.objectContaining({
      jwksUri: 'https://idp.example.com/jwks',
      cache: true,
      cacheMaxAge: 60000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    }),
  );
  expect(mockGetSigningKey).toHaveBeenNthCalledWith(1, 'kid-1');
  expect(mockGetSigningKey).toHaveBeenNthCalledWith(2, 'kid-2');
});

it('retries building the client on the next call after a failure, instead of sticking', async () => {
  const getJwksUri = jest
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('discovery unavailable');
    })
    .mockImplementationOnce(() => 'https://idp.example.com/jwks');
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });

  const resolveSigningKey = createLogoutJwksKeyResolver({
    getJwksUri,
    getCacheMaxAgeMs: () => 60000,
  });

  await expect(resolveSigningKey('kid-1')).rejects.toThrow('discovery unavailable');
  await expect(resolveSigningKey('kid-1')).resolves.toBe('public-key');
  expect(getJwksUri).toHaveBeenCalledTimes(2);
  expect(mockJwksRsa).toHaveBeenCalledTimes(1);
});

it('passes the injected cache age and proxy agent through to the jwks-rsa client options', async () => {
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  const getJwksUri = jest.fn(() => 'https://idp.example.com/jwks');
  const getCacheMaxAgeMs = jest.fn(() => 123456);
  const agent = {} as Agent;
  const getRequestAgent = jest.fn(() => agent);

  const resolveSigningKey = createLogoutJwksKeyResolver({
    getJwksUri,
    getCacheMaxAgeMs,
    getRequestAgent,
  });
  await resolveSigningKey('kid-1');

  expect(getCacheMaxAgeMs).toHaveBeenCalledTimes(1);
  expect(getRequestAgent).toHaveBeenCalledWith('https://idp.example.com/jwks');
  expect(mockJwksRsa).toHaveBeenCalledWith(
    expect.objectContaining({ cacheMaxAge: 123456, requestAgent: agent }),
  );
});

it('omits requestAgent when getRequestAgent resolves to no agent', async () => {
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  const getRequestAgent = jest.fn(() => undefined);

  const resolveSigningKey = createLogoutJwksKeyResolver({
    getJwksUri: () => 'https://idp.example.com/jwks',
    getCacheMaxAgeMs: () => 60000,
    getRequestAgent,
  });
  await resolveSigningKey('kid-1');

  expect(getRequestAgent).toHaveBeenCalledWith('https://idp.example.com/jwks');
  const [options] = mockJwksRsa.mock.calls[0];
  expect(options).not.toHaveProperty('requestAgent');
});
