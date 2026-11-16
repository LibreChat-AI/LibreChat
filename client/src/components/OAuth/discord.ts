import type { DiscordOAuthErrorCode } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/**
 * The remedy for each callback failure the Discord redirect may carry. The landing page and the
 * dialog that started the authorization share it; the management error map words some of these
 * differently on purpose and is not used here.
 */
export const discordCallbackLabels: Record<DiscordOAuthErrorCode, TranslationKeys> = {
  discord_forbidden: 'com_ui_discord_admin',
  discord_not_configured: 'com_ui_discord_disabled',
  discord_invalid_state: 'com_ui_discord_oauth_restart',
  discord_invalid_input: 'com_ui_discord_oauth_restart',
  discord_invalid_grant: 'com_ui_discord_oauth_restart',
  discord_application_changed: 'com_ui_discord_oauth_changed',
  discord_installation_changed: 'com_ui_discord_oauth_changed',
  discord_guild_changed: 'com_ui_discord_guild_changed',
  discord_missing_permissions: 'com_ui_discord_permissions',
  discord_unsupported_installation: 'com_ui_discord_code_grant',
  discord_provider_refused: 'com_ui_discord_oauth_refused',
  discord_rate_limited: 'com_ui_discord_rate_limited',
  discord_provider_unavailable: 'com_ui_discord_provider_unavailable',
  discord_timeout: 'com_ui_discord_provider_unavailable',
  discord_transactions_unavailable: 'com_ui_channels_transaction_required',
};
