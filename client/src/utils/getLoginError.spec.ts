import { ErrorTypes } from 'librechat-data-provider';
import getLoginError from './getLoginError';

describe('getLoginError', () => {
  it.each([
    [ErrorTypes.AUTH_CROSS_ORIGIN, 'com_auth_error_login_cross_origin'],
    ['Request failed with status code 403', 'com_auth_error_login_ban'],
    ['Request failed with status code 429', 'com_auth_error_login_rl'],
    ['Request failed with status code 422', 'com_auth_error_login_unverified'],
    ['Request failed with status code 500', 'com_auth_error_login_server'],
    ['Request failed with status code 401', 'com_auth_error_login'],
    ['', 'com_auth_error_login'],
  ])('maps %p to %p', (errorText, key) => {
    expect(getLoginError(errorText)).toBe(key);
  });
});
