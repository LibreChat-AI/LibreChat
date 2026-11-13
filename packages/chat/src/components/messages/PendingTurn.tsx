import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useLocalize } from '@librechat/client';
import type { ReactElement, ReactNode, RefObject } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { hasRevealSuccessor, buildRevealedMessage } from '../../react/steering/useQueuedTurnReveal';
import { getHeaderPrefixForScreenReader, getMessageAriaLabel } from './labels';
import { useQueuedTurnPortal } from '../composer/steering/QueuedTurnPortal';
import { revealedQueuedTurnFamily } from '../../react/steer/rows';
import { messageFooterClasses } from './styles';
import MessageRow from './MessageRow';
import SubRow from './SubRow';

/** How far above the end of the thread a reader can be and still be handed
 *  the next turn, matching the scroll button's own near-bottom band. */
const FOLLOW_THRESHOLD_PX = 160;

export type PendingTurnProps = {
  scrollableRef?: RefObject<HTMLDivElement | null>;
  messages?: TMessage[] | null;
  maximizeChatSpace?: boolean;
  /** The routed conversation: its reveal is the turn drawn. */
  conversationId: string;
  /** The thread's current tail; the turn is drawn only after the response it follows. */
  latestMessageId?: string;
  /** Who the turn is attributed to. */
  label: string;
  /** The author's icon. */
  icon: ReactNode;
  /** The turn's text, drawn inside the row (the host decides markdown and wrappers). */
  renderBody: (message: TMessage, text: string) => ReactNode;
};

/**
 * The queued follow-up the server is about to admit, drawn as the user turn after the completed
 * response it follows. It is not persisted: its actions come from the composer that owns the
 * queue, and it leaves as soon as the thread gains a turn after that response.
 */
export default function PendingTurn({
  scrollableRef,
  messages,
  maximizeChatSpace = false,
  conversationId,
  latestMessageId,
  label,
  icon,
  renderBody,
}: PendingTurnProps): ReactElement | null {
  const localize = useLocalize();
  const reveal = useAtomValue(revealedQueuedTurnFamily(conversationId));
  const setPortalTarget = useQueuedTurnPortal()?.setTarget;
  const clientRequestId = reveal?.clientRequestId;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const message = useMemo(
    () => (reveal == null ? null : buildRevealedMessage(reveal, conversationId)),
    [reveal, conversationId],
  );
  const successorSeen = useMemo(
    () => reveal != null && hasRevealSuccessor(messages ?? [], reveal),
    [messages, reveal],
  );
  const shown =
    message != null &&
    reveal != null &&
    reveal.parentMessageId === latestMessageId &&
    !successorSeen;
  const setActionsTarget = useCallback(
    (element: HTMLSpanElement | null) => {
      setPortalTarget?.(
        element == null || clientRequestId == null
          ? null
          : { element, conversationId, clientRequestId },
      );
    },
    [setPortalTarget, conversationId, clientRequestId],
  );

  /** A reader resting at the end of the thread was following the response;
   *  bring the turn that replaces it into view the way its streaming did.
   *  Anyone reading further up is left where they are. */
  useEffect(() => {
    const row = rowRef.current;
    const scrollEl = scrollableRef?.current;
    if (!shown || row == null || scrollEl == null) {
      return;
    }
    const distanceFromEnd =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight - row.offsetHeight;
    if (distanceFromEnd > FOLLOW_THRESHOLD_PX) {
      return;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    row.scrollIntoView({ block: 'end', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [shown, scrollableRef]);

  if (!shown) {
    return null;
  }

  return (
    <div
      ref={rowRef}
      className="text-text-primary w-full border-0 bg-transparent"
      data-testid="pending-turn"
    >
      <div className="m-auto justify-center px-4 py-3 sm:px-0">
        <MessageRow
          message={message}
          icon={icon}
          label={label}
          timestamp={reveal.revealedAt}
          ariaLabel={getMessageAriaLabel(message, localize)}
          headerPrefix={getHeaderPrefixForScreenReader(message, localize)}
          isCreatedByUser
          fullWidth={maximizeChatSpace}
          footer={
            <SubRow
              classes={[messageFooterClasses, 'flex-wrap items-center justify-end gap-1.5'].join(
                ' ',
              )}
            >
              <span className="text-text-secondary text-xs" role="status">
                {localize('com_ui_queued_turn_starting')}
              </span>
              <span ref={setActionsTarget} className="flex items-center gap-1" />
            </SubRow>
          }
        >
          {renderBody(message, reveal.text)}
        </MessageRow>
      </div>
    </div>
  );
}
