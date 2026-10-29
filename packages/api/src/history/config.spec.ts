import {
  describeTarget,
  MissingCredentialError,
  optionalEnv,
  readClickHouseConfig,
  readHistoryTierConfig,
  requireEnv,
} from './config';

/** Stands in for an operator-supplied secret. No real credential appears in this repo. */
const SECRET = 'REPLACE_ME_TEST_ONLY_SECRET';

describe('requireEnv', () => {
  it('returns the configured value', () => {
    expect(requireEnv('X', { X: ' value ' })).toBe('value');
  });

  it('throws when the variable is absent, empty, or whitespace', () => {
    expect(() => requireEnv('X', {})).toThrow(MissingCredentialError);
    expect(() => requireEnv('X', { X: '' })).toThrow(MissingCredentialError);
    expect(() => requireEnv('X', { X: '   ' })).toThrow(MissingCredentialError);
  });

  it('never has a fallback default', () => {
    expect(() => requireEnv('CHAT_SEARCH_CLICKHOUSE_PASSWORD', {})).toThrow(
      /required and has no default/,
    );
  });

  it('names only the variable, never a value, in the error', () => {
    // A malformed DSN must not leak its password into a log line or a stack trace.
    const malformed = `postgres//writer:${SECRET}@db`;
    let thrown: Error | null = null;
    try {
      requireEnv('CHAT_SEARCH_WRITER_URL', { CHAT_SEARCH_WRITER_URL: '' });
      requireEnv('CHAT_SEARCH_WRITER_URL', { CHAT_SEARCH_WRITER_URL: malformed });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(MissingCredentialError);
    expect(thrown?.message).toBe(
      'CHAT_SEARCH_WRITER_URL is required and has no default; set it in the environment',
    );
    expect(`${thrown?.message}${thrown?.stack ?? ''}`).not.toContain(SECRET);
    expect((thrown as MissingCredentialError).variable).toBe('CHAT_SEARCH_WRITER_URL');
  });
});

describe('optionalEnv', () => {
  it('falls back only for non-secret settings', () => {
    expect(optionalEnv('CHAT_SEARCH_EMBEDDING_SPACE', 'chat-v1', {})).toBe('chat-v1');
    expect(
      optionalEnv('CHAT_SEARCH_EMBEDDING_SPACE', 'chat-v1', {
        CHAT_SEARCH_EMBEDDING_SPACE: 'chat-v2',
      }),
    ).toBe('chat-v2');
  });
});

describe('readClickHouseConfig', () => {
  const complete = {
    CHAT_SEARCH_CLICKHOUSE_URL: 'https://clickhouse.internal:8443',
    CHAT_SEARCH_CLICKHOUSE_USER: 'chat_search_writer',
    CHAT_SEARCH_CLICKHOUSE_PASSWORD: SECRET,
  };

  it('reads a complete configuration', () => {
    expect(readClickHouseConfig(complete)).toEqual({
      url: 'https://clickhouse.internal:8443',
      username: 'chat_search_writer',
      password: SECRET,
      database: 'chat_search',
    });
  });

  it.each(Object.keys(complete))('fails closed when %s is missing', (variable) => {
    const partial: Record<string, string> = { ...complete };
    delete partial[variable];
    expect(() => readClickHouseConfig(partial)).toThrow(variable);
  });
});

describe('readHistoryTierConfig', () => {
  it('reads nothing while the tier is disabled', () => {
    expect(readHistoryTierConfig({})).toBeNull();
    expect(readHistoryTierConfig({ CHAT_SEARCH_CLICKHOUSE_ENABLED: 'false' })).toBeNull();
  });

  it('requires every credential once the tier is enabled', () => {
    expect(() => readHistoryTierConfig({ CHAT_SEARCH_CLICKHOUSE_ENABLED: 'true' })).toThrow(
      MissingCredentialError,
    );
  });

  it('requires the writer DSN, never the request-reader DSN', () => {
    expect(() =>
      readHistoryTierConfig({
        CHAT_SEARCH_CLICKHOUSE_ENABLED: 'true',
        CHAT_SEARCH_CLICKHOUSE_URL: 'https://clickhouse.internal:8443',
        CHAT_SEARCH_CLICKHOUSE_USER: 'chat_search_writer',
        CHAT_SEARCH_CLICKHOUSE_PASSWORD: SECRET,
        CHAT_SEARCH_DATABASE_URL: 'postgres://reader@db/chat_search',
      }),
    ).toThrow('CHAT_SEARCH_WRITER_URL');
  });

  it('assembles the tier configuration when everything is supplied', () => {
    const config = readHistoryTierConfig({
      CHAT_SEARCH_CLICKHOUSE_ENABLED: 'true',
      CHAT_SEARCH_CLICKHOUSE_URL: 'https://clickhouse.internal:8443',
      CHAT_SEARCH_CLICKHOUSE_USER: 'chat_search_writer',
      CHAT_SEARCH_CLICKHOUSE_PASSWORD: SECRET,
      CHAT_SEARCH_WRITER_URL: `postgres://writer:${SECRET}@db:5432/chat_search`,
    });

    expect(config?.enabled).toBe(true);
    expect(config?.embeddingSpace).toBe('chat-v1');
    expect(config?.clickhouse.database).toBe('chat_search');
  });
});

describe('describeTarget', () => {
  it('strips userinfo, path and query so a DSN is loggable', () => {
    const dsn = `postgres://writer:${SECRET}@db.internal:5432/chat_search?sslmode=require`;
    expect(describeTarget(dsn)).toBe('postgres://db.internal:5432');
    expect(describeTarget(dsn)).not.toContain(SECRET);
  });

  it('never echoes an unparseable string that might carry a password', () => {
    expect(describeTarget(`not a url ${SECRET}`)).toBe('<unparseable-url>');
  });
});
