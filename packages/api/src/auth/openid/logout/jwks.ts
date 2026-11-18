import jwksRsa from 'jwks-rsa';
import type { Agent } from 'http';
import type { LogoutTokenKeyResolver } from './token';
import { createMemoizedConfigLoader } from '../providerSession/config';

/** Keeps the IdP's JWKS endpoint from being hit on every logout token; small because a logout
 *  token is rare, not high-volume like access-token verification. */
const JWKS_REQUESTS_PER_MINUTE = 10;

export interface LogoutJwksClientDeps {
  /** The already-discovered `jwks_uri` (from the OpenID client's own metadata); this factory
   *  only builds the caching, rate-limited client around it. */
  getJwksUri: () => string;
  /** Cache TTL for a resolved signing key, evaluated at client-build time; the caller owns
   *  `OPENID_JWKS_URL_CACHE_TIME` and its default. */
  getCacheMaxAgeMs: () => number;
  /** Resolves the proxy agent for the JWKS request, if any; the caller owns the process-wide
   *  proxy configuration this depends on. */
  getRequestAgent?: (uri: string) => Agent | undefined;
}

function buildLogoutJwksClient(jwksUri: string, deps: LogoutJwksClientDeps): jwksRsa.JwksClient {
  const options: jwksRsa.Options = {
    jwksUri,
    cache: true,
    cacheMaxAge: deps.getCacheMaxAgeMs(),
    rateLimit: true,
    jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
  };
  const requestAgent = deps.getRequestAgent?.(jwksUri);
  if (requestAgent) {
    options.requestAgent = requestAgent;
  }
  return jwksRsa(options);
}

/** Builds a `LogoutTokenKeyResolver` backed by one memoized JWKS client; only a successful
 *  build is cached, so a transient failure retries on the next call instead of sticking. */
export function createLogoutJwksKeyResolver(deps: LogoutJwksClientDeps): LogoutTokenKeyResolver {
  const getClient = createMemoizedConfigLoader(async () =>
    buildLogoutJwksClient(deps.getJwksUri(), deps),
  );
  return async (kid) => {
    const client = await getClient();
    const key = await client.getSigningKey(kid);
    return key.getPublicKey();
  };
}
