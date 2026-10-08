import type { Dispatcher } from 'undici';
import type { PullRequestFetch } from './github';
import { getEnvProxyDispatcher } from '~/utils/proxy';

/**
 * Wraps a fetch so every request goes through the deployment's proxy when one is configured
 * (`HTTPS_PROXY` and friends, honoring `NO_PROXY`), and goes direct when none is. The dispatcher is
 * resolved per request, so an environment that changes at runtime is respected, and the client and
 * the dispatcher are both arguments, so a caller or a test supplies its own.
 */
export function createProxyAwareFetch(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  getDispatcher: () => Dispatcher | undefined = getEnvProxyDispatcher,
): PullRequestFetch {
  return (input, init) => {
    const dispatcher = getDispatcher();
    if (dispatcher == null) return fetchFn(input, init);
    const request: RequestInit & { dispatcher?: Dispatcher } = { ...init, dispatcher };
    return fetchFn(input, request);
  };
}
