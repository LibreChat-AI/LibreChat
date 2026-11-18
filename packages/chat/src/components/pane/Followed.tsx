import { useMemo } from 'react';
import { buildTree } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { MessagesHost } from '../../react/messages/host';
import type { ChatScreenMessagesSlots } from './messages';
import type { FollowedChat } from '../../react/follow';
import { useMessagesHost, inertSeenSource, MessagesHostProvider } from '../../react/messages/host';
import { ChatContext, useChatContext } from '../../react/chat/context';
import { useFollowedContract } from '../../react/chat/followed';
import ScreenMessages from './messages';

export type FollowedThreadProps = {
  /** The conversation followed. */
  id: string;
  followed: FollowedChat;
  /** The pane number the host keys per-pane state by; see `useFollowedContract`. */
  index: number;
  conversation: TConversation | null;
  /** Replacements for the list's slots, over the ones a followed conversation leaves empty. */
  slots?: ChatScreenMessagesSlots;
};

const none = (): null => null;

/**
 * A followed conversation has no turn of the reader's waiting on it and no steers of theirs, and
 * a surface narrow enough to sit beside a chat has no room for the navigation rail.
 */
const followedSlots: ChatScreenMessagesSlots = {
  renderPendingTurn: none,
  renderPendingSteers: none,
  renderNav: none,
};

/** The followed chat's own list, where the page's host would hand a row main chat's. */
const useFollowedMessages: MessagesHost['useGetMessages'] = () => useChatContext().getMessages;
const useNoPendingTurn: MessagesHost['useHasPendingTurn'] = () => false;
const useNoSeenSource: MessagesHost['useSeenSource'] = () => inertSeenSource;

/**
 * The page's messages host with the members that act on main chat pointed at the followed one:
 * a row reads the followed list, the reader has no queued turn here, and reading it marks no
 * conversation of theirs seen.
 */
function useFollowedMessagesHost(): MessagesHost {
  const host = useMessagesHost();
  return useMemo(
    () => ({
      ...host,
      useGetMessages: useFollowedMessages,
      useHasPendingTurn: useNoPendingTurn,
      useSeenSource: useNoSeenSource,
    }),
    [host],
  );
}

/**
 * A followed conversation drawn by main chat's own message list: the same thread, rows, parts
 * and scrolling, reading a chat contract built from the followed `Chat`. The hosts those rows
 * read come from the tree it is mounted in, except the three that would act on main chat. It is
 * never the page's main list, so it leaves the page-wide end marker and screenshot target to
 * that one.
 */
export default function FollowedThread({
  id,
  followed,
  index,
  conversation,
  slots,
}: FollowedThreadProps): ReactElement {
  const contract = useFollowedContract({ id, followed, index, conversation });
  const { messages } = followed;
  const messagesTree = useMemo(() => buildTree({ messages }), [messages]);
  const listSlots = useMemo(() => ({ ...followedSlots, ...slots }), [slots]);
  const messagesHost = useFollowedMessagesHost();
  return (
    <ChatContext.Provider value={contract}>
      <MessagesHostProvider host={messagesHost}>
        <ScreenMessages
          messagesTree={messagesTree}
          messages={messages}
          slots={listSlots}
          primary={false}
        />
      </MessagesHostProvider>
    </ChatContext.Provider>
  );
}
