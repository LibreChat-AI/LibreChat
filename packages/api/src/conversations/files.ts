import { ContentTypes } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';

type MessageFileRefs = Partial<Pick<TMessage, 'files' | 'attachments' | 'tokenCount' | 'content'>>;

type ConversationFileRefs = Partial<Pick<TConversation, 'file_ids'>> & {
  files?: string[] | null;
};

type ContentPart = NonNullable<TMessage['content']>[number];
type Attachment = NonNullable<TMessage['attachments']>[number];

/** Whether an attachment is a stored file (a code output) rather than tool metadata like search
 *  sources, which the thread file walk never collects and the transcript still renders. */
const isFileAttachment = (attachment: Attachment): boolean =>
  'file_id' in attachment && typeof attachment.file_id === 'string' && attachment.file_id !== '';

export type MessageWithoutFiles<T extends MessageFileRefs> = Omit<
  T,
  'files' | 'attachments' | 'tokenCount'
> &
  Pick<MessageFileRefs, 'attachments' | 'tokenCount'>;

const carriesFiles = (files: readonly object[] | null | undefined): boolean =>
  (files?.length ?? 0) > 0;

/** A steer part's attachments replay on every later turn, like a user turn's uploads. */
function withoutSteerFiles(part: ContentPart): ContentPart {
  if (part?.type !== ContentTypes.STEER || !('files' in part) || !carriesFiles(part.files)) {
    return part;
  }
  const { files: _files, ...rest } = part;
  return rest as ContentPart;
}

/**
 * Drops the file references a later turn collects from history and sends again: uploads on a
 * user turn (`files`), file-backed attachments such as code-execution outputs (metadata-only
 * attachments like search sources stay), and attachments steered into a response
 * (`content[].files` on a steer part). A stored token count that covered dropped uploads
 * goes too, so the next turn recounts what is left instead of budgeting context for files it no
 * longer sends.
 */
export function withoutMessageFiles<T extends MessageFileRefs>(message: T): MessageWithoutFiles<T> {
  const { files, attachments, tokenCount, ...rest } = message;
  let droppedUploads = carriesFiles(files);
  const keptAttachments = attachments?.filter((attachment) => !isFileAttachment(attachment));
  if (keptAttachments != null && keptAttachments.length > 0) {
    (rest as MessageFileRefs).attachments = keptAttachments;
  }
  if (Array.isArray(rest.content)) {
    const content = rest.content.map(withoutSteerFiles);
    if (content.some((part, index) => part !== rest.content?.[index])) {
      droppedUploads = true;
      rest.content = content;
    }
  }
  if (droppedUploads || tokenCount == null) {
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
