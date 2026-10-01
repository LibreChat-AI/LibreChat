import { v4 as uuidv4 } from 'uuid';
import { Constants } from 'librechat-data-provider';
import type {
  GrokResponse,
  GrokTimestamp,
  ConvertedMessage,
  ConvertedConversation,
  GrokConversationEntry,
} from '~/import/types';
import { resolveGrokModel } from './models';
import { orderTree } from '~/import/tree';

const HUMAN_SENDERS = new Set(['human', 'user']);
const DEFAULT_TITLE = 'Imported Grok Chat';

export interface GrokConvertOptions {
  defaultModel: string;
}

export interface ConvertedGrokConversation extends ConvertedConversation {
  /** Responses the export recorded no text for (aborted or `partial`
   * generations), which are skipped so they render as nothing rather than as an
   * empty bubble. Their children re-parent onto the nearest emitted ancestor. */
  dropped: number;
}

interface PreparedResponse {
  response: GrokResponse;
  messageId: string;
}

/**
 * Reads either timestamp encoding a Grok export uses: an ISO string on the
 * conversation, and MongoDB Extended JSON on every response: canonical
 * (`{ $date: { $numberLong: '<ms>' } }`) in the exports measured so far, with
 * the relaxed `{ $date: '<iso>' }` form accepted for free.
 */
export function parseGrokTimestamp(value: GrokTimestamp | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const inner = value.$date;
  if (inner == null) {
    return null;
  }
  if (typeof inner !== 'object') {
    return parseGrokTimestamp(inner);
  }

  const millis = Number(inner.$numberLong);
  return inner.$numberLong == null || !Number.isFinite(millis) ? null : millis;
}

/**
 * Grok's `sender` casing is inconsistent inside a single export: a real one
 * carries `human`, `assistant` and `ASSISTANT`, so the role is compared
 * case-insensitively. A `=== 'assistant'` test would leave the 206 uppercase
 * turns unmatched and, since anything that is not the assistant is the user,
 * import them as user messages.
 */
function isUserSender(sender: string | null | undefined): boolean {
  return typeof sender === 'string' && HUMAN_SENDERS.has(sender.toLowerCase());
}

/**
 * Assigns a LibreChat message id to every response before any parent is
 * resolved, and records which ones carry text: `findParent` needs that answer
 * for each ancestor it may walk through.
 */
function prepareResponses(entries: GrokConversationEntry['responses']): {
  prepared: Map<string, PreparedResponse>;
  emitted: Set<string>;
  order: PreparedResponse[];
} {
  const prepared = new Map<string, PreparedResponse>();
  const emitted = new Set<string>();
  const order: PreparedResponse[] = [];

  for (const entry of entries ?? []) {
    const response = entry?.response;
    if (!response?._id || prepared.has(response._id)) {
      continue;
    }
    const item: PreparedResponse = { response, messageId: uuidv4() };
    prepared.set(response._id, item);
    if (typeof response.message === 'string' && response.message.trim().length > 0) {
      emitted.add(response._id);
      order.push(item);
    }
  }

  return { prepared, emitted, order };
}

/**
 * Walks up `parent_response_id` to the nearest ancestor that was emitted, so
 * skipping a textless response re-parents its children instead of orphaning
 * them. Iterative for the deep chains real exports contain, with `visited`
 * breaking the loops a corrupt export can hold. An absent or unknown parent id
 * resolves to `NO_PARENT`: a real export omits the field on the first response
 * of every conversation and on each retry of an opening prompt, which are
 * genuine sibling roots rather than a lost link.
 */
function findParent(
  startId: string | null | undefined,
  prepared: Map<string, PreparedResponse>,
  emitted: Set<string>,
): string {
  const visited = new Set<string>();
  let current = startId;

  while (current && !visited.has(current)) {
    visited.add(current);
    const candidate = prepared.get(current);
    if (!candidate) {
      return Constants.NO_PARENT;
    }
    if (emitted.has(current)) {
      return candidate.messageId;
    }
    current = candidate.response.parent_response_id;
  }

  return Constants.NO_PARENT;
}

export function convertGrokConversation(
  entry: GrokConversationEntry,
  options: GrokConvertOptions,
): ConvertedGrokConversation {
  const meta = entry.conversation;
  const { prepared, emitted, order } = prepareResponses(entry.responses);
  const fallbackTime = parseGrokTimestamp(meta.create_time) ?? Date.now();

  const messages: ConvertedMessage[] = [];

  for (const item of order) {
    const { response } = item;
    const isCreatedByUser = isUserSender(response.sender);
    const { model, sender } = resolveGrokModel(response.model, options.defaultModel);

    messages.push({
      messageId: item.messageId,
      parentMessageId: findParent(response.parent_response_id, prepared, emitted),
      text: response.message,
      sender: isCreatedByUser ? 'user' : sender,
      isCreatedByUser,
      model,
      createdAt: new Date(parseGrokTimestamp(response.create_time) ?? fallbackTime),
      assetPointers: [],
    });
  }

  orderTree(messages);

  /** `summary` is empty on every conversation of a real export, so it is only
   * useful as a title fallback rather than as a field of its own. */
  const title = meta.title?.trim() || meta.summary?.trim() || DEFAULT_TITLE;

  return {
    conversationId: uuidv4(),
    externalId: meta.id,
    title,
    createdAt: new Date(fallbackTime),
    isArchived: false,
    pinned: meta.starred === true,
    model: options.defaultModel,
    messages,
    dropped: prepared.size - order.length,
  };
}
