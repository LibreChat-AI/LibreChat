import { useMemo } from 'react';
import { buildTree } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { TMessageAuthor } from '../../react/messages/author';
import type { MessagesHost } from '../../react/messages/host';
import type { ChatContract } from '../../react/chat/contract';
import type { ChatScreenMessagesSlots } from './messages';
import type { FollowedChat } from '../../react/follow';
import { useMessagesHost, inertSeenSource, MessagesHostProvider } from '../../react/messages/host';
import { ChatContext, useChatContext } from '../../react/chat/context';
import { UserTurnAuthorContext } from '../../react/messages/author';
import { useFollowedContract } from '../../react/chat/followed';
import Thread from '../messages/thread/Thread';
import ScreenMessages from './messages';
import EarlierMessages from './Earlier';

export type FollowedThreadProps = {
  /** The conversation followed. */
  id: string;
  followed: FollowedChat;
  /** The pane number the host keys per-pane state by; see `useFollowedContract`. */
  index: number;
  conversation: TConversation | null;
  /** Replacements for the list's slots, over the ones a followed conversation leaves empty. */
  slots?: ChatScreenMessagesSlots;
  /** Who wrote the conversation's user-side turns, when the reader did not. */
  userAuthor?: TMessageAuthor;
};

const none = (): null => null;

/**
 * A conversation the reader only follows has no queued turn of theirs waiting on it and no
 * steers of theirs, and a surface narrow enough to sit beside a chat has no room for the
 * navigation rail.
 */
const followedSlots: ChatScreenMessagesSlots = {
  renderPendingTurn: none,
  renderPendingSteers: none,
  renderNav: none,
};

/**
 * One of their own, which they drive, has both: the steers a run has not taken yet and the
 * queued turn about to be sent are drawn at the end of its list, as main chat draws them.
 */
const ownSlots: ChatScreenMessagesSlots = { renderNav: none };

/** The chat's own list, where the page's host would hand a row main chat's. */
const useFollowedMessages: MessagesHost['useGetMessages'] = () => useChatContext().getMessages;
const useNoPendingTurn: MessagesHost['useHasPendingTurn'] = () => false;
const useNoSeenSource: MessagesHost['useSeenSource'] = () => inertSeenSource;
const noAddedConversation = (): null => null;
const useNoAddedConversation: MessagesHost['useGetAddedConvo'] = () => noAddedConversation;

/**
 * The page's messages host with the members that act on main chat pointed at this one: a row
 * reads this chat's list, and a rerun here does not take the model main chat is being compared
 * with. Only a conversation of the reader's own (`own`) has a queued turn of theirs to wait on,
 * and read state of theirs to mark when it is read.
 */
function useFollowedMessagesHost(own: boolean): MessagesHost {
  const host = useMessagesHost();
  return useMemo(
    () => ({
      ...host,
      useGetMessages: useFollowedMessages,
      useGetAddedConvo: useNoAddedConversation,
      ...(!own && { useHasPendingTurn: useNoPendingTurn, useSeenSource: useNoSeenSource }),
    }),
    [host, own],
  );
}

/**
 * A conversation that is not the page's main one, drawn by main chat's own message list: the
 * same thread, rows, parts and scrolling, reading the chat contract it is given. The hosts those
 * rows read come from the tree it is mounted in, except the three that would act on main chat.
 * It leaves the page-wide end marker and screenshot target to the main list.
 */
export function ContractThread({
  contract,
  followed,
  slots,
  userAuthor,
  own = false,
}: {
  contract: ChatContract;
  /** The conversation as read so far: its rows, and whether older ones are still to be read. */
  followed: Pick<
    FollowedChat,
    'messages' | 'hasEarlier' | 'isLoadingEarlier' | 'isEarlierError' | 'loadEarlier'
  >;
  slots?: ChatScreenMessagesSlots;
  userAuthor?: TMessageAuthor;
  /** Whether this is a conversation of the reader's own, whose replies they catch up with here. */
  own?: boolean;
}): ReactElement {
  const { messages, hasEarlier, isLoadingEarlier, isEarlierError, loadEarlier } = followed;
  const messagesTree = useMemo(() => buildTree({ messages }), [messages]);
  /** The rows are the package's own, under whatever of the conversation is still to be read. */
  const listSlots = useMemo<ChatScreenMessagesSlots>(
    () => ({
      ...(own ? ownSlots : followedSlots),
      renderThread: (props) => (
        <>
          <EarlierMessages
            followed={{ hasEarlier, isLoadingEarlier, isEarlierError, loadEarlier }}
          />
          <Thread {...props} />
        </>
      ),
      ...slots,
    }),
    [own, slots, hasEarlier, isLoadingEarlier, isEarlierError, loadEarlier],
  );
  const messagesHost = useFollowedMessagesHost(own);
  return (
    <ChatContext.Provider value={contract}>
      <MessagesHostProvider host={messagesHost}>
        <UserTurnAuthorContext.Provider value={userAuthor}>
          <ScreenMessages
            messagesTree={messagesTree}
            messages={messages}
            slots={listSlots}
            primary={false}
          />
        </UserTurnAuthorContext.Provider>
      </MessagesHostProvider>
    </ChatContext.Provider>
  );
}

/** A conversation the reader follows and does not drive, over a contract that takes no turns. */
export default function FollowedThread({
  id,
  followed,
  index,
  conversation,
  slots,
  userAuthor,
}: FollowedThreadProps): ReactElement {
  const contract = useFollowedContract({ id, followed, index, conversation });
  return (
    <ContractThread contract={contract} followed={followed} slots={slots} userAuthor={userAuthor} />
  );
}
