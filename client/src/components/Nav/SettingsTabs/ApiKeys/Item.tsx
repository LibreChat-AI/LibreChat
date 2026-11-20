import { useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { Plug, Trash2 } from 'lucide-react';
import type { TAgentApiKeyListItem } from 'librechat-data-provider';
import { formatDate, formatRelativeTime, getExpiryStatus } from './utils';
import DeleteKeyDialog from './DeleteKeyDialog';
import { useLocalize } from '~/hooks';
import KeyGrant from './KeyGrant';

type ItemProps = {
  apiKey: TAgentApiKeyListItem;
  /** Key runs are limited to what the owner granted, so each key gets a way to grant. */
  grants?: boolean;
};

export default function Item({ apiKey, grants = false }: ItemProps) {
  const localize = useLocalize();
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const grantButtonRef = useRef<HTMLButtonElement | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);

  const status = getExpiryStatus(apiKey.expiresAt);

  return (
    <li className="group hover:bg-surface-secondary/50 flex items-start justify-between gap-3 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-text-primary truncate font-medium">{apiKey.name}</span>
          {status?.state === 'expired' && (
            <span className="border-status-error-border bg-status-error-subtle text-status-error shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium">
              {localize('com_ui_api_key_expired')}
            </span>
          )}
          {status?.state === 'expiring' && (
            <span className="border-status-warning-border bg-status-warning-subtle text-status-warning shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium">
              {status.days === 1
                ? localize('com_ui_api_key_expires_in_day')
                : localize('com_ui_api_key_expires_in_days', { 0: status.days })}
            </span>
          )}
        </div>
        <div className="text-text-secondary flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
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
      {/* A key issued to an integration holds no grants, so there is nothing to open for it. */}
      {grants && apiKey.bound !== true && (
        <Button
          ref={grantButtonRef}
          variant="outline"
          size="icon"
          onClick={() => setGrantOpen(true)}
          aria-label={localize('com_ui_api_key_grant_open', { 0: apiKey.name })}
          aria-haspopup="dialog"
          className="size-8 shrink-0 self-center"
        >
          <Plug className="icon-sm" aria-hidden="true" />
        </Button>
      )}
      {grantOpen && (
        <KeyGrant
          id={apiKey.id}
          name={apiKey.name}
          onOpenChange={setGrantOpen}
          triggerRef={grantButtonRef}
        />
      )}
      <Button
        ref={deleteButtonRef}
        variant="destructive-soft"
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
