import type { ReactElement } from 'react';
import type { ChatScreenMessagesSlots } from './messages';
import type { FollowedChat } from '../../react/follow';
import { useDrivenContract } from '../../react/chat/driven';
import { ContractThread } from './Followed';

export type DrivenThreadProps = {
  /** The conversation driven. */
  id: string;
  followed: FollowedChat;
  /** The pane the host keys this chat's state by; see `useDrivenContract`. */
  index: number;
  slots?: ChatScreenMessagesSlots;
  /**
   * Arranges the list with whatever takes the reader's words: handed the chat's contract and
   * the list, it returns the two together. Without it the list is drawn alone.
   */
  children?: (contract: ReturnType<typeof useDrivenContract>, thread: ReactElement) => ReactElement;
};

/**
 * A conversation the reader drives beside the main one: main chat's message list over a core
 * `Chat`, with the contract that sends, reruns, continues and stops through it. Whatever takes
 * the reader's words is drawn by the surface, which is handed that contract and the list.
 */
export default function DrivenThread({
  id,
  followed,
  index,
  slots,
  children,
}: DrivenThreadProps): ReactElement {
  const contract = useDrivenContract({ id, followed, index });
  const thread = <ContractThread contract={contract} followed={followed} slots={slots} own />;
  return children == null ? thread : children(contract, thread);
}
