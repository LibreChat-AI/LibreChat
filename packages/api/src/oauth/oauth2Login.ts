import { fetch as undiciFetch } from 'undici';
import { logger } from '@librechat/data-schemas';
import { getOpenIdProxyDispatcher } from '~/utils/proxy';

/**
 * Login helpers for providers that speak OAuth 2.0 but issue no `id_token`, so the OIDC code flow
 * cannot complete. Identity comes from a configured userinfo endpoint instead.
 */

/** Required before an OAuth2-only strategy can be registered. */
export const OAUTH2_LOGIN_REQUIRED_VARS = [
  'OPENID_AUTHORIZATION_URL',
  'OPENID_TOKEN_URL',
  'OPENID_USERINFO_URL',
] as const;

/** Reports every missing variable at once rather than failing on whichever is read first. */
export function getMissingOAuth2LoginConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return OAUTH2_LOGIN_REQUIRED_VARS.filter((key) => !env[key]?.trim());
}

/** Options handed to `passport-oauth2`'s Strategy constructor. */
export interface OAuth2StrategyOptions {
  authorizationURL: string;
  tokenURL: string;
  clientID?: string;
  clientSecret?: string;
  callbackURL: string;
  scope?: string[];
}

/**
 * Assumes the required URLs are present; call `getMissingOAuth2LoginConfig` first.
 *
 * The caller supplies the state `store`. The OpenID route must not pass a `state` string to
 * `passport.authenticate` in this mode: passport-oauth2 short-circuits on one, putting it straight
 * on the authorization URL without calling the store, so the callback has nothing to verify.
 */
export function buildOAuth2StrategyOptions(
  env: NodeJS.ProcessEnv = process.env,
): OAuth2StrategyOptions {
  return {
    authorizationURL: env.OPENID_AUTHORIZATION_URL as string,
    tokenURL: env.OPENID_TOKEN_URL as string,
    clientID: env.OPENID_CLIENT_ID,
    clientSecret: env.OPENID_CLIENT_SECRET,
    callbackURL: `${env.DOMAIN_SERVER ?? ''}${env.OPENID_CALLBACK_URL ?? ''}`,
    /** space-delimited, as on the OIDC path; passport-oauth2 wants an array */
    scope: env.OPENID_SCOPE?.split(/\s+/).filter(Boolean),
  };
}

/**
 * Extra authorization-request parameters. `OPENID_AUDIENCE` is comma-separated and the first
 * non-empty entry wins, matching the OIDC path.
 */
export function buildOAuth2AuthorizationParams(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const audience = (env.OPENID_AUDIENCE ?? '')
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);

  return audience ? { audience } : {};
}

/**
 * OAuth2 userinfo endpoints are not bound by the OIDC spec and name the identifier
 * inconsistently, so fall back in order while leaving an explicit `sub` authoritative.
 */
export function resolveOAuth2Subject(
  userinfo: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!userinfo) {
    return undefined;
  }

  for (const key of ['sub', 'account_id', 'id'] as const) {
    const value = userinfo[key];
    if (typeof value === 'string' && value) {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
  }

  return undefined;
}

/** Bearer request to the userinfo endpoint; honours the OpenID proxy config. Null on failure. */
export async function fetchOAuth2UserInfo(
  userInfoURL: string,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const dispatcher = getOpenIdProxyDispatcher();
    const response = await undiciFetch(userInfoURL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      logger.error(
        `[oauth2Login] userinfo request failed: HTTP ${response.status} ${response.statusText} :: ${body}`,
      );
      return null;
    }

    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    logger.error('[oauth2Login] userinfo request error:', error);
    return null;
  }
}
