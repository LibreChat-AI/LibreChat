import { isOpenIdConfigured } from './configured';

const REQUIRED_ENV = {
  OPENID_CLIENT_ID: 'client-id',
  OPENID_CLIENT_SECRET: 'client-secret',
  OPENID_ISSUER: 'https://issuer.example.com',
  OPENID_SCOPE: 'openid profile',
  OPENID_SESSION_SECRET: 'session-secret',
};

describe('isOpenIdConfigured', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is true when every required field is present and a client secret is set', () => {
    process.env = { ...process.env, ...REQUIRED_ENV, OPENID_USE_PKCE: undefined };
    expect(isOpenIdConfigured()).toBe(true);
  });

  it('is true with PKCE enabled and no client secret', () => {
    process.env = {
      ...process.env,
      ...REQUIRED_ENV,
      OPENID_CLIENT_SECRET: undefined,
      OPENID_USE_PKCE: 'true',
    };
    expect(isOpenIdConfigured()).toBe(true);
  });

  it('is false when neither PKCE nor a client secret is configured', () => {
    process.env = { ...process.env, ...REQUIRED_ENV, OPENID_CLIENT_SECRET: undefined };
    expect(isOpenIdConfigured()).toBe(false);
  });

  it('is false when a client secret is only whitespace', () => {
    process.env = { ...process.env, ...REQUIRED_ENV, OPENID_CLIENT_SECRET: '   ' };
    expect(isOpenIdConfigured()).toBe(false);
  });

  it.each(Object.keys(REQUIRED_ENV))('is false when %s is missing', (missingKey) => {
    process.env = { ...process.env, ...REQUIRED_ENV, [missingKey]: undefined };
    expect(isOpenIdConfigured()).toBe(false);
  });
});
