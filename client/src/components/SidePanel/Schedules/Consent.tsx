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
  const [edited, setEdited] = useState<Record<string, string[]> | null>(null);
  const busy = confirm.isLoading || revoke.isLoading || query.isFetching;
  const data: ScheduleMCPConsentView | undefined = query.data;
  const choosing = canConfirm && data?.offer != null;
  const choice = edited ?? (data ? initialChoice(data) : {});
  const chosenCount = Object.values(choice).reduce((count, tools) => count + tools.length, 0);
  const setTools = (serverName: string, tools: string[]) =>
    setEdited({ ...choice, [serverName]: tools });
  const commit = () => {
    if (!data?.offer || chosenCount === 0) return;
    setMessage(null);
    confirm.mutate(
      {
        offerDigest: data.offer.digest,
        expectedRevision: data.revision,
        lifetimeHours: hours,
        allow: choice,
      },
      {
        onSuccess: () => {
          setEdited(null);
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
                          disabled={busy}
                          onChange={(tools) => setTools(target.resource.serverName, tools)}
                        />
                      ) : (
                        <>
                          <p className="text-text-secondary text-xs">
                            {localize('com_ui_schedule_consent_allowed', {
                              tools: (data.allowed[target.resource.serverName] ?? []).join(', '),
                            })}
                          </p>
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
  disabled,
  onChange,
}: {
  serverName: string;
  offered: string[];
  chosen: string[];
  /** Tools the server changed since they were allowed. Refused until confirmed again. */
  changed: string[];
  disabled: boolean;
  onChange: (tools: string[]) => void;
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
