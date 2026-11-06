import { isFileAttachment, isFileContentPart, hasContentPartFiles } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';

type MessageFileRefs = Partial<Pick<TMessage, 'files' | 'attachments' | 'tokenCount' | 'content'>>;

type ConversationFileRefs = Partial<Pick<TConversation, 'file_ids'>> & {
  files?: string[] | null;
};

type ContentPart = NonNullable<TMessage['content']>[number];

export type MessageWithoutFiles<T extends MessageFileRefs> = Omit<
  T,
  'files' | 'attachments' | 'tokenCount'
> &
  Pick<MessageFileRefs, 'attachments' | 'tokenCount'>;

/** A part's own attached files (a steer's) go; a part that is itself a file goes entirely. */
function withoutContentFiles(content: ContentPart[]): ContentPart[] {
  let changed = false;
  const kept: ContentPart[] = [];
  for (const part of content) {
    if (isFileContentPart(part)) {
      changed = true;
      continue;
    }
    if (!hasContentPartFiles(part)) {
      kept.push(part);
      continue;
    }
    changed = true;
    const { files: _files, ...rest } = part as ContentPart & { files?: readonly object[] };
    kept.push(rest as ContentPart);
  }
  return changed ? kept : content;
}

/**
 * Drops every file reference a later turn collects from history and sends again, in the shapes
 * historical replay reads (`messageCarriesFiles`): uploads on a user turn (`files`), file-backed
 * attachments such as code outputs (metadata-only ones like search sources stay), and file
 * references in the content (a steered attachment, a generated image, a provider file block). A
 * stored token count that covered a dropped file goes too, so the next turn recounts what is left
 * instead of budgeting context for files it no longer sends.
 */
export function withoutMessageFiles<T extends MessageFileRefs>(message: T): MessageWithoutFiles<T> {
  const { files, attachments, tokenCount, ...rest } = message;
  let droppedFiles = (files?.length ?? 0) > 0;
  const keptAttachments = attachments?.filter((attachment) => !isFileAttachment(attachment));
  if (keptAttachments != null && keptAttachments.length > 0) {
    (rest as MessageFileRefs).attachments = keptAttachments;
  }
  if (Array.isArray(rest.content)) {
    const content = withoutContentFiles(rest.content);
    if (content !== rest.content) {
      droppedFiles = true;
      rest.content = content;
    }
  }
  if (droppedFiles || tokenCount == null) {
    return rest;
  }
  return { ...rest, tokenCount };
}

/** Drops the conversation-level file ids that turns without a branch anchor fall back to. */
export function withoutConversationFiles<T extends ConversationFileRefs>(
  conversation: T,
): Omit<T, 'files' | 'file_ids'> {
  const { files: _files, file_ids: _fileIds, ...rest } = conversation;
  return rest;
}

/**
 * How a copied conversation treats files: as they are, or with every reference a later turn would
 * send again left out (`excludeFiles`). Native copies (forks) apply it to each cloned message and
 * to the conversation, so the decision lives here rather than in each copy path.
 */
export function forkFileScope(excludeFiles = false): {
  message: <T extends MessageFileRefs>(message: T) => T | MessageWithoutFiles<T>;
  conversation: <T extends ConversationFileRefs>(
    conversation: T,
  ) => T | Omit<T, 'files' | 'file_ids'>;
} {
  if (excludeFiles !== true) {
    return { message: (message) => message, conversation: (conversation) => conversation };
  }
  return { message: withoutMessageFiles, conversation: withoutConversationFiles };
}
