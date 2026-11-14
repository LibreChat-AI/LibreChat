import type mongoose from 'mongoose';
import type { OpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import type { RefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import type { PostgresOptions, PostgresDatabase } from '../pool';
import type { TokenListMethods } from '~/methods/tokenList';
import type { SessionMethods } from '~/methods/session';
import type { PasskeyMethods } from '~/methods/passkey';
import type { TokenMethods } from '~/methods/token';
import type { TokenQueries } from './tokenQueries';
import { createMongoTokenQueries, createPostgresTokenQueries } from './tokenQueries';
import { createOpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import { createRefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import { createPostgresOpenIDRefreshFlightMethods } from './flight';
import { createPostgresRefreshTokenBridgeMethods } from './bridge';
import { createTokenListMethods } from '~/methods/tokenList';
import { assertPostgresAuthenticationReady } from './schema';
import { createSessionMethods } from '~/methods/session';
import { createPasskeyMethods } from '~/methods/passkey';
import { createPostgresSessionMethods } from './session';
import { createPostgresPasskeyMethods } from './passkey';
import { createTokenMethods } from '~/methods/token';
import { createPostgresTokenMethods } from './token';
import { createPostgresDatabase } from '../pool';
import logger from '~/config/winston';

export type AuthenticationMethods = SessionMethods &
  TokenMethods &
  TokenListMethods &
  PasskeyMethods &
  RefreshTokenBridgeMethods &
  OpenIDRefreshFlightMethods &
  TokenQueries;
export interface AuthenticationBackend {
  methods: AuthenticationMethods;
  initialize(): Promise<void>;
  close(): Promise<void>;
}
export function createMongoAuthenticationMethods(database: typeof mongoose): AuthenticationMethods {
  return {
    ...createSessionMethods(database),
    ...createTokenMethods(database),
    ...createTokenListMethods(database),
    ...createPasskeyMethods(database),
    ...createRefreshTokenBridgeMethods(database),
    ...createOpenIDRefreshFlightMethods(database),
    ...createMongoTokenQueries(database),
  };
}
export interface AuthenticationPostgresOptions extends PostgresOptions {
  authenticationCleanupIntervalMs?: number;
  authenticationCleanupBatchSize?: number;
}

export function createPostgresAuthenticationBackend(
  options: AuthenticationPostgresOptions,
): AuthenticationBackend {
  const db = createPostgresDatabase(options);
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const sweep = () => {
    sweeping ??= purgeExpiredAuthentication(
      db,
      options.authenticationCleanupBatchSize ?? 250,
    ).finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };
  return {
    methods: {
      ...createPostgresSessionMethods(db),
      ...createPostgresPasskeyMethods(db),
      ...createPostgresTokenMethods(db),
      ...createPostgresRefreshTokenBridgeMethods(db),
      ...createPostgresOpenIDRefreshFlightMethods(db),
      ...createPostgresTokenQueries(db),
    },
    async initialize() {
      await assertPostgresAuthenticationReady(db);
      await sweep();
      timer ??= setInterval(() => {
        void sweep().catch(() => logger.warn('[authentication] Expired credential cleanup failed'));
      }, options.authenticationCleanupIntervalMs ?? 60000);
      timer.unref();
    },
    close() {
      if (timer) clearInterval(timer);
      closing ??= (async () => {
        await sweeping?.catch(() => undefined);
        await db.close();
      })();
      return closing;
    },
  };
}

/** One bounded, index-backed batch per expiring collection. Passkeys do not expire. */
export async function purgeExpiredAuthentication(
  db: PostgresDatabase,
  limit: number,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
    throw new Error('Invalid authentication cleanup batch size');
  for (const [table, expiry] of [
    ['auth_sessions', 'expiration'],
    ['auth_tokens', 'expires_at'],
    ['auth_bridges', 'expires_at'],
    ['auth_refresh_flights', 'expires_at'],
  ] as const) {
    await db.query(
      `DELETE FROM ${table} WHERE id IN (
      SELECT id FROM ${table} WHERE ${expiry}<=clock_timestamp()
      ${table === 'auth_refresh_flights' ? 'AND (delivery_expires_at IS NULL OR delivery_expires_at<=clock_timestamp())' : ''}
      ORDER BY ${expiry},id LIMIT $1 FOR UPDATE SKIP LOCKED
    )`,
      [limit],
    );
  }
}
