import { useState, useId } from 'react';
import { Button, Input, Label, Spinner, OGDialog, OGDialogTemplate } from '@librechat/client';
import type { ScheduleMCPConsentView } from 'librechat-data-provider';
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
  const busy = confirm.isLoading || revoke.isLoading || query.isFetching;
  const data: ScheduleMCPConsentView | undefined = query.data;
  const commit = () => {
    if (!data?.offer) return;
    setMessage(null);
    confirm.mutate(
      { offerDigest: data.offer.digest, expectedRevision: data.revision, lifetimeHours: hours },
      {
        onSuccess: () => setMessage('success'),
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
                        <p className="text-text-secondary text-xs break-all">
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
                      {target.permittedTools.map((selection) => (
                        <p className="text-text-secondary text-xs" key={selection.agentId}>
                          {selection.agentId}: {selection.tools.join(', ')}
                        </p>
                      ))}
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
                        !Number.isInteger(hours) ||
                        hours < 1 ||
                        hours > data.offer.maxLifetimeHours
                      }
                    >
                      {localize('com_ui_schedule_consent_confirm')}
                    </Button>
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
