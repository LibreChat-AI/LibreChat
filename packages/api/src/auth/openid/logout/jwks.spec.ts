import jwksRsa from 'jwks-rsa';
import type { Agent } from 'http';
import type { LogoutJwksClientDeps } from './jwks';
import { createLogoutJwksKeyResolver } from './jwks';

const mockGetSigningKeys = jest.fn();

jest.mock('jwks-rsa', () => {
  const actual = jest.requireActual('jwks-rsa');
  const factory = jest.fn(() => ({ getSigningKeys: mockGetSigningKeys }));
  return Object.assign(factory, { SigningKeyNotFoundError: actual.SigningKeyNotFoundError });
});

const mockJwksRsa = jwksRsa as unknown as jest.Mock;

function signingKey(kid: string | undefined, publicKey = `public-key-${kid}`) {
  return { kid, getPublicKey: () => publicKey };
}

function makeResolver(overrides: Partial<LogoutJwksClientDeps> = {}) {
  return createLogoutJwksKeyResolver({
    getJwksUri: () => 'https://idp.example.com/jwks',
    getCacheMaxAgeMs: () => 60000,
    ...overrides,
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

it('builds one uncached client and leaves caching to the key-set cache', async () => {
  mockGetSigningKeys.mockResolvedValue([signingKey('kid-1')]);
  const getJwksUri = jest.fn(() => 'https://idp.example.com/jwks');
  const getCacheMaxAgeMs = jest.fn(() => 60000);

  const resolveKey = makeResolver({ getJwksUri, getCacheMaxAgeMs });
  await resolveKey('kid-1');
  await resolveKey('kid-1');

  expect(getJwksUri).toHaveBeenCalledTimes(1);
  expect(getCacheMaxAgeMs).toHaveBeenCalledTimes(1);
  expect(mockJwksRsa).toHaveBeenCalledTimes(1);
  expect(mockJwksRsa).toHaveBeenCalledWith({
    jwksUri: 'https://idp.example.com/jwks',
    cache: false,
  });
});

it('answers a known kid from the cached key set', async () => {
  mockGetSigningKeys.mockResolvedValue([signingKey('kid-1'), signingKey('kid-2')]);
  const resolveKey = makeResolver();

  await expect(resolveKey('kid-1')).resolves.toBe('public-key-kid-1');
  await expect(resolveKey('kid-2')).resolves.toBe('public-key-kid-2');
  expect(mockGetSigningKeys).toHaveBeenCalledTimes(1);
});

it('rejects many unknown kids from the cache with at most one fetch, and still resolves a known kid', async () => {
  mockGetSigningKeys.mockResolvedValue([signingKey('kid-1')]);
  const resolveKey = makeResolver();

  const unknown = Array.from({ length: 50 }, (_, i) => resolveKey(`junk-${i}-${Math.random()}`));
  const results = await Promise.allSettled(unknown);

  for (const result of results) {
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
      jwksRsa.SigningKeyNotFoundError,
    );
  }
  await expect(resolveKey('kid-1')).resolves.toBe('public-key-kid-1');
  expect(mockGetSigningKeys).toHaveBeenCalledTimes(1);
});

it('finds a newly rotated kid after the cache expires', async () => {
  let current = 1_000_000;
  mockGetSigningKeys
    .mockResolvedValueOnce([signingKey('kid-1')])
    .mockResolvedValueOnce([signingKey('kid-1'), signingKey('kid-2')]);
  const resolveKey = makeResolver({ now: () => current });

  await expect(resolveKey('kid-1')).resolves.toBe('public-key-kid-1');
  current += 59_999;
  await expect(resolveKey('kid-2')).rejects.toBeInstanceOf(jwksRsa.SigningKeyNotFoundError);
  expect(mockGetSigningKeys).toHaveBeenCalledTimes(1);

  current += 1;
  await expect(resolveKey('kid-2')).resolves.toBe('public-key-kid-2');
  expect(mockGetSigningKeys).toHaveBeenCalledTimes(2);
});

it('does not cache a failed fetch; the next call fetches again', async () => {
  mockGetSigningKeys
    .mockRejectedValueOnce(new Error('jwks unavailable'))
    .mockResolvedValueOnce([signingKey('kid-1')]);
  const resolveKey = makeResolver();

  await expect(resolveKey('kid-1')).rejects.toThrow('jwks unavailable');
  await expect(resolveKey('kid-1')).resolves.toBe('public-key-kid-1');
  expect(mockGetSigningKeys).toHaveBeenCalledTimes(2);
});

it('matches a token without a kid only when the key set has a single key', async () => {
  mockGetSigningKeys.mockResolvedValueOnce([signingKey('kid-1')]);
  await expect(makeResolver()(undefined)).resolves.toBe('public-key-kid-1');

  mockGetSigningKeys.mockResolvedValueOnce([signingKey('kid-1'), signingKey('kid-2')]);
  await expect(makeResolver()(undefined)).rejects.toBeInstanceOf(jwksRsa.SigningKeyNotFoundError);
});

it('retries building the client on the next call after a failure, instead of sticking', async () => {
  const getJwksUri = jest
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('discovery unavailable');
    })
    .mockImplementationOnce(() => 'https://idp.example.com/jwks');
  mockGetSigningKeys.mockResolvedValue([signingKey('kid-1')]);

  const resolveKey = makeResolver({ getJwksUri });

  await expect(resolveKey('kid-1')).rejects.toThrow('discovery unavailable');
  await expect(resolveKey('kid-1')).resolves.toBe('public-key-kid-1');
  expect(getJwksUri).toHaveBeenCalledTimes(2);
  expect(mockJwksRsa).toHaveBeenCalledTimes(1);
});

it('passes the proxy agent through to the jwks-rsa client options', async () => {
  mockGetSigningKeys.mockResolvedValue([signingKey('kid-1')]);
  const agent = {} as Agent;
  const getRequestAgent = jest.fn(() => agent);

  await makeResolver({ getRequestAgent })('kid-1');

  expect(getRequestAgent).toHaveBeenCalledWith('https://idp.example.com/jwks');
  expect(mockJwksRsa).toHaveBeenCalledWith(expect.objectContaining({ requestAgent: agent }));
});

it('omits requestAgent when getRequestAgent resolves to no agent', async () => {
  mockGetSigningKeys.mockResolvedValue([signingKey('kid-1')]);

  await makeResolver({ getRequestAgent: () => undefined })('kid-1');

  const [options] = mockJwksRsa.mock.calls[0];
  expect(options).not.toHaveProperty('requestAgent');
});
