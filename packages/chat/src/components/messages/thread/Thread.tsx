import type { Dispatch, ReactElement, SetStateAction } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { useMessagesHost } from '../../../react/messages/host';
import useThreadRows from '../../../react/messages/rows';
import MultiMessage from './MultiMessage';
import List from './List';

/** What the thread slot renders the conversation from. */
export type MessagesThreadProps = {
  messagesTree?: TMessage[];
  messages?: TMessage[] | null;
  /** The conversation that owns the rendered tree. */
  conversationId?: string | null;
  /** Renders the flat row list; `false` renders the recursive tree. */
  flat: boolean;
  currentEditId: string | number | null;
  setCurrentEditId: Dispatch<SetStateAction<string | number | null>>;
};

/**
 * The message list's default thread: the flat row list, or the recursive renderer when the
 * view turns the flat one off. Each row's message and activity render through the host's slots.
 */
export default function Thread({
  flat,
  messagesTree,
  messages,
  conversationId,
  currentEditId,
  setCurrentEditId,
}: MessagesThreadProps): ReactElement {
  const fileMap = useMessagesHost().useFileMap();
  const rows = useThreadRows(flat ? messages : null, conversationId, fileMap);
  if (flat && rows) {
    return <List rows={rows} currentEditId={currentEditId} setCurrentEditId={setCurrentEditId} />;
  }
  return (
    <MultiMessage
      messagesTree={messagesTree}
      messageId={conversationId ?? null}
      currentEditId={currentEditId}
      setCurrentEditId={setCurrentEditId}
    />
  );
}
