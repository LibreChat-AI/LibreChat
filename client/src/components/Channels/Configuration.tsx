import { useId, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { CopyButton } from '@librechat/chat/components';
import {
  Button,
  IconButton,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  TooltipAnchor,
} from '@librechat/client';
import type { SlackAppPage, SlackAppRegistration } from 'librechat-data-provider';
import { useCopyToClipboard, useLocalize } from '~/hooks';

type ConfigurationProps = {
  app: SlackAppRegistration;
  setup: NonNullable<SlackAppPage['setup']>;
  tenantId: string;
};

export default function Configuration({
  app,
  setup,
  tenantId,
  disabled,
}: ConfigurationProps & { disabled: boolean }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <OGDialog open={open} onOpenChange={setOpen} triggerRef={trigger}>
      <TooltipAnchor
        description={localize('com_ui_slack_apps_connection_settings')}
        render={
          <IconButton
            ref={trigger}
            label={localize('com_ui_slack_apps_connection_settings_named', {
              0: app.name ? `${app.name} (${app.appId})` : app.appId,
            })}
            variant="ghost"
            size="sm"
            shape="control"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <Settings2 className="size-4" aria-hidden="true" />
          </IconButton>
        }
      />
      <OGDialogTemplate
        className="max-w-xl"
        title={localize('com_ui_slack_apps_connection_settings')}
        description={app.name ? `${app.name} · ${app.appId}` : app.appId}
        showCancelButton={false}
        onCloseAutoFocus={(event) => {
          if (trigger.current?.isConnected) {
            event.preventDefault();
            trigger.current.focus();
          }
        }}
        main={open ? <Settings app={app} setup={setup} tenantId={tenantId} /> : null}
        selection={
          <Button variant="outline" onClick={() => setOpen(false)}>
            {localize('com_ui_close')}
          </Button>
        }
      />
    </OGDialog>
  );
}

function Settings({ app, setup, tenantId }: ConfigurationProps) {
  const localize = useLocalize();
  const suffix = `/${encodeURIComponent(tenantId)}/${encodeURIComponent(app.appId)}`;
  const events = `${setup.eventsBaseUrl}${suffix}`;
  const interactions = `${setup.interactionsBaseUrl}${suffix}`;
  const urls = <Urls redirect={setup.redirectUri} events={events} interactions={interactions} />;
  return (
    <div className="space-y-4">
      {urls}
      <a
        className="text-text-primary inline-flex text-sm underline"
        href="https://api.slack.com/apps"
        target="_blank"
        rel="noopener noreferrer"
      >
        {localize('com_ui_slack_apps_dashboard')}
      </a>
    </div>
  );
}

function Urls({
  redirect,
  events,
  interactions,
}: {
  redirect: string;
  events: string;
  interactions: string;
}) {
  const localize = useLocalize();
  const id = useId();
  return (
    <div className="space-y-4">
      {(
        [
          ['com_ui_slack_apps_redirect', redirect],
          ['com_ui_slack_apps_events', events],
          ['com_ui_slack_apps_interactions', interactions],
        ] as const
      ).map(([key, value]) => (
        <div key={key} className="space-y-1">
          <Label htmlFor={`${id}-${key}`}>{localize(key)}</Label>
          <Callback id={`${id}-${key}`} value={value} label={localize(key)} />
        </div>
      ))}
    </div>
  );
}

function Callback({ id, value, label }: { id: string; value: string; label: string }) {
  const localize = useLocalize();
  const [copied, setCopied] = useState(false);
  const copy = useCopyToClipboard({ text: value });
  return (
    <div className="flex items-center gap-2">
      <Input id={id} readOnly value={value} onFocus={(event) => event.target.select()} />
      <CopyButton
        isCopied={copied}
        onClick={() => copy(setCopied)}
        iconOnly
        label={localize('com_ui_slack_apps_copy_setting', { 0: label })}
      />
    </div>
  );
}
