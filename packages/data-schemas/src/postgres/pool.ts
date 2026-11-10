import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

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
  async function connect(): Promise<PoolClient> {
    if (closing || pool.waitingCount >= options.maxWaiting) {
      throw new Error('PostgreSQL connection admission unavailable');
    }
    try {
      return await pool.connect();
    } catch {
      throw new Error('PostgreSQL connection unavailable');
    }
  }
  const database: PostgresDatabase = {
    async query<R extends QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>> {
      const client = await connect();
      try {
        return await client.query<R>(text, values);
      } finally {
        client.release();
      }
    },
    async transaction<T>(operation: (sql: SqlExecutor) => Promise<T>): Promise<T> {
      return database.session((session) => session.transaction(operation));
    },
    async session<T>(operation: (sql: PostgresSession) => Promise<T>): Promise<T> {
      const client = await connect();
      let discard = false;
      let inTransaction = false;
      const session: PostgresSession = {
        query: (text, values) => client.query(text, values),
        async transaction<U>(work: (sql: SqlExecutor) => Promise<U>): Promise<U> {
          if (inTransaction) throw new Error('Nested PostgreSQL transactions are not supported');
          inTransaction = true;
          try {
            await client.query('BEGIN');
            const value = await work(session);
            await client.query('COMMIT');
            return value;
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch {
              discard = true;
            }
            throw error;
          } finally {
            inTransaction = false;
          }
        },
      };
      try {
        return await operation(session);
      } finally {
        client.release(discard);
      }
    },
    close() {
      closing = true;
      closePromise ??= pool.end();
      return closePromise;
    },
  };
  return database;
}
