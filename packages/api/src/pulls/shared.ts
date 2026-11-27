/** Defaults for the operator bounds in `endpoints.agents.pullRequests`, shared by every provider. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CANDIDATE_PULL_REQUESTS = 10;
export const DEFAULT_MAX_HEAD_COMPARISONS = 3;
export const DEFAULT_MAX_CANDIDATE_PAGES = 1;

export const COMMIT_ID: RegExp = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const MAX_TITLE_LENGTH = 256;

/** The only part of `fetch` the sources call, so any compatible client can be injected. */
export type PullRequestFetch = (input: string, init?: RequestInit) => Promise<Response>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

export const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `.` and `..` match the path character class but would rewrite an API path. */
export const isPathSegment = (value: string): boolean => value !== '.' && value !== '..';

/** The URL ends up in an href, so only a plain https page on the configured host is accepted. */
export function isPageUrl(value: unknown, host: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === host;
  } catch {
    return false;
  }
}

/** How long a provider asked callers to wait: `retry-after` seconds, else a reset time in epoch
 *  seconds from the named header. */
export function retryAfterMs(response: Response, resetHeader: string): number | undefined {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (response.headers.get('retry-after') != null && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter * 1000);
  }
  const reset = Number(response.headers.get(resetHeader));
  if (response.headers.get(resetHeader) != null && Number.isFinite(reset)) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return undefined;
}
