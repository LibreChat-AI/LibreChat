import type { AppConfig } from '@librechat/data-schemas';
import type {
  EmailChangeDeps,
  EmailChangeSettings,
  EmailChangeToken,
  EmailChangeTokenData,
  EmailChangeTokenMetadata,
  EmailChangeTokenQuery,
  EmailChangeUser,
} from './email';
import type { GetAppConfigOptions } from '~/app/service';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { resolveEmailChangeSettings } from './email';

/** A stored id is an ObjectId in production and a string in tests; both stringify. */
type Identifier = string | { toString(): string };

/** What the database hands back, before it is narrowed to the service's plain records. */
interface StoredUser {
  _id?: Identifier;
  id?: Identifier;
  email?: string;
  name?: string;
  username?: string;
  password?: string;
  provider?: string;
  role?: string;
  tenantId?: Identifier;
  idOnTheSource?: string | null;
}

interface StoredToken {
  userId?: Identifier;
  token?: string;
  email?: string;
  scope?: string;
  identifier?: string;
  expiresAt?: Date | string;
  metadata?: EmailChangeTokenMetadata;
  tenantId?: Identifier;
}

interface StoredUserQuery {
  email: string;
  $or?: Array<{ tenantId: { $exists: boolean } | null }>;
}

interface UserCommit {
  email: string;
  emailVerified: boolean;
  emailChangedAt: Date;
}

interface UserExpectation {
  email?: string;
  password?: string;
  provider?: string;
}

/** The database surface the change needs, as the application's models already expose it. */
export interface EmailChangeStore {
  findUser: (query: StoredUserQuery, select: string) => Promise<StoredUser | null>;
  getUserById: (userId: string, select: string) => Promise<StoredUser | null>;
  updateUser: (
    userId: string,
    update: UserCommit,
    expectedState: UserExpectation,
  ) => Promise<StoredUser | null>;
  findToken: (
    query: EmailChangeTokenQuery,
    options: { sort: { createdAt: -1 } },
  ) => Promise<StoredToken | null>;
  replaceTokenIfCurrent: (
    scope: string,
    expectedToken: string | null,
    data: EmailChangeTokenData,
  ) => Promise<boolean>;
  deleteTokens: (query: EmailChangeTokenQuery) => Promise<{ deletedCount?: number }>;
}

/** Everything else the adapter needs from the host application. */
export interface EmailChangeRuntime {
  store: EmailChangeStore;
  /** Runs an operation inside a tenant's context, or in the system one when there is none. */
  withTenant: <T>(tenantId: string | undefined, operation: () => Promise<T>) => Promise<T>;
  comparePassword: (user: EmailChangeUser, password: string) => Promise<boolean>;
  sendEmail: (data: {
    email: string;
    subject: string;
    payload: Record<string, string>;
    template: string;
  }) => Promise<void>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  clientDomain: string;
  appName: string;
}

const USER_FIELDS = 'email _id name username provider role tenantId idOnTheSource +password';
const IDENTITY_FIELDS = 'email _id tenantId';

function identifier(value?: Identifier): string | undefined {
  return value?.toString();
}

function toUser(stored: StoredUser | null): EmailChangeUser | null {
  if (!stored?.email) {
    return null;
  }
  return {
    _id: identifier(stored._id),
    id: identifier(stored.id),
    email: stored.email,
    name: stored.name,
    username: stored.username,
    password: stored.password,
    provider: stored.provider,
    role: stored.role,
    tenantId: identifier(stored.tenantId),
    /** Carried through so principal resolution does not re-read the user we just loaded;
     *  an explicit `null` is a resolved answer and must survive, unlike an absent field. */
    ...(Object.prototype.hasOwnProperty.call(stored, 'idOnTheSource')
      ? { idOnTheSource: stored.idOnTheSource ?? null }
      : {}),
  };
}

function toToken(stored: StoredToken | null): EmailChangeToken | null {
  const userId = identifier(stored?.userId);
  if (!stored || !userId || !stored.token) {
    return null;
  }
  return {
    userId,
    token: stored.token,
    email: stored.email,
    scope: stored.scope,
    identifier: stored.identifier,
    expiresAt: stored.expiresAt,
    metadata: stored.metadata,
    tenantId: identifier(stored.tenantId),
  };
}

/**
 * A tenant-less lookup must not match another tenant's account, which a bare `email` query
 * would: the system context suppresses tenant filtering, so the scope has to be stated.
 */
function identityQuery(email: string, tenantId?: string): StoredUserQuery {
  if (tenantId) {
    return { email };
  }
  return { email, $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
}

/**
 * Builds the service's dependencies from the application's database and mail surfaces. The
 * tenant scoping, the identity query and the policy resolution below are authorization
 * behavior, so they live here rather than in the route that calls the service.
 */
export function createEmailChangeDeps(runtime: EmailChangeRuntime): EmailChangeDeps {
  const { store, withTenant } = runtime;

  /**
   * Confirmation is unauthenticated and so has no request config. Resolving the same full
   * principal scope issuance used keeps a role, group, or user override of
   * `registration.allowedDomains` enforced here too. Deliberately not `withTenant`: a
   * tenant-less user would fall back to the system context, which suppresses tenant
   * filtering, so another tenant's override of a shared principal such as the `USER` role
   * would decide this policy.
   */
  const resolveAppConfig = (user: EmailChangeUser): Promise<AppConfig | undefined> => {
    const options = getAppConfigOptionsFromUser(
      {
        id: user._id ?? user.id,
        role: user.role,
        tenantId: user.tenantId,
        idOnTheSource: user.idOnTheSource,
      },
      undefined,
    );
    /** A transient principal or override failure must not fall back to a base allowlist
     *  that is broader than the scoped one, which would commit an address policy forbids. */
    const read = () => runtime.getAppConfig({ ...options, failClosed: true });
    return user.tenantId ? withTenant(user.tenantId, read) : read();
  };

  return {
    findUserByEmail: (email, tenantId) =>
      withTenant(tenantId, async () =>
        toUser(await store.findUser(identityQuery(email, tenantId), IDENTITY_FIELDS)),
      ),
    getUserById: (userId, tenantId) =>
      withTenant(tenantId, async () => toUser(await store.getUserById(userId, USER_FIELDS))),
    updateUser: (userId, update, expectedState, tenantId) =>
      withTenant(tenantId, async () =>
        toUser(await store.updateUser(userId, update, expectedState)),
      ),
    findToken: (query, tenantId) =>
      withTenant(tenantId, async () =>
        toToken(await store.findToken(query, { sort: { createdAt: -1 } })),
      ),
    replaceTokenIfCurrent: (scope, expectedToken, data, tenantId) =>
      withTenant(tenantId, () => store.replaceTokenIfCurrent(scope, expectedToken, data)),
    deleteTokens: (query, tenantId) => withTenant(tenantId, () => store.deleteTokens(query)),
    verifyPassword: runtime.comparePassword,
    resolvePolicy: async (user) => {
      const appConfig = await resolveAppConfig(user);
      return {
        settings: resolveEmailChangeSettings(appConfig?.emailChange),
        allowedDomains: appConfig?.registration?.allowedDomains,
      };
    },
    sendEmail: runtime.sendEmail,
    resolveSettings: async (): Promise<EmailChangeSettings> => {
      const appConfig = await runtime.getAppConfig({ failClosed: true });
      return resolveEmailChangeSettings(appConfig?.emailChange);
    },
    clientDomain: runtime.clientDomain,
    appName: runtime.appName,
  };
}
