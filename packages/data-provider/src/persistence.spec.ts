import { configSchema, persistenceConfigSchema, DEPLOYMENT_ONLY_CONFIG_PATHS } from './config';

describe('deployment persistence configuration', () => {
  it('defaults existing deployments to Mongo and keeps selection deployment-only', () => {
    expect(configSchema.parse({ version: '1.3.1' }).persistence).toEqual({
      favorites: 'mongo',
      authentication: 'mongo',
    });
    expect(DEPLOYMENT_ONLY_CONFIG_PATHS.persistence).toBe('operator');
  });
  it('accepts bounded pool settings and an environment-variable name, never a DSN', () => {
    const config = persistenceConfigSchema.parse({
      favorites: 'postgres',
      postgres: { connectionStringEnv: 'LIBRECHAT_POSTGRES_DSN' },
    });
    expect(config.postgres).toMatchObject({
      max: 10,
      maxWaiting: 100,
      acquireTimeoutMs: 5000,
      queryTimeoutMs: 15000,
    });
    expect(
      persistenceConfigSchema.safeParse({
        favorites: 'postgres',
        postgres: { connectionStringEnv: 'postgres://secret' },
      }).success,
    ).toBe(false);
  });
  it('selects authentication independently and bounds native credential cleanup', () => {
    const config = persistenceConfigSchema.parse({
      authentication: 'postgres',
      postgres: {
        connectionStringEnv: 'PG_AUTH',
        authenticationCleanupIntervalMs: 1000,
        authenticationCleanupBatchSize: 1,
      },
    });
    expect(config.favorites).toBe('mongo');
    expect(config.authentication).toBe('postgres');
    expect(config.postgres).toMatchObject({
      authenticationCleanupIntervalMs: 1000,
      authenticationCleanupBatchSize: 1,
    });
    const defaults = persistenceConfigSchema.parse({
      authentication: 'postgres',
      postgres: { connectionStringEnv: 'PG_AUTH' },
    });
    expect(defaults.postgres).toMatchObject({
      authenticationCleanupIntervalMs: 60000,
      authenticationCleanupBatchSize: 250,
    });
  });
  it.each([
    { favorites: 'postgres' },
    { favorites: 'invalid' },
    { authentication: 'postgres' },
    { authentication: 'invalid' },
    {
      authentication: 'postgres',
      postgres: { connectionStringEnv: 'PG', authenticationCleanupIntervalMs: 0 },
    },
    {
      authentication: 'postgres',
      postgres: { connectionStringEnv: 'PG', authenticationCleanupBatchSize: 10001 },
    },
    { favorites: 'postgres', postgres: { connectionStringEnv: 'PG', max: 0 } },
  ])('refuses an explicit invalid selection: %j', (config) => {
    expect(persistenceConfigSchema.safeParse(config).success).toBe(false);
  });
});
