import { useEffect, useRef } from 'react';
import { useRecoilCallback, useSetRecoilState } from 'recoil';
import type { TAttachment, TFile, TFilePreview } from 'librechat-data-provider';
import { useMessageContext } from '~/Providers/MessageContext';
import { useFilePreview } from '~/data-provider';
import { useShareContext } from '~/Providers';
import store from '~/store';

interface UseAttachmentPreviewSyncResult {
  /**
   * Effective lifecycle status: `'pending'` while background HTML
   * extraction is in flight, `'ready'` once it completes successfully
   * (or for legacy / non-office files that never had a status), and
   * `'failed'` when extraction errored or hit the 60s ceiling. Drives
   * UI state (spinner, badge, etc.) without callers needing to read
   * the attachment shape directly.
   */
  status: 'pending' | 'ready' | 'failed';
  /** Short machine-readable failure reason from the backend. */
  previewError?: string;
  /** True while React Query is actively polling the preview endpoint. */
  isPolling: boolean;
}

/**
 * Bridge the deferred-preview code-execution lifecycle to the
 * attachment cache.
 *
 * The immediate persist step (in callbacks.js + processCodeOutput)
 * emits the attachment record at `status: 'pending'` so the agent's
 * response stops blocking on extraction. The background render runs
 * separately; if the SSE stream is still open when it lands, an
 * `attachment` update event arrives and the SSE handler upserts by
 * `file_id`. If the stream has already closed (the model finished
 * generating before the render resolved), this hook covers the gap by
 * polling `GET /api/files/:file_id/preview` and writing the resolved
 * record back into `messageAttachmentsMap` — which triggers
 * re-classification through `artifactTypeForAttachment`, so the file
 * chip transitions from a plain download to the rich preview card
 * (or to a download-with-error state) without remounting.
 *
 * Polling is gated on:
 *   - `attachment.file_id` present (no id → nothing to poll for)
 *   - Effective status is `'pending'` (terminal states need no work).
 *     `useFilePreview`'s `refetchInterval` returns `false` the moment
 *     the server reports `ready`/`failed`, so polling auto-terminates
 *     within one tick of resolution. Bounded ceiling: the server-side
 *     render timeout is 60s, so a stuck pending record gets ~24 polls
 *     max before the lazy sweep in the preview endpoint forces it to
 *     `'failed'`.
 *
 * NOTE: an earlier version of this hook also gated on `isAnySubmitting`
 * (the LLM still generating). That gate was removed because the
 * deferred render can complete *after* the SSE stream closes — when it
 * does, the SSE update is silently dropped, and polling is the only
 * recovery path. With the gate in place, the chip would stay stuck on
 * "Preparing preview…" forever (until manual refresh) for any render
 * that landed even seconds after submission ended. The polling itself
 * doesn't block UX; the user can keep messaging regardless.
 */
export default function useAttachmentPreviewSync(
  attachment: TAttachment | undefined,
): UseAttachmentPreviewSyncResult {
  const setAttachmentsMap = useSetRecoilState(store.messageAttachmentsMap);
  const { isSubmitting, messageId: contextMessageId } = useMessageContext();
  /* `useRecoilCallback` writes without subscribing this hook to
   * another message or file's pending→ready flag. */
  const flagJustResolved = useRecoilCallback(
    ({ set }) =>
      (ownerId: string, id: string) => {
        set(store.previewJustResolved([ownerId, id]), true);
      },
    [],
  );
  const file = (attachment ?? undefined) as Partial<TFile> | undefined;
  const fileId = file?.file_id;
  const baseStatus: 'pending' | 'ready' | 'failed' = file?.status ?? 'ready';
  const messageId = (attachment as Partial<TAttachment> | undefined)?.messageId;
  const ownerMessageId = contextMessageId || messageId;
  /** A reused row must observe the pending→ready edge for its current owner, not its last one. */
  const streamRef = useRef({
    ownerMessageId,
    fileId,
    wasSubmitting: isSubmitting === true,
    previousStatus: null as 'pending' | 'ready' | 'failed' | null,
  });
  if (streamRef.current.ownerMessageId !== ownerMessageId || streamRef.current.fileId !== fileId) {
    streamRef.current = {
      ownerMessageId,
      fileId,
      wasSubmitting: isSubmitting === true,
      previousStatus: null,
    };
  }

  const { shareId } = useShareContext();
  const enabled = !!fileId && baseStatus === 'pending';

  const previewQuery = useFilePreview(fileId, { enabled }, shareId);

  /* Effective status: prefer the polled record once it arrives, since
   * the SSE handler may have already moved the cache forward and the
   * `attachment` prop will catch up on the next render anyway. */
  const polled = previewQuery.data as TFilePreview | undefined;
  const effectiveStatus: 'pending' | 'ready' | 'failed' = polled?.status ?? baseStatus;
  const previewError = polled?.previewError ?? file?.previewError;

  /* Track the previous effective status so we can fire the
   * pending→ready edge for the owning message and file. Two gates have to
   * pass for the auto-open flag to flip:
   *   1. We actually observed the transition (prev → curr).
   *   2. This message mounted during its own active stream, not a
   *      historical sibling displayed while another turn submits. A
   *      page-navigation mount (or refresh) of a stale-pending DB
   *      record will see the same transition when polling catches
   *      up, but we must NOT auto-open in that case — the user is
   *      revisiting old work, not waiting on a fresh result.
   * The per-owner ref is reset before the effect when a different message
   * or file takes this row, so a transition from the previous owner
   * cannot be mistaken for a fresh preview. */
  useEffect(() => {
    const prev = streamRef.current.previousStatus;
    streamRef.current.previousStatus = effectiveStatus;
    if (
      prev === 'pending' &&
      effectiveStatus === 'ready' &&
      fileId &&
      ownerMessageId &&
      streamRef.current.wasSubmitting
    ) {
      flagJustResolved(ownerMessageId, fileId);
    }
  }, [effectiveStatus, fileId, ownerMessageId, flagJustResolved]);

  /* On a terminal poll response (ready or failed), upsert into the
   * shared attachments map. Mirrors the SSE handler's by-file_id
   * upsert (`useAttachmentHandler`) — the attachment object is
   * patched in place so siblings sharing the same atom re-render
   * with the resolved data and `artifactTypeForAttachment` re-runs
   * its empty-text gate, transitioning the file chip into a panel
   * artifact card.
   *
   * Two paths:
   *   1. Live SSE flow (active turn): the SSE handler already wrote
   *      the attachment into messageAttachmentsMap. `existingIndex`
   *      finds it; we patch in place.
   *   2. Loaded conversation (no SSE): the message's `attachments`
   *      come from the DB (frozen at the immediate-persist state of
   *      `status: 'pending'`); messageAttachmentsMap is empty for
   *      this messageId. `existingIndex` is `-1`. We INSERT a new
   *      entry that overlays the polled fields onto the original
   *      `attachment` prop. `useAttachments` (the hook the renderer
   *      reads through) merges live entries onto DB entries by
   *      `file_id`, so the inserted entry takes precedence and the
   *      parent re-routes to the proper PanelArtifact card. */
  useEffect(() => {
    if (!polled || polled.status === 'pending' || !messageId || !fileId || !attachment) {
      return;
    }
    /* Idempotency gate. `useAttachments` re-derives `attachment` with a
     * fresh object identity on every messageAttachmentsMap write, and
     * `attachment` is in this effect's deps — so without a gate the
     * write-back ping-pongs forever (setAttachmentsMap → re-derive →
     * effect → setAttachmentsMap …), tripping React's "Maximum update
     * depth exceeded" (#185) once the preview resolves on a loaded
     * conversation. Once the merged attachment already carries the
     * resolved fields, there's nothing to write — stop. */
    const current = attachment as Partial<TFile> & TAttachment;
    const nextText = polled.text ?? current.text ?? null;
    const nextTextFormat = polled.textFormat ?? current.textFormat ?? null;
    if (
      current.status === polled.status &&
      current.text === nextText &&
      current.textFormat === nextTextFormat &&
      current.previewError === polled.previewError
    ) {
      return;
    }
    setAttachmentsMap((prevMap) => {
      const messageAttachments =
        (prevMap as Record<string, TAttachment[] | undefined>)[messageId] || [];
      const resolvedFields = {
        status: polled.status,
        text: polled.text ?? null,
        textFormat: polled.textFormat ?? null,
        previewError: polled.previewError,
      };
      /* Fan out to EVERY entry sharing this file_id: sibling tool calls
       * (or handoff agents) can legitimately hold the same claimed file,
       * and the preview is a per-file result — patching only the first
       * match would leave the other cards stuck on `pending`. */
      let found = false;
      const merged = messageAttachments.map((a) => {
        if ((a as Partial<TFile>).file_id !== fileId) {
          return a;
        }
        found = true;
        const existing = a as Partial<TFile> & TAttachment;
        return {
          ...existing,
          ...resolvedFields,
          text: polled.text ?? existing.text ?? null,
          textFormat: polled.textFormat ?? existing.textFormat ?? null,
        } as TAttachment;
      });
      if (found) {
        return { ...prevMap, [messageId]: merged };
      }
      const inserted = { ...attachment, ...resolvedFields } as TAttachment;
      return { ...prevMap, [messageId]: [...messageAttachments, inserted] };
    });
  }, [polled, fileId, messageId, attachment, setAttachmentsMap]);

  return {
    status: effectiveStatus,
    previewError,
    isPolling: enabled && previewQuery.isFetching,
  };
}
