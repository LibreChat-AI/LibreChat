import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { AppConfig } from './github/app';
import type { Limits } from './catalog';
import { resolvePullRequestHost, resolveTokenReference } from '~/pulls/settings';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '~/pulls/shared';
import { LIMITS } from './catalog';

export type EventConfig = NonNullable<TAgentsEndpoint['events']>;

type Env = Readonly<Record<string, string | undefined>>;

/** How long an answer about an account's write access is reused when none is set: 5 minutes. */
export const ACCESS_TTL_MS = 300_000;

/** The GitHub App's resolved credentials. Never log or return `app.key` or `secret`. */
export interface GitHubSettings {
  app: AppConfig;
  /** The app's webhook secret, which `github.verify` checks deliveries against. */
  secret: string;
  /** How long an answer about an account's write access is reused; 0 asks every time. */
  accessTtlMs: number;
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
  // Only binding needs the OAuth client, so deliveries are verified without it.
  const clientId = config.clientId == null ? null : resolveTokenReference(config.clientId, env);
  const clientSecret =
    config.clientSecret == null ? null : resolveTokenReference(config.clientSecret, env);
  const client = clientId && clientSecret ? { id: clientId, secret: clientSecret } : undefined;
  const accessTtlMs =
    config.accessTtlSeconds == null ? ACCESS_TTL_MS : config.accessTtlSeconds * 1000;
  return {
    app: { id, key: pem(key), host, timeoutMs, ...(client && { client }) },
    secret,
    accessTtlMs,
  };
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

/** How a subscription's runs are bounded and kept. */
export interface RunSettings {
  /** Runs per clock hour for a subscription whose owner set no cap. */
  perHour: number;
  /** The most runs per hour any subscription may start. */
  maxPerHour: number;
  /** Runs in a row that may fail before the subscription is turned off; 0 never. */
  failures: number;
  /** How long a run may stay active with no live generation before it is ended. */
  staleMs: number;
}

export const RUN_DEFAULTS: RunSettings = {
  perHour: 20,
  maxPerHour: 100,
  failures: 5,
  staleMs: 30 * 60_000,
};

/** The run bounds `endpoints.agents.events.runs` sets, each default where it sets none. */
export function runSettings(config: Partial<EventConfig> | null | undefined): RunSettings {
  const runs = config?.runs;
  const maxPerHour = runs?.maxPerHour ?? RUN_DEFAULTS.maxPerHour;
  return {
    perHour: Math.min(runs?.perHour ?? RUN_DEFAULTS.perHour, maxPerHour),
    maxPerHour,
    failures: runs?.failures ?? RUN_DEFAULTS.failures,
    staleMs: runs?.staleMinutes != null ? runs.staleMinutes * 60_000 : RUN_DEFAULTS.staleMs,
  };
}
