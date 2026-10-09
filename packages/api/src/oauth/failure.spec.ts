import { buildOAuthFailureLog, getOAuthFailureMessage, isOAuthProtocolFailure } from './failure';
import type { OAuthFailureRequest } from './failure';

function createRequest(overrides: Partial<OAuthFailureRequest> = {}): OAuthFailureRequest {
  return {
    headers: {},
    method: 'GET',
    path: '/openid/callback',
    originalUrl: '/openid/callback',
    query: {},
    ...overrides,
  };
}

describe('OAuth failure logging helpers', () => {
  it('prefers session failure messages and removes the consumed message', () => {
    const req = createRequest({
      session: {
        messages: ['first', 'latest'],
      },
    });

    expect(getOAuthFailureMessage(req)).toBe('latest');
    expect(req.session?.messages).toEqual(['first']);
  });

  it('falls back to provider query error details without returning Unknown OAuth error', () => {
    const req = createRequest({
      query: {
        error: 'access_denied',
        error_description: 'Denied by provider',
      },
    });

    expect(getOAuthFailureMessage(req)).toBe('Denied by provider');
  });

  it('logs OpenID protocol failure metadata without raw code or state values', () => {
    const req = createRequest({
      headers: {
        host: 'chat.example.com',
        'x-forwarded-for': '203.0.113.10',
        'x-forwarded-proto': 'https',
        'user-agent': 'test-agent',
      },
      id: 'request-id',
      originalUrl: '/openid/callback?code=secret-code&state=secret-state',
      query: {
        code: 'secret-code',
        state: 'secret-state',
      },
    });
    const error = Object.assign(new Error('invalid response encountered'), {
      code: 'OAUTH_INVALID_RESPONSE',
      name: 'ClientError',
      cause: {
        code: 'OAUTH_INVALID_RESPONSE',
        name: 'OperationProcessingError',
        message: 'invalid response encountered',
      },
    });

    const log = buildOAuthFailureLog({
      provider: 'openid',
      req,
      err: error,
      defaultMessage: 'OpenID authentication failed',
    });

    expect(log).toEqual({
      provider: 'openid',
      code: 'OAUTH_INVALID_RESPONSE',
      name: 'ClientError',
      message: 'invalid response encountered',
      cause_code: 'OAUTH_INVALID_RESPONSE',
      cause_name: 'OperationProcessingError',
      cause_message: 'invalid response encountered',
      has_code: true,
      has_state: true,
      method: 'GET',
      path: '/openid/callback',
      request_id: 'request-id',
      host: 'chat.example.com',
      forwarded_proto: 'https',
      forwarded_for: '203.0.113.10',
      user_agent: 'test-agent',
    });
    expect(JSON.stringify(log)).not.toContain('secret-code');
    expect(JSON.stringify(log)).not.toContain('secret-state');
  });

  it('captures provider response error fields from Passport info', () => {
    const log = buildOAuthFailureLog({
      provider: 'openid',
      req: createRequest(),
      info: {
        error: 'access_denied',
        error_description: 'User denied consent',
      },
    });

    expect(log).toEqual({
      provider: 'openid',
      code: 'access_denied',
      message: 'User denied consent',
      has_code: false,
      has_state: false,
      method: 'GET',
      path: '/openid/callback',
    });
  });

  it('truncates very long messages', () => {
    const longMessage = 'x'.repeat(320);

    const log = buildOAuthFailureLog({
      provider: 'openid',
      req: createRequest(),
      info: {
        message: longMessage,
      },
    });

    expect(log.message).toHaveLength(315);
    expect(log.message?.endsWith('... [truncated]')).toBe(true);
  });

  it.each([
    [{ code: 'OAUTH_INVALID_RESPONSE' }, true],
    [{ name: 'AuthorizationResponseError' }, true],
    [
      { cause: { name: 'OperationProcessingError', message: 'invalid response encountered' } },
      true,
    ],
    [{ name: 'DatabaseError', message: 'database exploded' }, false],
  ])('classifies OAuth protocol failure %j as %s', (error, expected) => {
    expect(isOAuthProtocolFailure(error)).toBe(expected);
  });
});
