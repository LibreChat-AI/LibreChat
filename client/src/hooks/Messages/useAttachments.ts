import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { TAttachment } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';
import { messageAttachmentsMapAtom } from '~/hooks/SSE/atoms';
import { mergeAttachments } from '~/utils/attachments';

export default function useAttachments({
  messageId,
  attachments,
}: {
  messageId?: string;
  attachments?: TAttachment[];
}) {
  const messageAttachmentsMap = useAtomValue(messageAttachmentsMapAtom);
  const messageAttachments = useMemo<TAttachment[]>(
    () => mergeAttachments(attachments, messageAttachmentsMap[messageId ?? '']),
    [attachments, messageAttachmentsMap, messageId],
  );

  const searchResults = useSearchResultsByTurn(messageAttachments);

  return {
    attachments: messageAttachments,
    searchResults,
  };
}
