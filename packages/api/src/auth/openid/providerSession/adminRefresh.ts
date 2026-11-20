import { logger } from '@librechat/data-schemas';
import type { AdminAuthErrorResponse } from '~/auth/adminAuthErrors';
import type { AdminRefreshDeps, RefreshTokenset } from '~/auth/refresh';
import type { AdminExchangeResponse } from '~/auth/exchange';
import type {
  AdminRefreshGrantDeps,
  BuildAdminRefreshProviderSessionDepsInput,
} from './adminRefreshDeps';
import { mapAdminAuthError, mapAdminRefreshError } from '~/auth/adminAuthErrors';
import { prepareAdminOpenIdRefresh, runAdminOpenIdRefreshGrant } from './adminRefreshDeps';
import { applyAdminRefresh } from '~/auth/refresh';

export interface AdminOpenIdRefreshRequest {
  /** The refresh token the admin panel sent. */
  refreshToken: string;
  /** User `_id` from the previous admin-panel session, when the panel sent one. */
  userId?: string;
  /** Tenant resolved by the route's pre-auth tenant scope. */
  tenantId?: string;
  /** Issuer of the configured OpenID provider. */
  expectedIssuer?: string;
}

export interface AdminOpenIdRefreshDeps {
  /** Sends the given refresh token to the IdP's refresh-token grant. */
  grant: (refreshToken: string) => Promise<RefreshTokenset>;
  providerSession: BuildAdminRefreshProviderSessionDepsInput;
  flight: AdminRefreshGrantDeps;
  /** User lookup, admin-access checks and token minting for {@link applyAdminRefresh}. */
  user: Pick<
    AdminRefreshDeps,
    | 'findUsers'
    | 'getUserById'
    | 'mintToken'
    | 'canAccessAdmin'
    | 'isEmailAllowed'
    | 'onRefreshSuccess'
  >;
}

export type AdminOpenIdRefreshOutcome =
  | { ok: true; value: AdminExchangeResponse }
  | { ok: false; error: AdminAuthErrorResponse };

/**
 * Runs the OpenID admin refresh: the provider-session precheck and bridge recovery
 * ({@link prepareAdminOpenIdRefresh}), the coordinated IdP grant
 * ({@link runAdminOpenIdRefreshGrant}), then authorization, persistence and minting
 * ({@link applyAdminRefresh}).
 *
 * A coded failure returns `{ ok: false }` with the HTTP response to send. A grant failure is
 * classified by {@link mapAdminRefreshError}. Any other failure throws.
 */
export async function refreshAdminOpenIdSession(
  request: AdminOpenIdRefreshRequest,
  deps: AdminOpenIdRefreshDeps,
): Promise<AdminOpenIdRefreshOutcome> {
  const { refreshToken, userId, tenantId, expectedIssuer } = request;

  let prepared: Awaited<ReturnType<typeof prepareAdminOpenIdRefresh>>;
  try {
    prepared = await prepareAdminOpenIdRefresh(refreshToken, deps.providerSession, {
      expectedIssuer,
      userId,
      tenantId,
    });
  } catch (error) {
    const mapped = mapAdminAuthError(error);
    if (mapped) {
      return { ok: false, error: mapped };
    }
    throw error;
  }

  let tokenset: RefreshTokenset;
  try {
    tokenset = await runAdminOpenIdRefreshGrant(
      () => deps.grant(prepared.grantRefreshToken),
      refreshToken,
      prepared,
      deps.flight,
    );
    const granted = tokenset as RefreshTokenset & { id_token?: string; expires_in?: number };
    logger.debug('[admin/oauth/refresh] OpenID refresh succeeded', {
      has_access_token: Boolean(granted.access_token),
      has_id_token: Boolean(granted.id_token),
      has_refresh_token: Boolean(granted.refresh_token),
      expires_in: granted.expires_in,
    });
  } catch (error) {
    const details = (error ?? {}) as { code?: unknown; name?: unknown };
    logger.warn('[admin/oauth/refresh] IdP refresh grant failed', {
      code: details.code,
      name: details.name,
    });
    return { ok: false, error: mapAdminRefreshError(error) };
  }

  try {
    const value = await applyAdminRefresh(
      tokenset,
      { ...deps.user, ...prepared.providerSessionDeps },
      {
        userId,
        previousRefreshToken: refreshToken,
        grantRefreshToken: prepared.grantRefreshToken,
        expectedIssuer,
        tenantId,
        boundProviderSession: prepared.binding.ref,
        bridgeIdentity: prepared.identity,
      },
    );
    return { ok: true, value };
  } catch (error) {
    const mapped = mapAdminAuthError(error);
    if (mapped) {
      return { ok: false, error: mapped };
    }
    throw error;
  }
}
