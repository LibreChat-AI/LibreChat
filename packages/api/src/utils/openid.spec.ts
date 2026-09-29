import { logHeaders, logOpenIdRequestBody, safeStringify } from './openid';

describe('OpenID logging helpers', () => {
  it('fully masks secret-bearing object fields', () => {
    const output = safeStringify({
      client_secret: 'client-secret-canary',
      code: 'authorization-code-canary',
      code_verifier: 'pkce-verifier-canary',
      nested: {
        refresh_token: 'refresh-token-canary',
        connectionString: 'mongodb://user:password@example.test/db',
      },
    });

    expect(output).not.toContain('client-secret-canary');
    expect(output).not.toContain('authorization-code-canary');
    expect(output).not.toContain('pkce-verifier-canary');
    expect(output).not.toContain('refresh-token-canary');
    expect(output).not.toContain('mongodb://');
    expect(output).toContain('***MASKED***');
  });

  it('masks credential-bearing headers case-insensitively', () => {
    const output = logHeaders(
      new Headers({
        Authorization: 'Bearer authorization-canary',
        Cookie: 'session=cookie-canary',
        Location: 'https://example.test/callback?code=location-code-canary',
        'Set-Cookie': 'refreshToken=set-cookie-canary',
        'X-Amz-Security-Token': 'aws-token-canary',
        'X-API-Key': 'api-key-canary',
        'Content-Type': 'application/json',
      }),
    );

    expect(output).not.toContain('authorization-canary');
    expect(output).not.toContain('cookie-canary');
    expect(output).not.toContain('set-cookie-canary');
    expect(output).not.toContain('aws-token-canary');
    expect(output).not.toContain('location-code-canary');
    expect(output).not.toContain('api-key-canary');
    expect(output).toContain('application/json');
  });

  it('logs URL-encoded request shape without logging values', () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'authorization-code-canary',
      code_verifier: 'pkce-verifier-canary',
      client_secret: 'client-secret-canary',
    });

    const output = logOpenIdRequestBody(body);

    expect(output).toContain('URLSearchParams');
    expect(output).toContain('fieldCount');
    expect(output).not.toContain('grant_type');
    expect(output).not.toContain('client_secret');
    expect(output).not.toContain('authorization-code-canary');
    expect(output).not.toContain('pkce-verifier-canary');
    expect(output).not.toContain('client-secret-canary');
  });

  it('logs opaque string body metadata without logging content', () => {
    const output = logOpenIdRequestBody('refresh_token=refresh-token-canary');

    expect(output).toContain('string');
    expect(output).toContain('length');
    expect(output).not.toContain('refresh-token-canary');
  });

  it('never lets hostile debug values interrupt an OpenID request', () => {
    const hostileBody = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('refresh_token=proxy-canary');
        },
      },
    );

    expect(() => logOpenIdRequestBody(hostileBody)).not.toThrow();
    expect(logOpenIdRequestBody(hostileBody)).not.toContain('proxy-canary');
  });
});
