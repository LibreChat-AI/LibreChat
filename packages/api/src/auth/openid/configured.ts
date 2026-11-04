import { isEnabled } from '~/utils/common';

/** True once the environment carries the minimum OpenID registration fields; a leaf check so
 *  the strategy chain and the authorization connection can both read it without a require cycle. */
export function isOpenIdConfigured(): boolean {
  return Boolean(
    process.env.OPENID_CLIENT_ID &&
      (isEnabled(process.env.OPENID_USE_PKCE) || process.env.OPENID_CLIENT_SECRET?.trim()) &&
      process.env.OPENID_ISSUER &&
      process.env.OPENID_SCOPE &&
      process.env.OPENID_SESSION_SECRET,
  );
}
