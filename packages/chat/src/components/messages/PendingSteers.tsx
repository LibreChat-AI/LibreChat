import { memo, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Clock, TextQuote, X } from 'lucide-react';
import { Button, TooltipAnchor, useLocalize } from '@librechat/client';
import type { ReactElement, NamedExoticComponent } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { SteerReceiptState } from '../composer/steering/Receipt';
import useSteerCancel, {
  useSteerMoveToQueue,
  useSteerRehome,
} from '../../react/steering/useSteerCancel';
import { hasLiveRunPause, isLegacyDeliveryUncertain } from '../../core';
import useSteerRecovery from '../../react/steering/useSteerRecovery';
import useSteerEscalate from '../../react/steering/useSteerEscalate';
import { pendingSteersByConvoId } from '../../react/steer/atoms';
import EscalateNowButton from '../composer/EscalateNowButton';
import { useMessagesHost } from '../../react/messages/host';
import { useMessagePartsHost } from '../../react/host';
import { useBranchTail } from '../../react/latest';
import { getMessageRowWidthClass } from './width';
import SteerPart from '../parts/SteerPart';

/** Steers the server has not confirmed, at the tail of the reply they will join.
 *  Confirmation swaps them for the real steer part, so the row holds the place
 *  and says it is provisional. */
export interface PendingSteersProps {
  conversationId: string;
  /** The pane rendering this tree. Its sibling selection is the branch the pause
   *  check reads; another pane's selection would get that wrong. */
  index?: number;
  fullWidth?: boolean;
}

/** Whether escalation must stay off. A multi-message cache follows the branch on
 *  screen once this pane owns the conversation, and any branch until then. A
 *  one-message cache is that branch. */
function resolvePaused(
  cachedMessages: TMessage[],
  paneConversationId: string | null,
  conversationId: string,
  latestMessage: TMessage | null,
  fallbackPaused: boolean | undefined,
): boolean {
  if (cachedMessages.length > 1) {
    if (paneConversationId === conversationId && latestMessage != null) {
      return hasLiveRunPause(latestMessage);
    }
    return cachedMessages.some((message) => hasLiveRunPause(message));
  }
  if (fallbackPaused != null) {
    return fallbackPaused;
  }
  return cachedMessages.length === 1 && hasLiveRunPause(cachedMessages[0]);
}

function PendingSteers({
  conversationId,
  index = 0,
  fullWidth = false,
}: PendingSteersProps): ReactElement | null {
  const localize = useLocalize();
  const { useToast, useSteerEscalating, usePaneConversationId } = useMessagePartsHost();
  const showToast = useToast();
  const steers = useAtomValue(pendingSteersByConvoId(conversationId));
  const { retry, sendAsNew } = useSteerRecovery(conversationId);
  const cancelSteer = useSteerCancel(conversationId);
  const escalate = useSteerEscalate(conversationId);
  const moveToQueue = useSteerMoveToQueue(conversationId);
  const rehomeSteer = useSteerRehome(conversationId);
  const [movingId, setMovingId] = useState<string | null>(null);
  const escalating = useSteerEscalating(conversationId);
  const paneConversationId = usePaneConversationId(index);
  const cached = useMessagesHost().useConversationMessages(conversationId, true);
  const latestMessage = useBranchTail(
    paneConversationId,
    paneConversationId ? conversationId : null,
  );
  /** Arming removes the control that was activated, so the row's Cancel button
   *  (which survives the `preempt` flip) is where keyboard focus goes next. */
  const cancelButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const interruptPending = useMemo(
    () => escalating || steers.some((steer) => steer.preempt === true && steer.status !== 'failed'),
    [escalating, steers],
  );

  if (steers.length === 0) {
    return null;
  }
  /** Read only with a steer to show. This row follows the conversation's messages, so it
   *  renders for every streamed delta, and the pause check walks every part of every message:
   *  with nothing pending that walk would run for each delta of each run, for no row. */
  const cachedMessages = cached ?? [];
  const fallbackPaused = cached == null ? undefined : hasLiveRunPause(cached);
  const paused = resolvePaused(
    cachedMessages,
    paneConversationId,
    conversationId,
    latestMessage,
    fallbackPaused,
  );

  const queueSteer = async (steer: (typeof steers)[number]) => {
    if (movingId != null) {
      return;
    }
    setMovingId(steer.steerId);
    try {
      const outcome = await moveToQueue(steer);
      if (outcome === 'applied') {
        showToast({ message: localize('com_ui_steer_already_applied'), status: 'info' });
      } else if (outcome === 'failed') {
        showToast({ message: localize('com_ui_steer_cancel_failed'), status: 'error' });
      }
    } finally {
      setMovingId(null);
    }
  };
  /** A definitively rejected steer can be corrected: the whole message comes
   *  back through the shared recovery boundary, so its attachments, quoted
   *  excerpts and skill picks come with it. Withheld while delivery is
   *  uncertain, like every other action that assumes the server does not hold
   *  these words. */
  const editFailedSteer = (steer: (typeof steers)[number]) => {
    if (rehomeSteer(steer, { rejectedByServer: true }) === 'queue') {
      showToast({ message: localize('com_ui_steer_moved_to_queue'), status: 'info' });
    }
  };
  const cancelPendingSteer = async (steer: (typeof steers)[number]) => {
    if (movingId != null) {
      return;
    }
    setMovingId(steer.steerId);
    try {
      const outcome = await cancelSteer(steer);
      if (outcome === 'applied') {
        showToast({ message: localize('com_ui_steer_already_applied'), status: 'info' });
      } else if (outcome === 'failed') {
        showToast({ message: localize('com_ui_steer_cancel_failed'), status: 'error' });
      }
    } finally {
      setMovingId(null);
    }
  };

  return (
    <div
      role="list"
      aria-label={localize('com_ui_steer_in_flight')}
      className={`mx-auto min-w-0 px-4 ${getMessageRowWidthClass({ fullWidth })}`}
      data-testid="pending-steers"
    >
      {steers.map((steer) => {
        const deliveryUncertain = steer.deliveryUncertain === true;
        const retrySafe = !isLegacyDeliveryUncertain(steer);
        const quoteCount = steer.quotes?.length ?? 0;
        let receiptState: SteerReceiptState = 'delivered';
        if (steer.status === 'sending') {
          receiptState = 'sending';
        } else if (steer.preempt === true) {
          receiptState = 'interrupting';
        }
        return (
          <div key={steer.steerId} role="listitem">
            <SteerPart
              steer={steer.text}
              files={steer.files}
              steerId={steer.steerId}
              createdAt={steer.createdAt}
              receiptState={steer.status === 'failed' ? null : receiptState}
            />
            {steer.status === 'failed' ? (
              <div className="-mt-2 mb-2 flex flex-wrap items-center justify-end gap-3 text-xs">
                {quoteCount > 0 && (
                  <span className="text-text-secondary flex items-center gap-0.5">
                    <TextQuote className="h-3.5 w-3.5" aria-hidden="true" />
                    <span aria-hidden="true">{quoteCount}</span>
                    <span className="sr-only">
                      {localize('com_ui_queued_quote_count', { 0: String(quoteCount) })}
                    </span>
                  </span>
                )}
                <span className="text-text-destructive">
                  {localize(
                    deliveryUncertain
                      ? 'com_ui_steer_delivery_uncertain'
                      : 'com_ui_steer_failed_inline',
                  )}
                </span>
                {retrySafe && (
                  <Button type="button" onClick={() => retry(steer.steerId)} variant="text-action">
                    {localize('com_ui_retry')}
                  </Button>
                )}
                {!deliveryUncertain && (
                  <Button
                    type="button"
                    onClick={() => editFailedSteer(steer)}
                    variant="text-action"
                  >
                    {localize('com_ui_edit')}
                  </Button>
                )}
                {!deliveryUncertain && (
                  <Button
                    type="button"
                    onClick={() => sendAsNew(steer.steerId)}
                    variant="text-action"
                  >
                    {localize('com_ui_send_as_new')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="text-text-secondary -mt-2 mb-2 flex flex-wrap items-center justify-end gap-0.5 text-xs">
                {/* Only a `pending` steer can be armed: `sending` has no server id
                    yet, and one already interrupting has nothing left to escalate. */}
                {steer.status === 'pending' && steer.preempt !== true && (
                  <EscalateNowButton
                    surface="bubble"
                    messageText={steer.text}
                    disabled={paused === true || interruptPending}
                    onClick={() =>
                      escalate(
                        {
                          steerId: steer.steerId,
                          generationCreatedAt: steer.generationCreatedAt,
                        },
                        () => cancelButtonRefs.current.get(steer.steerId)?.focus(),
                      )
                    }
                  />
                )}
                {steer.status === 'pending' && (
                  <TooltipAnchor
                    description={localize('com_ui_convert_to_queue')}
                    render={
                      <Button
                        type="button"
                        variant="message-action"
                        aria-label={localize('com_ui_convert_to_queue')}
                        disabled={movingId != null}
                        onClick={() => void queueSteer(steer)}
                      >
                        <Clock className="h-[19px] w-[19px]" aria-hidden="true" />
                      </Button>
                    }
                  />
                )}
                {(steer.status === 'pending' || steer.status === 'sending') && (
                  <TooltipAnchor
                    description={localize('com_ui_cancel')}
                    render={
                      <Button
                        type="button"
                        variant="message-action"
                        aria-label={localize('com_ui_cancel')}
                        ref={(node) => {
                          if (node == null) {
                            cancelButtonRefs.current.delete(steer.steerId);
                            return;
                          }
                          cancelButtonRefs.current.set(steer.steerId, node);
                        }}
                        disabled={movingId != null}
                        onClick={() => void cancelPendingSteer(steer)}
                      >
                        <X className="h-[19px] w-[19px]" aria-hidden="true" />
                      </Button>
                    }
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const MemoizedPendingSteers: NamedExoticComponent<PendingSteersProps> = memo(PendingSteers);

export default MemoizedPendingSteers;
