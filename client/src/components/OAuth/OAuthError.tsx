import React, { useEffect } from 'react';
import { CircleX } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { announceOAuthSettled } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Shell from './Shell';

export default function OAuthError() {
  const localize = useLocalize();
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error') || 'unknown_error';
  const flowId = searchParams.get('flow') ?? undefined;

  useEffect(() => {
    /** Ends the watch on this sign-in in the window that started it, which no longer polls. */
    announceOAuthSettled({ outcome: 'failed', flowId });
  }, [flowId]);

  const getErrorMessage = (error: string): string => {
    switch (error) {
      case 'slack_transactions_unavailable':
        return localize('com_ui_channels_transaction_required');
      case 'slack_workspace_in_use':
        return localize('com_ui_slack_workspaces_in_use');
      case 'slack_forbidden':
        return localize('com_ui_slack_workspaces_admin');
      case 'slack_unsupported_installation':
        return localize('com_ui_slack_workspaces_unsupported');
      case 'slack_missing_scopes':
        return localize('com_ui_slack_workspaces_scopes');
      case 'slack_workspace_changed':
        return localize('com_ui_slack_workspaces_changed');
      case 'slack_stale_install':
      case 'slack_invalid_install':
        return localize('com_ui_slack_workspaces_restart');
      case 'discord_forbidden':
        return localize('com_ui_discord_admin');
      case 'discord_not_configured':
        return localize('com_ui_discord_disabled');
      case 'discord_invalid_state':
      case 'discord_invalid_input':
      case 'discord_invalid_grant':
        return localize('com_ui_discord_oauth_restart');
      case 'discord_application_changed':
      case 'discord_installation_changed':
        return localize('com_ui_discord_oauth_changed');
      case 'discord_guild_changed':
        return localize('com_ui_discord_guild_changed');
      case 'discord_missing_permissions':
        return localize('com_ui_discord_permissions');
      case 'discord_unsupported_installation':
        return localize('com_ui_discord_code_grant');
      case 'discord_provider_refused':
        return localize('com_ui_discord_oauth_refused');
      case 'discord_rate_limited':
        return localize('com_ui_discord_rate_limited');
      case 'discord_provider_unavailable':
      case 'discord_timeout':
        return localize('com_ui_discord_provider_unavailable');
      case 'missing_code':
        return localize('com_ui_oauth_error_missing_code');
      case 'missing_state':
        return localize('com_ui_oauth_error_missing_state');
      case 'invalid_state':
        return localize('com_ui_oauth_error_invalid_state');
      case 'callback_failed':
        return localize('com_ui_oauth_error_callback_failed');
      default:
        return localize('com_ui_oauth_error_generic');
    }
  };

  return (
    <Shell icon={CircleX} tone="error" title={localize('com_ui_oauth_error_title')}>
      <p className="text-text-secondary text-sm">{getErrorMessage(error)}</p>
    </Shell>
  );
}
