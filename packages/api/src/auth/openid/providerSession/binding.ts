import type { ISession, SessionQueryOptions, SessionSearchParams } from '@librechat/data-schemas';
import type { ProviderSessionRef } from 'librechat-data-provider';

/** The provider-session binding the Session row stores for a refresh token. */
export interface ProviderSessionBinding {
  userId?: string;
  tenantId?: string;
  providerSession?: ProviderSessionRef | null;
}

export interface CreateFindProviderSessionBindingDeps {
  findSession: (
    params: SessionSearchParams,
    options?: SessionQueryOptions,
  ) => Promise<ISession | null>;
}

/**
 * Builds a lookup that reads a presented refresh token's provider-session binding from the
 * Session row (keyed by the refresh token hash). Returns `null` when no row matches.
 */
export function createFindProviderSessionBinding(
  deps: CreateFindProviderSessionBindingDeps,
): (refreshToken: string) => Promise<ProviderSessionBinding | null> {
  return async (refreshToken: string): Promise<ProviderSessionBinding | null> => {
    const session = await deps.findSession({ refreshToken }, { lean: true });
    if (!session) return null;
    return {
      userId: session.user ? String(session.user) : undefined,
      tenantId: session.tenantId,
      providerSession: session.providerSession,
    };
  };
}
