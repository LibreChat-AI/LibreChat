import { PULL_REQUEST_PROVIDERS } from 'librechat-data-provider';
import type { PullRequestProvider, TAgentsEndpoint } from 'librechat-data-provider';

export type PullRequestSettings = NonNullable<TAgentsEndpoint['pullRequests']>;

const TOKEN_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Tried in order when `token` is not configured, so a deployment that already holds a token for
 * something else gets pull requests without more setup. A token named in the config always wins,
 * and one that does not resolve is reported instead of silently replaced.
 */
const TOKEN_ENV_FALLBACKS: Record<PullRequestProvider, readonly string[]> = {
  github: ['GITHUB_PULL_REQUEST_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
  gitlab: ['GITLAB_PULL_REQUEST_TOKEN', 'GITLAB_TOKEN'],
  bitbucket: ['BITBUCKET_PULL_REQUEST_TOKEN'],
};

const DEFAULT_HOSTS: Record<PullRequestProvider, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** The configured provider, GitHub when none is set, `null` for a name this server does not know. */
export function resolvePullRequestProvider(
  provider: string | undefined,
): PullRequestProvider | null {
  if (provider == null) return 'github';
  return (PULL_REQUEST_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as PullRequestProvider)
    : null;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Resolves `${NAME}` against the environment; the config never holds the token itself. */
export function resolveTokenReference(reference: string | undefined, env: Env): string | null {
  const name = reference == null ? undefined : TOKEN_REFERENCE.exec(reference)?.[1];
  if (name == null) return null;
  return env[name]?.trim() || null;
}

const HOST = /^(?=[a-z0-9])[a-z0-9.-]*[a-z0-9](?::[0-9]{1,5})?$/;

/**
 * The configured host, lowercased, or the provider's own when none is set. `null` for a value that
 * is not a plain host name, and for any Bitbucket host but Cloud's: the token is then sent nowhere
 * rather than to a host nobody named.
 */
export function resolvePullRequestHost(
  host: string | undefined,
  provider: PullRequestProvider = 'github',
): string | null {
  if (host == null) return DEFAULT_HOSTS[provider];
  const value = host.trim().toLowerCase();
  if (value.length > 253 || !HOST.test(value)) return null;
  const [name, port] = value.split(':');
  const number = port == null ? null : Number(port);
  if (number != null && (number < 1 || number > 65535)) return null;
  /** A URL drops the https default port, so a page on `host:443` compares as `host`. */
  const normalized = number == null || number === 443 ? name : `${name}:${number}`;
  if (provider === 'bitbucket' && normalized !== DEFAULT_HOSTS.bitbucket) return null;
  return normalized;
}

/** The configured token reference, else the first fallback variable that is set. */
export function resolvePullRequestToken(
  reference: string | undefined,
  env: Env,
  provider: PullRequestProvider = 'github',
): string | null {
  if (reference != null) return resolveTokenReference(reference, env);
  for (const name of TOKEN_ENV_FALLBACKS[provider]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** A user connection the operator configured: the app users authorize, on the configured host. */
export type PullRequestOAuthConfig = {
  provider: PullRequestProvider;
  host: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  flowTimeoutMinutes?: number;
  requestTimeoutSeconds?: number;
  retentionDays?: number;
};

/**
 * The OAuth app users connect their accounts through, or `null` when none is configured or its
 * references do not resolve, in which case users cannot connect and only the server token is used.
 */
export function resolvePullRequestOAuth(
  settings: Partial<PullRequestSettings> | null | undefined,
  env: Env,
): PullRequestOAuthConfig | null {
  const oauth = settings?.oauth;
  if (oauth == null) return null;
  const provider = resolvePullRequestProvider(settings?.provider);
  if (provider == null) return null;
  const host = resolvePullRequestHost(settings?.host, provider);
  const clientId = resolveTokenReference(oauth.clientId, env);
  const clientSecret = resolveTokenReference(oauth.clientSecret, env);
  if (host == null || clientId == null || clientSecret == null) return null;
  const scope = oauth.scope?.trim();
  const { flowTimeoutMinutes, requestTimeoutSeconds, retentionDays } = oauth;
  return {
    provider,
    host,
    clientId,
    clientSecret,
    ...(scope ? { scope } : {}),
    ...(flowTimeoutMinutes != null ? { flowTimeoutMinutes } : {}),
    ...(requestTimeoutSeconds != null ? { requestTimeoutSeconds } : {}),
    ...(retentionDays != null ? { retentionDays } : {}),
  };
}

/**
 * Whether pull requests can do anything on this deployment. The feature is on unless an
 * administrator turns it off, and it stays dormant, advertising nothing and recording nothing,
 * until there is both a token to read with and a scope of repositories to read: either a list, or
 * the explicit opt-in to every repository the token can see.
 */
export function isPullRequestFeatureActive(
  settings: Partial<PullRequestSettings> | null | undefined,
  env: Env,
): boolean {
  if (settings?.enabled === false) return false;
  const provider = resolvePullRequestProvider(settings?.provider);
  if (provider == null || resolvePullRequestHost(settings?.host, provider) == null) return false;
  /** Users who connect their own account need no repository list: their token sees only what
   *  they can already see. */
  if (resolvePullRequestOAuth(settings, env) != null) return true;
  if (settings?.token == null && resolvePullRequestToken(undefined, env, provider) == null) {
    return false;
  }
  return (
    settings?.allowAllRepositories === true || (settings?.allowedRepositories?.length ?? 0) > 0
  );
}

/**
 * What a lane recorder needs from the settings: whether to record at all, and the host whose pull
 * request links it keeps.
 */
export function resolvePullRequestRecording(
  settings: Partial<PullRequestSettings> | null | undefined,
  env: Env,
): { enabled: boolean; host?: string } {
  const enabled = isPullRequestFeatureActive(settings, env);
  const provider = resolvePullRequestProvider(settings?.provider);
  const host =
    enabled && provider != null ? resolvePullRequestHost(settings?.host, provider) : null;
  return host != null ? { enabled, host } : { enabled };
}
