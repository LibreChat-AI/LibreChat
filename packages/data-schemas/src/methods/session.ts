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

export interface SessionMethods {
  findSession: (
    params: t.SessionSearchParams,
    options?: t.SessionQueryOptions,
  ) => Promise<t.SessionRecord | null>;
  SessionError: typeof SessionError;
  deleteSession: (params: t.DeleteSessionParams) => Promise<{ deletedCount?: number }>;
  createSession: (userId: string, options?: t.CreateSessionOptions) => Promise<t.SessionResult>;
  upsertSession: (
    userId: string,
    refreshToken: string,
    options: t.UpsertSessionOptions,
  ) => Promise<t.SessionRecord>;
  ensureSessionIndexes: () => Promise<void>;
  generateRefreshToken: (session: t.SessionRecord) => Promise<string>;
  deleteAllUserSessions: (
    userId: string | { userId: string },
    options?: t.DeleteAllSessionsOptions,
  ) => Promise<{ deletedCount?: number }>;
}

export interface SessionMethodDeps {
  signPayload?: typeof signPayload;
  hashToken?: typeof hashToken;
}

/** Shared signing policy; repositories own the insert or compare-and-swap. */
export async function createSessionToken(
  session: Pick<t.SessionRecord, '_id' | 'user' | 'expiration'>,
  deps: SessionMethodDeps = {},
): Promise<{ refreshToken: string; refreshTokenHash: string }> {
  const refreshToken = await (deps.signPayload ?? signPayload)({
    payload: {
      id: session.user,
      sessionId: session._id,
      issuedAtMs: Date.now(),
    },
    secret: process.env.JWT_REFRESH_SECRET!,
    expirationTime: Math.floor((session.expiration.getTime() - Date.now()) / 1000),
  });
  return { refreshToken, refreshTokenHash: await (deps.hashToken ?? hashToken)(refreshToken) };
}

type StoredSession = Omit<t.SessionRecord, '_id' | 'user'> & {
  _id: { toString(): string };
  user: { toString(): string };
};

function toSessionRecord(session: StoredSession): t.SessionRecord {
  return {
    _id: session._id.toString(),
    user: session.user.toString(),
    refreshTokenHash: session.refreshTokenHash,
    expiration: session.expiration,
    ...(session.tenantId == null ? {} : { tenantId: session.tenantId }),
  };
}

export function createSessionMethods(
  mongoose: typeof import('mongoose'),
  deps: SessionMethodDeps = {},
): SessionMethods {
  const digest = deps.hashToken ?? hashToken;
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
      const session = {
        _id: new mongoose.Types.ObjectId().toString(),
        user: userId,
        expiration: options.expiration || new Date(Date.now() + expiresIn),
      };
      const { refreshToken, refreshTokenHash } = await createSessionToken(session, deps);
      const stored = await Session.create({ ...session, refreshTokenHash });
      return { session: toSessionRecord(stored), refreshToken };
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
  ): Promise<t.SessionRecord> {
    if (!userId || !refreshToken || !options.expiration) {
      throw new SessionError('User, refresh token, and expiration are required', 'INVALID_SESSION');
    }

    try {
      await ensureSessionIndexes();
      const Session = mongoose.models.Session;
      const refreshTokenHash = await digest(refreshToken);
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
      )
        .lean<StoredSession>()
        .exec();
      if (!session) {
        throw new SessionError('Stored session was not returned', 'SESSION_NOT_FOUND');
      }
      return toSessionRecord(session);
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
    _options: t.SessionQueryOptions = { lean: true },
  ): Promise<t.SessionRecord | null> {
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
        const tokenHash = await digest(params.refreshToken);
        query.refreshTokenHash = tokenHash;
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

      const session = await Session.findOne(query).lean<StoredSession>().exec();
      return session ? toSessionRecord(session) : null;
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
        query.refreshTokenHash = await digest(params.refreshToken);
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
  async function generateRefreshToken(session: t.SessionRecord): Promise<string> {
    if (!session || !session.user) {
      throw new SessionError('Invalid session object', 'INVALID_SESSION');
    }
    try {
      const previousHash = session.refreshTokenHash;
      const expiration = session.expiration ?? new Date(Date.now() + DEFAULT_REFRESH_TOKEN_EXPIRY);
      const { refreshToken, refreshTokenHash } = await createSessionToken(
        { ...session, expiration },
        deps,
      );
      if (refreshTokenHash === previousHash) throw new Error('Refresh token did not change');
      const result = await mongoose.models.Session.updateOne(
        {
          _id: session._id,
          user: session.user,
          tenantId: session.tenantId ?? null,
          refreshTokenHash: previousHash,
          expiration: { $gt: new Date() },
        },
        { $set: { refreshTokenHash } },
      );
      if (result.matchedCount !== 1) {
        throw new SessionError('Session is no longer current', 'SESSION_NOT_FOUND');
      }
      return refreshToken;
    } catch (error) {
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
