import { DEFAULT_REFRESH_TOKEN_EXPIRY, runAsSystem } from '@librechat/data-schemas';
import type { ISession, DeleteSessionParams } from '@librechat/data-schemas';
import { math } from '~/utils/math';

export interface OpenIdSessionParams {
  userId: string;
  refreshToken?: string;
  tenantId?: string;
  previousRefreshToken?: string;
}

export interface OpenIdSessionDeps {
  upsertSession: (
    userId: string,
    refreshToken: string,
    options: { expiration: Date; tenantId?: string },
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
    }),
  );
  const previousRefreshToken = params.previousRefreshToken;
  if (previousRefreshToken && previousRefreshToken !== refreshToken) {
    await runAsSystem(() => deps.deleteSession({ refreshToken: previousRefreshToken }));
  }
  return true;
}
