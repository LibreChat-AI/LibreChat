import { ErrorTypes } from 'librechat-data-provider';
import { TranslationKeys } from '~/hooks';

const getLoginError = (errorText: string): TranslationKeys => {
  const defaultError: TranslationKeys = 'com_auth_error_login';

  if (!errorText) {
    return defaultError;
  }

  switch (true) {
    case errorText === ErrorTypes.AUTH_CROSS_ORIGIN:
      return 'com_auth_error_login_cross_origin';
    case errorText.includes('429'):
      return 'com_auth_error_login_rl';
    case errorText.includes('403'):
      return 'com_auth_error_login_ban';
    case errorText.includes('500'):
      return 'com_auth_error_login_server';
    case errorText.includes('422'):
      return 'com_auth_error_login_unverified';
    default:
      return defaultError;
  }
};

export default getLoginError;
