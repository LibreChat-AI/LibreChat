import { useContext } from 'react';
import { collectLiveAskToolCallIds } from '@librechat/chat';
import { AskAnswerHostProvider } from '@librechat/chat/react';
import type { LiveAskPauses } from '@librechat/chat/react';
import type { ReactNode } from 'react';
import { ChatContext } from '~/Providers/ChatContext';
import { useCachedMessages } from '~/data-provider';

/**
 * Live ask pauses in the open conversation, subscribed by the host.
 */
export function useChatLiveAskPauses(): LiveAskPauses | null {
  const conversationId = useContext(ChatContext)?.conversation?.conversationId;
  const enabled = conversationId != null && conversationId !== 'new';
  const { data } = useCachedMessages(enabled ? conversationId : '', collectLiveAskToolCallIds);
  return data ?? null;
}

/** The chat's ask host: whether drafts are saved, and which ask calls are already interactive. */
export default function AskHost({
  saveDrafts,
  children,
}: {
  saveDrafts: boolean;
  children?: ReactNode;
}) {
  const liveAskPauses = useChatLiveAskPauses();
  return (
    <AskAnswerHostProvider saveDrafts={saveDrafts} liveAskPauses={liveAskPauses}>
      {children}
    </AskAnswerHostProvider>
  );
}
