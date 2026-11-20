// api/test/__mocks__/openid-client.js
module.exports = {
  Issuer: {
    discover: jest.fn().mockResolvedValue({
      Client: jest.fn().mockImplementation(() => ({
        authorizationUrl: jest.fn().mockReturnValue('mock_auth_url'),
        callback: jest.fn().mockResolvedValue({
          access_token: 'mock_access_token',
          id_token: 'mock_id_token',
          claims: () => ({
            sub: 'mock_sub',
            email: 'mock@example.com',
          }),
        }),
        userinfo: jest.fn().mockResolvedValue({
          sub: 'mock_sub',
          email: 'mock@example.com',
        }),
      })),
    }),
  },
  Strategy: jest.fn().mockImplementation(() => {
    // Store verify to call it if needed, or just mock the strategy behavior
    return { name: 'openid-mock-strategy' };
  }),
  custom: {
    setHttpOptionsDefaults: jest.fn(),
  },
  // Add any other exports from openid-client that are used directly
  // For example, if your code uses `client.Issuer.discover`, then mock `Issuer`
  // If it uses `new Strategy()`, then mock `Strategy`
  // Based on openidStrategy.js, it uses:
  // const client = require('openid-client'); -> client.discovery, client.fetchUserInfo, client.genericGrantRequest
  // const { Strategy: OpenIDStrategy } = require('openid-client/passport');
  // So the mock needs to cover these.
  // The provided mock in openidStrategy.spec.js is a good reference.

  // Simpler mock based on the spec file:
  discovery: jest.fn().mockResolvedValue({
    clientId: 'fake_client_id',
    clientSecret: 'fake_client_secret',
    issuer: 'https://fake-issuer.com',
    serverMetadata: jest.fn().mockReturnValue({
      jwks_uri: 'https://fake-issuer.com/.well-known/jwks.json',
      end_session_endpoint: 'https://fake-issuer.com/logout',
    }),
    Client: jest.fn().mockImplementation(() => ({
      authorizationUrl: jest.fn().mockReturnValue('mock_auth_url'),
      callback: jest.fn().mockResolvedValue({
        access_token: 'mock_access_token',
        id_token: 'mock_id_token',
        claims: () => ({
          sub: 'mock_sub',
          email: 'mock@example.com',
        }),
      }),
      userinfo: jest.fn().mockResolvedValue({
        sub: 'mock_sub',
        email: 'mock@example.com',
      }),
      grant: jest.fn().mockResolvedValue({ access_token: 'mock_grant_token' }), // For genericGrantRequest
    })),
  }),
  fetchUserInfo: jest.fn().mockResolvedValue({
    preferred_username: 'preferred_username',
  }),
  genericGrantRequest: jest
    .fn()
    .mockResolvedValue({ access_token: 'mock_grant_access_token', expires_in: 3600 }),
  customFetch: Symbol('customFetch'),
};
