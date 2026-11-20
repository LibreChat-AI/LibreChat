import { useMemo, useCallback } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ChatContract } from '../../react/chat/contract';
import type { ChatScreenMessagesSlots } from './messages';
import type { FollowedChat } from '../../react/follow';
import useQueuedTurnReveal from '../../react/steering/useQueuedTurnReveal';
import useQueueDrain from '../../react/steering/useQueueDrain';
import { useOptionalSteerHost } from '../../react/steer/host';
import { useDrivenContract } from '../../react/chat/driven';
import { useSnapshot } from '../../react/snapshot';
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
  /** Only an app that hosts the steer hooks has a queue for the reader to fill. */
  const queues = useOptionalSteerHost() != null;
  const { chat, hasEarlier, isLoadingEarlier, isEarlierError, loadEarlier } = followed;
  /**
   * One element for as long as what it is made of is the same. The conversation's rows change
   * on every frame of a reply, and the list subscribes to them itself, so a surface that is
   * handed this element and has nothing else new is left as it is while the reply streams.
   */
  const thread = useMemo(
    () => (
      <>
        {queues && <QueueDrain id={id} index={index} ask={contract.ask} />}
        <DrivenMessages
          chat={chat}
          contract={contract}
          slots={slots}
          hasEarlier={hasEarlier}
          isLoadingEarlier={isLoadingEarlier}
          isEarlierError={isEarlierError}
          loadEarlier={loadEarlier}
        />
      </>
    ),
    [
      id,
      chat,
      index,
      slots,
      queues,
      contract,
      hasEarlier,
      loadEarlier,
      isEarlierError,
      isLoadingEarlier,
    ],
  );
  return children == null ? thread : children(contract, thread);
}

const noMessages: TMessage[] = [];
const unsubscribed = () => () => undefined;

type DrivenMessagesProps = Pick<DrivenThreadProps, 'slots'> &
  Pick<
    FollowedChat,
    'chat' | 'hasEarlier' | 'isLoadingEarlier' | 'isEarlierError' | 'loadEarlier'
  > & { contract: ChatContract };

/**
 * The list, which reads the chat's rows for itself: a change to them redraws the list and
 * nothing above it. Not handed down by a context, which React would search everything under
 * its provider for on every change.
 */
function DrivenMessages({ chat, contract, slots, ...earlier }: DrivenMessagesProps): ReactElement {
  const subscribe = useCallback(
    (listener: () => void) => chat?.subscribe(listener) ?? unsubscribed(),
    [chat],
  );
  const messages = useSnapshot(subscribe, () => chat?.messages ?? noMessages);
  return (
    <ContractThread contract={contract} followed={{ messages, ...earlier }} slots={slots} own />
  );
}

/**
 * What the reader queued behind a run goes out when the run ends, as it does in main chat: the
 * pane's run end, which whoever follows the chat publishes, lets the next queued message go
 * through the contract's own `ask`.
 */
function QueueDrain({
  id,
  index,
  ask,
}: Pick<DrivenThreadProps, 'id' | 'index'> & { ask: ChatContract['ask'] }): null {
  const revealQueuedTurn = useQueuedTurnReveal(id, index);
  useQueueDrain(index, id, ask, revealQueuedTurn);
  return null;
}
