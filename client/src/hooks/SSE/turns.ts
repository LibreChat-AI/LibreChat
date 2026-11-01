import { selectConvoTitle } from '@librechat/chat';
import { QueryKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { ConvoTitleState } from '@librechat/chat';
import { findConvoInAllQueries, findManualConvoTitleInAllQueries } from '~/utils';

export {
  createErrorMessage,
  resolveErrorTurn,
  resolveSettledErrorReadState,
} from '@librechat/chat';
export type { ErrorTurn } from '@librechat/chat';

export const getConvoTitle = ({
  queryClient,
  currentTitle,
  conversationId,
  titleSetByUser,
  titleRevision,
  authoritative = false,
}: {
  queryClient: QueryClient;
  currentTitle?: string | null;
  conversationId?: string | null;
  titleSetByUser?: boolean;
  titleRevision?: number;
  authoritative?: boolean;
}): ConvoTitleState => {
  const incoming = { title: currentTitle ?? null, titleSetByUser, titleRevision };
  if (!conversationId) {
    return incoming;
  }
  return selectConvoTitle({
    incoming,
    authoritative,
    cached: queryClient.getQueryData<TConversation>([QueryKeys.conversation, conversationId]),
    findManual: (state) => findManualConvoTitleInAllQueries(queryClient, conversationId, state),
    findListed: () => findConvoInAllQueries(queryClient, conversationId),
  });
};
