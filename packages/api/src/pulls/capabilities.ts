import { EModelEndpoint, PULL_REQUEST_BATCH_VERSION } from 'librechat-data-provider';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { isPullRequestFeatureActive } from './settings';

export type PullRequestCapabilities = {
  pullRequestsEnabled: boolean;
  /** Present only with the feature on, so a client never sees a version without the flag. */
  pullRequestsBatchVersion?: typeof PULL_REQUEST_BATCH_VERSION;
  /** The lookups one batch runs at once, so a client that falls back to the single route can
   *  keep to the same limit while a replica without the batch route is still serving it. */
  pullRequestsMaxConcurrentLookups?: number;
};

/**
 * What the startup config tells a client about pull requests: whether the deployment turned the
 * feature on (by default whenever a token and a repository scope exist), and which version of the batch route this server serves, so the
 * sidebar asks only a server that has it.
 */
export function resolvePullRequestCapabilities(
  appConfig: Pick<AppConfig, 'endpoints'> | null | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): PullRequestCapabilities {
  const agents = appConfig?.endpoints?.[EModelEndpoint.agents] as TAgentsEndpoint | undefined;
  const enabled = isPullRequestFeatureActive(agents?.pullRequests, env);
  return {
    pullRequestsEnabled: enabled,
    ...(enabled
      ? {
          pullRequestsBatchVersion: PULL_REQUEST_BATCH_VERSION,
          pullRequestsMaxConcurrentLookups: agents?.pullRequests?.maxConcurrentLookups ?? 4,
        }
      : {}),
  };
}
