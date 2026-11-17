import { useMemo } from 'react';
import { buildTree } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ChatScreenMessagesSlots } from './messages';
import type { FollowedChat } from '../../react/follow';
import { useFollowedContract } from '../../react/chat/followed';
import { ChatContext } from '../../react/chat/context';
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

/**
 * A followed conversation drawn by main chat's own message list: the same thread, rows, parts
 * and scrolling, reading a chat contract built from the followed `Chat`. The hosts those rows
 * read come from the tree it is mounted in. It is never the page's main list, so it leaves the
 * page-wide end marker and screenshot target to that one.
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
  return (
    <ChatContext.Provider value={contract}>
      <ScreenMessages
        messagesTree={messagesTree}
        messages={messages}
        slots={listSlots}
        primary={false}
      />
    </ChatContext.Provider>
  );
}
