import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import { getOAuthConfig } from './oauth';

describe('getOAuthConfig', () => {
  it('serializes an explicit token exchange method', () => {
    expect(
      getOAuthConfig({
        auth_type: 'oauth',
        oauth_client_id: 'client-id',
        oauth_token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      }),
    ).toEqual({
      client_id: 'client-id',
      token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
    });
  });

  it('omits the exchange method when automatic discovery is selected', () => {
    expect(
      getOAuthConfig({
        auth_type: 'oauth',
        oauth_client_id: 'client-id',
        oauth_token_exchange_method: undefined,
      }),
    ).toEqual({ client_id: 'client-id' });
  });

  it('does not create OAuth config for another authentication type', () => {
    expect(
      getOAuthConfig({
        auth_type: 'none',
        oauth_client_id: 'stale-client-id',
        oauth_token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
      }),
    ).toBeUndefined();
  });
});
