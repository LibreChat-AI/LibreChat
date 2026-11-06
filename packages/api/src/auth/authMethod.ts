import type { AuthMethod } from '@librechat/data-schemas';

const DIRECT_AUTH_METHODS = new Set<string>(['local', 'ldap', 'saml', 'openid', 'passkey']);

/** Maps a user's login provider (`api/strategies`) to a Session doc's `authMethod`. Every
 *  OAuth2/OIDC social strategy (google, github, facebook, discord, apple) collapses to `'social'`. */
export function resolveAuthMethod(provider: string | null | undefined): AuthMethod | undefined {
  if (!provider) {
    return undefined;
  }
  return DIRECT_AUTH_METHODS.has(provider) ? (provider as AuthMethod) : 'social';
}
