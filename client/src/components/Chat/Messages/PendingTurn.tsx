import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import type { RefObject } from 'react';
import type { TMessageIcon } from '~/common';
import { buildRevealedMessage, hasRevealSuccessor } from '~/hooks/Chat/useQueuedTurnReveal';
import { useQueuedTurnPortal } from '~/components/Chat/Steering/QueuedTurnPortal';
import { getHeaderPrefixForScreenReader, getMessageAriaLabel } from '~/utils';
import { messageFooterClasses } from '~/components/Chat/Messages/styles';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { revealedQueuedTurnFamily } from '~/store/steer';
import { useAuthContext } from '~/hooks/AuthContext';
import MarkdownLite from './Content/MarkdownLite';
import { useChatContext } from '~/Providers';
import Container from './Content/Container';
import { useLocalize } from '~/hooks';
import SubRow from './SubRow';
import { cn } from '~/utils';
import store from '~/store';

/** How far above the end of the thread a reader can be and still be handed
 *  the next turn, matching the scroll button's own near-bottom band. */
const FOLLOW_THRESHOLD_PX = 160;

/**
 * The queued follow-up the server is about to admit, drawn as the user turn
 * after the completed response it follows. It is not persisted: its actions
 * come from the composer that owns the queue, and it leaves as soon as the
 * thread gains a turn after that response.
 */
export default function PendingTurn({
  scrollableRef,
  messages,
  maximizeChatSpace = false,
}: {
  scrollableRef?: RefObject<HTMLDivElement | null>;
  messages?: TMessage[] | null;
  maximizeChatSpace?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { conversation, latestMessageId } = useChatContext();
  const conversationId = conversation?.conversationId ?? '';
  const reveal = useAtomValue(revealedQueuedTurnFamily(conversationId));
  const setPortalTarget = useQueuedTurnPortal()?.setTarget;
  const clientRequestId = reveal?.clientRequestId;
  const usernameDisplay = useRecoilValue(store.UsernameDisplay);
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
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

  const label = usernameDisplay
    ? (user?.name ?? '') || (user?.username ?? '')
    : localize('com_user_message');
  const iconData: TMessageIcon = {
    endpoint: conversation?.endpoint,
    model: conversation?.model,
    modelLabel: label,
    isCreatedByUser: true,
  };

  return (
    <div
      ref={rowRef}
      className="w-full border-0 bg-transparent text-text-primary"
      data-testid="pending-turn"
    >
      <div className="m-auto justify-center px-4 py-3 sm:px-0">
        <MessageRow
          icon={<MessageIcon iconData={iconData} />}
          label={label}
          timestamp={reveal.revealedAt}
          ariaLabel={getMessageAriaLabel(message, localize)}
          headerPrefix={getHeaderPrefixForScreenReader(message, localize)}
          isCreatedByUser
          fullWidth={maximizeChatSpace}
          footer={
            <SubRow
              classes={cn(messageFooterClasses, 'flex-wrap items-center justify-end gap-1.5')}
            >
              <span className="text-xs text-text-secondary" role="status">
                {localize('com_ui_queued_turn_starting')}
              </span>
              <span ref={setActionsTarget} className="flex items-center gap-1" />
            </SubRow>
          }
        >
          <Container message={message}>
            <div
              className={cn(
                'markdown prose message-content dark:prose-invert light w-full break-words text-text-primary',
                !enableUserMsgMarkdown && 'whitespace-pre-wrap',
              )}
            >
              {enableUserMsgMarkdown ? <MarkdownLite content={reveal.text} /> : reveal.text}
            </div>
          </Container>
        </MessageRow>
      </div>
    </div>
  );
}
