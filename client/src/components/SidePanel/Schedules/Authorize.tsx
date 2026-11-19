import { useEffect, useId, useState } from 'react';
import { Input, Label, Button, Spinner } from '@librechat/client';
import type { ScheduleAuthorization } from 'librechat-data-provider';
import GrantTools, { useGrantChoice } from '~/components/MCP/GrantTools';
import { useScheduleMCPOffer } from '~/data-provider/Schedules/consent';
import { useLocalize } from '~/hooks';

/** What the form needs to know: the owner's choice, and whether one is owed before creating. */
export interface Authorization {
  value: ScheduleAuthorization | null;
  /** There is something to allow, so the schedule is not created until something is. */
  owed: boolean;
}

/**
 * What a schedule may use while its owner is away, chosen as it is created. Mounted per
 * agent (`key`), so a choice made for one agent is never carried to the next.
 */
export default function Authorize({
  agentId,
  onChange,
}: {
  agentId: string;
  onChange: (authorization: Authorization) => void;
}) {
  const localize = useLocalize();
  const inputId = useId();
  const query = useScheduleMCPOffer(agentId);
  const state = useGrantChoice(query.data);
  const [hours, setHours] = useState(1);
  const offer = query.data?.offer ?? null;
  const valid =
    offer != null &&
    state.count > 0 &&
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= offer.maxLifetimeHours;
  /** Compared by value: the choice is rebuilt on every render, and the form is told on change. */
  const chosen = valid
    ? JSON.stringify({
        offerDigest: offer.digest,
        lifetimeHours: hours,
        allow: state.choice,
        ask: state.ask,
        tools: state.other,
      })
    : null;
  const owed = offer != null;
  useEffect(() => {
    onChange({ value: chosen ? (JSON.parse(chosen) as ScheduleAuthorization) : null, owed });
  }, [chosen, owed, onChange]);

  if (query.isLoading && query.fetchStatus !== 'idle') return <Spinner />;
  if (query.isError)
    return (
      <div role="alert" className="space-y-2">
        <p className="text-text-primary text-sm">
          {localize('com_ui_schedule_authorize_unavailable')}
        </p>
        <Button variant="outline" onClick={() => query.refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  if (!query.data || !offer) return null;
  return (
    <fieldset className="space-y-3">
      <legend className="text-text-primary text-sm font-medium">
        {localize('com_ui_schedule_authorize_title')}
      </legend>
      <p className="text-text-secondary text-sm">{localize('com_ui_schedule_consent_boundary')}</p>
      <GrantTools data={query.data} choosing state={state} busy={false} />
      <div className="space-y-1">
        <Label htmlFor={inputId}>{localize('com_ui_schedule_consent_hours')}</Label>
        <Input
          id={inputId}
          type="number"
          min={1}
          max={offer.maxLifetimeHours}
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
        />
      </div>
      {state.count === 0 && (
        <p className="text-text-secondary text-xs">
          {localize('com_ui_schedule_consent_none_selected')}
        </p>
      )}
    </fieldset>
  );
}
