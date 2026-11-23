import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationSeenSource } from '@librechat/chat/react';
import {
  findConvoInAllQueries,
  isConversationUnseen,
  hasServerFetchedReply,
  hasLocallyCommittedReply,
} from '~/utils';
import { consumeFocusSuppression } from './notificationNavigation';
import { useMarkConversationSeenMutation } from '~/data-provider';

/** The app's read state as the message list's seen reporting reads it: the conversation
 *  caches every sidebar list and point query write, the reply proofs the stream and the
 *  messages fetch leave on the messages cache, and the seen mutation. */
export default function useConversationSeenSource(): ConversationSeenSource {
  const queryClient = useQueryClient();
  const { mutate } = useMarkConversationSeenMutation();
  return useMemo<ConversationSeenSource>(
    () => ({
      readReply: (conversationId) => {
        const convo = findConvoInAllQueries(queryClient, conversationId);
        if (!convo) {
          return undefined;
        }
        return {
          lastResponseAt: convo.lastResponseAt,
          lastResponseMessageId: convo.lastResponseMessageId,
          lastResponseIsManual: convo.lastResponseIsManual,
          unseen: isConversationUnseen(convo),
        };
      },
      hasReplyProof: (conversationId, lastResponseAt, from) =>
        from === 'local'
          ? hasLocallyCommittedReply(queryClient, conversationId, lastResponseAt)
          : hasServerFetchedReply(queryClient, conversationId, lastResponseAt),
      markSeen: (input) => mutate(input),
      consumeFocusSuppression,
    }),
    [queryClient, mutate],
  );
}
