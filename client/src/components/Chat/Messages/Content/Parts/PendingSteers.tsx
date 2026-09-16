import { memo, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { TextQuote } from 'lucide-react';
import { useToastContext } from '@librechat/client';
import EscalateNowButton from '~/components/Chat/Input/EscalateNowButton';
import { useSteerMoveToQueue } from '~/hooks/Chat/useSteerCancel';
import useSteerEscalate from '~/hooks/Chat/useSteerEscalate';
import useSteerRecovery from '~/hooks/Chat/useSteerRecovery';
import { hasLiveRunPause } from '~/hooks/Chat/useSteering';
import { useGetMessagesByConvoId } from '~/data-provider';
import { cn, isLegacyDeliveryUncertain } from '~/utils';
import { escalatingSteerFamily } from '~/store/steer';
import { useLocalize } from '~/hooks';
import SteerPart from './SteerPart';
import store from '~/store';

const ACTION_CLASS =
  'rounded text-xs font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-xheavy';

/**
 * Steers that have not been confirmed by the server yet, rendered at the tail
 * of the streaming reply (the place the words will land) instead of in a
 * floating overlay over the composer. Confirmation swaps them for the real
 * `ContentTypes.STEER` part (`useResumableSSE` removes the pending entry), so
 * the row's whole job is to hold the position and admit it is provisional.
 */
interface PendingSteersProps {
  conversationId: string;
}

function PendingSteers({ conversationId }: PendingSteersProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const steers = useRecoilValue(store.pendingSteersByConvoId(conversationId));
  const { retry, sendAsNew } = useSteerRecovery(conversationId);
  const escalate = useSteerEscalate(conversationId);
  const moveToQueue = useSteerMoveToQueue(conversationId);
  const [movingId, setMovingId] = useState<string | null>(null);
  const escalating = useAtomValue(escalatingSteerFamily(conversationId));
  /* Reads the cache the composer already populates, so the escalation control
     is gated on the same pause the composer sees rather than round-tripping to
     discover the run cannot accept an arm. The shared predicate covers a live
     `ask_user_question` as well as an unresolved tool approval: both suspend
     the generation while holding its submission slot, and gating on approvals
     alone left this control enabled while the composer correctly refused.
     Boolean `select` for the same reason the composer uses one: streaming
     deltas must not re-render this row. */
  const { data: paused } = useGetMessagesByConvoId<boolean>(conversationId, {
    select: hasLiveRunPause,
  });
  /* Only one interrupt can be unresolved at a time: a second arm would seal the
     same run twice. The flag covers an arm's round trip, before its own chip
     can report `preempt`. */
  const interruptPending = useMemo(
    () => escalating || steers.some((steer) => steer.preempt === true && steer.status !== 'failed'),
    [escalating, steers],
  );

  if (steers.length === 0) {
    return null;
  }

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

  return (
    <div role="list" aria-label={localize('com_ui_steer_in_flight')} data-testid="pending-steers">
      {steers.map((steer) => {
        const deliveryUncertain = steer.deliveryUncertain === true;
        const retrySafe = !isLegacyDeliveryUncertain(steer);
        const quoteCount = steer.quotes?.length ?? 0;
        return (
          <div
            key={steer.steerId}
            role="listitem"
            className={cn(steer.status !== 'failed' && 'opacity-60')}
          >
            <SteerPart
              steer={steer.text}
              files={steer.files}
              steerId={steer.steerId}
              createdAt={steer.createdAt}
            />
            {steer.status === 'failed' ? (
              <div className="-mt-2 mb-2 flex items-center gap-3 pl-9 text-xs">
                {quoteCount > 0 && (
                  <span className="flex items-center gap-0.5 text-text-secondary">
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
                  <button
                    type="button"
                    onClick={() => retry(steer.steerId)}
                    className={ACTION_CLASS}
                  >
                    {localize('com_ui_retry')}
                  </button>
                )}
                {!deliveryUncertain && (
                  <button
                    type="button"
                    onClick={() => sendAsNew(steer.steerId)}
                    className={ACTION_CLASS}
                  >
                    {localize('com_ui_send_as_new')}
                  </button>
                )}
              </div>
            ) : (
              <div className="-mt-2 mb-2 flex items-center gap-2 pl-9 text-xs text-text-secondary">
                <span>
                  {localize(
                    steer.preempt === true ? 'com_ui_steer_in_flight_preempt' : 'com_ui_sending',
                  )}
                </span>
                {/* Only a `pending` steer can be armed: `sending` has no server id
                    yet, and one already interrupting has nothing left to escalate. */}
                {steer.status === 'pending' && steer.preempt !== true && (
                  <EscalateNowButton
                    surface="bubble"
                    messageText={steer.text}
                    disabled={paused === true || interruptPending}
                    onClick={() =>
                      escalate({
                        steerId: steer.steerId,
                        generationCreatedAt: steer.generationCreatedAt,
                      })
                    }
                  />
                )}
                {steer.status === 'pending' && (
                  <button
                    type="button"
                    disabled={movingId != null}
                    onClick={() => void queueSteer(steer)}
                    className={ACTION_CLASS}
                  >
                    {localize('com_ui_convert_to_queue')}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default memo(PendingSteers);
