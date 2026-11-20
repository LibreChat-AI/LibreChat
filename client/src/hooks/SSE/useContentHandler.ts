import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useContentHandler as useStreamContent } from '@librechat/chat/react';
import type { TMessage, ImageFile, PartMetadata } from 'librechat-data-provider';
import type { ContentHandlers } from '@librechat/chat/react';
import { addFileToCache } from '~/utils';

/** The package's content-frame handler, caching streamed image files in the app's file list. */
export default function useContentHandler({
  setMessages,
  getMessages,
}: {
  setMessages: (messages: TMessage[]) => void;
  getMessages: () => TMessage[] | undefined;
}): ContentHandlers {
  const queryClient = useQueryClient();
  const onImageFile = useCallback(
    (file: ImageFile & PartMetadata) => addFileToCache(queryClient, file),
    [queryClient],
  );
  return useStreamContent({ setMessages, getMessages, onImageFile });
}
