import { Constants } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';

/** Minimal shape for request file entries (from `req.body.files`) */
type RequestFile = { file_id?: string };

type GetMessagesByParentId = (
  filter: { user: string; messageId: string; conversationId?: string },
  select: '_id',
) => Promise<unknown[]>;

/** Fields to strip from files before client transmission */
const FILE_STRIP_FIELDS = ['text', '_id', '__v'] as const;

/** Fields to strip from messages before client transmission.
 * Both are prompt-building inputs: `fileContext` is text extracted from
 * attachments and `image_urls` holds base64 image inputs. Terminal events are
 * additionally projected centrally by `projectTerminalEvent`; this stays as
 * defense in depth for the non-terminal senders (`error.js`,
 * `abortMiddleware.js`). */
const MESSAGE_STRIP_FIELDS = ['fileContext', 'image_urls'] as const;

/**
 * Strips large/unnecessary fields from a file object before transmitting to client.
 * Use this within existing loops when building file arrays to avoid extra iterations.
 *
 * @param file - The file object to sanitize
 * @returns A new file object without the stripped fields
 *
 * @example
 * // Use in existing file processing loop:
 * for (const attachment of client.options.attachments) {
 *   if (messageFiles.has(attachment.file_id)) {
 *     userMessage.files.push(sanitizeFileForTransmit(attachment));
 *   }
 * }
 */
export function sanitizeFileForTransmit<T extends Partial<TFile>>(
  file: T,
): Omit<T, (typeof FILE_STRIP_FIELDS)[number]> {
  const sanitized = { ...file };
  for (const field of FILE_STRIP_FIELDS) {
    delete sanitized[field as keyof typeof sanitized];
  }
  return sanitized;
}

/** Filters attachments to those whose `file_id` appears in `requestFiles`, then sanitizes each. */
export function buildMessageFiles<T extends Partial<TFile>>(
  requestFiles: RequestFile[],
  attachments: T[],
): Omit<T, (typeof FILE_STRIP_FIELDS)[number]>[] {
  const requestFileIds = new Set<string>();
  for (const f of requestFiles) {
    if (f.file_id) {
      requestFileIds.add(f.file_id);
    }
  }

  const files: Omit<T, (typeof FILE_STRIP_FIELDS)[number]>[] = [];
  for (const attachment of attachments) {
    if (attachment.file_id != null && requestFileIds.has(attachment.file_id)) {
      files.push(sanitizeFileForTransmit(attachment));
    }
  }
  return files;
}

/**
 * Sanitizes a message object before transmitting to client.
 * Removes prompt-building fields (`fileContext`, `image_urls`) and strips
 * `text` from embedded files.
 *
 * @param message - The message object to sanitize
 * @returns A new message object safe for client transmission
 *
 * @example
 * sendEvent(res, {
 *   final: true,
 *   requestMessage: sanitizeMessageForTransmit(userMessage),
 *   responseMessage: response,
 * });
 */
export function sanitizeMessageForTransmit<T extends Partial<TMessage>>(
  message: T,
): Omit<T, (typeof MESSAGE_STRIP_FIELDS)[number]> {
  if (!message) {
    return message as Omit<T, (typeof MESSAGE_STRIP_FIELDS)[number]>;
  }

  const sanitized = { ...message };

  if (sanitized.metadata) {
    const {
      thoughtSignatures: _thought,
      nativeSignatures: _native,
      ...publicMetadata
    } = sanitized.metadata;
    sanitized.metadata = publicMetadata;
  }

  // Remove message-level fields
  for (const field of MESSAGE_STRIP_FIELDS) {
    delete sanitized[field as keyof typeof sanitized];
  }

  // Always create a new array when files exist to maintain full immutability
  if (Array.isArray(sanitized.files)) {
    sanitized.files = sanitized.files.map((file) => sanitizeFileForTransmit(file));
  }

  return sanitized;
}

export function isPreliminaryMessageId(messageId: unknown): messageId is string {
  return typeof messageId === 'string' && messageId.endsWith('_');
}

export async function isUnpersistedPreliminaryParent({
  userId,
  conversationId,
  parentMessageId,
  getMessages,
}: {
  userId: string;
  conversationId?: string | null;
  parentMessageId?: string | null;
  getMessages: GetMessagesByParentId;
}): Promise<boolean> {
  if (!isPreliminaryMessageId(parentMessageId)) {
    return false;
  }

  const filter: { user: string; messageId: string; conversationId?: string } = {
    user: userId,
    messageId: parentMessageId,
  };
  if (conversationId && conversationId !== Constants.NEW_CONVO) {
    filter.conversationId = conversationId;
  }

  const messages = await getMessages(filter, '_id');
  return messages.length === 0;
}

/** Minimal message shape for thread traversal.
 *
 * Both `files` and `attachments` carry `file_id` references, but they
 * land on different roles by convention: user-uploaded files live on
 * `messages.files` (set when the user attaches a file in chat), while
 * code-execution outputs live on `messages.attachments` (set by
 * `processCodeOutput` when a tool call produces a file). The thread
 * walk must visit both so the next turn's `tool_resources.execute_code.file_ids`
 * picks up files the assistant generated, not just files the user
 * uploaded. */
type ThreadMessage = {
  messageId: string;
  parentMessageId?: string | null;
  files?: Array<{ file_id?: string }>;
  attachments?: Array<{ file_id?: string }>;
};

/** Result of thread data extraction */
export type ThreadData = {
  messageIds: string[];
  fileIds: string[];
};

/**
 * Extracts thread message IDs and file IDs in a single O(n) pass.
 * Builds a Map for O(1) lookups, then traverses the thread collecting both IDs.
 *
 * @param messages - All messages in the conversation (should be queried with select for efficiency)
 * @param parentMessageId - The ID of the parent message to start traversal from
 * @returns Object containing messageIds and fileIds arrays
 */
export function getThreadData(
  messages: ThreadMessage[],
  parentMessageId: string | null | undefined,
): ThreadData {
  const result: ThreadData = { messageIds: [], fileIds: [] };

  if (!messages || messages.length === 0 || !parentMessageId) {
    return result;
  }

  /** Build Map for O(1) lookups instead of O(n) .find() calls */
  const messageMap = new Map<string, ThreadMessage>();
  for (const msg of messages) {
    messageMap.set(msg.messageId, msg);
  }

  const fileIdSet = new Set<string>();
  const visitedIds = new Set<string>();
  let currentId: string | null | undefined = parentMessageId;

  /** Single traversal: collect message IDs and file IDs together */
  while (currentId) {
    if (visitedIds.has(currentId)) {
      break;
    }
    visitedIds.add(currentId);

    const message = messageMap.get(currentId);
    if (!message) {
      break;
    }

    result.messageIds.push(message.messageId);

    /** Collect file IDs from BOTH `files` (user uploads) and
     *  `attachments` (code-execution outputs from `processCodeOutput`).
     *  Walking only one half drops half the relevant refs — see
     *  the type doc on `ThreadMessage` for the role split. */
    if (message.files) {
      for (const file of message.files) {
        if (file.file_id) {
          fileIdSet.add(file.file_id);
        }
      }
    }
    if (message.attachments) {
      for (const attachment of message.attachments) {
        if (attachment.file_id) {
          fileIdSet.add(attachment.file_id);
        }
      }
    }

    currentId = message.parentMessageId === Constants.NO_PARENT ? null : message.parentMessageId;
  }

  result.fileIds = Array.from(fileIdSet);
  return result;
}
