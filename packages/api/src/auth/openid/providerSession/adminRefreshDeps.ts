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
  /** Same flight-key derivation the main refresh path's bridge recovery uses, so a bridged admin
   *  retry and a bridged browser retry sharing the token never collide, but two admin retries for
   *  the same bridged token coalesce. */
  createRefreshTokenBridgeFlightKey?: (args: {
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
  waitForOpenIDRefreshFlight?: (args: { key?: string | null }) => Promise<TokenResult | null>;
  withOpenIDRefreshFlightLease?: <T>(args: {
    key?: string | null;
    ownerId?: string;
    operation: (context: { assertLeaseOwned: () => Promise<unknown> }) => Promise<T>;
  }) => Promise<T>;
}

/**
 * Runs the IdP refresh-token grant for an admin refresh. When the resolved token is a bridged
 * replacement (a prior attempt already spent the presented token), wraps the grant in the main
 * refresh path's flight lease so two concurrent retries that both recovered the same bridge
 * coalesce into a single IdP grant instead of racing a single-use rotating refresh token against
 * itself — the loser would otherwise get `REFRESH_FAILED` from the IdP for no reason. A direct
 * (unbridged) grant, or a deployment without the flight deps wired, runs the grant unprotected.
 *
 * A caller that loses the race waits for the flight to complete and reconstructs a
 * {@link RefreshTokenset} from the winner's published result; `claims()` is rebuilt from the
 * plain `__identityClaims` the winner captured, since a function does not survive the flight's
 * encrypted JSON round trip.
 */
export async function runAdminOpenIdRefreshGrant(
  grant: () => Promise<RefreshTokenset>,
  presentedRefreshToken: string,
  prepared: Pick<AdminOpenIdRefreshPrepareResult, 'bridged' | 'identity'>,
  deps: AdminRefreshGrantDeps,
): Promise<RefreshTokenset> {
  if (!prepared.bridged || !prepared.identity?.userId) {
    return grant();
  }

  const key = deps.createRefreshTokenBridgeFlightKey?.({
    oldRefreshToken: presentedRefreshToken,
    userId: prepared.identity.userId,
    tenantId: prepared.identity.tenantId,
    openidIssuer: prepared.identity.openidIssuer,
  });
  if (!key || !deps.acquireOpenIDRefreshFlight || !deps.withOpenIDRefreshFlightLease) {
    return grant();
  }

  let flight: { acquired: boolean; ownerId: string };
  try {
    flight = await deps.acquireOpenIDRefreshFlight({ key });
  } catch (error) {
    logger.warn('[runAdminOpenIdRefreshGrant] Failed to acquire the shared refresh flight', {
      error,
    });
    throw new ProviderSessionUnavailableError(
      'OpenID refresh coordination is temporarily unavailable',
      { cause: error },
    );
  }

  if (!flight.acquired) {
    let resolved: TokenResult | null;
    try {
      resolved = (await deps.waitForOpenIDRefreshFlight?.({ key })) ?? null;
    } catch (error) {
      logger.warn(
        '[runAdminOpenIdRefreshGrant] Failed while waiting for the shared refresh flight',
        { error },
      );
      throw new ProviderSessionUnavailableError(
        'OpenID refresh coordination is temporarily unavailable',
        { cause: error },
      );
    }
    if (!resolved) {
      throw new ProviderSessionUnavailableError(
        'OpenID refresh coordination is temporarily unavailable',
      );
    }
    const claims = resolved.__identityClaims;
    return {
      access_token: resolved.access_token,
      refresh_token: resolved.refresh_token,
      claims: () => (claims ?? {}) as ReturnType<RefreshTokenset['claims']>,
    };
  }

  /** Only a coordination failure strictly before the grant starts maps to a `503`. Once the
   *  grant has run, the IdP has already rotated the refresh token. A failure from the grant
   *  itself still reaches the caller as-is. A failure from the lease's own bookkeeping after a
   *  successful grant — the flight-completion write above, or the lease's post-operation renewal
   *  and ownership checks — must not drop the rotated tokenset; it is returned so the caller can
   *  still persist it. */
  let grantStarted = false;
  let grantedTokenset: RefreshTokenset | undefined;
  try {
    return await deps.withOpenIDRefreshFlightLease({
      key,
      ownerId: flight.ownerId,
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
            ownerId: flight.ownerId,
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
            await deps.assertOpenIDRefreshFlightAvailable?.({ key, ownerId: flight.ownerId });
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
      throw new ProviderSessionUnavailableError(
        'OpenID refresh coordination is temporarily unavailable',
        { cause: error },
      );
    }
    throw error;
  }
}
