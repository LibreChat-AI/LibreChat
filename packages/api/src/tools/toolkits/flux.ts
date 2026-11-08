export interface FluxResultRequest {
  url: string;
  params?: { id: string };
}

const BFL_DOMAIN = 'bfl.ai';

function isBflHost(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    (url.hostname === BFL_DOMAIN || url.hostname.endsWith(`.${BFL_DOMAIN}`))
  );
}

function isTrustedPollingUrl(pollingUrl: URL, baseUrl: URL): boolean {
  if (pollingUrl.origin === baseUrl.origin) {
    return true;
  }
  return isBflHost(baseUrl) && isBflHost(pollingUrl);
}

/**
 * Resolves where to poll for a BFL task result. The global and regional endpoints route
 * tasks to other clusters and return the cluster's `polling_url`, so it is preferred.
 * The API key travels with the poll, so a `polling_url` is only followed when it shares the
 * base URL's origin, or when both are BFL clusters over https; otherwise the legacy
 * `/v1/get_result` endpoint on the base URL is used.
 */
export function resolveFluxResultRequest(
  baseUrl: string,
  taskId: string,
  pollingUrl?: unknown,
): FluxResultRequest {
  const fallback: FluxResultRequest = {
    url: `${baseUrl.replace(/\/+$/, '')}/v1/get_result`,
    params: { id: taskId },
  };
  if (typeof pollingUrl !== 'string' || !pollingUrl) {
    return fallback;
  }
  try {
    const polling = new URL(pollingUrl);
    if (!isTrustedPollingUrl(polling, new URL(baseUrl))) {
      return fallback;
    }
    return { url: polling.toString() };
  } catch {
    return fallback;
  }
}
