/**
 * Connection configuration for the history tier (PLAN "Credentials", Danny's
 * directive 2026-08-07).
 *
 * No hardcoded credentials anywhere: every DSN and password is operator-supplied
 * and REQUIRED. There is deliberately no fallback default — a working default is
 * the defect, not the convenience, and it is exactly how the existing `vectordb`
 * ended up reachable with a credential committed to four compose files and a
 * Helm chart.
 *
 * Two rules the helpers below enforce mechanically:
 *
 *  - Missing configuration throws at startup, naming only the VARIABLE. A value
 *    is never echoed, so a typo'd DSN cannot leak a password into a log line, a
 *    stack trace, or an error-tracking payload.
 *  - `describeTarget` is the only thing any caller may log about a connection:
 *    scheme, host and port with userinfo and query string stripped.
 */

export class MissingCredentialError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is required and has no default; set it in the environment`);
    this.name = 'MissingCredentialError';
  }
}

export type HistoryEnv = Readonly<Record<string, string | undefined>>;

export type ClickHouseConnectionConfig = Readonly<{
  url: string;
  username: string;
  password: string;
  database: string;
}>;

export type HistoryTierConfig = Readonly<{
  enabled: boolean;
  clickhouse: ClickHouseConnectionConfig;
  /** Projector/outbox/sweep DSN. Never the request-reader DSN. */
  writerUrl: string;
  embeddingSpace: string;
}>;

/** Required string from the environment. Throws without echoing the value. */
export function requireEnv(name: string, env: HistoryEnv = process.env): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissingCredentialError(name);
  }
  return value.trim();
}

/**
 * Non-secret setting with a safe default. Restricted to values that carry no
 * credential — never use this for a DSN, password, or key.
 */
export function optionalEnv(name: string, fallback: string, env: HistoryEnv = process.env): string {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function readClickHouseConfig(env: HistoryEnv = process.env): ClickHouseConnectionConfig {
  return {
    url: requireEnv('CHAT_SEARCH_CLICKHOUSE_URL', env),
    username: requireEnv('CHAT_SEARCH_CLICKHOUSE_USER', env),
    password: requireEnv('CHAT_SEARCH_CLICKHOUSE_PASSWORD', env),
    database: optionalEnv('CHAT_SEARCH_CLICKHOUSE_DATABASE', 'chat_search', env),
  };
}

/**
 * Full tier configuration. Reads nothing when the tier is disabled, so a
 * deployment running `CHAT_SEARCH_CLICKHOUSE_ENABLED=false` is not forced to
 * provision credentials it will not use (PLAN track 6 abort criterion).
 */
export function readHistoryTierConfig(env: HistoryEnv = process.env): HistoryTierConfig | null {
  if (optionalEnv('CHAT_SEARCH_CLICKHOUSE_ENABLED', 'false', env) !== 'true') {
    return null;
  }
  return {
    enabled: true,
    clickhouse: readClickHouseConfig(env),
    writerUrl: requireEnv('CHAT_SEARCH_WRITER_URL', env),
    embeddingSpace: optionalEnv('CHAT_SEARCH_EMBEDDING_SPACE', 'chat-v1', env),
  };
}

/**
 * The only representation of a connection target that may be logged: scheme,
 * host and port, with userinfo, path and query removed. Falls back to a constant
 * rather than risking an echo of an unparseable string that may contain a
 * password.
 */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '<unparseable-url>';
  }
}
