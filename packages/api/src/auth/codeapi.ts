import { SYSTEM_TENANT_ID, getTenantId } from '@librechat/data-schemas';
import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from 'crypto';
import type { KeyObject, JsonWebKey } from 'crypto';
import type { ServerRequest } from '~/types';
import { isEnabled } from '~/utils';

type CodeApiJwtAlg = 'EdDSA' | 'RS256';
type PrincipalSource = 'librechat_jwt' | 'openid_reuse';

interface CodeApiUserContext {
  id?: string;
  _id?: { toString(): string };
  role?: string;
  tenantId?: string | { toString(): string };
  provider?: string;
  orgId?: string;
  serviceId?: string;
  chcUserId?: string;
  idOnTheSource?: string;
  planId?: string;
  subscription?: {
    planId?: string;
  };
}

interface CodeApiClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  tenant_id: string;
  role: string;
  principal_source: PrincipalSource;
  org_id?: string;
  service_id?: string;
  chc_user_id?: string;
  plan_id?: string;
  code_worker_id?: string;
  auth_context_hash: string;
}

interface SigningConfig {
  alg: CodeApiJwtAlg;
  kid: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  cacheSeconds: number;
  key: KeyObject;
  rawKey: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  cachedUntil: number;
}

const DEFAULT_ISSUER = 'librechat';
const DEFAULT_AUDIENCE = 'codeapi';
const DEFAULT_KID = 'lc-codeapi-2026-05';
const DEFAULT_SINGLE_TENANT_ID = 'legacy';
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_CACHE_SECONDS = 30;
const MAX_TTL_SECONDS = 300;
const MAX_CACHE_SECONDS = 30;
const TOKEN_REUSE_SAFETY_WINDOW_SECONDS = 30;
const TOKEN_CACHE_PRUNE_INTERVAL_SECONDS = 30;

let signingConfigCache: SigningConfig | null = null;
const tokenCache = new Map<string, CachedToken>();
let tokenCacheLastPrunedAt = 0;

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function getPrivateKeyRaw(): string {
  const inlineKey = process.env.CODEAPI_JWT_PRIVATE_KEY;
  if (inlineKey != null && inlineKey.trim() !== '') {
    return normalizePem(inlineKey);
  }
  const base64Key = process.env.CODEAPI_JWT_PRIVATE_KEY_BASE64;
  if (base64Key != null && base64Key.trim() !== '') {
    return normalizePem(Buffer.from(base64Key, 'base64').toString('utf8'));
  }
  const jwkJson = process.env.CODEAPI_JWT_PRIVATE_JWK_JSON;
  if (jwkJson != null && jwkJson.trim() !== '') {
    return jwkJson.trim();
  }
  throw new Error('Code API JWT signing key is not configured');
}

function parseAlg(value: string | undefined): CodeApiJwtAlg {
  if (value === 'RS256') {
    return 'RS256';
  }
  if (value === undefined || value === '' || value === 'EdDSA') {
    return 'EdDSA';
  }
  throw new Error(`Unsupported Code API JWT algorithm: ${value}`);
}

function parseCappedSeconds(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

/**
 * A parse failure here must not propagate verbatim. Node's JSON `SyntaxError`
 * quotes an excerpt of the source around the offending token, so a malformed
 * private JWK puts signing material into a message that callers log; the
 * message redaction patterns do not recognize a bare base64 fragment. Callers
 * get the failure and its key format, never the key.
 */
function createSigningKey(rawKey: string): KeyObject {
  const isJwk = rawKey.startsWith('{');
  try {
    return isJwk
      ? createPrivateKey({ key: JSON.parse(rawKey) as JsonWebKey, format: 'jwk' })
      : createPrivateKey(rawKey);
  } catch {
    throw new Error(
      `Code API JWT signing key could not be loaded (${isJwk ? 'JWK' : 'PEM'} format)`,
    );
  }
}

function getSigningConfig(): SigningConfig {
  const rawKey = getPrivateKeyRaw();
  const alg = parseAlg(process.env.CODEAPI_JWT_ALGORITHM);
  const kid = process.env.CODEAPI_JWT_KID ?? process.env.CODEAPI_JWT_KEY_ID ?? DEFAULT_KID;
  const issuer = process.env.CODEAPI_JWT_ISSUER ?? DEFAULT_ISSUER;
  const audience = process.env.CODEAPI_JWT_AUDIENCE ?? DEFAULT_AUDIENCE;
  const ttlSeconds = parseCappedSeconds(
    process.env.CODEAPI_JWT_TTL_SECONDS,
    DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
  );
  const cacheSeconds = parseCappedSeconds(
    process.env.CODEAPI_JWT_MINT_CACHE_SECONDS,
    DEFAULT_CACHE_SECONDS,
    MAX_CACHE_SECONDS,
  );

  if (
    signingConfigCache &&
    signingConfigCache.rawKey === rawKey &&
    signingConfigCache.alg === alg &&
    signingConfigCache.kid === kid &&
    signingConfigCache.issuer === issuer &&
    signingConfigCache.audience === audience &&
    signingConfigCache.ttlSeconds === ttlSeconds &&
    signingConfigCache.cacheSeconds === cacheSeconds
  ) {
    return signingConfigCache;
  }

  signingConfigCache = {
    alg,
    kid,
    issuer,
    audience,
    ttlSeconds,
    cacheSeconds,
    rawKey,
    key: createSigningKey(rawKey),
  };
  tokenCache.clear();
  tokenCacheLastPrunedAt = 0;
  return signingConfigCache;
}

export function assertCodeApiJwtSigningReady(): void {
  const config = getSigningConfig();
  const keyType = config.key.asymmetricKeyType;
  if (config.alg === 'EdDSA' && keyType !== 'ed25519' && keyType !== 'ed448') {
    throw new Error(`Code API JWT algorithm EdDSA requires an EdDSA key, received ${keyType}`);
  }
  if (config.alg === 'RS256' && keyType !== 'rsa') {
    throw new Error(`Code API JWT algorithm RS256 requires an RSA key, received ${keyType}`);
  }
  cryptoSign(
    config.alg === 'RS256' ? 'RSA-SHA256' : null,
    Buffer.from('librechat-codeapi-signing-readiness'),
    config.key,
  );
}

function stringifyClaimValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  if (value && typeof value === 'object' && 'toString' in value) {
    const stringValue = value.toString();
    return stringValue.trim() === '' ? undefined : stringValue;
  }
  return undefined;
}

function resolveUser(req: ServerRequest): CodeApiUserContext {
  const user = req.user as CodeApiUserContext | undefined;
  if (!user) {
    throw new Error('Code API token minting requires an authenticated user');
  }
  return user;
}

function resolveUserId(user: CodeApiUserContext): string {
  const userId = stringifyClaimValue(user.id) ?? stringifyClaimValue(user._id);
  if (!userId) {
    throw new Error('Code API token minting requires a canonical user id');
  }
  return userId;
}

function resolveSingleTenantId(): string {
  const configured = process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
  if (configured != null && configured.trim() !== '') {
    return configured.trim();
  }
  return DEFAULT_SINGLE_TENANT_ID;
}

/**
 * `SYSTEM_TENANT_ID` marks an ambient background context (e.g. the expired-file
 * sweep) rather than a real tenant, so it is treated as absent: minting it into
 * `tenant_id` would claim a tenant whose Code API sessions never existed.
 */
function resolveTenantId(user: CodeApiUserContext): string | undefined {
  const tenantId = stringifyClaimValue(user.tenantId) ?? getTenantId();
  if (tenantId && tenantId !== SYSTEM_TENANT_ID) {
    return tenantId;
  }
  if (isEnabled(process.env.TENANT_ISOLATION_STRICT)) {
    return undefined;
  }
  return resolveSingleTenantId();
}

export function getCodeApiTenantId(req: ServerRequest): string {
  const tenantId = resolveTenantId(resolveUser(req));
  if (!tenantId) {
    throw new Error('Code API JWT auth requires tenant context');
  }
  return tenantId;
}

function isManagedCodeApiJwtMode(): boolean {
  const provider = process.env.CODEAPI_AUTH_PROVIDER;
  return provider === 'librechat-jwt' || provider === 'both';
}

export function isCodeApiJwtAuthEnabled(): boolean {
  return isManagedCodeApiJwtMode() || isEnabled(process.env.CODEAPI_JWT_ENABLED);
}

function resolvePrincipalSource(req: ServerRequest): PrincipalSource {
  if (req.authStrategy === 'openidJwt') {
    return 'openid_reuse';
  }
  return 'librechat_jwt';
}

function canonicalContextHash(input: {
  userId: string;
  tenantId: string;
  role: string;
  principalSource: PrincipalSource;
  orgId?: string;
  serviceId?: string;
  chcUserId?: string;
}): string {
  const canonical = {
    chc_user_id: input.chcUserId ?? '',
    org_id: input.orgId ?? '',
    principal_source: input.principalSource,
    role: input.role,
    service_id: input.serviceId ?? '',
    sub: input.userId,
    tenant_id: input.tenantId,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function buildClaims(
  req: ServerRequest,
  config: SigningConfig,
  now: number,
  codeWorkerId?: string,
): CodeApiClaims {
  const user = resolveUser(req);
  const userId = resolveUserId(user);
  const tenantId = getCodeApiTenantId(req);

  const role = user.role ?? 'USER';
  const principalSource = resolvePrincipalSource(req);
  const orgId = stringifyClaimValue(user.orgId);
  const serviceId = stringifyClaimValue(user.serviceId);
  const chcUserId = stringifyClaimValue(user.chcUserId) ?? stringifyClaimValue(user.idOnTheSource);
  const planId = stringifyClaimValue(user.planId) ?? stringifyClaimValue(user.subscription?.planId);
  const authContextHash = canonicalContextHash({
    userId,
    tenantId,
    role,
    principalSource,
    orgId,
    serviceId,
    chcUserId,
  });

  return {
    iss: config.issuer,
    aud: config.audience,
    sub: userId,
    iat: now,
    nbf: now,
    exp: now + config.ttlSeconds,
    jti: randomUUID(),
    tenant_id: tenantId,
    role,
    principal_source: principalSource,
    ...(orgId ? { org_id: orgId } : {}),
    ...(serviceId ? { service_id: serviceId } : {}),
    ...(chcUserId ? { chc_user_id: chcUserId } : {}),
    ...(planId ? { plan_id: planId } : {}),
    ...(codeWorkerId != null && codeWorkerId !== '' ? { code_worker_id: codeWorkerId } : {}),
    auth_context_hash: authContextHash,
  };
}

function signJwt(config: SigningConfig, claims: CodeApiClaims): string {
  const header = {
    alg: config.alg,
    typ: 'JWT',
    kid: config.kid,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = cryptoSign(
    config.alg === 'RS256' ? 'RSA-SHA256' : null,
    Buffer.from(signingInput),
    config.key,
  );
  return `${signingInput}.${base64Url(signature)}`;
}

function cacheKey(config: SigningConfig, claims: CodeApiClaims): string {
  return JSON.stringify([
    config.alg,
    config.kid,
    claims.sub,
    claims.tenant_id,
    claims.role,
    claims.principal_source,
    claims.org_id ?? '',
    claims.service_id ?? '',
    claims.chc_user_id ?? '',
    claims.plan_id ?? '',
    claims.code_worker_id ?? '',
    claims.auth_context_hash,
  ]);
}

function pruneTokenCache(now: number): void {
  if (tokenCache.size === 0) {
    return;
  }
  if (now - tokenCacheLastPrunedAt < TOKEN_CACHE_PRUNE_INTERVAL_SECONDS) {
    return;
  }

  tokenCacheLastPrunedAt = now;
  for (const [key, cached] of tokenCache) {
    if (cached.cachedUntil <= now || cached.expiresAt <= now + TOKEN_REUSE_SAFETY_WINDOW_SECONDS) {
      tokenCache.delete(key);
    }
  }
}

export async function mintCodeApiToken(req: ServerRequest, codeWorkerId?: string): Promise<string> {
  if (!isCodeApiJwtAuthEnabled()) {
    return '';
  }

  const config = getSigningConfig();
  const now = Math.floor(Date.now() / 1000);
  pruneTokenCache(now);
  const claims = buildClaims(req, config, now, codeWorkerId);
  const key = cacheKey(config, claims);
  const cached = tokenCache.get(key);
  if (
    cached &&
    cached.cachedUntil > now &&
    cached.expiresAt > now + TOKEN_REUSE_SAFETY_WINDOW_SECONDS
  ) {
    return cached.token;
  }

  const token = signJwt(config, claims);
  tokenCache.set(key, {
    token,
    expiresAt: claims.exp,
    cachedUntil: Math.min(
      now + config.cacheSeconds,
      claims.exp - TOKEN_REUSE_SAFETY_WINDOW_SECONDS,
    ),
  });
  return token;
}

export async function getCodeApiAuthHeaders(
  req?: ServerRequest,
  codeWorkerId?: string,
): Promise<Record<string, string>> {
  if (!req || !isCodeApiJwtAuthEnabled()) {
    return {};
  }
  const token = await mintCodeApiToken(req, codeWorkerId);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
