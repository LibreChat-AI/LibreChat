import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { AppConfig } from './github/app';
import type { Limits } from './catalog';
import { resolvePullRequestHost, resolveTokenReference } from '~/pulls/settings';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '~/pulls/shared';
import { LIMITS } from './catalog';

export type EventConfig = NonNullable<TAgentsEndpoint['events']>;

type Env = Readonly<Record<string, string | undefined>>;

/** The GitHub App's resolved credentials. Never log or return either field. */
export interface GitHubSettings {
  app: AppConfig;
  /** The app's webhook secret, which `github.verify` checks deliveries against. */
  secret: string;
}

export interface EventSettings {
  limits: Limits;
  /** `null` when no app is configured, a reference does not resolve, or the host is not one. */
  github: GitHubSettings | null;
}

/** A PEM kept on one line in an environment variable writes its line breaks as `\n`. */
function pem(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function resolveGitHub(config: EventConfig['github'], env: Env): GitHubSettings | null {
  if (config == null) {
    return null;
  }
  const id = resolveTokenReference(config.appId, env);
  const key = resolveTokenReference(config.privateKey, env);
  const secret = resolveTokenReference(config.webhookSecret, env);
  const host = resolvePullRequestHost(config.host, 'github');
  if (id == null || key == null || secret == null || host == null) {
    return null;
  }
  const timeoutMs =
    config.requestTimeoutSeconds == null
      ? DEFAULT_REQUEST_TIMEOUT_MS
      : config.requestTimeoutSeconds * 1000;
  return { app: { id, key: pem(key), host, timeoutMs }, secret };
}

/**
 * What `endpoints.agents.events` resolves to against the environment, or `null` while events
 * are off, which they are unless `enabled` is true. The config holds only the names of the
 * variables; the values are read here and go no further than the returned object.
 */
export function eventSettings(
  config: Partial<EventConfig> | null | undefined,
  env: Env,
): EventSettings | null {
  if (config?.enabled !== true) {
    return null;
  }
  return {
    limits: {
      excerpt: config.limits?.excerpt ?? LIMITS.excerpt,
      fanout: config.limits?.fanout ?? LIMITS.fanout,
    },
    github: resolveGitHub(config.github, env),
  };
}
