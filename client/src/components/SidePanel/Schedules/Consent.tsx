import { useState, useId } from 'react';
import {
  Button,
  Input,
  Label,
  Spinner,
  Checkbox,
  OGDialog,
  OGDialogTemplate,
} from '@librechat/client';
import type { ScheduleMCPConsentView, ScheduledMCPTarget } from 'librechat-data-provider';
import type { MutableRefObject } from 'react';
import {
  useScheduleMCPConsent,
  useScheduleMCPConsentMutations,
} from '~/data-provider/Schedules/consent';
import { useLocalize } from '~/hooks';

const statusKeys = {
  missing: 'com_ui_schedule_consent_missing',
  active: 'com_ui_schedule_consent_active',
  expired: 'com_ui_schedule_consent_expired',
  revoked: 'com_ui_schedule_consent_revoked',
  changed: 'com_ui_schedule_consent_changed',
  unsupported: 'com_ui_schedule_consent_unsupported',
} as const;

const messageKeys = {
  error: 'com_ui_schedule_consent_error',
  revoked: 'com_ui_schedule_consent_revoked',
  success: 'com_ui_schedule_consent_confirmed',
} as const;

/** Every tool on offer for a server, whichever agents selected it. */
function offeredTools(target: ScheduledMCPTarget): string[] {
  return [...new Set(target.permittedTools.flatMap((selection) => selection.tools))].sort();
}

/**
 * The owner's starting point: what the stored grant already allows and is still on offer.
 * A tool whose definition changed starts unticked, so allowing the new one is a decision.
 */
function initialChoice(data: ScheduleMCPConsentView): Record<string, string[]> {
  return Object.fromEntries(
    data.targets.map((target) => {
      const offered = offeredTools(target);
      const allowed = data.allowed[target.resource.serverName] ?? [];
      const changed = data.changed[target.resource.serverName] ?? [];
      return [
        target.resource.serverName,
        offered.filter((tool) => allowed.includes(tool) && !changed.includes(tool)),
      ];
    }),
  );
}

/**
 * The owner's ticks, with the grant they were made against and the tools it marked as
 * changed at the time. A mark belongs to one grant: the same tool marked again under a later
 * grant is a different change, which the owner has not looked at.
 */
interface Edited {
  choice: Record<string, string[]>;
  revision: string | null;
  changed: Record<string, string[]>;
}

/**
 * The owner's ticks, kept to what is on offer now. The offer is read again while the dialog
 * is open: a server or tool the agents dropped has no box left to untick, and a tool marked
 * as changed since the owner last ticked anything, or marked under another grant, loses its
 * tick, so allowing the new definition is something the owner does with the warning in view.
 */
function currentChoice(
  data: ScheduleMCPConsentView,
  edited: Edited | null,
): Record<string, string[]> {
  const initial = initialChoice(data);
  if (!edited) return initial;
  return Object.fromEntries(
    data.targets.map((target) => {
      const { serverName } = target.resource;
      const offered = offeredTools(target);
      const marked = data.changed[serverName] ?? [];
      const seen = edited.revision === data.revision ? (edited.changed[serverName] ?? []) : [];
      return [
        serverName,
        (edited.choice[serverName] ?? initial[serverName]).filter(
          (tool) => offered.includes(tool) && (!marked.includes(tool) || seen.includes(tool)),
        ),
      ];
    }),
  );
}

/** Of the tools ticked to start with, the ones the stored grant asks about before each use. */
function initialAsking(
  data: ScheduleMCPConsentView,
  choice: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(choice).map(([serverName, tools]) => [
      serverName,
      tools.filter((tool) => (data.asking[serverName] ?? []).includes(tool)),
    ]),
  );
}

export default function Consent({
  canConfirm = true,
  id,
  name,
  onOpenChange,
  triggerRef,
}: {
  canConfirm?: boolean;
  id: string;
  name: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const localize = useLocalize();
  const inputId = useId();
  const query = useScheduleMCPConsent(id);
  const { confirm, revoke } = useScheduleMCPConsentMutations(id);
  const [hours, setHours] = useState(1);
  const [message, setMessage] = useState<'success' | 'revoked' | 'error' | null>(null);
  /** Null until the owner changes a box, so a refetch cannot overwrite a choice in progress. */
  const [edited, setEdited] = useState<Edited | null>(null);
  const busy = confirm.isLoading || revoke.isLoading || query.isFetching;
  const data: ScheduleMCPConsentView | undefined = query.data;
  const choosing = canConfirm && data?.offer != null;
  const choice = data ? currentChoice(data, edited) : {};
  const chosenCount = Object.values(choice).reduce((count, tools) => count + tools.length, 0);
  /** Null until the owner changes an "ask me first" box. Only ever holds allowed tools. */
  const [editedAsking, setEditedAsking] = useState<Record<string, string[]> | null>(null);
  const canAsk = data?.approval === true;
  const asking = editedAsking ?? (data && canAsk ? initialAsking(data, choice) : {});
  const setTools = (serverName: string, tools: string[]) => {
    setEdited({
      choice: { ...choice, [serverName]: tools },
      revision: data?.revision ?? null,
      changed: data?.changed ?? {},
    });
    // A tool that is no longer allowed has nothing left to ask about.
    setEditedAsking({
      ...asking,
      [serverName]: (asking[serverName] ?? []).filter((tool) => tools.includes(tool)),
    });
  };
  const setAsking = (serverName: string, tools: string[]) =>
    setEditedAsking({ ...asking, [serverName]: tools });
  /** Sent with the confirmation: only tools still ticked, since a tick can be dropped by a refetch. */
  const ask = Object.fromEntries(
    Object.entries(asking)
      .map(([serverName, tools]): [string, string[]] => [
        serverName,
        tools.filter((tool) => (choice[serverName] ?? []).includes(tool)),
      ])
      .filter(([, tools]) => tools.length > 0),
  );
  const commit = () => {
    if (!data?.offer || chosenCount === 0) return;
    setMessage(null);
    confirm.mutate(
      {
        offerDigest: data.offer.digest,
        expectedRevision: data.revision,
        lifetimeHours: hours,
        allow: choice,
        ...(Object.keys(ask).length > 0 && { ask }),
      },
      {
        onSuccess: () => {
          setEdited(null);
          setEditedAsking(null);
          setMessage('success');
        },
        onError: () => setMessage('error'),
      },
    );
  };
  const withdraw = () => {
    if (!data?.revision) return;
    setMessage(null);
    revoke.mutate(data.revision, {
      onSuccess: () => setMessage('revoked'),
      onError: () => setMessage('error'),
    });
  };
  return (
    <OGDialog open onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        title={localize('com_ui_schedule_consent_title')}
        className="w-11/12 max-w-lg"
        main={
          <div className="space-y-4">
            <p className="text-text-primary text-sm">{name}</p>
            <p className="text-text-secondary text-sm">
              {localize('com_ui_schedule_consent_boundary')}
            </p>
            {query.isLoading && <Spinner />}
            {!query.isLoading && query.isError && (
              <div role="alert">
                <p>{localize('com_ui_schedule_consent_error')}</p>
                <Button variant="outline" onClick={() => query.refetch()}>
                  {localize('com_ui_retry')}
                </Button>
              </div>
            )}
            {!query.isLoading && !query.isError && data && (
              <>
                <p role="status">{localize(statusKeys[data.state])}</p>
                {data.required && (
                  <p className="text-status-warning text-sm">
                    {localize('com_ui_schedule_consent_required')}
                  </p>
                )}
                {data.requireAfterMs != null && (
                  <p className="text-text-secondary text-sm">
                    {localize('com_ui_schedule_consent_required_after', {
                      time: new Date(data.requireAfterMs).toLocaleString(),
                    })}
                  </p>
                )}
                {data.expiresAtMs != null && (
                  <p className="text-text-secondary text-sm">
                    {localize('com_ui_schedule_consent_deadline', {
                      time: new Date(data.expiresAtMs).toLocaleString(),
                    })}
                  </p>
                )}
                <ul className="space-y-2">
                  {data.targets.map((target) => (
                    <li key={target.resource.serverName}>
                      <p className="text-sm font-medium">{target.resource.serverName}</p>
                      <p className="text-text-secondary text-xs break-all">{target.resource.url}</p>
                      <p className="text-text-secondary text-xs">
                        {target.resource.credentialMode}
                      </p>
                      {target.resource.issuer && (
                        <p className="text-text-secondary text-xs wrap-anywhere">
                          {localize('com_ui_schedule_consent_issuer', {
                            issuer: target.resource.issuer,
                          })}
                        </p>
                      )}
                      {target.resource.audience && (
                        <p className="text-text-secondary text-xs">
                          {localize('com_ui_schedule_consent_audience', {
                            audience: target.resource.audience,
                          })}
                        </p>
                      )}
                      {target.resource.scopes.length > 0 && (
                        <p className="text-text-secondary text-xs">
                          {localize('com_ui_schedule_consent_scopes', {
                            scopes: target.resource.scopes.join(', '),
                          })}
                        </p>
                      )}
                      {choosing ? (
                        <ToolChoice
                          serverName={target.resource.serverName}
                          offered={offeredTools(target)}
                          chosen={choice[target.resource.serverName] ?? []}
                          changed={data.changed[target.resource.serverName] ?? []}
                          asking={canAsk ? (asking[target.resource.serverName] ?? []) : null}
                          disabled={busy}
                          onChange={(tools) => setTools(target.resource.serverName, tools)}
                          onAskingChange={(tools) => setAsking(target.resource.serverName, tools)}
                        />
                      ) : (
                        <>
                          <p className="text-text-secondary text-xs">
                            {localize('com_ui_schedule_consent_allowed', {
                              tools: (data.allowed[target.resource.serverName] ?? []).join(', '),
                            })}
                          </p>
                          {(data.asking[target.resource.serverName] ?? []).length > 0 && (
                            <p className="text-text-secondary text-xs">
                              {localize('com_ui_schedule_consent_asking', {
                                tools: data.asking[target.resource.serverName].join(', '),
                              })}
                            </p>
                          )}
                          {(data.changed[target.resource.serverName] ?? []).length > 0 && (
                            <p className="text-status-warning text-xs">
                              {localize('com_ui_schedule_consent_changed_tools', {
                                tools: data.changed[target.resource.serverName].join(', '),
                              })}
                            </p>
                          )}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {canConfirm && data.offer && (
                  <>
                    <Label htmlFor={inputId}>{localize('com_ui_schedule_consent_hours')}</Label>
                    <Input
                      id={inputId}
                      type="number"
                      min={1}
                      max={data.offer.maxLifetimeHours}
                      value={hours}
                      disabled={busy}
                      onChange={(event) => setHours(Number(event.target.value))}
                    />
                    <Button
                      onClick={commit}
                      disabled={
                        busy ||
                        chosenCount === 0 ||
                        !Number.isInteger(hours) ||
                        hours < 1 ||
                        hours > data.offer.maxLifetimeHours
                      }
                    >
                      {localize('com_ui_schedule_consent_confirm')}
                    </Button>
                    {chosenCount === 0 && (
                      <p className="text-text-secondary text-xs">
                        {localize('com_ui_schedule_consent_none_selected')}
                      </p>
                    )}
                  </>
                )}
                {data.revision && data.state !== 'revoked' && (
                  <Button variant="outline" disabled={busy} onClick={withdraw}>
                    {localize('com_ui_schedule_consent_revoke')}
                  </Button>
                )}
              </>
            )}
            {message && (
              <p role={message === 'error' ? 'alert' : 'status'}>
                {localize(messageKeys[message])}
              </p>
            )}
          </div>
        }
      />
    </OGDialog>
  );
}

/** One server's tools: a box for the whole server and one per tool. Unchecked means refused. */
function ToolChoice({
  serverName,
  offered,
  chosen,
  changed,
  asking,
  disabled,
  onChange,
  onAskingChange,
}: {
  serverName: string;
  offered: string[];
  chosen: string[];
  /** Tools the server changed since they were allowed. Refused until confirmed again. */
  changed: string[];
  /** Allowed tools the owner approves call by call. Null where a scheduled run cannot pause. */
  asking: string[] | null;
  disabled: boolean;
  onChange: (tools: string[]) => void;
  onAskingChange: (tools: string[]) => void;
}) {
  const localize = useLocalize();
  const groupId = useId();
  /** Checked only when every tool is: the shared box has no partly-selected appearance. */
  const all = offered.length > 0 && offered.every((tool) => chosen.includes(tool));
  return (
    <fieldset className="mt-2 space-y-1" disabled={disabled}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${groupId}-all`}
          checked={all}
          disabled={disabled}
          aria-label={localize('com_ui_schedule_consent_allow_server', { server: serverName })}
          onCheckedChange={(checked) => onChange(checked === true ? offered : [])}
        />
        <Label htmlFor={`${groupId}-all`} className="text-xs">
          {localize('com_ui_schedule_consent_allow_server', { server: serverName })}
        </Label>
      </div>
      <ul className="space-y-1 pl-6">
        {offered.map((tool) => (
          <li key={tool}>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${groupId}-${tool}`}
                checked={chosen.includes(tool)}
                disabled={disabled}
                aria-labelledby={`${groupId}-${tool}-label`}
                aria-describedby={changed.includes(tool) ? `${groupId}-${tool}-changed` : undefined}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? offered.filter((name) => name === tool || chosen.includes(name))
                      : chosen.filter((name) => name !== tool),
                  )
                }
              />
              <Label
                id={`${groupId}-${tool}-label`}
                htmlFor={`${groupId}-${tool}`}
                className="text-xs break-all"
              >
                {tool}
              </Label>
              {asking && chosen.includes(tool) && (
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <Checkbox
                    id={`${groupId}-${tool}-ask`}
                    checked={asking.includes(tool)}
                    disabled={disabled}
                    aria-label={localize('com_ui_schedule_consent_ask_tool', { tool })}
                    onCheckedChange={(checked) =>
                      onAskingChange(
                        checked === true
                          ? [...asking, tool]
                          : asking.filter((name) => name !== tool),
                      )
                    }
                  />
                  <Label htmlFor={`${groupId}-${tool}-ask`} variant="secondary" className="text-xs">
                    {localize('com_ui_schedule_consent_ask_first')}
                  </Label>
                </span>
              )}
            </div>
            {changed.includes(tool) && (
              <p id={`${groupId}-${tool}-changed`} className="text-status-warning pl-6 text-xs">
                {localize('com_ui_schedule_consent_tool_changed')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
