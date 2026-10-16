import { createHash } from 'crypto';

type ContentPart = {
  type?: string;
  think?: unknown;
  provider_replay?: unknown;
  tool_call?: Record<string, unknown>;
} | null;

/** Key of the signed reasoning of the `think` part at a content index. */
export const THINK_REPLAY_KEY_PREFIX = 'think:';

/**
 * Most characters of signed reasoning kept for one message. A message over it keeps none, so
 * a long run cannot grow a document towards the MongoDB limit and the outcome is the same on
 * every later turn.
 */
export const MAX_THINK_REPLAY_CHARS = 2_000_000;

/** Fingerprint of a reasoning text; a replay is only used while its part still has this text. */
export function thinkReplayHash(think: unknown): string {
  return createHash('sha256')
    .update(typeof think === 'string' ? think : '')
    .digest('hex');
}

export type ThinkReplayItem = { hash: string; replay: unknown };

/**
 * Splits the provider output items off the parts of a response. They live in a field of their
 * own, outside `content`, so no read of the content can carry them by accident:
 * - `tool_call.providerItems` (encrypted reasoning and ids of an OpenAI Responses round), keyed
 *   by tool call id; items of a call without an id are dropped;
 * - `think.provider_replay` (signed Anthropic / Bedrock reasoning blocks), keyed by
 *   `think:<content index>` together with a hash of the part's text, so a reasoning part that
 *   was edited afterwards is not replayed.
 * @returns the content without them, and the items; undefined when the content has none
 */
export function splitProviderItems(
  content: unknown,
): { content: unknown[]; providerItems: Record<string, unknown> } | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const providerItems: Record<string, unknown> = {};
  const thinkItems: Record<string, ThinkReplayItem> = {};
  let thinkChars = 0;
  let found = false;
  const stripped = content.map((part: ContentPart, index) => {
    if (part?.type === 'think' && part.provider_replay != null) {
      found = true;
      const { provider_replay: replay, ...rest } = part;
      thinkChars += JSON.stringify(replay).length;
      thinkItems[`${THINK_REPLAY_KEY_PREFIX}${index}`] = {
        hash: thinkReplayHash(rest.think),
        replay,
      };
      return rest;
    }
    const toolCall = part?.tool_call;
    if (toolCall == null || toolCall.providerItems == null) {
      return part;
    }
    found = true;
    const { providerItems: items, ...rest } = toolCall;
    if (typeof rest.id === 'string' && rest.id !== '') {
      providerItems[rest.id] = items;
    }
    return { ...part, tool_call: rest };
  });
  if (!found) {
    return undefined;
  }
  if (thinkChars <= MAX_THINK_REPLAY_CHARS) {
    Object.assign(providerItems, thinkItems);
  }
  return { content: stripped, providerItems };
}
