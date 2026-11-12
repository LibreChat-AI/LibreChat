import type { ISession, SessionQueryOptions, SessionSearchParams } from '@librechat/data-schemas';
import type { AdminRefreshBindingLookup } from '~/auth/refresh';

export interface CreateFindProviderSessionBindingDeps {
  findSession: (
    params: SessionSearchParams,
    options?: SessionQueryOptions,
  ) => Promise<ISession | null>;
}

/**
 * Builds the `findProviderSessionBinding` dependency {@link prepareAdminOpenIdRefresh} uses to
 * read a presented refresh token's provider-session binding from the Session row. Factored out of
 * the inline adapter `routes/admin/auth.js` used to pass, keeping the same `findSession` call
 * arguments and field mapping.
 */
export function createFindProviderSessionBinding(
  deps: CreateFindProviderSessionBindingDeps,
): (refreshToken: string) => Promise<AdminRefreshBindingLookup | null> {
  return async (refreshToken: string): Promise<AdminRefreshBindingLookup | null> => {
    const session = await deps.findSession({ refreshToken }, { lean: true });
    if (!session) return null;
    return {
      userId: session.user ? String(session.user) : undefined,
      tenantId: session.tenantId,
      providerSession: session.providerSession,
    };
  };
}
