import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { announceOAuthSettled } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function OAuthSuccess() {
  const localize = useLocalize();
  const [searchParams] = useSearchParams();
  const [secondsLeft, setSecondsLeft] = useState(3);
  const serverName = searchParams.get('serverName');
  const flowId = searchParams.get('flow') ?? undefined;

  useEffect(() => {
    /** Reaches the window that started the sign-in even when the provider severed the popup. */
    announceOAuthSettled({ outcome: 'succeeded', flowId });
  }, [flowId]);

  useEffect(() => {
    const countdown = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(countdown);
          window.close();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdown);
  }, []);

  return (
    <div className="bg-surface-secondary flex min-h-screen items-center justify-center p-8">
      <div className="bg-surface-primary w-full max-w-md rounded-xl p-8 text-center shadow-lg">
        <h1 className="text-text-primary mb-4 text-3xl font-bold">
          {localize('com_ui_oauth_success_title') || 'Authentication Successful'}
        </h1>
        <p className="text-text-secondary mb-2 text-sm">
          {localize('com_ui_oauth_success_description') ||
            'Your authentication was successful. This window will close in'}{' '}
          <span className="text-accent-primary font-medium">{secondsLeft}</span>{' '}
          {localize('com_ui_seconds') || 'seconds'}.
        </p>
        {serverName && (
          <p className="text-text-tertiary mt-4 text-xs">
            {localize('com_ui_oauth_connected_to') || 'Connected to'}:{' '}
            <span className="font-medium">{serverName}</span>
          </p>
        )}
      </div>
    </div>
  );
}
