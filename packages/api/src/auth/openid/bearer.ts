import type {
  AuthorizeOpenIDSessionInput,
  AuthorizeOpenIDSessionResult,
  OpenIDSessionAuthorizationDeps,
  OpenIDSessionDenialCode,
} from './sessions';
import {
  authorizeOpenIDSession,
  createOpenIDSessionAuthorizationUnavailableError,
} from './sessions';

type AuthorizeOpenIDSessionBySessionId = Extract<
  AuthorizeOpenIDSessionInput,
  { sessionId: string }
>;
type AuthorizeOpenIDSessionBySid = Extract<AuthorizeOpenIDSessionInput, { sid: string }>;

/** Set after the caller's own post-authorization work so this per-token value never enters a
 *  cached auth-user document. */
export function applyOpenIDSessionIdClaim<T extends { openidSessionId?: string }>(
  user: T,
  sessionId: string | undefined,
): T {
  if (sessionId) {
    user.openidSessionId = sessionId;
  }
  return user;
}

/** A signed `tenantId` claim must match the user it was issued for; only enforced with
 *  enforcement on. */
export function isOpenIDBearerTenantClaimMismatched(
  enforcement: boolean | undefined,
  claimedTenantId: string | undefined,
  userTenantId: string | undefined,
): boolean {
  return Boolean(enforcement && claimedTenantId !== undefined && claimedTenantId !== userTenantId);
}

export type OpenIDBearerAuthorizationVerdict =
  | { outcome: 'authorized'; sessionId?: string }
  | { outcome: 'unavailable'; error: Error & { code: string } }
  | { outcome: 'denied'; code: OpenIDSessionDenialCode; message: string };

export function toOpenIDBearerAuthorizationVerdict(
  result: AuthorizeOpenIDSessionResult,
): OpenIDBearerAuthorizationVerdict {
  if (result.ok) {
    return { outcome: 'authorized', sessionId: result.sessionId };
  }
  if (result.code === 'unavailable') {
    return { outcome: 'unavailable', error: createOpenIDSessionAuthorizationUnavailableError() };
  }
  return { outcome: 'denied', code: result.code, message: 'OpenID session authorization denied' };
}

export interface AuthorizeOpenIDLibreChatBearerInput {
  sessionId: string | undefined;
  issuer: string | undefined;
  clientId: string | undefined;
  subject: string | undefined;
  user: string;
  tenantId?: string;
  provider?: string;
  prefetchedSession?: AuthorizeOpenIDSessionBySessionId['prefetchedSession'];
  prefetchedBinding?: AuthorizeOpenIDSessionBySessionId['prefetchedBinding'];
}

/** A local/LDAP bearer carries no `openidSessionId` and skips this check; an OpenID-backed
 *  bearer missing it is a legacy login and, with enforcement on, must re-authenticate. */
export async function authorizeOpenIDLibreChatBearer(
  input: AuthorizeOpenIDLibreChatBearerInput,
  deps: Partial<OpenIDSessionAuthorizationDeps>,
): Promise<AuthorizeOpenIDSessionResult> {
  const { sessionId, provider, ...identity } = input;
  if (!sessionId) {
    if (deps.enforcement && provider === 'openid') {
      return { ok: false, code: 'unknown_session' };
    }
    return { ok: true };
  }
  return authorizeOpenIDSession(
    { ...identity, sessionId } as AuthorizeOpenIDSessionBySessionId,
    deps as OpenIDSessionAuthorizationDeps,
  );
}

export interface OpenIDBearerPrefetchPayload {
  openidSessionId?: string;
  id?: string;
  tenantId?: string;
}

export interface OpenIDBearerPrefetch {
  prefetchedSession?: AuthorizeOpenIDSessionBySessionId['prefetchedSession'];
  prefetchedBinding?: AuthorizeOpenIDSessionBySessionId['prefetchedBinding'];
}

/** Starts the session and binding reads early so a caller can overlap them with its own user
 *  load; a read failure here is swallowed and retried by the later authorization call. */
export function prefetchOpenIDBearerContext(
  payload: OpenIDBearerPrefetchPayload | undefined,
  deps: Partial<Pick<OpenIDSessionAuthorizationDeps, 'enforcement' | 'authorization'>>,
): OpenIDBearerPrefetch {
  const canPrefetch = Boolean(deps.enforcement && payload?.openidSessionId);
  const prefetchedSession = canPrefetch
    ? deps.authorization?.findOpenIDSessionById(payload!.openidSessionId!)
    : undefined;
  prefetchedSession?.catch(() => {});
  const prefetchedBinding =
    canPrefetch && payload?.id && payload?.tenantId !== undefined
      ? deps.authorization?.findOpenIDBinding({
          sessionId: payload!.openidSessionId!,
          user: payload.id,
          tenantId: payload.tenantId,
        })
      : undefined;
  prefetchedBinding?.catch(() => {});
  return { prefetchedSession, prefetchedBinding };
}

export interface ResolveOpenIDLibreChatBearerVerdictInput {
  payload: { openidSessionId?: string; id?: string; tenantId?: string } | undefined;
  user: {
    id: string;
    openidIssuer?: string;
    openidId?: string;
    tenantId?: string;
    provider?: string;
  };
  clientId: string | undefined;
  prefetch: OpenIDBearerPrefetch;
}

export type OpenIDLibreChatBearerVerdict =
  | OpenIDBearerAuthorizationVerdict
  | { outcome: 'tenant_mismatch' };

/** Checks the signed tenant claim before authorizing the bearer's session; the tenant-claim
 *  check keeps its own outcome so a caller can log it distinctly from a denial. */
export async function resolveOpenIDLibreChatBearerVerdict(
  input: ResolveOpenIDLibreChatBearerVerdictInput,
  deps: Partial<OpenIDSessionAuthorizationDeps>,
): Promise<OpenIDLibreChatBearerVerdict> {
  const { payload, user, clientId, prefetch } = input;
  if (isOpenIDBearerTenantClaimMismatched(deps.enforcement, payload?.tenantId, user.tenantId)) {
    return { outcome: 'tenant_mismatch' };
  }
  const result = await authorizeOpenIDLibreChatBearer(
    {
      sessionId: payload?.openidSessionId,
      issuer: user.openidIssuer,
      clientId,
      subject: user.openidId,
      user: user.id,
      tenantId: user.tenantId,
      provider: user.provider,
      ...prefetch,
    },
    deps,
  );
  return toOpenIDBearerAuthorizationVerdict(result);
}

export interface OpenIDBearerPassportOptions {
  userId: string;
  logger: { warn: (message: string) => void };
  label: string;
}

export type OpenIDBearerPassportResult =
  | { ok: true; sessionId?: string }
  | { ok: false; args: [Error] | [null, false, { message: string; code?: string }] };

/** Maps a bearer verdict to passport's `done` arguments, logging a denial or mismatch before
 *  returning it. */
export function toOpenIDBearerPassportResult(
  verdict: OpenIDLibreChatBearerVerdict,
  { userId, logger, label }: OpenIDBearerPassportOptions,
): OpenIDBearerPassportResult {
  if (verdict.outcome === 'authorized') {
    return { ok: true, sessionId: verdict.sessionId };
  }
  if (verdict.outcome === 'tenant_mismatch') {
    logger.warn(`[${label}] Bearer tenant claim does not match user ${userId}`);
    return {
      ok: false,
      args: [
        null,
        false,
        { message: 'OpenID session authorization denied', code: 'identity_mismatch' },
      ],
    };
  }
  if (verdict.outcome === 'unavailable') {
    return { ok: false, args: [verdict.error] };
  }
  logger.warn(`[${label}] OpenID session authorization denied for user ${userId}: ${verdict.code}`);
  return { ok: false, args: [null, false, { message: verdict.message, code: verdict.code }] };
}

export interface AuthorizeOpenIDProviderBearerInput {
  issuer: string | undefined;
  clientId: string | undefined;
  subject: string | undefined;
  sid: string | undefined;
  user: string;
  tenantId?: string;
  payload: { aud?: string | string[]; azp?: string } | undefined;
}

/** With enforcement on, authorizes by `sid` regardless of audience; without a `sid`, only a
 *  token issued to this client is denied, and only under enforcement. */
export async function authorizeOpenIDProviderBearer(
  input: AuthorizeOpenIDProviderBearerInput,
  deps: Partial<OpenIDSessionAuthorizationDeps>,
): Promise<AuthorizeOpenIDSessionResult> {
  const { payload, sid, ...identity } = input;
  const issuedToClient = isOpenIDBearerIssuedToClient(payload, identity.clientId);
  if (!sid) {
    if (issuedToClient && deps.enforcement) {
      return { ok: false, code: 'unknown_session' };
    }
    return { ok: true };
  }
  if (!issuedToClient && !deps.enforcement) {
    return { ok: true };
  }
  const result = await authorizeOpenIDSession(
    { ...identity, sid } as AuthorizeOpenIDSessionBySid,
    deps as OpenIDSessionAuthorizationDeps,
  );
  // A foreign-audience sid with no LibreChat session binding is not a denial; only a real denial or outage is.
  if (!issuedToClient && !result.ok && result.code !== 'denied' && result.code !== 'unavailable') {
    return { ok: true };
  }
  return result;
}

/** Whether an ID token was issued to this client: its `aud` includes the client id, or its
 *  `azp` equals it. */
export function isOpenIDBearerIssuedToClient(
  payload: { aud?: string | string[]; azp?: string } | undefined,
  clientId: string | undefined,
): boolean {
  if (!clientId) {
    return false;
  }
  const aud = payload?.aud;
  const audIncludesClient = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
  return audIncludesClient || payload?.azp === clientId;
}
