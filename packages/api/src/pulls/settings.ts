import type { TAgentsEndpoint } from 'librechat-data-provider';

export type PullRequestSettings = NonNullable<TAgentsEndpoint['pullRequests']>;

const TOKEN_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Tried in order when `token` is not configured, so a deployment that already holds a GitHub token
 * for something else gets pull requests without more setup. A token named in the config always
 * wins, and one that does not resolve is reported instead of silently replaced.
 */
const TOKEN_ENV_FALLBACKS = ['GITHUB_PULL_REQUEST_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Resolves `${NAME}` against the environment; the config never holds the token itself. */
export function resolveTokenReference(reference: string | undefined, env: Env): string | null {
  const name = reference == null ? undefined : TOKEN_REFERENCE.exec(reference)?.[1];
  if (name == null) return null;
  return env[name]?.trim() || null;
}

/** The configured token reference, else the first fallback variable that is set. */
export function resolvePullRequestToken(reference: string | undefined, env: Env): string | null {
  if (reference != null) return resolveTokenReference(reference, env);
  for (const name of TOKEN_ENV_FALLBACKS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
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
  if (settings?.token == null && resolvePullRequestToken(undefined, env) == null) return false;
  return (
    settings?.allowAllRepositories === true || (settings?.allowedRepositories?.length ?? 0) > 0
  );
}
