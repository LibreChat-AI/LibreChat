import { v4 as uuidv4 } from 'uuid';
import { Constants } from 'librechat-data-provider';
import type {
  ClaudeMessage,
  ConvertedMessage,
  ClaudeConversation,
  ConvertedConversation,
} from '~/import/types';
import type { ConvertedClaudeContent } from './content';
import { convertClaudeContent, hasRenderableContent } from './content';
import { orderTree } from '~/import/tree';

const ASSISTANT_SENDER = 'Claude';
const HUMAN_SENDER = 'human';
const DEFAULT_TITLE = 'Imported Claude Chat';

export interface ClaudeConvertOptions {
  defaultModel: string;
}

export interface ConvertedClaudeConversation extends ConvertedConversation {
  /** Attachment extractions carried into the conversation's messages. */
  extracted: number;
  /** Referenced files and images the export does not contain. */
  unavailable: number;
}

interface PreparedMessage {
  message: ClaudeMessage;
  converted: ConvertedClaudeContent;
  messageId: string;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Walks up `parent_message_uuid` to the nearest ancestor that was actually
 * emitted, so dropping a contentless message re-parents its children instead of
 * orphaning them. Iterative because real chains run deep, and `visited` breaks
 * the loops a corrupt export can contain. Claude also roots messages with an
 * all-zero sentinel uuid that matches no message, which resolves here to
 * `NO_PARENT` by simply not being found.
 */
function findParent(
  startUuid: string | null | undefined,
  prepared: Map<string, PreparedMessage>,
  emitted: Set<string>,
): string {
  const visited = new Set<string>();
  let current = startUuid;

  while (current && !visited.has(current)) {
    visited.add(current);
    const candidate = prepared.get(current);
    if (!candidate) {
      return Constants.NO_PARENT;
    }
    if (emitted.has(current)) {
      return candidate.messageId;
    }
    current = candidate.message.parent_message_uuid;
  }

  return Constants.NO_PARENT;
}

/**
 * Converts every message once, before any parent is resolved: whether a message
 * is emitted depends on what its blocks produced, and `findParent` needs that
 * answer for every ancestor it may walk through.
 */
function prepareMessages(messages: ClaudeMessage[]): {
  prepared: Map<string, PreparedMessage>;
  emitted: Set<string>;
  order: PreparedMessage[];
} {
  const prepared = new Map<string, PreparedMessage>();
  const emitted = new Set<string>();
  const order: PreparedMessage[] = [];

  for (const message of messages) {
    if (!message?.uuid || prepared.has(message.uuid)) {
      continue;
    }
    const converted = convertClaudeContent(message);
    const entry: PreparedMessage = { message, converted, messageId: uuidv4() };
    prepared.set(message.uuid, entry);
    if (hasRenderableContent(converted)) {
      emitted.add(message.uuid);
      order.push(entry);
    }
  }

  return { prepared, emitted, order };
}

export function convertClaudeConversation(
  conv: ClaudeConversation,
  options: ClaudeConvertOptions,
): ConvertedClaudeConversation {
  const { prepared, emitted, order } = prepareMessages(conv.chat_messages ?? []);
  const fallbackTime = parseTimestamp(conv.created_at) ?? Date.now();

  const messages: ConvertedMessage[] = [];
  let extracted = 0;
  let unavailable = 0;

  for (const entry of prepared.values()) {
    extracted += entry.converted.extracted;
    unavailable += entry.converted.unavailable;
  }

  let previousId: string = Constants.NO_PARENT;

  for (const entry of order) {
    const { message, converted } = entry;
    const isCreatedByUser = message.sender === HUMAN_SENDER;

    /** An export that carries no `parent_message_uuid` at all (the field is
     * absent rather than null) has no tree to rebuild, so its messages chain in
     * array order, the shape the pre-branching importer always produced. An
     * explicit `null` is a real root and is left alone. */
    const parentMessageId =
      message.parent_message_uuid === undefined
        ? previousId
        : findParent(message.parent_message_uuid, prepared, emitted);

    const built: ConvertedMessage = {
      messageId: entry.messageId,
      parentMessageId,
      text: converted.text,
      sender: isCreatedByUser ? 'user' : ASSISTANT_SENDER,
      isCreatedByUser,
      model: options.defaultModel,
      createdAt: new Date(parseTimestamp(message.created_at) ?? fallbackTime),
      assetPointers: [],
    };

    if (converted.content) {
      built.content = converted.content;
    }
    if (converted.attachments) {
      built.attachments = converted.attachments;
    }

    previousId = built.messageId;
    messages.push(built);
  }

  orderTree(messages);

  return {
    conversationId: uuidv4(),
    externalId: conv.uuid,
    title: conv.name || DEFAULT_TITLE,
    createdAt: new Date(fallbackTime),
    isArchived: false,
    pinned: false,
    model: options.defaultModel,
    messages,
    extracted,
    unavailable,
  };
}
