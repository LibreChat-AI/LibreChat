import jwksRsa from 'jwks-rsa';
import type { LogoutTokenKeyResolver } from './token';
import { createMemoizedConfigLoader } from '../providerSession/config';
import { getHttpsProxyAgent } from '~/utils/proxy';
import { math } from '~/utils/math';

/** Keeps the IdP's JWKS endpoint from being hit on every logout token; small because a logout
 *  token is rare, not high-volume like access-token verification. */
const JWKS_REQUESTS_PER_MINUTE = 10;

export interface LogoutJwksClientDeps {
  /** The already-discovered `jwks_uri` (from the OpenID client's own metadata); this factory
   *  only builds the caching, rate-limited client around it. */
  getJwksUri: () => string;
}

function buildLogoutJwksClient(jwksUri: string): jwksRsa.JwksClient {
  const options: jwksRsa.Options = {
    jwksUri,
    cache: true,
    cacheMaxAge: math(process.env.OPENID_JWKS_URL_CACHE_TIME, 60000),
    rateLimit: true,
    jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
  };
  const requestAgent = getHttpsProxyAgent(jwksUri);
  if (requestAgent) {
    options.requestAgent = requestAgent;
  }
  return jwksRsa(options);
}

/** Builds a `LogoutTokenKeyResolver` backed by one memoized JWKS client; only a successful
 *  build is cached, so a transient failure retries on the next call instead of sticking. */
export function createLogoutJwksKeyResolver(deps: LogoutJwksClientDeps): LogoutTokenKeyResolver {
  const getClient = createMemoizedConfigLoader(async () =>
    buildLogoutJwksClient(deps.getJwksUri()),
  );
  return async (kid) => {
    const client = await getClient();
    const key = await client.getSigningKey(kid);
    return key.getPublicKey();
  };
}
