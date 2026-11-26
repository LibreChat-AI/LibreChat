import type { Document, Types } from 'mongoose';

export interface ISession extends Document {
  refreshTokenHash: string;
  previousRefreshTokenHash?: string;
  rotatedAt?: Date;
  expiration: Date;
  user: Types.ObjectId;
  tenantId?: string;
}

export interface CreateSessionOptions {
  expiration?: Date;
  /** Duration in milliseconds for session expiry. Default: 7 days */
  expiresIn?: number;
}

export interface UpsertSessionOptions {
  expiration: Date;
  tenantId?: string;
}

export interface SessionSearchParams {
  refreshToken?: string;
  userId?: string;
  sessionId?: string | { sessionId: string };
}

export interface SessionQueryOptions {
  lean?: boolean;
  /**
   * Also match a refresh token that a rotation replaced at most this many milliseconds ago. Tabs
   * share one refresh cookie, so a refresh can carry a token another tab's refresh just replaced.
   */
  graceMs?: number;
}

export interface DeleteSessionParams {
  refreshToken?: string;
  sessionId?: string;
}

export interface DeleteAllSessionsOptions {
  excludeCurrentSession?: boolean;
  currentSessionId?: string;
}

export interface SessionResult {
  session: Partial<ISession>;
  refreshToken: string;
}

export interface SignPayloadParams {
  payload: Record<string, unknown>;
  secret?: string;
  expirationTime: number;
}
