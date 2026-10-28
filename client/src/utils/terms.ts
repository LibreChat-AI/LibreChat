import { QueryKeys, TERMS_NOT_ACCEPTED_CODE } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';

/** Reads the stable code from a flat `{ code }` or a nested `{ error: { code } }` response body. */
export function hasTermsRefusal(data: unknown): boolean {
  if (data == null || typeof data !== 'object') {
    return false;
  }
  const { code, error } = data as { code?: unknown; error?: { code?: unknown } };
  return code === TERMS_NOT_ACCEPTED_CODE || error?.code === TERMS_NOT_ACCEPTED_CODE;
}

/**
 * Terms were reset or enabled mid-session: refetching the startup config and the terms status
 * activates the acceptance query, which reopens the modal. Returns whether `data` was a refusal.
 */
export function reopenTermsOnRefusal(queryClient: QueryClient, data: unknown): boolean {
  if (!hasTermsRefusal(data)) {
    return false;
  }
  void queryClient.invalidateQueries([QueryKeys.startupConfig]);
  void queryClient.invalidateQueries([QueryKeys.userTerms]);
  return true;
}
