import { inspect } from 'util';
import {
  ServerError,
  InvalidGrantError,
  InvalidClientError,
  InvalidRequestError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { getSafeOAuthError } from './errors';

const secret = 'sentinel-provider-credential';

describe('getSafeOAuthError', () => {
  it.each([
    new Error(secret),
    Object.assign(new Error(secret), {
      config: { data: secret },
      response: { status: 401, data: { refresh_token: secret } },
      cause: new Error(secret),
    }),
    secret,
  ])('drops provider text, request metadata and causes', (error) => {
    const safe = getSafeOAuthError(error, 'OAuth token exchange failed');
    expect(safe.message).toBe('OAuth token exchange failed');
    expect(safe.cause).toBeUndefined();
    expect(inspect(safe, { depth: null })).not.toContain(secret);
  });

  it.each([
    [new InvalidClientError(secret, `https://example.com/${secret}`), 'invalid_client'],
    [new UnauthorizedClientError(secret), 'unauthorized_client'],
    [new Error(`client_id mismatch: ${secret}`), 'invalid_client'],
    [new Error(`invalid_grant: ${secret}`), 'invalid_grant'],
    [new ServerError(`unknown client: ${secret}`), 'invalid_client'],
    [new InvalidRequestError(`client_id mismatch: ${secret}`), 'invalid_client'],
    [new InvalidGrantError(`client not found: ${secret}`), 'invalid_client'],
    [new ServerError(`client not found: ${secret}`), 'invalid_client'],
    [new ServerError(`client_id mismatch: ${secret}`), 'invalid_client'],
  ])('retains only allowlisted recovery codes', (error, code) => {
    const safe = getSafeOAuthError(error, 'OAuth token exchange failed');
    expect(safe.message).toBe(`OAuth token exchange failed (${code})`);
    expect(inspect(safe, { depth: null })).not.toContain(secret);
  });

  it('retains bounded HTTP status', () => {
    expect(
      getSafeOAuthError(
        Object.assign(new Error(secret), { response: { status: 401 } }),
        'OAuth token exchange failed',
      ),
    ).toMatchObject({ status: 401 });
  });
});
