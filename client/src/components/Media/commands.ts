import { useCallback, useEffect, useState, useRef } from 'react';
import { useAtom, useStore } from 'jotai';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  mediaSubmissionReceiptSchema,
  mediaImportReceiptSchema,
  mediaErrorSchema,
} from 'librechat-data-provider';
import type { MediaErrorCode } from 'librechat-data-provider';
import type { UseQueryOptions } from '@tanstack/react-query';
import type { MediaReceipt } from '~/data-provider';
import type { PendingMedia } from './state';
import { invalidateMedia, mayClearMediaDraft, useMediaCommandMutations } from '~/data-provider';
import { clearSubmittedMediaDraft, submittedMediaThreadDraft } from './draft';
import { mediaDraftFamily, mediaPendingFamily } from './state';
import { useMediaHost } from './host';

export function mediaErrorCode(error: unknown): MediaErrorCode {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'error' in data) {
        const parsed = mediaErrorSchema.safeParse(data.error);
        if (parsed.success) return parsed.data.code;
      }
    }
  }
  return 'internal_error';
}
function definitiveRejection(error: unknown) {
  if (typeof error !== 'object' || error === null || !('response' in error)) return false;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('status' in response)) return false;
  return typeof response.status === 'number' && response.status >= 400 && response.status < 500;
}
const receiptKey = (scope: string, pending: PendingMedia) => [
  pending.kind === 'import' ? QueryKeys.mediaImport : QueryKeys.mediaSubmission,
  scope,
  pending.request.clientRequestId,
];
/** A receipt polls quickly until it settles. A server that answers "no such request" is not
 * going to change its mind, so the loop stops and leaves the entry to be recovered or dismissed;
 * an outage backs off to the catch-up cadence instead of hammering at the poll rate. */
export function receiptInterval(
  data: MediaReceipt | undefined,
  error: unknown,
  intervals: { pollIntervalMs: number; catchUpIntervalMs: number },
): number | false {
  if (data) return data.phase === 'preparing' ? intervals.pollIntervalMs : false;
  if (!error) return intervals.pollIntervalMs;
  return definitiveRejection(error) ? false : intervals.catchUpIntervalMs;
}
export function useMediaCommands(visibleThreadIds: string[]) {
  const host = useMediaHost();
  const client = useQueryClient();
  const store = useStore();
  const { submit, retry, importMedia } = useMediaCommandMutations(host);
  const { mutateAsync: submitAsync } = submit;
  const { mutateAsync: retryAsync } = retry;
  const { mutateAsync: importAsync } = importMedia;
  const [pending, setPending] = useAtom(mediaPendingFamily(host.scope));
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<MediaErrorCode>();
  const observed = useRef(new Map<string, MediaReceipt['phase']>());
  const inFlight = useRef(new Set<string>());
  const attempted = useRef(new Set<string>());
  const seedThreadDraft = useCallback(
    (command: PendingMedia, receipt: MediaReceipt) => {
      if (
        command.kind !== 'submission' ||
        command.after ||
        command.request.threadId ||
        receipt.phase === 'rejected'
      )
        return;
      const target = mediaDraftFamily(`${host.scope}:${receipt.threadId}`);
      const current = store.get(target);
      const implicitDefault =
        current.revision === 1 &&
        Object.keys(current.parameters).every((key) => key === 'count') &&
        !current.providerOptionsText &&
        !current.parameterContexts &&
        !current.compare &&
        current.autoEdit === undefined;
      if (
        (current.revision !== 0 && !implicitDefault) ||
        current.prompt ||
        current.inputs.length ||
        current.assets.length ||
        current.parentTurnId ||
        current.referenceURL
      )
        return;
      store.set(
        target,
        submittedMediaThreadDraft(store.get(mediaDraftFamily(command.draftKey)), command),
      );
    },
    [host.scope, store],
  );
  const queries: UseQueryOptions<MediaReceipt, unknown, MediaReceipt, string[]>[] = pending.map(
    (command) => ({
      queryKey: receiptKey(host.scope, command),
      queryFn: async ({ signal }): Promise<MediaReceipt> => {
        const receipt =
          command.kind === 'import'
            ? mediaImportReceiptSchema.parse(
                await dataService.getMediaImport(command.request.clientRequestId, signal),
              )
            : mediaSubmissionReceiptSchema.parse(
                await dataService.getMediaSubmission(command.request.clientRequestId, signal),
              );
        if (!host.isCurrentSession()) throw new Error('Session ended');
        return receipt;
      },
      retry: false,
      enabled: command.kind !== 'submission' || !command.after || !!command.request.threadId,
      refetchInterval: (data, query) => receiptInterval(data, query.state.error, host),
      refetchIntervalInBackground: false,
    }),
  );
  const receipts = useQueries({ queries });
  const send = useCallback(
    async (input: PendingMedia): Promise<MediaReceipt | undefined> => {
      if (!host.canCreate || !host.isCurrentSession()) return undefined;
      const saved = store.get(mediaPendingFamily(host.scope));
      let command = input;
      /** A rejected receipt is final; sending the same draft again is a new request. */
      let superseded: string | undefined;
      if (input.kind !== 'retry' && !(input.kind === 'submission' && input.after)) {
        const previous = saved.find(
          (item) =>
            item.kind === input.kind &&
            !(item.kind === 'submission' && item.after) &&
            item.draftKey === input.draftKey &&
            item.draftRevision === input.draftRevision,
        );
        const previousReceipt =
          previous && client.getQueryData<MediaReceipt>(receiptKey(host.scope, previous));
        if (previous && previousReceipt?.phase === 'rejected' && previous !== input)
          superseded = previous.request.clientRequestId;
        else command = previous ?? input;
      }
      if (command.kind === 'submission' && command.following) {
        const receipt = client.getQueryData<MediaReceipt>(receiptKey(host.scope, command));
        if (receipt?.phase === 'accepted') {
          const parent = command;
          command = saved.find(
            (item) => item.request.clientRequestId === parent.following!.clientRequestId,
          ) ?? {
            kind: 'submission',
            request: parent.following!,
            after: parent.request.clientRequestId,
            draftKey: parent.draftKey,
            draftRevision: parent.draftRevision,
          };
        }
      }
      if (command.kind === 'submission' && command.after) {
        const after = command.after;
        const parent = saved.find((item) => item.request.clientRequestId === after);
        const receipt = parent && client.getQueryData<MediaReceipt>(receiptKey(host.scope, parent));
        if (receipt?.phase !== 'accepted') return undefined;
        command = {
          ...command,
          request: { ...command.request, threadId: receipt.threadId, temporary: undefined },
        };
      }
      const id = command.request.clientRequestId;
      if (inFlight.current.has(id)) return undefined;
      inFlight.current.add(id);
      attempted.current.add(id);
      const selected = command;
      setPending((current) => {
        const previous = superseded
          ? current.filter(
              (p) =>
                p.request.clientRequestId !== superseded &&
                !(p.kind === 'submission' && p.after === superseded),
            )
          : current;
        const next = previous.some((p) => p.request.clientRequestId === id)
          ? previous.map((p) => (p.request.clientRequestId === id ? selected : p))
          : [...previous, selected];
        if (
          selected.kind !== 'submission' ||
          !selected.following ||
          next.some((p) => p.request.clientRequestId === selected.following!.clientRequestId)
        )
          return next;
        return [
          ...next,
          {
            kind: 'submission',
            request: selected.following,
            after: id,
            draftKey: selected.draftKey,
            draftRevision: selected.draftRevision,
          },
        ];
      });
      setSending((previous) => new Set(previous).add(id));
      setError(undefined);
      try {
        let receipt: MediaReceipt;
        if (command.kind === 'submission') receipt = await submitAsync(command.request);
        else if (command.kind === 'retry')
          receipt = await retryAsync({ jobId: command.jobId, request: command.request });
        else receipt = await importAsync(command.request);
        if (!host.isCurrentSession()) return undefined;
        seedThreadDraft(command, receipt);
        client.setQueryData(receiptKey(host.scope, command), receipt);
        if (receipt.phase === 'rejected') setError(receipt.error.code);
        else if (command.kind !== 'retry' && !command.request.threadId)
          host.openThread(receipt.threadId);
        return receipt;
      } catch (failure) {
        if (host.isCurrentSession()) {
          setError(mediaErrorCode(failure));
          // A rejected command preserves its editable draft. A lost response keeps its identity.
          if (
            definitiveRejection(failure) &&
            !(command.kind === 'submission' && (command.after || command.following))
          )
            setPending((previous) =>
              previous.filter((item) => item.request.clientRequestId !== id),
            );
          else void client.invalidateQueries(receiptKey(host.scope, command));
        }
        return undefined;
      } finally {
        inFlight.current.delete(id);
        if (host.isCurrentSession())
          setSending((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
      }
    },
    [host, client, setPending, store, submitAsync, retryAsync, importAsync, seedThreadDraft],
  );
  useEffect(() => {
    if (!host.isCurrentSession()) return;
    const published = new Set<string>();
    pending.forEach((command, index) => {
      const receipt = receipts[index]?.data;
      if (receipt) seedThreadDraft(command, receipt);
      if (receipt && observed.current.get(command.request.clientRequestId) !== receipt.phase) {
        observed.current.set(command.request.clientRequestId, receipt.phase);
        void invalidateMedia(client, host.scope);
      }
      if (!receipt || receipt.phase !== 'accepted') return;
      if (command.kind === 'submission' && command.after) return;
      if (command.kind === 'submission' && command.following) {
        const nextIndex = pending.findIndex(
          (item) => item.request.clientRequestId === command.following!.clientRequestId,
        );
        const next = pending[nextIndex];
        if (!next || receipts[nextIndex]?.data?.phase !== 'accepted') {
          if (next && !attempted.current.has(next.request.clientRequestId)) void send(next);
          return;
        }
        if (visibleThreadIds.includes(receipt.threadId))
          published.add(next.request.clientRequestId);
      }
      const draftAtom = mediaDraftFamily(command.draftKey);
      const draft = store.get(draftAtom);
      if (mayClearMediaDraft(draft.revision, command.draftRevision, receipt.phase)) {
        store.set(draftAtom, clearSubmittedMediaDraft(draft));
      }
      if (visibleThreadIds.includes(receipt.threadId))
        published.add(command.request.clientRequestId);
    });
    if (published.size)
      setPending((previous) =>
        previous.filter((command) => !published.has(command.request.clientRequestId)),
      );
  }, [pending, receipts, visibleThreadIds, host, setPending, store, client, send, seedThreadDraft]);
  const clearError = useCallback(() => setError(undefined), []);
  return {
    pending,
    receipts,
    sending,
    error,
    clearError,
    send,
    dismiss: (id: string) =>
      setPending((previous) => {
        const selected = previous.find((command) => command.request.clientRequestId === id);
        const parentId = selected?.kind === 'submission' ? (selected.after ?? id) : id;
        return previous.filter(
          (command) =>
            command.request.clientRequestId !== parentId &&
            !(command.kind === 'submission' && command.after === parentId),
        );
      }),
  };
}
