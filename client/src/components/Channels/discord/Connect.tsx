import { Alert, Button, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
import type { DiscordOAuthErrorCode } from 'librechat-data-provider';
import { discordCallbackLabels } from '~/components/OAuth/discord';
import { useLocalize } from '~/hooks';
import { errorLabel } from './errors';

type Flow = 'pending' | 'cancelling' | 'failed';

/** Blocks the dialog while the Discord authorization runs in its own window. */
export default function Connect({
  flow,
  reason,
  error,
  busy,
  retryable,
  alertRef,
  errorRef,
  onCancel,
  onRetry,
  onRefresh,
}: {
  flow: Flow | null;
  reason: DiscordOAuthErrorCode | null;
  error: unknown;
  busy: boolean;
  retryable: boolean;
  alertRef: (node: HTMLDivElement | null) => void;
  errorRef: (node: HTMLDivElement | null) => void;
  onCancel: () => void;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const localize = useLocalize();
  return (
    <OGDialog open={flow !== null} onOpenChange={() => {}}>
      <OGDialogTemplate
        className="max-w-md"
        title={localize(
          flow === 'failed' ? 'com_ui_discord_connection_failed' : 'com_ui_discord_connecting',
        )}
        showCloseButton={false}
        showCancelButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        main={
          flow === 'failed' ? (
            <div className="space-y-3">
              {Boolean(error) && (
                <Alert ref={errorRef} tabIndex={-1} variant="error">
                  {localize(errorLabel(error))}
                  <Button type="button" variant="outline" disabled={busy} onClick={onRefresh}>
                    {localize('com_ui_refresh')}
                  </Button>
                </Alert>
              )}
              <Alert ref={alertRef} tabIndex={-1} variant="warning">
                {reason && <p>{localize(discordCallbackLabels[reason])}</p>}
                <p>{localize('com_ui_discord_unconfirmed')}</p>
              </Alert>
            </div>
          ) : (
            <div role="status" className="text-text-secondary flex items-center gap-3 text-sm">
              <Spinner className="size-5 shrink-0" aria-hidden="true" />
              <p>
                {localize(
                  flow === 'cancelling'
                    ? 'com_ui_discord_connection_cancelling'
                    : 'com_ui_discord_pending',
                )}
              </p>
            </div>
          )
        }
        selection={
          <>
            <Button variant="outline" disabled={flow === 'cancelling'} onClick={onCancel}>
              {localize('com_ui_cancel')}
            </Button>
            {flow === 'failed' && retryable && (
              <Button onClick={onRetry}>{localize('com_ui_retry')}</Button>
            )}
          </>
        }
      />
    </OGDialog>
  );
}
