import React, { useEffect } from 'react';
import { CircleX } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { discordOAuthErrorCodeSchema } from 'librechat-data-provider';
import { announceOAuthSettled } from '~/data-provider';
import { discordCallbackLabels } from './discord';
import { useLocalize } from '~/hooks';
import Shell from './Shell';

export default function OAuthError() {
  const localize = useLocalize();
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error') || 'unknown_error';
  const flowId = searchParams.get('flow') ?? undefined;
  const discordCode = discordOAuthErrorCodeSchema.safeParse(error);
  const errorCode = discordCode.success ? discordCode.data : undefined;

  useEffect(() => {
    /** Ends the watch on this sign-in in the window that started it, which no longer polls. */
    announceOAuthSettled({ outcome: 'failed', flowId, ...(errorCode ? { errorCode } : {}) });
  }, [flowId, errorCode]);

  const getErrorMessage = (error: string): string => {
    if (errorCode) return localize(discordCallbackLabels[errorCode]);
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
