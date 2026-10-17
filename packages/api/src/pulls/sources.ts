import type { PullRequestProvider } from 'librechat-data-provider';
import type { PullRequestFetch } from './shared';
import type { PullRequestSource } from './types';
import { createBitbucketPullRequestSource } from './bitbucket';
import { createGitHubPullRequestSource } from './github';
import { createGitLabPullRequestSource } from './gitlab';
import { PullRequestSourceError } from './types';

/**
 * One source per provider behind the single interface the lookup uses, so the lookup and its cache
 * stay unaware of providers. A provider this server has no source for cannot be served, which is
 * reported as not configured rather than answered as "no pull request".
 */
export function routePullRequestSources(
  sources: Partial<Record<PullRequestProvider, PullRequestSource>>,
): PullRequestSource {
  return {
    find(input) {
      const source = sources[input.provider ?? 'github'];
      if (source == null) return Promise.reject(new PullRequestSourceError('NOT_CONFIGURED'));
      return source.find(input);
    },
  };
}

/** Every provider this server can look up, all through the deployment's HTTP client. */
export function createPullRequestSource({
  fetchFn,
}: {
  fetchFn: PullRequestFetch;
}): PullRequestSource {
  return routePullRequestSources({
    github: createGitHubPullRequestSource({ fetchFn }),
    gitlab: createGitLabPullRequestSource({ fetchFn }),
    bitbucket: createBitbucketPullRequestSource({ fetchFn }),
  });
}
