import { logger } from '@librechat/data-schemas';
import { OPENID_SESSION_ENDED } from 'librechat-data-provider';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type {
  AdminRefreshBinding,
  AdminRefreshBindingLookup,
  AdminRefreshBindingLookupOutcome,
  AdminRefreshDeps,
  AdminRefreshTokenResolution,
  RefreshTokenset,
} from '~/auth/refresh';
import type { RefreshTokenBridgeDeleteInput, RefreshTokenBridgeInput } from '~/auth/openid/types';
import type { ProviderSessionAuthorizer } from './authorize';
import type { OpenIdSessionDeps } from '~/images/session';
import type { TokenResult } from '~/auth/openid/flight';
import {
  AdminRefreshError,
  lookupAdminRefreshBinding,
  precheckAdminRefreshBinding,
  resolveAdminRefreshToken,
} from '~/auth/refresh';
import { ProviderSessionUnavailableError } from './errors';

export type AdminRefreshProviderSessionDeps = Pick<
  AdminRefreshDeps,
  | 'findProviderSessionBinding'
  | 'preCheckProviderSession'
  | 'authorizeProviderSession'
  | 'getMode'
  | 'getProviderSessionClient'
  | 'upsertSession'
  | 'deleteSession'
  | 'getRefreshTokenBridge'
  | 'storeRefreshTokenBridge'
  | 'deleteRefreshTokenBridges'
  | 'bridgeGraceMs'
  | 'getRefreshTokenExpiryMs'
>;

export interface BuildAdminRefreshProviderSessionDepsInput {
  authorizer: ProviderSessionAuthorizer;
  getProviderSessionClient: () => { issuer: string; clientId: string } | null;
  findProviderSessionBinding: (refreshToken: string) => Promise<AdminRefreshBindingLookup | null>;
  getRefreshTokenBridge: (args: {
    oldRefreshToken: string;
    userId: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => Promise<{
    refreshToken: string;
    providerSession?: ProviderSessionRef;
    version?: string;
  } | null>;
  storeRefreshTokenBridge: (args: RefreshTokenBridgeInput) => Promise<string | null>;
  deleteRefreshTokenBridges: (args: RefreshTokenBridgeDeleteInput) => Promise<object | null>;
  bridgeGraceMs: number;
  upsertSession: OpenIdSessionDeps['upsertSession'];
  deleteSession: OpenIdSessionDeps['deleteSession'];
  /** The refresh-token lifetime backing a provider-session grant, evaluated per call; threaded
   *  through to `precheckAdminRefreshBinding` and `applyAdminRefresh`. */
  getRefreshTokenExpiryMs: () => number;
}

/** `{}` when the deployment mode is `'off'`; otherwise the full binding/check/persistence deps. */
export async function buildAdminRefreshProviderSessionDeps(
  deps: BuildAdminRefreshProviderSessionDepsInput,
): Promise<AdminRefreshProviderSessionDeps> {
  const mode = await deps.authorizer.getMode();
  if (mode === 'off') {
    return { getRefreshTokenExpiryMs: deps.getRefreshTokenExpiryMs };
  }
  return {
    findProviderSessionBinding: deps.findProviderSessionBinding,
    preCheckProviderSession: deps.authorizer.preCheck,
    authorizeProviderSession: deps.authorizer.authorize,
    getMode: deps.authorizer.getMode,
    getProviderSessionClient: deps.getProviderSessionClient,
    upsertSession: deps.upsertSession,
    deleteSession: deps.deleteSession,
    getRefreshTokenBridge: deps.getRefreshTokenBridge,
    storeRefreshTokenBridge: deps.storeRefreshTokenBridge,
    deleteRefreshTokenBridges: deps.deleteRefreshTokenBridges,
    bridgeGraceMs: deps.bridgeGraceMs,
    getRefreshTokenExpiryMs: deps.getRefreshTokenExpiryMs,
  };
}

export interface AdminOpenIdRefreshPrepareResult {
  providerSessionDeps: AdminRefreshProviderSessionDeps;
  binding: AdminRefreshBinding;
  /** Token to send to the IdP's refresh grant: the incoming token, or a bridged replacement
   *  recovered from a prior attempt. */
  grantRefreshToken: string;
  /** True when `grantRefreshToken` is a bridged replacement rather than the presented token. */
  bridged: boolean;
  /** Identity the bridge lookup resolved; feeds a flight key so concurrent retries sharing a
   *  bridged token coalesce into a single IdP grant, and feeds `applyAdminRefresh`'s post-grant
   *  bridge store so it keys the same row the lookup read. */
  identity?: AdminRefreshTokenResolution['identity'];
}

/** Removes a bridge discovered only to recover a missing Session row, once the precheck run
 *  against its ref denies it. Leaving the bridge in place would let the next retry rediscover
 *  the same denied ref and repeat the lookup for no benefit. Best-effort: a cleanup failure does
 *  not change the denial already decided. */
async function deleteStaleAdminRefreshBridge(
  refreshToken: string,
  identity: { userId: string; tenantId?: string },
  version: string | undefined,
  deps: AdminRefreshProviderSessionDeps,
): Promise<void> {
  if (!deps.deleteRefreshTokenBridges) return;
  try {
    await deps.deleteRefreshTokenBridges({
      refreshTokens: [refreshToken],
      userId: identity.userId,
      tenantId: identity.tenantId,
      version,
    });
  } catch (error) {
    logger.warn(
      '[prepareAdminOpenIdRefresh] Failed to remove the refresh-token bridge after a provider-session denial',
      { error },
    );
  }
}

/** Runs the provider-session precheck and refresh-token-bridge recovery that must happen before
 *  the IdP grant is spent. Reads the provider-session binding once and shares it between the
 *  precheck and the bridge resolution.
 *
 * The Session row a rotating admin refresh replaces is gone by the time a retry presents the
 * token it replaced, so a missing binding alone is not evidence the credential is unassociated:
 * the bridge recovered from that same prior attempt still carries the provider session it was
 * issued under. The bridge is resolved first and, when found, the precheck runs against its ref
 * instead of denying the retry as missing before the bridge is ever consulted. A binding read
 * from the Session row always wins over a bridge; the bridge is consulted only when the Session
 * row itself has nothing. */
export async function prepareAdminOpenIdRefresh(
  refreshToken: string,
  deps: BuildAdminRefreshProviderSessionDepsInput,
  options: { expectedIssuer?: string; userId?: string; tenantId?: string } = {},
): Promise<AdminOpenIdRefreshPrepareResult> {
  const providerSessionDeps = await buildAdminRefreshProviderSessionDeps(deps);
  const lookup = await lookupAdminRefreshBinding(refreshToken, providerSessionDeps);
  const resolution = await resolveAdminRefreshToken(
    refreshToken,
    lookup,
    providerSessionDeps,
    options,
  );

  const recoveredIdentity = resolution.bridged ? resolution.identity : undefined;
  const precheckLookup: AdminRefreshBindingLookupOutcome =
    lookup.ok && !lookup.binding && recoveredIdentity
      ? {
          ok: true,
          binding: {
            userId: recoveredIdentity.userId,
            tenantId: recoveredIdentity.tenantId,
            providerSession: resolution.providerSession ?? null,
          },
        }
      : lookup;

  let binding: AdminRefreshBinding;
  try {
    binding = await precheckAdminRefreshBinding(precheckLookup, providerSessionDeps);
  } catch (error) {
    if (
      precheckLookup !== lookup &&
      recoveredIdentity &&
      error instanceof AdminRefreshError &&
      error.code === OPENID_SESSION_ENDED
    ) {
      await deleteStaleAdminRefreshBridge(
        refreshToken,
        recoveredIdentity,
        resolution.bridgeVersion,
        providerSessionDeps,
      );
    }
    throw error;
  }

  return {
    providerSessionDeps,
    binding,
    grantRefreshToken: resolution.refreshToken,
    bridged: resolution.bridged,
    identity: resolution.identity,
  };
}

export interface AdminRefreshGrantDeps {
  /** Key of the flight that grants the bridged successor of the presented token. The browser's
   *  bridge recovery uses the same key, so a bridged admin retry and a bridged browser retry
   *  for the same token grant the successor once, and two admin retries coalesce. */
  createRefreshTokenBridgeFlightKey?: (args: {
    oldRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => string | null;
  /** Key of the flight that records the admin's own grant of the presented token. A browser can
   *  complete the bridge flight of a token the IdP has not spent yet (the login publication when
   *  `OPENID_REUSE_TOKENS` is on), so this record lives in a separate namespace. */
  createAdminRefreshGrantFlightKey?: (args: {
    oldRefreshToken?: string;
    userId?: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => string | null;
  acquireOpenIDRefreshFlight?: (args: { key?: string | null }) => Promise<{
    acquired: boolean;
    ownerId: string;
  }>;
  completeOpenIDRefreshFlight?: (args: {
    key?: string | null;
    ownerId?: string;
    tokens?: TokenResult | null;
  }) => Promise<unknown>;
  /** Confirms a completion write landed under this flight's ownership despite the write itself
   *  throwing; mirrors the main refresh path's indeterminate-completion check. */
  assertOpenIDRefreshFlightAvailable?: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<unknown>;
  waitForOpenIDRefreshFlight?: (args: {
    key?: string | null;
    timeoutMs?: number;
  }) => Promise<TokenResult | null>;
  withOpenIDRefreshFlightLease?: <T>(args: {
    key?: string | null;
    ownerId?: string;
    operation: (context: { assertLeaseOwned: () => Promise<unknown> }) => Promise<T>;
  }) => Promise<T>;
}

function coordinationUnavailable(cause?: unknown): ProviderSessionUnavailableError {
  return new ProviderSessionUnavailableError(
    'OpenID refresh coordination is temporarily unavailable',
    cause === undefined ? undefined : { cause },
  );
}

function withClaims(
  accessToken: string,
  refreshToken: string | undefined,
  claims: ReturnType<RefreshTokenset['claims']>,
): RefreshTokenset {
  return { access_token: accessToken, refresh_token: refreshToken, claims: () => claims };
}

/**
 * Reads a completed flight result as an admin tokenset. An admin grant stores the tokens at the
 * top level with `__identityClaims`. A browser publication or bridge recovery stores them under
 * `tokenset`, with the identity in `claims`. Returns `null` for a result that is not usable here:
 * missing tokens or subject, or a browser publication of the presented token itself (the login
 * publication when `OPENID_REUSE_TOKENS` is on), which is not a successor of that token.
 */
function readSharedAdminTokenset(
  result: TokenResult,
  presentedRefreshToken: string,
): RefreshTokenset | null {
  if (result.tokenset) {
    const { access_token: accessToken, refresh_token: refreshToken } = result.tokenset;
    const claims = typeof result.claims === 'object' ? result.claims : undefined;
    if (!accessToken || !refreshToken || refreshToken === presentedRefreshToken || !claims?.sub) {
      return null;
    }
    return withClaims(accessToken, refreshToken, {
      ...claims,
      iss: claims.iss ?? result.openidIssuer,
    });
  }
  const claims = result.__identityClaims;
  if (!result.access_token || !claims?.sub) {
    return null;
  }
  return withClaims(result.access_token, result.refresh_token, { ...claims });
}

/** Bounds the read of the recorded admin grant. A grant that is still pending cannot be the one
 *  the bridge points to, because the bridge is stored after the grant completes, so the read
 *  does not wait for it; the bound only gives the read itself time to run. */
const RECORDED_ADMIN_GRANT_READ_TIMEOUT_MS = 100;

/** Reads the admin grant recorded for the presented token. A missing, pending, failed or
 *  unreadable record is not an error here: the caller then coordinates a new grant of the
 *  successor. */
async function readRecordedAdminGrant(
  key: string,
  deps: AdminRefreshGrantDeps,
): Promise<TokenResult | null> {
  try {
    return (
      (await deps.waitForOpenIDRefreshFlight?.({
        key,
        timeoutMs: RECORDED_ADMIN_GRANT_READ_TIMEOUT_MS,
      })) ?? null
    );
  } catch (error) {
    logger.debug('[runAdminOpenIdRefreshGrant] No usable recorded admin grant', { error });
    return null;
  }
}

/** Waits for the owner of flight `key` and reads its result as an admin tokenset. A failed
 *  owner, a timed-out wait, or a result that is not usable answers a retryable `503`. */
async function waitForSharedAdminTokenset(
  key: string,
  presentedRefreshToken: string,
  deps: AdminRefreshGrantDeps,
): Promise<RefreshTokenset> {
  let resolved: TokenResult | null;
  try {
    resolved = (await deps.waitForOpenIDRefreshFlight?.({ key })) ?? null;
  } catch (error) {
    logger.warn('[runAdminOpenIdRefreshGrant] Failed while waiting for the shared refresh flight', {
      error,
    });
    throw coordinationUnavailable(error);
  }
  const tokenset = resolved ? readSharedAdminTokenset(resolved, presentedRefreshToken) : null;
  if (!tokenset) {
    if (resolved) {
      logger.warn(
        '[runAdminOpenIdRefreshGrant] The shared refresh flight holds no successor of the presented token',
      );
    }
    throw coordinationUnavailable();
  }
  return tokenset;
}

/**
 * Runs `grant` while this caller owns the flight `key`, and records the result on it.
 *
 * Only a coordination failure strictly before the grant starts maps to a `503`. Once the grant
 * has run, the IdP has already rotated the refresh token. A failure from the grant itself still
 * reaches the caller as-is. A failure from the lease's own bookkeeping after a successful grant
 * (the completion write, or the lease's post-operation renewal and ownership checks) must not
 * drop the rotated tokenset; it is returned so the caller can still persist it.
 */
async function runOwnedAdminGrant(
  grant: () => Promise<RefreshTokenset>,
  key: string,
  ownerId: string,
  deps: AdminRefreshGrantDeps & {
    withOpenIDRefreshFlightLease: NonNullable<
      AdminRefreshGrantDeps['withOpenIDRefreshFlightLease']
    >;
  },
): Promise<RefreshTokenset> {
  let grantStarted = false;
  let grantedTokenset: RefreshTokenset | undefined;
  try {
    return await deps.withOpenIDRefreshFlightLease({
      key,
      ownerId,
      operation: async () => {
        grantStarted = true;
        const tokenset = await grant();
        grantedTokenset = tokenset;
        let identityClaims: ReturnType<RefreshTokenset['claims']> | undefined;
        try {
          identityClaims = tokenset.claims();
        } catch {
          identityClaims = undefined;
        }
        try {
          await deps.completeOpenIDRefreshFlight?.({
            key,
            ownerId,
            tokens: {
              access_token: tokenset.access_token,
              refresh_token: tokenset.refresh_token,
              __identityClaims: identityClaims as TokenResult['__identityClaims'],
            },
          });
        } catch (completionError) {
          /** The IdP already rotated the refresh token at this point. Mirrors the main refresh
           *  path's indeterminate-completion handling: confirm whether the write landed under
           *  this flight's ownership despite the throw. Unlike the main path — which has already
           *  persisted the rotated tokens to the session before this write runs — nothing else
           *  recovers this tokenset once lost, so it is kept regardless of what the confirmation
           *  finds; `applyAdminRefresh` is what persists it and repoints the bridge. */
          try {
            await deps.assertOpenIDRefreshFlightAvailable?.({ key, ownerId });
          } catch {
            // Ownership could not be confirmed either; still keep the rotated tokenset.
          }
          logger.warn(
            '[runAdminOpenIdRefreshGrant] Flight completion failed after a successful grant; keeping the rotated tokenset',
            { error: completionError },
          );
        }
        return tokenset;
      },
    });
  } catch (error) {
    if (grantedTokenset) {
      logger.warn(
        '[runAdminOpenIdRefreshGrant] Refresh flight lease failed after a successful grant; keeping the rotated tokenset',
        { error },
      );
      return grantedTokenset;
    }
    if (!grantStarted) {
      logger.warn(
        '[runAdminOpenIdRefreshGrant] Refresh flight coordination failed before the grant started',
        { error },
      );
      throw coordinationUnavailable(error);
    }
    throw error;
  }
}

/**
 * Runs the IdP refresh-token grant for an admin refresh.
 *
 * Two flights are involved, with two different meanings:
 *  - The admin grant flight (`createAdminRefreshGrantFlightKey` of the presented token) records
 *    the admin's grant of the presented token. Only the admin reads it.
 *  - The bridge flight (`createRefreshTokenBridgeFlightKey` of the presented token) records the
 *    result that replaces the presented token. The browser's publication and bridge recovery
 *    also write it, so its result can have either shape.
 *
 * A direct (unbridged) grant runs under the admin grant flight. A caller that loses that flight
 * to a concurrent request with the same token waits for the owner's result instead of granting
 * the token a second time. Only a deployment without the key or the flight deps wired runs the
 * grant directly.
 *
 * A bridged retry (a prior attempt already spent the presented token) first reads the admin
 * grant flight: when its refresh token is the bridge's successor, that is the result of the grant
 * the bridge points to, and it is returned without a new IdP call. Otherwise the retry grants the
 * successor under the bridge flight, so concurrent admin and browser retries sharing the bridge
 * coalesce into a single IdP grant instead of racing a single-use rotating refresh token against
 * itself. A caller that loses that race reads the winner's result in either shape; a result that
 * is not usable answers a retryable `503`, never a tokenset with missing fields.
 *
 * `claims()` is rebuilt from the plain claims the winner recorded, since a function does not
 * survive the flight's encrypted JSON round trip.
 */
export async function runAdminOpenIdRefreshGrant(
  grant: () => Promise<RefreshTokenset>,
  presentedRefreshToken: string,
  prepared: Pick<AdminOpenIdRefreshPrepareResult, 'bridged' | 'identity'> &
    Partial<Pick<AdminOpenIdRefreshPrepareResult, 'grantRefreshToken'>>,
  deps: AdminRefreshGrantDeps,
): Promise<RefreshTokenset> {
  const identity = prepared.identity;
  const { acquireOpenIDRefreshFlight, withOpenIDRefreshFlightLease } = deps;
  if (!identity?.userId || !acquireOpenIDRefreshFlight || !withOpenIDRefreshFlightLease) {
    return grant();
  }
  const keyInput = {
    oldRefreshToken: presentedRefreshToken,
    userId: identity.userId,
    tenantId: identity.tenantId,
    openidIssuer: identity.openidIssuer,
  };
  const grantKey = deps.createAdminRefreshGrantFlightKey?.(keyInput) ?? null;
  const ownedDeps = { ...deps, withOpenIDRefreshFlightLease };

  if (!prepared.bridged) {
    if (!grantKey) {
      return grant();
    }
    let flight: { acquired: boolean; ownerId: string };
    try {
      flight = await acquireOpenIDRefreshFlight({ key: grantKey });
    } catch (error) {
      logger.warn('[runAdminOpenIdRefreshGrant] Failed to acquire the admin grant flight', {
        error,
      });
      throw coordinationUnavailable(error);
    }
    if (!flight.acquired) {
      /** A concurrent request with the same token owns the grant. Granting again would present a
       *  token the owner already spent, so this request takes the owner's result instead. */
      return waitForSharedAdminTokenset(grantKey, presentedRefreshToken, deps);
    }
    return runOwnedAdminGrant(grant, grantKey, flight.ownerId, ownedDeps);
  }

  const successor = prepared.grantRefreshToken;
  if (grantKey && successor) {
    const recorded = await readRecordedAdminGrant(grantKey, deps);
    if (recorded?.access_token && recorded.refresh_token === successor) {
      const tokenset = readSharedAdminTokenset(recorded, presentedRefreshToken);
      if (tokenset) {
        return tokenset;
      }
    }
  }

  const key = deps.createRefreshTokenBridgeFlightKey?.(keyInput);
  if (!key) {
    return grant();
  }

  let flight: { acquired: boolean; ownerId: string };
  try {
    flight = await acquireOpenIDRefreshFlight({ key });
  } catch (error) {
    logger.warn('[runAdminOpenIdRefreshGrant] Failed to acquire the shared refresh flight', {
      error,
    });
    throw coordinationUnavailable(error);
  }

  if (flight.acquired) {
    return runOwnedAdminGrant(grant, key, flight.ownerId, ownedDeps);
  }

  return waitForSharedAdminTokenset(key, presentedRefreshToken, deps);
}
