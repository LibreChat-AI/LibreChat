import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { fetch as undiciFetch } from 'undici';
import type { JwtPayload, VerifyOptions } from 'jsonwebtoken';
import { clearOidcAccessTokenCache, verifyOidcAccessToken } from './oidc';

const mockGetSigningKey = jest.fn();

jest.mock('jwks-rsa', () => jest.fn(() => ({ getSigningKey: mockGetSigningKey })));
jest.mock('undici', () => ({ fetch: jest.fn() }));
jest.mock('jsonwebtoken', () => ({ decode: jest.fn(), verify: jest.fn() }));
jest.mock('~/utils', () => ({ isEnabled: jest.fn(() => true), math: jest.fn(() => 60000) }));
jest.mock('~/utils/proxy', () => ({
  getEnvProxyDispatcher: jest.fn(),
  getHttpsProxyAgent: jest.fn(),
}));

const mockFetch = undiciFetch as jest.Mock;
const mockDecode = jwt.decode as jest.Mock;
const mockVerify = jwt.verify as jest.Mock;
const originalOpenIdJwksUrl = process.env.OPENID_JWKS_URL;
type JwtVerifyCallback = (error: Error | null, payload?: JwtPayload) => void;

afterEach(() => {
  clearOidcAccessTokenCache();
  jest.clearAllMocks();
  if (originalOpenIdJwksUrl == null) {
    delete process.env.OPENID_JWKS_URL;
  } else {
    process.env.OPENID_JWKS_URL = originalOpenIdJwksUrl;
  }
});

it('does not use the interactive OpenID JWKS override unless explicitly enabled', async () => {
  const issuer = 'https://management-issuer.example.com';
  const discoveredJwksUri = `${issuer}/jwks`;
  process.env.OPENID_JWKS_URL = 'https://interactive-login.example.com/jwks';
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jwks_uri: discoveredJwksUri }),
  });
  mockDecode.mockReturnValue({ header: { kid: 'management-key' } });
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  mockVerify.mockImplementation(
    (_token: string, _key: string, _options: object, callback: JwtVerifyCallback) =>
      callback(null, { sub: 'machine-client@clients' } satisfies JwtPayload),
  );

  await verifyOidcAccessToken('access-token', {
    issuer,
    audience: 'agent-management',
  });

  expect(mockFetch).toHaveBeenCalledWith(
    `${issuer}/.well-known/openid-configuration`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(jwksRsa).toHaveBeenCalledWith(
    expect.objectContaining({
      jwksUri: discoveredJwksUri,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    }),
  );
  expect(mockVerify).toHaveBeenCalledWith(
    'access-token',
    'public-key',
    expect.objectContaining({ audience: 'agent-management' }),
    expect.any(Function),
  );
});

it('does not reuse an interactive OpenID JWKS override for a machine-token caller', async () => {
  const issuer = 'https://shared-issuer.example.com';
  const interactiveJwksUri = 'https://interactive-login.example.com/jwks';
  const discoveredJwksUri = `${issuer}/machine-jwks`;
  process.env.OPENID_JWKS_URL = interactiveJwksUri;
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jwks_uri: discoveredJwksUri }),
  });
  mockDecode.mockReturnValue({ header: { kid: 'shared-key' } });
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  mockVerify.mockImplementation(
    (_token: string, _key: string, _options: object, callback: JwtVerifyCallback) =>
      callback(null, { sub: 'machine-client@clients' } satisfies JwtPayload),
  );
  const config = { issuer, audience: 'agent-management' };

  await verifyOidcAccessToken('interactive-token', config, { useOpenIdJwksEnv: true });
  await verifyOidcAccessToken('machine-token', config);

  expect(jwksRsa).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ jwksUri: interactiveJwksUri }),
  );
  expect(jwksRsa).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ jwksUri: discoveredJwksUri }),
  );
});

it('validates a Cognito access token without requiring an aud claim', async () => {
  const issuer = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_example';
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jwks_uri: `${issuer}/.well-known/jwks.json` }),
  });
  mockDecode.mockReturnValue({ header: { kid: 'cognito-key' } });
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  mockVerify.mockImplementation(
    (_token: string, _key: string, options: VerifyOptions, callback: JwtVerifyCallback) => {
      expect(options).not.toHaveProperty('audience');
      callback(null, {
        client_id: 'machine-client',
        token_use: 'access',
        scope: 'agents-api/manage another-scope',
      } satisfies JwtPayload);
    },
  );

  await expect(
    verifyOidcAccessToken('cognito-access-token', {
      issuer,
      tokenUse: 'access',
      requiredScopes: ['agents-api/manage'],
    }),
  ).resolves.toMatchObject({ client_id: 'machine-client' });
});

it.each([
  ['the token type is wrong', { token_use: 'id', scope: 'agents-api/manage' }],
  ['a required scope is missing', { token_use: 'access', scope: 'another-scope' }],
])('rejects a Cognito token when %s', async (_case, claims) => {
  const issuer = 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_example';
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ jwks_uri: `${issuer}/.well-known/jwks.json` }),
  });
  mockDecode.mockReturnValue({ header: { kid: 'cognito-key' } });
  mockGetSigningKey.mockResolvedValue({ getPublicKey: () => 'public-key' });
  mockVerify.mockImplementation(
    (_token: string, _key: string, _options: VerifyOptions, callback: JwtVerifyCallback) =>
      callback(null, claims satisfies JwtPayload),
  );

  await expect(
    verifyOidcAccessToken('cognito-access-token', {
      issuer,
      tokenUse: 'access',
      requiredScopes: ['agents-api/manage'],
    }),
  ).rejects.toThrow();
});
