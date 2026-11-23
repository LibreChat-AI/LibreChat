import { useCallback } from 'react';
import axios from 'axios';
import { useToastContext } from '@librechat/client';
import { CREDENTIAL_RETIREMENT_INCOMPLETE_CODE } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';

/** The change committed, but not every earlier session could be signed out. */
export function isCredentialRetirementIncomplete(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    (error.response?.data as { code?: string } | undefined)?.code ===
      CREDENTIAL_RETIREMENT_INCOMPLETE_CODE
  );
}

export function getTwoFactorError(
  error: unknown,
  fallback: TranslationKeys,
): {
  key: TranslationKeys;
  seconds?: number;
} {
  if (!axios.isAxiosError(error) || error.response?.status !== 429) {
    return { key: fallback };
  }
  // Recognize status alone too, for compatibility with an older server during rollout.
  const raw = error.response.headers?.['retry-after'];
  const seconds = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 300) {
    return { key: 'com_ui_2fa_rate_limited_retry', seconds: Math.ceil(seconds) };
  }
  return { key: 'com_ui_2fa_rate_limited' };
}

export function useTwoFactorError() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  return useCallback(
    (error: unknown, fallback: TranslationKeys) => {
      const { key, seconds } = getTwoFactorError(error, fallback);
      showToast({ message: localize(key, { seconds }), status: 'error' });
    },
    [localize, showToast],
  );
}
