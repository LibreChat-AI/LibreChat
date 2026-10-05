import { useState } from 'react';
import { Settings } from 'lucide-react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import type { MediaCatalog } from 'librechat-data-provider';
import type { MediaKeyConfiguration } from './credentials';
import SetKeyDialog from '~/components/Input/SetKeyDialog/SetKeyDialog';
import { mergeMediaUserKeys } from './credentials';
import { useLocalize } from '~/hooks';

export function useMediaCredentials(catalog: MediaCatalog, selectId: string) {
  const localize = useLocalize();
  const [active, setActive] = useState<MediaKeyConfiguration>();
  const keys = mergeMediaUserKeys(catalog.integrations);
  const canConfigure = (connectionId: string) => {
    const descriptor = catalog.integrations?.find(
      (item) => item.connectionId === connectionId,
    )?.userKey;
    const key = descriptor && keys.get(descriptor.keyName);
    return !!key && !key.conflict;
  };
  const close = (open: boolean) => {
    if (open) return;
    setActive(undefined);
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    document.getElementById(selectId)?.focus();
  };
  const action = (connectionId: string) => {
    const integration = catalog.integrations?.find((item) => item.connectionId === connectionId);
    const key = integration?.userKey && keys.get(integration.userKey.keyName);
    if (!integration || !key) return undefined;
    return {
      label: localize('com_ui_provider_key_action', {
        action: localize('com_endpoint_config_key'),
        name: integration.connectionName,
      }),
      icon: <Settings className="size-4" aria-hidden="true" />,
      onClick: () => setActive({ ...key, label: integration.connectionName }),
    };
  };
  const dialog =
    active &&
    (active.conflict ? (
      <OGDialog open onOpenChange={close}>
        <OGDialogContent onCloseAutoFocus={restoreFocus}>
          <OGDialogHeader>
            <OGDialogTitle>{active.label}</OGDialogTitle>
          </OGDialogHeader>
          <p role="alert">{localize('com_ui_provider_api_keys_conflict')}</p>
        </OGDialogContent>
      </OGDialog>
    ) : (
      <SetKeyDialog
        open
        endpoint={active.keyName}
        label={active.label}
        keyConfiguration={active.encoding === 'google' ? undefined : active}
        userProvideURL={active.userProvideURL}
        onOpenChange={close}
        onCloseAutoFocus={restoreFocus}
      />
    ));
  return { action, dialog, canConfigure };
}
