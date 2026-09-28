import { memo, useId, useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { X, Clock, Pencil } from 'lucide-react';
import { useSetAtom, useAtomValue } from 'jotai';
import { useRecoilValue, useRecoilCallback } from 'recoil';
import { Zap, ZapOff, ChevronUp, ChevronDown } from 'lucide';
import { MorphIcon, useToastContext } from '@librechat/client';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { SteeringControls, QueuedMessageContext } from '~/hooks/Chat/useSteering';
import type { SteerReceiptState } from '~/components/Chat/Steering/Receipt';
import type { PendingSteer } from '~/store/families';
import type { MenuEntry } from './SteerMenu';
import {
  RowMenu,
  EscalateNowButton,
  useDefaultToggleEntry,
  useInterruptToggleEntry,
} from './SteerMenu';
import { carriedSteerContext, cn, hydrateFileDeliveryMetadata, usesImagePreview } from '~/utils';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { supportsGenerationProtocolV2, useArmSteerMutation } from '~/data-provider';
import { steerOverlayHeightFamily, escalatingSteerFamily } from '~/store/steer';
import MessageQuotes from '~/components/Chat/Messages/Content/MessageQuotes';
import { QUEUE_ICON, STEER_ICON } from '~/components/Chat/Steering/identity';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { useSteerCancel, useSteerReclaim, useLocalize } from '~/hooks';
import ImagePreview from '~/components/Chat/Input/Files/ImagePreview';
import SteerReceipt from '~/components/Chat/Steering/Receipt';
import { useFileMapContext } from '~/Providers';
import store from '~/store';

/** Restores a message's text into the composer, or refuses (false) when the
 *  composer is occupied / on another chat — see `restoreReclaimedSteer` in
 *  `ChatForm`. Shared by the in-flight cancel and the queued trash safety net. */
export type RestoreToComposer = (
  text: string,
  files: TMessage['files'],
  context: QueuedMessageContext,
  originConversationId: string,
) => boolean;

const splitFiles = (files?: TMessage['files']) => {
  const images: NonNullable<TMessage['files']> = [];
  const others: NonNullable<TMessage['files']> = [];
  for (const file of files ?? []) {
    (usesImagePreview(file) ? images : others).push(file);
  }
  return { images, others };
};

/** Collapsed preview height (px) for a long steer before "Show more". Matched
 *  to the JS overflow check below so the toggle appears exactly when clipped;
 *  the tolerance absorbs the trailing markdown margin so content that fits but
 *  for its own bottom margin does not trip a pointless toggle. */
const STEER_COLLAPSED_MAX_HEIGHT = 128;
const STEER_OVERFLOW_TOLERANCE = 8;
/** Axios has no default request timeout. Bound the UI lock while preserving an
 *  honest unknown outcome; the idempotent arm may still complete server-side. */
const ARM_CONFIRM_TIMEOUT_MS = 10_000;

/** Live-region copy per receipt state, announced on transitions only. */
const RECEIPT_ANNOUNCEMENTS = {
  sending: 'com_ui_steer_sending',
  delivered: 'com_ui_steer_delivered',
  interrupting: 'com_ui_steer_in_flight_preempt',
  applied: 'com_ui_steer_applied_info',
} as const;

/** The control rail flanking a bubble. `py-3` reproduces the bubble's own
 *  first-line band — its `py-2.5` padding, its 1px border, and half the gap
 *  between the 24px control and the taller text line box — so a 24px control
 *  centers on the first line: visually centered beside a one-line steer, and
 *  aligned to the opening line of a tall one rather than adrift in its middle.
 *  `sticky` then keeps it in view while a tall steer scrolls past (the stack
 *  scrolls once it passes 35vh); the matching `pt-2` on the overlay means the
 *  topmost rail already clears the sticky inset, so it is not shoved down at
 *  rest while the rails below it — which never trip the inset — stay put. */
const STEER_CONTROL_RAIL = 'sticky top-2 flex shrink-0 items-center py-3';

type ArmFailure = {
  name?: string;
  response?: { data?: { code?: string } };
};

/** Only a failure without an HTTP response leaves the server-side outcome
 * unknown. An HTTP rejection is a known response and must not replay the arm. */
const isAmbiguousArmFailure = (error: unknown): boolean => {
  const failure = error as ArmFailure | null | undefined;
  return failure?.name !== 'AbortError' && failure?.response == null;
};

const armFailureCode = (error: unknown): string | undefined =>
  (error as ArmFailure | null | undefined)?.response?.data?.code;

/**
 * One steer on its way into the run, anchored above the composer as a message
 * bubble rather than a control chip — the words are already part of the
 * conversation, they just have no in-thread index yet. It leaves on
 * `on_steer_applied`, when the persisted STEER part lands at its authoritative
 * position in the response.
 *
 * Text and attachments render through the same leaves as the applied
 * `SteerPart` (markdown toggle, file preview) so the words don't reformat the
 * moment the server injects them.
 *
 * `sending` is still awaiting its 202 ACK (no server id yet, so nothing to
 * cancel); `pending` is acknowledged and waiting on the next tool-batch
 * boundary. Every control here reclaims the steer from the server queue first,
 * so they are offered only once `pending` — while `sending` there is no id to
 * reclaim with, and the words cannot be held back.
 */
const InFlightSteer = memo(function InFlightSteer({
  steer,
  steering,
  conversationId,
  interruptPending,
  onRestoreToComposer,
}: {
  steer: PendingSteer;
  steering: SteeringControls;
  conversationId: string;
  interruptPending: boolean;
  onRestoreToComposer: RestoreToComposer;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const cancelSteer = useSteerCancel(conversationId);
  const reclaimSteer = useSteerReclaim(conversationId);
  const toggleEntry = useDefaultToggleEntry(steering);
  const interruptToggle = useInterruptToggleEntry();
  const enableUserMsgMarkdown = useRecoilValue<boolean>(store.enableUserMsgMarkdown);
  const activeGenerationCreatedAt = useRecoilValue(
    store.activeGenerationCreatedAtByConvoId(conversationId),
  );
  const activeGenerationProtocolVersion = useRecoilValue(
    store.activeGenerationProtocolVersionByConvoId(conversationId),
  );
  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const [escalationAnnouncement, setEscalationAnnouncement] = useState('');
  const handlePreviewClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  const { images, others } = useMemo(() => splitFiles(steer.files), [steer.files]);
  const sending = steer.status === 'sending';
  const preempting = steer.preempt === true;
  /** This row's own arm request is in flight (the convo-scoped escalating flag
   *  cannot say WHICH row asked). The receipt must react on the click, not the
   *  ACK — the silent round trip is exactly what reads as broken. */
  const [arming, setArming] = useState(false);
  /** An interrupt shows as interrupting even before its confirmation (the
   *  click must react instantly); `confirmed` withholds the check until the
   *  server durably acknowledged the enqueue/arm. A relabelled chip
   *  (`preempt` true past `sending`) IS that confirmation — the SSE
   *  `steer_updated` can deliver it while the arm HTTP response is still in
   *  flight, and the check must not wait out that round trip. */
  let receiptState: SteerReceiptState = 'delivered';
  if (preempting || arming) {
    receiptState = 'interrupting';
  } else if (sending) {
    receiptState = 'sending';
  }
  const receiptConfirmed = preempting ? !sending : !arming;

  /** Mirrors each receipt TRANSITION into the row's polite live region so
   *  keyboard and screen-reader users get the same immediate confirmation the
   *  visible marks give; the initial state is not replayed on mount. */
  const prevReceiptStateRef = useRef(receiptState);
  useEffect(() => {
    if (prevReceiptStateRef.current === receiptState) {
      return;
    }
    prevReceiptStateRef.current = receiptState;
    setEscalationAnnouncement(localize(RECEIPT_ANNOUNCEMENTS[receiptState]));
  }, [receiptState, localize]);

  /** Long steers (several paragraphs) collapse to a preview so the stack stays
   *  scannable; the toggle is offered only once the content actually overflows
   *  the cap. `scrollHeight` reports the full height even while clamped, so the
   *  same check holds whether expanded or not, and the observer re-measures on
   *  the width reflows that change wrapped-line count. */
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = contentRef.current;
    if (el == null) {
      return;
    }
    const measure = () =>
      setOverflowing(el.scrollHeight - STEER_COLLAPSED_MAX_HEIGHT > STEER_OVERFLOW_TOLERANCE);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Relabels the chip in place once the server confirms the durable arm —
   *  same steerId, same position, only the `preempt` flag flips. */
  const markSteerPreempt = useRecoilCallback(
    ({ set }) =>
      (steerId: string, revision: number) =>
        set(store.pendingSteersByConvoId(conversationId), (prev) =>
          prev.map((item) =>
            item.steerId === steerId && revision >= (item.preemptRevision ?? 0)
              ? { ...item, preempt: true, preemptRevision: revision }
              : item,
          ),
        ),
    [conversationId],
  );
  const { mutateAsync: armSteer } = useArmSteerMutation();
  const setEscalating = useSetAtom(escalatingSteerFamily(conversationId));

  /**
   * Escalate this waiting steer to an interrupt: one idempotent server op
   * flips `preempt` on the EXISTING queued item, so its FIFO position, id, and
   * timestamp survive and there is no reclaim window to race. A transport
   * failure is retried once because the first request may have committed even
   * though its response was lost. Every "too late" interleaving (drained,
   * cancelled, run ended or replaced) is the same honest `armed: false`, and
   * the chip is only relabelled on a confirmed durable arm. The escalating
   * flag flips synchronously, before the request: the chip-derived gate cannot
   * see this arm until the response lands, and the other escalation controls
   * advertise "one interrupt at a time".
   */
  const escalate = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const generationCreatedAt =
        steer.generationCreatedAt ?? activeGenerationCreatedAt ?? undefined;
      if (generationCreatedAt == null) {
        return;
      }
      const trigger = event.currentTarget;
      setEscalationAnnouncement('');
      setEscalating(true);
      setArming(true);
      const params = {
        conversationId,
        steerId: steer.steerId,
        ...(generationCreatedAt != null && { generationCreatedAt }),
      };
      const requestArm = async () => {
        let firstResponseWasLost = false;
        let acceptingRetry = true;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const firstAttempt = armSteer(params);
          const attempts =
            activeGenerationProtocolVersion === 2
              ? firstAttempt.catch((error) => {
                  /** If the overall confirmation window already closed, do not let a
                   *  very late rejection launch a detached retry behind the user's
                   *  back. The first request itself may still have committed. */
                  if (!acceptingRetry) {
                    throw error;
                  }
                  if (!isAmbiguousArmFailure(error)) {
                    throw error;
                  }
                  firstResponseWasLost = true;
                  return armSteer(params);
                })
              : firstAttempt;
          const response = await Promise.race([
            attempts,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Steer arm confirmation timed out')),
                ARM_CONFIRM_TIMEOUT_MS,
              );
            }),
          ]);
          const responseSupportsNegotiatedProtocol =
            activeGenerationProtocolVersion === 1 || supportsGenerationProtocolV2(response);
          if (responseSupportsNegotiatedProtocol && response.armed === true) {
            /** The successful state removes the arm button. Move focus to the
             * stable options control only if the user has not moved elsewhere
             * while the request was pending. */
            if (document.activeElement === trigger) {
              optionsButtonRef.current?.focus();
            }
            setEscalationAnnouncement(localize('com_ui_steer_in_flight_preempt'));
            markSteerPreempt(steer.steerId, response.preemptRevision ?? 0);
            return;
          }
          if (!responseSupportsNegotiatedProtocol) {
            showToast({ message: localize('com_ui_steer_arm_unconfirmed'), status: 'warning' });
            return;
          }
          /** Once a response was lost, a later `armed: false` cannot prove the
           *  first request did not commit: the steer may have drained or the job
           *  may have paused between attempts. Keep the chip event-driven and
           *  report the result as unknown instead of claiming a lost race. */
          if (firstResponseWasLost) {
            showToast({ message: localize('com_ui_steer_arm_unconfirmed'), status: 'warning' });
            return;
          }
          /* `armed: false` is deliberately ambiguous — injected, cancelled,
           * re-homed, or run over — so the message only says the escalation
           * lost, and the chip defers to the events for what happened. */
          showToast({
            message: localize(
              response.code === 'PREEMPT_UNSUPPORTED'
                ? 'com_ui_steer_preempt_unsupported'
                : 'com_ui_steer_arm_lost_race',
            ),
            status: 'info',
          });
        } catch (error) {
          const ambiguous = isAmbiguousArmFailure(error);
          if (ambiguous) {
            showToast({
              message: localize('com_ui_steer_arm_unconfirmed'),
              status: 'warning',
            });
            return;
          }
          showToast({
            message: localize(
              armFailureCode(error) === 'PREEMPT_UNSUPPORTED'
                ? 'com_ui_steer_preempt_unsupported'
                : 'com_ui_steer_arm_lost_race',
            ),
            status: 'info',
          });
        } finally {
          acceptingRetry = false;
          clearTimeout(timeout);
        }
      };
      void requestArm().finally(() => {
        setEscalating(false);
        setArming(false);
      });
    },
    [
      armSteer,
      conversationId,
      steer.steerId,
      steer.generationCreatedAt,
      activeGenerationCreatedAt,
      activeGenerationProtocolVersion,
      setEscalating,
      markSteerPreempt,
      showToast,
      localize,
    ],
  );

  /**
   * Takes the steer back off the server queue so its words can be re-homed.
   * The chip is left alone until the answer is known: only `reclaimed` proves
   * the words never entered the run, and the re-homing callers below own the
   * removal from there.
   */
  const reclaim = useCallback(async (): Promise<boolean> => {
    const outcome = await reclaimSteer(steer);
    if (outcome === 'reclaimed') {
      return true;
    }
    showToast({
      message: localize(
        outcome === 'applied' ? 'com_ui_steer_already_applied' : 'com_ui_steer_cancel_failed',
      ),
      status: outcome === 'applied' ? 'info' : 'error',
    });
    return false;
  }, [reclaimSteer, steer, showToast, localize]);

  const entries: MenuEntry[] = [
    {
      key: 'edit',
      label: localize('com_ui_edit_message'),
      icon: <Pencil className="h-4 w-4" aria-hidden="true" />,
      onClick: () => {
        void reclaim().then((reclaimed) => {
          if (!reclaimed) {
            return;
          }
          const restored = onRestoreToComposer(
            steer.text,
            steer.files,
            carriedSteerContext(steer),
            conversationId,
          );
          if (restored) {
            steering.removeSteer(steer.steerId);
            return;
          }
          /* The composer moved on while the reclaim was in flight. The words
           * are already off the server, so queue them rather than overwrite a
           * newer draft — neither text is the one to throw away. */
          steering.queueReclaimedSteer(steer);
          showToast({ message: localize('com_ui_steer_edit_queued'), status: 'info' });
        });
      },
    },
    {
      /* Non-destructive, but only when it is safe: cancel reliably first (the
       * optimistic hook removes the chip and restores it if the server would
       * still inject), then hand the words back to the composer ONLY on a
       * `reclaimed` outcome. On `applied` (cancel lost the race) or `failed`
       * the steer may still reach the run, so restoring would duplicate the
       * text — in the response, or beside the restored bubble. The gated
       * restore also refuses rather than clobber a draft typed meanwhile. */
      key: 'cancel',
      label: localize('com_ui_steer_cancel'),
      icon: <X className="h-4 w-4" aria-hidden="true" />,
      onClick: () => {
        void cancelSteer(steer).then((outcome) => {
          if (outcome !== 'reclaimed') {
            return;
          }
          // useSteerReclaim has tombstoned both ids and removed any terminal
          // recovery copy, so exactly one client destination is restored here.
          const restored = onRestoreToComposer(
            steer.text,
            steer.files,
            carriedSteerContext(steer),
            conversationId,
          );
          if (!restored) {
            /* Reclaimed, but the composer moved on (draft typed, answer mode,
             * navigated). The chip is already gone, so queue the words as Edit
             * does rather than drop them — never lost, just re-homed. */
            steering.queueReclaimedSteer(steer);
            showToast({ message: localize('com_ui_steer_edit_queued'), status: 'info' });
          }
        });
      },
    },
    {
      key: 'queue',
      label: localize('com_ui_convert_to_queue'),
      icon: <Clock className={cn('h-4 w-4', QUEUE_ICON)} aria-hidden="true" />,
      onClick: () => {
        void reclaim().then((reclaimed) => {
          if (reclaimed) {
            steering.queueReclaimedSteer(steer);
          }
        });
      },
    },
  ];
  const preferences: MenuEntry[] = [toggleEntry, interruptToggle];

  return (
    <div
      role="listitem"
      data-testid="in-flight-steer"
      data-steer-status={steer.status}
      data-steer-preempt={preempting ? 'true' : undefined}
      /* pointer-events-auto: the overlay container disables events so wheeling
       * over the gaps reaches the messages behind; each bubble re-enables them
       * for its own controls and internal scroll. */
      className="group pointer-events-auto flex max-w-full flex-col items-end gap-1.5"
    >
      {(images.length > 0 || others.length > 0) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {others.map((file) => (
            <FileContainer
              key={file.file_id}
              file={file as TFile}
              onClick={() => setSelectedFile(file)}
            />
          ))}
          {images.map((file) => (
            <div
              key={file.file_id}
              className="overflow-hidden rounded-xl border border-border-light"
            >
              <ImagePreview
                url={file.preview ?? file.filepath}
                alt={file.filename ?? localize('com_ui_attached_image')}
              />
            </div>
          ))}
        </div>
      )}
      {/* Mirrors the user turn: the whole group hugs the right edge like every
       *  other message the user wrote. The two controls flank the bubble rather
       *  than stacking beside each other — the overflow menu outboard-left, the
       *  send-now arrow outboard-right — so neither can read as belonging to
       *  the other, and the pairing repeats cleanly when steers stack.
       *  items-start so the sticky controls have room to travel — see below. */}
      <div className="flex max-w-full items-start gap-1.5">
        {!sending && (
          /* One always-visible affordance: a label-less menu hidden until hover
           * is undiscoverable, and edit/queue/cancel all live inside it now, so
           * the menu shows at rest on every pointer (matching the always-on
           * controls on the queued rows). `sticky` keeps it in view while the
           * user scrolls through a tall, expanded steer (the stack scrolls once
           * it passes 35vh). */
          <div data-testid="steer-controls" className={cn(STEER_CONTROL_RAIL, 'gap-1')}>
            <RowMenu
              label={localize('com_ui_more_options')}
              entries={entries}
              preferences={preferences}
              buttonRef={optionsButtonRef}
            />
          </div>
        )}
        <div
          className={cn(
            /* Same bubble geometry as the applied `SteerPart` and every user
             * turn, so the words don't reshape when the server injects them. */
            'flex min-w-0 items-start gap-2 rounded-theme-surface rounded-br-theme-control',
            /* Outlined, not just filled: an in-flight steer is provisional —
             * the fill alone reads as a settled message. */
            'border border-border-medium bg-surface-secondary',
            'px-theme-normal py-2.5 text-sm text-text-primary',
            sending && 'opacity-70',
          )}
        >
          <MorphIcon
            icon={preempting ? ZapOff : Zap}
            className={cn('mt-1 h-3.5 w-3.5 shrink-0', STEER_ICON)}
          />
          <span className="sr-only">
            {localize(preempting ? 'com_ui_steer_in_flight_preempt' : 'com_ui_steer_in_flight')}
          </span>
          <div className="flex min-w-0 flex-col items-start gap-1">
            {/* Same reference blocks the applied `SteerPart` shows, outside the
             *  collapse so the excerpts stay visible while a long steer clips. */}
            <MessageQuotes quotes={steer.quotes} />
            <div
              ref={contentRef}
              id={contentId}
              className={cn('relative w-full', !expanded && 'overflow-hidden')}
              style={!expanded ? { maxHeight: STEER_COLLAPSED_MAX_HEIGHT } : undefined}
            >
              <div
                className={cn(
                  'markdown prose message-content dark:prose-invert light min-w-0 break-words',
                  'dark:text-gray-20',
                  !enableUserMsgMarkdown && 'whitespace-pre-wrap',
                )}
              >
                {/* No code execution: this bubble sits outside MessageContext, so
                 *  Run Code would fire with no message/part to target. */}
                {enableUserMsgMarkdown ? (
                  <MarkdownLite content={steer.text} codeExecution={false} />
                ) : (
                  steer.text
                )}
              </div>
              {!expanded && overflowing && (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-secondary to-transparent"
                  aria-hidden="true"
                />
              )}
            </div>
            {overflowing && (
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-controls={contentId}
                className="inline-flex items-center gap-1 rounded text-xs font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy"
              >
                <MorphIcon icon={expanded ? ChevronUp : ChevronDown} className="h-3.5 w-3.5" />
                {expanded ? localize('com_ui_show_less') : localize('com_ui_show_more')}
              </button>
            )}
          </div>
        </div>
        {!sending && !preempting && (
          /* Sticky for the same reason as the menu: a tall, expanded steer must
           * never scroll its send-now out of reach. */
          <div className={STEER_CONTROL_RAIL}>
            <EscalateNowButton
              surface="bubble"
              messageText={steer.text}
              disabled={interruptPending || steering.pausedOnApproval || !steering.duringRunActive}
              onClick={escalate}
            />
          </div>
        )}
      </div>
      {/* Delivery receipt under the bubble, iMessage-style: present from the
       *  first frame so the status never flickers in from nothing, and every
       *  advance (Sending → Delivered ✓ → Interrupting) is an event the server
       *  actually confirmed. The margin re-aligns it under the bubble's right
       *  edge when the outboard send-now rail (24px control + 6px gap) is
       *  present; the rail hides while sending or already escalated. */}
      <SteerReceipt
        state={receiptState}
        confirmed={receiptConfirmed}
        className={!sending && !preempting ? 'mr-[30px]' : undefined}
      />
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {escalationAnnouncement}
      </span>
      {others.length > 0 && (
        <FilePreviewDialog
          open={selectedFile !== null}
          onOpenChange={handlePreviewClose}
          fileName={selectedFile?.filename ?? ''}
          fileId={selectedFile?.file_id}
          filePath={selectedFile?.filepath}
          fileType={selectedFile?.type ?? undefined}
          fileSource={selectedFile?.source}
          fileSize={(selectedFile as TFile | null)?.bytes}
          deliveryPath={selectedFile?.llmDeliveryPath}
        />
      )}
    </div>
  );
});

/**
 * Steers the server hasn't applied yet, stacked directly above the composer.
 * Anchoring them here (instead of guessing an in-thread injection point on the
 * streaming message) keeps the thread showing only what the server actually
 * committed, while the user still sees their words land somewhere stable.
 */
const InFlightSteers = memo(function InFlightSteers({
  steering,
  conversationId,
  onRestoreToComposer,
}: {
  steering: SteeringControls;
  conversationId: string;
  onRestoreToComposer: RestoreToComposer;
}) {
  const localize = useLocalize();
  const steers = useRecoilValue(store.pendingSteersByConvoId(conversationId));
  const fileMap = useFileMapContext();
  const inFlight = useMemo(
    () =>
      steers
        .filter((steer) => steer.status !== 'failed')
        .map((steer) => {
          const files = hydrateFileDeliveryMetadata(steer.files, undefined, fileMap);
          return files === steer.files ? steer : { ...steer, files };
        }),
    [fileMap, steers],
  );
  /** Mirrors `PendingSteerChips`: while one interrupt is unresolved, every
   *  other escalation control disables rather than arming a second seal. The
   *  escalating flag covers an arm request's round trip, before its chip
   *  relabels for the chip-derived check to see. */
  const escalating = useAtomValue(escalatingSteerFamily(conversationId));
  const interruptPending = useMemo(
    () => escalating || inFlight.some((steer) => steer.preempt === true),
    [escalating, inFlight],
  );
  const setOverlayHeight = useSetAtom(steerOverlayHeightFamily(conversationId));

  /** Steers append newest-last, so an overflowing stack would sit scrolled to
   *  the oldest — the steer just submitted (and its cancel) would be below the
   *  fold and read as dropped. Keyed on the newest id, not every render. */
  const listRef = useRef<HTMLDivElement>(null);
  const newestId = inFlight[inFlight.length - 1]?.steerId;
  useEffect(() => {
    const list = listRef.current;
    if (list != null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [newestId]);

  /** The overlay is pulled out of flow (absolute), so the messages no longer
   *  shrink to fit it. Publish its rendered height so the message scroll area
   *  can reserve an equal band of bottom padding — keeping the newest message
   *  clear of the overlay at rest while older ones scroll behind it. */
  useEffect(() => {
    const list = listRef.current;
    if (list == null) {
      setOverlayHeight(0);
      return;
    }
    const publish = () => setOverlayHeight(list.offsetHeight);
    publish();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publish);
    observer.observe(list);
    return () => observer.disconnect();
  }, [setOverlayHeight, inFlight.length]);

  /** Drop the reserved band when the overlay leaves (run ends while steers are
   *  still in flight, or conversation switch) — the measure effect above only
   *  resets when it re-runs, which unmount does not do. */
  useEffect(() => () => setOverlayHeight(0), [setOverlayHeight]);

  if (inFlight.length === 0) {
    return null;
  }

  return (
    <div
      ref={listRef}
      role="list"
      aria-label={localize('com_ui_steer_in_flight')}
      data-testid="in-flight-steers"
      /* Floats above the composer over the bottom of the thread instead of
       * displacing it, so scrolling up reveals the messages behind. Height is
       * capped: a steer runs to 16k chars and a run takes up to 10 of them;
       * unbounded it would cover the whole thread. Width is not — `inset-x-0`
       * takes the width of the composer the steer was typed into, so the stack
       * ends where that composer ends at every desktop width (`xl:max-w-4xl`,
       * maximized chat space) instead of drifting inboard against a second,
       * narrower cap of its own; `p-2` then lands the send-now arrow in the
       * same column as the composer's own send button (`mr-2` + border).
       * pointer-events-none lets wheeling over the gaps reach those messages
       * (each bubble opts back in). */
      className="pointer-events-none absolute inset-x-0 bottom-full flex max-h-[35vh] flex-col items-end gap-2 overflow-y-auto p-2"
    >
      {inFlight.map((steer) => (
        <InFlightSteer
          key={steer.steerId}
          steer={steer}
          steering={steering}
          conversationId={conversationId}
          interruptPending={interruptPending}
          onRestoreToComposer={onRestoreToComposer}
        />
      ))}
    </div>
  );
});

export default InFlightSteers;
