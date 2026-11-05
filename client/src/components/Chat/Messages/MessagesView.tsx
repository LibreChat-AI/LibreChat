import { MessagesView as MessagesList } from '@librechat/chat/components';
import type { MessagesThreadProps } from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import { MessagePartsHostProvider, appMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { MessagesViewProvider, useFileMapContext } from '~/Providers';
import { useChatSurface } from '~/components/Chat/Subagents/surface';
import useThreadRows from '~/hooks/Messages/useThreadRows';
import PendingSteers from './Content/Parts/PendingSteers';
import { FLAT_THREAD, ThreadList } from './Thread';
import MultiMessage from './MultiMessage';
import ScrollButton from './ScrollButton';
import PendingTurn from './PendingTurn';
import MessageNav from './MessageNav';

/** The flat thread renderer by default, the recursive one when the flag turns it off. */
function Thread({
  messagesTree,
  messages,
  conversationId,
  currentEditId,
  setCurrentEditId,
}: MessagesThreadProps) {
  const fileMap = useFileMapContext();
  const threadRows = useThreadRows(FLAT_THREAD ? messages : null, conversationId, fileMap);
  if (FLAT_THREAD && threadRows) {
    return (
      <ThreadList
        rows={threadRows}
        setCurrentEditId={setCurrentEditId}
        currentEditId={currentEditId ?? null}
      />
    );
  }
  return (
    <MultiMessage
      messagesTree={messagesTree}
      messageId={conversationId ?? null}
      setCurrentEditId={setCurrentEditId}
      currentEditId={currentEditId ?? null}
    />
  );
}

function MessagesViewContent({
  messagesTree,
  messages,
}: {
  messagesTree?: TMessage[] | null;
  messages?: TMessage[] | null;
}) {
  const { showScrollButton, maximizeChatSpace } = useChatSurface();
  return (
    <MessagesList
      messagesTree={messagesTree}
      messages={messages}
      showScrollButton={showScrollButton}
      maximizeChatSpace={maximizeChatSpace}
      renderThread={(props) => <Thread {...props} />}
      renderPendingTurn={(props) => <PendingTurn {...props} />}
      renderPendingSteers={(props) => <PendingSteers {...props} />}
      renderScrollButton={(props) => <ScrollButton {...props} />}
      renderNav={({ conversationId, scrollableRef }) => (
        <MessageNav
          key={conversationId}
          conversationId={conversationId}
          scrollableRef={scrollableRef}
        />
      )}
    />
  );
}

export default function MessagesView({
  messagesTree,
  messages,
}: {
  messagesTree?: TMessage[] | null;
  messages?: TMessage[] | null;
}) {
  return (
    <MessagesViewProvider>
      <MessagePartsHostProvider host={appMessagePartsHost}>
        <MessagesViewContent messagesTree={messagesTree} messages={messages} />
      </MessagePartsHostProvider>
    </MessagesViewProvider>
  );
}
