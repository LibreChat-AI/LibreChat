import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { reduceRunArtifactAttachments } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';
import { messageAttachmentsMapAtom } from '~/hooks/SSE/atoms';
import { mergeAttachments } from '~/utils/attachments';

export default function useAttachments({
  messageId,
  attachments,
  content,
  conversationId,
}: {
  messageId?: string;
  attachments?: TAttachment[];
  content?: TMessageContentParts[];
  conversationId?: string | null;
}) {
  const messageAttachmentsMap = useAtomValue(messageAttachmentsMapAtom);
  const messageAttachments = useMemo<TAttachment[]>(
    () => mergeAttachments(attachments, messageAttachmentsMap[messageId ?? '']),
    [attachments, messageAttachmentsMap, messageId],
  );
  const visibleAttachments = useMemo(
    () =>
      reduceRunArtifactAttachments({
        attachments: messageAttachments,
        content: content ?? [],
        conversationId,
      }),
    [conversationId, content, messageAttachments],
  );

  const searchResults = useSearchResultsByTurn(visibleAttachments);

  return {
    attachments: visibleAttachments,
    searchResults,
  };
}
