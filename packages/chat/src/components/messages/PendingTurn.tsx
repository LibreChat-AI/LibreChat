import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useLocalize } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement, RefObject } from 'react';
import { hasRevealSuccessor, buildRevealedMessage } from '../../react/steering/useQueuedTurnReveal';
import { getHeaderPrefixForScreenReader, getMessageAriaLabel } from './labels';
import { useQueuedTurnPortal } from '../composer/steering/QueuedTurnPortal';
import { revealedQueuedTurnFamily } from '../../react/steer/rows';
import { useMessagesHost } from '../../react/messages/host';
import { useChatContext } from '../../react/chat/context';
import { useMessagePartsHost } from '../../react/host';
import { messageFooterClasses } from './styles';
import Container from '../parts/Container';
import MessageRow from './MessageRow';
import SubRow from './SubRow';

/** How far above the end of the thread a reader can be and still be handed
 *  the next turn, matching the scroll button's own near-bottom band. */
const FOLLOW_THRESHOLD_PX = 160;

export type PendingTurnProps = {
  scrollableRef?: RefObject<HTMLDivElement | null>;
  messages?: TMessage[] | null;
  maximizeChatSpace?: boolean;
};

/**
 * The queued follow-up the server is about to admit, drawn as the user turn after the completed
 * response it follows. It is not persisted: its actions come from the composer that owns the
 * queue, and it leaves as soon as the thread gains a turn after that response.
 *
 * The pane context names the conversation, including while a warm navigation still shows the
 * previous chat there. The label, icon and text come from the hosts.
 */
export default function PendingTurn({
  scrollableRef,
  messages,
  maximizeChatSpace = false,
}: PendingTurnProps): ReactElement | null {
  const localize = useLocalize();
  const { conversation, latestMessageId } = useChatContext();
  const conversationId = conversation?.conversationId ?? '';
  const { useUser, useUserTextPreferences, renderMarkdown } = useMessagePartsHost();
  const renderMessageIcon = useMessagesHost().renderMessageIcon;
  const user = useUser();
  const { usernameDisplay, enableUserMsgMarkdown } = useUserTextPreferences();
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

  if (!shown || message == null || reveal == null) {
    return null;
  }

  const label = usernameDisplay
    ? (user?.name ?? '') || (user?.username ?? '')
    : localize('com_user_message');
  const icon = renderMessageIcon({
    iconData: {
      endpoint: conversation?.endpoint,
      model: conversation?.model ?? undefined,
      modelLabel: label,
      isCreatedByUser: true,
    },
  });
  const bodyClass = [
    'markdown prose message-content light text-text-primary w-full break-words',
    enableUserMsgMarkdown ? '' : 'whitespace-pre-wrap',
  ]
    .filter((part) => part !== '')
    .join(' ');

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
          <Container message={message}>
            <div className={bodyClass}>
              {enableUserMsgMarkdown
                ? renderMarkdown({
                    content: reveal.text,
                    variant: 'lite',
                    isLatestMessage: false,
                  })
                : reveal.text}
            </div>
          </Container>
        </MessageRow>
      </div>
    </div>
  );
}
