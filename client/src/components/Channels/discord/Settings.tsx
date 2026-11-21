import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import { Alert, Button, Label, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
import type { DiscordApplication, DiscordApplicationPage } from 'librechat-data-provider';
import type { RefObject } from 'react';
import { useLocalize } from '~/hooks';
import { errorLabel } from './errors';
import Callback from '../Callback';
import Notice from '../Notice';

/** What the administrator copies into the Discord Developer Portal, and the command registration. */
export default function Settings({
  app,
  setup,
  open,
  disabled,
  busy,
  registering,
  registered,
  failure,
  loadError,
  loadRef,
  alertRef,
  commandRef,
  onOpenChange,
  onClosed,
  onRegister,
  onRefresh,
  onRetry,
}: {
  app: DiscordApplication | undefined;
  setup: DiscordApplicationPage['setup'];
  open: boolean;
  disabled: boolean;
  busy: boolean;
  registering: boolean;
  registered: boolean;
  failure: { error: unknown } | null;
  /** The reads behind this dialog failed; the page that would show it is out of reach while this is open. */
  loadError: unknown;
  loadRef: RefObject<HTMLDivElement>;
  alertRef: (node: HTMLDivElement | null) => void;
  commandRef: (node: HTMLButtonElement | null) => void;
  onOpenChange: (open: boolean) => void;
  onClosed: (event: Event) => void;
  onRegister: () => void;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const name = app?.name ? `${app.name} · ${app.applicationId}` : app?.applicationId;
  return (
    <OGDialog open={open && app !== undefined} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        className="max-w-xl"
        title={localize('com_ui_discord_settings')}
        description={name}
        showCancelButton={false}
        onCloseAutoFocus={onClosed}
        main={
          app && (
            <div className="space-y-4">
              {Boolean(loadError) && (
                <Notice
                  ref={loadRef}
                  message={localize(errorLabel(loadError))}
                  action={localize('com_ui_retry')}
                  onAction={onRetry}
                />
              )}
              {setup?.oauthCallbackUrl && (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-callback`}>{localize('com_ui_discord_callback')}</Label>
                  <Callback
                    id={`${id}-callback`}
                    value={setup.oauthCallbackUrl}
                    copyLabel={localize('com_ui_discord_copy_setting', {
                      0: localize('com_ui_discord_callback'),
                    })}
                  />
                </div>
              )}
              {setup?.interactionBaseUrl ? (
                <div className="space-y-1">
                  <Label htmlFor={`${id}-ingress`}>{localize('com_ui_discord_interactions')}</Label>
                  <Callback
                    id={`${id}-ingress`}
                    value={`${setup.interactionBaseUrl}${encodeURIComponent(app.applicationId)}/interactions`}
                    copyLabel={localize('com_ui_discord_copy_setting', {
                      0: localize('com_ui_discord_interactions'),
                    })}
                  />
                </div>
              ) : (
                <Alert variant="info">{localize('com_ui_discord_ingress_required')}</Alert>
              )}
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{localize('com_ui_discord_commands')}</h4>
                <p className="text-text-secondary text-xs">
                  {localize('com_ui_discord_commands_help')}
                </p>
                <Button
                  ref={commandRef}
                  type="button"
                  variant="submit"
                  disabled={disabled || failure !== null}
                  aria-label={localize('com_ui_discord_commands_named', {
                    0: app.name || app.applicationId,
                  })}
                  aria-busy={registering}
                  onClick={onRegister}
                >
                  {registering && <Spinner className="size-4" aria-hidden="true" />}
                  {localize(
                    registering
                      ? 'com_ui_discord_commands_registering'
                      : 'com_ui_discord_commands_register',
                  )}
                </Button>
                {registered && (
                  <Alert variant="success" role="status">
                    {localize('com_ui_discord_commands_success')}
                  </Alert>
                )}
                {failure && (
                  <Notice
                    ref={alertRef}
                    message={localize(errorLabel(failure.error))}
                    action={localize('com_ui_refresh')}
                    disabled={busy}
                    onAction={onRefresh}
                  />
                )}
              </div>
              <Button asChild variant="inline-link" className="w-fit">
                <a
                  href="https://discord.com/developers/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {localize('com_ui_discord_developer_portal')}
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </Button>
            </div>
          )
        }
        selection={
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {localize('com_ui_close')}
          </Button>
        }
      />
    </OGDialog>
  );
}
