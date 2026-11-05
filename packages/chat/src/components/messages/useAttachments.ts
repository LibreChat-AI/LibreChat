import { useMemo } from 'react';
import type { SearchResultData } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';
import { useMessagesHost } from '../../react/messages/host';
import { mergeAttachments } from '../../core/attachments';

export default function useAttachments({
  messageId,
  attachments,
}: {
  messageId?: string;
  attachments?: TAttachment[];
}): { attachments: TAttachment[]; searchResults: { [key: string]: SearchResultData } } {
  const streamed = useMessagesHost().useStreamedAttachments(messageId ?? '');
  const messageAttachments = useMemo<TAttachment[]>(
    () => mergeAttachments(attachments, streamed),
    [attachments, streamed],
  );

  const searchResults = useSearchResultsByTurn(messageAttachments);

  return {
    attachments: messageAttachments,
    searchResults,
  };
}
