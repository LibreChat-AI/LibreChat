import { getResponseStatus } from '~/utils/errors';

/** Retry transport and server failures, never an authorization or resource decision. */
export function retryTransientQuery(failureCount: number, error: unknown): boolean {
  const status = getResponseStatus(error);
  return failureCount < 2 && (status == null || status >= 500);
}
