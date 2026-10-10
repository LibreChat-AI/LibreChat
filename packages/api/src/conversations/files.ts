import type { TConversation, TMessage } from 'librechat-data-provider';

type MessageFileRefs = Partial<Pick<TMessage, 'files' | 'attachments' | 'tokenCount'>>;

type ConversationFileRefs = Partial<Pick<TConversation, 'file_ids'>> & {
  files?: string[] | null;
};

/**
 * Drops the file references a later turn collects from history and sends again: uploads on a
 * user turn (`files`) and code-execution outputs (`attachments`). A stored token count that
 * covered dropped uploads goes too, so the next turn recounts the text alone instead of
 * budgeting context for files it no longer sends.
 */
export function withoutMessageFiles<T extends MessageFileRefs>(
  message: T,
): Omit<T, 'files' | 'attachments' | 'tokenCount'> & Pick<MessageFileRefs, 'tokenCount'> {
  const { files, attachments: _attachments, tokenCount, ...rest } = message;
  if ((files?.length ?? 0) > 0 || tokenCount == null) {
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
