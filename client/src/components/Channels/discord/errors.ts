import type { TranslationKeys } from '~/hooks';

/** Safe codes only; error messages are never shown, and unknown codes stay unconfirmed. */
export function errorLabel(error: unknown): TranslationKeys {
  if (!(error instanceof Error)) return 'com_ui_discord_error';
  if ('status' in error && error.status === 403) return 'com_ui_discord_admin';
  if ('status' in error && error.status === 404) return 'com_ui_discord_disabled';
  if (!('code' in error)) return 'com_ui_discord_error';
  switch (error.code) {
    case 'transactions_unavailable':
      return 'com_ui_channels_transaction_required';
    case 'application_changed':
    case 'installation_changed':
      return 'com_ui_discord_changed';
    case 'provider_refused':
      return 'com_ui_discord_refused';
    case 'unsupported_installation':
      return 'com_ui_discord_code_grant';
    case 'application_in_use':
      return 'com_ui_discord_in_use';
    case 'rate_limited':
      return 'com_ui_discord_rate_limited';
    case 'provider_unavailable':
      return 'com_ui_discord_provider_unavailable';
    case 'timeout':
      return 'com_ui_discord_timeout';
    default:
      return 'com_ui_discord_error';
  }
}
