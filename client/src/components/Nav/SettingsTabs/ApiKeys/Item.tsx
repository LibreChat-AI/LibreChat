import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@librechat/client';
import type { TAgentApiKeyListItem } from 'librechat-data-provider';
import { formatDate, formatRelativeTime, getExpiryStatus } from './utils';
import DeleteKeyDialog from './DeleteKeyDialog';
import { useLocalize } from '~/hooks';

type ItemProps = {
  apiKey: TAgentApiKeyListItem;
};

export default function Item({ apiKey }: ItemProps) {
  const localize = useLocalize();
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const status = getExpiryStatus(apiKey.expiresAt);

  return (
    <li className="group flex items-start justify-between gap-3 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-secondary/50">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-text-primary">{apiKey.name}</span>
          {status?.state === 'expired' && (
            <span className="shrink-0 rounded-full border border-status-error-border bg-status-error-subtle px-2 py-0.5 text-xs font-medium text-status-error">
              {localize('com_ui_api_key_expired')}
            </span>
          )}
          {status?.state === 'expiring' && (
            <span className="shrink-0 rounded-full border border-status-warning-border bg-status-warning-subtle px-2 py-0.5 text-xs font-medium text-status-warning">
              {status.days === 1
                ? localize('com_ui_api_key_expires_in_day')
                : localize('com_ui_api_key_expires_in_days', { 0: status.days })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-secondary">
          <code className="font-mono">{apiKey.keyPrefix}…</code>
          <span aria-hidden="true" className="text-text-tertiary">
            ·
          </span>
          <span>
            {apiKey.lastUsedAt
              ? localize('com_ui_api_key_last_used', { 0: formatRelativeTime(apiKey.lastUsedAt) })
              : localize('com_ui_api_key_never_used')}
          </span>
          <span aria-hidden="true" className="text-text-tertiary">
            ·
          </span>
          <span>
            {apiKey.expiresAt
              ? localize('com_ui_api_key_expires_on', { 0: formatDate(apiKey.expiresAt) })
              : localize('com_ui_api_key_no_expiration')}
          </span>
        </div>
      </div>
      <Button
        ref={deleteButtonRef}
        variant="destructive"
        size="icon"
        onClick={() => setDeleteOpen(true)}
        aria-label={localize('com_ui_api_key_delete_name', { 0: apiKey.name })}
        aria-haspopup="dialog"
        className="size-8 shrink-0 self-center"
      >
        <Trash2 className="icon-sm" aria-hidden="true" />
      </Button>
      <DeleteKeyDialog
        id={apiKey.id}
        name={apiKey.name}
        keyPrefix={apiKey.keyPrefix}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        triggerRef={deleteButtonRef}
      />
    </li>
  );
}
