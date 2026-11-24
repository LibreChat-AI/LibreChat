import { v4 as uuidv4 } from 'uuid';
import { Constants, ContentTypes, isFailedToolOutput } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { FunctionCallOutputItem, Response } from './types';
import type { InternalMessage } from './service';

const rootParent = String(Constants.NO_PARENT);

export interface StoredResponseOutputLayout {
  id: string;
  type: 'message' | 'function_call' | 'function_call_output';
  callId?: string;
  textParts?: number;
  pendingClientTool?: boolean;
}

export function pendingResponseCalls(response: Response): Set<string> {
  if (response.status !== 'completed' || !response.tools?.length) return new Set();
  const names = new Set(
    response.tools.flatMap((tool) => (tool.type === 'function' ? [tool.name] : [])),
  );
  const results = new Set(
    response.output.flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : [])),
  );
  return new Set(
    response.output.flatMap((item) =>
      item.type === 'function_call' && names.has(item.name) && !results.has(item.call_id)
        ? [item.call_id]
        : [],
    ),
  );
}

/** Keep canonical tool content, including caller-owned calls awaiting a result. */
export function projectResponseMessage(
  response: Pick<Response, 'output'> & Partial<Pick<Response, 'status' | 'tools'>>,
): {
  text: string;
  content: Agents.MessageContentComplex[];
  unfinished?: boolean;
} {
  const results = new Map<string, FunctionCallOutputItem>();
  for (const item of response.output)
    if (item.type === 'function_call_output') results.set(item.call_id, item);
  const content: Agents.MessageContentComplex[] = [];
  let text = '';
  const clientTools = new Set(
    response.tools?.flatMap((tool) => (tool.type === 'function' ? [tool.name] : [])),
  );
  for (const item of response.output) {
    if (item.type === 'function_call') {
      const result = results.get(item.call_id);
      const isClientTool = clientTools.has(item.name);
      if (result === undefined && !isClientTool) continue;
      let runStepStatus: Agents.RunStepClosedStatus | undefined;
      if (result !== undefined) {
        if (item.status === 'completed' && result.status === 'completed') {
          runStepStatus = isFailedToolOutput(result.output) ? 'failed' : 'completed';
        }
      } else if (response.status === 'cancelled' || response.status === 'failed') {
        runStepStatus = response.status;
      }
      content.push({
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: item.call_id,
          name: item.name,
          args: item.arguments,
          ...(isClientTool && response.status === 'completed'
            ? { clientToolCall: true as const }
            : {}),
          ...(runStepStatus ? { runStepStatus } : {}),
          ...(result !== undefined ? { output: result.output } : {}),
        },
      });
      continue;
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

/** UI lifecycle metadata belongs to canonical storage, not the provider input formatter. */
export function projectResponseInputContent(
  content: Exclude<InternalMessage['content'], string>,
  origin?: InternalMessage['clientToolOrigin'],
): Exclude<InternalMessage['content'], string> {
  if (!origin) return content;
  const ids = new Set(origin.callIds);
  if (ids.size === 0 || ids.size !== origin.callIds.length) throw new ResponsePersistenceError();
  const projected = content.map((part) => {
    if (
      part.type !== ContentTypes.TOOL_CALL ||
      !('tool_call' in part) ||
      !ids.has(part.tool_call.id)
    )
      return part;
    if (part.tool_call.output == null) throw new ResponsePersistenceError();
    ids.delete(part.tool_call.id);
    return {
      ...part,
      tool_call: { ...part.tool_call, clientToolCall: true, runStepStatus: 'completed' as const },
    };
  });
  if (ids.size !== 0) throw new ResponsePersistenceError();
  return projected;
}

export type StoredResponseMessage = {
  messageId: string;
  conversationId?: string;
  parentMessageId?: string | null;
  isCreatedByUser?: boolean;
  isUserSubmitted?: boolean;
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
  if (message && !message.isCreatedByUser && !message.isUserSubmitted && message.conversationId) {
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
  if (!anchor || anchor.isCreatedByUser || anchor.isUserSubmitted) return [];
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
  responseReference: boolean = responseId.startsWith('resp_'),
): T[] {
  if (responseReference) {
    return messages.filter(
      (message) =>
        message.messageId === responseId && !message.isCreatedByUser && !message.isUserSubmitted,
    );
  }
  return messages
    .filter((message) => !message.isCreatedByUser && !message.isUserSubmitted)
    .slice(-1);
}
