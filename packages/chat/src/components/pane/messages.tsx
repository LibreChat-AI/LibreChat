import type { TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { MessagesViewProps } from '../messages/MessagesView';
import { MessagesViewProvider } from '../../react/messages/view';
import { useChatSurface } from '../../react/subagents/surface';
import MessagesView from '../messages/MessagesView';

/** The list's slots a host may replace: the thread, pending pieces, scroll control and rail.
 *  Flat thread mode is a host setting (`useFlatThread`), and the pending pieces render
 *  themselves when a slot is absent. */
export type ChatScreenMessagesSlots = Pick<
  MessagesViewProps,
  'renderThread' | 'renderPendingTurn' | 'renderPendingSteers' | 'renderScrollButton' | 'renderNav'
>;

/** What the message list receives: the session's messages and the tree built from them. */
export type ChatScreenMessagesProps = {
  messagesTree: TMessage[] | null;
  messages: TMessage[] | null;
};

/** The default message list: the package list under the viewer's surface preferences. */
export default function ScreenMessages({
  messagesTree,
  messages,
  slots,
}: ChatScreenMessagesProps & { slots?: ChatScreenMessagesSlots }): ReactElement {
  const { showScrollButton, maximizeChatSpace } = useChatSurface();
  return (
    <MessagesViewProvider>
      <MessagesView
        {...slots}
        messagesTree={messagesTree}
        messages={messages}
        showScrollButton={showScrollButton}
        maximizeChatSpace={maximizeChatSpace}
      />
    </MessagesViewProvider>
  );
}
