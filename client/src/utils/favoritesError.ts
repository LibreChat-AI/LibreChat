import type { TranslationKeys } from '~/hooks';

type LocalizeFn = (key: TranslationKeys, options?: Record<string, string>) => string;

interface ApiErrorShape {
  response?: { data?: { code?: string; limit?: number } };
}

const isApiError = (error: unknown): error is ApiErrorShape =>
  typeof error === 'object' && error !== null && 'response' in error;

/**
 * Builds a localized error message from an axios-shaped favorites mutation
 * rejection. Recognizes the `MAX_*_EXCEEDED` codes the backend emits and falls
 * back to the generic error string otherwise. `messageKey` lets callers pick
 * wording that fits their surface (pinned items vs. starred marketplace items).
 */
export function getFavoritesErrorMessage(
  error: unknown,
  localize: LocalizeFn,
  defaultLimit: number,
  messageKey: TranslationKeys = 'com_ui_max_favorites_reached',
): string {
  if (isApiError(error)) {
    const { code, limit } = error.response?.data ?? {};
    if (code === 'MAX_FAVORITES_EXCEEDED' || code === 'MAX_SKILL_FAVORITES_EXCEEDED') {
      return localize(messageKey, {
        0: String(limit ?? defaultLimit),
      });
    }
  }
  return localize('com_ui_error');
}
