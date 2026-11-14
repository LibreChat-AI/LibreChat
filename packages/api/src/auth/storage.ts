import type {
  TokenQuery,
  TokenRecord,
  TokenDeleteResult,
  TokenMethods,
  SessionRecord,
  SessionMethods,
  TokenCreateData,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { PasswordResetInput, PasswordResetResult } from './passwordReset';
import type { storeOpenIdSession } from '../images/session';
import type { setLocalSessionCookies } from '../oauth/csrf';
import type { SafeErrorMetadata } from '../utils/errors';
import type { math } from '../utils/math';
import { getSafeErrorMetadata } from '../utils/errors';

type Identity = string | { toString(): string };
interface Account {
  _id?: Identity;
  tenantId?: string;
}
type TokenLookup = Omit<TokenQuery, 'userId'> & { userId?: Identity };
type TokenCreation = Omit<TokenCreateData, 'userId'> & { userId: Identity };
interface LogoutRequest {
  user: { _id: Identity };
  session?: { destroy(): void };
}

interface AuthenticationStorageDependencies<User extends Account> {
  sessions: Pick<
    SessionMethods,
    'findSession' | 'createSession' | 'deleteSession' | 'generateRefreshToken' | 'upsertSession'
  >;
  tokens: Pick<TokenMethods, 'findToken' | 'createToken' | 'deleteTokens'>;
  getUserById(userId: string): Promise<User | null>;
  updateUser(userId: string, update: { emailVerified: true }): Promise<User | null>;
  generateToken(user: User | null, expiresIn: number): Promise<string>;
  resetPassword(input: PasswordResetInput): Promise<PasswordResetResult>;
  storeOpenIdSession: typeof storeOpenIdSession;
  setLocalSessionCookies: typeof setLocalSessionCookies;
  setCloudFrontAuthCookies(
    req: Request | null,
    res: Response,
    user: User | null,
    options: { userId: string },
  ): void;
  math: typeof math;
  env: { REFRESH_TOKEN_EXPIRY?: string; SESSION_EXPIRY?: string };
  defaultRefreshTokenExpiry: number;
  defaultSessionExpiry: number;
  logger: {
    error(message: string, metadata: SafeErrorMetadata): void;
    debug(message: string, metadata: SafeErrorMetadata): void;
  };
}

export interface AuthenticationStorage<User extends Account> {
  findToken(
    query: TokenLookup,
    options?: Parameters<TokenMethods['findToken']>[1],
  ): Promise<TokenRecord | null>;
  createToken(data: TokenCreation): Promise<TokenRecord>;
  deleteTokens(query: TokenLookup): Promise<TokenDeleteResult>;
  verifyEmail(userId: Identity): Promise<User | null>;
  resetPassword(userId: Identity, token: string, password: string): Promise<PasswordResetResult>;
  storeOpenIDSession(
    userId: Identity,
    refreshToken?: string,
    tenantId?: string,
    previousRefreshToken?: string,
  ): Promise<boolean>;
  logoutUser(
    req: LogoutRequest,
    refreshToken?: string,
  ): Promise<{ status: number; message: string }>;
  setAuthTokens(
    userId: Identity,
    res: Response,
    session?: SessionRecord | null,
    req?: Request | null,
  ): Promise<string>;
}

/** Owns the legacy host's adaptation to plain authentication persistence. */
export function createAuthenticationStorage<User extends Account>(
  deps: AuthenticationStorageDependencies<User>,
): AuthenticationStorage<User> {
  const tokenQuery = (query: TokenLookup): TokenQuery => {
    const { userId, ...fields } = query;
    return userId === undefined ? fields : { ...fields, userId: String(userId) };
  };
  const openIdSessions = {
    upsertSession: deps.sessions.upsertSession,
    deleteSession: deps.sessions.deleteSession,
  };
  return {
    findToken(query: TokenLookup, options?: Parameters<TokenMethods['findToken']>[1]) {
      return deps.tokens.findToken(tokenQuery(query), options);
    },
    createToken(data: TokenCreation): Promise<TokenRecord> {
      return deps.tokens.createToken({ ...data, userId: String(data.userId) });
    },
    deleteTokens(query: TokenLookup) {
      return deps.tokens.deleteTokens(tokenQuery(query));
    },
    verifyEmail(userId: Identity): Promise<User | null> {
      return deps.updateUser(String(userId), { emailVerified: true });
    },
    resetPassword(userId: Identity, token: string, password: string): Promise<PasswordResetResult> {
      return deps.resetPassword({ userId: String(userId), token, password });
    },
    storeOpenIDSession(
      userId: Identity,
      refreshToken?: string,
      tenantId?: string,
      previousRefreshToken?: string,
    ): Promise<boolean> {
      return deps.storeOpenIdSession(
        { userId: String(userId), refreshToken, tenantId, previousRefreshToken },
        openIdSessions,
      );
    },
    async logoutUser(
      req: LogoutRequest,
      refreshToken?: string,
    ): Promise<{ status: number; message: string }> {
      try {
        const session = await deps.sessions.findSession({
          userId: String(req.user._id),
          refreshToken,
        });
        if (session) {
          try {
            await deps.sessions.deleteSession({ sessionId: String(session._id) });
          } catch (error) {
            deps.logger.error(
              '[logoutUser] Failed to delete session.',
              getSafeErrorMetadata(error),
            );
            return { status: 500, message: 'Failed to delete session.' };
          }
        }
        try {
          req.session!.destroy();
        } catch (error) {
          deps.logger.debug('[logoutUser] Failed to destroy session.', getSafeErrorMetadata(error));
        }
        return { status: 200, message: 'Logout successful' };
      } catch {
        return { status: 500, message: 'Failed to logout.' };
      }
    },
    async setAuthTokens(
      userId: Identity,
      res: Response,
      session: SessionRecord | null = null,
      req: Request | null = null,
    ): Promise<string> {
      try {
        let refreshToken: string;
        let expiration: Date;
        if (session && session._id && session.expiration != null) {
          expiration = session.expiration;
          refreshToken = await deps.sessions.generateRefreshToken(session);
        } else {
          const created = await deps.sessions.createSession(String(userId), {
            expiresIn: deps.math(deps.env.REFRESH_TOKEN_EXPIRY, deps.defaultRefreshTokenExpiry),
          });
          expiration = created.session.expiration;
          refreshToken = created.refreshToken;
        }
        const user = await deps.getUserById(String(userId));
        const token = await deps.generateToken(
          user,
          deps.math(deps.env.SESSION_EXPIRY, deps.defaultSessionExpiry),
        );
        const canonicalId = String(user?._id ?? userId);
        deps.setLocalSessionCookies(res, {
          refreshToken,
          expires: new Date(expiration.getTime()),
          userId: canonicalId,
          tenantId: user?.tenantId,
        });
        deps.setCloudFrontAuthCookies(req, res, user, { userId: canonicalId });
        return token;
      } catch (error) {
        deps.logger.error(
          '[setAuthTokens] Error in setting authentication tokens:',
          getSafeErrorMetadata(error),
        );
        throw error;
      }
    },
  };
}
