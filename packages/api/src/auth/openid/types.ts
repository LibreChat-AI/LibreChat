import type { OIDCTokens } from '@librechat/data-schemas';
import type {
  AuthIdentityContext,
  AuthIdentitySource,
  AuthIdentityTuple,
  OpenIDSessionIdentitySource,
  RefreshTokenBridgeIdentity,
} from '~/utils/identity';

export type TokenPreference = 'access_token' | 'id_token';
export type AsyncVoidCallback = (error?: Error | null) => void;
export type LeaseAssertion = () => Promise<object | null | boolean>;
export type LogArgument = string | number | boolean | Error | object | null | undefined;

export interface OpenIDPublicationGeneration {
  key: string;
  ownerId: string;
  createdAt?: number;
}

export interface OpenIDClaims {
  sub: string;
  oid?: string;
  email?: string;
  iss?: string;
}

export interface OpenIDTokenSet extends OIDCTokens {
  access_token?: string;
  expires_in?: number | string;
  claims?: () => OpenIDClaims;
  /**
   * Set non-enumerably when an inline refresh strips an expired carried-forward `id_token` from
   * the result. It is identity material only — never an authentication response token.
   */
  __identityIdToken?: string;
  /** Serializable identity evidence for shared-flight followers. */
  __identityClaims?: OpenIDClaims;
  /** Access token that the shared candidate advanced from. */
  __predecessorAccessToken?: string;
}

export interface SharedOpenIDRefreshResult {
  tokenset: OpenIDTokenSet;
  claims: OpenIDClaims;
  openidIssuer?: string;
  expires_at?: number;
  appAuthToken: string;
  predecessorAccessToken?: string;
  acceptedIdentity?: AuthIdentityContext;
  /** Non-enumerable durable generation marker restored by the flight service. */
  __flightOwnerId?: string;
  __flightCreatedAt?: number;
}

export interface SessionOpenIDTokens {
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  browserRefreshToken?: string;
  expiresAt?: number;
  lastRefreshedAt?: number;
  appUserId?: string;
  openidSubject?: string;
  tenantId?: string;
  openidIssuer?: string;
  accessTokenExpiresAt?: number;
  /** Durable coordination generation that authorized this session publication. */
  publicationFlightKey?: string;
  publicationFlightOwnerId?: string;
  publicationFlightCreatedAt?: number;
}

export interface OpenIDSession {
  openidTokens?: SessionOpenIDTokens;
  save?: (callback: AsyncVoidCallback) => void;
  reload?: (callback: AsyncVoidCallback) => void;
  destroy?: (callback: AsyncVoidCallback) => void;
}

export interface OpenIDRequest {
  headers?: { authorization?: string; cookie?: string };
  session?: OpenIDSession;
  sessionID?: string;
  user?: OpenIDUser;
}

export interface OpenIDResponse {
  headersSent?: boolean;
  cookie?: (name: string, value: string, options?: { expires?: Date }) => void;
  clearCookie?: (name: string) => void;
}

export interface OpenIDUser extends AuthIdentitySource {
  _id?: string | number | { toString(): string };
  id?: string;
  email?: string;
  provider?: string;
  openidId?: string;
  tenantId?: string;
  openidIssuer?: string;
  federatedTokens?: OIDCTokens;
}

export interface OpenIDRefreshResolution {
  tokenset: OpenIDTokenSet;
  claims: OpenIDClaims;
  openidIssuer?: string;
  user?: OpenIDUser | null;
  error?: string | null;
  migration?: boolean;
}

export interface OpenIDLogger {
  debug: (...args: LogArgument[]) => void;
  info: (...args: LogArgument[]) => void;
  warn: (...args: LogArgument[]) => void;
  error: (...args: LogArgument[]) => void;
}

export interface LeaseContext {
  assertLeaseOwned: LeaseAssertion;
  markLeaseSettled: () => void;
}

export interface RefreshFlightAcquireResult {
  acquired: boolean;
  key: string | null;
  ownerId: string;
  flight?: RefreshFlightRecord | null;
}

export interface RefreshFlightRecord {
  status?: 'pending' | 'completed' | 'failed' | 'revoked';
  ownerId?: string;
  createdAt?: Date | string;
  deliveryId?: string;
  deliveryExpiresAt?: Date | string;
  revocationRequestedAt?: Date | string;
  encryptedResult?: string;
  errorMessage?: string;
  expiresAt?: Date | string;
}

export interface RefreshTokenBridgeInput {
  oldRefreshToken: string;
  newRefreshToken: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  ttl?: number;
}

export interface RefreshTokenBridgeDeleteInput {
  refreshTokens: string[];
  userId: string;
  tenantId?: string;
  version?: string;
}

export interface RefreshKeyInput {
  req?: OpenIDRequest;
  user?: OpenIDUser;
  refreshToken?: string;
  identityContext?: AuthIdentityContext;
}

export type {
  AuthIdentityContext,
  AuthIdentitySource,
  AuthIdentityTuple,
  OpenIDSessionIdentitySource,
  OIDCTokens,
  RefreshTokenBridgeIdentity,
};
