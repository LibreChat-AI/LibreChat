import jwksRsa from 'jwks-rsa';
import type { Agent } from 'http';
import type { LogoutTokenKeyResolver } from './token';
import { createMemoizedConfigLoader } from '../providerSession/config';

export interface LogoutJwksClientDeps {
  /** The already-discovered `jwks_uri` (from the OpenID client's own metadata); this factory
   *  only builds the key-set cache around it. */
  getJwksUri: () => string;
  /** How long a fetched key set answers every `kid` before the next fetch, evaluated at
   *  client-build time; the caller owns `OPENID_JWKS_URL_CACHE_TIME` and its default. */
  getCacheMaxAgeMs: () => number;
  /** Resolves the proxy agent for the JWKS request, if any; the caller owns the process-wide
   *  proxy configuration this depends on. */
  getRequestAgent?: (uri: string) => Agent | undefined;
  now?: () => number;
}

interface LogoutJwksClient {
  client: jwksRsa.JwksClient;
  cacheMaxAgeMs: number;
}

/** The client fetches on every call; `createLogoutJwksKeyResolver` owns the cache. */
function buildLogoutJwksClient(jwksUri: string, deps: LogoutJwksClientDeps): LogoutJwksClient {
  const options: jwksRsa.Options = { jwksUri, cache: false };
  const requestAgent = deps.getRequestAgent?.(jwksUri);
  if (requestAgent) {
    options.requestAgent = requestAgent;
  }
  return { client: jwksRsa(options), cacheMaxAgeMs: deps.getCacheMaxAgeMs() };
}

/** Same selection as `JwksClient.getSigningKey`: without a `kid`, only a single-key set matches. */
function findSigningKey(
  keys: jwksRsa.SigningKey[],
  kid: string | undefined,
): jwksRsa.SigningKey | undefined {
  if (kid === undefined) {
    return keys.length === 1 ? keys[0] : undefined;
  }
  return keys.find((key) => key.kid === kid);
}

/** Builds a `LogoutTokenKeyResolver` that caches the whole key set. While the set is newer than
 *  the cache age, it answers every `kid` with no fetch, and an unknown `kid` rejects with
 *  `SigningKeyNotFoundError`. So the provider gets at most one fetch per cache period, and tokens
 *  with random `kid` values cannot use a fetch budget that real logout tokens need. A failed
 *  fetch or client build is not cached, so the next call retries. */
export function createLogoutJwksKeyResolver(deps: LogoutJwksClientDeps): LogoutTokenKeyResolver {
  const now = deps.now ?? Date.now;
  const getClient = createMemoizedConfigLoader(async () =>
    buildLogoutJwksClient(deps.getJwksUri(), deps),
  );
  let keySet: { keys: jwksRsa.SigningKey[]; fetchedAt: number } | null = null;
  let pendingFetch: Promise<jwksRsa.SigningKey[]> | null = null;

  async function fetchKeySet(): Promise<jwksRsa.SigningKey[]> {
    const { client } = await getClient();
    const keys = await client.getSigningKeys();
    keySet = { keys, fetchedAt: now() };
    return keys;
  }

  async function getKeySet(): Promise<jwksRsa.SigningKey[]> {
    const { cacheMaxAgeMs } = await getClient();
    if (keySet && now() - keySet.fetchedAt < cacheMaxAgeMs) {
      return keySet.keys;
    }
    if (!pendingFetch) {
      pendingFetch = fetchKeySet().finally(() => {
        pendingFetch = null;
      });
    }
    return pendingFetch;
  }

  return async (kid) => {
    const key = findSigningKey(await getKeySet(), kid);
    if (!key) {
      throw new jwksRsa.SigningKeyNotFoundError(
        `Unable to find a signing key that matches '${kid}'`,
      );
    }
    return key.getPublicKey();
  };
}
