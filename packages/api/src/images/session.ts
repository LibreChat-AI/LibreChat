import { DEFAULT_REFRESH_TOKEN_EXPIRY, runAsSystem } from '@librechat/data-schemas';
import type { ISession, AuthMethod, DeleteSessionParams } from '@librechat/data-schemas';
import type { ProviderSessionRef } from 'librechat-data-provider';
import { math } from '~/utils/math';

export interface OpenIdSessionParams {
  userId: string;
  refreshToken?: string;
  tenantId?: string;
  previousRefreshToken?: string;
  /** The provider session this credential is bound to; omitted stores no binding. */
  providerSession?: ProviderSessionRef | null;
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

/** Every Session this writes comes from an OpenID login or its refresh-token rotation, so it
 *  records `authMethod: 'openid'` itself; each rotation upserts a new Session doc. */
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
      authMethod: 'openid',
      ...(params.providerSession ? { providerSession: params.providerSession } : {}),
    }),
  );
  const previousRefreshToken = params.previousRefreshToken;
  if (previousRefreshToken && previousRefreshToken !== refreshToken) {
    await runAsSystem(() => deps.deleteSession({ refreshToken: previousRefreshToken }));
  }
  return true;
}
