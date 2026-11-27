import { useState, useId } from 'react';
import { Button, Input, Label, Spinner, OGDialog, OGDialogTemplate } from '@librechat/client';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type { RunGrantView, ConfirmRunGrant } from 'librechat-data-provider';
import type { MutableRefObject, ReactNode } from 'react';
import type { TranslationKeys } from '~/hooks';
import GrantTools, { useGrantChoice } from './GrantTools';
import { useLocalize } from '~/hooks';

/** Where a grant is read and written: a schedule's, or an API key's for one agent. */
export interface GrantSource {
  query: UseQueryResult<RunGrantView>;
  confirm: UseMutationResult<RunGrantView, unknown, ConfirmRunGrant>;
  revoke: UseMutationResult<void, unknown, string>;
}

/** The words that depend on what holds the grant. Everything else reads the same. */
export interface GrantCopy {
  title: TranslationKeys;
  boundary: TranslationKeys;
  /** Replaces the status line for a state, where the default speaks of schedules. */
  status?: Partial<Record<RunGrantView['state'], TranslationKeys>>;
  /** Replaces the notice that the subject's tools are refused until a grant is made. */
  required?: TranslationKeys;
  confirmed?: TranslationKeys;
}

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

/**
 * The owner's view of one grant: which MCP servers and tools a run may use while nobody is
 * watching. `children` sits above the grant, for whatever picks its subject; `subjectKey`
 * names that subject, so choices made for one are never carried to the next.
 */
export default function GrantDialog({
  canConfirm = true,
  longest = false,
  source,
  copy,
  name,
  children,
  subjectKey,
  onOpenChange,
  triggerRef,
}: {
  canConfirm?: boolean;
  /**
   * Start the lifetime at the longest the operator allows, for a grant whose subject runs for
   * as long as it exists, like a schedule. Otherwise it starts at one hour.
   */
  longest?: boolean;
  source: GrantSource;
  copy: GrantCopy;
  name: string;
  children?: ReactNode;
  subjectKey?: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const localize = useLocalize();
  return (
    <OGDialog open onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <OGDialogTemplate
        title={localize(copy.title)}
        className="w-11/12 max-w-lg"
        main={
          <div className="space-y-4">
            <p className="text-text-primary text-sm">{name}</p>
            <p className="text-text-secondary text-sm">{localize(copy.boundary)}</p>
            {children}
            <Grant
              key={subjectKey}
              canConfirm={canConfirm}
              longest={longest}
              source={source}
              copy={copy}
            />
          </div>
        }
      />
    </OGDialog>
  );
}

/** One subject's grant and the owner's choices for it. */
function Grant({
  canConfirm,
  longest,
  source,
  copy,
}: {
  canConfirm: boolean;
  longest: boolean;
  source: GrantSource;
  copy: GrantCopy;
}) {
  const localize = useLocalize();
  const inputId = useId();
  const { query, confirm, revoke } = source;
  /** Nothing has been asked for yet: the subject is still being chosen. */
  const idle = query.fetchStatus === 'idle' && query.data == null && !query.isError;
  /** Null until the owner types one. `longest` starts at the most the operator allows. */
  const [typed, setHours] = useState<number | null>(null);
  const hours = typed ?? (longest ? query.data?.offer?.maxLifetimeHours : undefined) ?? 1;
  const [message, setMessage] = useState<'success' | 'revoked' | 'error' | null>(null);
  const busy = confirm.isLoading || revoke.isLoading || query.isFetching;
  const data: RunGrantView | undefined = query.data;
  const choosing = canConfirm && data?.offer != null;
  const state = useGrantChoice(data);
  const commit = () => {
    if (!data?.offer || !state.some) return;
    setMessage(null);
    confirm.mutate(
      {
        offerDigest: data.offer.digest,
        expectedRevision: data.revision,
        lifetimeHours: hours,
        ...state.request,
      },
      {
        onSuccess: () => {
          state.reset();
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
    <>
      {!idle && query.isLoading && <Spinner />}
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
          <p role="status">{localize(copy.status?.[data.state] ?? statusKeys[data.state])}</p>
          {data.required && (
            <p className="text-status-warning text-sm">
              {localize(copy.required ?? 'com_ui_schedule_consent_required')}
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
          <GrantTools data={data} choosing={choosing} state={state} busy={busy} />
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
                  !state.some ||
                  !Number.isInteger(hours) ||
                  hours < 1 ||
                  hours > data.offer.maxLifetimeHours
                }
              >
                {localize('com_ui_schedule_consent_confirm')}
              </Button>
              {!state.some && (
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
          {localize(
            message === 'success' && copy.confirmed ? copy.confirmed : messageKeys[message],
          )}
        </p>
      )}
    </>
  );
}
