import { fetch as undiciFetch } from 'undici';
import {
  fetchOAuth2UserInfo,
  resolveOAuth2Subject,
  buildOAuth2StrategyOptions,
  getMissingOAuth2LoginConfig,
  buildOAuth2AuthorizationParams,
} from './oauth2Login';

jest.mock('undici', () => ({
  fetch: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('~/utils/proxy', () => ({
  getOpenIdProxyDispatcher: jest.fn(() => undefined),
}));

const mockFetch = undiciFetch as unknown as jest.Mock;
const { getOpenIdProxyDispatcher } = jest.requireMock('~/utils/proxy');

describe('getMissingOAuth2LoginConfig', () => {
  const complete = {
    OPENID_AUTHORIZATION_URL: 'https://auth.example.com/authorize',
    OPENID_TOKEN_URL: 'https://auth.example.com/oauth/token',
    OPENID_USERINFO_URL: 'https://api.example.com/me',
  } as NodeJS.ProcessEnv;

  it('returns nothing when every required variable is set', () => {
    expect(getMissingOAuth2LoginConfig(complete)).toEqual([]);
  });

  it('reports every missing variable at once', () => {
    expect(getMissingOAuth2LoginConfig({} as NodeJS.ProcessEnv)).toEqual([
      'OPENID_AUTHORIZATION_URL',
      'OPENID_TOKEN_URL',
      'OPENID_USERINFO_URL',
    ]);
  });

  it('treats a blank value as missing', () => {
    expect(getMissingOAuth2LoginConfig({ ...complete, OPENID_TOKEN_URL: '   ' })).toEqual([
      'OPENID_TOKEN_URL',
    ]);
  });
});

describe('buildOAuth2StrategyOptions', () => {
  const env = {
    OPENID_AUTHORIZATION_URL: 'https://auth.example.com/authorize',
    OPENID_TOKEN_URL: 'https://auth.example.com/oauth/token',
    OPENID_CLIENT_ID: 'the-client',
    OPENID_CLIENT_SECRET: 'the-secret',
    DOMAIN_SERVER: 'https://chat.example.com',
    OPENID_CALLBACK_URL: '/oauth/openid/callback',
    OPENID_SCOPE: 'read:me read:account',
  } as NodeJS.ProcessEnv;

  it('maps the environment onto passport-oauth2 options', () => {
    expect(buildOAuth2StrategyOptions(env)).toEqual({
      authorizationURL: 'https://auth.example.com/authorize',
      tokenURL: 'https://auth.example.com/oauth/token',
      clientID: 'the-client',
      clientSecret: 'the-secret',
      callbackURL: 'https://chat.example.com/oauth/openid/callback',
      scope: ['read:me', 'read:account'],
    });
  });

  it('splits a space-delimited scope, collapsing extra whitespace', () => {
    const options = buildOAuth2StrategyOptions({
      ...env,
      OPENID_SCOPE: '  read:me   read:account  ',
    });
    expect(options.scope).toEqual(['read:me', 'read:account']);
  });

  it('leaves scope undefined when none is configured', () => {
    const { OPENID_SCOPE: _omitted, ...withoutScope } = env;
    expect(buildOAuth2StrategyOptions(withoutScope).scope).toBeUndefined();
  });

  it('leaves state handling to the store the caller supplies', () => {
    const options = buildOAuth2StrategyOptions(env);
    expect(options).not.toHaveProperty('state');
    expect(options).not.toHaveProperty('store');
  });

  it('sets no pkce option, which the signed-cookie state store cannot back', () => {
    expect(buildOAuth2StrategyOptions(env)).not.toHaveProperty('pkce');
  });
});

describe('buildOAuth2AuthorizationParams', () => {
  it('includes the audience when configured', () => {
    expect(
      buildOAuth2AuthorizationParams({ OPENID_AUDIENCE: 'api.example.com' } as NodeJS.ProcessEnv),
    ).toEqual({ audience: 'api.example.com' });
  });

  it('takes the first non-empty entry of a comma-separated list, as the OIDC path does', () => {
    expect(
      buildOAuth2AuthorizationParams({
        OPENID_AUDIENCE: ' , api.example.com , other.example.com',
      } as NodeJS.ProcessEnv),
    ).toEqual({ audience: 'api.example.com' });
  });

  it('omits the audience when unset or blank', () => {
    expect(buildOAuth2AuthorizationParams({} as NodeJS.ProcessEnv)).toEqual({});
    expect(buildOAuth2AuthorizationParams({ OPENID_AUDIENCE: '  ' } as NodeJS.ProcessEnv)).toEqual(
      {},
    );
  });
});

describe('resolveOAuth2Subject', () => {
  it('prefers an explicit sub', () => {
    expect(resolveOAuth2Subject({ sub: 'the-sub', account_id: 'the-account', id: 'the-id' })).toBe(
      'the-sub',
    );
  });

  it('falls back to account_id', () => {
    expect(resolveOAuth2Subject({ account_id: '712020:abc-123' })).toBe('712020:abc-123');
  });

  it('falls back to id last', () => {
    expect(resolveOAuth2Subject({ id: 'the-id' })).toBe('the-id');
  });

  it('coerces a numeric identifier to a string', () => {
    expect(resolveOAuth2Subject({ id: 42 })).toBe('42');
  });

  it('skips blank values rather than keying a user on an empty string', () => {
    expect(resolveOAuth2Subject({ sub: '', account_id: 'the-account' })).toBe('the-account');
  });

  it('returns undefined when the payload carries no identifier', () => {
    expect(resolveOAuth2Subject({ email: 'test@example.com' })).toBeUndefined();
    expect(resolveOAuth2Subject(null)).toBeUndefined();
    expect(resolveOAuth2Subject(undefined)).toBeUndefined();
  });
});

describe('fetchOAuth2UserInfo', () => {
  const url = 'https://api.example.com/me';

  beforeEach(() => {
    jest.clearAllMocks();
    getOpenIdProxyDispatcher.mockReturnValue(undefined);
  });

  it('sends the access token as a bearer credential', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ account_id: 'abc' }),
    });

    await expect(fetchOAuth2UserInfo(url, 'the-token')).resolves.toEqual({ account_id: 'abc' });
    expect(mockFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer the-token' }),
      }),
    );
  });

  it('applies the OpenID proxy dispatcher when one is configured', async () => {
    const dispatcher = { proxy: true };
    getOpenIdProxyDispatcher.mockReturnValue(dispatcher);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ sub: 'abc' }),
    });

    await fetchOAuth2UserInfo(url, 'the-token');
    expect(mockFetch).toHaveBeenCalledWith(url, expect.objectContaining({ dispatcher }));
  });

  it('omits the dispatcher key when no proxy is configured', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ sub: 'abc' }),
    });

    await fetchOAuth2UserInfo(url, 'the-token');
    expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('dispatcher');
  });

  it('returns null on a non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'unauthorized',
    });

    await expect(fetchOAuth2UserInfo(url, 'the-token')).resolves.toBeNull();
  });

  it('returns null when the request throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(fetchOAuth2UserInfo(url, 'the-token')).resolves.toBeNull();
  });

  it('returns null when the body cannot be decoded', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('not json');
      },
    });

    await expect(fetchOAuth2UserInfo(url, 'the-token')).resolves.toBeNull();
  });
});
