import { useAtomValue } from 'jotai';
import type { TAttachment } from 'librechat-data-provider';
import { messageAttachmentsMapAtom } from '../stream/atoms';

/** The attachments that arrived while a message streamed, ahead of its saved copy. */
export default function useStreamedAttachments(messageId: string): TAttachment[] | undefined {
  return useAtomValue(messageAttachmentsMapAtom)[messageId];
}
