import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createSessionModel } from '~/models/session';
import { hashToken } from '~/crypto';

export interface DiscordBrowserSession {
  sessionId: string;
  userId: string;
  tenantId?: string;
  expiresAtMs: number;
}
export interface DiscordBrowserSessionStorage {
  read(input: {
    userId: string;
    refreshToken?: string;
    sessionId?: string;
  }): Promise<DiscordBrowserSession | null>;
}

/** Plain session projection for OAuth callbacks; the original session remains the revocation authority. */
export function createDiscordBrowserSessionStorage(
  mongoose: typeof import('mongoose'),
): DiscordBrowserSessionStorage {
  const sessions = createSessionModel(mongoose);
  return {
    async read(input) {
      const tenantId = getTenantId() || undefined;
      if (tenantId === SYSTEM_TENANT_ID)
        throw new TypeError('Discord browser sessions require a tenant scope');
      if (
        !mongoose.isValidObjectId(input.userId) ||
        (!input.refreshToken && !input.sessionId) ||
        (input.sessionId !== undefined && !mongoose.isValidObjectId(input.sessionId))
      )
        return null;
      const session = await sessions
        .findOne({
          user: input.userId,
          tenantId: tenantId ?? null,
          expiration: { $gt: new Date() },
          ...(input.sessionId ? { _id: input.sessionId } : {}),
          ...(input.refreshToken ? { refreshTokenHash: await hashToken(input.refreshToken) } : {}),
        })
        .select('_id user tenantId expiration')
        .read('primary')
        .lean();
      if (
        !session ||
        String(session.user) !== input.userId ||
        (session.tenantId || undefined) !== tenantId
      )
        return null;
      return {
        sessionId: String(session._id),
        userId: String(session.user),
        tenantId,
        expiresAtMs: session.expiration.getTime(),
      };
    },
  };
}
