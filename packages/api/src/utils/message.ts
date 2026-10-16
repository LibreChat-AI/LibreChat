import { thinkReplayHash, THINK_REPLAY_KEY_PREFIX } from '@librechat/data-schemas';
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

/**
 * Provider output items the agents SDK reports for a finished response, so the next turn
 * replays it as it was sent: `tool_call.providerItems` (OpenAI Responses ids, status and
 * encrypted reasoning of a tool round) and `think.provider_replay` (signed Anthropic / Bedrock
 * reasoning blocks). They live in the run's content while it is live; `saveMessage` moves them
 * into a field of their own, so a stored message never carries them in `content`. They are
 * server state: never sent to a client, never accepted from one.
 */
const PROVIDER_ITEMS_FIELD = 'providerItems';
const THINK_REPLAY_FIELD = 'provider_replay';

type ReplayCarrierPart = {
  type?: string;
  think?: unknown;
  tool_call?: Record<string, unknown>;
  [THINK_REPLAY_FIELD]?: unknown;
} | null;

/**
 * Message content without provider output items. Returns the same array when
 * no part carries them.
 */
export function stripProviderItems<T>(content: T): T {
  if (!Array.isArray(content)) {
    return content;
  }
  let stripped: unknown[] | undefined;
  content.forEach((part: ReplayCarrierPart, index) => {
    if (part?.type === 'think' && THINK_REPLAY_FIELD in part) {
      const { [THINK_REPLAY_FIELD]: _replay, ...rest } = part;
      stripped ??= [...content];
      stripped[index] = rest;
      return;
    }
    if (part?.tool_call == null || !(PROVIDER_ITEMS_FIELD in part.tool_call)) {
      return;
    }
    const { [PROVIDER_ITEMS_FIELD]: _items, ...toolCall } = part.tool_call;
    stripped ??= [...content];
    stripped[index] = { ...part, tool_call: toolCall };
  });
  return (stripped ?? content) as T;
}

/**
 * Content with the signed reasoning of its `think` parts removed, of the parts before index
 * `before` only when given. The same array when no part carries any.
 */
export function stripReasoningReplay<T>(content: T, before?: number): T {
  if (!Array.isArray(content)) {
    return content;
  }
  let stripped: unknown[] | undefined;
  content.forEach((part: ReplayCarrierPart, index) => {
    if (index < (before ?? Infinity) && part?.type === 'think' && THINK_REPLAY_FIELD in part) {
      const { [THINK_REPLAY_FIELD]: _replay, ...rest } = part;
      stripped ??= [...content];
      stripped[index] = rest;
    }
  });
  return (stripped ?? content) as T;
}

/**
 * A reasoning delta without the signed blocks of the reasoning parts it carries, for the
 * client stream. The same object when it carries none or when signed blocks are not stored.
 */
export function omitReasoningReplayFromDelta<T>(data: T, storesProviderItems = true): T {
  if (!storesProviderItems) {
    return data;
  }
  const delta = (data as { delta?: { content?: unknown } } | null)?.delta;
  const parts = delta?.content;
  if (!Array.isArray(parts) || !parts.some((part) => part?.[THINK_REPLAY_FIELD] != null)) {
    return data;
  }
  return {
    ...data,
    delta: { ...delta, content: stripProviderItems(parts) },
  } as T;
}

type ContentCarrier = { content?: unknown; aggregatedContent?: unknown };

function withoutProviderItems<T extends ContentCarrier>(
  carrier: T,
  key: 'content' | 'aggregatedContent',
): T {
  const stripped = stripProviderItems(carrier[key]);
  return stripped === carrier[key] ? carrier : { ...carrier, [key]: stripped };
}

/**
 * A stream event without the provider items of live tool calls, on the two shapes that carry the
 * run's content: a sync event (`resumeState.aggregatedContent`) and a final one
 * (`responseMessage.content`). The event is returned as is when it has none.
 */
export function omitProviderItemsFromEvent<T>(event: T): T {
  const carrier = event as {
    responseMessage?: ContentCarrier;
    resumeState?: ContentCarrier;
  } | null;
  if (carrier == null || typeof carrier !== 'object') {
    return event;
  }
  const responseMessage =
    carrier.responseMessage != null
      ? withoutProviderItems(carrier.responseMessage, 'content')
      : undefined;
  const resumeState =
    carrier.resumeState != null
      ? withoutProviderItems(carrier.resumeState, 'aggregatedContent')
      : undefined;
  if (responseMessage === carrier.responseMessage && resumeState === carrier.resumeState) {
    return event;
  }
  return {
    ...carrier,
    ...(responseMessage != null && { responseMessage }),
    ...(resumeState != null && { resumeState }),
  } as T;
}

/**
 * A stored message with its provider items put back on the tool call parts they belong to, for
 * formatting the history. Same object when it has none; never changes the input.
 */
export function attachProviderItems<
  T extends { content?: unknown; providerItems?: Record<string, unknown> | null },
>(message: T): T {
  const { providerItems, content } = message;
  if (providerItems == null || !Array.isArray(content)) {
    return message;
  }
  const attached = content.map((part: ReplayCarrierPart, index) => {
    if (part?.type === 'think') {
      const item = providerItems[`${THINK_REPLAY_KEY_PREFIX}${index}`] as
        | { hash?: unknown; replay?: unknown }
        | undefined;
      /** A reasoning text edited after the response was saved no longer matches its blocks. */
      return item?.replay != null && item.hash === thinkReplayHash(part.think)
        ? { ...part, [THINK_REPLAY_FIELD]: item.replay }
        : part;
    }
    const id = part?.tool_call?.id as string | undefined;
    return id != null && providerItems[id] != null
      ? { ...part, tool_call: { ...part?.tool_call, providerItems: providerItems[id] } }
      : part;
  });
  return { ...message, content: attached };
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
