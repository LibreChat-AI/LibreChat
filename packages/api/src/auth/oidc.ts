import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { fetch as undiciFetch } from 'undici';
import { isRemoteOidcUrlAllowed } from 'librechat-data-provider';
import type { Algorithm, JwtPayload, VerifyOptions } from 'jsonwebtoken';
import type { RequestInit } from 'undici';
import { getEnvProxyDispatcher, getHttpsProxyAgent } from '~/utils/proxy';
import { normalizeOpenIdIssuer } from './openid';
import { isEnabled, math } from '~/utils';

export interface OidcAccessTokenConfig {
  audience?: string;
  issuer: string;
  jwksUri?: string;
  requiredScopes?: string[];
  tokenUse?: 'access';
}

export interface OidcAccessTokenOptions {
  useOpenIdJwksEnv?: boolean;
}

type JwksCacheOptions = {
  enabled: boolean;
  maxAge: number;
};

type CacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const OIDC_DISCOVERY_TIMEOUT_MS = 10000;
const JWKS_REQUESTS_PER_MINUTE = 10;
const OIDC_THROTTLE_WINDOW_MS = 60000;
const MAX_JWKS_CACHE_ENTRIES = 100;
const JWT_ALGORITHMS: Algorithm[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
];
const jwksUriCache = new Map<string, CacheEntry<string>>();
const jwksClientCache = new Map<string, CacheEntry<jwksRsa.JwksClient>>();

export function clearOidcAccessTokenCache(): void {
  jwksUriCache.clear();
  jwksClientCache.clear();
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  const match = authHeader?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

function pruneExpiredEntries<T>(cache: Map<string, CacheEntry<T>>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function setCacheEntry<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>,
): void {
  pruneExpiredEntries(cache);

  while (cache.size >= MAX_JWKS_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }

  cache.set(key, entry);
}

function getJwksCacheOptions(): JwksCacheOptions {
  return {
    enabled: process.env.OPENID_JWKS_URL_CACHE_ENABLED
      ? isEnabled(process.env.OPENID_JWKS_URL_CACHE_ENABLED)
      : true,
    maxAge: Math.max(math(process.env.OPENID_JWKS_URL_CACHE_TIME, 60000), 0),
  };
}

function buildDiscoveryOptions(controller: AbortController): RequestInit {
  const options: RequestInit = { signal: controller.signal };
  const dispatcher = getEnvProxyDispatcher();

  if (dispatcher) {
    options.dispatcher = dispatcher;
  }

  return options;
}

function ensureRemoteOidcUrlAllowed(value: string, label: string): string {
  if (isRemoteOidcUrlAllowed(value)) return value;
  throw new Error(`${label} must use https:// unless targeting localhost`);
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const normalizedIssuer = normalizeOpenIdIssuer(ensureRemoteOidcUrlAllowed(issuer, 'OIDC issuer'));
  if (!normalizedIssuer) throw new Error('OIDC issuer is required');

  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OIDC_DISCOVERY_TIMEOUT_MS);

  try {
    const res = await undiciFetch(discoveryUrl, buildDiscoveryOptions(controller));
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);

    const meta = (await res.json()) as { jwks_uri?: string };
    if (!meta.jwks_uri) throw new Error('OIDC discovery response missing jwks_uri');

    return ensureRemoteOidcUrlAllowed(meta.jwks_uri, 'OIDC JWKS URI');
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveJwksUri(
  oidcConfig: OidcAccessTokenConfig,
  cacheOptions: JwksCacheOptions,
  options: OidcAccessTokenOptions,
): Promise<string> {
  if (oidcConfig.jwksUri) return ensureRemoteOidcUrlAllowed(oidcConfig.jwksUri, 'OIDC JWKS URI');
  if (options.useOpenIdJwksEnv === true && process.env.OPENID_JWKS_URL) {
    return ensureRemoteOidcUrlAllowed(process.env.OPENID_JWKS_URL, 'OIDC JWKS URI');
  }

  const cacheKey = oidcConfig.issuer;
  const cached = jwksUriCache.get(cacheKey);
  if (cached != null && cached.expiresAt > Date.now()) return cached.promise;
  if (cached != null) jwksUriCache.delete(cacheKey);

  const promise = discoverJwksUri(oidcConfig.issuer).catch((err) => {
    jwksUriCache.delete(cacheKey);
    throw err;
  });

  setCacheEntry(jwksUriCache, cacheKey, {
    promise,
    expiresAt: Date.now() + Math.max(cacheOptions.maxAge, OIDC_THROTTLE_WINDOW_MS),
  });
  return promise;
}

function buildJwksClient(uri: string, cacheOptions: JwksCacheOptions): jwksRsa.JwksClient {
  const cacheMaxAge = cacheOptions.enabled
    ? Math.max(cacheOptions.maxAge, OIDC_THROTTLE_WINDOW_MS)
    : OIDC_THROTTLE_WINDOW_MS;
  const options: jwksRsa.Options = {
    cache: true,
    cacheMaxAge,
    jwksUri: uri,
    rateLimit: true,
    jwksRequestsPerMinute: JWKS_REQUESTS_PER_MINUTE,
  };

  const requestAgent = getHttpsProxyAgent(uri);
  if (requestAgent) {
    options.requestAgent = requestAgent;
  }

  return jwksRsa(options);
}

async function getJwksClient(
  oidcConfig: OidcAccessTokenConfig,
  options: OidcAccessTokenOptions,
): Promise<jwksRsa.JwksClient> {
  const cacheOptions = getJwksCacheOptions();
  const uri = await resolveJwksUri(oidcConfig, cacheOptions, options);

  const cacheKey = uri;
  const cached = jwksClientCache.get(cacheKey);
  if (cached != null && cached.expiresAt > Date.now()) return cached.promise;
  if (cached != null) jwksClientCache.delete(cacheKey);

  let client: jwksRsa.JwksClient;
  try {
    client = buildJwksClient(uri, cacheOptions);
  } catch (err) {
    jwksClientCache.delete(cacheKey);
    throw err;
  }

  const promise = Promise.resolve(client);

  setCacheEntry(jwksClientCache, cacheKey, {
    promise,
    expiresAt: Date.now() + Math.max(cacheOptions.maxAge, OIDC_THROTTLE_WINDOW_MS),
  });
  return promise;
}

function getVerifyOptions(oidcConfig: OidcAccessTokenConfig): VerifyOptions {
  const normalizedIssuer = normalizeOpenIdIssuer(oidcConfig.issuer);
  const issuer =
    normalizedIssuer && normalizedIssuer !== oidcConfig.issuer
      ? [oidcConfig.issuer, normalizedIssuer]
      : oidcConfig.issuer;

  const options: VerifyOptions = {
    algorithms: JWT_ALGORITHMS,
    issuer,
  };
  if (oidcConfig.audience) options.audience = oidcConfig.audience;
  return options;
}

function verifyAccessTokenClaims(
  payload: JwtPayload,
  oidcConfig: OidcAccessTokenConfig,
): JwtPayload {
  if (oidcConfig.tokenUse && payload.token_use !== oidcConfig.tokenUse) {
    throw new Error('Invalid JWT token use');
  }

  if (oidcConfig.requiredScopes?.length) {
    const scope = typeof payload.scope === 'string' ? payload.scope.trim().split(/\s+/) : [];
    const grantedScopes = new Set(scope.filter(Boolean));
    if (!oidcConfig.requiredScopes.every((requiredScope) => grantedScopes.has(requiredScope))) {
      throw new Error('Invalid JWT scope');
    }
  }

  return payload;
}

function verifyJwt(
  token: string,
  signingKey: jwksRsa.SigningKey,
  oidcConfig: OidcAccessTokenConfig,
): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, signingKey.getPublicKey(), getVerifyOptions(oidcConfig), (err, payload) => {
      if (err != null || payload == null) return reject(err ?? new Error('Empty payload'));
      if (typeof payload === 'string') return reject(new Error('Invalid JWT payload'));
      try {
        resolve(verifyAccessTokenClaims(payload, oidcConfig));
      } catch (claimError) {
        reject(claimError);
      }
    });
  });
}

export async function verifyOidcAccessToken(
  token: string,
  oidcConfig: OidcAccessTokenConfig,
  options: OidcAccessTokenOptions = {},
): Promise<JwtPayload> {
  ensureRemoteOidcUrlAllowed(oidcConfig.issuer, 'OIDC issuer');

  const decoded = jwt.decode(token, { complete: true });
  if (decoded == null || typeof decoded === 'string') throw new Error('Invalid JWT: cannot decode');

  const kid = typeof decoded.header?.kid === 'string' ? decoded.header.kid : undefined;
  if (!kid) throw new Error('Invalid JWT: missing signing key ID');

  const client = await getJwksClient(oidcConfig, options);
  const signingKey = await client.getSigningKey(kid);
  return verifyJwt(token, signingKey, oidcConfig);
}
