import { logger } from '@librechat/data-schemas';
import { getRefreshGraceMs } from './localRefresh';

type UserIdentifier = string | { toString(): string };

interface LogoutRequest {
  user: { _id: UserIdentifier };
  session?: { destroy: () => unknown } | null;
}

export interface LogoutResult {
  status: number;
  message: string;
}

interface LogoutDependencies {
  findSession: (
    query: { userId: string; refreshToken?: string },
    options: { lean: true; graceMs: number },
  ) => Promise<{ _id: UserIdentifier } | null>;
  deleteSession: (query: { sessionId: string }) => Promise<unknown>;
}

/**
 * Ends the refresh session a logout presents. Tabs share one refresh cookie, so the logout can
 * carry a token another tab's refresh replaced a moment earlier; the lookup takes the same grace
 * window the refresh route does, or a logout racing a refresh would leave the session alive.
 */
export function createLogoutUser(
  deps: LogoutDependencies,
): (req: LogoutRequest, refreshToken?: string) => Promise<LogoutResult> {
  return async (req, refreshToken) => {
    try {
      const session = await deps.findSession(
        { userId: req.user._id.toString(), refreshToken },
        { lean: true, graceMs: getRefreshGraceMs() },
      );

      if (session) {
        try {
          await deps.deleteSession({ sessionId: session._id.toString() });
        } catch (error) {
          logger.error('[logoutUser] Failed to delete session.', error);
          return { status: 500, message: 'Failed to delete session.' };
        }
      }

      try {
        req.session?.destroy();
      } catch (error) {
        logger.debug('[logoutUser] Failed to destroy session.', error);
      }

      return { status: 200, message: 'Logout successful' };
    } catch (error) {
      logger.error('[logoutUser] Failed to log out.', error);
      return { status: 500, message: 'Logout failed' };
    }
  };
}
