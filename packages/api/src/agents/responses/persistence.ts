import { v4 as uuidv4 } from 'uuid';
import { Constants, ContentTypes } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { Response } from './types';

const rootParent = String(Constants.NO_PARENT);

/** Retain completed server tool pairs for browser rendering and later model turns. */
export function projectResponseMessage(
  response: Pick<Response, 'output'> & Partial<Pick<Response, 'status'>>,
): {
  text: string;
  content: Agents.MessageContentComplex[];
  unfinished?: boolean;
} {
  const results = new Map<string, string>();
  for (const item of response.output)
    if (item.type === 'function_call_output') results.set(item.call_id, item.output);
  const content: Agents.MessageContentComplex[] = [];
  let text = '';
  for (const item of response.output) {
    if (item.type === 'function_call' && results.has(item.call_id)) {
      content.push({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: item.call_id,
          name: item.name,
          args: item.arguments,
          output: results.get(item.call_id)!,
        },
      });
    }
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    for (const part of item.content) {
      if (part.type !== 'output_text') continue;
      text += part.text;
      content.push({ type: ContentTypes.TEXT, text: part.text });
    }
  }
  return {
    text,
    content,
    ...(response.status == null
      ? {}
      : { unfinished: response.status === 'in_progress' || response.status === 'queued' }),
  };
}

export type StoredResponseMessage = {
  messageId: string;
  conversationId?: string;
  parentMessageId?: string | null;
  isCreatedByUser?: boolean;
  text?: string;
  tokenCount?: number;
  createdAt?: Date | string;
};

type ResponseReferenceDeps = {
  getMessage: (query: { user: string; messageId: string }) => Promise<StoredResponseMessage | null>;
};

export class ResponsePersistenceError extends Error {
  readonly status = 503;
  readonly code = 'response_storage_unavailable';

  constructor() {
    super('Response storage is unavailable. Please try again.');
    this.name = 'ResponsePersistenceError';
  }
}

/** Response IDs identify assistant messages, not the conversation containing them. */
export async function resolveResponseContinuation(
  previousResponseId: string | undefined,
  userId: string,
  deps: ResponseReferenceDeps,
): Promise<{ conversationId: string; parentMessageId: string }> {
  try {
    return await resolveStoredContinuation(previousResponseId, userId, deps);
  } catch {
    throw new ResponsePersistenceError();
  }
}

async function resolveStoredContinuation(
  previousResponseId: string | undefined,
  userId: string,
  deps: ResponseReferenceDeps,
): Promise<{ conversationId: string; parentMessageId: string }> {
  if (!previousResponseId) {
    return { conversationId: uuidv4(), parentMessageId: rootParent };
  }
  const message = await deps.getMessage({ user: userId, messageId: previousResponseId });
  if (message && !message.isCreatedByUser && message.conversationId) {
    return { conversationId: message.conversationId, parentMessageId: message.messageId };
  }
  // Keep legacy conversation-ID callers working. The existing owner/project
  // admission check rejects absent or foreign conversations before execution.
  return { conversationId: previousResponseId, parentMessageId: rootParent };
}

/** Follow the selected reply's ancestry so continuation cannot replay a later sibling turn. */
export function selectResponseHistory<T extends StoredResponseMessage>(
  messages: T[],
  previousResponseId?: string,
): T[] {
  if (!previousResponseId || !previousResponseId.startsWith('resp_')) return messages;
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const anchor = byId.get(previousResponseId);
  if (!anchor || anchor.isCreatedByUser) return [];
  // Old Responses writes had null parents; preserve their original linear
  // history, but never include a message written after the selected response.
  if (anchor.parentMessageId == null) {
    return messages.slice(0, messages.indexOf(anchor) + 1);
  }
  const chain: T[] = [];
  const visited = new Set<string>();
  let current: T | undefined = anchor;
  while (current) {
    if (visited.has(current.messageId)) throw new Error('Stored response history contains a cycle');
    visited.add(current.messageId);
    chain.push(current);
    const parent = current.parentMessageId;
    if (parent == null) {
      return [...messages.slice(0, messages.indexOf(current)), ...chain.reverse()];
    }
    if (!parent || parent === Constants.NO_PARENT) break;
    current = byId.get(parent);
    if (!current) throw new Error('Stored response history is incomplete');
  }
  return chain.reverse();
}

export function buildResponseInputChain<T extends { role: string; messageId?: string }>(
  messages: T[],
  previousMessageId: string,
  history: { messageId?: string }[] = [],
): { messages: (T & { messageId: string; parentMessageId: string })[]; parentMessageId: string } {
  const inputs: (T & { messageId: string; parentMessageId: string })[] = [];
  let parentMessageId =
    previousMessageId === rootParent
      ? history[history.length - 1]?.messageId || previousMessageId
      : previousMessageId;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const input = {
      ...message,
      messageId: message.messageId || uuidv4(),
      parentMessageId,
    };
    inputs.push(input);
    parentMessageId = input.messageId;
  }
  return { messages: inputs, parentMessageId };
}

/** GET returns the selected turn, not every assistant reply in the conversation. */
export function selectStoredResponse<T extends StoredResponseMessage>(
  messages: T[],
  responseId: string,
): T[] {
  if (responseId.startsWith('resp_')) {
    return messages.filter(
      (message) => message.messageId === responseId && !message.isCreatedByUser,
    );
  }
  return messages.filter((message) => !message.isCreatedByUser).slice(-1);
}
