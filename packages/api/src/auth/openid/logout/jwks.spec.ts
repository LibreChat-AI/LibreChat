import jwksRsa from 'jwks-rsa';
import { createLogoutJwksKeyResolver } from './jwks';

const mockGetSigningKey = jest.fn();

jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: mockGetSigningKey })));
jest.mock('~/utils/math', () => ({ math: jest.fn(() => 60000) }));
jest.mock('~/utils/proxy', () => ({ getHttpsProxyAgent: jest.fn() }));

const mockJwksRsa = jwksRsa as unknown as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

it('builds the client once with caching and a rate limit, and reuses it across calls', async () => {
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  const getJwksUri = jest.fn(() => 'https://idp.example.com/jwks');

  const resolveSigningKey = createLogoutJwksKeyResolver({ getJwksUri });
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

  const resolveSigningKey = createLogoutJwksKeyResolver({ getJwksUri });

  await expect(resolveSigningKey('kid-1')).rejects.toThrow('discovery unavailable');
  await expect(resolveSigningKey('kid-1')).resolves.toBe('public-key');
  expect(getJwksUri).toHaveBeenCalledTimes(2);
  expect(mockJwksRsa).toHaveBeenCalledTimes(1);
});
