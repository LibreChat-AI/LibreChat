import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AuthIdentityContext,
  LeaseContext,
  OpenIDLogger,
  OpenIDClaims,
  OpenIDTokenSet,
  RefreshFlightAcquireResult,
  RefreshFlightRecord,
  RefreshKeyInput,
} from './types';
import {
  OPENID_REFRESH_CANCELLED_BEFORE_GRANT,
  createOpenIDRefreshOwnershipError,
  isOpenIDRefreshOwnershipError,
  toOpenIDLogArgument,
} from './errors';
import { createOpenIDRefreshIdentityTuple, serializeAuthIdentityTuple } from '~/utils/identity';
import { OPENID_EXPIRY_BUFFER_SECONDS } from '~/oauth/expiry';

const DEFAULT_FLIGHT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 30 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_FLIGHT_TTL_MS;
const DEFAULT_WAIT_INTERVAL_MS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 1000;
const DEFAULT_DELIVERY_TTL_MS = 30 * 1000;
const INTERNAL_BROWSER_REFRESH_TOKEN_FIELD = '__browserRefreshToken';
const INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD = '__predecessorRefreshToken';
const INTERNAL_PREDECESSOR_ACCESS_TOKEN_FIELD = '__predecessorAccessToken';
const INTERNAL_DEFERRED_PUBLICATION_FIELD = '__deferredPublication';
const INTERNAL_FLIGHT_OWNER_FIELD = '__flightOwnerId';
const INTERNAL_FLIGHT_CREATED_AT_FIELD = '__flightCreatedAt';

export interface TokenResult extends Omit<OpenIDTokenSet, 'claims'> {
  tokenset?: OpenIDTokenSet;
  claims?: OpenIDClaims | (() => OpenIDClaims);
  openidIssuer?: string;
  __browserRefreshToken?: string;
  __predecessorRefreshToken?: string;
  __predecessorAccessToken?: string;
  __deferredPublication?: boolean;
  __flightOwnerId?: string;
  __flightCreatedAt?: number;
  predecessorAccessToken?: string;
  acceptedIdentity?: AuthIdentityContext;
}

interface FlightAcquireData {
  key: string;
  ownerId: string;
  lockExpiresAt: Date;
  expiresAt: Date;
}

interface FlightOwnerData {
  key: string;
  ownerId: string;
  expiresAt: Date;
}

interface FlightCompleteData extends FlightOwnerData {
  encryptedResult: string;
}

interface FlightRenewData extends FlightOwnerData {
  lockExpiresAt: Date;
}

interface FlightFailData extends FlightOwnerData {
  errorMessage: string;
}

interface FlightDeliveryData {
  key: string;
  ownerId: string;
  deliveryId: string;
}

export interface OpenIDRefreshFlightService {
  acquireOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    ttl?: number;
    lockTtl?: number;
  }) => Promise<RefreshFlightAcquireResult>;
  completeOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    tokens?: TokenResult | null;
    ttl?: number;
    onWriteStart?: () => void;
  }) => Promise<RefreshFlightRecord | null>;
  createOpenIDRefreshFlightKey: (input: RefreshKeyInput) => string | null;
  failOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    error?: Error | { message?: string } | null;
    ttl?: number;
  }) => Promise<RefreshFlightRecord | null>;
  renewOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    lockTtl?: number;
    ttl?: number;
  }) => Promise<RefreshFlightRecord | null>;
  assertOpenIDRefreshFlightAvailable: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  assertOpenIDRefreshSessionGenerationAvailable: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  claimOpenIDRefreshFlightDelivery: (args: {
    key: string;
    ownerId: string;
    createdAt?: number;
    deliveryId?: string;
    ttl?: number;
  }) => Promise<RefreshFlightRecord>;
  assertOpenIDRefreshFlightDeliveryAvailable: (args: FlightDeliveryData) => Promise<void>;
  releaseOpenIDRefreshFlightDelivery: (args: FlightDeliveryData) => Promise<void>;
  revokeOpenIDRefreshFlights: (args: {
    keys?: Array<string | null | undefined>;
    ttl?: number;
  }) => Promise<Array<TokenResult | null>>;
  waitForOpenIDRefreshFlight: (args: {
    key?: string | null;
    timeoutMs?: number;
    intervalMs?: number;
    requirePublication?: boolean;
    signal?: AbortSignal;
  }) => Promise<TokenResult | null>;
  withOpenIDRefreshFlightLease: <T>(args: {
    key?: string | null;
    ownerId?: string;
    operation: (context: LeaseContext) => Promise<T>;
    heartbeatInterval?: number;
    lockTtl?: number;
    ttl?: number;
  }) => Promise<T>;
  __internals: {
    sha256: (value: string) => string;
    readCompletedFlight: (flight: RefreshFlightRecord | null) => Promise<TokenResult | null>;
    DEFAULT_FLIGHT_TTL_MS: number;
    DEFAULT_LOCK_TTL_MS: number;
    DEFAULT_WAIT_TIMEOUT_MS: number;
    DEFAULT_WAIT_INTERVAL_MS: number;
    DEFAULT_HEARTBEAT_INTERVAL_MS: number;
    DEFAULT_DELIVERY_TTL_MS: number;
    INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD: string;
    getRenewedWaitDeadline: (deadline: number, flight: RefreshFlightRecord | null) => number;
  };
}

export interface OpenIDRefreshFlightDeps {
  db: {
    acquireOpenIDRefreshFlight: (
      data: FlightAcquireData,
    ) => Promise<{ acquired: boolean; flight?: RefreshFlightRecord | null }>;
    completeOpenIDRefreshFlight: (data: FlightCompleteData) => Promise<RefreshFlightRecord | null>;
    renewOpenIDRefreshFlight: (data: FlightRenewData) => Promise<RefreshFlightRecord | null>;
    failOpenIDRefreshFlight: (data: FlightFailData) => Promise<RefreshFlightRecord | null>;
    revokeOpenIDRefreshFlight: (data: {
      key: string;
      expiresAt: Date;
    }) => Promise<RefreshFlightRecord | null>;
    findOpenIDRefreshFlight: (data: { key: string }) => Promise<RefreshFlightRecord | null>;
    claimOpenIDRefreshFlightDelivery: (
      data: FlightDeliveryData & { deliveryExpiresAt: Date; createdAt?: Date },
    ) => Promise<RefreshFlightRecord | null>;
    releaseOpenIDRefreshFlightDelivery: (
      data: FlightDeliveryData,
    ) => Promise<RefreshFlightRecord | null>;
  };
  logger: Pick<OpenIDLogger, 'warn'>;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
}

export function createOpenIDRefreshFlightService({
  db,
  logger,
  encrypt,
  decrypt,
}: OpenIDRefreshFlightDeps): OpenIDRefreshFlightService {
  const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

  function createOpenIDRefreshFlightKey({
    req,
    user,
    refreshToken,
    identityContext,
  }: RefreshKeyInput): string | null {
    const identitySource = identityContext
      ? {
          id: identityContext.appUserId,
          openidId: identityContext.openidSubject,
          tenantId: identityContext.tenantId,
          openidIssuer: identityContext.openidIssuer,
        }
      : user;
    const tuple = createOpenIDRefreshIdentityTuple({
      user: identitySource,
      requestUser: req?.user,
    });
    if (!tuple || !refreshToken) return null;
    return sha256([serializeAuthIdentityTuple(tuple), sha256(refreshToken)].join('\x1f'));
  }

  async function acquireOpenIDRefreshFlight({
    key,
    ownerId = crypto.randomUUID(),
    ttl = DEFAULT_FLIGHT_TTL_MS,
    lockTtl = DEFAULT_LOCK_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    ttl?: number;
    lockTtl?: number;
  }): Promise<RefreshFlightAcquireResult> {
    if (!key) return { acquired: true, key: null, ownerId, flight: null };
    const acquired = await db.acquireOpenIDRefreshFlight({
      key,
      ownerId,
      lockExpiresAt: new Date(Date.now() + lockTtl),
      expiresAt: new Date(Date.now() + ttl),
    });
    return { ...acquired, key, ownerId };
  }

  async function completeOpenIDRefreshFlight({
    key,
    ownerId,
    tokens,
    ttl = DEFAULT_FLIGHT_TTL_MS,
    onWriteStart,
  }: {
    key?: string | null;
    ownerId?: string;
    tokens?: TokenResult | null;
    ttl?: number;
    onWriteStart?: () => void;
  }): Promise<RefreshFlightRecord | null> {
    if (!key || !ownerId || !tokens) return null;
    const serializedTokens: TokenResult = { ...tokens };
    if (tokens.__browserRefreshToken) {
      serializedTokens.__browserRefreshToken = tokens.__browserRefreshToken;
    }
    if (tokens.__predecessorRefreshToken) {
      serializedTokens.__predecessorRefreshToken = tokens.__predecessorRefreshToken;
    }
    if (tokens.__predecessorAccessToken) {
      serializedTokens.__predecessorAccessToken = tokens.__predecessorAccessToken;
    }
    if (tokens.__deferredPublication) {
      serializedTokens.__deferredPublication = true;
    }
    const accessTokenExpiresAt = Number(tokens.expires_at) * 1000;
    const usableTokenTtl = Number.isFinite(accessTokenExpiresAt)
      ? Math.max(1, accessTokenExpiresAt - Date.now() - OPENID_EXPIRY_BUFFER_SECONDS * 1000)
      : ttl;
    const encryptedResult = await encrypt(JSON.stringify(serializedTokens));
    onWriteStart?.();
    return db.completeOpenIDRefreshFlight({
      key,
      ownerId,
      encryptedResult,
      expiresAt: new Date(Date.now() + Math.min(ttl, usableTokenTtl)),
    });
  }

  async function renewOpenIDRefreshFlight({
    key,
    ownerId,
    lockTtl = DEFAULT_LOCK_TTL_MS,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    lockTtl?: number;
    ttl?: number;
  }): Promise<RefreshFlightRecord | null> {
    if (!key || !ownerId) return null;
    return db.renewOpenIDRefreshFlight({
      key,
      ownerId,
      lockExpiresAt: new Date(Date.now() + lockTtl),
      expiresAt: new Date(Date.now() + ttl),
    });
  }

  async function assertOpenIDRefreshFlightAvailable({
    key,
    ownerId,
  }: {
    key?: string | null;
    ownerId?: string;
  }): Promise<RefreshFlightRecord | boolean> {
    if (!key) return true;
    const flight = await db.findOpenIDRefreshFlight({ key });
    if (
      flight?.status === 'completed' &&
      ownerId &&
      flight.ownerId === ownerId &&
      !flight.revocationRequestedAt
    ) {
      return flight;
    }
    throw createOpenIDRefreshOwnershipError(
      'OpenID refresh result is no longer available for publication',
    );
  }

  /**
   * Validates a generation already installed in an Express session. Completed-flight rows may
   * expire before the session reuse window, so absence is acceptable; an extant row must still
   * name the same completed generation. Logout tombstones and replacement generations fail closed.
   */
  async function assertOpenIDRefreshSessionGenerationAvailable({
    key,
    ownerId,
  }: {
    key?: string | null;
    ownerId?: string;
  }): Promise<RefreshFlightRecord | boolean> {
    if (!key && !ownerId) return true;
    if (!key || !ownerId) {
      throw createOpenIDRefreshOwnershipError(
        'OpenID session publication generation is incomplete',
      );
    }
    const flight = await db.findOpenIDRefreshFlight({ key });
    if (
      !flight ||
      (flight.status === 'completed' && flight.ownerId === ownerId && !flight.revocationRequestedAt)
    ) {
      return flight ?? true;
    }
    throw createOpenIDRefreshOwnershipError(
      'OpenID session publication generation is no longer available',
    );
  }

  async function claimOpenIDRefreshFlightDelivery({
    key,
    ownerId,
    createdAt,
    deliveryId = crypto.randomUUID(),
    ttl = DEFAULT_DELIVERY_TTL_MS,
  }: {
    key: string;
    ownerId: string;
    createdAt?: number;
    deliveryId?: string;
    ttl?: number;
  }): Promise<RefreshFlightRecord> {
    const deadline = Date.now() + ttl;
    while (Date.now() <= deadline) {
      const deliveryExpiresAt = new Date(Date.now() + ttl);
      const delivery = await db.claimOpenIDRefreshFlightDelivery({
        key,
        ownerId,
        deliveryId,
        deliveryExpiresAt,
        ...(Number.isFinite(createdAt) ? { createdAt: new Date(createdAt as number) } : {}),
      });
      if (delivery) return delivery;

      const current = await db.findOpenIDRefreshFlight({ key });
      if (!current && Number.isFinite(createdAt)) {
        await delay(DEFAULT_WAIT_INTERVAL_MS);
        continue;
      }
      if (
        current?.status !== 'completed' ||
        current.ownerId !== ownerId ||
        current.revocationRequestedAt
      ) {
        throw createOpenIDRefreshOwnershipError(
          'OpenID refresh generation is unavailable for response delivery',
        );
      }
      await delay(DEFAULT_WAIT_INTERVAL_MS);
    }
    throw new Error('Timed out waiting to deliver the OpenID refresh generation');
  }

  async function assertOpenIDRefreshFlightDeliveryAvailable({
    key,
    ownerId,
    deliveryId,
  }: FlightDeliveryData): Promise<void> {
    const delivery = await db.findOpenIDRefreshFlight({ key });
    const deliveryExpiresAt = delivery?.deliveryExpiresAt
      ? new Date(delivery.deliveryExpiresAt).getTime()
      : NaN;
    if (
      delivery?.status === 'completed' &&
      delivery.ownerId === ownerId &&
      delivery.deliveryId === deliveryId &&
      !delivery.revocationRequestedAt &&
      Number.isFinite(deliveryExpiresAt) &&
      deliveryExpiresAt > Date.now()
    ) {
      return;
    }
    throw createOpenIDRefreshOwnershipError(
      'OpenID refresh response delivery authorization was revoked',
    );
  }

  async function releaseOpenIDRefreshFlightDelivery({
    key,
    ownerId,
    deliveryId,
  }: FlightDeliveryData): Promise<void> {
    await db.releaseOpenIDRefreshFlightDelivery({ key, ownerId, deliveryId });
  }

  async function withOpenIDRefreshFlightLease<T>({
    key,
    ownerId,
    operation,
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS,
    lockTtl = DEFAULT_LOCK_TTL_MS,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    operation: (context: LeaseContext) => Promise<T>;
    heartbeatInterval?: number;
    lockTtl?: number;
    ttl?: number;
  }): Promise<T> {
    if (!key || !ownerId)
      return operation({ assertLeaseOwned: async () => true, markLeaseSettled: () => {} });
    let renewalPromise: Promise<RefreshFlightRecord | null> | null = null;
    let ownershipLost = false;
    let settled = false;
    const ownershipError = () =>
      createOpenIDRefreshOwnershipError(
        'OpenID refresh coordination ownership was lost before completion',
      );
    const renewLease = async () => {
      if (ownershipLost) throw ownershipError();
      if (!renewalPromise)
        renewalPromise = renewOpenIDRefreshFlight({ key, ownerId, lockTtl, ttl }).finally(() => {
          renewalPromise = null;
        });
      const flight = await renewalPromise;
      if (!flight) {
        if (settled) return null;
        const terminalFlight = await db.findOpenIDRefreshFlight({ key });
        if (terminalFlight?.ownerId === ownerId && terminalFlight?.status === 'completed') {
          return terminalFlight;
        }
        ownershipLost = true;
        throw ownershipError();
      }
      return flight;
    };
    const heartbeat = setInterval(() => {
      renewLease().catch((error) =>
        logger.warn('[OpenIDRefreshFlight] Refresh flight lease renewal failed', {
          key,
          error: error?.message,
        }),
      );
    }, heartbeatInterval);
    heartbeat.unref?.();
    let result: T;
    try {
      result = await operation({
        assertLeaseOwned: renewLease,
        markLeaseSettled: () => {
          settled = true;
        },
      });
      if (ownershipLost) throw ownershipError();
    } catch (error) {
      clearInterval(heartbeat);
      if (renewalPromise) {
        try {
          await renewalPromise;
        } catch (cleanupError) {
          logger.warn('[OpenIDRefreshFlight] Lease cleanup also failed after the operation', {
            key,
            error: toOpenIDLogArgument(cleanupError),
          });
        }
      }
      throw error;
    }
    clearInterval(heartbeat);
    if (renewalPromise) {
      try {
        await renewalPromise;
      } catch (error) {
        if (!settled || isOpenIDRefreshOwnershipError(error)) {
          throw error;
        }
      }
    }
    if (ownershipLost) {
      throw ownershipError();
    }
    return result;
  }

  async function failOpenIDRefreshFlight({
    key,
    ownerId,
    error,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    error?: Error | { message?: string } | null;
    ttl?: number;
  }): Promise<RefreshFlightRecord | null> {
    if (!key || !ownerId) return null;
    const errorMessage =
      typeof error?.message === 'string' && error.message ? error.message : 'OpenID refresh failed';
    return db.failOpenIDRefreshFlight({
      key,
      ownerId,
      errorMessage,
      expiresAt: new Date(Date.now() + ttl),
    });
  }

  async function revokeOpenIDRefreshFlights({
    keys,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    keys?: Array<string | null | undefined>;
    ttl?: number;
  }): Promise<Array<TokenResult | null>> {
    const uniqueKeys = [...new Set<string>((keys ?? []).filter((key): key is string => !!key))];
    if (uniqueKeys.length === 0) return [];
    const expiresAt = new Date(Date.now() + ttl);
    const revoked = await Promise.all(
      uniqueKeys.map((key) => db.revokeOpenIDRefreshFlight({ key, expiresAt })),
    );
    return Promise.all(
      revoked.map(async (flight) => {
        if (!flight?.encryptedResult) return null;
        return restoreInternalTokenFields(
          JSON.parse(await decrypt(flight.encryptedResult)) as TokenResult,
        );
      }),
    );
  }

  function restoreInternalTokenFields(tokens: TokenResult): TokenResult {
    for (const [field, value] of [
      [INTERNAL_BROWSER_REFRESH_TOKEN_FIELD, tokens.__browserRefreshToken],
      [INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD, tokens.__predecessorRefreshToken],
      [INTERNAL_PREDECESSOR_ACCESS_TOKEN_FIELD, tokens.__predecessorAccessToken],
      [INTERNAL_DEFERRED_PUBLICATION_FIELD, tokens.__deferredPublication],
    ] as const) {
      if (value) {
        delete tokens[field];
        Object.defineProperty(tokens, field, { value, enumerable: false, configurable: true });
      }
    }
    return tokens;
  }

  function attachFlightOwner(
    tokens: TokenResult,
    ownerId?: string,
    createdAt?: Date | string,
  ): TokenResult {
    if (!ownerId) return tokens;
    Object.defineProperty(tokens, INTERNAL_FLIGHT_OWNER_FIELD, {
      value: ownerId,
      enumerable: false,
      configurable: true,
    });
    const createdAtMs = createdAt ? new Date(createdAt).getTime() : NaN;
    if (Number.isFinite(createdAtMs)) {
      Object.defineProperty(tokens, INTERNAL_FLIGHT_CREATED_AT_FIELD, {
        value: createdAtMs,
        enumerable: false,
        configurable: true,
      });
    }
    return tokens;
  }

  async function readCompletedFlight(
    flight: RefreshFlightRecord | null,
  ): Promise<TokenResult | null> {
    if (!flight) return null;
    if (
      flight.status === 'failed' &&
      flight.errorMessage === OPENID_REFRESH_CANCELLED_BEFORE_GRANT
    ) {
      throw Object.assign(new Error('OpenID refresh owner stopped before starting the grant'), {
        status: 503,
        retryable: true,
      });
    }
    if (flight.status === 'revoked')
      throw new Error(flight.errorMessage || 'OpenID refresh was revoked by logout');
    if (flight.status === 'failed')
      throw new Error(flight.errorMessage || 'OpenID refresh failed in another worker');
    if (flight.status !== 'completed' || flight.revocationRequestedAt || !flight.encryptedResult)
      return null;
    const tokens = JSON.parse(await decrypt(flight.encryptedResult)) as TokenResult;
    const accessTokenExpiresAt = Number(tokens.expires_at) * 1000;
    if (
      Number.isFinite(accessTokenExpiresAt) &&
      accessTokenExpiresAt <= Date.now() + OPENID_EXPIRY_BUFFER_SECONDS * 1000
    ) {
      return null;
    }
    return attachFlightOwner(restoreInternalTokenFields(tokens), flight.ownerId, flight.createdAt);
  }

  function getRenewedWaitDeadline(deadline: number, flight: RefreshFlightRecord | null): number {
    const renewedExpiry = flight?.expiresAt ? new Date(flight.expiresAt).getTime() : NaN;
    return Number.isFinite(renewedExpiry) ? Math.max(deadline, renewedExpiry) : deadline;
  }

  async function waitForOpenIDRefreshFlight({
    key,
    timeoutMs,
    intervalMs = DEFAULT_WAIT_INTERVAL_MS,
    requirePublication = false,
    signal,
  }: {
    key?: string | null;
    timeoutMs?: number;
    intervalMs?: number;
    requirePublication?: boolean;
    signal?: AbortSignal;
  }): Promise<TokenResult | null> {
    signal?.throwIfAborted();
    if (!key) return null;
    const followRenewals = timeoutMs == null && !requirePublication;
    let deadline = Date.now() + (timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    while (Date.now() <= deadline) {
      signal?.throwIfAborted();
      const flight = await db.findOpenIDRefreshFlight({ key });
      signal?.throwIfAborted();
      const completed = await readCompletedFlight(flight);
      signal?.throwIfAborted();
      const awaitingPublication = requirePublication && completed?.__deferredPublication;
      if (completed && !awaitingPublication) return completed;
      if (flight?.status === 'completed' && !awaitingPublication) return null;
      if (!flight && !requirePublication) return null;
      if (followRenewals) {
        deadline = getRenewedWaitDeadline(deadline, flight);
      }
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
    logger.warn('[OpenIDRefreshFlight] Timed out waiting for refresh flight', { key });
    return null;
  }

  return {
    acquireOpenIDRefreshFlight,
    assertOpenIDRefreshFlightDeliveryAvailable,
    assertOpenIDRefreshFlightAvailable,
    assertOpenIDRefreshSessionGenerationAvailable,
    claimOpenIDRefreshFlightDelivery,
    completeOpenIDRefreshFlight,
    createOpenIDRefreshFlightKey,
    failOpenIDRefreshFlight,
    renewOpenIDRefreshFlight,
    releaseOpenIDRefreshFlightDelivery,
    revokeOpenIDRefreshFlights,
    waitForOpenIDRefreshFlight,
    withOpenIDRefreshFlightLease,
    __internals: {
      sha256,
      readCompletedFlight,
      DEFAULT_FLIGHT_TTL_MS,
      DEFAULT_LOCK_TTL_MS,
      DEFAULT_WAIT_TIMEOUT_MS,
      DEFAULT_WAIT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      DEFAULT_DELIVERY_TTL_MS,
      INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD,
      getRenewedWaitDeadline,
    },
  };
}
