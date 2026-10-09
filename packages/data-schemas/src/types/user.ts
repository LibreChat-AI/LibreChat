import type {
  TUserFavorite,
  RefillIntervalUnit,
  BalanceRefillMode,
  StatefulCodeEnvironment,
} from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';
import { CursorPaginationParams } from '~/common';

export interface IUser extends Document {
  _id: Types.ObjectId;
  /**
   * Mongoose's `Document.id` virtual is typed `id?: any`. At runtime it's
   * always `_id.toString()` for a hydrated doc, so narrow to a required
   * string. This also lets `IUser` satisfy Express.User augmentations
   * (the OIDC remote-agent middleware assigns `req.user = IUser` where
   * the project's local `Express.User` requires `id: string`).
   */
  id: string;
  name?: string;
  username?: string;
  email: string;
  emailVerified: boolean;
  emailChangedAt?: Date;
  password?: string;
  avatar?: string;
  provider: string;
  role?: string;
  googleId?: string;
  facebookId?: string;
  openidId?: string;
  samlId?: string;
  ldapId?: string;
  githubId?: string;
  discordId?: string;
  appleId?: string;
  plugins?: string[];
  openidIssuer?: string;
  twoFactorEnabled?: boolean;
  /**
   * When required enrollment promoted this account. Access tokens are stateless, so this is the
   * cutoff that retires the ones minted while the account still had no second factor.
   */
  twoFactorEnrolledAt?: Date | null;
  totpSecret?: string;
  backupCodes?: Array<{
    codeHash: string;
    used: boolean;
    usedAt?: Date | null;
  }>;
  pendingTotpSecret?: string;
  pendingBackupCodes?: Array<{
    codeHash: string;
    used: boolean;
    usedAt?: Date | null;
  }>;
  /** Instant of the last credential change; bearer tokens issued before it are rejected */
  credentialsChangedAt?: Date | null;
  /** SHA-256 hash of the one-time nonce that authorizes the backup-code acknowledgement step. */
  twoFactorAcknowledgementNonceHash?: string | null;
  /** SHA-256 hash of the one-time nonce that authorizes required-enrollment finalization. */
  twoFactorFinalizationNonceHash?: string | null;
  refreshToken?: Array<{
    refreshToken: string;
  }>;
  expiresAt?: Date;
  termsAccepted?: boolean;
  termsAcceptedAt?: Date | null;
  /** Internal fence that prevents agent-trigger admission during account deletion. */
  agentTriggerDeletionStartedAt?: Date;
  /** Expiring fences closing subagent admission while bulk deletions drain. */
  subagentAdmissionFences?: Array<{
    token: string;
    expiresAt: Date;
  }>;
  personalization?: {
    memories?: boolean;
    statefulCodeEnvironment?: StatefulCodeEnvironment;
  };
  favorites?: TUserFavorite[];
  /** Display order for the sidebar's Pinned section: favorite and pinned-chat
   *  entry keys interleaved (`agent:`, `spec:`, `model:`, `convo:` prefixes). */
  pinnedOrder?: string[];
  /** Per-skill active/inactive overrides. Key = skillId, value = active state. */
  skillStates?: Record<string, boolean>;
  createdAt?: Date;
  updatedAt?: Date;
  /** Field for external source identification (for consistency with TPrincipal schema) */
  idOnTheSource?: string;
  tenantId?: string;
  federatedTokens?: OIDCTokens;
  openidTokens?: OIDCTokens;
}

/**
 * Predicates that bind a required two-factor enrollment mutation to the exact state its
 * caller observed. Every supplied field is ANDed into the compare-and-swap filter, so a
 * concurrent regeneration, acknowledgement, or finalization loses the race and fails closed.
 */
export interface TwoFactorEnrollmentGuard {
  pendingTotpSecret?: string;
  pendingBackupCodes?: NonNullable<IUser['pendingBackupCodes']>;
  twoFactorAcknowledgementNonceHash?: string;
  twoFactorFinalizationNonceHash?: string;
}

/** Fields a required two-factor enrollment step may write; `null` clears the stored value. */
export interface TwoFactorEnrollmentUpdate {
  totpSecret?: string | null;
  backupCodes?: NonNullable<IUser['backupCodes']>;
  twoFactorEnabled?: boolean;
  twoFactorEnrolledAt?: Date;
  pendingTotpSecret?: string | null;
  pendingBackupCodes?: NonNullable<IUser['pendingBackupCodes']>;
  twoFactorAcknowledgementNonceHash?: string | null;
  twoFactorFinalizationNonceHash?: string | null;
}

export interface OIDCTokens {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export interface BalanceConfig {
  enabled?: boolean;
  startBalance?: number;
  autoRefillEnabled?: boolean;
  refillIntervalValue?: number;
  refillIntervalUnit?: RefillIntervalUnit;
  refillAmount?: number;
  refillMode?: BalanceRefillMode;
  reservationTtlMs?: number;
}

export interface CreateUserRequest extends Partial<IUser> {
  email: string;
}

/** A user's own fields, without Mongoose document members. */
type UserFields = Omit<IUser, keyof Document>;

/**
 * A stored user as plain data with a storage-neutral id: what `.lean()` queries and `.toObject()`
 * return. New contracts take and return this rather than the `IUser` document type.
 */
export type UserRecord = UserFields & { _id: { toString(): string } };

/** The fields a new user is created with, as plain data. */
export type NewUserData = Partial<UserFields> & { email: string };

/** The created user, or `user_exists` when an account already holds its email or provider identity. */
export type CreateUserIfAbsentResult =
  | { ok: true; value: UserRecord }
  | { ok: false; error: { code: 'user_exists' } };

export interface UpdateUserRequest {
  name?: string;
  username?: string;
  email?: string;
  role?: string;
  emailVerified?: boolean;
  avatar?: string;
  plugins?: string[];
  twoFactorEnabled?: boolean;
  termsAccepted?: boolean;
  termsAcceptedAt?: Date | null;
  personalization?: {
    memories?: boolean;
    statefulCodeEnvironment?: StatefulCodeEnvironment;
  };
  skillStates?: Record<string, boolean>;
}

export interface UserDeleteResult {
  deletedCount: number;
  message: string;
}

export interface UserFilterOptions extends CursorPaginationParams {
  _id?: Types.ObjectId | string;
  // Includes email, username and name
  search?: string;
  role?: string;
  emailVerified?: boolean;
  provider?: string;
  twoFactorEnabled?: boolean;
  // External IDs
  googleId?: string;
  facebookId?: string;
  openidId?: string;
  samlId?: string;
  ldapId?: string;
  githubId?: string;
  discordId?: string;
  appleId?: string;
  // Date filters
  createdAfter?: string;
  createdBefore?: string;
}

export interface UserQueryOptions {
  fieldsToSelect?: string | string[] | null;
  lean?: boolean;
}
