import { Agent } from 'undici';
import { isIP } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport';
import type { Dispatcher } from 'undici';
import { createSSRFSafeUndiciConnect, isOAuthUrlAllowed, isSSRFTarget } from '~/auth';
import { getOAuthUrlPort } from './url';

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: Dispatcher;
};

const MAX_OAUTH_DISPATCHERS = 64;
const oauthDispatchers = new Map<string, Agent>();

function shouldBypassSSRFDispatcher(url: string | URL, allowedDomains?: string[] | null): boolean {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return false;
  }

  return isOAuthUrlAllowed(url.toString(), allowedDomains, null);
}

function getDispatcherCacheKey(port: string, allowedAddresses?: string[] | null): string {
  const normalizedAddresses = Array.isArray(allowedAddresses)
    ? [...new Set(allowedAddresses)].sort().join('\n')
    : '';
  return `${port}\0${normalizedAddresses}`;
}

function evictOldestDispatcher(): void {
  const oldestKey = oauthDispatchers.keys().next().value as string | undefined;
  if (!oldestKey) {
    return;
  }

  const dispatcher = oauthDispatchers.get(oldestKey);
  oauthDispatchers.delete(oldestKey);
  dispatcher?.destroy();
}

function getOAuthDispatcher(
  url: string | URL,
  allowedDomains?: string[] | null,
  allowedAddresses?: string[] | null,
): Agent | undefined {
  if (shouldBypassSSRFDispatcher(url, allowedDomains)) {
    return undefined;
  }

  const parsedUrl = url instanceof URL ? url : new URL(url);
  const port = getOAuthUrlPort(parsedUrl);
  const effectiveAddresses =
    Array.isArray(allowedDomains) && allowedDomains.length > 0 ? null : allowedAddresses;
  const literalHost = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literalHost) && isSSRFTarget(literalHost, effectiveAddresses, port)) {
    throw new Error('OAuth endpoint targets a blocked address');
  }
  const cacheKey = getDispatcherCacheKey(port, effectiveAddresses);
  const cached = oauthDispatchers.get(cacheKey);
  if (cached) {
    oauthDispatchers.delete(cacheKey);
    oauthDispatchers.set(cacheKey, cached);
    return cached;
  }

  if (oauthDispatchers.size >= MAX_OAUTH_DISPATCHERS) {
    evictOldestDispatcher();
  }

  const dispatcher = new Agent({
    connect: createSSRFSafeUndiciConnect(effectiveAddresses, port),
  });
  oauthDispatchers.set(cacheKey, dispatcher);
  return dispatcher;
}

export function createHardenedOAuthFetch({
  allowedDomains,
  allowedAddresses,
}: {
  allowedDomains?: string[] | null;
  allowedAddresses?: string[] | null;
} = {}): FetchLike {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const dispatcher = getOAuthDispatcher(url, allowedDomains, allowedAddresses);
    const fetchInit: FetchInitWithDispatcher =
      dispatcher != null
        ? { ...init, dispatcher, redirect: 'error' }
        : { ...init, redirect: 'error' };
    return fetch(url, fetchInit);
  };
}

export function resetHardenedOAuthFetchDispatchers(): void {
  for (const dispatcher of oauthDispatchers.values()) {
    dispatcher.destroy();
  }
  oauthDispatchers.clear();
}
