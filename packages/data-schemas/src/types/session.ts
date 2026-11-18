import type { Document, Types } from 'mongoose';

/** How a session's credential was issued, matching the repo's login strategies
 *  (`api/strategies`): the OAuth2/OIDC social strategies share `'social'`. */
export type AuthMethod = 'local' | 'ldap' | 'saml' | 'openid' | 'social' | 'passkey';

export interface ISession extends Document {
  refreshTokenHash: string;
  expiration: Date;
  user: Types.ObjectId;
  tenantId?: string;
  authMethod?: AuthMethod;
}

export interface CreateSessionOptions {
  expiration?: Date;
  /** Duration in milliseconds for session expiry. Default: 7 days */
  expiresIn?: number;
  authMethod?: AuthMethod;
}

export interface UpsertSessionOptions {
  expiration: Date;
  tenantId?: string;
  authMethod?: AuthMethod;
}

export interface SessionSearchParams {
  refreshToken?: string;
  userId?: string;
  sessionId?: string | { sessionId: string };
}

export interface SessionQueryOptions {
  lean?: boolean;
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
