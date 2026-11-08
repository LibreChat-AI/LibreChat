import { isIP } from 'net';

export interface FluxResultRequest {
  url: string;
  params?: { id: string };
}

/** Last two hostname labels (`api.eu2.bfl.ai` -> `bfl.ai`), or the full host for IPs and single labels. */
function getSiteDomain(hostname: string): string {
  if (isIP(hostname) || !hostname.includes('.')) {
    return hostname;
  }
  return hostname.split('.').slice(-2).join('.');
}

function isTrustedPollingUrl(pollingUrl: URL, baseUrl: URL): boolean {
  if (pollingUrl.protocol !== baseUrl.protocol) {
    return false;
  }
  if (pollingUrl.hostname === baseUrl.hostname) {
    return true;
  }
  const domain = getSiteDomain(baseUrl.hostname);
  if (domain === baseUrl.hostname) {
    return false;
  }
  return pollingUrl.hostname.endsWith(`.${domain}`);
}

/**
 * Resolves where to poll for a BFL task result. The global and regional endpoints route
 * tasks to other clusters and return the cluster's `polling_url`, so it is preferred.
 * The API key travels with the poll, so a `polling_url` is only followed when it shares the
 * base URL's protocol and site domain; otherwise the legacy `/v1/get_result` endpoint is used.
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
