import { useId, useRef, useState } from 'react';
import { Info, Plus } from 'lucide-react';
import { Alert, Button, InfoHoverCard } from '@librechat/client';
import { useEventConnections, useEventSubscriptions } from '~/data-provider/Events';
import EventDialog from './EventDialog';
import { useLocalize } from '~/hooks';
import EventCard from './EventCard';

/**
 * The agent's event subscriptions owned by the person viewing it: when these events arrive,
 * run this agent. Each person who can use the agent has their own.
 */
export default function Events({
  agentId,
  canCreate = false,
}: {
  agentId?: string;
  /** `AGENT_EVENTS:CREATE`: adding, editing, turning on or off, and allowing tools. */
  canCreate?: boolean;
}) {
  const localize = useLocalize();
  const id = useId();
  const addRef = useRef<HTMLButtonElement | null>(null);
  const [adding, setAdding] = useState(false);
  const subscriptions = useEventSubscriptions(agentId);
  const connections = useEventConnections(Boolean(agentId));
  const choices = connections.data ?? [];
  const failed = subscriptions.isError || connections.isError;
  const loading = Boolean(agentId) && (subscriptions.isLoading || connections.isLoading);
  const none = connections.isSuccess && choices.length === 0;

  return (
    <section aria-labelledby={`${id}-heading`} className="mb-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3
            id={`${id}-heading`}
            className="text-text-secondary text-2xs truncate font-medium tracking-wide uppercase"
          >
            {localize('com_ui_events_title')}
          </h3>
          <InfoHoverCard text={localize('com_ui_events_description')}>
            <Info className="text-text-tertiary size-3.5" aria-hidden="true" />
          </InfoHoverCard>
        </div>
        {!none && canCreate && (
          <Button
            ref={addRef}
            type="button"
            variant="section-add"
            disabled={!agentId || !subscriptions.isSuccess || !connections.isSuccess}
            aria-label={localize('com_ui_events_add')}
            onClick={() => setAdding(true)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            {localize('com_ui_add')}
          </Button>
        )}
      </div>
      {!agentId && (
        <p className="text-text-secondary text-2xs">{localize('com_ui_events_save_first')}</p>
      )}
      {loading && (
        <p role="status" className="text-text-secondary text-xs">
          {localize('com_ui_events_loading')}
        </p>
      )}
      {failed && (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">{localize('com_ui_events_list_error')}</Alert>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void subscriptions.refetch();
              void connections.refetch();
            }}
          >
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {none && (
        <p className="text-text-secondary text-xs">{localize('com_ui_events_no_connection')}</p>
      )}
      {agentId && subscriptions.data != null && subscriptions.data.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {subscriptions.data.map((subscription) => (
            <EventCard
              key={subscription.id}
              agentId={agentId}
              subscription={subscription}
              connections={choices}
              canWrite={canCreate}
            />
          ))}
        </ul>
      )}
      {agentId &&
        !none &&
        subscriptions.data != null &&
        subscriptions.data.length === 0 &&
        connections.isSuccess && (
          <p className="text-text-secondary text-xs">
            {localize(canCreate ? 'com_ui_events_empty' : 'com_ui_events_empty_read_only')}
          </p>
        )}
      {adding && agentId && (
        <EventDialog
          agentId={agentId}
          connections={choices}
          onOpenChange={setAdding}
          triggerRef={addRef}
        />
      )}
    </section>
  );
}
