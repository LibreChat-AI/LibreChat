import { useRecoilValue } from 'recoil';
import { PendingTurn as PackagePendingTurn, Container } from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import type { RefObject } from 'react';
import type { TMessageIcon } from '~/common';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { useAuthContext } from '~/hooks/AuthContext';
import MarkdownLite from './Content/MarkdownLite';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

/** The app's side of the queued follow-up row: who sent it, their icon, and how the text reads. */
export default function PendingTurn({
  scrollableRef,
  messages,
  maximizeChatSpace = false,
}: {
  scrollableRef?: RefObject<HTMLDivElement | null>;
  messages?: TMessage[] | null;
  maximizeChatSpace?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { conversation, latestMessageId } = useChatContext();
  const usernameDisplay = useRecoilValue(store.UsernameDisplay);
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);

  const label = usernameDisplay
    ? (user?.name ?? '') || (user?.username ?? '')
    : localize('com_user_message');
  const iconData: TMessageIcon = {
    endpoint: conversation?.endpoint,
    model: conversation?.model,
    modelLabel: label,
    isCreatedByUser: true,
  };

  return (
    <PackagePendingTurn
      scrollableRef={scrollableRef}
      messages={messages}
      maximizeChatSpace={maximizeChatSpace}
      conversationId={conversation?.conversationId ?? ''}
      latestMessageId={latestMessageId}
      label={label}
      icon={<MessageIcon iconData={iconData} />}
      renderBody={(message, text) => (
        <Container message={message}>
          <div
            className={cn(
              'markdown prose message-content light text-text-primary w-full break-words',
              !enableUserMsgMarkdown && 'whitespace-pre-wrap',
            )}
          >
            {enableUserMsgMarkdown ? <MarkdownLite content={text} /> : text}
          </div>
        </Container>
      )}
    />
  );
}
