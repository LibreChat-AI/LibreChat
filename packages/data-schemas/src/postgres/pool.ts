import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

export interface PostgresOptions {
  connectionString: string;
  max: number;
  maxWaiting: number;
  acquireTimeoutMs: number;
  queryTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PostgresSession extends SqlExecutor {
  transaction<T>(operation: (sql: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface PostgresDatabase extends PostgresSession {
  session<T>(operation: (sql: PostgresSession) => Promise<T>): Promise<T>;
  transaction<T>(operation: (sql: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPostgresDatabase(options: PostgresOptions): PostgresDatabase {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.acquireTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    statement_timeout: options.queryTimeoutMs,
    query_timeout: options.queryTimeoutMs,
    idle_in_transaction_session_timeout: options.queryTimeoutMs,
    application_name: 'librechat',
  });
  // Idle-client errors must not become uncaught exceptions or expose connection details.
  pool.on('error', () => undefined);
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function connectionError(): Error {
    return new Error('PostgreSQL connection unavailable');
  }
  function isConnectionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
    const severity = 'severity' in error ? error.severity : undefined;
    return (
      severity === 'FATAL' ||
      severity === 'PANIC' ||
      code?.startsWith('08') === true ||
      ['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].includes(
        code ?? '',
      ) ||
      [
        'Connection terminated unexpectedly',
        'Connection terminated',
        'Client has encountered a connection error and is not queryable',
        'Client was closed and is not queryable',
        'Query read timeout',
      ].includes(error.message)
    );
  }
  function connect() {
    if (closing || pool.waitingCount >= options.maxWaiting) {
      return Promise.reject(new Error('PostgreSQL connection admission unavailable'));
    }
    // The callback installs protection before pg-pool's synchronous handoff returns.
    return new Promise<{
      query: SqlExecutor['query'];
      failure: Promise<never>;
      assertHealthy(): void;
      discard(): void;
      release(): void;
    }>((resolve, reject) => {
      pool.connect((error, client) => {
        if (error || !client) {
          reject(connectionError());
          return;
        }
        let failed: Error | undefined;
        let released = false;
        let discard = false;
        let rejectFailure: (error: Error) => void;
        const failure = new Promise<never>((_, reject) => {
          rejectFailure = reject;
        });
        void failure.catch(() => undefined);
        const onError = () => {
          if (failed) return;
          failed = connectionError();
          rejectFailure(failed);
        };
        client.on('error', onError);
        const assertHealthy = () => {
          if (failed) throw failed;
          if (released) throw connectionError();
        };
        resolve({
          failure,
          assertHealthy,
          discard() {
            discard = true;
          },
          async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
            assertHealthy();
            try {
              const result = await client.query<R>(text, values);
              assertHealthy();
              return result;
            } catch (error) {
              if (isConnectionError(error)) onError();
              throw failed ?? error;
            }
          },
          release() {
            if (released) return;
            released = true;
            try {
              client.release(discard || Boolean(failed));
            } finally {
              // release restores pg-pool's idle listener before ours is removed.
              client.removeListener('error', onError);
            }
          },
        });
      });
    }).catch(() => {
      throw connectionError();
    });
  }
  const database: PostgresDatabase = {
    query: (text, values) => database.session((session) => session.query(text, values)),
    async transaction<T>(operation: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      return database.session((session) => session.transaction(operation));
    },
    async session<T>(operation: (sql: PostgresSession) => Promise<T>): Promise<T> {
      const lease = await connect();
      let inTransaction = false;
      const session: PostgresSession = {
        query: lease.query,
        async transaction<U>(work: (sql: SqlExecutor) => Promise<U>): Promise<U> {
          lease.assertHealthy();
          if (inTransaction) throw new Error('Nested PostgreSQL transactions are not supported');
          inTransaction = true;
          try {
            await lease.query('BEGIN');
            const value = await work(session);
            await lease.query('COMMIT');
            return value;
          } catch (error) {
            // A lost COMMIT acknowledgement has an unknown outcome. Do not claim rollback.
            lease.assertHealthy();
            try {
              await lease.query('ROLLBACK');
            } catch {
              lease.discard();
            }
            lease.assertHealthy();
            throw error;
          } finally {
            inTransaction = false;
          }
        },
      };
      const work = Promise.resolve()
        .then(() => {
          lease.assertHealthy();
          return operation(session);
        })
        .then((value) => {
          lease.assertHealthy();
          return value;
        })
        .finally(() => lease.release());
      // Report disconnects promptly, but retain ownership until the callback settles.
      return Promise.race([work, lease.failure]);
    },
    close() {
      closing = true;
      closePromise ??= pool.end();
      return closePromise;
    },
  };
  return database;
}
