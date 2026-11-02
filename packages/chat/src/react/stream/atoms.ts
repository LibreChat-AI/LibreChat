import { atomFamily } from 'jotai/utils';
import { atom, useAtomValue } from 'jotai';
import type { TAttachment } from 'librechat-data-provider';
import type { Atom, PrimitiveAtom } from 'jotai';
import type { Family } from '../steer/family';

/** The run the pane at this index is displaying, renewed by every `created` or resume `sync`;
 *  audio autoplay keys "already played" on it. */
export const activeRunFamily: Family<
  string | null,
  PrimitiveAtom<string | null>,
  string | number | null
> = atomFamily((_index: string | number | null) => atom<string | null>(null));

/** Attachments that arrived while a message streamed, by message id, ahead of the saved copy. */
export const messageAttachmentsMapAtom: PrimitiveAtom<Record<string, TAttachment[] | undefined>> =
  atom<Record<string, TAttachment[] | undefined>>({});

/** The streamed attachments that belong to one conversation, by message id. */
export const conversationAttachmentsFamily: Family<
  Record<string, TAttachment[]>,
  Atom<Record<string, TAttachment[]>>,
  string | undefined
> = atomFamily((conversationId: string | undefined) =>
  atom((get) => {
    if (!conversationId) {
      return {};
    }

    const attachmentsMap = get(messageAttachmentsMapAtom);
    const result: Record<string, TAttachment[]> = {};

    // Filter to only include attachments for this conversation
    Object.entries(attachmentsMap).forEach(([messageId, attachments]) => {
      if (!attachments || attachments.length === 0) {
        return;
      }

      const relevantAttachments = attachments.filter(
        (attachment) => attachment.conversationId === conversationId,
      );

      if (relevantAttachments.length > 0) {
        result[messageId] = relevantAttachments;
      }
    });

    return result;
  }),
);

/** Attachments delivered by message id ahead of the message cache. */
export function useLiveAttachments(): Record<string, TAttachment[] | undefined> {
  return useAtomValue(messageAttachmentsMapAtom);
}
