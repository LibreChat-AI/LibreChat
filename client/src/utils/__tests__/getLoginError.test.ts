import { TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE } from 'librechat-data-provider';
import getLoginError from '../getLoginError';

describe('getLoginError', () => {
  it('falls back to the generic message without error text', () => {
    expect(getLoginError('')).toBe('com_auth_error_login');
  });

  it.each([
    ['Request failed with status code 429', 'com_auth_error_login_rl'],
    ['Request failed with status code 403', 'com_auth_error_login_ban'],
    ['Request failed with status code 500', 'com_auth_error_login_server'],
    ['Request failed with status code 422', 'com_auth_error_login_unverified'],
    ['something unmapped', 'com_auth_error_login'],
  ])('maps %s', (errorText, expected) => {
    expect(getLoginError(errorText)).toBe(expected);
  });

  /**
   * A refused federated password login is also a 403, so it has to win over the ban case; that
   * mapping is the only thing standing between the user and a false "account banned" message.
   */
  it('reports a refused federated password login rather than a ban', () => {
    expect(getLoginError(TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE)).toBe(
      'com_auth_error_login_federated_two_factor',
    );
  });
});
