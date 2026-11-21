import { useId } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, Label, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
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
        showCloseButton
        footerClassName="hidden"
        onCloseAutoFocus={onClosed}
        main={
          app && (
            <div className="space-y-5">
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
              <div className="space-y-1">
                <Label htmlFor={setup?.interactionBaseUrl ? `${id}-ingress` : undefined}>
                  {localize('com_ui_discord_interactions')}
                </Label>
                {setup?.interactionBaseUrl ? (
                  <Callback
                    id={`${id}-ingress`}
                    value={`${setup.interactionBaseUrl}${encodeURIComponent(app.applicationId)}/interactions`}
                    copyLabel={localize('com_ui_discord_copy_setting', {
                      0: localize('com_ui_discord_interactions'),
                    })}
                  />
                ) : (
                  <p className="text-text-secondary text-sm">
                    {localize('com_ui_discord_ingress_required')}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-medium">{localize('com_ui_discord_commands')}</h4>
                    <p className="text-text-secondary text-xs">
                      {localize('com_ui_discord_commands_help')}
                    </p>
                  </div>
                  <Button
                    ref={commandRef}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
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
                </div>
                {registered && (
                  <p role="status" className="text-status-success text-xs">
                    {localize('com_ui_discord_commands_success')}
                  </p>
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
      />
    </OGDialog>
  );
}
