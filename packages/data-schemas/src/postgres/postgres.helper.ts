import { randomBytes } from 'node:crypto';
import type { PostgresDatabase, PostgresOptions } from './pool';
import { createPostgresDatabase } from './pool';

export const postgresTestOptions: PostgresOptions = {
  connectionString: process.env.PG_TEST_URL ?? '',
  max: 4,
  maxWaiting: 20,
  acquireTimeoutMs: 1000,
  queryTimeoutMs: 5000,
  idleTimeoutMs: 1000,
};

/** Each spec/Stryker worker gets its own schema; network and constraints remain real. */
export async function createPostgresTestDatabase(): Promise<{
  db: PostgresDatabase;
  options: PostgresOptions;
  schema: string;
}> {
  const admin = createPostgresDatabase(postgresTestOptions);
  const schema = `favorites_test_${randomBytes(8).toString('hex')}`;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(postgresTestOptions.connectionString);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const options = { ...postgresTestOptions, connectionString: url.toString() };
    const database = createPostgresDatabase(options);
    let closing: Promise<void> | undefined;
    const db: PostgresDatabase = {
      ...database,
      close() {
        closing ??= (async () => {
          try {
            await database.close();
          } finally {
            try {
              await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            } finally {
              await admin.close();
            }
          }
        })();
        return closing;
      },
    };
    return { db, options, schema };
  } catch (error) {
    await admin.close();
    throw error;
  }
}
