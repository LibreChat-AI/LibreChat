import React, { useEffect, useState } from 'react';
import { Chip } from '@librechat/client';
import { CircleCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { announceOAuthSettled } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Shell from './Shell';

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
    <Shell icon={CircleCheck} tone="success" title={localize('com_ui_oauth_success_title')}>
      {serverName && (
        <Chip tone="surface" className="mb-3">
          {localize('com_ui_oauth_connected_to')}{' '}
          <span className="text-text-primary">{serverName}</span>
        </Chip>
      )}
      <p className="text-text-secondary text-sm">
        {localize('com_ui_oauth_success_description')}{' '}
        <span className="text-text-primary font-medium tabular-nums">{secondsLeft}</span>{' '}
        {localize('com_ui_seconds')}.
      </p>
    </Shell>
  );
}
