import jwt from 'jsonwebtoken';
import { decryptV2, encryptV2, logger } from '@librechat/data-schemas';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PullRequestProvider } from 'librechat-data-provider';
import type { PullRequestOAuthConfig } from './settings';
import type { PullRequestFetch } from './shared';
import { getOAuthCallbackUrl } from '~/oauth/url';
import { getSafeErrorMetadata } from '~/utils';
import { isRecord } from './shared';

export const PULL_REQUEST_OAUTH_TYPE = 'pr_oauth';
/** One row per user: the connection generation a disconnect replaces, which every flow binds to. */
export const PULL_REQUEST_OAUTH_GENERATION_TYPE = 'pr_oauth_generation';
/** The generation of a user with no generation row: never connected, or deleted. No grant is ever
 *  stored under it, so reverting to it leaves every stored grant unusable. */
const FIRST_GENERATION = 'initial';
export const PULL_REQUEST_OAUTH_CALLBACK_PATH = '/api/pull-requests/oauth/callback';
const STATE_AUDIENCE = 'librechat:pull-request-oauth';
/** Defaults for `pullRequests.oauth.flowTimeoutMinutes`, `requestTimeoutSeconds` and
 *  `retentionDays`. */
export const DEFAULT_PULL_REQUEST_OAUTH_FLOW_MINUTES = 10;
export const DEFAULT_PULL_REQUEST_OAUTH_REQUEST_SECONDS = 10;
export const DEFAULT_PULL_REQUEST_OAUTH_RETENTION_DAYS = 180;
/** An access token this close to expiring is refreshed first, so a lookup never starts with it. */
const REFRESH_SKEW_MS = 60_000;
const DAY_SECONDS = 24 * 60 * 60;
/** A generation row outlives every grant made under it: the longest `retentionDays` allowed, and
 *  renewed whenever a grant under it is (see `renewGeneration`), so a grant in use for longer than
 *  that never outlives it. If it expired first, the user would be silently disconnected. */
const GENERATION_LIFETIME_SECONDS = 3650 * DAY_SECONDS;
const MAX_TOKEN_LENGTH = 8_192;
/**
 * The token endpoint errors that mean the grant itself is dead: RFC 6749 `invalid_grant`, and the
 * codes GitHub answers with for a refresh token or a code it no longer accepts. Any other error,
 * such as `invalid_client` after a wrong client secret is deployed, is about the server, and
 * deleting every user's grant for it would leave them nothing to recover once it is fixed.
 */
const GRANT_REFUSALS: ReadonlySet<string> = new Set([
  'invalid_grant',
  'bad_refresh_token',
  'bad_verification_code',
]);

/** Where users authorize and where the code is exchanged, on the configured host. */
export function oauthEndpoints(
  provider: PullRequestProvider,
  host: string,
): { authorize: string; token: string; defaultScope?: string; basicAuth: boolean } {
  if (provider === 'gitlab') {
    return {
      authorize: `https://${host}/oauth/authorize`,
      token: `https://${host}/oauth/token`,
      defaultScope: 'read_api',
      basicAuth: false,
    };
  }
  if (provider === 'bitbucket') {
    return {
      authorize: 'https://bitbucket.org/site/oauth2/authorize',
      token: 'https://bitbucket.org/site/oauth2/access_token',
      basicAuth: true,
    };
  }
  return {
    authorize: `https://${host}/login/oauth/authorize`,
    token: `https://${host}/login/oauth/access_token`,
    basicAuth: false,
  };
}

/** The fields of a stored token row this module reads and writes; plain values, no documents. */
export type PullRequestOAuthRow = { token: string; expiresAt?: Date | string | null };

export type PullRequestOAuthRowInput = {
  userId: string;
  type: string;
  identifier: string;
  token: string;
  /** Seconds until the row may be deleted. */
  expiresIn: number;
};

/** The token persistence this module needs, supplied by the caller (the app's token methods). */
export type PullRequestOAuthStore = {
  findToken(query: { scope: string }): Promise<PullRequestOAuthRow | null>;
  /** Writes `data` only while the row still holds `expected` (or is absent, for `null`). */
  replaceTokenIfCurrent(
    scope: string,
    expected: string | null,
    data: PullRequestOAuthRowInput,
  ): Promise<boolean>;
  deleteTokens(
    query: { scope: string; token?: string } | { userId: string; type: string },
  ): Promise<unknown>;
  /** Whether the user exists and no account deletion has started for it (its deletion fence). */
  isAgentTriggerPrincipalActive(userId: string): Promise<boolean>;
  /** Every row of one type the user holds, whatever app or host made it. */
  findTokensOfUser(query: { userId: string; type: string }): Promise<PullRequestOAuthRow[]>;
};

export type PullRequestOAuthStatus = { connected: boolean; flowId?: string };

/** What a verified `state` carries back to the callback. */
export type PullRequestOAuthState = {
  userId: string;
  provider: PullRequestProvider;
  host: string;
  tenantId?: string;
  /** Binds the CSRF cookie to this one flow. */
  flowId: string;
  nonce: string;
  /** The user's connection generation when the flow started; a disconnect since voids it. */
  generation: string;
};

/** What the provider issued. */
type Issued = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; absent for a token that does not expire. */
  accessExpiresAt?: number;
  /** The app that issued it; a grant of a replaced app is treated as no connection. */
  clientId: string;
};

/**
 * Every stored record carries `lineage`, fixed when the user connects and kept by every refresh,
 * so a write can tell a later state of the same connection from a new one. Each write also
 * stores a fresh `v`, which makes the ciphertext a version: every write and delete compares and
 * swaps on the exact row it read, never on equal content.
 */
type Versioned = {
  lineage: string;
  v: string;
  /** The user's connection generation the record was made under. Only a record of the current
   *  generation is a connection, so a sign-in, a disconnect or an account deletion, each of
   *  which replaces or removes the generation, leaves every older record unusable even where
   *  removing it failed. Absent from a record that predates it, which is therefore never one. */
  generation?: string;
};

/** A grant as stored, encrypted, in one row per user and provider host. `leaseUntil` marks the
 *  one replica allowed to refresh it, so no two spend the same refresh token. */
type Grant = Issued &
  Versioned & {
    leaseUntil?: number;
    /** Epoch milliseconds of the last write, which every use makes; the retention counts from it
     *  under the current `retentionDays`, so a shortened retention applies to existing grants. */
    usedAt?: number;
    /** The sign-in that made the connection, kept through refreshes, so a client can tell its
     *  own sign-in landed from an older connection still being there. */
    flowId?: string;
  };

/** What a definite refusal leaves behind: no connection, but the lineage, so a slower replica
 *  whose refresh of the same grant succeeded can still store its result over it. */
type Refused = Versioned & { refused: true; clientId: string };

type Stored = Grant | Refused;

const isRefused = (record: Stored): record is Refused => 'refused' in record;

/** A stored grant that decrypts but is not one this service wrote: corruption, not absence. */
class MalformedGrantError extends Error {
  constructor() {
    super('The stored pull request grant is malformed');
    this.name = 'MalformedGrantError';
  }
}

/** Thrown for a grant the provider refused, as opposed to one it could not be asked about. A
 *  refusal disconnects the user, so only a definite one is: a server error, or an error about the
 *  client rather than the grant, is an outage, whatever its status. */
class GrantRejectedError extends Error {
  constructor() {
    super('The provider rejected the grant');
    this.name = 'GrantRejectedError';
  }
}

/** Another replica holds the refresh of this grant, so its token is not known yet. */
class GrantRefreshPendingError extends Error {
  constructor() {
    super('Another refresh of the grant is in progress');
    this.name = 'GrantRefreshPendingError';
  }
}

/** The user disconnected after this flow started, so it may not connect them again. */
class StaleFlowError extends Error {
  constructor() {
    super('The flow started before a disconnect, or for another provider');
    this.name = 'StaleFlowError';
  }
}

/** The user was deleted, or its deletion started, while the connection was being made. */
class InactivePrincipalError extends Error {
  constructor() {
    super('The user is not active');
    this.name = 'InactivePrincipalError';
  }
}

const base64url = (value: Buffer): string => value.toString('base64url');

const isToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;

/**
 * A stored record, from its decrypted text. Only this service writes the row, so text that is
 * not one of its records is a failure (corruption), never an absent connection.
 */
function parseStored(plaintext: string): Stored {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new MalformedGrantError();
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.clientId !== 'string' ||
    typeof parsed.lineage !== 'string' ||
    typeof parsed.v !== 'string' ||
    (parsed.generation !== undefined && typeof parsed.generation !== 'string')
  ) {
    throw new MalformedGrantError();
  }
  if (parsed.refused === true) return parsed as Refused;
  if (
    !isToken(parsed.accessToken) ||
    (parsed.refreshToken !== undefined && !isToken(parsed.refreshToken)) ||
    (parsed.accessExpiresAt !== undefined && typeof parsed.accessExpiresAt !== 'number') ||
    (parsed.leaseUntil !== undefined && typeof parsed.leaseUntil !== 'number') ||
    (parsed.usedAt !== undefined && typeof parsed.usedAt !== 'number') ||
    (parsed.flowId !== undefined && typeof parsed.flowId !== 'string')
  ) {
    throw new MalformedGrantError();
  }
  return parsed as Grant;
}

const isSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export type PullRequestOAuth = {
  /** Where to send the user, and the flow id its CSRF cookie must be bound to. */
  authorizationUrl(
    user: { id: string; tenantId?: string },
    config: PullRequestOAuthConfig,
  ): Promise<{ url: string; flowId: string }>;
  /** The claims of a `state` this server issued and that has not expired; null otherwise. */
  verifyState(state: string): PullRequestOAuthState | null;
  /** Exchanges the code and stores the grant for the user the state names. */
  complete(
    state: PullRequestOAuthState,
    code: string,
    config: PullRequestOAuthConfig,
  ): Promise<void>;
  /** The user's access token, refreshed when it is about to expire; null when not connected.
   *  Rejects when it cannot be known: an outage, a grant that cannot be read, or a refusal that
   *  another replica's refresh may still overtake. */
  token(userId: string, config: PullRequestOAuthConfig): Promise<string | null>;
  connected(userId: string, config: PullRequestOAuthConfig): Promise<boolean>;
  /** `connected`, with the sign-in that made the connection. */
  status(userId: string, config: PullRequestOAuthConfig): Promise<PullRequestOAuthStatus>;
  /** Whether the user holds a grant under any app or host, read without a configuration, so a
   *  grant made before the app was turned off still shows, and can still be disconnected. */
  storedStatus(userId: string): Promise<PullRequestOAuthStatus>;
  /** Marks the grant refused when the provider rejected `accessToken` on a lookup, only while it
   *  is still the stored one: a grant refreshed or reconnected since stands. */
  reject(userId: string, config: PullRequestOAuthConfig, accessToken: string): Promise<void>;
  /** Removes every connection the user has, whatever app or host it was made with, so a later
   *  configuration can never bring back one the user removed. */
  disconnect(userId: string): Promise<void>;
};

/**
 * Per-user connections to the configured provider, so pull request lookups run on each user's own
 * token, rate limit and repository access. The `state` is a short-lived signed token, so the
 * callback needs no server-side flow record, and the PKCE verifier is derived from it with the
 * server secret, so it never travels through the browser. Grants are stored encrypted, one row per
 * user and provider host, and replaced only when unchanged since read, so two replicas refreshing
 * at once cannot overwrite each other's newer grant.
 */
export function createPullRequestOAuth({
  store,
  fetchFn,
  secret,
  redirectUri,
  encrypt = encryptV2,
  decrypt = decryptV2,
  now = Date.now,
}: {
  store: PullRequestOAuthStore;
  fetchFn: PullRequestFetch;
  /** Signs the state and derives the PKCE verifier. */
  secret: string;
  redirectUri: string;
  encrypt?: (value: string) => Promise<string>;
  decrypt?: (value: string) => Promise<string>;
  now?: () => number;
}): PullRequestOAuth {
  const scopeOf = (userId: string, config: PullRequestOAuthConfig) =>
    `${PULL_REQUEST_OAUTH_TYPE}:${userId}:${config.provider}:${config.host}`;
  const verifierOf = (nonce: string) =>
    base64url(createHmac('sha256', secret).update(`pull-request-oauth:${nonce}`).digest());

  /** Token reads in flight in this process, so concurrent lookups share one read and at most one
   *  refresh. Keyed by the user and every setting of the app config, since any of them (the app,
   *  the retention, the timeouts) can change the answer. */
  const reading = new Map<string, Promise<string | null>>();
  const configKeyOf = (config: PullRequestOAuthConfig): string =>
    createHash('sha256')
      .update(JSON.stringify(config, Object.keys(config).sort()))
      .digest('hex');

  const generationScopeOf = (userId: string) => `${PULL_REQUEST_OAUTH_GENERATION_TYPE}:${userId}`;
  async function generationOf(userId: string): Promise<string> {
    const row = await store.findToken({ scope: generationScopeOf(userId) });
    return row?.token ?? FIRST_GENERATION;
  }

  async function replaceGeneration(userId: string): Promise<void> {
    const scope = generationScopeOf(userId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await store.findToken({ scope });
      const replaced = await store.replaceTokenIfCurrent(scope, current?.token ?? null, {
        userId,
        type: PULL_REQUEST_OAUTH_GENERATION_TYPE,
        identifier: 'generation',
        token: randomUUID(),
        expiresIn: GENERATION_LIFETIME_SECONDS,
      });
      if (replaced) return;
    }
    throw new Error('The connection generation could not be replaced');
  }

  /**
   * After a sign-in's writes failed without a known outcome: returns the stored grant's row token
   * when both the generation and the grant landed, and otherwise puts the previous generation back
   * if this sign-in's generation is the current one.
   */
  async function reconcileSignIn(
    state: PullRequestOAuthState,
    config: PullRequestOAuthConfig,
    generation: string,
    lineage: string,
  ): Promise<string | null> {
    if ((await generationOf(state.userId)) !== generation) return null;
    const row = await store.findToken({ scope: scopeOf(state.userId, config) });
    if (row != null) {
      const record = parseStored(await decrypt(row.token));
      if (!isRefused(record) && record.lineage === lineage) return row.token;
    }
    await restoreGeneration(state.userId, generation, state.generation);
    return null;
  }

  /** Moves the user back from `from` to `to`, only while `from` is still current. */
  async function restoreGeneration(userId: string, from: string, to: string): Promise<void> {
    const scope = generationScopeOf(userId);
    if (to === FIRST_GENERATION) {
      await store.deleteTokens({ scope, token: from });
      return;
    }
    await store.replaceTokenIfCurrent(scope, from, {
      userId,
      type: PULL_REQUEST_OAUTH_GENERATION_TYPE,
      identifier: 'generation',
      token: to,
      expiresIn: GENERATION_LIFETIME_SECONDS,
    });
  }

  /**
   * Starts the generation's lifetime again, at most once a day, whenever a grant under it is
   * extended or refreshed. The same value is written back only while it is current, so a
   * generation replaced meanwhile (a disconnect, a new sign-in) is never restored.
   */
  async function renewGeneration(userId: string, generation: string | undefined): Promise<void> {
    if (generation == null || generation === FIRST_GENERATION) return;
    const scope = generationScopeOf(userId);
    const row = await store.findToken({ scope });
    if (row?.token !== generation || row.expiresAt == null) return;
    const remaining = new Date(row.expiresAt).getTime() - now();
    if (remaining > (GENERATION_LIFETIME_SECONDS - DAY_SECONDS) * 1000) return;
    await store.replaceTokenIfCurrent(scope, generation, {
      userId,
      type: PULL_REQUEST_OAUTH_GENERATION_TYPE,
      identifier: 'generation',
      token: generation,
      expiresIn: GENERATION_LIFETIME_SECONDS,
    });
  }

  /**
   * Moves the user from the generation a flow started in to a new one, or fails as stale: one
   * sign-in at a time, and none across a disconnect. Returns the new generation.
   */
  async function advanceGeneration(userId: string, from: string, next: string): Promise<string> {
    const advanced = await store.replaceTokenIfCurrent(
      generationScopeOf(userId),
      from === FIRST_GENERATION ? null : from,
      {
        userId,
        type: PULL_REQUEST_OAUTH_GENERATION_TYPE,
        identifier: 'generation',
        token: next,
        expiresIn: GENERATION_LIFETIME_SECONDS,
      },
    );
    if (!advanced) throw new StaleFlowError();
    return next;
  }

  const dropPendingReads = (userId: string): void => {
    for (const key of reading.keys()) {
      if (key.startsWith(`${userId}\0`)) reading.delete(key);
    }
  };

  /**
   * A token, or null when the user disconnected while it was being read. The generation is read
   * before the grant and again after: a grant found before a disconnect removed it is answered
   * only if that disconnect had not finished, since its last step replaces the generation.
   */
  async function fencedToken(
    userId: string,
    config: PullRequestOAuthConfig,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await generationOf(userId);
      const token = await currentToken(userId, config, before);
      /**
       * The connection changed under this read: a sign-in or a disconnect, on any replica or any
       * instance, including one whose pending reads this instance cannot drop. It is read again
       * under the new one, so neither this caller nor any that joined it answers for the old.
       */
      if ((await generationOf(userId)) === before) return token;
    }
    return null;
  }

  /** A flow may store a grant only for an active user still in the generation it started in. */
  async function assertCurrent(state: PullRequestOAuthState): Promise<void> {
    const [active, generation] = await Promise.all([
      store.isAgentTriggerPrincipalActive(state.userId),
      generationOf(state.userId),
    ]);
    if (!active) throw new InactivePrincipalError();
    if (generation !== state.generation) throw new StaleFlowError();
  }

  async function requestGrant(
    config: PullRequestOAuthConfig,
    form: Record<string, string>,
    clientId: string,
  ): Promise<Issued> {
    const endpoints = oauthEndpoints(config.provider, config.host);
    const body = new URLSearchParams(form);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'LibreChat-Pull-Requests',
    };
    if (endpoints.basicAuth) {
      const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`);
      headers.Authorization = `Basic ${credentials.toString('base64')}`;
    } else {
      body.set('client_id', config.clientId);
      body.set('client_secret', config.clientSecret);
    }
    const response = await fetchFn(endpoints.token, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(
        (config.requestTimeoutSeconds ?? DEFAULT_PULL_REQUEST_OAUTH_REQUEST_SECONDS) * 1000,
      ),
    });
    const parsed: unknown = await response.json().catch(() => null);
    const error = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : undefined;
    /** GitHub answers a refused grant with 200 and an `error` field; others use 400 or 401. A
     *  server error is an outage whatever its body says. */
    const refused =
      (response.ok || response.status === 400 || response.status === 401) &&
      error != null &&
      GRANT_REFUSALS.has(error);
    if (refused) throw new GrantRejectedError();
    if (!response.ok || error != null || !isRecord(parsed) || !isToken(parsed.access_token)) {
      throw new Error(`Token endpoint answered ${response.status}`);
    }
    return {
      accessToken: parsed.access_token,
      ...(isToken(parsed.refresh_token) ? { refreshToken: parsed.refresh_token } : {}),
      ...(isSeconds(parsed.expires_in)
        ? { accessExpiresAt: now() + parsed.expires_in * 1000 }
        : {}),
      clientId,
    };
  }

  const retentionOf = (config: PullRequestOAuthConfig): number =>
    (config.retentionDays ?? DEFAULT_PULL_REQUEST_OAUTH_RETENTION_DAYS) * DAY_SECONDS;

  /** One replica's claim on a refresh: its provider request, with room to store the answer. A
   *  claim that outlives it (a stalled replica) lets another replica claim the grant; the stalled
   *  one's answer is then still stored, as it carries the same lineage. */
  const leaseOf = (config: PullRequestOAuthConfig): number =>
    2 * (config.requestTimeoutSeconds ?? DEFAULT_PULL_REQUEST_OAUTH_REQUEST_SECONDS) * 1000;

  /** How long the row may live: an access token that expires without a refresh token lives that
   *  long; a refusal lives a day, long enough for a slower refresh of the same grant to land; any
   *  other grant lives the retention, which every use extends (see `token`). */
  const lifetimeOf = (record: Stored, config: PullRequestOAuthConfig): number => {
    if (isRefused(record)) return DAY_SECONDS;
    if (record.refreshToken == null && record.accessExpiresAt != null) {
      const remaining = Math.max(1, Math.ceil((record.accessExpiresAt - now()) / 1000));
      return Math.min(remaining, retentionOf(config));
    }
    return retentionOf(config);
  };

  /** Whether using a grant should rewrite its row: once a write would extend its deadline by more
   *  than a day (half the retention, if that is shorter), so the retention runs from the last use
   *  within a day without a write per use, or when it is set to outlive what the current retention
   *  allows (past the second `lifetimeOf` rounds up to), so a shortened retention takes hold. A
   *  grant whose access token expires without a refresh token already lives until that expiry, so
   *  using it never needs a write. */
  const needsRewrite = (
    row: PullRequestOAuthRow,
    grant: Grant,
    config: PullRequestOAuthConfig,
  ): boolean => {
    if (row.expiresAt == null) return false;
    const remaining = new Date(row.expiresAt).getTime() - now();
    const lifetime = lifetimeOf(grant, config) * 1000;
    const interval = Math.min(DAY_SECONDS * 1000, (retentionOf(config) * 1000) / 2);
    return (
      Number.isFinite(remaining) && (remaining < lifetime - interval || remaining > lifetime + 1000)
    );
  };

  /** Whether a grant can answer now, or never will without a refresh. */
  const isLive = (grant: Grant, skewMs: number): boolean =>
    grant.accessExpiresAt == null || grant.accessExpiresAt - skewMs > now();

  /** The stored record for this app, or null when there is none: no row, a row past its
   *  retention (the TTL reaper removes it late, never on time), or a record of a replaced app. */
  async function read(
    userId: string,
    config: PullRequestOAuthConfig,
    generation: string,
  ): Promise<{ row: PullRequestOAuthRow; record: Stored } | null> {
    const row = await store.findToken({ scope: scopeOf(userId, config) });
    if (row == null) return null;
    if (row.expiresAt != null) {
      const expiresAt = new Date(row.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && expiresAt <= now()) return null;
    }
    /** Only this service writes the row, so a value that does not decrypt (a missing or rotated
     *  key) or is not one of its records is a failure, not an absent connection, and it
     *  propagates. A record of another OAuth app, from before the app was replaced, is no
     *  connection to this one. */
    const parsed = parseStored(await decrypt(row.token));
    /** A record of another app is no connection to this one, and is left alone: during a rollout
     *  this replica's config may be the stale one, and deleting would destroy the user's new
     *  connection. It expires with the retention, and disconnecting removes it. */
    if (parsed.clientId !== config.clientId) return null;
    /** A record of an earlier generation is no connection, and is left alone like one of
     *  another app: the disconnect or sign-in that replaced its generation owns its removal. */
    if (parsed.generation !== generation) return null;
    if (isRefused(parsed)) return { row, record: parsed };
    /** Unused for longer than the retention now allows: gone, and removed if still this row.
     *  Awaited, and a failure propagates: the caller hears there is no connection only once the
     *  credential is actually gone. */
    if (typeof parsed.usedAt === 'number' && parsed.usedAt + retentionOf(config) * 1000 <= now()) {
      await store.deleteTokens({ scope: scopeOf(userId, config), token: row.token });
      return null;
    }
    return { row, record: parsed };
  }

  async function statusOf(
    userId: string,
    config: PullRequestOAuthConfig,
    attempt = 0,
  ): Promise<PullRequestOAuthStatus> {
    /** Fenced like a token read, so it never reports a connection a finished disconnect removed. */
    const before = await generationOf(userId);
    const current = await read(userId, config, before);
    /** The generation moved during the read (a disconnect or a sign-in finished): the answer is
     *  read again under the new one, as `fencedToken` does, so a reconnect is not reported as
     *  disconnected. */
    if ((await generationOf(userId)) !== before) {
      return attempt < 2 ? statusOf(userId, config, attempt + 1) : { connected: false };
    }
    if (current == null || isRefused(current.record)) return { connected: false };
    const grant = current.record;
    /** The row of a grant that cannot be refreshed outlives it until the TTL reaper runs. */
    if (grant.refreshToken == null && !isLive(grant, 0)) return { connected: false };
    return grant.flowId != null ? { connected: true, flowId: grant.flowId } : { connected: true };
  }

  /**
   * Stores `record` as a new version, only while the row is still `expected` (absent, for null).
   * Returns the new version, or null when the row had moved on.
   */
  async function write(
    userId: string,
    config: PullRequestOAuthConfig,
    expected: string | null,
    record: Omit<Grant, 'v'> | Omit<Refused, 'v'>,
  ): Promise<string | null> {
    const versioned = (
      'refused' in record
        ? { ...record, v: randomUUID() }
        : { ...record, usedAt: now(), v: randomUUID() }
    ) as Stored;
    const token = await encrypt(JSON.stringify(versioned));
    const stored = await store.replaceTokenIfCurrent(scopeOf(userId, config), expected, {
      userId,
      type: PULL_REQUEST_OAUTH_TYPE,
      identifier: `${config.provider}:${config.host}`,
      token,
      expiresIn: lifetimeOf(versioned, config),
    });
    return stored ? token : null;
  }

  /**
   * Stores a refreshed grant over the version this replica claimed. When that version is gone,
   * the row's state decides: removed (a disconnect or an account deletion) stays removed; a newer
   * connection wins; a later state of this same connection (another replica's claim after this
   * one's lease ran out, or its refusal of the refresh token this one already used) is replaced,
   * since only this answer holds the refresh token the provider now accepts.
   */
  async function settle(
    userId: string,
    config: PullRequestOAuthConfig,
    expected: string,
    next: Omit<Grant, 'v'>,
  ): Promise<string | null> {
    let version = expected;
    for (let attempt = 0; attempt < 3; attempt++) {
      if ((await write(userId, config, version, next)) != null) {
        await renewGeneration(userId, next.generation);
        return next.accessToken;
      }
      const current = await read(userId, config, next.generation ?? FIRST_GENERATION);
      if (current == null) return null;
      if (current.record.lineage !== next.lineage) {
        return isRefused(current.record) || !isLive(current.record, 0)
          ? null
          : current.record.accessToken;
      }
      version = current.row.token;
    }
    throw new Error('The refreshed grant could not be stored');
  }

  async function refresh(
    userId: string,
    config: PullRequestOAuthConfig,
    row: PullRequestOAuthRow,
    grant: Grant,
  ): Promise<string | null> {
    if (grant.refreshToken == null) return null;
    if (grant.leaseUntil != null && grant.leaseUntil > now()) throw new GrantRefreshPendingError();
    const { v: _v, leaseUntil: _lease, ...unleased } = grant;
    /** Claim the refresh: only the replica whose claim lands spends the refresh token. */
    const claimed = await write(userId, config, row.token, {
      ...unleased,
      leaseUntil: now() + leaseOf(config),
    });
    if (claimed == null) {
      const current = await read(userId, config, grant.generation ?? FIRST_GENERATION);
      if (current == null || isRefused(current.record)) return null;
      if (current.record.leaseUntil == null && isLive(current.record, REFRESH_SKEW_MS)) {
        return current.record.accessToken;
      }
      throw new GrantRefreshPendingError();
    }
    let issued: Issued;
    try {
      issued = await requestGrant(
        config,
        { grant_type: 'refresh_token', refresh_token: grant.refreshToken },
        config.clientId,
      );
    } catch (error) {
      if (error instanceof GrantRejectedError) {
        /** Refuses only the version this replica claimed; anything newer stands. */
        const refused = await write(userId, config, claimed, {
          refused: true,
          clientId: grant.clientId,
          lineage: grant.lineage,
          ...(grant.generation != null ? { generation: grant.generation } : {}),
        });
        if (refused != null) return null;
        const current = await read(userId, config, grant.generation ?? FIRST_GENERATION);
        return current == null || isRefused(current.record) || !isLive(current.record, 0)
          ? null
          : current.record.accessToken;
      }
      /** An outage: release the claim so the next attempt need not wait it out. */
      await write(userId, config, claimed, unleased).catch((cause: unknown) => {
        logger.warn('[PullRequests] OAuth refresh claim not released', getSafeErrorMetadata(cause));
      });
      throw error;
    }
    /** A provider that does not rotate refresh tokens keeps the one it was given. */
    return settle(userId, config, claimed, {
      ...issued,
      refreshToken: issued.refreshToken ?? grant.refreshToken,
      lineage: grant.lineage,
      ...(grant.flowId != null ? { flowId: grant.flowId } : {}),
      ...(grant.generation != null ? { generation: grant.generation } : {}),
    });
  }

  async function currentToken(
    userId: string,
    config: PullRequestOAuthConfig,
    generation: string,
    attempt = 0,
  ): Promise<string | null> {
    const current = await read(userId, config, generation);
    if (current == null || isRefused(current.record)) return null;
    const { row, record: grant } = current;
    /** Without a refresh token there is nothing to refresh with, so it serves until it expires. */
    if (isLive(grant, grant.refreshToken == null ? 0 : REFRESH_SKEW_MS)) {
      if (needsRewrite(row, grant, config) && grant.leaseUntil == null) {
        const { v: _v, ...same } = grant;
        /** Rare (past half the retention, or a shortened one), so the read waits for it. A failed
         *  write is an outage, not a successful read: the grant would keep its old deadline. */
        if ((await write(userId, config, row.token, same)) == null) {
          /** Another replica changed the row first (an old-config one may have extended it), so the
           *  current policy is read and applied again rather than assumed to have landed. */
          if (attempt >= 2) throw new Error('The grant retention could not be updated');
          return currentToken(userId, config, generation, attempt + 1);
        }
        await renewGeneration(userId, grant.generation);
      }
      return grant.accessToken;
    }
    return refresh(userId, config, row, grant);
  }

  return {
    async authorizationUrl(user, config) {
      const nonce = base64url(randomBytes(16));
      const generation = await generationOf(user.id);
      const state = jwt.sign(
        {
          sub: user.id,
          p: config.provider,
          h: config.host,
          n: nonce,
          g: generation,
          ...(user.tenantId ? { t: user.tenantId } : {}),
        },
        secret,
        {
          audience: STATE_AUDIENCE,
          expiresIn: (config.flowTimeoutMinutes ?? DEFAULT_PULL_REQUEST_OAUTH_FLOW_MINUTES) * 60,
        },
      );
      const endpoints = oauthEndpoints(config.provider, config.host);
      const scope = config.scope ?? endpoints.defaultScope;
      const challenge = base64url(createHash('sha256').update(verifierOf(nonce)).digest());
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(scope ? { scope } : {}),
      });
      return {
        url: `${endpoints.authorize}?${query.toString()}`,
        flowId: flowIdOf(user.id, nonce),
      };
    },

    verifyState(state) {
      let claims: unknown;
      try {
        claims = jwt.verify(state, secret, { audience: STATE_AUDIENCE });
      } catch {
        return null;
      }
      if (
        !isRecord(claims) ||
        typeof claims.sub !== 'string' ||
        typeof claims.h !== 'string' ||
        typeof claims.n !== 'string' ||
        typeof claims.g !== 'string' ||
        (claims.p !== 'github' && claims.p !== 'gitlab' && claims.p !== 'bitbucket') ||
        (claims.t !== undefined && typeof claims.t !== 'string')
      ) {
        return null;
      }
      return {
        userId: claims.sub,
        provider: claims.p,
        host: claims.h,
        nonce: claims.n,
        generation: claims.g,
        flowId: flowIdOf(claims.sub, claims.n),
        ...(typeof claims.t === 'string' ? { tenantId: claims.t } : {}),
      };
    },

    async complete(state, code, config) {
      /** The code is exchanged only with the provider the flow was started for. */
      if (state.provider !== config.provider || state.host !== config.host) {
        throw new StaleFlowError();
      }
      /** No code is spent for a user that is gone, being deleted, or disconnected since. */
      await assertCurrent(state);
      const response = await requestGrant(
        config,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifierOf(state.nonce),
        },
        config.clientId,
      );
      /**
       * The sign-in is an identity boundary: the user moves to a new generation before the grant is
       * stored under it, so every earlier grant, and every read that found one, stops answering.
       * After the exchange, so a failed sign-in leaves the existing connection alone.
       */
      const generation = randomUUID();
      const record = { ...response, lineage: randomUUID(), flowId: state.flowId, generation };
      /** Replaces whatever the user had connected before, read first so the swap is exact. */
      let stored: string | null = null;
      try {
        await advanceGeneration(state.userId, state.generation, generation);
        dropPendingReads(state.userId);
        for (let attempt = 0; attempt < 3 && stored == null; attempt++) {
          const current = await store.findToken({ scope: scopeOf(state.userId, config) });
          stored = await write(state.userId, config, current?.token ?? null, record);
        }
        if (stored == null) throw new Error('The grant could not be stored');
      } catch (error) {
        if (error instanceof StaleFlowError) throw error;
        /**
         * A write can apply and still fail to answer, so what was stored decides, not the error:
         * the new grant under the new generation is a finished sign-in; the new generation without
         * it goes back to the previous one, whose grant is untouched; anything else moved on.
         */
        stored = await reconcileSignIn(state, config, generation, record.lineage);
        if (stored == null) throw error;
      }
      /**
       * Account deletion sets its fence and then removes the user's tokens; a disconnect replaces
       * the generation and then removes the grants. A grant stored before that removal goes with
       * it; one stored after it finds the fence, no user, or a new generation here and removes
       * itself, so neither a deletion nor a disconnect is undone by a flow started before it.
       */
      try {
        await assertCurrent({ ...state, generation });
      } catch (error) {
        /** Only a confirmed fence undoes the sign-in; a failed check read is an outage, and the
         *  stored grant under the new generation stays the user's connection. */
        if (!(error instanceof InactivePrincipalError || error instanceof StaleFlowError)) {
          throw error;
        }
        /**
         * Both undone, each attempted whatever the other does: the grant, and the generation this
         * sign-in set (only while it is still current). Either alone keeps the grant unusable, so
         * a deletion that is later cancelled cannot make it a connection.
         */
        await Promise.allSettled([
          store.deleteTokens({ scope: scopeOf(state.userId, config), token: stored }),
          restoreGeneration(state.userId, generation, state.generation),
        ]);
        throw error;
      }
    },

    async token(userId, config) {
      /** Concurrent callers share one read and at most one refresh. Joining only the refresh is
       *  not enough: a caller whose read answered after another's refresh had already finished
       *  would refresh the grant that refresh replaced. */
      const key = `${userId}\0${configKeyOf(config)}`;
      const pending = reading.get(key);
      if (pending != null) return pending;
      const started = fencedToken(userId, config);
      reading.set(key, started);
      try {
        return await started;
      } finally {
        /** Only its own entry: a disconnect may have cleared it and a newer read taken the key. */
        if (reading.get(key) === started) reading.delete(key);
      }
    },

    async connected(userId, config) {
      return (await statusOf(userId, config)).connected;
    },

    status: statusOf,

    async storedStatus(userId) {
      const before = await generationOf(userId);
      const rows = await store.findTokensOfUser({ userId, type: PULL_REQUEST_OAUTH_TYPE });
      for (const row of rows) {
        if (row.expiresAt != null && new Date(row.expiresAt).getTime() <= now()) continue;
        /** A row that cannot be read is a failure, as for a configured read. */
        const parsed = parseStored(await decrypt(row.token));
        if (isRefused(parsed) || parsed.generation !== before) continue;
        if ((await generationOf(userId)) !== before) return { connected: false };
        return parsed.flowId != null
          ? { connected: true, flowId: parsed.flowId }
          : { connected: true };
      }
      return { connected: false };
    },

    async reject(userId, config, accessToken) {
      /** A write that loses to another (a retention rewrite of the same grant) is read again, so
       *  the rejection still lands while the row holds that access token; a row that moved on to
       *  another token or connection is left alone. */
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(userId, config, await generationOf(userId));
        if (current == null || isRefused(current.record)) return;
        if (current.record.accessToken !== accessToken) return;
        /** Only the access token was turned away: with a refresh token the next read refreshes it,
         *  and only a refused refresh ends the connection. */
        const { v: _v, ...grant } = current.record;
        const written =
          current.record.refreshToken != null
            ? await write(userId, config, current.row.token, { ...grant, accessExpiresAt: 0 })
            : await write(userId, config, current.row.token, {
                refused: true,
                clientId: current.record.clientId,
                lineage: current.record.lineage,
                ...(current.record.generation != null
                  ? { generation: current.record.generation }
                  : {}),
              });
        if (written != null) return;
      }
      throw new Error('The rejected grant could not be updated');
    },

    async disconnect(userId) {
      /**
       * The generation is replaced before the grants are removed, so a flow started before this
       * cannot store a grant after it (see `complete`), and again after, so a token read that
       * found the grant before its removal does not answer with it once this has returned (see
       * `fencedToken`). Reads of this process are not joined by later requests either.
       */
      await replaceGeneration(userId);
      await store.deleteTokens({ userId, type: PULL_REQUEST_OAUTH_TYPE });
      await replaceGeneration(userId);
      dropPendingReads(userId);
    },
  };
}

const flowIdOf = (userId: string, nonce: string): string => `pull-request-oauth:${userId}:${nonce}`;

/**
 * The connection service for this deployment, from its environment: the state is signed with
 * `JWT_SECRET` and the callback is on `DOMAIN_SERVER`. Without a secret no user can connect.
 */
export function createPullRequestOAuthFromEnv({
  store,
  fetchFn,
  env,
}: {
  store: PullRequestOAuthStore;
  fetchFn: PullRequestFetch;
  env: Readonly<Record<string, string | undefined>>;
}): PullRequestOAuth | undefined {
  const secret = env.JWT_SECRET;
  if (!secret) return undefined;
  return createPullRequestOAuth({
    store,
    fetchFn,
    secret,
    redirectUri: getOAuthCallbackUrl(
      env.DOMAIN_SERVER || 'http://localhost:3080',
      PULL_REQUEST_OAUTH_CALLBACK_PATH,
    ),
  });
}
