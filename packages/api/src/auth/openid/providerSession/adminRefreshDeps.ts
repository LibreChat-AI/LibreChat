import type { ProviderSessionRef } from 'librechat-data-provider';
import type { RefreshTokenBridgeDeleteInput, RefreshTokenBridgeInput } from '~/auth/openid/types';
import type { AdminRefreshBinding, AdminRefreshDeps } from '~/auth/refresh';
import type { ProviderSessionAuthorizer } from './authorize';
import type { OpenIdSessionDeps } from '~/images/session';
import { precheckAdminRefreshBinding, resolveAdminRefreshToken } from '~/auth/refresh';

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
>;

export interface BuildAdminRefreshProviderSessionDepsInput {
  authorizer: ProviderSessionAuthorizer;
  getProviderSessionClient: () => { issuer: string; clientId: string } | null;
  findProviderSessionBinding: (refreshToken: string) => Promise<{
    userId?: string;
    tenantId?: string;
    providerSession?: ProviderSessionRef | null;
  } | null>;
  getRefreshTokenBridge: (args: {
    oldRefreshToken: string;
    userId: string;
    tenantId?: string;
    openidIssuer?: string;
  }) => Promise<{ refreshToken: string; providerSession?: ProviderSessionRef } | null>;
  storeRefreshTokenBridge: (args: RefreshTokenBridgeInput) => Promise<string | null>;
  deleteRefreshTokenBridges: (args: RefreshTokenBridgeDeleteInput) => Promise<object | null>;
  bridgeGraceMs: number;
  upsertSession: OpenIdSessionDeps['upsertSession'];
  deleteSession: OpenIdSessionDeps['deleteSession'];
}

/** `{}` when the deployment mode is `'off'`; otherwise the full binding/check/persistence deps. */
export async function buildAdminRefreshProviderSessionDeps(
  deps: BuildAdminRefreshProviderSessionDepsInput,
): Promise<AdminRefreshProviderSessionDeps> {
  const mode = await deps.authorizer.getMode();
  if (mode === 'off') {
    return {};
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
  };
}

export interface AdminOpenIdRefreshPrepareResult {
  providerSessionDeps: AdminRefreshProviderSessionDeps;
  binding: AdminRefreshBinding;
  /** Token to send to the IdP's refresh grant: the incoming token, or a bridged replacement
   *  recovered from a prior attempt. */
  grantRefreshToken: string;
  /** Present only after a bridge recovery; run after a successful refresh or a confirmed denial. */
  releaseBridge?: () => Promise<void>;
}

/** Runs the provider-session precheck and refresh-token-bridge recovery that must happen before
 *  the IdP grant is spent. */
export async function prepareAdminOpenIdRefresh(
  refreshToken: string,
  deps: BuildAdminRefreshProviderSessionDepsInput,
  options: { expectedIssuer?: string } = {},
): Promise<AdminOpenIdRefreshPrepareResult> {
  const providerSessionDeps = await buildAdminRefreshProviderSessionDeps(deps);
  const binding = await precheckAdminRefreshBinding(refreshToken, providerSessionDeps);
  const resolution = await resolveAdminRefreshToken(refreshToken, providerSessionDeps, options);
  return {
    providerSessionDeps,
    binding,
    grantRefreshToken: resolution.refreshToken,
    releaseBridge: resolution.releaseBridge,
  };
}
