import { Suspense } from 'react';
import { cn, Alert, DelayedRender, useLocalize } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useMessagePartsHost } from '../../react/host';
import { useOnline } from '../../react/errors';
import Container from '../parts/Container';
import EmptyText from '../EmptyText';
import ErrorText from './ErrorText';

/** The text a client persists for a turn whose stream never reached the server. */
export const ERROR_CONNECTION_TEXT = 'Error connecting to server, try refreshing the page.';
const DELAYED_ERROR_TIMEOUT = 5500;

const LoadingFallback = () => (
  <div className="mb-2.5">
    <EmptyText underHeaderIcon />
  </div>
);

/** The box an error is stated in: an assertive live region on the error surface. */
export function ErrorBox({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'border-status-error-border bg-status-error-subtle text-text-secondary rounded-xl border p-3 text-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

function ConnectionError({ message }: { message?: TMessage }): ReactNode {
  const localize = useLocalize();
  const online = useOnline();

  return (
    <Suspense fallback={<LoadingFallback />}>
      <DelayedRender delay={DELAYED_ERROR_TIMEOUT}>
        <Container message={message}>
          {/* The quiet variant: this card sits in the transcript beside `ErrorBox`, and every
              other failure there states itself in the ordinary copy color. */}
          <Alert variant="error-quiet" icon={false} elevation="raised" className="mt-2">
            {localize(online ? 'com_ui_error_connection' : 'com_ui_error_offline')}
          </Alert>
        </Container>
      </DelayedRender>
    </Suspense>
  );
}

/**
 * A failed turn as the transcript shows it: the error's own card, and under it whatever the host
 * offers a reader to do about it (`renderErrorActions`). A turn that never reached the server
 * waits a moment before saying so, since a reconnect usually follows.
 */
export default function ErrorMessage({
  text,
  message,
  className = '',
}: {
  text: string;
  message?: TMessage;
  className?: string;
}): ReactNode {
  const { renderErrorActions } = useMessagePartsHost();
  if (text === ERROR_CONNECTION_TEXT) {
    return <ConnectionError message={message} />;
  }

  return (
    <Container message={message}>
      <ErrorBox className={className}>
        <ErrorText text={text} message={message} />
        {renderErrorActions?.({ text, messageId: message?.messageId })}
      </ErrorBox>
    </Container>
  );
}
