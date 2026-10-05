import { ContentTypes } from 'librechat-data-provider';
import type { FilterQuery } from 'mongoose';
import type { IMessage } from '~/types/message';

/** Stored and imported transcripts can contain legacy or provider-defined content. */
export type MessageFileFields = { files?: unknown; attachments?: unknown; content?: unknown };

export function collectMessageFileIds(message: MessageFileFields): string[] {
  const ids = new Set<string>();
  const collect = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && typeof item === 'object' && 'file_id' in item) {
        const id: unknown = item.file_id;
        if (typeof id === 'string' && id) ids.add(id);
      }
    }
  };
  collect(message.files);
  collect(message.attachments);
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === ContentTypes.IMAGE_FILE) collect([part.image_file]);
      else if (part.type === ContentTypes.STEER) collect(part.files);
    }
  }
  return [...ids];
}

/** Matches the same four locations as collectMessageFileIds, including part discriminators. */
export function messageFileReferenceFilter(fileId: string): FilterQuery<IMessage> {
  return {
    $or: [
      { 'files.file_id': fileId },
      { 'attachments.file_id': fileId },
      { content: { $elemMatch: { type: ContentTypes.IMAGE_FILE, 'image_file.file_id': fileId } } },
      { content: { $elemMatch: { type: ContentTypes.STEER, 'files.file_id': fileId } } },
    ],
  };
}

/** A failed late writer loses only its file references; text and unrelated attachments survive. */
export function removeMessageFileIds(
  message: MessageFileFields,
  unavailableIds: Set<string>,
): MessageFileFields {
  const filter = (items: unknown) =>
    Array.isArray(items)
      ? items.filter(
          (item) =>
            !item ||
            typeof item !== 'object' ||
            !('file_id' in item) ||
            !unavailableIds.has(item.file_id),
        )
      : items;
  return {
    ...(message.files !== undefined ? { files: filter(message.files) } : {}),
    ...(message.attachments !== undefined ? { attachments: filter(message.attachments) } : {}),
    ...(Array.isArray(message.content)
      ? {
          content: message.content.map((part) => {
            if (!part || typeof part !== 'object') return part;
            if (part.type === ContentTypes.STEER) return { ...part, files: filter(part.files) };
            if (
              part.type !== ContentTypes.IMAGE_FILE ||
              !unavailableIds.has(part.image_file?.file_id)
            )
              return part;
            const { native_media: _native, ...visible } = part;
            return {
              ...visible,
              image_file: {
                ...part.image_file,
                file_id: '',
                filepath: '',
                unavailable: 'not_transferred',
              },
            };
          }),
        }
      : {}),
  };
}
