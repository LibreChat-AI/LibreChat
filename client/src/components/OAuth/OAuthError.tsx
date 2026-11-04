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
