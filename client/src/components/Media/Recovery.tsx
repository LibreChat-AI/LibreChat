import { useId, useRef, useState } from 'react';
import { v4 } from 'uuid';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { mediaRecoveryRequestSchema } from 'librechat-data-provider';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Label,
  OGDialog,
  OGDialogContent,
  OGDialogDescription,
  OGDialogTitle,
  Radio,
  Spinner,
  Textarea,
} from '@librechat/client';
import type {
  MediaErrorCode,
  MediaRecoveryJob,
  MediaRecoveryRequest,
  MediaWorkerHealth,
} from 'librechat-data-provider';
import type { MediaRecoveryScope } from '~/data-provider';
import { useMediaRecoveryJobs, useMediaRecoveryMutation } from '~/data-provider';
import { mediaErrorLabels, mediaJobPhaseLabels } from './labels';
import { mediaRecoveryFamily } from './state';
import { getMessageTimestamp } from '~/utils';
import { mediaErrorCode } from './commands';
import { useLocalize } from '~/hooks';

const actionLabels = {
  resume: 'com_media_recovery_resume',
  settle: 'com_media_recovery_settle',
  acknowledge: 'com_media_recovery_acknowledge',
} as const;
const actionHints = {
  resume: 'com_media_recovery_resume_hint',
  settle: 'com_media_recovery_settle_hint',
  acknowledge: 'com_media_recovery_acknowledge_hint',
} as const;
const sameJob = (left: MediaRecoveryJob, right: MediaRecoveryJob) =>
  left.ownerId === right.ownerId && left.jobId === right.jobId;

const workerLabels = {
  starting: 'com_media_worker_starting',
  armed: 'com_media_worker_armed',
  draining: 'com_media_worker_draining',
  unavailable: 'com_media_worker_unavailable',
} as const satisfies Record<MediaWorkerHealth['state'], string>;

export default function MediaRecovery({
  host,
  canManage = false,
}: {
  host: MediaRecoveryScope;
  canManage?: boolean;
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MediaRecoveryJob>();
  const [action, setAction] = useState<MediaRecoveryRequest['action']>('resume');
  const [evidence, setEvidence] = useState('');
  const [cost, setCost] = useState('');
  const [terminalStatus, setTerminalStatus] = useState<'failed' | 'cancelled'>('failed');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<MediaErrorCode>();
  const [succeeded, setSucceeded] = useState(false);
  const [pending, setPending] = useAtom(mediaRecoveryFamily(host.scope));
  const jobs = useMediaRecoveryJobs(host, open);
  const mutation = useMediaRecoveryMutation(host);
  const maxEvidenceChars = jobs.data?.pages[0]?.maxEvidenceChars;
  const worker = jobs.data?.pages[0]?.worker;
  const lastScan = getMessageTimestamp(worker?.lastScanAt, i18n.language);
  const forbidden =
    error === 'forbidden' || (jobs.isError && mediaErrorCode(jobs.error) === 'forbidden');
  const saved = selected && pending.find((item) => sameJob(item.job, selected));
  const choices = selected
    ? (Object.keys(actionLabels) as MediaRecoveryRequest['action'][]).filter(
        (value) => selected.allowedActions[value],
      )
    : [];
  const items = new Map(
    jobs.data?.pages
      .flatMap((page) => page.items)
      .map((job) => [JSON.stringify([job.ownerId, job.jobId]), job]),
  );
  for (const item of pending) {
    const key = JSON.stringify([item.job.ownerId, item.job.jobId]);
    if (!items.has(key)) items.set(key, item.job);
  }
  const select = (job: MediaRecoveryJob) => {
    const unresolved = pending.find((item) => sameJob(item.job, job));
    const request = unresolved?.request;
    setSelected(job);
    let fallback: MediaRecoveryRequest['action'] = 'settle';
    if (job.allowedActions.acknowledge) fallback = 'acknowledge';
    if (job.allowedActions.resume) fallback = 'resume';
    setAction(request?.action ?? fallback);
    setEvidence(request?.evidence ?? '');
    setCost(request?.action === 'settle' ? String(request.costUSD) : '');
    setTerminalStatus(request?.action === 'settle' ? request.terminalStatus : 'failed');
    setConfirmed(false);
    setError(undefined);
    setSucceeded(false);
  };
  const validCost = cost.trim() !== '' && Number.isFinite(Number(cost)) && Number(cost) >= 0;
  const valid =
    !!saved ||
    (!!maxEvidenceChars &&
      evidence.trim().length > 0 &&
      evidence.length <= maxEvidenceChars &&
      choices.includes(action) &&
      (action !== 'settle' || (validCost && confirmed)));
  const recover = async () => {
    if (
      !canManage ||
      !selected ||
      !valid ||
      forbidden ||
      inFlight.current ||
      !host.isCurrentSession()
    )
      return;
    let command = saved;
    if (!command) {
      const parsed = mediaRecoveryRequestSchema.safeParse({
        clientRequestId: v4(),
        expectedVersion: selected.version,
        evidence,
        ...(action === 'settle' ? { action, costUSD: Number(cost), terminalStatus } : { action }),
      });
      if (!parsed.success) {
        setError('invalid_request');
        return;
      }
      command = { job: selected, request: parsed.data };
    }
    const dispatched = command;
    inFlight.current = true;
    setPending((previous) => [
      ...previous.filter((item) => !sameJob(item.job, selected)),
      dispatched,
    ]);
    setError(undefined);
    setSucceeded(false);
    try {
      await mutation.mutateAsync(dispatched);
      if (!host.isCurrentSession()) return;
      setPending((previous) =>
        previous.filter(
          (item) => item.request.clientRequestId !== dispatched.request.clientRequestId,
        ),
      );
      setSelected(undefined);
      setSucceeded(true);
    } catch (failure) {
      if (!host.isCurrentSession()) return;
      const code = mediaErrorCode(failure);
      setError(code);
      if (
        code === 'version_conflict' ||
        code === 'invalid_request' ||
        code === 'request_conflict'
      ) {
        setPending((previous) =>
          previous.filter(
            (item) => item.request.clientRequestId !== dispatched.request.clientRequestId,
          ),
        );
        setSelected(undefined);
      }
      void jobs.refetch();
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <div className="flex items-center justify-between gap-4">
      <Label>{localize('com_media_recovery_admin')}</Label>
      <Button ref={trigger} variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {localize('com_media_recovery_open')}
      </Button>
      <OGDialog open={open} onOpenChange={setOpen} triggerRef={trigger}>
        <OGDialogContent className="max-h-[85dvh] max-w-3xl overflow-y-auto">
          <OGDialogTitle>{localize('com_media_recovery_admin')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_media_recovery_description')}</OGDialogDescription>
          {!forbidden && worker && (
            <div className="space-y-1 text-sm" role="status">
              <p>
                {localize('com_media_worker_status')}: {localize(workerLabels[worker.state])}
              </p>
              <p className="text-text-secondary">{localize('com_media_worker_scope')}</p>
              {lastScan && (
                <p>
                  {localize('com_media_worker_last_scan')}:{' '}
                  <time dateTime={lastScan.iso}>{lastScan.absolute}</time>
                </p>
              )}
              {worker.consecutiveScanFailures > 0 && (
                <p>
                  {localize('com_media_worker_failures', { count: worker.consecutiveScanFailures })}
                </p>
              )}
            </div>
          )}
          {(error || jobs.isError) && (
            <Alert variant="error">
              <p>{localize(mediaErrorLabels[error ?? mediaErrorCode(jobs.error)])}</p>
              <Button
                variant="outline"
                onClick={() => {
                  setError(undefined);
                  setSelected(undefined);
                  void jobs.refetch();
                }}
              >
                {localize('com_ui_retry')}
              </Button>
            </Alert>
          )}
          {succeeded && <p role="status">{localize('com_media_recovery_success')}</p>}
          {jobs.isLoading && (
            <p role="status" className="flex items-center gap-2">
              <Spinner className="size-4" />
              {localize('com_media_loading')}
            </p>
          )}
          {!forbidden && selected && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void recover();
              }}
            >
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm break-all">
                <dt>{localize('com_media_recovery_owner')}</dt>
                <dd>{selected.ownerId}</dd>
                <dt>{localize('com_media_recovery_job')}</dt>
                <dd>{selected.jobId}</dd>
                <dt>{localize('com_ui_model')}</dt>
                <dd>{selected.selection.modelId}</dd>
                <dt>{localize('com_media_connection')}</dt>
                <dd>{selected.selection.connectionId}</dd>
                <dt>{localize('com_media_recovery_status')}</dt>
                <dd>{localize(mediaJobPhaseLabels[selected.phase])}</dd>
                {selected.provider.operationId && (
                  <>
                    <dt>{localize('com_media_recovery_provider_operation')}</dt>
                    <dd>{selected.provider.operationId}</dd>
                  </>
                )}
                {selected.provider.requestId && (
                  <>
                    <dt>{localize('com_media_recovery_provider_request')}</dt>
                    <dd>{selected.provider.requestId}</dd>
                  </>
                )}
                {selected.accounting.credits !== undefined && (
                  <>
                    <dt>{localize('com_media_recovery_reserved')}</dt>
                    <dd>{selected.accounting.credits.toLocaleString()}</dd>
                  </>
                )}
              </dl>
              {saved && <Alert variant="warning">{localize('com_media_recovery_uncertain')}</Alert>}
              {!canManage && (
                <p className="text-text-secondary text-sm">
                  {localize('com_media_recovery_read_only')}
                </p>
              )}
              <fieldset
                className="space-y-3"
                disabled={!canManage || mutation.isLoading || !!saved}
              >
                <legend className="mb-2 text-sm font-medium">
                  {localize('com_media_recovery_action')}
                </legend>
                <Radio
                  value={action}
                  onChange={(value) => {
                    if (value === 'resume' || value === 'settle' || value === 'acknowledge') {
                      setAction(value);
                      setConfirmed(false);
                    }
                  }}
                  aria-label={localize('com_media_recovery_action')}
                  options={choices.map((value) => ({
                    value,
                    label: localize(actionLabels[value]),
                  }))}
                />
                <p className="text-text-secondary text-sm">{localize(actionHints[action])}</p>
                <Label htmlFor={`${id}-evidence`}>{localize('com_media_recovery_evidence')}</Label>
                <Textarea
                  id={`${id}-evidence`}
                  required
                  value={evidence}
                  maxLength={maxEvidenceChars}
                  onChange={(event) => setEvidence(event.target.value)}
                />
                {action === 'settle' && (
                  <>
                    <Label htmlFor={`${id}-cost`}>{localize('com_media_recovery_cost')}</Label>
                    <Input
                      id={`${id}-cost`}
                      type="number"
                      min="0"
                      step="any"
                      required
                      value={cost}
                      onChange={(event) => {
                        setCost(event.target.value);
                        setConfirmed(false);
                      }}
                    />
                    <Radio
                      value={terminalStatus}
                      aria-label={localize('com_media_recovery_outcome')}
                      onChange={(value) => {
                        if (value === 'failed' || value === 'cancelled') {
                          setTerminalStatus(value);
                          setConfirmed(false);
                        }
                      }}
                      options={[
                        { value: 'failed', label: localize('com_media_phase_failed') },
                        { value: 'cancelled', label: localize('com_media_phase_cancelled') },
                      ]}
                    />
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id={`${id}-confirm`}
                        aria-labelledby={`${id}-confirm-label`}
                        checked={confirmed}
                        onCheckedChange={(value) => setConfirmed(value === true)}
                      />
                      <Label
                        id={`${id}-confirm-label`}
                        htmlFor={`${id}-confirm`}
                        className="min-w-0 flex-1 leading-snug break-normal"
                      >
                        {validCost
                          ? localize('com_media_recovery_financial_confirm', {
                              amount: Number(cost).toLocaleString(undefined, {
                                style: 'currency',
                                currency: 'USD',
                                maximumFractionDigits: 8,
                              }),
                            })
                          : localize('com_media_recovery_financial_confirm_pending')}
                      </Label>
                    </div>
                  </>
                )}
              </fieldset>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={mutation.isLoading}
                  onClick={() => setSelected(undefined)}
                >
                  {localize('com_ui_back')}
                </Button>
                <Button type="submit" disabled={!canManage || !valid || mutation.isLoading}>
                  {mutation.isLoading && <Spinner className="size-4" />}
                  {localize(saved ? 'com_media_recovery_retry_same' : 'com_media_recovery_apply')}
                </Button>
              </div>
            </form>
          )}
          {!forbidden && !selected && (
            <>
              {jobs.isSuccess && items.size === 0 && (
                <p role="status">{localize('com_media_recovery_empty')}</p>
              )}
              {items.size > 0 && (
                <ul
                  className="divide-border-light divide-y"
                  aria-label={localize('com_media_recovery_admin')}
                >
                  {[...items.values()].map((job) => (
                    <li
                      key={JSON.stringify([job.ownerId, job.jobId])}
                      className="flex items-start justify-between gap-3 py-3"
                    >
                      <div className="min-w-0 break-all">
                        <p className="text-sm font-medium">{job.selection.modelId}</p>
                        <p className="text-text-secondary text-xs">
                          {job.ownerId} · {job.jobId}
                        </p>
                        <p className="text-sm">{localize(mediaJobPhaseLabels[job.phase])}</p>
                      </div>
                      <Button variant="outline" onClick={() => select(job)}>
                        {localize('com_media_recovery_review')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {jobs.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={jobs.isFetchingNextPage}
                  onClick={() => void jobs.fetchNextPage()}
                >
                  {localize('com_ui_load_more')}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={jobs.isFetching}
                onClick={() => void jobs.refetch()}
              >
                {localize('com_ui_refresh')}
              </Button>
            </>
          )}
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
