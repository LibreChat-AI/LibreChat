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
  handoff?: boolean;
  onAccepted?: () => void;
  slots?: ChatScreenMessagesSlots;
  /** Drawn under the list, inside the chat's contract: the surface's composer. */
  children?: (contract: ReturnType<typeof useDrivenContract>) => ReactElement | null;
};

/**
 * A conversation the reader drives beside the main one: main chat's message list over a core
 * `Chat`, with the contract that sends, reruns, continues and stops through it. Whatever takes
 * the reader's words is drawn by the surface, which is handed that contract.
 */
export default function DrivenThread({
  id,
  followed,
  index,
  handoff,
  onAccepted,
  slots,
  children,
}: DrivenThreadProps): ReactElement {
  const contract = useDrivenContract({ id, followed, index, handoff, onAccepted });
  return (
    <>
      <ContractThread contract={contract} followed={followed} slots={slots} />
      {children?.(contract)}
    </>
  );
}
