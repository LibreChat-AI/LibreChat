import { useRef, useState, useMemo } from 'react';
import * as Ariakit from '@ariakit/react';
import { Ellipsis, Pencil, ShieldCheck, Trash } from 'lucide-react';
import { Chip, Label, Switch, OGDialog, DropdownPopup, OGDialogTemplate } from '@librechat/client';
import type { ConnectionChoice, AgentEventType, Subscription } from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import { useEventGrant, useEventSubscriptionMutations } from '~/data-provider/Events';
import { eventErrorLabel, eventLabels, grantLabels } from './labels';
import { rowActionClasses } from '~/utils';
import EventDialog from './EventDialog';
import { useLocalize } from '~/hooks';
import EventGrant from './EventGrant';

/** One subscription: what it listens for, whether it is on, and what its runs may use. */
export default function EventCard({
  agentId,
  subscription,
  connections,
  canWrite,
}: {
  agentId: string;
  subscription: Subscription;
  connections: ConnectionChoice[];
  /** Whether the viewer may edit it, turn it on or off, and allow tools; deleting needs none. */
  canWrite: boolean;
}) {
  const localize = useLocalize();
  const { update, remove } = useEventSubscriptionMutations(agentId);
  const grant = useEventGrant(subscription.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'edit' | 'grant' | 'delete' | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const grantRef = useRef<HTMLButtonElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement | null>(null);

  const connection = connections.find((choice) => choice.id === subscription.connection);
  const name = subscription.events
    .map((type) => (type in eventLabels ? localize(eventLabels[type as AgentEventType]) : type))
    .join(', ');
  const grantState = grant.data ? grantLabels[grant.data.state] : undefined;
  const failure = [update, remove].find((mutation) => mutation.isError)?.error;

  const items = useMemo(
    () => [
      {
        label: localize('com_ui_events_grant_title'),
        onClick: () => setDialog('grant'),
        icon: <ShieldCheck className="icon-sm text-text-primary me-2" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: grantRef,
        render: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
      },
      ...(canWrite
        ? [
            {
              label: localize('com_ui_edit'),
              onClick: () => setDialog('edit'),
              icon: <Pencil className="icon-sm text-text-primary me-2" aria-hidden="true" />,
              ariaHasPopup: 'dialog' as const,
              hideOnClick: false,
              ref: editRef,
              render: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
                <button {...props} />
              ),
            },
          ]
        : []),
      {
        label: localize('com_ui_delete'),
        onClick: () => setDialog('delete'),
        icon: <Trash className="icon-sm text-text-primary me-2" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: deleteRef,
        render: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
      },
    ],
    [localize, canWrite],
  );

  return (
    <li
      data-testid="event-card"
      className="group hover:bg-surface-secondary rounded-lg px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-text-primary truncate text-sm font-medium" title={name}>
            {name}
          </span>
          <span className="text-text-secondary truncate text-xs">
            {connection?.account ?? localize('com_ui_events_connection_gone')}
          </span>
        </div>
        <Switch
          checked={subscription.enabled}
          disabled={!canWrite || update.isLoading}
          aria-label={`${localize('com_ui_events_enabled')}: ${name}`}
          onCheckedChange={(enabled) =>
            update.mutate({
              id: subscription.id,
              payload: { enabled, expectedRevision: subscription.revision },
            })
          }
        />
        <DropdownPopup
          portal={true}
          menuId={`event-menu-${subscription.id}`}
          focusLoop={true}
          className="z-[125]"
          unmountOnHide={true}
          isOpen={menuOpen}
          setIsOpen={setMenuOpen}
          trigger={
            <Ariakit.MenuButton
              aria-label={`${localize('com_ui_events_options')}: ${name}`}
              className={rowActionClasses({ open: menuOpen })}
            >
              <Ellipsis className="size-4" aria-hidden={true} />
            </Ariakit.MenuButton>
          }
          items={items}
        />
      </div>
      {grantState && (
        <div className="mt-1">
          <Chip tone="warning">{localize(grantState)}</Chip>
        </div>
      )}
      {failure != null && (
        <p role="alert" className="text-text-destructive mt-1 text-xs">
          {localize(eventErrorLabel(failure))}
        </p>
      )}
      {dialog === 'edit' && (
        <EventDialog
          agentId={agentId}
          subscription={subscription}
          connections={connections}
          onOpenChange={(open) => !open && setDialog(null)}
          triggerRef={editRef}
        />
      )}
      {dialog === 'grant' && (
        <EventGrant
          canConfirm={canWrite}
          id={subscription.id}
          name={name}
          onOpenChange={(open) => !open && setDialog(null)}
          triggerRef={grantRef}
        />
      )}
      <DeleteEvent
        open={dialog === 'delete'}
        name={name}
        onOpenChange={(open) => !open && setDialog(null)}
        onConfirm={() => remove.mutate(subscription.id, { onSuccess: () => setDialog(null) })}
        triggerRef={deleteRef}
      />
    </li>
  );
}

function DeleteEvent({
  open,
  name,
  onOpenChange,
  onConfirm,
  triggerRef,
}: {
  open: boolean;
  name: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const localize = useLocalize();
  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        showCloseButton={false}
        title={localize('com_ui_events_delete')}
        className="w-11/12 max-w-lg"
        main={
          <Label className="text-start text-sm font-medium">
            {localize('com_ui_events_delete_confirm', { 0: name })}
          </Label>
        }
        selection={{
          selectHandler: onConfirm,
          selectClasses:
            'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
          selectText: localize('com_ui_delete'),
        }}
      />
    </OGDialog>
  );
}
