import { DEFAULT_REFRESH_TOKEN_EXPIRY, runAsSystem } from '@librechat/data-schemas';
import type { ISession, AuthMethod, DeleteSessionParams } from '@librechat/data-schemas';
import type { ProviderSessionRef } from 'librechat-data-provider';
import { math } from '~/utils/math';

export interface OpenIdSessionParams {
  userId: string;
  refreshToken?: string;
  tenantId?: string;
  previousRefreshToken?: string;
  /**
   * The token actually sent to the IdP's refresh grant, when it was a bridged replacement for
   * `previousRefreshToken` rather than `previousRefreshToken` itself. Deleted alongside
   * `previousRefreshToken` whenever the IdP rotated it (it differs from `refreshToken`), so the
   * Session row an earlier, lost request wrote for the bridged token doesn't outlive the retry
   * that replaces it. Left alone when the IdP didn't rotate it — it IS the token being stored.
   */
  grantRefreshToken?: string;
  /** The provider session this credential is bound to; omitted stores no binding. */
  providerSession?: ProviderSessionRef | null;
  authMethod?: AuthMethod;
}

export interface OpenIdSessionDeps {
  upsertSession: (
    userId: string,
    refreshToken: string,
    options: {
      expiration: Date;
      tenantId?: string;
      providerSession?: ProviderSessionRef;
      authMethod?: AuthMethod;
    },
  ) => Promise<ISession>;
  deleteSession: (params: DeleteSessionParams) => Promise<{ deletedCount?: number }>;
}

export async function storeOpenIdSession(
  params: OpenIdSessionParams,
  deps: OpenIdSessionDeps,
): Promise<boolean> {
  if (!params.userId || !params.refreshToken) {
    return false;
  }

  const refreshToken = params.refreshToken;
  const expiresIn = math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY);
  await runAsSystem(() =>
    deps.upsertSession(params.userId, refreshToken, {
      expiration: new Date(Date.now() + expiresIn),
      tenantId: params.tenantId,
      ...(params.providerSession ? { providerSession: params.providerSession } : {}),
      ...(params.authMethod ? { authMethod: params.authMethod } : {}),
    }),
  );
  const staleRefreshTokens = new Set<string>();
  if (params.previousRefreshToken && params.previousRefreshToken !== refreshToken) {
    staleRefreshTokens.add(params.previousRefreshToken);
  }
  if (params.grantRefreshToken && params.grantRefreshToken !== refreshToken) {
    staleRefreshTokens.add(params.grantRefreshToken);
  }
  for (const staleRefreshToken of staleRefreshTokens) {
    await runAsSystem(() => deps.deleteSession({ refreshToken: staleRefreshToken }));
  }
  return true;
}
