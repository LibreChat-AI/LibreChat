import React, { useEffect } from 'react';
import { Button } from '@librechat/client';
import { useSearchParams } from 'react-router-dom';
import { announceOAuthSettled } from '~/data-provider';
import { useLocalize } from '~/hooks';

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
        return (
          localize('com_ui_oauth_error_missing_code') ||
          'Authorization code is missing. Please try again.'
        );
      case 'missing_state':
        return (
          localize('com_ui_oauth_error_missing_state') ||
          'State parameter is missing. Please try again.'
        );
      case 'invalid_state':
        return (
          localize('com_ui_oauth_error_invalid_state') ||
          'Invalid state parameter. Please try again.'
        );
      case 'callback_failed':
        return (
          localize('com_ui_oauth_error_callback_failed') ||
          'Authentication callback failed. Please try again.'
        );
      default:
        return localize('com_ui_oauth_error_generic') || error.replace(/_/g, ' ');
    }
  };

  return (
    <div className="bg-surface-secondary flex min-h-screen items-center justify-center p-8">
      <div className="bg-surface-primary w-full max-w-md rounded-lg p-8 text-center shadow-lg">
        <div className="mb-4 flex justify-center">
          <div className="bg-status-error-subtle flex h-12 w-12 items-center justify-center rounded-full">
            <svg
              className="text-status-error h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
        </div>
        <h1 className="text-text-primary mb-4 text-3xl font-bold">
          {localize('com_ui_oauth_error_title') || 'Authentication Failed'}
        </h1>
        <p className="text-text-secondary mb-6 text-sm">{getErrorMessage(error)}</p>
        <Button
          variant="default"
          onClick={() => window.close()}
          aria-label={localize('com_ui_close_window')}
        >
          {localize('com_ui_close_window')}
        </Button>
      </div>
    </div>
  );
}
