import { useEffect, useId, useState } from 'react';
import { Input, Label, Button, Spinner } from '@librechat/client';
import type { ScheduleReauthorization } from 'librechat-data-provider';
import GrantTools, { useGrantChoice } from '~/components/MCP/GrantTools';
import { useScheduleMCPOffer } from '~/data-provider/Schedules/consent';
import { useLocalize } from '~/hooks';

/** What the form needs to know: the owner's choice, and whether one is owed before creating. */
export interface Authorization {
  value: ScheduleReauthorization | null;
  /** There is something to allow, so the schedule is not created until something is. */
  owed: boolean;
  /**
   * The choice is not the grant the schedule has in force: saving has something to store even
   * where no field of the schedule was edited.
   */
  unsaved: boolean;
}

/**
 * What a schedule may use while its owner is away, chosen as it is created or edited. Mounted
 * per agent (`key`), so a choice made for one agent is never carried to the next.
 *
 * `scheduleId` is a stored schedule that keeps its agent: the choice starts from the grant it
 * has and names it, so the edit replaces that grant and no other.
 */
export default function Authorize({
  agentId,
  scheduleId,
  onChange,
}: {
  agentId: string;
  scheduleId?: string;
  onChange: (authorization: Authorization) => void;
}) {
  const localize = useLocalize();
  const inputId = useId();
  const query = useScheduleMCPOffer(agentId, scheduleId);
  const state = useGrantChoice(query.data);
  const offer = query.data?.offer ?? null;
  /**
   * A schedule runs for as long as it exists, so its grant starts at the longest the operator
   * allows: one that ran out before the next run would leave the schedule without its tools.
   * Null until the owner types another.
   */
  const [typed, setHours] = useState<number | null>(null);
  const hours = typed ?? offer?.maxLifetimeHours ?? 1;
  /** Not while the offer is being read again: its digest is the one just turned down. */
  const valid =
    offer != null &&
    !query.isFetching &&
    state.some &&
    Number.isInteger(hours) &&
    hours >= 1 &&
    hours <= offer.maxLifetimeHours;
  /** Compared by value: the choice is rebuilt on every render, and the form is told on change. */
  const chosen = valid
    ? JSON.stringify({
        offerDigest: offer.digest,
        ...(scheduleId && { expectedRevision: query.data?.revision ?? null }),
        lifetimeHours: hours,
        ...state.request,
      })
    : null;
  const owed = offer != null;
  /** A grant that is not in force is not what the form shows, however little was touched. */
  const unsaved = query.data?.state !== 'active' || !state.pristine || typed != null;
  useEffect(() => {
    onChange({
      value: chosen ? (JSON.parse(chosen) as ScheduleReauthorization) : null,
      owed,
      unsaved,
    });
  }, [chosen, owed, unsaved, onChange]);

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
      {!state.some && (
        <p className="text-text-secondary text-xs">
          {localize('com_ui_schedule_consent_none_selected')}
        </p>
      )}
    </fieldset>
  );
}
