import { randomUUID } from 'node:crypto';
import type * as t from '~/types/session';
import { createIndexesWithRetry } from '~/utils/retry';
import { signPayload, hashToken } from '~/crypto';
import logger from '~/config/winston';

export class SessionError extends Error {
  public code: string;

  constructor(message: string, code: string = 'SESSION_ERROR') {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

/** Default refresh token expiry: 7 days in milliseconds */
export const DEFAULT_REFRESH_TOKEN_EXPIRY: number = 1000 * 60 * 60 * 24 * 7;

/** `SessionError` code for a rotation that another request completed first. */
export const REFRESH_TOKEN_ROTATED = 'REFRESH_TOKEN_ROTATED';

/**
 * How many replaced tokens a session keeps for `findSession`'s grace window. A session rotates once
 * per refresh round, so more rounds than this inside one window are not expected; the cap only
 * bounds the document.
 */
const MAX_PREVIOUS_REFRESH_TOKENS = 10;

// Factory function that takes mongoose instance and returns the methods
export function createSessionMethods(mongoose: typeof import('mongoose')): {
  findSession: (
    params: t.SessionSearchParams,
    options?: t.SessionQueryOptions,
  ) => Promise<t.ISession | null>;
  SessionError: typeof SessionError;
  deleteSession: (params: t.DeleteSessionParams) => Promise<{ deletedCount?: number }>;
  createSession: (userId: string, options?: t.CreateSessionOptions) => Promise<t.SessionResult>;
  upsertSession: (
    userId: string,
    refreshToken: string,
    options: t.UpsertSessionOptions,
  ) => Promise<t.ISession>;
  ensureSessionIndexes: () => Promise<void>;
  generateRefreshToken: (session: t.ISession) => Promise<string>;
  deleteAllUserSessions: (
    userId: string | { userId: string },
    options?: t.DeleteAllSessionsOptions,
  ) => Promise<{ deletedCount?: number }>;
} {
  let sessionIndexesPromise: Promise<void> | null = null;

  function ensureSessionIndexes(): Promise<void> {
    if (!sessionIndexesPromise) {
      sessionIndexesPromise = createIndexesWithRetry(mongoose.models.Session).catch((error) => {
        sessionIndexesPromise = null;
        throw error;
      });
    }
    return sessionIndexesPromise;
  }

  /**
   * Creates a new session for a user
   */
  async function createSession(
    userId: string,
    options: t.CreateSessionOptions = {},
  ): Promise<t.SessionResult> {
    if (!userId) {
      throw new SessionError('User ID is required', 'INVALID_USER_ID');
    }

    const expiresIn = options.expiresIn ?? DEFAULT_REFRESH_TOKEN_EXPIRY;

    try {
      await ensureSessionIndexes();
      const Session = mongoose.models.Session;
      const currentSession = new Session({
        user: userId,
        expiration: options.expiration || new Date(Date.now() + expiresIn),
      });
      const refreshToken = await generateRefreshToken(currentSession);

      return { session: currentSession, refreshToken };
    } catch (error) {
      logger.error('[createSession] Error creating session:', error);
      throw new SessionError('Failed to create session', 'CREATE_SESSION_FAILED');
    }
  }

  /** Stores an externally issued refresh token so logout and administrative revocation apply. */
  async function upsertSession(
    userId: string,
    refreshToken: string,
    options: t.UpsertSessionOptions,
  ): Promise<t.ISession> {
    if (!userId || !refreshToken || !options.expiration) {
      throw new SessionError('User, refresh token, and expiration are required', 'INVALID_SESSION');
    }

    try {
      await ensureSessionIndexes();
      const Session = mongoose.models.Session;
      const refreshTokenHash = await hashToken(refreshToken);
      const update: Record<string, unknown> = {
        user: userId,
        refreshTokenHash,
        expiration: options.expiration,
      };
      if (options.tenantId) {
        update.tenantId = options.tenantId;
      }
      const session = await Session.findOneAndUpdate(
        { user: userId, refreshTokenHash },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
      if (!session) {
        throw new SessionError('Stored session was not returned', 'SESSION_NOT_FOUND');
      }
      return session as t.ISession;
    } catch (error) {
      logger.error('[upsertSession] Error storing session:', error);
      throw new SessionError('Failed to store session', 'UPSERT_SESSION_FAILED');
    }
  }

  /**
   * Finds a session by various parameters
   */
  async function findSession(
    params: t.SessionSearchParams,
    options: t.SessionQueryOptions = { lean: true },
  ): Promise<t.ISession | null> {
    try {
      const Session = mongoose.models.Session;
      const query: Record<string, unknown> = {};

      if (!params.refreshToken && !params.userId && !params.sessionId) {
        throw new SessionError(
          'At least one search parameter is required',
          'INVALID_SEARCH_PARAMS',
        );
      }

      if (params.refreshToken) {
        const tokenHash = await hashToken(params.refreshToken);
        if (options.graceMs) {
          const rotatedAfter = new Date(Date.now() - options.graceMs);
          query.$or = [
            { refreshTokenHash: tokenHash },
            {
              previousRefreshTokens: {
                $elemMatch: { hash: tokenHash, rotatedAt: { $gt: rotatedAfter } },
              },
            },
          ];
        } else {
          query.refreshTokenHash = tokenHash;
        }
      }

      if (params.userId) {
        query.user = params.userId;
      }

      if (params.sessionId) {
        const sessionId =
          typeof params.sessionId === 'object' &&
          params.sessionId !== null &&
          'sessionId' in params.sessionId
            ? (params.sessionId as { sessionId: string }).sessionId
            : (params.sessionId as string);
        if (!mongoose.Types.ObjectId.isValid(sessionId)) {
          throw new SessionError('Invalid session ID format', 'INVALID_SESSION_ID');
        }
        query._id = sessionId;
      }

      // Add expiration check to only return valid sessions
      query.expiration = { $gt: new Date() };

      const sessionQuery = Session.findOne(query);

      if (options.lean) {
        return (await sessionQuery.lean()) as t.ISession | null;
      }

      return await sessionQuery.exec();
    } catch (error) {
      logger.error('[findSession] Error finding session:', error);
      throw new SessionError('Failed to find session', 'FIND_SESSION_FAILED');
    }
  }

  /**
   * Deletes a session by refresh token or session ID
   */
  async function deleteSession(params: t.DeleteSessionParams): Promise<{ deletedCount?: number }> {
    try {
      const Session = mongoose.models.Session;
      if (!params.refreshToken && !params.sessionId) {
        throw new SessionError(
          'Either refreshToken or sessionId is required',
          'INVALID_DELETE_PARAMS',
        );
      }

      const query: Record<string, unknown> = {};

      if (params.refreshToken) {
        query.refreshTokenHash = await hashToken(params.refreshToken);
      }

      if (params.sessionId) {
        query._id = params.sessionId;
      }

      const result = await Session.deleteOne(query);

      if (result.deletedCount === 0) {
        logger.warn('[deleteSession] No session found to delete');
      }

      return result;
    } catch (error) {
      logger.error('[deleteSession] Error deleting session:', error);
      throw new SessionError('Failed to delete session', 'DELETE_SESSION_FAILED');
    }
  }

  /**
   * Deletes all sessions for a user
   */
  async function deleteAllUserSessions(
    userId: string | { userId: string },
    options: t.DeleteAllSessionsOptions = {},
  ): Promise<{ deletedCount?: number }> {
    try {
      const Session = mongoose.models.Session;
      if (!userId) {
        throw new SessionError('User ID is required', 'INVALID_USER_ID');
      }

      const userIdString =
        typeof userId === 'object' && userId !== null ? userId.userId : (userId as string);

      if (!mongoose.Types.ObjectId.isValid(userIdString)) {
        throw new SessionError('Invalid user ID format', 'INVALID_USER_ID_FORMAT');
      }

      const query: Record<string, unknown> = { user: userIdString };

      if (options.excludeCurrentSession && options.currentSessionId) {
        query._id = { $ne: options.currentSessionId };
      }

      const result = await Session.deleteMany(query);

      if (result.deletedCount && result.deletedCount > 0) {
        logger.debug(
          `[deleteAllUserSessions] Deleted ${result.deletedCount} sessions for user ${userIdString}.`,
        );
      }

      return result;
    } catch (error) {
      logger.error('[deleteAllUserSessions] Error deleting user sessions:', error);
      throw new SessionError('Failed to delete user sessions', 'DELETE_ALL_SESSIONS_FAILED');
    }
  }

  /**
   * Generates a refresh token for a session
   */
  async function generateRefreshToken(session: t.ISession): Promise<string> {
    if (!session || !session.user) {
      throw new SessionError('Invalid session object', 'INVALID_SESSION');
    }

    try {
      const expiresIn = session.expiration
        ? session.expiration.getTime()
        : Date.now() + DEFAULT_REFRESH_TOKEN_EXPIRY;

      if (!session.expiration) {
        session.expiration = new Date(expiresIn);
      }

      const refreshToken = await signPayload({
        payload: {
          id: session.user,
          sessionId: session._id,
          /** `iat` is whole seconds, too coarse to order this token against a password reset that
           * lands in the same second. `isTokenRetired` reads this claim to settle that exactly. */
          issuedAtMs: Date.now(),
          /** Tokens minted in the same millisecond would otherwise be identical, and a rotation
           * that reproduced the current token would leave its hash, and so the race, open. */
          jti: randomUUID(),
        },
        secret: process.env.JWT_REFRESH_SECRET!,
        expirationTime: Math.floor((expiresIn - Date.now()) / 1000),
      });

      const refreshTokenHash = await hashToken(refreshToken);
      const replaced = session.isNew ? undefined : session.refreshTokenHash;
      if (!replaced) {
        session.refreshTokenHash = refreshTokenHash;
        await session.save();
        return refreshToken;
      }

      /**
       * Two refreshes can read the session before either rotates it. Only the first may replace the
       * hash: if both did, the stored hash and the cookie the browser keeps could name different
       * tokens, and every later refresh would be refused.
       */
      const { matchedCount } = await mongoose.models.Session.updateOne(
        { _id: session._id, refreshTokenHash: replaced },
        {
          $set: { refreshTokenHash },
          $push: {
            previousRefreshTokens: {
              $each: [{ hash: replaced, rotatedAt: new Date() }],
              $slice: -MAX_PREVIOUS_REFRESH_TOKENS,
            },
          },
        },
      );
      if (!matchedCount) {
        throw new SessionError('Refresh token was already rotated', REFRESH_TOKEN_ROTATED);
      }
      session.refreshTokenHash = refreshTokenHash;

      return refreshToken;
    } catch (error) {
      if (error instanceof SessionError) {
        throw error;
      }
      logger.error('[generateRefreshToken] Error generating refresh token:', error);
      throw new SessionError('Failed to generate refresh token', 'GENERATE_TOKEN_FAILED');
    }
  }

  return {
    findSession,
    SessionError,
    deleteSession,
    createSession,
    upsertSession,
    ensureSessionIndexes,
    generateRefreshToken,
    deleteAllUserSessions,
  };
}

export type SessionMethods = ReturnType<typeof createSessionMethods>;
