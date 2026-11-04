import { isAxiosError } from 'axios';
import type { TranslationKeys } from '~/hooks';

/** Show only supported setup codes; remote error text and serialized requests stay private. */
export function channelErrorLabel(
  error: unknown,
  fallback: TranslationKeys = 'com_ui_channels_action_error',
): TranslationKeys {
  const failure = isAxiosError<{ error?: unknown }>(error)
    ? error.response?.data?.error
    : undefined;
  const code =
    typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : failure;
  const unavailable =
    code === 'transactions_unavailable' ||
    (error instanceof Error && 'code' in error && error.code === 'transactions_unavailable');
  return unavailable ? 'com_ui_channels_transaction_required' : fallback;
}
