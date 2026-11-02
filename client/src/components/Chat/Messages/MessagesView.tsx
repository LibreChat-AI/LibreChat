import { useChatSurface } from '@librechat/chat/react';
import { MessagesView as MessagesList } from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import { MessagePartsHostProvider, appMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import PendingSteers from './Content/Parts/PendingSteers';
import { MessagesViewProvider } from '~/Providers';
import ScrollButton from './ScrollButton';
import PendingTurn from './PendingTurn';
import { FLAT_THREAD } from './Thread';
import MessageNav from './MessageNav';

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
      flatThread={FLAT_THREAD}
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
